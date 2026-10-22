mod account_scope;
mod auth;
mod auth_gate;
mod catalog;
mod console_presence;
mod profile;
mod session;
mod session_journal;
mod subscription;
pub mod vault;
mod wake;

use auth::{PendingLogin, TokenBundle, poll_device_code};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session::{
    DeviceProfilePatch, IceCandidate, SessionClient, SessionKind, SessionSnapshot,
    provisioning_attempts,
};
use std::{sync::Mutex, time::Duration};
use tauri::State;
use zeroize::Zeroizing;

mod connection_cancel;
pub struct AppState {
    cancellations: connection_cancel::ConnectionCancellation,
    stream_owner: Mutex<Option<String>>,
    client: Client,
    pending: Mutex<Option<(String, PendingLogin)>>,
    tokens: Mutex<Option<TokenBundle>>,
    stream: Mutex<Option<SessionClient>>,
    stream_operation: tokio::sync::Mutex<()>,
    profile_cache: profile::ProfileCache,
    /// Sólo para pruebas de integración (mock HTTP local); siempre None en producción.
    profile_base_override: Option<String>,
    /// F3: epoch monótono + gate de commit; logout incrementa el epoch y todo
    /// productor auth (refresh/poll_login/persist) revalida antes de escribir.
    auth_gate: auth_gate::AuthGate,
}
impl AppState {
    fn new() -> Self {
        let tokens = vault::load().ok().flatten();
        Self {
            cancellations: Default::default(),
            stream_owner: Mutex::new(None),
            client: session::http_client(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
            )
            .expect("HTTP client for Xbox auth"),
            pending: Mutex::new(None),
            tokens: Mutex::new(tokens),
            stream: Mutex::new(None),
            stream_operation: tokio::sync::Mutex::new(()),
            profile_cache: profile::ProfileCache::production(),
            profile_base_override: None,
            auth_gate: auth_gate::AuthGate::new(),
        }
    }
}

#[derive(Serialize)]
struct Status {
    authenticated: bool,
    #[serde(rename = "catalogAccountScope")]
    catalog_account_scope: Option<String>,
    account: String,
    storage: String,
}

fn state_error() -> String {
    "Authentication state is unavailable".into()
}

async fn complete_login_timed(
    client: &Client,
    pending: &PendingLogin,
) -> Result<TokenBundle, auth::AuthError> {
    tokio::time::timeout(
        Duration::from_secs(60),
        auth::complete_login_from_device_code(client, pending),
    )
    .await
    .unwrap_or(Err(auth::AuthError::Timeout))
}

/// Estado unificado post-auth (usado por refresh/poll_login/load/persist).
fn auth_status_after(state: &State<'_, AppState>) -> Status {
    Status {
        authenticated: true,
        catalog_account_scope: state
            .tokens
            .lock()
            .map_err(|_| state_error())
            .ok()
            .as_ref()
            .and_then(|tokens| tokens.as_ref())
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
        account: "Xbox account".into(),
        storage: "secure vault".into(),
    }
}
fn token_text(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing required {key} in token response"))
}
fn region_host(token: &Value) -> Result<String, String> {
    let regions = token
        .pointer("/offeringSettings/regions")
        .and_then(Value::as_array)
        .ok_or("Streaming token has no region list")?;
    let region = regions
        .iter()
        .find(|r| r.get("isDefault").and_then(Value::as_bool) == Some(true))
        .or_else(|| regions.first())
        .ok_or("Streaming token contains no region")?;
    let uri = region
        .get("baseUri")
        .and_then(Value::as_str)
        .ok_or("Streaming region has no baseUri")?;
    Url::parse(uri)
        .map_err(|_| "Streaming region URI is invalid".to_owned())?
        .host_str()
        .map(str::to_owned)
        .ok_or("Streaming region host is missing".into())
}
async fn get_json(
    client: &Client,
    url: String,
    bearer: Option<&str>,
    xbox_auth: Option<&str>,
    headers: &[(&str, &str)],
) -> Result<Value, String> {
    let mut req = client.get(url);
    if let Some(token) = bearer {
        req = req.bearer_auth(token);
    }
    if let Some(token) = xbox_auth {
        req = req.header("Authorization", token);
    }
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let response = req
        .send()
        .await
        .map_err(|_| "Xbox API request failed".to_owned())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Xbox API returned invalid JSON".to_owned())?;
    if !status.is_success() {
        return Err(format!("Xbox API returned HTTP {}", status.as_u16()));
    }
    Ok(body)
}
fn snapshot_tokens(state: &State<'_, AppState>) -> Result<TokenBundle, String> {
    state
        .tokens
        .lock()
        .map_err(|_| state_error())?
        .clone()
        .ok_or("Sign in first".into())
}

/// F3: captura epoch+tokens bajo el gate antes de cualquier await de red.
/// El Tauri command `refresh_session` delega aquí; el sidecar Electron mantiene
/// su FIFO serial y aplica el mismo contrato de epoch en su rama refresh.
pub async fn refresh_with_gate<Fetch, Fut, Persist>(
    gate: &auth_gate::AuthGate,
    snapshot: impl FnOnce() -> Result<TokenBundle, String>,
    fetch: Fetch,
    persist: Persist,
) -> Result<TokenBundle, String>
where
    Fetch: FnOnce(TokenBundle) -> Fut,
    Fut: std::future::Future<Output = Result<TokenBundle, String>>,
    Persist: FnOnce(TokenBundle) -> Result<(), String>,
{
    let mut rx = gate.subscribe();
    let (epoch, current) = {
        let _commit = gate.lock_commit()?;
        (gate.current(), snapshot()?)
    };
    let expected = epoch;
    // Logout mientras el refresh está en vuelo: cancelar el await de red en
    // lugar de dejarlo terminar y competir por el commit.
    let refreshed = tokio::select! {
        biased;
        _ = gate.invalidated(&mut rx, expected) => {
            return Err(auth_gate::INVALIDATED.to_owned());
        }
        result = fetch(current) => result,
    }?;
    // El token renovado sólo persiste si el epoch sigue vigente.
    gate.commit(expected, || persist(refreshed.clone()))?;
    Ok(refreshed)
}

/// F3: logout completo con invalidación de flujo auth. El lock de commit se
/// mantiene durante todo el tramo síncrono para que ningún commit se intercale.
pub fn logout_state(
    state: &AppState,
    clear_scopes: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _commit = state.auth_gate.lock_commit()?;
    state.auth_gate.invalidate();
    clear_scopes()?;
    vault::delete()?;
    *state.tokens.lock().map_err(|_| state_error())? = None;
    *state.pending.lock().map_err(|_| state_error())? = None;
    Ok(())
}

#[tauri::command]
async fn begin_login(
    attempt_id: String,
    state: State<'_, AppState>,
) -> Result<auth::LoginStart, String> {
    let (epoch, ()) = state.auth_gate.begin_attempt_with(&attempt_id, || {
        *state.pending.lock().map_err(|_| state_error())? = None;
        Ok(())
    })?;
    let mut invalidated = state.auth_gate.subscribe();
    let (login, pending) = tokio::select! {
        _ = state.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
        result = auth::begin_login(&state.client) => result.map_err(|e| e.to_string())?,
    };
    state.auth_gate.publish_pending(epoch, || {
        *state.pending.lock().map_err(|_| state_error())? = Some((attempt_id, pending));
        Ok(())
    })?;
    Ok(login)
}

#[tauri::command]
async fn begin_login_window(
    attempt_id: String,
    state: State<'_, AppState>,
) -> Result<auth::LoginStart, String> {
    begin_login(attempt_id, state).await
}

#[tauri::command]
fn cancel_login(attempt_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.auth_gate.cancel_attempt_with(&attempt_id, || {
        let mut pending = state.pending.lock().map_err(|_| state_error())?;
        if pending
            .as_ref()
            .is_some_and(|(active_id, _)| active_id == &attempt_id)
        {
            *pending = None;
        }
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
async fn poll_login(attempt_id: String, state: State<'_, AppState>) -> Result<Status, String> {
    let (epoch, mut pending) = state.auth_gate.with_attempt(&attempt_id, |epoch| {
        let mut guard = state.pending.lock().map_err(|_| state_error())?;
        match guard.take() {
            Some((pending_id, pending)) if pending_id == attempt_id => Ok((epoch, pending)),
            Some(other) => {
                *guard = Some(other);
                Err(auth_gate::INVALIDATED.into())
            }
            None => Err("Start sign-in first".into()),
        }
    })?;

    let mut invalidated = state.auth_gate.subscribe();
    let result = tokio::select! {
        _ = state.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
        result = poll_device_code(&state.client, &mut pending) => result,
    };
    match result {
        Ok(_) | Err(auth::AuthError::AlreadyVerified) => {
            let completion = tokio::select! {
                _ = state.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
                result = complete_login_timed(&state.client, &pending) => result,
            };
            match completion {
                Ok(tokens) => {
                    let saved = state.auth_gate.commit(epoch, || {
                        let saved = vault::save(&tokens);
                        *state.tokens.lock().map_err(|_| state_error())? = Some(tokens);
                        *state.pending.lock().map_err(|_| state_error())? = None;
                        Ok(saved)
                    })?;
                    let storage = match saved {
                        Ok(()) => "keyring",
                        Err(error) if error.contains("fallback passphrase required") => "passphrase-required",
                        Err(_) => return Err(
                            "Authentication succeeded, but secure storage failed; tokens remain only in memory".into(),
                        ),
                    };
                    Ok(Status {
                        authenticated: true,
                        catalog_account_scope: state
                            .tokens
                            .lock()
                            .map_err(|_| state_error())?
                            .as_ref()
                            .and_then(|tokens| {
                                account_scope::catalog_account_scope(&tokens.web_token)
                            }),
                        account: "Xbox account".into(),
                        storage: storage.into(),
                    })
                }
                Err(error) => {
                    state.auth_gate.publish_pending(epoch, || {
                        *state.pending.lock().map_err(|_| state_error())? =
                            Some((attempt_id.clone(), pending));
                        Ok(())
                    })?;
                    Err(error.to_string())
                }
            }
        }
        Err(error @ (auth::AuthError::Pending | auth::AuthError::SlowDown)) => {
            state.auth_gate.publish_pending(epoch, || {
                *state.pending.lock().map_err(|_| state_error())? =
                    Some((attempt_id.clone(), pending));
                Ok(())
            })?;
            Err(error.to_string())
        }
        Err(error @ (auth::AuthError::Expired | auth::AuthError::Denied)) => {
            state.auth_gate.publish_pending(epoch, || {
                *state.pending.lock().map_err(|_| state_error())? = None;
                Ok(())
            })?;
            Err(error.to_string())
        }
        Err(error) => {
            state.auth_gate.publish_pending(epoch, || {
                *state.pending.lock().map_err(|_| state_error())? = Some((attempt_id, pending));
                Ok(())
            })?;
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn complete_login(
    _redirect_url: Option<String>,
    _state: State<'_, AppState>,
) -> Result<Status, String> {
    // Retrocompatibilidad: el flujo Device Code no usa redirect URL.
    // Usar poll_login en su lugar.
    Err("Use poll_login instead".into())
}

#[tauri::command]
fn persist_session(state: State<'_, AppState>) -> Result<Status, String> {
    let _commit = state.auth_gate.lock_commit()?;
    let tokens = snapshot_tokens(&state)?;
    vault::save(&tokens)?;
    Ok(Status {
        authenticated: true,
        catalog_account_scope: state
            .tokens
            .lock()
            .map_err(|_| state_error())?
            .as_ref()
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
        account: "Xbox account".into(),
        storage: "encrypted local vault (0600)".into(),
    })
}

#[tauri::command]
fn load_session(state: State<'_, AppState>) -> Result<Status, String> {
    let _commit = state.auth_gate.lock_commit()?;
    let bundle = vault::load()?.ok_or("No saved Xbox session")?;
    *state.tokens.lock().map_err(|_| state_error())? = Some(bundle);
    Ok(Status {
        authenticated: true,
        catalog_account_scope: state
            .tokens
            .lock()
            .map_err(|_| state_error())?
            .as_ref()
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
        account: "Xbox account".into(),
        storage: "secure vault".into(),
    })
}

#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Result<Status, String> {
    let authenticated = state.tokens.lock().map_err(|_| state_error())?.is_some();
    Ok(Status {
        authenticated,
        catalog_account_scope: state
            .tokens
            .lock()
            .map_err(|_| state_error())?
            .as_ref()
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
        account: if authenticated { "Xbox account" } else { "" }.into(),
        storage: "Secret Service / encrypted fallback".into(),
    })
}

#[tauri::command]
async fn refresh_session(state: State<'_, AppState>) -> Result<Status, String> {
    // F3: snapshot+epoch bajo gate antes del await; el commit persiste tokens y
    // bóveda juntos sólo si ningún logout incrementó el epoch mientras tanto.
    let client = state.client.clone();
    let _refreshed = refresh_with_gate(
        &state.auth_gate,
        || snapshot_tokens(&state),
        |current| async move {
            auth::refresh_bundle(&client, &current)
                .await
                .map_err(|e| e.to_string())
        },
        |refreshed| {
            vault::save(&refreshed)?;
            *state.tokens.lock().map_err(|_| state_error())? = Some(refreshed);
            Ok(())
        },
    )
    .await?;
    Ok(auth_status_after(&state))
}

#[tauri::command]
fn logout(state: State<'_, AppState>) -> Result<(), String> {
    // F3: invalidar el flujo auth ANTES de borrar; los refresh en vuelo quedan
    // cancelados y sus commits descartados silenciosamente.
    logout_state(&state, || {
        if let Some(scope) = snapshot_tokens(&state)
            .ok()
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token))
        {
            state.profile_cache.clear_scope(&scope)?;
        }
        Ok(())
    })
}

/// web_token (XSTS http://xboxlive.com) → (uhs, Token) para el header XBL3.0.
fn web_token_credentials(web: &Value) -> Result<(String, String), String> {
    let bearer = token_text(web, "Token")?;
    let uhs = web
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Web token has no user hash")?
        .to_owned();
    Ok((uhs, bearer))
}

mod settings;
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}
#[tauri::command]
fn load_settings() -> Result<Option<settings::Settings>, String> {
    settings::load_at(&settings::root()?)
}
#[tauri::command]
fn save_settings(settings: settings::Settings) -> Result<(), String> {
    self::settings::save_at(&self::settings::root()?, &settings)
}

#[derive(serde::Serialize)]
pub struct ProfileView {
    #[serde(rename = "gamertag")]
    gamertag: String,
    #[serde(rename = "gameDisplayName")]
    game_display_name: String,
    gamerscore: String,
    #[serde(rename = "gameDisplayPicRaw")]
    game_display_pic_raw: String,
    #[serde(rename = "accountTier")]
    account_tier: String,
    subscription: subscription::Subscription,
    #[serde(rename = "accountScope")]
    account_scope: Option<String>,
    telemetry: profile::ProfileTelemetry,
}

impl ProfileView {
    fn from_identity(
        identity: profile::ProfileIdentity,
        state: &AppState,
        subscription: subscription::Subscription,
        scope: String,
    ) -> Self {
        let telemetry = state.profile_cache.telemetry();
        Self {
            gamertag: identity.gamertag,
            game_display_name: identity.game_display_name,
            gamerscore: identity.gamerscore,
            game_display_pic_raw: identity.game_display_pic_raw,
            account_tier: subscription.label.clone(),
            subscription,
            // Bind identity and entitlement evidence to the exact captured account, never a later login.
            account_scope: Some(scope),
            telemetry,
        }
    }
}

#[tauri::command]
async fn xbox_profile(state: State<'_, AppState>) -> Result<ProfileView, String> {
    let bundle = snapshot_tokens(&state)?;
    let (uhs, bearer) = web_token_credentials(&bundle.web_token)?;
    let scope = account_scope::catalog_account_scope(&bundle.web_token)
        .ok_or("profile: stable account scope required")?;
    let client = state.client.clone();
    let identity = state
        .profile_cache
        .identity(&scope, profile_now_unix(), || {
            profile::fetch_profile(
                &client,
                &uhs,
                &bearer,
                state.profile_base_override.as_deref(),
            )
        })
        .await?;
    let subscription = subscription::resolve(
        &[&bundle.web_token, &bundle.user_token, &bundle.sisu_token],
        bundle.cloud_stream_token.as_ref(),
        bundle.acquired_at_unix,
        profile_now_unix(),
    );
    if account_scope::catalog_account_scope(&snapshot_tokens(&state)?.web_token).as_deref()
        != Some(scope.as_str())
    {
        return Err("Profile request invalidated by account change".into());
    }
    Ok(ProfileView::from_identity(
        identity,
        &state,
        subscription,
        scope,
    ))
}

fn profile_now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[tauri::command]
async fn list_consoles_smartglass(state: State<'_, AppState>) -> Result<Value, String> {
    let bundle = snapshot_tokens(&state)?;
    let web = &bundle.web_token;
    let bearer = token_text(web, "Token")?;
    let uhs = web
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(Value::as_str)
        .ok_or("Web token has no user hash")?;
    let authorization = format!("XBL3.0 x={uhs};{bearer}");
    let devices = get_json(&state.client, "https://xccs.xboxlive.com/lists/devices?queryCurrentDevice=false&includeStorageDevices=true".into(),
        None, Some(&authorization), &[("x-xbl-contract-version", "4"), ("skillplatform", "RemoteManagement"), ("Cache-Control", "no-store, no-cache, must-revalidate"), ("Pragma", "no-cache")]).await?;
    Ok(console_presence::refresh(&state.client, &authorization, devices).await)
}

#[tauri::command]
async fn wake_console(
    device_id: String,
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let bundle = snapshot_tokens(&state)?;
    state
        .cancellations
        .run(
            attempt_id.as_deref(),
            wake::wake(&state.client, &bundle.web_token, &device_id),
        )
        .await
}

#[tauri::command]
async fn cancel_connection(attempt_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.cancellations.cancel(&attempt_id);
    let _operation = state.stream_operation.lock().await;
    if state
        .stream_owner
        .lock()
        .map_err(|_| state_error())?
        .as_deref()
        != Some(&attempt_id)
    {
        return Ok(());
    }
    let mut previous = state.stream.lock().map_err(|_| state_error())?.take();
    let result = session::stop_previous(&mut previous).await;
    if let Some(previous) = previous {
        restore_stream(&state, previous)?;
    }
    if result.is_ok() {
        *state.stream_owner.lock().map_err(|_| state_error())? = None;
    }
    result
}

fn check_stream_attempt(state: &State<'_, AppState>, id: Option<&str>) -> Result<(), String> {
    state.cancellations.check(id)?;
    if let Some(id) = id {
        if state
            .stream_owner
            .lock()
            .map_err(|_| state_error())?
            .as_deref()
            != Some(id)
        {
            return Err("ConnectionCancelled".into());
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_streaming_servers(state: State<'_, AppState>) -> Result<Value, String> {
    let bundle = snapshot_tokens(&state)?;
    let host = region_host(&bundle.home_stream_token)?;
    let bearer = token_text(&bundle.home_stream_token, "gsToken")?;
    get_json(
        &state.client,
        format!("https://{host}/v6/servers/home"),
        Some(&bearer),
        None,
        &[
            ("Cache-Control", "no-store, no-cache, must-revalidate"),
            ("Pragma", "no-cache"),
        ],
    )
    .await
}

#[tauri::command]
async fn list_cloud_titles(state: State<'_, AppState>) -> Result<Value, String> {
    let bundle = snapshot_tokens(&state)?;
    let cloud = bundle
        .cloud_stream_token
        .as_ref()
        .ok_or("xCloud streaming token unavailable for this account or region")?;
    let host = region_host(cloud)?;
    let bearer = token_text(cloud, "gsToken")?;
    get_json(
        &state.client,
        format!("https://{host}/v2/titles"),
        Some(&bearer),
        None,
        &[],
    )
    .await
}

#[tauri::command]
async fn catalog_products(
    product_ids: Vec<String>,
    language: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _ = snapshot_tokens(&state)?;
    catalog::catalog_products(
        &state.client,
        &product_ids,
        language.as_deref().unwrap_or("es"),
    )
    .await
}

#[tauri::command]
async fn list_gamepass_catalog(
    language: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _ = snapshot_tokens(&state)?;
    let (locale, accept_language) =
        catalog::catalog_request_locale(language.as_deref().unwrap_or("es"))?;
    let url = format!(
        "https://catalog.gamepass.com/sigls/v2?id=f13cf6b4-57e6-4459-89df-6aec18cf0538&market=MX&language={locale}"
    );
    get_json(
        &state.client,
        url,
        None,
        None,
        &[("Accept-Language", accept_language)],
    )
    .await
}

#[derive(Deserialize)]
struct StreamStartArgs {
    kind: SessionKind,
    target: String,
    profile: Option<DeviceProfilePatch>,
}

fn take_stream(state: &State<'_, AppState>) -> Result<SessionClient, String> {
    state
        .stream
        .lock()
        .map_err(|_| state_error())?
        .take()
        .ok_or("No active streaming session".into())
}
fn restore_stream(state: &State<'_, AppState>, stream: SessionClient) -> Result<(), String> {
    *state.stream.lock().map_err(|_| state_error())? = Some(stream);
    Ok(())
}

#[tauri::command]
async fn start_stream(
    args: StreamStartArgs,
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    let _operation = state.stream_operation.lock().await;
    state.cancellations.check(attempt_id.as_deref())?;
    if let Some(id) = attempt_id.as_deref() {
        if state.stream.lock().map_err(|_| state_error())?.is_some()
            && state
                .stream_owner
                .lock()
                .map_err(|_| state_error())?
                .as_deref()
                != Some(id)
        {
            return Err("Otra sesión sigue activa".into());
        }
        *state.stream_owner.lock().map_err(|_| state_error())? = Some(id.to_owned());
    }
    let bundle = snapshot_tokens(&state)?;
    let stream_token = match args.kind {
        SessionKind::Home => &bundle.home_stream_token,
        SessionKind::Cloud => bundle
            .cloud_stream_token
            .as_ref()
            .ok_or("xCloud streaming token unavailable for this account or region")?,
    };
    let host = region_host(stream_token)?;
    let token = token_text(stream_token, "gsToken")?;
    let mut stream = SessionClient::new(
        state.client.clone(),
        host,
        token,
        args.kind,
        args.profile
            .map(DeviceProfilePatch::apply)
            .unwrap_or_default(),
    );
    stream.set_account_scope(account_scope::catalog_account_scope(&bundle.web_token))?;
    // Ambos modos exigen lpt para el POST /connect en ReadyToConnect:
    // - Home: xhome (Remote Play). - Cloud: MSAL token auditado en xcloudapi.ts.
    {
        // The persisted lpt can outlive MSA validity; always mint per launch.
        let transfer = auth::transfer_token_async(&state.client, bundle.refresh_token.expose())
            .await
            .map_err(|e| format!("Transfer token: {e}"))?;
        stream.set_transfer_token(Some(transfer));
    }
    state.cancellations.check(attempt_id.as_deref())?;
    let mut previous = state.stream.lock().map_err(|_| state_error())?.take();
    let cleanup = session::stop_previous(&mut previous).await;
    if let Some(previous) = previous {
        restore_stream(&state, previous)?;
    }
    cleanup?;
    state.cancellations.check(attempt_id.as_deref())?;
    let result = stream.start(&args.target).await;
    if stream.snapshot().session_id.is_some() {
        restore_stream(&state, stream)?;
    }
    state.cancellations.check(attempt_id.as_deref())?;
    result
}

#[tauri::command]
async fn provision_stream(
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let mut stream = take_stream(&state)?;
    let result = stream
        .poll_until_provisioned_scoped(
            provisioning_attempts(Duration::from_secs(120), Duration::from_millis(2500)) as u8,
            Duration::from_millis(2500),
            attempt_id.as_deref().map(|id| (&state.cancellations, id)),
        )
        .await;
    restore_stream(&state, stream)?;
    result
}

#[tauri::command]
async fn submit_stream_offer(
    sdp: String,
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let sdp = Zeroizing::new(sdp);
    let mut stream = take_stream(&state)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.submit_offer(sdp.as_str()))
        .await;
    restore_stream(&state, stream)?;
    result
}

#[tauri::command]
async fn poll_stream_answer(
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state)?;
    let result = state
        .cancellations
        .run(
            attempt_id.as_deref(),
            stream.poll_answer(30, Duration::from_secs(1)),
        )
        .await;
    restore_stream(&state, stream)?;
    result
}

#[tauri::command]
async fn exchange_stream_ice(
    candidates: Vec<IceCandidate>,
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<IceCandidate>, String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.exchange_ice(candidates))
        .await;
    restore_stream(&state, stream)?;
    result
}

#[tauri::command]
async fn stream_keepalive(
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.keepalive())
        .await;
    restore_stream(&state, stream)?;
    result
}

#[tauri::command]
async fn stop_stream(attempt_id: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.stream_operation.lock().await;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let mut stream = take_stream(&state)?;
    let result = stream.stop().await;
    if result.is_err() {
        restore_stream(&state, stream)?;
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{SettingsExt, WebViewExt};
                let window = app
                    .get_webview_window("main")
                    .ok_or("No se encontró la ventana principal XJAUS")?;
                window.with_webview(|webview| {
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_webrtc(true);
                        settings.set_enable_media_stream(true);
                        eprintln!(
                            "XJAUS WebKitGTK: WebRTC={}, MediaStream={}",
                            settings.enables_webrtc(),
                            settings.enables_media_stream()
                        );
                    } else {
                        eprintln!("XJAUS WebKitGTK: WebView sin configuración disponible");
                    }
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_exit,
            begin_login,
            begin_login_window,
            poll_login,
            cancel_login,
            complete_login,
            persist_session,
            load_session,
            auth_status,
            refresh_session,
            logout,
            wake_console,
            cancel_connection,
            list_consoles_smartglass,
            list_streaming_servers,
            list_cloud_titles,
            catalog_products,
            list_gamepass_catalog,
            xbox_profile,
            load_settings,
            save_settings,
            start_stream,
            provision_stream,
            submit_stream_offer,
            poll_stream_answer,
            exchange_stream_ice,
            stream_keepalive,
            stop_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

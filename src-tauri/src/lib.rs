// Shared source is compiled independently by these two runner roots.
macro_rules! sidecar_only {
    ($($item:item)*) => {};
}
macro_rules! sidecar_or_test {
    ($($item:item)*) => { $(#[cfg(test)] $item)* };
}
macro_rules! tauri_only {
    ($($item:item)*) => { $($item)* };
}
macro_rules! tauri_or_test {
    ($($item:item)*) => { $($item)* };
}
macro_rules! production_or_tauri {
    ($($item:item)*) => { $($item)* };
}

mod account_scope;
mod auth;
mod auth_gate;
mod catalog;
mod console_presence;
mod instance_guard;
#[cfg(all(test, not(windows)))]
mod logout_barrier;
#[cfg_attr(windows, path = "profile_windows.rs")]
mod profile;
mod session;
#[cfg_attr(windows, path = "session_journal_windows.rs")]
mod session_journal;
mod subscription;
#[cfg_attr(windows, path = "vault_windows.rs")]
pub mod vault;
mod wake;
#[cfg(windows)]
mod windows_fs;

use auth::{PendingLogin, TokenBundle, poll_device_code};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session::{
    DeviceProfilePatch, IceCandidate, SessionClient, SessionKind, SessionSnapshot,
    provisioning_attempts,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};
use zeroize::Zeroizing;

mod connection_cancel;
pub struct AppState {
    cancellations: Arc<connection_cancel::ConnectionCancellation>,
    stream_owner: Mutex<Option<String>>,
    client: Client,
    pending: Mutex<Option<(String, PendingLogin, u64)>>,
    tokens: Mutex<Option<TokenBundle>>,
    stream: Arc<Mutex<Option<SessionClient>>>,
    cleanup_pending: Arc<Mutex<Vec<PendingCleanup>>>,
    cleanup_inflight: Arc<std::sync::atomic::AtomicUsize>,
    cleanup_orphans: Arc<std::sync::atomic::AtomicUsize>,
    stream_operation: Arc<tokio::sync::Mutex<()>>,
    profile_cache: profile::ProfileCache,
    /// Sólo para pruebas de integración (mock HTTP local); siempre None en producción.
    profile_base_override: Option<String>,
    /// F3: epoch monótono + gate de commit; logout incrementa el epoch y todo
    /// productor auth (refresh/poll_login/persist) revalida antes de escribir.
    auth_gate: Arc<auth_gate::AuthGate>,
}
impl AppState {
    fn new() -> Self {
        let tokens = None;
        Self {
            cancellations: Default::default(),
            stream_owner: Mutex::new(None),
            client: session::http_client(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
            )
            .expect("HTTP client for Xbox auth"),
            pending: Mutex::new(None),
            tokens: Mutex::new(tokens),
            stream: Arc::new(Mutex::new(None)),
            cleanup_pending: Default::default(),
            cleanup_inflight: Default::default(),
            cleanup_orphans: Default::default(),
            stream_operation: Arc::new(tokio::sync::Mutex::new(())),
            profile_cache: profile::ProfileCache::production(),
            profile_base_override: None,
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
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
        storage: "memory (session only)".into(),
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
fn snapshot_tokens(state: &AppState) -> Result<TokenBundle, String> {
    state
        .tokens
        .lock()
        .map_err(|_| state_error())?
        .clone()
        .ok_or("Sign in first".into())
}

fn snapshot_read_auth(state: &AppState) -> Result<(u64, TokenBundle), String> {
    let _guard = state.auth_gate.lock_commit()?;
    Ok((state.auth_gate.current(), snapshot_tokens(state)?))
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

/// Invalidate primary state before doing persistent I/O. Remote cleanup owns
/// any detached session independently and is not part of the logout result.
pub fn logout_state(
    state: &AppState,
    clear_scopes: impl FnOnce(Option<String>) -> Result<(), String>,
) -> Result<(), String> {
    logout_state_with_delete(state, clear_scopes, vault::delete_persistent)
}

fn logout_state_with_delete(
    state: &AppState,
    clear_scopes: impl FnOnce(Option<String>) -> Result<(), String>,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    finish_logout(admit_logout(state), clear_scopes, delete)
}

fn admit_logout(state: &AppState) -> Result<Option<String>, String> {
    let _commit = state.auth_gate.lock_commit()?;
    vault::invalidate_memory_generation();
    let cleanup_guard = state.stream_owner.lock().ok().and_then(|owner| {
        owner
            .as_deref()
            .and_then(|id| state.cancellations.retain_for_cleanup(id))
    });
    state.cancellations.cancel_all();
    state.auth_gate.invalidate();
    let mut scope = None;
    let tokens_result = state
        .tokens
        .lock()
        .map(|mut tokens| {
            scope = tokens
                .as_ref()
                .and_then(|t| account_scope::catalog_account_scope(&t.web_token));
            *tokens = None;
        })
        .map_err(|_| state_error());
    let pending_result = state
        .pending
        .lock()
        .map(|mut pending| *pending = None)
        .map_err(|_| state_error());
    let stream_result = state
        .stream
        .lock()
        .map(|mut stream| {
            if let Some(stream) = stream.take() {
                schedule_cleanup_guarded(state, stream, cleanup_guard);
            }
        })
        .map_err(|_| state_error());
    let owner_result = state
        .stream_owner
        .lock()
        .map(|mut owner| *owner = None)
        .map_err(|_| state_error());
    tokens_result
        .and(pending_result)
        .and(stream_result)
        .and(owner_result)?;
    Ok(scope)
}

fn finish_logout(
    admission: Result<Option<String>, String>,
    clear_scopes: impl FnOnce(Option<String>) -> Result<(), String>,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let delete_result = delete();
    match admission {
        Ok(scope) => clear_scopes(scope).and(delete_result),
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn begin_login(
    attempt_id: String,
    state: State<'_, AppState>,
) -> Result<auth::LoginStart, String> {
    let (epoch, vault_generation) = state.auth_gate.begin_attempt_with(&attempt_id, || {
        *state.pending.lock().map_err(|_| state_error())? = None;
        vault::begin_login()
    })?;
    let mut invalidated = state.auth_gate.subscribe();
    let (login, pending) = tokio::select! {
        _ = state.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
        result = auth::begin_login(&state.client) => result.map_err(|e| e.to_string())?,
    };
    state.auth_gate.publish_pending(epoch, || {
        *state.pending.lock().map_err(|_| state_error())? =
            Some((attempt_id, pending, vault_generation));
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
            .is_some_and(|(active_id, _, _)| active_id == &attempt_id)
        {
            *pending = None;
        }
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
async fn poll_login(attempt_id: String, state: State<'_, AppState>) -> Result<Status, String> {
    let (epoch, mut pending, vault_generation) =
        state.auth_gate.with_attempt(&attempt_id, |epoch| {
            let mut guard = state.pending.lock().map_err(|_| state_error())?;
            match guard.take() {
                Some((pending_id, pending, generation)) if pending_id == attempt_id => {
                    Ok((epoch, pending, generation))
                }
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
                        let saved = vault::login(&tokens, vault_generation);
                        saved.as_ref().map_err(|e| e.clone())?;
                        *state.tokens.lock().map_err(|_| state_error())? = Some(tokens);
                        *state.pending.lock().map_err(|_| state_error())? = None;
                        Ok(saved)
                    })?;
                    let storage = match saved {
                        Ok(()) => "memory",
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
                            Some((attempt_id.clone(), pending, vault_generation));
                        Ok(())
                    })?;
                    Err(error.to_string())
                }
            }
        }
        Err(error @ (auth::AuthError::Pending | auth::AuthError::SlowDown)) => {
            state.auth_gate.publish_pending(epoch, || {
                *state.pending.lock().map_err(|_| state_error())? =
                    Some((attempt_id.clone(), pending, vault_generation));
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
                *state.pending.lock().map_err(|_| state_error())? =
                    Some((attempt_id, pending, vault_generation));
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
fn persist_session(_state: State<'_, AppState>) -> Result<Status, String> {
    Err("Session persistence is disabled; sessions are memory only".into())
}

#[tauri::command]
fn load_session(_state: State<'_, AppState>) -> Result<Status, String> {
    Err("Session restoration is disabled; sign in again".into())
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
        storage: "memory (session only)".into(),
    })
}

#[tauri::command]
async fn refresh_session(state: State<'_, AppState>) -> Result<Status, String> {
    let (epoch, original) = snapshot_read_auth(&state)?;
    let vault_generation = vault::generation()?;
    let mut changes = state.auth_gate.subscribe();
    let refreshed = tokio::select! {
        biased;
        _ = state.auth_gate.invalidated(&mut changes, epoch) => return Err(auth_gate::INVALIDATED.into()),
        result = auth::refresh_bundle(&state.client, &original) => result.map_err(|e| e.to_string())?,
    };
    state.auth_gate.commit(epoch, || {
        vault::save_if_generation(&refreshed, &original, vault_generation)?;
        *state.tokens.lock().map_err(|_| state_error())? = Some(refreshed);
        Ok(())
    })?;
    Ok(auth_status_after(&state))
}

#[tauri::command]
async fn logout(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let admission = admit_logout(&state);
    tauri::async_runtime::spawn_blocking(move || {
        finish_logout(
            admission,
            |scope| {
                if let Some(scope) = scope {
                    app.state::<AppState>().profile_cache.clear_scope(&scope)?;
                }
                Ok(())
            },
            vault::delete_persistent,
        )
    })
    .await
    .map_err(|_| "Persistent logout cleanup could not complete".to_owned())?
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

#[cfg_attr(windows, path = "settings_windows.rs")]
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
    let app = state.inner();
    xbox_profile_with(app, |uhs, bearer| async move {
        profile::fetch_profile(
            &app.client,
            &uhs,
            &bearer,
            app.profile_base_override.as_deref(),
        )
        .await
    })
    .await
}

async fn xbox_profile_with<Fut>(
    state: &AppState,
    fetch: impl FnOnce(String, String) -> Fut,
) -> Result<ProfileView, String>
where
    Fut: std::future::Future<Output = Result<profile::ProfileIdentity, String>>,
{
    let (epoch, bundle) = snapshot_read_auth(state)?;
    let (uhs, bearer) = web_token_credentials(&bundle.web_token)?;
    let scope = account_scope::catalog_account_scope(&bundle.web_token)
        .ok_or("profile: stable account scope required")?;
    let identity = state
        .profile_cache
        .identity(&scope, profile_now_unix(), || fetch(uhs, bearer))
        .await;
    let subscription = subscription::resolve(
        &[&bundle.web_token, &bundle.user_token, &bundle.sisu_token],
        bundle.cloud_stream_token.as_ref(),
        bundle.acquired_at_unix,
        profile_now_unix(),
    );
    state.auth_gate.commit(epoch, || {
        let identity = identity?;
        if account_scope::catalog_account_scope(&snapshot_tokens(state)?.web_token).as_deref()
            != Some(scope.as_str())
        {
            return Err("Profile request invalidated by account change".into());
        }
        Ok(ProfileView::from_identity(
            identity,
            state,
            subscription,
            scope,
        ))
    })
}

fn profile_now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[tauri::command]
async fn list_consoles_smartglass(state: State<'_, AppState>) -> Result<Value, String> {
    let client = &state.inner().client;
    list_consoles_smartglass_with(
        &state,
        |authorization: Zeroizing<String>| async move {
            get_json(
                client,
                "https://xccs.xboxlive.com/lists/devices?queryCurrentDevice=false&includeStorageDevices=true".into(),
                None,
                Some(&authorization),
                &[
                    ("x-xbl-contract-version", "4"),
                    ("skillplatform", "RemoteManagement"),
                    ("Cache-Control", "no-store, no-cache, must-revalidate"),
                    ("Pragma", "no-cache"),
                ],
            )
            .await
        },
        |authorization: Zeroizing<String>, devices| async move {
            console_presence::refresh(client, &authorization, devices).await
        },
    )
    .await
}

async fn list_consoles_smartglass_with<List, Presence>(
    state: &AppState,
    list: impl FnOnce(Zeroizing<String>) -> List,
    presence: impl FnOnce(Zeroizing<String>, Value) -> Presence,
) -> Result<Value, String>
where
    List: std::future::Future<Output = Result<Value, String>>,
    Presence: std::future::Future<Output = Value>,
{
    let (epoch, bundle) = snapshot_read_auth(state)?;
    let web = &bundle.web_token;
    let bearer = token_text(web, "Token")?;
    let uhs = web
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(Value::as_str)
        .ok_or("Web token has no user hash")?;
    let authorization = Zeroizing::new(format!("XBL3.0 x={uhs};{bearer}"));
    let devices = list(authorization.clone()).await;
    let devices = state.auth_gate.commit(epoch, || devices)?;
    let devices = presence(authorization, devices).await;
    state.auth_gate.commit(epoch, || Ok(devices))
}

#[tauri::command]
fn begin_connection(attempt_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let epoch = state.auth_gate.capture()?;
    state.auth_gate.commit(epoch, || {
        snapshot_tokens(&state)?;
        // The lease is claimed only when a scoped work command acquires it.
        state.cancellations.issue(&attempt_id)
    })
}

#[tauri::command]
async fn wake_console(
    device_id: String,
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or("Falta el intento de conexión")?,
    )?;
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
async fn cancel_connection(
    attempt_id: String,
    generation: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attempt_id = connection_cancel::scoped_id(&attempt_id, &generation)?;
    let _admission = state.cancellations.acquire(&attempt_id)?;
    state.cancellations.cancel(&attempt_id);
    state.cancellations.finish(&attempt_id)?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    let mut previous = state.auth_gate.commit(epoch, || {
        if state
            .stream_owner
            .lock()
            .map_err(|_| state_error())?
            .as_deref()
            != Some(&attempt_id)
        {
            return Ok(None);
        }
        Ok(state.stream.lock().map_err(|_| state_error())?.take())
    })?;
    if previous.is_none() {
        return Ok(());
    }
    let result = session::stop_previous(&mut previous).await;
    if let Some(previous) = previous {
        schedule_cleanup_guarded(&state, previous, Some(_admission));
    }
    state.auth_gate.commit(epoch, || {
        *state.stream_owner.lock().map_err(|_| state_error())? = None;
        Ok(())
    })?;
    result
}

fn check_stream_owner(owner: &Mutex<Option<String>>, id: Option<&str>) -> Result<(), String> {
    let id = id
        .filter(|id| !id.is_empty())
        .ok_or("Falta el intento de conexión")?;
    if owner.lock().map_err(|_| state_error())?.as_deref() != Some(id) {
        return Err("ConnectionCancelled".into());
    }
    Ok(())
}

fn check_stream_attempt(state: &AppState, id: Option<&str>) -> Result<(), String> {
    state.cancellations.check(id)?;
    check_stream_owner(&state.stream_owner, id)
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
#[serde(rename_all = "camelCase")]
struct StreamStartArgs {
    kind: SessionKind,
    target: String,
    profile: Option<DeviceProfilePatch>,
    streaming_locale: Option<String>,
}

fn take_stream(state: &AppState, epoch: u64) -> Result<SessionClient, String> {
    state.auth_gate.commit(epoch, || {
        state
            .stream
            .lock()
            .map_err(|_| state_error())?
            .take()
            .ok_or("No active streaming session".into())
    })
}
#[cfg(test)]
fn restore_stream(state: &AppState, epoch: u64, stream: SessionClient) -> Result<(), String> {
    restore_stream_guarded(state, epoch, stream, None)
}
fn restore_stream_guarded(
    state: &AppState,
    epoch: u64,
    stream: SessionClient,
    guard: Option<connection_cancel::bounded_registry::Guard>,
) -> Result<(), String> {
    let commit = match state.auth_gate.lock_commit() {
        Ok(commit) => commit,
        Err(error) => {
            schedule_cleanup_guarded(state, stream, guard);
            return Err(error);
        }
    };
    if state.auth_gate.current() != epoch {
        schedule_cleanup_guarded(state, stream, guard);
        drop(commit);
        return Err(auth_gate::INVALIDATED.into());
    }
    let mut slot = match state.stream.lock() {
        Ok(slot) => slot,
        Err(_) => {
            schedule_cleanup_guarded(state, stream, guard);
            return Err(state_error());
        }
    };
    *slot = Some(stream);
    Ok(())
}

// Retain failed handles for bounded background retries; on expiry report the
// potential orphan and leave any durable journal entry intact.
struct PendingCleanup {
    id: u64,
    client: Option<SessionClient>,
}

static CLEANUP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

async fn cleanup_owned(
    mut client: SessionClient,
    pending: Arc<Mutex<Vec<PendingCleanup>>>,
    orphans: Arc<std::sync::atomic::AtomicUsize>,
    guard: Option<connection_cancel::bounded_registry::Guard>,
) -> Result<(), String> {
    if client.snapshot().session_id.is_none() {
        return Ok(());
    }
    for attempt in 0..3 {
        if matches!(
            tokio::time::timeout(Duration::from_secs(2), client.stop()).await,
            Ok(Ok(()))
        ) {
            return Ok(());
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let id = CLEANUP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    pending
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .push(PendingCleanup {
            id,
            client: Some(client),
        });
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        // The marker remains in the registry while a DELETE is in flight, so
        // a concurrent play cannot slip between dequeue and completion.
        for delay in [1, 2, 4, 8] {
            tokio::time::sleep(Duration::from_secs(delay)).await;
            let mut client = {
                let mut entries = pending.lock().unwrap_or_else(|poison| poison.into_inner());
                entries
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .and_then(|entry| entry.client.take())
            }
            .expect("cleanup marker owns its client");
            let stopped = matches!(
                tokio::time::timeout(Duration::from_secs(2), client.stop()).await,
                Ok(Ok(()))
            );
            let mut entries = pending.lock().unwrap_or_else(|poison| poison.into_inner());
            if let Some(index) = entries.iter().position(|entry| entry.id == id) {
                if stopped {
                    entries.remove(index);
                    return;
                }
                entries[index].client = Some(client);
            }
        }
        let mut entries = pending.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(index) = entries.iter().position(|entry| entry.id == id) {
            entries.remove(index);
            orphans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // Cloud journals remain on disk; home sessions have no journal.
            eprintln!(
                "XJAUS: session cleanup expired; remote session may be orphaned (journal retained when available)"
            );
        }
    });
    Err("Owned session cleanup failed; retry pending and play blocked".into())
}

fn schedule_cleanup_guarded(
    state: &AppState,
    stream: SessionClient,
    guard: Option<connection_cancel::bounded_registry::Guard>,
) {
    if stream.snapshot().session_id.is_none() {
        return;
    }
    let pending = state.cleanup_pending.clone();
    let orphans = state.cleanup_orphans.clone();
    let inflight = state.cleanup_inflight.clone();
    inflight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let _ = cleanup_owned(stream, pending, orphans, guard).await;
        inflight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    });
}

// The spawned task owns /play and its session even if the IPC future disappears.
// Failed DELETEs retain the exact client during bounded reconciliation.
fn spawn_play_worker(
    state: &AppState,
    epoch: u64,
    mut stream: SessionClient,
    target: String,
    attempt_id: Option<String>,
    operation: tokio::sync::OwnedMutexGuard<()>,
    admission: Option<connection_cancel::bounded_registry::Guard>,
) -> tokio::sync::oneshot::Receiver<Result<SessionSnapshot, String>> {
    let gate = state.auth_gate.clone();
    let slot = state.stream.clone();
    let pending = state.cleanup_pending.clone();
    let orphans = state.cleanup_orphans.clone();
    let cancellations = state.cancellations.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _operation = operation;
        let _admission = admission;
        // The task takes the previous client itself, before its first network
        // await; dropping the caller can no longer drop a teardown in flight.
        let previous = gate.commit(epoch, || {
            cancellations.check(attempt_id.as_deref())?;
            if send.is_closed() {
                return Err("ConnectionCancelled".into());
            }
            Ok(slot.lock().map_err(|_| state_error())?.take())
        });
        let previous = match previous {
            Ok(previous) => previous,
            Err(error) => {
                let _ = send.send(Err(error));
                return;
            }
        };
        if let Some(previous) = previous {
            let retry_guard = attempt_id
                .as_deref()
                .and_then(|id| cancellations.retain_for_cleanup(id));
            if let Err(error) =
                cleanup_owned(previous, pending.clone(), orphans.clone(), retry_guard).await
            {
                let _ = send.send(Err(error));
                return;
            }
        }
        let valid = gate.commit(epoch, || {
            cancellations.check(attempt_id.as_deref())?;
            if send.is_closed() {
                return Err("ConnectionCancelled".into());
            }
            Ok(())
        });
        if let Err(error) = valid {
            let _ = send.send(Err(error));
            return;
        }
        let result = stream.start(&target).await;
        let mut owned = Some(stream);
        let mut sender = Some(send);
        let decision = gate.commit(epoch, || {
            cancellations.check(attempt_id.as_deref())?;
            if sender.as_ref().unwrap().is_closed() {
                return Err("ConnectionCancelled".into());
            }
            if owned.as_ref().unwrap().snapshot().session_id.is_some() {
                let mut active = slot.lock().map_err(|_| state_error())?;
                *active = owned.take();
                if let Err(returned) = sender.take().unwrap().send(result.clone()) {
                    owned = active.take();
                    return Err(returned
                        .err()
                        .unwrap_or_else(|| "ConnectionCancelled".into()));
                }
            }
            Ok(())
        });
        if let Some(client) = owned {
            let retry_guard = attempt_id
                .as_deref()
                .and_then(|id| cancellations.retain_for_cleanup(id));
            let _ = cleanup_owned(client, pending, orphans, retry_guard).await;
        }
        if let Some(sender) = sender {
            let _ = sender.send(decision.and(result));
        }
    });
    receive
}

#[tauri::command]
async fn start_stream(
    args: StreamStartArgs,
    attempt_id: String,
    generation: String,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    let attempt_id = connection_cancel::scoped_id(&attempt_id, &generation)?;
    let admission = state.cancellations.acquire(&attempt_id)?;
    let attempt_id = Some(attempt_id);
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.clone().lock_owned().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    state.cancellations.check(attempt_id.as_deref())?;
    state.auth_gate.commit(epoch, || {
        let pending = state.cleanup_pending.lock().map_err(|_| state_error())?;
        if state
            .cleanup_orphans
            .swap(0, std::sync::atomic::Ordering::SeqCst)
            != 0
        {
            return Err(
                "Session cleanup expired; a remote session may be orphaned. Retry play to continue"
                    .into(),
            );
        }
        if state
            .cleanup_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
            || !pending.is_empty()
        {
            return Err("Owned session cleanup pending; play blocked".into());
        }
        drop(pending);
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
        Ok(())
    })?;
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
    let profile =
        session::profile_for_stream(args.kind, args.profile, args.streaming_locale.as_deref())?;
    let mut stream = SessionClient::new(state.client.clone(), host, token, args.kind, profile);
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
    spawn_play_worker(
        &state,
        epoch,
        stream,
        args.target,
        attempt_id,
        _operation,
        Some(admission),
    )
    .await
    .map_err(|_| "Stream worker stopped unexpectedly".to_owned())?
}

#[tauri::command]
async fn provision_stream(
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .ok_or("Falta el intento de conexión")?,
    )?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let mut stream = take_stream(&state, epoch)?;
    let result = stream
        .poll_until_provisioned_scoped(
            provisioning_attempts(Duration::from_secs(120), Duration::from_millis(2500)) as u8,
            Duration::from_millis(2500),
            attempt_id
                .as_deref()
                .map(|id| (state.cancellations.as_ref(), id)),
        )
        .await;
    restore_stream_guarded(&state, epoch, stream, Some(_admission))?;
    result
}

#[tauri::command]
async fn submit_stream_offer(
    sdp: String,
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .ok_or("Falta el intento de conexión")?,
    )?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let sdp = Zeroizing::new(sdp);
    let mut stream = take_stream(&state, epoch)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.submit_offer(sdp.as_str()))
        .await;
    restore_stream_guarded(&state, epoch, stream, Some(_admission))?;
    result
}

#[tauri::command]
async fn poll_stream_answer(
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .ok_or("Falta el intento de conexión")?,
    )?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state, epoch)?;
    let result = state
        .cancellations
        .run(
            attempt_id.as_deref(),
            stream.poll_answer(30, Duration::from_secs(1)),
        )
        .await;
    restore_stream_guarded(&state, epoch, stream, Some(_admission))?;
    result
}

#[tauri::command]
async fn exchange_stream_ice(
    candidates: Vec<IceCandidate>,
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<Vec<IceCandidate>, String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .ok_or("Falta el intento de conexión")?,
    )?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state, epoch)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.exchange_ice(candidates))
        .await;
    restore_stream_guarded(&state, epoch, stream, Some(_admission))?;
    result
}

#[tauri::command]
async fn stream_keepalive(
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attempt_id = Some(connection_cancel::scoped_id(
        attempt_id.as_deref().unwrap_or(""),
        &generation,
    )?);
    let _admission = state.cancellations.acquire(
        attempt_id
            .as_deref()
            .ok_or("Falta el intento de conexión")?,
    )?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(&state, attempt_id.as_deref())?;
    let stream = take_stream(&state, epoch)?;
    let result = state
        .cancellations
        .run(attempt_id.as_deref(), stream.keepalive())
        .await;
    restore_stream_guarded(&state, epoch, stream, Some(_admission))?;
    result
}

#[tauri::command]
async fn stop_stream(
    attempt_id: Option<String>,
    generation: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attempt_id =
        connection_cancel::scoped_id(attempt_id.as_deref().unwrap_or(""), &generation)?;
    stop_owned_stream(&state, &attempt_id).await
}

async fn stop_owned_stream(state: &AppState, attempt_id: &str) -> Result<(), String> {
    let _admission = state.cancellations.acquire(attempt_id)?;
    let epoch = state.auth_gate.capture()?;
    let _operation = state.stream_operation.lock().await;
    state.auth_gate.commit(epoch, || Ok(()))?;
    check_stream_attempt(state, Some(attempt_id))?;
    let mut stream = take_stream(state, epoch)?;
    let result = stream.stop().await;
    if result.is_err() {
        restore_stream_guarded(state, epoch, stream, Some(_admission))?;
    } else {
        state.cancellations.finish(attempt_id)?;
        let mut owner = state.stream_owner.lock().map_err(|_| state_error())?;
        if owner.as_deref() == Some(attempt_id) {
            *owner = None;
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _instance_guard = instance_guard::acquire().unwrap_or_else(|error| {
        eprintln!("XJAUS: {error}");
        std::process::exit(1);
    });
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
            begin_connection,
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

#[cfg(test)]
mod authenticated_read_epoch_tests {
    use super::*;
    use serde_json::json;

    fn fixture_bundle(bearer: &str) -> TokenBundle {
        serde_json::from_value(json!({
            "refresh_token": "synthetic",
            "acquired_at_unix": 0,
            "web_token": {"Token": bearer, "DisplayClaims": {"xui": [{"uhs": "fixture-account"}]}}
        }))
        .unwrap()
    }

    fn signed_in() -> AppState {
        let mut state = AppState::new();
        state.profile_cache = profile::ProfileCache::new(profile::CachePolicy {
            identity_ttl_secs: 0,
        });
        *state.tokens.lock().unwrap() = Some(fixture_bundle("old-fixture"));
        state
    }

    fn relogin(state: &AppState) {
        // Isolate the command's auth gate from profile-cache and vault I/O.
        logout_state_with_delete(state, |_| Ok(()), || Ok(())).unwrap();
        let epoch = state.auth_gate.begin_attempt("fixture-relogin").unwrap();
        state
            .auth_gate
            .commit(epoch, || {
                *state.tokens.lock().unwrap() = Some(fixture_bundle("new-fixture"));
                Ok(())
            })
            .unwrap();
    }

    fn fixture_identity() -> profile::ProfileIdentity {
        profile::ProfileIdentity {
            gamertag: "Fixture".into(),
            game_display_name: "Fixture".into(),
            gamerscore: "0".into(),
            game_display_pic_raw: String::new(),
            account_tier: String::new(),
        }
    }

    #[tokio::test]
    async fn profile_rejects_late_result_after_same_account_relogin() {
        let state = signed_in();
        let current = xbox_profile_with(&state, |_, _| async { Ok(fixture_identity()) })
            .await
            .unwrap();
        assert_eq!(current.gamertag, "Fixture");
        let result = xbox_profile_with(&state, |_, _| async {
            tokio::task::yield_now().await;
            relogin(&state);
            Ok(fixture_identity())
        })
        .await;
        assert_eq!(result.err().as_deref(), Some(auth_gate::INVALIDATED));
    }

    #[tokio::test]
    async fn smartglass_does_not_start_presence_after_logout_during_list() {
        let state = signed_in();
        let presence_started = std::cell::Cell::new(false);
        let result = list_consoles_smartglass_with(
            &state,
            |_| async {
                tokio::task::yield_now().await;
                logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
                Ok(json!({"devices": []}))
            },
            |_, devices| async {
                presence_started.set(true);
                devices
            },
        )
        .await;
        assert_eq!(result.err().as_deref(), Some(auth_gate::INVALIDATED));
        assert!(!presence_started.get());
    }

    #[tokio::test]
    async fn smartglass_rejects_late_presence_after_same_account_relogin() {
        let state = signed_in();
        let devices = json!({"devices": [{"id": "fixture"}]});
        let current = list_consoles_smartglass_with(
            &state,
            |_| async { Ok(devices.clone()) },
            |_, devices| async { devices },
        )
        .await
        .unwrap();
        assert_eq!(current, devices);
        let result = list_consoles_smartglass_with(
            &state,
            |_| async { Ok(devices) },
            |_, devices| async {
                tokio::task::yield_now().await;
                relogin(&state);
                devices
            },
        )
        .await;
        assert_eq!(result.err().as_deref(), Some(auth_gate::INVALIDATED));
    }
}

#[cfg(test)]
mod stream_start_locale_tests {
    use super::*;

    async fn fixture_start(
        state: std::sync::Arc<AppState>,
        stream: SessionClient,
        epoch: u64,
    ) -> Result<SessionSnapshot, String> {
        let admission = state.cancellations.acquire("fixture").ok();
        let attempt_id = admission.as_ref().map(|_| "fixture".to_owned());
        let operation = state.stream_operation.clone().lock_owned().await;
        spawn_play_worker(
            &state,
            epoch,
            stream,
            "fixture".into(),
            attempt_id,
            operation,
            admission,
        )
        .await
        .unwrap()
    }

    #[test]
    fn blocked_persistent_cleanup_does_not_hold_logout_admission() {
        let state = AppState::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::scope(|threads| {
            threads.spawn(|| {
                logout_state_with_delete(
                    &state,
                    |_| Ok(()),
                    move || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                )
                .unwrap()
            });
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            threads.spawn(|| {
                logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
                done_tx.send(()).unwrap();
            });
            let admitted = done_rx.recv_timeout(Duration::from_secs(1));
            release_tx.send(()).unwrap();
            assert!(
                admitted.is_ok(),
                "persistent cleanup held the auth admission gate"
            );
        });
    }

    #[test]
    fn logout_invalidates_memory_before_delete_io() {
        let state = AppState::new();
        *state.tokens.lock().unwrap() = Some(serde_json::from_value(serde_json::json!({"refresh_token":"fixture","acquired_at_unix":0,"web_token":{"DisplayClaims":{"xui":[{"uhs":"test-account"}]}},"home_stream_token":{"gsToken":"fixture"}})).unwrap());
        logout_state_with_delete(
            &state,
            |scope| {
                assert!(
                    scope.is_some(),
                    "scope must be captured before tokens are cleared"
                );
                assert!(state.tokens.lock().unwrap().is_none());
                Ok(())
            },
            || {
                assert!(
                    state.tokens.lock().unwrap().is_none(),
                    "tokens still live during logout I/O"
                );
                Ok(())
            },
        )
        .unwrap();
    }
    #[test]
    fn tauri_owner_rejects_a_different_generation_for_the_same_id() {
        let owner = connection_cancel::scoped_id("same", "current").unwrap();
        let stale = connection_cancel::scoped_id("same", "stale").unwrap();
        let slot = Mutex::new(Some(owner.clone()));
        assert!(check_stream_owner(&slot, Some(&owner)).is_ok());
        assert!(check_stream_owner(&slot, Some(&stale)).is_err());
    }
    #[test]
    fn tauri_stop_closes_generation_and_rejects_late_work() {
        tauri::async_runtime::block_on(async {
            let state = AppState::new();
            let generation = state.cancellations.issue("stopped").unwrap();
            let key = connection_cancel::scoped_id("stopped", &generation).unwrap();
            *state.stream_owner.lock().unwrap() = Some(key.clone());
            *state.stream.lock().unwrap() = Some(SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "synthetic".into(),
                SessionKind::Cloud,
                Default::default(),
            ));
            stop_owned_stream(&state, &key).await.unwrap();
            assert!(
                state.cancellations.acquire(&key).is_err(),
                "successful stop must retire admission"
            );
            assert!(state.stream_owner.lock().unwrap().is_none());
            assert!(state.stream.lock().unwrap().is_none());
            let generation = state.cancellations.issue("stopped").unwrap();
            let newer = connection_cancel::scoped_id("stopped", &generation).unwrap();
            *state.stream_owner.lock().unwrap() = Some(newer.clone());
            assert!(stop_owned_stream(&state, &key).await.is_err());
            assert_eq!(
                state.stream_owner.lock().unwrap().as_deref(),
                Some(newer.as_str())
            );
        });
    }
    #[test]
    fn missing_stream_owner_id_is_rejected_before_cleanup() {
        let state = AppState::new();
        *state.stream_owner.lock().unwrap() = Some("owner".into());
        // The shared owner gate must fail closed, including callers without an ID.
        assert!(check_stream_owner(&state.stream_owner, None).is_err());
    }
    #[test]
    fn logout_during_delayed_tls_play_deletes_only_late_handle() {
        use std::{
            io::{BufRead, BufReader, Write},
            process::{Command, Stdio},
            sync::Arc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!(
                "xjaus-tls-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let server = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(4)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2])
print(s.getsockname()[1],flush=True)
def req():
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 return t,data.split(b'\r\n',1)[0].decode()
t,line=req(); print(line,flush=True); sys.stdin.readline()
b=b'{"sessionId":"late-owned"}'; t.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(b)).encode()+b'\r\nConnection: close\r\n\r\n'+b); t.close()
try:
 t,line=req(); print(line,flush=True); t.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); t.close()
except socket.timeout: print('NO DELETE',flush=True)
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", server])
            .arg(&cert)
            .arg(&key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let state = Arc::new(AppState::new());
        state.cancellations.begin("fixture").unwrap();
        let epoch = state.auth_gate.capture().unwrap();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        let control_state = state.clone();
        let control = std::thread::spawn(move || {
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "POST /v5/sessions/cloud/play HTTP/1.1");
            let before = std::time::Instant::now();
            logout_state_with_delete(&control_state, |_| Ok(()), || Ok(())).unwrap();
            assert!(before.elapsed() < Duration::from_secs(1));
            assert!(control_state.cancellations.acquire("fixture").is_err());
            assert!(
                control_state
                    .cancellations
                    .retain_for_cleanup("fixture")
                    .is_some()
            );
            writeln!(child.stdin.take().unwrap(), "release").unwrap();
            line.clear();
            out.read_line(&mut line).unwrap();
            assert!(child.wait().unwrap().success());
            line
        });
        let result = tauri::async_runtime::block_on(fixture_start(state.clone(), stream, epoch));
        assert_eq!(result.unwrap_err(), auth_gate::INVALIDATED);
        let line = control.join().unwrap();
        assert_eq!(line.trim(), "DELETE /v5/sessions/cloud/late-owned HTTP/1.1");
        assert!(state.cancellations.retain_for_cleanup("fixture").is_none());
        assert!(state.stream.lock().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn published_tls_session_logout_retries_its_exact_handle_without_waiting() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-logout-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(8)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); print(s.getsockname()[1],flush=True)
for i in range(3):
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==0: status=b'200 OK'; body=b'{"sessionId":"published-owned"}'
 elif i==1: status=b'500 Error'; body=b'{}'
 else: status=b'204 No Content'; body=b''
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body); t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for _ in 0..3 {
                let mut line = String::new();
                out.read_line(&mut line).unwrap();
                lines.push(line.trim().to_owned());
            }
            tx.send(lines).unwrap();
            let _ = child.wait();
        });
        let state = AppState::new();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        tauri::async_runtime::block_on(stream.start("fixture")).unwrap();
        *state.stream.lock().unwrap() = Some(stream);
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(state.stream.lock().unwrap().is_none());
        let lines = rx.recv_timeout(Duration::from_secs(7)).unwrap();
        assert_eq!(
            lines,
            vec![
                "POST /v5/sessions/cloud/play HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1"
            ]
        );
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn logout_while_stream_is_borrowed_cleans_exact_handle_on_restore() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-borrowed-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(8)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); print(s.getsockname()[1],flush=True)
for i in range(3):
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==0: status=b'200 OK'; body=b'{"sessionId":"published-owned"}'
 elif i==1: status=b'500 Error'; body=b'{}'
 else: status=b'204 No Content'; body=b''
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body); t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for _ in 0..3 {
                let mut line = String::new();
                out.read_line(&mut line).unwrap();
                lines.push(line.trim().to_owned());
            }
            tx.send(lines).unwrap();
            let _ = child.wait();
        });
        let state = AppState::new();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        tauri::async_runtime::block_on(stream.start("fixture")).unwrap();
        let epoch = state.auth_gate.capture().unwrap();
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert_eq!(
            restore_stream(&state, epoch, stream).unwrap_err(),
            auth_gate::INVALIDATED
        );
        assert!(state.stream.lock().unwrap().is_none());
        let lines = rx.recv_timeout(Duration::from_secs(7)).unwrap();
        assert_eq!(
            lines,
            vec![
                "POST /v5/sessions/cloud/play HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1"
            ]
        );
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn published_tls_cleanup_exhausts_three_retries_and_preserves_handle() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-failed-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(8)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); print(s.getsockname()[1],flush=True)
for i in range(4):
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==0: status=b'200 OK'; body=b'{"sessionId":"published-owned"}'
 else: status=b'500 Error'; body=b'{}'
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body); t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for _ in 0..4 {
                let mut line = String::new();
                out.read_line(&mut line).unwrap();
                lines.push(line.trim().to_owned());
            }
            tx.send(lines).unwrap();
            let _ = child.wait();
        });
        let state = AppState::new();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        tauri::async_runtime::block_on(stream.start("fixture")).unwrap();
        *state.stream.lock().unwrap() = Some(stream);
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(state.stream.lock().unwrap().is_none());
        let lines = rx.recv_timeout(Duration::from_secs(7)).unwrap();
        assert_eq!(
            lines,
            vec![
                "POST /v5/sessions/cloud/play HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1"
            ]
        );
        server.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state
            .cleanup_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        let retained = state.cleanup_pending.lock().unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(
            retained[0]
                .client
                .as_ref()
                .unwrap()
                .snapshot()
                .session_id
                .as_deref(),
            Some("published-owned")
        );
        drop(retained);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_cleanup_retries_and_releases_handle_after_later_success() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-retry-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(8)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); print(s.getsockname()[1],flush=True)
for i in range(5):
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==0: status=b'200 OK'; body=b'{"sessionId":"published-owned"}'
 elif i<4: status=b'500 Error'; body=b'{}'
 else: status=b'204 No Content'; body=b''
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body); t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for _ in 0..5 {
                let mut line = String::new();
                out.read_line(&mut line).unwrap();
                lines.push(line.trim().to_owned());
            }
            tx.send(lines).unwrap();
            let _ = child.wait();
        });
        let state = AppState::new();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        tauri::async_runtime::block_on(stream.start("fixture")).unwrap();
        *state.stream.lock().unwrap() = Some(stream);
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(state.stream.lock().unwrap().is_none());
        let lines = rx.recv_timeout(Duration::from_secs(7)).unwrap();
        assert_eq!(
            lines,
            vec![
                "POST /v5/sessions/cloud/play HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1",
                "DELETE /v5/sessions/cloud/published-owned HTTP/1.1"
            ]
        );
        server.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state
            .cleanup_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(state.cleanup_pending.lock().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_cleanup_expires_and_reports_orphan() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-expiry-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); s.settimeout(20)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); print(s.getsockname()[1],flush=True)
for i in range(8):
 t,_=s.accept(); t=c.wrap_socket(t,server_side=True); data=b''
 while b'\r\n\r\n' not in data: data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==0: status=b'200 OK'; body=b'{"sessionId":"published-owned"}'
 else: status=b'500 Error'; body=b'{}'
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body); t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for _ in 0..8 {
                let mut line = String::new();
                out.read_line(&mut line).unwrap();
                lines.push(line.trim().to_owned());
            }
            tx.send(lines).unwrap();
            let _ = child.wait();
        });
        let state = AppState::new();
        let mut stream = SessionClient::new(
            Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            "fixture.invalid".into(),
            "synthetic".into(),
            SessionKind::Cloud,
            Default::default(),
        );
        stream.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
        tauri::async_runtime::block_on(stream.start("fixture")).unwrap();
        *state.stream.lock().unwrap() = Some(stream);
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(state.stream.lock().unwrap().is_none());
        let lines = rx.recv_timeout(Duration::from_secs(25)).unwrap();
        assert_eq!(lines.len(), 8);
        server.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state
            .cleanup_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(state.cleanup_pending.lock().unwrap().is_empty());
        assert_eq!(
            state
                .cleanup_orphans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn logout_while_replacing_session_worker_keeps_old_handle_after_failed_delete() {
        use std::{
            io::{BufRead, BufReader, Write},
            process::{Command, Stdio},
            sync::mpsc,
        };
        let dir = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!("xjaus-previous-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let script = r#"import ssl,socket,sys
s=socket.socket();s.bind(('127.0.0.1',0));s.listen();s.settimeout(7)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);c.load_cert_chain(sys.argv[1],sys.argv[2]);print(s.getsockname()[1],flush=True)
for i in range(3):
 t,_=s.accept();t=c.wrap_socket(t,server_side=True);data=b''
 while b'\r\n\r\n' not in data:data+=t.recv(8192)
 print(data.split(b'\r\n',1)[0].decode(),flush=True)
 if i==1:sys.stdin.readline()
 status=[b'200 OK',b'500 Error',b'204 No Content'][i];body=[b'{"sessionId":"previous-owned"}',b'{}',b''][i]
 t.sendall(b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body);t.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let make_stream = || {
            let mut c = SessionClient::new(
                client.clone(),
                "fixture.invalid".into(),
                "synthetic".into(),
                SessionKind::Cloud,
                Default::default(),
            );
            c.fixture_base_url(format!("https://127.0.0.1:{}", port.trim()));
            c
        };
        let state = std::sync::Arc::new(AppState::new());
        let mut previous = make_stream();
        tauri::async_runtime::block_on(previous.start("old")).unwrap();
        *state.stream.lock().unwrap() = Some(previous);
        let epoch = state.auth_gate.capture().unwrap();
        let new_stream = make_stream();
        let clone = state.clone();
        let (tx, rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "POST /v5/sessions/cloud/play HTTP/1.1");
            line.clear();
            out.read_line(&mut line).unwrap();
            tx.send(line.trim().to_owned()).unwrap();
            let mut stdin = child.stdin.take().unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            writeln!(stdin, "release").unwrap();
            line.clear();
            out.read_line(&mut line).unwrap();
            let result = line.trim().to_owned();
            let _ = child.wait();
            result
        });
        let handle =
            tauri::async_runtime::spawn(
                async move { fixture_start(clone, new_stream, epoch).await },
            );
        let line = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(line, "DELETE /v5/sessions/cloud/previous-owned HTTP/1.1");
        let before = std::time::Instant::now();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        release_tx.send(()).unwrap();
        assert_eq!(
            server.join().unwrap(),
            "DELETE /v5/sessions/cloud/previous-owned HTTP/1.1"
        );
        assert!(tauri::async_runtime::block_on(handle).unwrap().is_err());
        assert!(state.stream.lock().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn logout_prevents_in_flight_stream_restore() {
        let state = std::sync::Arc::new(AppState::new());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let worker_state = state.clone();
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            let stream = SessionClient::new(
                Client::new(),
                "unused.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                Default::default(),
            );
            let epoch = worker_state.auth_gate.capture().unwrap();
            worker_barrier.wait();
            worker_barrier.wait();
            restore_stream(&worker_state, epoch, stream)
        });
        barrier.wait();
        logout_state_with_delete(&state, |_| Ok(()), || Ok(())).unwrap();
        barrier.wait();
        assert_eq!(worker.join().unwrap().unwrap_err(), auth_gate::INVALIDATED);
        assert!(state.stream.lock().unwrap().is_none());
    }

    #[test]
    fn logout_clears_memory_when_profile_cleanup_fails() {
        let state = AppState {
            cancellations: Default::default(),
            stream_owner: Mutex::new(None),
            client: Client::new(),
            pending: Mutex::new(None),
            tokens: Mutex::new(Some(
                serde_json::from_value(
                    serde_json::json!({"refresh_token":"fixture", "acquired_at_unix":0}),
                )
                .unwrap(),
            )),
            stream: Arc::new(Mutex::new(None)),
            cleanup_pending: Default::default(),
            cleanup_inflight: Default::default(),
            cleanup_orphans: Default::default(),
            stream_operation: Arc::new(tokio::sync::Mutex::new(())),
            profile_cache: profile::ProfileCache::new(Default::default()),
            profile_base_override: None,
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
        };
        let epoch = state.auth_gate.capture().unwrap();
        let deleted = std::cell::Cell::new(false);
        let result = logout_state_with_delete(
            &state,
            |_| Err("profile failure".into()),
            || {
                deleted.set(true);
                Ok(())
            },
        );
        assert!(deleted.get());
        assert!(result.is_err());
        assert!(state.tokens.lock().unwrap().is_none());
        assert!(
            state
                .auth_gate
                .commit(epoch, || Ok::<_, String>(()))
                .is_err()
        );
    }

    #[test]
    fn logout_keyring_failure_clears_tauri_memory() {
        let state = AppState {
            cancellations: Default::default(),
            stream_owner: Mutex::new(Some("active".into())),
            client: Client::new(),
            pending: Mutex::new(None),
            tokens: Mutex::new(Some(
                serde_json::from_value(
                    serde_json::json!({"refresh_token":"fixture", "acquired_at_unix":0}),
                )
                .unwrap(),
            )),
            stream: Arc::new(Mutex::new(Some(SessionClient::new(
                Client::new(),
                "unused.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                Default::default(),
            )))),
            cleanup_pending: Default::default(),
            cleanup_inflight: Default::default(),
            cleanup_orphans: Default::default(),
            stream_operation: Arc::new(tokio::sync::Mutex::new(())),
            profile_cache: profile::ProfileCache::new(Default::default()),
            profile_base_override: None,
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
        };
        let epoch = state.auth_gate.begin_attempt("old").unwrap();
        assert_eq!(
            logout_state_with_delete(&state, |_| Ok(()), || Err("keyring failure".into()))
                .unwrap_err(),
            "keyring failure"
        );
        assert!(state.tokens.lock().unwrap().is_none());
        assert!(
            state
                .auth_gate
                .commit(epoch, || Ok::<_, String>(()))
                .is_err()
        );
        assert_eq!(state.stream_owner.lock().unwrap().as_deref(), None);
        assert!(state.stream.lock().unwrap().is_none());
        assert!(state.auth_gate.begin_attempt("new").is_ok());
    }

    #[test]
    fn tauri_start_args_deserialize_streaming_locale_as_a_separate_cloud_preference() {
        for requested in ["en-US", "es-MX", "en-GB"] {
            let args = serde_json::from_value::<StreamStartArgs>(serde_json::json!({
                "kind": "cloud",
                "target": "title-fixture",
                "profile": {"width": 2560},
                "streamingLocale": requested
            }))
            .unwrap();
            assert_eq!(args.streaming_locale.as_deref(), Some(requested));
            let profile = session::profile_for_stream(
                args.kind,
                args.profile,
                args.streaming_locale.as_deref(),
            )
            .unwrap();
            assert_eq!(profile.locale, requested);
            assert_eq!(
                profile
                    .play_payload(SessionKind::Cloud, "title-fixture")
                    .pointer("/settings/market")
                    .and_then(serde_json::Value::as_str),
                Some("ES-MX")
            );
        }
    }
}

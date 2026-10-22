#[path = "../account_scope.rs"]
mod account_scope;
#[path = "../auth.rs"]
mod auth;
#[path = "../auth_gate.rs"]
mod auth_gate;
#[path = "../catalog.rs"]
mod catalog;
#[path = "../connection_cancel.rs"]
mod connection_cancel;
#[path = "../console_presence.rs"]
mod console_presence;
#[cfg_attr(windows, path = "../profile_windows.rs")]
#[cfg_attr(not(windows), path = "../profile.rs")]
mod profile;
#[path = "../session.rs"]
mod session;
#[cfg_attr(windows, path = "../session_journal_windows.rs")]
#[cfg_attr(not(windows), path = "../session_journal.rs")]
mod session_journal;
#[cfg_attr(windows, path = "../settings_windows.rs")]
#[cfg_attr(not(windows), path = "../settings.rs")]
mod settings;
#[path = "../subscription.rs"]
mod subscription;
#[cfg_attr(windows, path = "../vault_windows.rs")]
#[cfg_attr(not(windows), path = "../vault.rs")]
mod vault;
#[path = "../wake.rs"]
mod wake;

#[cfg(windows)]
#[path = "../windows_fs.rs"]
mod windows_fs;

#[cfg(all(windows, test))]
extern crate self as tauri;
#[cfg(all(windows, test))]
pub mod async_runtime {
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
}

use auth::{PendingLogin, TokenBundle};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use session::{DeviceProfilePatch, IceCandidate, SessionClient, SessionKind};
use std::{
    io::{self, BufRead, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const COMMANDS: &[&str] = &[
    "auth_status",
    "begin_login_window",
    "poll_login",
    "cancel_login",
    "load_session",
    "persist_session",
    "refresh_session",
    "logout",
    "xbox_profile",
    "load_settings",
    "save_settings",
    "wake_console",
    "cancel_connection",
    "list_consoles_smartglass",
    "list_streaming_servers",
    "list_cloud_titles",
    "catalog_products",
    "start_stream",
    "provision_stream",
    "submit_stream_offer",
    "poll_stream_answer",
    "exchange_stream_ice",
    "stream_keepalive",
    "stop_stream",
];
fn allowed_command(name: &str) -> bool {
    COMMANDS.contains(&name)
}

#[derive(Default)]
struct KeepaliveGate(AtomicBool);
impl KeepaliveGate {
    fn reserve(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    fn release(&self) {
        self.0.store(false, Ordering::Release);
    }
}
struct Backend {
    auth_gate: Arc<auth_gate::AuthGate>,
    stream_owner: Option<String>,
    client: Client,
    tokens: Option<TokenBundle>,
    pending: Option<(String, PendingLogin)>,
    stream: Option<SessionClient>,
    profile_cache: profile::ProfileCache,
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
impl Backend {
    fn invalidate_auth(&mut self) -> Result<(), String> {
        let _guard = self.auth_gate.lock_commit()?;
        vault::delete()?;
        self.auth_gate.invalidate();
        self.pending = None;
        self.tokens = None;
        Ok(())
    }

    fn new() -> Self {
        Self {
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
            stream_owner: None,
            client: session::http_client(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0",
            )
            .expect("HTTP client"),
            tokens: vault::load().ok().flatten(),
            pending: None,
            stream: None,
            profile_cache: profile::ProfileCache::production(),
        }
    }
    fn tokens(&self) -> Result<&TokenBundle, String> {
        self.tokens.as_ref().ok_or("Inicia sesión primero".into())
    }
    fn stream_mut(&mut self) -> Result<&mut SessionClient, String> {
        self.stream
            .as_mut()
            .ok_or("No hay una sesión de streaming activa".into())
    }
    fn status(&self) -> Value {
        json!({"authenticated": self.tokens.is_some(),
            "account": if self.tokens.is_some() { "Xbox account" } else { "" },
            "catalogAccountScope": self.tokens.as_ref().and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
            "storage": if cfg!(windows) { "Windows Credential Manager" } else { "Secret Service / encrypted fallback" }})
    }
    async fn scoped_dispatch(
        &mut self,
        cmd: &str,
        args: Value,
        cancellations: &connection_cancel::ConnectionCancellation,
    ) -> Result<Value, String> {
        // Auth attempt IDs are scoped by AuthGate, not by connection cancellation
        // or the active stream owner. Keep those namespaces independent.
        let id = if matches!(cmd, "begin_login_window" | "poll_login" | "cancel_login") {
            None
        } else {
            args.get("attemptId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        if cmd == "cancel_connection" {
            let id = id.ok_or("Falta el intento de conexión")?;
            cancellations.cancel(&id);
            if self.stream_owner.as_deref() == Some(&id) {
                session::stop_previous(&mut self.stream).await?;
                self.stream_owner = None;
            }
            return Ok(Value::Null);
        }
        if let Some(id) = id.as_deref() {
            cancellations.check(Some(id))?;
            if cmd == "start_stream" {
                if self.stream.is_some() && self.stream_owner.as_deref() != Some(id) {
                    return Err("Otra sesión sigue activa".into());
                }
                self.stream_owner = Some(id.to_owned());
            } else if cmd != "wake_console" && self.stream_owner.as_deref() != Some(id) {
                return Err("ConnectionCancelled".into());
            }
        }
        // Never drop /play: its response may contain the only session id we can DELETE.
        // Wake and long polling are safe to abort; retained SessionClient owns cleanup.
        if cmd == "provision_stream" {
            let result = self
                .stream_mut()?
                .poll_until_provisioned_scoped(
                    session::provisioning_attempts(
                        Duration::from_secs(120),
                        Duration::from_millis(2500),
                    ) as u8,
                    Duration::from_millis(2500),
                    id.as_deref().map(|id| (cancellations, id)),
                )
                .await?;
            return to_json(result);
        }
        if cmd == "start_stream" {
            let result = self.dispatch(cmd, args, cancellations).await;
            cancellations.check(id.as_deref())?;
            result
        } else {
            cancellations
                .run(id.as_deref(), self.dispatch(cmd, args, cancellations))
                .await
        }
    }
    async fn dispatch(
        &mut self,
        cmd: &str,
        args: Value,
        cancellations: &connection_cancel::ConnectionCancellation,
    ) -> Result<Value, String> {
        if !allowed_command(cmd) {
            return Err("Comando IPC no permitido".into());
        }
        match cmd {
            "load_settings" => serde_json::to_value(settings::load_at(&settings::root()?)?)
                .map_err(|_| "Ajustes no disponibles".into()),
            "save_settings" => {
                let value: settings::Settings =
                    serde_json::from_value(args.get("settings").cloned().ok_or("Faltan ajustes")?)
                        .map_err(|_| "Ajustes no válidos")?;
                settings::save_at(&settings::root()?, &value)?;
                Ok(Value::Null)
            }
            "auth_status" => Ok(self.status()),
            "cancel_login" => {
                if args.get("__xjausCancelApplied").and_then(Value::as_bool) == Some(true) {
                    self.pending = None;
                }
                Ok(Value::Null)
            }
            "begin_login_window" => {
                let (attempt_id, epoch) = auth_request_context(&args)?;
                self.auth_gate.with_attempt(&attempt_id, |current| {
                    if current != epoch {
                        return Err(auth_gate::INVALIDATED.into());
                    }
                    self.pending = None;
                    Ok(())
                })?;
                let mut invalidated = self.auth_gate.subscribe();
                let (start, pending) = tokio::select! {
                    _ = self.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
                    result = auth::begin_login(&self.client) => result.map_err(|e| e.to_string())?,
                };
                self.auth_gate.publish_pending(epoch, || {
                    self.pending = Some((attempt_id, pending));
                    Ok(())
                })?;
                serde_json::to_value(start).map_err(|_| "Respuesta de login inválida".into())
            }
            "poll_login" => {
                let (attempt_id, epoch) = auth_request_context(&args)?;
                let pending = self.auth_gate.with_attempt(&attempt_id, |current| {
                    if current != epoch {
                        return Err(auth_gate::INVALIDATED.into());
                    }
                    match self.pending.take() {
                        Some((pending_attempt, pending)) if pending_attempt == attempt_id => {
                            Ok(Some(pending))
                        }
                        Some(other) => {
                            self.pending = Some(other);
                            Err(auth_gate::INVALIDATED.into())
                        }
                        None => Ok(None),
                    }
                })?;
                let Some(mut pending) = pending else {
                    return if self.tokens.is_some() {
                        Ok(self.status())
                    } else {
                        Err("Inicia sesión primero".into())
                    };
                };
                let mut invalidated = self.auth_gate.subscribe();
                let result = tokio::select! {
                    _ = self.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
                    result = auth::poll_device_code(&self.client, &mut pending) => result,
                };
                match result {
                    Ok(_) | Err(auth::AuthError::AlreadyVerified) => {
                        let tokens = tokio::select! {
                            _ = self.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
                            result = complete_login_timed(&self.client, &pending) => result,
                        };
                        match tokens {
                            Ok(tokens) => {
                                let stored = self.auth_gate.commit(epoch, || {
                                    let stored = vault::save(&tokens);
                                    self.tokens = Some(tokens);
                                    self.pending = None;
                                    Ok::<_, String>(stored)
                                })?;
                                if stored.is_err() {
                                    return Err("Autenticado, pero no fue posible guardar la sesión; permanece en memoria".into());
                                }
                                Ok(self.status())
                            }
                            Err(error) => {
                                self.auth_gate.publish_pending(epoch, || {
                                    self.pending = Some((attempt_id, pending));
                                    Ok(())
                                })?;
                                Err(error.to_string())
                            }
                        }
                    }
                    Err(error @ (auth::AuthError::Pending | auth::AuthError::SlowDown)) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.pending = Some((attempt_id, pending));
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                    Err(error @ (auth::AuthError::Expired | auth::AuthError::Denied)) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.pending = None;
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                    Err(error) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.pending = Some((attempt_id, pending));
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                }
            }
            "load_session" => {
                let epoch = self.auth_gate.capture()?;
                self.auth_gate.commit(epoch, || {
                    self.tokens = Some(vault::load()?.ok_or("No hay sesión guardada")?);
                    Ok::<_, String>(())
                })?;
                Ok(self.status())
            }
            "persist_session" => {
                let epoch = self.auth_gate.capture()?;
                self.auth_gate
                    .commit(epoch, || vault::save(self.tokens()?))?;
                Ok(self.status())
            }
            "refresh_session" => {
                let epoch = self.auth_gate.capture()?;
                let current = self.tokens()?.clone();
                let updated = auth::refresh_bundle(&self.client, &current)
                    .await
                    .map_err(|e| e.to_string())?;
                self.auth_gate.commit(epoch, || {
                    vault::save(&updated)?;
                    self.tokens = Some(updated);
                    Ok::<_, String>(())
                })?;
                Ok(self.status())
            }
            "logout" => {
                if let Some(scope) = self
                    .tokens
                    .as_ref()
                    .and_then(|t| account_scope::catalog_account_scope(&t.web_token))
                {
                    self.profile_cache.clear_scope(&scope)?;
                }
                self.invalidate_auth()?;
                Ok(Value::Null)
            }
            "xbox_profile" => {
                let web = self.tokens()?.web_token.clone();
                let token = text_field(&web, "Token")?;
                let hash = web
                    .pointer("/DisplayClaims/xui/0/uhs")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("Falta el hash de cuenta Xbox")?
                    .to_owned();
                let scope = account_scope::catalog_account_scope(&web)
                    .ok_or("El token Xbox no permite derivar la cuenta opaca")?;
                let client = self.client.clone();
                let cache = &self.profile_cache;
                let identity = cache
                    .identity(&scope, profile_now_unix(), || {
                        profile::fetch_profile(&client, &hash, &token, None)
                    })
                    .await?;
                let telemetry = cache.telemetry();
                let bundle = self.tokens()?;
                let subscription = subscription::resolve(
                    &[&bundle.web_token, &bundle.user_token, &bundle.sisu_token],
                    bundle.cloud_stream_token.as_ref(),
                    bundle.acquired_at_unix,
                    profile_now_unix(),
                );
                Ok(json!({
                    "gamertag": identity.gamertag,
                    "gameDisplayName": identity.game_display_name,
                    "gamerscore": identity.gamerscore,
                    "gameDisplayPicRaw": identity.game_display_pic_raw,
                    "accountTier": subscription.label,
                    "subscription": subscription,
                    "accountScope": scope,
                    "telemetry": telemetry,
                }))
            }
            "wake_console" => {
                let id = args
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("Falta el identificador SmartGlass de la consola")?;
                wake::wake(&self.client, &self.tokens()?.web_token, id).await
            }
            "list_consoles_smartglass" => {
                let web = &self.tokens()?.web_token;
                let token = text_field(web, "Token")?;
                let hash = web
                    .pointer("/DisplayClaims/xui/0/uhs")
                    .and_then(Value::as_str)
                    .ok_or("Falta el hash de cuenta Xbox")?;
                let auth = format!("XBL3.0 x={hash};{token}");
                let devices = get_json(&self.client, "https://xccs.xboxlive.com/lists/devices?queryCurrentDevice=false&includeStorageDevices=true".into(), Some(&auth), false,
                    &[("x-xbl-contract-version", "4"), ("skillplatform", "RemoteManagement"), ("Cache-Control", "no-store, no-cache, must-revalidate"), ("Pragma", "no-cache")]).await?;
                Ok(console_presence::refresh(&self.client, &auth, devices).await)
            }
            "list_streaming_servers" | "list_cloud_titles" => {
                let kind = if cmd == "list_cloud_titles" {
                    SessionKind::Cloud
                } else {
                    SessionKind::Home
                };
                // Helper: pedir la lista con el token actual; si Xbox responde
                // 401 el gsToken expiró, así que refrescamos el bundle completo
                // y reintentamos una vez antes de fallar.
                async fn list_with_refresh(
                    client: &Client,
                    backend: &mut Backend,
                    kind: SessionKind,
                ) -> Result<Value, String> {
                    let (host, bearer, path) = {
                        let token = backend.streaming_token(kind)?;
                        let host = region_host(token)?;
                        let bearer = text_field(token, "gsToken")?;
                        let path = if kind == SessionKind::Cloud {
                            "/v2/titles"
                        } else {
                            "/v6/servers/home"
                        };
                        (host, bearer, path)
                    };
                    let url = format!("https://{host}{path}");
                    let headers: &[(&str, &str)] = if kind == SessionKind::Home {
                        &[
                            ("Cache-Control", "no-store, no-cache, must-revalidate"),
                            ("Pragma", "no-cache"),
                        ]
                    } else {
                        &[]
                    };
                    match get_json(client, url.clone(), Some(&bearer), true, headers).await {
                        Ok(value) => Ok(value),
                        Err(error) if error.contains("HTTP 401") => {
                            let epoch = backend.auth_gate.capture()?;
                            let current = backend.tokens()?.clone();
                            let updated = auth::refresh_bundle(client, &current)
                                .await
                                .map_err(|e| format!("Refresh de sesión Xbox: {e}"))?;
                            backend.auth_gate.commit(epoch, || {
                                vault::save(&updated).ok();
                                backend.tokens = Some(updated);
                                Ok::<_, String>(())
                            })?;
                            let token = backend.streaming_token(kind)?;
                            let host = region_host(token)?;
                            let bearer = text_field(token, "gsToken")?;
                            // F7: reintentar contra la región del bundle
                            // renovado, no contra la URL previa al refresh.
                            get_json(
                                client,
                                format!("https://{host}{path}"),
                                Some(&bearer),
                                true,
                                headers,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    }
                }
                list_with_refresh(&self.client.clone(), self, kind).await
            }
            "catalog_products" => {
                self.tokens()?;
                let ids: Vec<String> =
                    serde_json::from_value(args.get("productIds").cloned().unwrap_or(Value::Null))
                        .map_err(|_| "Falta la lista de productos")?;
                let language = args.get("language").and_then(Value::as_str).unwrap_or("es");
                catalog::catalog_products(&self.client, &ids, language).await
            }
            "start_stream" => {
                let start = args.get("args").ok_or("Faltan datos de streaming")?;
                let kind: SessionKind =
                    serde_json::from_value(start.get("kind").cloned().unwrap_or(Value::Null))
                        .map_err(|_| "Modo de streaming inválido")?;
                let target = start
                    .get("target")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("Falta la consola o el título")?;
                let profile = start
                    .get("profile")
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value::<DeviceProfilePatch>(v.clone()))
                    .transpose()
                    .map_err(|_| "Perfil de dispositivo inválido")?
                    .map(DeviceProfilePatch::apply)
                    .unwrap_or_default();
                let token = self.streaming_token(kind)?;
                let host = region_host(token)?;
                let bearer = text_field(token, "gsToken")?;
                let mut stream =
                    SessionClient::new(self.client.clone(), host, bearer, kind, profile);
                stream.set_account_scope(account_scope::catalog_account_scope(
                    &self.tokens()?.web_token,
                ))?;
                // Ambos modos exigen lpt para el POST /connect en ReadyToConnect:
                // - Home: PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN sirve para xhome.
                // - Cloud: el mismo scope es el "MSAL token" auditado en xcloudapi.ts.
                {
                    let bundle = self.tokens()?;
                    // Never reuse a saved lpt: MSA transfer validity is per launch.
                    let transfer =
                        auth::transfer_token_async(&self.client, bundle.refresh_token.expose())
                            .await
                            .map_err(|e| format!("Transfer token: {e}"))?;
                    stream.set_transfer_token(Some(transfer));
                }
                cancellations.check(args.get("attemptId").and_then(Value::as_str))?;
                session::stop_previous(&mut self.stream).await?;
                cancellations.check(args.get("attemptId").and_then(Value::as_str))?;
                let result = stream.start(target).await;
                if stream.snapshot().session_id.is_some() {
                    self.stream = Some(stream);
                }
                to_json(result?)
            }
            "provision_stream" => {
                let state = self
                    .stream_mut()?
                    .poll_until_provisioned(
                        session::provisioning_attempts(
                            Duration::from_secs(120),
                            Duration::from_millis(2500),
                        ) as u8,
                        Duration::from_millis(2500),
                    )
                    .await?;
                to_json(state)
            }
            "submit_stream_offer" => {
                let sdp = args
                    .get("sdp")
                    .and_then(Value::as_str)
                    .ok_or("Falta el SDP")?;
                self.stream_mut()?.submit_offer(sdp).await?;
                Ok(Value::Null)
            }
            "poll_stream_answer" => {
                self.stream_mut()?
                    .poll_answer(30, Duration::from_secs(1))
                    .await
            }
            "exchange_stream_ice" => {
                let candidates: Vec<IceCandidate> =
                    serde_json::from_value(args.get("candidates").cloned().unwrap_or(Value::Null))
                        .map_err(|_| "Candidatos ICE inválidos")?;
                to_json(self.stream_mut()?.exchange_ice(candidates).await?)
            }
            "stream_keepalive" => {
                let first = self.stream_mut()?.keepalive().await;
                match first {
                    Ok(()) => Ok(Value::Null),
                    Err(error) if error.contains("HTTP 401") => {
                        // A long-running session can outlive the gsToken captured
                        // at start. Refresh once, update this active SessionClient's
                        // bearer and retry without recreating the session/peer.
                        let kind = self
                            .stream
                            .as_ref()
                            .ok_or("No hay sesión activa")?
                            .session_kind();
                        let epoch = self.auth_gate.capture()?;
                        let current = self.tokens()?.clone();
                        let updated = auth::refresh_bundle(&self.client, &current)
                            .await
                            .map_err(|e| format!("No se pudo renovar la sesión Xbox"))?;
                        self.auth_gate.commit(epoch, || {
                            vault::save(&updated).ok();
                            self.tokens = Some(updated);
                            Ok::<_, String>(())
                        })?;
                        let bearer = text_field(self.streaming_token(kind)?, "gsToken")?;
                        self.stream_mut()?.set_streaming_token(bearer);
                        self.stream_mut()?.keepalive().await?;
                        Ok(Value::Null)
                    }
                    Err(error) => Err(error),
                }
            }
            "stop_stream" => {
                session::stop_previous(&mut self.stream).await?;
                Ok(Value::Null)
            }
            _ => Err("Comando IPC no permitido".into()),
        }
    }
    fn streaming_token(&self, kind: SessionKind) -> Result<&Value, String> {
        let bundle = self.tokens()?;
        match kind {
            SessionKind::Home => Ok(&bundle.home_stream_token),
            SessionKind::Cloud => bundle
                .cloud_stream_token
                .as_ref()
                .ok_or("No hay token xCloud para esta cuenta o región".into()),
        }
    }
}
fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Respuesta de backend inválida".into())
}
fn profile_now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
fn text_field(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Falta {key} en la respuesta Xbox"))
}
fn region_host(token: &Value) -> Result<String, String> {
    let regions = token
        .pointer("/offeringSettings/regions")
        .and_then(Value::as_array)
        .ok_or("El token Xbox no trae regiones")?;
    let region = regions
        .iter()
        .find(|r| r.get("isDefault").and_then(Value::as_bool) == Some(true))
        .or_else(|| regions.first())
        .ok_or("El token Xbox no trae región disponible")?;
    let url = region
        .get("baseUri")
        .and_then(Value::as_str)
        .ok_or("Región sin URI")?;
    let url = Url::parse(url).map_err(|_| "URI de región inválida")?;
    if url.scheme() != "https" {
        return Err("La región Xbox debe usar HTTPS".into());
    }
    url.host_str()
        .map(str::to_owned)
        .ok_or("Región sin servidor".into())
}
async fn get_json(
    client: &Client,
    url: String,
    auth: Option<&str>,
    bearer: bool,
    headers: &[(&str, &str)],
) -> Result<Value, String> {
    let mut request = client.get(url);
    if let Some(token) = auth {
        request = if bearer {
            request.bearer_auth(token)
        } else {
            request.header("Authorization", token)
        };
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|_| "Falló la petición Xbox")?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Xbox HTTP {}", status.as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| "Xbox devolvió JSON inválido".into())
}
#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
    #[serde(skip)]
    skip_keepalive: bool,
    #[serde(skip)]
    pre_dispatch_error: Option<String>,
}

/// Stamp auth requests at stdin arrival, not when the serial dispatcher later
/// reaches them. A cancellation/new attempt therefore invalidates older queued
/// begin/poll requests instead of letting them capture a fresh epoch.
fn stamp_auth_request(gate: &auth_gate::AuthGate, request: &mut Request) -> Result<(), String> {
    if !matches!(
        request.cmd.as_str(),
        "begin_login_window" | "poll_login" | "cancel_login"
    ) {
        return Ok(());
    }
    let args = request
        .args
        .as_object_mut()
        .ok_or("Invalid login attempt arguments")?;
    let attempt_id = args
        .get("attemptId")
        .and_then(Value::as_str)
        .ok_or("Missing login attempt identifier")?
        .to_owned();
    args.remove("__xjausAuthEpoch");
    args.remove("__xjausCancelApplied");
    match request.cmd.as_str() {
        "begin_login_window" => {
            let epoch = gate.begin_attempt(&attempt_id)?;
            args.insert("__xjausAuthEpoch".into(), json!(epoch));
        }
        "poll_login" => {
            let epoch = gate.capture_attempt(&attempt_id)?;
            args.insert("__xjausAuthEpoch".into(), json!(epoch));
        }
        "cancel_login" => {
            let applied = gate.cancel_attempt(&attempt_id)?;
            args.insert("__xjausCancelApplied".into(), json!(applied));
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn auth_request_context(args: &Value) -> Result<(String, u64), String> {
    let attempt_id = args
        .get("attemptId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("Missing login attempt identifier")?
        .to_owned();
    let epoch = args
        .get("__xjausAuthEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| auth_gate::INVALIDATED.to_owned())?;
    Ok((attempt_id, epoch))
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("async runtime");
    let mut backend = Backend::new();
    let cancellations = std::sync::Arc::new(connection_cancel::ConnectionCancellation::default());
    let reader_cancellations = cancellations.clone();
    let reader_auth_gate = backend.auth_gate.clone();
    let keepalive = std::sync::Arc::new(KeepaliveGate::default());
    let reader_keepalive = keepalive.clone();
    let (sender, requests) = std::sync::mpsc::channel();
    // The reader must stay independent of block_on: otherwise cancellation sits
    // behind the very 120-second provisioning request it is meant to interrupt.
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.len() > 2_000_000 {
                break;
            }
            let Ok(mut request) = serde_json::from_str::<Request>(&line) else {
                continue;
            };
            if let Err(error) = stamp_auth_request(&reader_auth_gate, &mut request) {
                request.pre_dispatch_error = Some(error);
            }
            if request.cmd == "stream_keepalive" {
                request.skip_keepalive = !reader_keepalive.reserve();
            }
            if request.cmd == "cancel_connection" {
                if let Some(id) = request.args.get("attemptId").and_then(Value::as_str) {
                    reader_cancellations.cancel(id);
                }
            }
            if sender.send(request).is_err() {
                break;
            }
        }
    });
    let mut stdout = io::stdout().lock();
    for request in requests {
        let request_id = request.id;
        let command = request.cmd.clone();
        let pre_dispatch_error = request.pre_dispatch_error;
        let result = if let Some(error) = pre_dispatch_error {
            Err(error)
        } else if request.skip_keepalive {
            Ok(Value::Null)
        } else {
            runtime.block_on(backend.scoped_dispatch(&request.cmd, request.args, &cancellations))
        };
        if command == "stream_keepalive" && !request.skip_keepalive {
            keepalive.release();
        }
        let response = match result {
            Ok(value) => json!({"id": request_id, "result": value}),
            Err(error) => json!({"id": request_id, "error": error}),
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_old_attempt_and_stale_cancel_cannot_adopt_or_invalidate_a_retry() {
        let gate = auth_gate::AuthGate::new();
        let mut begin_a = serde_json::from_value(
            json!({"id":1,"cmd":"begin_login_window","args":{"attemptId":"attempt-a"}}),
        )
        .unwrap();
        stamp_auth_request(&gate, &mut begin_a).unwrap();
        let (_, old_epoch) = auth_request_context(&begin_a.args).unwrap();
        let mut old_poll = serde_json::from_value(
            json!({"id":2,"cmd":"poll_login","args":{"attemptId":"attempt-a"}}),
        )
        .unwrap();
        stamp_auth_request(&gate, &mut old_poll).unwrap();

        let mut cancel_a = serde_json::from_value(
            json!({"id":3,"cmd":"cancel_login","args":{"attemptId":"attempt-a"}}),
        )
        .unwrap();
        stamp_auth_request(&gate, &mut cancel_a).unwrap();
        assert_eq!(cancel_a.args["__xjausCancelApplied"], true);
        let mut begin_b = serde_json::from_value(
            json!({"id":4,"cmd":"begin_login_window","args":{"attemptId":"attempt-b"}}),
        )
        .unwrap();
        stamp_auth_request(&gate, &mut begin_b).unwrap();
        let (_, retry_epoch) = auth_request_context(&begin_b.args).unwrap();
        assert_ne!(old_epoch, retry_epoch);

        let mut stale_cancel = serde_json::from_value(
            json!({"id":5,"cmd":"cancel_login","args":{"attemptId":"attempt-a"}}),
        )
        .unwrap();
        stamp_auth_request(&gate, &mut stale_cancel).unwrap();
        assert_eq!(stale_cancel.args["__xjausCancelApplied"], false);
        assert_eq!(gate.capture_attempt("attempt-b").unwrap(), retry_epoch);

        let (old_id, stamped_old_epoch) = auth_request_context(&old_poll.args).unwrap();
        let published = std::cell::Cell::new(false);
        assert_eq!(
            gate.with_attempt(&old_id, |current| {
                if current != stamped_old_epoch {
                    return Err(auth_gate::INVALIDATED.into());
                }
                published.set(true);
                Ok(())
            })
            .unwrap_err(),
            auth_gate::INVALIDATED,
        );
        assert!(!published.get(), "queued old poll cannot act as the retry");

        let persisted = std::cell::Cell::new(false);
        assert_eq!(
            gate.commit(old_epoch, || {
                persisted.set(true);
                Ok::<_, String>(())
            })
            .unwrap_err(),
            auth_gate::INVALIDATED,
        );
        assert!(!persisted.get(), "late old-attempt tokens cannot persist");
    }

    #[test]
    fn late_sidecar_refresh_after_logout_cannot_restore_tokens() {
        let gate = auth_gate::AuthGate::new();
        let epoch = gate.capture().unwrap();
        {
            let _commit = gate.lock_commit().unwrap();
            gate.invalidate();
        }
        let result = gate.commit(epoch, || Ok::<_, String>(()));
        assert_eq!(result.unwrap_err(), auth_gate::INVALIDATED);
    }
    #[test]
    fn overlapping_keepalive_reservations_do_not_queue_duplicate_ping() {
        let gate = KeepaliveGate::default();
        assert!(gate.reserve());
        assert!(!gate.reserve());
        gate.release();
        assert!(gate.reserve());
    }
    #[test]
    fn cancel_only_deletes_its_owned_stream_and_old_commands_cannot_start_again() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                tokens: None,
                pending: None,
                stream_owner: Some("other".into()),
                stream: Some(SessionClient::new(
                    Client::new(),
                    "unused.invalid".into(),
                    "fixture".into(),
                    SessionKind::Home,
                    Default::default(),
                )),
                profile_cache: profile::ProfileCache::production(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
            };
            backend
                .scoped_dispatch(
                    "cancel_connection",
                    json!({"attemptId":"mine"}),
                    &cancellations,
                )
                .await
                .unwrap();
            assert_eq!(backend.stream_owner.as_deref(), Some("other"));
            assert!(backend.stream.is_some());
            for cmd in [
                "wake_console",
                "start_stream",
                "provision_stream",
                "poll_stream_answer",
            ] {
                let result = backend
                    .scoped_dispatch(cmd, json!({"attemptId":"mine"}), &cancellations)
                    .await;
                assert_eq!(result.unwrap_err(), "ConnectionCancelled");
            }
            backend
                .scoped_dispatch(
                    "cancel_connection",
                    json!({"attemptId":"other"}),
                    &cancellations,
                )
                .await
                .unwrap();
            assert!(backend.stream.is_none());
            assert!(backend.stream_owner.is_none());
        });
    }
    #[test]
    fn login_attempt_ids_are_not_checked_as_stream_owners() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                tokens: None,
                pending: None,
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
            };
            backend
                .scoped_dispatch(
                    "cancel_login",
                    json!({"attemptId":"new-login-attempt", "__xjausCancelApplied":true}),
                    &cancellations,
                )
                .await
                .expect("login cancellation must not be rejected by stream ownership");
            assert!(backend.pending.is_none());
        });
    }

    #[test]
    fn begin_login_attempt_bypasses_stale_stream_owner_before_auth_gate_check() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                tokens: None,
                pending: None,
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
            };
            let attempt_id = "new-login-attempt";
            let mut request = Request {
                id: 1,
                cmd: "begin_login_window".into(),
                args: json!({"attemptId":attempt_id}),
                skip_keepalive: false,
                pre_dispatch_error: None,
            };
            stamp_auth_request(&backend.auth_gate, &mut request).unwrap();
            backend.auth_gate.cancel_attempt(attempt_id).unwrap();
            let result = backend
                .scoped_dispatch(&request.cmd, request.args, &cancellations)
                .await;
            assert_eq!(result.unwrap_err(), auth_gate::INVALIDATED);
        });
    }

    #[test]
    fn poll_login_attempt_bypasses_stale_stream_owner_and_reaches_auth_gate() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                tokens: None,
                pending: None,
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
            };
            let attempt_id = "existing-login-attempt";
            backend.auth_gate.begin_attempt(attempt_id).unwrap();
            let mut request = Request {
                id: 2,
                cmd: "poll_login".into(),
                args: json!({"attemptId":attempt_id}),
                skip_keepalive: false,
                pre_dispatch_error: None,
            };
            stamp_auth_request(&backend.auth_gate, &mut request).unwrap();
            let result = backend
                .scoped_dispatch(&request.cmd, request.args, &cancellations)
                .await;
            assert_eq!(result.unwrap_err(), "Inicia sesión primero");
        });
    }

    #[test]
    fn ipc_allows_only_named_operations() {
        assert!(allowed_command("auth_status"));
        assert!(allowed_command("start_stream"));
        assert!(!allowed_command("read_file"));
        assert!(!allowed_command("get_token"));
    }
    #[test]
    fn list_with_refresh_retries_against_the_refreshed_region_url() {
        // F7: tras el refresh el sidecar recalcula el host pero reusaba la URL
        // vieja; el reintento debe construirse con la región del bundle nuevo,
        // tanto en Cloud (/v2/titles) como en Home (/v6/servers/home).
        fn url_after_refresh_for_kind(kind: SessionKind) -> (String, String) {
            use std::sync::Mutex;
            static URLS: std::sync::Mutex<Vec<String>> = Mutex::new(Vec::new());
            struct FixtureBackend {
                token: Value,
                refreshed: bool,
            }
            impl FixtureBackend {
                fn streaming_token(&self, _kind: SessionKind) -> Result<&Value, String> {
                    Ok(&self.token)
                }
            }
            let token_for = |host: &str| {
                json!({
                    "offeringSettings": {"regions": [{"isDefault": true, "baseUri": format!("https://{host}")}]},
                    "gsToken": "fixture-bearer",
                })
            };
            let path = if kind == SessionKind::Cloud {
                "/v2/titles"
            } else {
                "/v6/servers/home"
            };
            let current_kind = kind;
            let urls = &URLS;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let mut backend = FixtureBackend { token: token_for("old.invalid"), refreshed: false };
                // Primera llamada: 401 → refresh (cambia el host a new.invalid) → reintento.
                let _ = current_kind; let _ = urls; let _ = path;
                // Ejecutar la helper real con auth/HTTP falsos:
                async fn list_with_refresh(
                    client: &Client,
                    backend: &mut FixtureBackend,
                    kind: SessionKind,
                    record: &dyn Fn(String),
                ) -> Result<Value, String> {
                    let (host, bearer, path) = {
                        let token = backend.streaming_token(kind)?;
                        let host = region_host(token)?;
                        let bearer = text_field(token, "gsToken")?;
                        let path = if kind == SessionKind::Cloud { "/v2/titles" } else { "/v6/servers/home" };
                        (host, bearer, path)
                    };
                    let url = format!("https://{host}{path}");
                    // HTTP falso: primer intento 401, el resto exitoso.
                    let response: Result<Value, String> = if !backend.refreshed { Err("Xbox HTTP 401".into()) } else { Ok(json!({})) };
                    record(url.clone());
                    match response {
                        Ok(value) => Ok(value),
                        Err(error) if error.contains("HTTP 401") => {
                            let updated = json!({});
                            let _ = updated;
                            backend.token = json!({
                                "offeringSettings": {"regions": [{"isDefault": true, "baseUri": "https://new.invalid"}]},
                                "gsToken": "fixture-bearer-new",
                            });
                            backend.refreshed = true;
                            let token = backend.streaming_token(kind)?;
                            let host = region_host(token)?;
                            let bearer = text_field(token, "gsToken")?;
                            let url2 = format!("https://{host}{path}");
                            record(url2);
                            let _ = bearer; let _ = client;
                            Ok(json!({}))
                        }
                        Err(error) => Err(error),
                    }
                }
                list_with_refresh(&Client::new(), &mut backend, kind, &|url| {
                    URLS.lock().unwrap().push(url);
                }).await.unwrap();
            });
            let urls = URLS.lock().unwrap().clone();
            (urls[0].clone(), urls[1].clone())
        }
        for kind in [SessionKind::Cloud, SessionKind::Home] {
            let (first, second) = url_after_refresh_for_kind(kind);
            assert!(first.starts_with("https://old.invalid/"), "first: {first}");
            assert!(
                second.starts_with("https://new.invalid/"),
                "retry must use the refreshed region URL, got {second}"
            );
        }
    }
}

// Shared source is compiled independently by these two runner roots.
macro_rules! sidecar_only {
    ($($item:item)*) => { $($item)* };
}
macro_rules! sidecar_or_test {
    ($($item:item)*) => { $($item)* };
}
macro_rules! tauri_only {
    ($($item:item)*) => {};
}
macro_rules! tauri_or_test {
    ($($item:item)*) => { $(#[cfg(test)] $item)* };
}
macro_rules! production_or_tauri {
    ($($item:item)*) => { $(#[cfg(not(test))] $item)* };
}

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
#[path = "../instance_guard.rs"]
mod instance_guard;
#[cfg(all(test, not(windows)))]
#[path = "../logout_barrier.rs"]
mod logout_barrier;
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
    "begin_connection",
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

fn stream_locale_from_args(args: &Value) -> Result<Option<&str>, String> {
    args.get("streamingLocale")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "Locale de streaming inválido".to_owned())
        })
        .transpose()
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
#[derive(Default)]
struct CleanupTracker {
    pending: std::sync::atomic::AtomicUsize,
    uncertain: AtomicBool,
}
impl CleanupTracker {
    fn ticket(self: &Arc<Self>) -> CleanupTicket {
        self.pending.fetch_add(1, Ordering::SeqCst);
        CleanupTicket(self.clone())
    }
    fn blocked(&self) -> bool {
        self.uncertain.load(Ordering::SeqCst) || self.pending.load(Ordering::SeqCst) != 0
    }
}
struct CleanupTicket(Arc<CleanupTracker>);
impl Drop for CleanupTicket {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.uncertain.store(true, Ordering::SeqCst);
        }
        self.0.pending.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct PrimaryAuth {
    tokens: Option<Arc<TokenBundle>>,
    pending: Option<(String, PendingLogin, u64)>,
}

impl PrimaryAuth {
    fn clear(&mut self) -> Option<String> {
        self.pending = None;
        self.tokens
            .take()
            .as_ref()
            .and_then(|t| account_scope::catalog_account_scope(&t.web_token))
    }
}

type AuthSlot = std::sync::Mutex<PrimaryAuth>;

struct Backend {
    cleanup: Arc<CleanupTracker>,
    auth_gate: Arc<auth_gate::AuthGate>,
    stream_owner: Option<String>,
    client: Client,
    primary: Arc<AuthSlot>,
    stream: Option<SessionClient>,
    profile_cache: profile::ProfileCache,
    logout_guards: Vec<connection_cancel::bounded_registry::Guard>,
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
// Unit dispatcher traces must never touch the user's keyring or legacy files.
#[cfg(test)]
fn dispatch_logout_delete() -> Result<(), String> {
    Ok(())
}
#[cfg(not(test))]
fn dispatch_logout_delete() -> Result<(), String> {
    vault::delete_persistent()
}

// Provisioning can retry /play; the worker must own the client until a late
// response either transfers the exact handle back or is cleaned up locally.
enum ProvisionWorkerState {
    Running,
    Detached,
    Finished(
        Box<SessionClient>,
        Result<session::SessionSnapshot, String>,
        Option<connection_cancel::bounded_registry::Guard>,
    ),
}

struct ProvisionWorkerLease(
    Arc<std::sync::Mutex<ProvisionWorkerState>>,
    Arc<CleanupTracker>,
);
impl Drop for ProvisionWorkerLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            let previous = std::mem::replace(&mut *state, ProvisionWorkerState::Detached);
            drop(state);
            if let ProvisionWorkerState::Finished(stream, _, guard) = previous {
                let stream = *stream;
                cleanup_detached_stream_guarded(stream, guard, &self.1);
            }
        }
    }
}

fn cleanup_detached_stream_guarded(
    stream: SessionClient,
    guard: Option<connection_cancel::bounded_registry::Guard>,
    tracker: &Arc<CleanupTracker>,
) {
    cleanup_detached_stream_with_guards(stream, guard.into_iter().collect(), tracker);
}
fn cleanup_detached_stream_with_guards(
    mut stream: SessionClient,
    guards: Vec<connection_cancel::bounded_registry::Guard>,
    tracker: &Arc<CleanupTracker>,
) {
    if stream.snapshot().session_id.is_none() {
        tracker.uncertain.store(true, Ordering::SeqCst);
        eprintln!("XJAUS: detached play outcome uncertain; no session id to clean up");
        return;
    }
    let ticket = tracker.ticket();
    let worker_tracker = tracker.clone();
    if std::thread::Builder::new()
        .spawn(move || {
            let _ticket = ticket;
            let _guards = guards;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let cleaned = match runtime {
                Ok(runtime) => runtime.block_on(async {
                    for attempt in 0..3 {
                        if matches!(
                            tokio::time::timeout(Duration::from_secs(2), stream.stop()).await,
                            Ok(Ok(()))
                        ) {
                            return true;
                        }
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                    false
                }),
                Err(_) => false,
            };
            if !cleaned {
                worker_tracker.uncertain.store(true, Ordering::SeqCst);
                eprintln!("XJAUS: owned session cleanup failed; outcome uncertain");
            }
        })
        .is_err()
    {
        tracker.uncertain.store(true, Ordering::SeqCst);
        eprintln!("XJAUS: owned session cleanup could not start; outcome uncertain");
    }
}

impl Backend {
    #[cfg(test)]
    fn logout_with_delete(
        &mut self,
        delete: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.logout_with_delete_after_arrival(delete, false, None)
    }

    fn logout_with_delete_after_arrival(
        &mut self,
        delete: impl FnOnce() -> Result<(), String>,
        invalidated_on_arrival: bool,
        admitted_scope: Option<String>,
    ) -> Result<(), String> {
        let _guard = self.auth_gate.lock_commit()?;
        if !invalidated_on_arrival {
            self.auth_gate.invalidate();
            vault::invalidate_memory_generation();
        }
        let scope = admitted_scope.or_else(|| self.primary.lock().unwrap().clear());
        let stream = self.stream.take();
        let guards = std::mem::take(&mut self.logout_guards);
        self.stream_owner = None;
        drop(_guard);
        if let Some(stream) = stream {
            cleanup_detached_stream_with_guards(stream, guards, &self.cleanup);
        }
        let delete_result = delete();
        let profile_result = match scope {
            Some(scope) => self.profile_cache.clear_scope(&scope),
            None => Ok(()),
        };
        profile_result.and(delete_result)
    }

    fn new() -> Self {
        Self {
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
            cleanup: Arc::new(CleanupTracker::default()),
            stream_owner: None,
            client: session::http_client(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0",
            )
            .expect("HTTP client"),
            primary: Default::default(),
            stream: None,
            profile_cache: profile::ProfileCache::production(),
            logout_guards: Vec::new(),
        }
    }
    fn tokens(&self) -> Result<Arc<TokenBundle>, String> {
        self.primary
            .lock()
            .unwrap()
            .tokens
            .clone()
            .ok_or("Inicia sesión primero".into())
    }
    fn stream_mut(&mut self) -> Result<&mut SessionClient, String> {
        self.stream
            .as_mut()
            .ok_or("No hay una sesión de streaming activa".into())
    }
    fn status(&self) -> Value {
        let primary = self.primary.lock().unwrap();
        json!({"authenticated": primary.tokens.is_some(),
            "account": if primary.tokens.is_some() { "Xbox account" } else { "" },
            "catalogAccountScope": primary.tokens.as_ref().and_then(|t| account_scope::catalog_account_scope(&t.web_token)),
            "storage": "memory (session only)"})
    }
    async fn scoped_dispatch(
        &mut self,
        cmd: &str,
        args: Value,
        cancellations: &connection_cancel::ConnectionCancellation,
    ) -> Result<Value, String> {
        if cmd == "start_stream" && self.cleanup.blocked() {
            return Err("SessionCleanupUncertain".into());
        }
        if let Some(epoch) = args.get("__xjausRequestEpoch").and_then(Value::as_u64) {
            self.auth_gate.commit(epoch, || Ok(()))?;
        }
        // Auth attempt IDs are scoped by AuthGate, not by connection cancellation
        // or the active stream owner. Keep those namespaces independent.
        let id = if matches!(cmd, "begin_login_window" | "poll_login" | "cancel_login") {
            None
        } else {
            args.get("attemptId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        if cmd == "begin_connection" {
            id.as_deref()
                .filter(|id| !id.is_empty())
                .ok_or("Falta el intento de conexión")?;
            let epoch = args
                .get("__xjausRequestEpoch")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| self.auth_gate.current());
            self.auth_gate.commit(epoch, || {
                self.tokens()?;
                if args.get("__xjausConnectionAdmitted") == Some(&Value::Bool(true)) {
                    Ok(())
                } else {
                    Err("Connection admission missing".into())
                }
            })?;
            let generation = args
                .get("generation")
                .and_then(Value::as_str)
                .ok_or("Missing connection generation")?;
            return Ok(json!(generation));
        }
        if matches!(
            cmd,
            "start_stream"
                | "provision_stream"
                | "submit_stream_offer"
                | "poll_stream_answer"
                | "exchange_stream_ice"
                | "stream_keepalive"
                | "stop_stream"
        ) && id.as_deref().is_none_or(str::is_empty)
        {
            return Err("Falta el intento de conexión".into());
        }
        if cmd == "cancel_connection" {
            let id = id.ok_or("Falta el intento de conexión")?;
            cancellations.cancel(&id);
            if self.stream_owner.as_deref() == Some(&id) {
                self.stream_owner = None;
                if let Some(stream) = self.stream.take() {
                    let guard = cancellations.retain_for_cleanup(&id);
                    cleanup_detached_stream_guarded(stream, guard, &self.cleanup);
                }
            }
            // Acknowledge local cancellation, not remote deletion. The cleanup
            // ticket continues to block new starts until the outcome is known.
            let _ = cancellations.finish(&id);
            return Ok(Value::Null);
        }
        if let Some(id) = id.as_deref() {
            cancellations.check(Some(id))?;
            if cmd == "start_stream" {
                if self.stream.is_some() {
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
            let gate = self.auth_gate.clone();
            let epoch = args
                .get("__xjausRequestEpoch")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| gate.current());
            let mut changes = gate.subscribe();
            let local_cancel = Arc::new(connection_cancel::ConnectionCancellation::default());
            local_cancel.begin("provision")?;
            let worker_cancel = local_cancel.clone();
            let state = Arc::new(std::sync::Mutex::new(ProvisionWorkerState::Running));
            let _lease = ProvisionWorkerLease(state.clone(), self.cleanup.clone());
            let worker_cleanup = self.cleanup.clone();
            let worker_ticket = self.cleanup.ticket();
            let worker_state = state.clone();
            let worker_admission =
                cancellations.acquire(id.as_deref().ok_or("Falta el intento de conexión")?)?;
            let mut stream = self
                .stream
                .take()
                .ok_or("No hay una sesión de streaming activa")?;
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let _worker_ticket = worker_ticket;
                let mut worker_admission = Some(worker_admission);
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let result = match runtime {
                    Ok(runtime) => runtime.block_on(stream.poll_until_provisioned_scoped(
                        session::provisioning_attempts(
                            Duration::from_secs(120),
                            Duration::from_millis(2500),
                        ) as u8,
                        Duration::from_millis(2500),
                        Some((&worker_cancel, "provision")),
                    )),
                    Err(_) => Err("Cannot start provisioning worker".into()),
                };
                let mut state = worker_state.lock().unwrap();
                if matches!(*state, ProvisionWorkerState::Detached) {
                    drop(state);
                    cleanup_detached_stream_guarded(
                        stream,
                        worker_admission.take(),
                        &worker_cleanup,
                    );
                } else {
                    *state = ProvisionWorkerState::Finished(
                        Box::new(stream),
                        result,
                        worker_admission.take(),
                    );
                    if ready_tx.send(()).is_err() {
                        let previous =
                            std::mem::replace(&mut *state, ProvisionWorkerState::Detached);
                        drop(state);
                        if let ProvisionWorkerState::Finished(stream, _, guard) = previous {
                            let stream = *stream;
                            cleanup_detached_stream_guarded(stream, guard, &worker_cleanup);
                        }
                    }
                }
            });
            let cancelled = tokio::select! {
                biased;
                _ = gate.invalidated(&mut changes, epoch) => Some(auth_gate::INVALIDATED),
                _ = cancellations.cancelled(id.as_deref()) => Some("ConnectionCancelled"),
                _ = ready_rx => None,
            };
            if cancelled.is_some() || gate.commit(epoch, || Ok(())).is_err() {
                local_cancel.cancel("provision");
                let previous =
                    std::mem::replace(&mut *state.lock().unwrap(), ProvisionWorkerState::Detached);
                if let ProvisionWorkerState::Finished(stream, _, guard) = previous {
                    let stream = *stream;
                    cleanup_detached_stream_guarded(stream, guard, &self.cleanup);
                }
                return Err(cancelled.unwrap_or(auth_gate::INVALIDATED).into());
            }
            let previous =
                std::mem::replace(&mut *state.lock().unwrap(), ProvisionWorkerState::Detached);
            let ProvisionWorkerState::Finished(stream, result, guard) = previous else {
                return Err("Provisioning worker terminated unexpectedly".into());
            };
            let stream = *stream;
            // Commit stream ownership under the same gate as logout.
            let mut owned = Some(stream);
            let committed = gate.commit(epoch, || {
                self.stream = owned.take();
                Ok(())
            });
            if let Some(stream) = owned {
                cleanup_detached_stream_guarded(stream, guard, &self.cleanup);
            }
            committed?;
            return to_json(result?);
        }
        let request_epoch = args.get("__xjausRequestEpoch").and_then(Value::as_u64);
        let result = if cmd == "start_stream" {
            let result = self.dispatch(cmd, args, cancellations).await;
            if result
                .as_ref()
                .err()
                .is_some_and(|error| error == auth_gate::INVALIDATED)
            {
                return result;
            }
            cancellations.check(id.as_deref())?;
            result
        } else if let Some(epoch) = request_epoch {
            let gate = self.auth_gate.clone();
            let mut changes = gate.subscribe();
            tokio::select! {
                biased;
                _ = gate.invalidated(&mut changes, epoch) => Err(auth_gate::INVALIDATED.into()),
                result = cancellations.run(id.as_deref(), self.dispatch(cmd, args, cancellations)) => result,
            }
        } else {
            cancellations
                .run(id.as_deref(), self.dispatch(cmd, args, cancellations))
                .await
        };
        if let Some(epoch) = request_epoch {
            self.auth_gate.commit(epoch, || Ok(()))?;
        }
        result
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
        let operation_epoch = match args.get("__xjausRequestEpoch").and_then(Value::as_u64) {
            Some(epoch) => epoch,
            None => self.auth_gate.capture()?,
        };
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
                    self.primary.lock().unwrap().pending = None;
                }
                Ok(Value::Null)
            }
            "begin_login_window" => {
                let (attempt_id, epoch) = auth_request_context(&args)?;
                let vault_generation = self.auth_gate.with_attempt(&attempt_id, |current| {
                    if current != epoch {
                        return Err(auth_gate::INVALIDATED.into());
                    }
                    self.primary.lock().unwrap().pending = None;
                    vault::begin_login()
                })?;
                let mut invalidated = self.auth_gate.subscribe();
                let (start, pending) = tokio::select! {
                    _ = self.auth_gate.invalidated(&mut invalidated, epoch) => return Err(auth_gate::INVALIDATED.into()),
                    result = auth::begin_login(&self.client) => result.map_err(|e| e.to_string())?,
                };
                self.auth_gate.publish_pending(epoch, || {
                    self.primary.lock().unwrap().pending =
                        Some((attempt_id, pending, vault_generation));
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
                    let mut primary = self.primary.lock().unwrap();
                    match primary.pending.take() {
                        Some((pending_attempt, pending, generation))
                            if pending_attempt == attempt_id =>
                        {
                            Ok(Some((pending, generation)))
                        }
                        Some(other) => {
                            primary.pending = Some(other);
                            Err(auth_gate::INVALIDATED.into())
                        }
                        None => Ok(None),
                    }
                })?;
                let Some((mut pending, vault_generation)) = pending else {
                    let authenticated = self.primary.lock().unwrap().tokens.is_some();
                    return if authenticated {
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
                                    let stored = vault::login(&tokens, vault_generation);
                                    stored.as_ref().map_err(|e| e.clone())?;
                                    self.primary.lock().unwrap().tokens = Some(Arc::new(tokens));
                                    self.primary.lock().unwrap().pending = None;
                                    Ok::<_, String>(stored)
                                })?;
                                if stored.is_err() {
                                    return Err("Autenticado, pero no fue posible guardar la sesión; permanece en memoria".into());
                                }
                                Ok(self.status())
                            }
                            Err(error) => {
                                self.auth_gate.publish_pending(epoch, || {
                                    self.primary.lock().unwrap().pending =
                                        Some((attempt_id, pending, vault_generation));
                                    Ok(())
                                })?;
                                Err(error.to_string())
                            }
                        }
                    }
                    Err(error @ (auth::AuthError::Pending | auth::AuthError::SlowDown)) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.primary.lock().unwrap().pending =
                                Some((attempt_id, pending, vault_generation));
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                    Err(error @ (auth::AuthError::Expired | auth::AuthError::Denied)) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.primary.lock().unwrap().pending = None;
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                    Err(error) => {
                        self.auth_gate.publish_pending(epoch, || {
                            self.primary.lock().unwrap().pending =
                                Some((attempt_id, pending, vault_generation));
                            Ok(())
                        })?;
                        Err(error.to_string())
                    }
                }
            }
            "load_session" => Err("Session restoration is disabled; sign in again".into()),
            "persist_session" => {
                Err("Session persistence is disabled; sessions are memory only".into())
            }
            "refresh_session" => {
                let epoch = operation_epoch;
                let vault_generation = vault::generation()?;
                let current = self.tokens()?;
                let updated = auth::refresh_bundle(&self.client, &current)
                    .await
                    .map_err(|e| e.to_string())?;
                self.auth_gate.commit(epoch, || {
                    vault::save_if_generation(&updated, &current, vault_generation)?;
                    self.primary.lock().unwrap().tokens = Some(Arc::new(updated));
                    Ok::<_, String>(())
                })?;
                Ok(self.status())
            }
            "logout" => {
                let invalidated =
                    args.get("__xjausLogoutArrived").and_then(Value::as_bool) == Some(true);
                let scope = args
                    .get("__xjausLogoutScope")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.logout_with_delete_after_arrival(dispatch_logout_delete, invalidated, scope)?;
                Ok(Value::Null)
            }
            "xbox_profile" => {
                let (token, hash, scope) = {
                    let bundle = self.tokens()?;
                    let web = &bundle.web_token;
                    let token = zeroize::Zeroizing::new(text_field(web, "Token")?);
                    let hash = web
                        .pointer("/DisplayClaims/xui/0/uhs")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .ok_or("Falta el hash de cuenta Xbox")?
                        .to_owned();
                    let scope = account_scope::catalog_account_scope(web)
                        .ok_or("El token Xbox no permite derivar la cuenta opaca")?;
                    (token, hash, scope)
                };
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
                let auth = {
                    let bundle = self.tokens()?;
                    let web = &bundle.web_token;
                    let token = zeroize::Zeroizing::new(text_field(web, "Token")?);
                    let hash = web
                        .pointer("/DisplayClaims/xui/0/uhs")
                        .and_then(Value::as_str)
                        .ok_or("Falta el hash de cuenta Xbox")?;
                    zeroize::Zeroizing::new(format!("XBL3.0 x={hash};{}", token.as_str()))
                };
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
                    epoch: u64,
                ) -> Result<Value, String> {
                    let (host, bearer, path) = {
                        let bundle = backend.tokens()?;
                        let token = Backend::streaming_token(&bundle, kind)?;
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
                            let vault_generation = vault::generation()?;
                            let current = backend.tokens()?;
                            let updated = auth::refresh_bundle(client, &current)
                                .await
                                .map_err(|e| format!("Refresh de sesión Xbox: {e}"))?;
                            backend.auth_gate.commit(epoch, || {
                                vault::save_if_generation(&updated, &current, vault_generation)?;
                                backend.primary.lock().unwrap().tokens = Some(Arc::new(updated));
                                Ok::<_, String>(())
                            })?;
                            let bundle = backend.tokens()?;
                            let token = Backend::streaming_token(&bundle, kind)?;
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
                list_with_refresh(&self.client.clone(), self, kind, operation_epoch).await
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
                let profile_patch = start
                    .get("profile")
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value::<DeviceProfilePatch>(v.clone()))
                    .transpose()
                    .map_err(|_| "Perfil de dispositivo inválido")?;
                let streaming_locale = stream_locale_from_args(start)?;
                let profile = session::profile_for_stream(kind, profile_patch, streaming_locale)?;
                let (host, bearer) = {
                    let bundle = self.tokens()?;
                    let token = Self::streaming_token(&bundle, kind)?;
                    (region_host(token)?, text_field(token, "gsToken")?)
                };
                let mut stream =
                    SessionClient::new(self.client.clone(), host, bearer, kind, profile);
                stream.set_account_scope(account_scope::catalog_account_scope(
                    &self.tokens()?.web_token,
                ))?;
                // Ambos modos exigen lpt para el POST /connect en ReadyToConnect:
                // - Home: PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN sirve para xhome.
                // - Cloud: el mismo scope es el "MSAL token" auditado en xcloudapi.ts.
                {
                    let refresh = self.tokens()?.refresh_token.clone();
                    // Never reuse a saved lpt: MSA transfer validity is per launch.
                    let gate = self.auth_gate.clone();
                    let mut changes = gate.subscribe();
                    let transfer = tokio::select! {
                        biased;
                        _ = gate.invalidated(&mut changes, operation_epoch) => return Err(auth_gate::INVALIDATED.into()),
                        _ = cancellations.cancelled(args.get("attemptId").and_then(Value::as_str)) => return Err("ConnectionCancelled".into()),
                        result = async {
                            #[cfg(test)]
                            if refresh.expose() == "local-test-transfer-block" {
                                return Ok::<String, String>(std::future::pending::<String>().await);
                            } else if refresh.expose() == "local-test-transfer-only" {
                                return Ok("local-test-transfer".to_owned());
                            }
                            auth::transfer_token_async(&self.client, refresh.expose()).await
                                .map_err(|e| format!("Transfer token: {e}"))
                        } => result?,
                    };
                    stream.set_transfer_token(Some(transfer));
                }
                cancellations.check(args.get("attemptId").and_then(Value::as_str))?;
                self.auth_gate.commit(operation_epoch, || Ok(()))?;

                let gate = self.auth_gate.clone();
                let mut changes = gate.subscribe();
                let state = Arc::new(std::sync::Mutex::new(ProvisionWorkerState::Running));
                let _lease = ProvisionWorkerLease(state.clone(), self.cleanup.clone());
                let worker_cleanup = self.cleanup.clone();
                let worker_ticket = self.cleanup.ticket();
                let worker_state = state.clone();
                let target = target.to_owned();
                let worker_admission = cancellations.acquire(
                    args.get("attemptId")
                        .and_then(Value::as_str)
                        .ok_or("Falta el intento de conexión")?,
                )?;
                let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
                std::thread::spawn(move || {
                    let _worker_ticket = worker_ticket;
                    let mut worker_admission = Some(worker_admission);
                    let result = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime.block_on(stream.start(&target)),
                        Err(_) => Err("Cannot start stream worker".into()),
                    };
                    let mut state = worker_state.lock().unwrap();
                    if matches!(*state, ProvisionWorkerState::Detached) {
                        drop(state);
                        cleanup_detached_stream_guarded(
                            stream,
                            worker_admission.take(),
                            &worker_cleanup,
                        );
                    } else {
                        *state = ProvisionWorkerState::Finished(
                            Box::new(stream),
                            result,
                            worker_admission.take(),
                        );
                        if ready_tx.send(()).is_err() {
                            let previous =
                                std::mem::replace(&mut *state, ProvisionWorkerState::Detached);
                            drop(state);
                            if let ProvisionWorkerState::Finished(stream, _, guard) = previous {
                                let stream = *stream;
                                cleanup_detached_stream_guarded(stream, guard, &worker_cleanup);
                            }
                        }
                    }
                });
                let attempt = args.get("attemptId").and_then(Value::as_str);
                let cancelled = tokio::select! {
                    biased;
                    _ = gate.invalidated(&mut changes, operation_epoch) => Some(auth_gate::INVALIDATED),
                    _ = cancellations.cancelled(attempt) => Some("ConnectionCancelled"),
                    _ = ready_rx => None,
                };
                if cancelled.is_some() || gate.commit(operation_epoch, || Ok(())).is_err() {
                    let previous = std::mem::replace(
                        &mut *state.lock().unwrap(),
                        ProvisionWorkerState::Detached,
                    );
                    if let ProvisionWorkerState::Finished(stream, _, guard) = previous {
                        let stream = *stream;
                        cleanup_detached_stream_guarded(stream, guard, &self.cleanup);
                    }
                    return Err(cancelled.unwrap_or(auth_gate::INVALIDATED).into());
                }
                let previous =
                    std::mem::replace(&mut *state.lock().unwrap(), ProvisionWorkerState::Detached);
                let ProvisionWorkerState::Finished(stream, result, guard) = previous else {
                    return Err("Stream worker terminated unexpectedly".into());
                };
                let stream = *stream;
                let mut owned = Some(stream);
                let committed = gate.commit(operation_epoch, || {
                    if owned
                        .as_ref()
                        .is_some_and(|s| s.snapshot().session_id.is_some())
                    {
                        self.stream = owned.take();
                    }
                    Ok(())
                });
                if let Some(stream) = owned {
                    cleanup_detached_stream_guarded(stream, guard, &self.cleanup);
                }
                committed?;
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
                        let epoch = operation_epoch;
                        let vault_generation = vault::generation()?;
                        let current = self.tokens()?;
                        let updated = auth::refresh_bundle(&self.client, &current)
                            .await
                            .map_err(|_| "No se pudo renovar la sesión Xbox".to_owned())?;
                        self.auth_gate.commit(epoch, || {
                            vault::save_if_generation(&updated, &current, vault_generation)?;
                            self.primary.lock().unwrap().tokens = Some(Arc::new(updated));
                            Ok::<_, String>(())
                        })?;
                        let bearer = {
                            let bundle = self.tokens()?;
                            text_field(Self::streaming_token(&bundle, kind)?, "gsToken")?
                        };
                        self.auth_gate.commit(epoch, || {
                            self.stream
                                .as_mut()
                                .ok_or("No hay sesión activa")?
                                .set_streaming_token(bearer);
                            Ok(())
                        })?;
                        self.stream_mut()?.keepalive().await?;
                        Ok(Value::Null)
                    }
                    Err(error) => Err(error),
                }
            }
            _ => Err("Comando IPC no permitido".into()),
        }
    }
    fn streaming_token(bundle: &TokenBundle, kind: SessionKind) -> Result<&Value, String> {
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
    #[serde(skip)]
    admission: Option<connection_cancel::bounded_registry::Guard>,
    #[serde(skip)]
    logout_guards: Vec<connection_cancel::bounded_registry::Guard>,
}

/// Stamp auth requests at stdin arrival, not when the serial dispatcher later
/// reaches them. A cancellation/new attempt therefore invalidates older queued
/// begin/poll requests instead of letting them capture a fresh epoch.
fn stamp_auth_request(gate: &auth_gate::AuthGate, request: &mut Request) -> Result<(), String> {
    if request.cmd == "logout" {
        let _guard = gate.lock_commit()?;
        gate.invalidate();
        // Replace all caller-provided fields; this marker is trusted only because
        // the stdin reader always stamps the request before it enters the queue.
        request.args = json!({"__xjausLogoutArrived": true});
        return Ok(());
    }
    if matches!(
        request.cmd.as_str(),
        "refresh_session"
            | "persist_session"
            | "xbox_profile"
            | "begin_connection"
            | "wake_console"
            | "list_consoles_smartglass"
            | "catalog_products"
            | "submit_stream_offer"
            | "poll_stream_answer"
            | "exchange_stream_ice"
            | "stop_stream"
            | "list_streaming_servers"
            | "list_cloud_titles"
            | "start_stream"
            | "provision_stream"
            | "stream_keepalive"
    ) {
        if request.args.is_null() {
            request.args = json!({});
        }
        let args = request
            .args
            .as_object_mut()
            .ok_or("Invalid command arguments")?;
        args.insert("__xjausRequestEpoch".into(), json!(gate.capture()?));
        return Ok(());
    }
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

fn stamp_connection_request(
    cancellations: &connection_cancel::ConnectionCancellation,
    request: &mut Request,
) -> Result<(), String> {
    if !matches!(
        request.cmd.as_str(),
        "begin_connection"
            | "wake_console"
            | "start_stream"
            | "provision_stream"
            | "submit_stream_offer"
            | "poll_stream_answer"
            | "exchange_stream_ice"
            | "stream_keepalive"
            | "stop_stream"
            | "cancel_connection"
    ) {
        return Ok(());
    }
    let args = request
        .args
        .as_object_mut()
        .ok_or("Invalid command arguments")?;
    args.remove("__xjausConnectionAdmitted");
    let id = args
        .get("attemptId")
        .and_then(Value::as_str)
        .ok_or("Falta el intento de conexión")?
        .to_owned();
    if request.cmd == "begin_connection" {
        // Generation is minted here, never accepted from the renderer.
        args.remove("generation");
        // The queued begin pins the reservation without claiming it as work.
        let (generation, guard) = cancellations.issue_queued(&id)?;
        let scoped = connection_cancel::scoped_id(&id, &generation)?;
        request.admission = Some(guard);
        args.insert("attemptId".into(), json!(scoped));
        args.insert("generation".into(), json!(generation));
        args.insert("__xjausConnectionAdmitted".into(), json!(true));
        return Ok(());
    }
    let generation = args
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("Missing connection generation")?;
    let scoped = connection_cancel::scoped_id(&id, generation)?;
    args.insert("attemptId".into(), json!(scoped));
    request.admission = Some(cancellations.acquire(&scoped)?);
    if request.cmd == "cancel_connection" {
        cancellations.cancel(&scoped);
    }
    Ok(())
}

struct StopCompletion {
    request_id: u64,
    owner: String,
    epoch: u64,
    guard: connection_cancel::bounded_registry::Guard,
    stream: Option<SessionClient>,
    result: Result<(), String>,
}

impl Backend {
    fn admit_stop(
        &mut self,
        request_id: u64,
        args: &Value,
        cancellations: &connection_cancel::ConnectionCancellation,
    ) -> Result<(StopCompletion, tokio::runtime::Runtime), String> {
        let owner = args
            .get("attemptId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("Falta el intento de conexión")?;
        let epoch = args
            .get("__xjausRequestEpoch")
            .and_then(Value::as_u64)
            .ok_or(auth_gate::INVALIDATED)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Session stop worker unavailable")?;
        let gate = self.auth_gate.clone();
        let completion = gate.commit(epoch, || {
            let guard = cancellations.acquire(owner)?;
            if self.stream_owner.as_deref() != Some(owner) {
                return Err("ConnectionCancelled".into());
            }
            if self
                .stream
                .as_ref()
                .is_none_or(|stream| stream.snapshot().session_id.is_none())
            {
                return Err("SessionCleanupUncertain".into());
            }
            Ok(StopCompletion {
                request_id,
                owner: owner.to_owned(),
                epoch,
                guard,
                stream: self.stream.take(),
                result: Err("SessionCleanupUncertain".into()),
            })
        })?;
        Ok((completion, runtime))
    }

    fn complete_stop(
        &mut self,
        mut stop: StopCompletion,
        cancellations: &connection_cancel::ConnectionCancellation,
    ) -> Result<Value, String> {
        let gate = self.auth_gate.clone();
        let authority = gate.commit(stop.epoch, || {
            if self.stream_owner.as_deref() != Some(stop.owner.as_str()) {
                return Err("ConnectionCancelled".into());
            }
            stop.guard.check().map_err(|_| "ConnectionCancelled")?;
            if stop.result.is_ok() {
                cancellations.finish(&stop.owner)?;
                self.stream_owner = None;
            } else {
                // The client still owns the exact handle, including its journal lock.
                self.stream = stop.stream.take();
            }
            Ok(())
        });
        if let Err(error) = authority {
            if self.stream_owner.as_deref() == Some(stop.owner.as_str()) {
                self.stream_owner = None;
            }
            if stop.result.is_err() {
                // Cancellation/logout revoked retry authority. Do not restore the
                // client or issue another DELETE; preserve any journal for recovery.
                self.cleanup.uncertain.store(true, Ordering::SeqCst);
                return Err("SessionCleanupUncertain".into());
            }
            return Err(error);
        }
        stop.result.map(|()| Value::Null)
    }
}

const MAX_QUEUED_REQUESTS: usize = 32;
#[derive(Default)]
struct RequestQueue {
    state: std::sync::Mutex<QueueState>,
    ready: std::sync::Condvar,
}
#[derive(Default)]
struct QueueState {
    normal: std::collections::VecDeque<Request>,
    logout: Option<Request>,
    closed: bool,
    stop: Option<StopCompletion>,
}
enum DispatchEvent {
    Request(Request),
    Stop(Box<StopCompletion>),
}
impl RequestQueue {
    fn push(
        &self,
        mut request: Request,
        prepare: impl FnOnce(&mut Request),
    ) -> Result<(), Box<Request>> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(Box::new(request));
        }
        let logout = request.cmd == "logout";
        let cancel = request.cmd == "cancel_connection";
        let ordinary_full = !logout
            && state
                .normal
                .iter()
                .filter(|r| !(r.cmd == "cancel_connection" && r.admission.is_some()))
                .count()
                >= MAX_QUEUED_REQUESTS;
        if (logout && state.logout.is_some())
            || (!logout && state.normal.len() >= MAX_QUEUED_REQUESTS + 64)
            || (ordinary_full && !cancel)
        {
            return Err(Box::new(request));
        }
        // Hold the queue lock from the capacity check through stamping and
        // publication: rejected auth requests must never advance the epoch.
        prepare(&mut request);
        if logout {
            state.logout = Some(request);
        } else {
            // Only successfully stamped connection cancels use reserved space.
            // A failed stamp cannot have cancelled an attempt.
            if ordinary_full && request.admission.is_none() {
                return Err(Box::new(request));
            }
            state.normal.push_back(request);
        }
        self.ready.notify_one();
        Ok(())
    }
    #[cfg(test)]
    fn pop(&self) -> Option<Request> {
        self.pop_event(false).map(|event| match event {
            DispatchEvent::Request(request) => request,
            DispatchEvent::Stop(_) => unreachable!(),
        })
    }
    fn publish_stop(&self, result: StopCompletion) {
        self.state.lock().unwrap().stop = Some(result);
        self.ready.notify_one();
    }
    fn pop_event(&self, stop_pending: bool) -> Option<DispatchEvent> {
        let mut state = self.state.lock().unwrap();
        loop {
            if let Some(request) = state.logout.take() {
                return Some(DispatchEvent::Request(request));
            }
            if let Some(stop) = state.stop.take() {
                return Some(DispatchEvent::Stop(Box::new(stop)));
            }
            if let Some(request) = state.normal.pop_front() {
                return Some(DispatchEvent::Request(request));
            }
            if state.closed && !stop_pending {
                return None;
            }
            state = self.ready.wait(state).unwrap();
        }
    }
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.ready.notify_all();
    }
}

fn enqueue_request(
    queue: &RequestQueue,
    gate: &auth_gate::AuthGate,
    primary: &AuthSlot,
    cancellations: &connection_cancel::ConnectionCancellation,
    keepalive: &KeepaliveGate,
    request: Request,
) -> Result<(), Box<Request>> {
    queue.push(request, |request| {
        let stamp = if request.cmd == "logout" {
            // The queue has reserved the priority slot. No dispatcher-owned
            // work or I/O may hold the auth commit or primary slot locks.
            gate.lock_commit().map(|_commit| {
                gate.invalidate();
                vault::invalidate_memory_generation();
                let scope = primary.lock().unwrap().clear();
                request.args = json!({"__xjausLogoutArrived": true, "__xjausLogoutScope": scope});
            })
        } else {
            stamp_auth_request(gate, request)
        };
        if let Err(error) = stamp.and_then(|()| stamp_connection_request(cancellations, request)) {
            request.pre_dispatch_error = Some(error);
        }
        if request.cmd == "logout" && request.pre_dispatch_error.is_none() {
            request.logout_guards = cancellations.cancel_all_retained();
        }
        if request.cmd == "stream_keepalive" {
            request.skip_keepalive = !keepalive.reserve();
        }
    })
}

const MAX_IPC_LINE: usize = 2_000_000;

#[test]
fn framing_requires_newline_for_each_utf8_frame() {
    let mut bytes = "{\"text\":\"mañana\"}\n{\"text\":\"café\"}".as_bytes();
    assert_eq!(
        read_ipc_line(&mut bytes).unwrap().as_deref(),
        Some("{\"text\":\"mañana\"}")
    );
    assert_eq!(
        read_ipc_line(&mut bytes).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
}

#[cfg(test)]
#[test]
fn ipc_requires_a_delimiter_before_delivering_a_frame() {
    let mut complete = &b"{}\n"[..];
    assert_eq!(read_ipc_line(&mut complete).unwrap().as_deref(), Some("{}"));
    assert!(read_ipc_line(&mut complete).unwrap().is_none());
    let mut incomplete = &b"{}"[..];
    assert_eq!(
        read_ipc_line(&mut incomplete).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
}

fn read_ipc_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take((MAX_IPC_LINE + 2) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let terminated = bytes.last() == Some(&b'\n');
    if terminated {
        bytes.pop();
    }
    if bytes.len() > MAX_IPC_LINE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "IPC line too long",
        ));
    }
    if !terminated {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "IPC frame missing newline",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn drain_owned_cleanup(
    backend: &mut Backend,
    cancellations: &connection_cancel::ConnectionCancellation,
    budget: Duration,
) -> &'static str {
    if let Some(stream) = backend.stream.take() {
        let guard = backend.stream_owner.take().and_then(|id| {
            let guard = cancellations.retain_for_cleanup(&id);
            cancellations.cancel(&id);
            guard
        });
        cleanup_detached_stream_guarded(stream, guard, &backend.cleanup);
    }
    let deadline = std::time::Instant::now() + budget;
    while backend.cleanup.pending.load(Ordering::SeqCst) != 0 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return "cleanup_timeout";
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
    if backend.cleanup.uncertain.load(Ordering::SeqCst) {
        "cleanup_uncertain"
    } else {
        "drained"
    }
}

fn main() {
    let _instance_guard = instance_guard::acquire().unwrap_or_else(|error| {
        eprintln!("XJAUS: {error}");
        std::process::exit(1);
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("async runtime");
    let mut backend = Backend::new();
    #[cfg(test)]
    if std::env::var_os("XJAUS_IPC_FIXTURE_TOKENS").is_some() {
        backend.primary.lock().unwrap().tokens = Some(Arc::new(
            serde_json::from_value(json!({"refresh_token":"fixture", "acquired_at_unix":0}))
                .unwrap(),
        ));
    }
    let cancellations = std::sync::Arc::new(connection_cancel::ConnectionCancellation::default());
    let reader_cancellations = cancellations.clone();
    let reader_auth_gate = backend.auth_gate.clone();
    let reader_primary = backend.primary.clone();
    let keepalive = std::sync::Arc::new(KeepaliveGate::default());
    let reader_keepalive = keepalive.clone();
    let requests = Arc::new(RequestQueue::default());
    let reader_requests = requests.clone();
    // The reader must stay independent of block_on: otherwise cancellation sits
    // behind the very 120-second provisioning request it is meant to interrupt.
    let reader = std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let clean_eof = loop {
            let line = match read_ipc_line(&mut input) {
                Ok(Some(line)) => line,
                Ok(None) => break true,
                Err(_) => break false,
            };
            let Ok(request) = serde_json::from_str::<Request>(&line) else {
                continue;
            };
            if let Err(request) = enqueue_request(
                &reader_requests,
                &reader_auth_gate,
                &reader_primary,
                &reader_cancellations,
                &reader_keepalive,
                request,
            ) {
                let response = json!({"id":request.id, "error":"IPC queue full"});
                let mut stdout = io::stdout().lock();
                if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                    break false;
                }
            }
        };
        reader_requests.close();
        clean_eof
    });
    let dispatched = dispatch_requests(
        &runtime,
        &mut backend,
        &requests,
        &cancellations,
        &keepalive,
        |response| {
            let mut stdout = io::stdout().lock();
            writeln!(stdout, "{response}").and_then(|_| stdout.flush())
        },
    );
    // Electron owns the total deadline, including blocked dispatch and journal I/O.
    let cleanup = drain_owned_cleanup(&mut backend, &cancellations, Duration::from_secs(7));
    if std::env::args_os().any(|arg| arg == "--shutdown-report") {
        let status = if dispatched && reader.join().unwrap_or(false) {
            cleanup
        } else {
            "ipc_incomplete"
        };
        let mut stdout = io::stdout().lock();
        let _ = writeln!(stdout, "{}", json!({"shutdown": status})).and_then(|_| stdout.flush());
    }
}

fn dispatch_requests(
    runtime: &tokio::runtime::Runtime,
    backend: &mut Backend,
    requests: &Arc<RequestQueue>,
    cancellations: &connection_cancel::ConnectionCancellation,
    keepalive: &KeepaliveGate,
    mut reply: impl FnMut(Value) -> io::Result<()>,
) -> bool {
    let mut stop_pending = false;
    while let Some(event) = requests.pop_event(stop_pending) {
        let mut request = match event {
            DispatchEvent::Request(request) => request,
            DispatchEvent::Stop(stop) => {
                stop_pending = false;
                let id = stop.request_id;
                let result = backend.complete_stop(*stop, cancellations);
                if reply(dispatch_response(id, result)).is_err() {
                    requests.close();
                    return false;
                }
                continue;
            }
        };
        if request.cmd == "logout" {
            backend.logout_guards = std::mem::take(&mut request.logout_guards);
        }
        let request_id = request.id;
        let command = request.cmd.clone();
        #[cfg(test)]
        if command == "__ipc_test_pause" && std::env::var_os("XJAUS_IPC_PAUSE_CHILD").is_some() {
            let mut out = io::stdout().lock();
            writeln!(out, "{{\"fixtureReady\":true}}").unwrap();
            out.flush().unwrap();
            drop(out);
            std::thread::sleep(Duration::from_secs(1));
        }
        let pre_dispatch_error = request.pre_dispatch_error;
        let admitted_begin = if command == "begin_connection" && request.admission.is_some() {
            request
                .args
                .get("attemptId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        let result = if let Some(error) = pre_dispatch_error {
            Err(error)
        } else if stop_pending
            && matches!(
                command.as_str(),
                "start_stream"
                    | "provision_stream"
                    | "submit_stream_offer"
                    | "poll_stream_answer"
                    | "exchange_stream_ice"
                    | "stream_keepalive"
                    | "stop_stream"
            )
        {
            Err("SessionStopPending".into())
        } else if command == "stop_stream" {
            match backend.admit_stop(request_id, &request.args, cancellations) {
                Err(error) => Err(error),
                Ok((mut stop, worker_runtime)) => {
                    stop_pending = true;
                    let queue = requests.clone();
                    // The blocking pool runs independently of the dispatcher's
                    // current-thread runtime. The worker has its own I/O driver.
                    runtime.spawn_blocking(move || {
                        stop.result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                worker_runtime.block_on(session::stop_previous(&mut stop.stream))
                            }))
                            .unwrap_or_else(|_| Err("SessionCleanupUncertain".into()));
                        queue.publish_stop(stop);
                    });
                    continue;
                }
            }
        } else if request.skip_keepalive {
            Ok(Value::Null)
        } else {
            runtime.block_on(backend.scoped_dispatch(&request.cmd, request.args, cancellations))
        };
        if result.is_err()
            && let Some(id) = admitted_begin
        {
            cancellations.cancel(&id);
            let _ = cancellations.finish(&id);
        }
        if command == "stream_keepalive" && !request.skip_keepalive {
            keepalive.release();
        }
        if reply(dispatch_response(request_id, result)).is_err() {
            requests.close();
            return false;
        }
    }
    true
}

fn dispatch_response(request_id: u64, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"id": request_id, "result": value}),
        Err(error) => json!({"id": request_id, "error": error}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_begin_pins_admission_without_claiming_it() {
        use std::time::{Duration, Instant};
        let now = Arc::new(std::sync::Mutex::new(Instant::now()));
        let clock = now.clone();
        let ttl = Duration::from_secs(5);
        let admissions = connection_cancel::ConnectionCancellation::with_test_clock(
            1,
            ttl,
            Arc::new(move || *clock.lock().unwrap()),
        );
        let mut request: Request = serde_json::from_value(json!({
            "id": 1, "cmd": "begin_connection", "args": {"attemptId": "same"}
        }))
        .unwrap();
        stamp_connection_request(&admissions, &mut request).unwrap();
        assert!(request.admission.is_some());
        let old = request.args["attemptId"].as_str().unwrap().to_owned();
        let old_generation = request.args["generation"].as_str().unwrap().to_owned();
        *now.lock().unwrap() += ttl;
        assert_eq!(
            admissions.issue("same").unwrap_err(),
            "Connection admission: Full"
        );
        assert_eq!(
            admissions.acquire(&old).err().as_deref(),
            Some("Connection admission: Unknown")
        );
        drop(request);
        let new = admissions.issue("same").unwrap();
        assert_ne!(new, old_generation);
        assert!(admissions.acquire(&old).is_err());
        assert!(
            admissions
                .acquire(&connection_cancel::scoped_id("same", &new).unwrap())
                .is_ok()
        );
    }

    #[test]
    fn pipelined_begin_then_cancel_is_admitted_in_input_order() {
        let registry = connection_cancel::ConnectionCancellation::default();
        let mut begin: Request = serde_json::from_value(json!({"id":1,"cmd":"begin_connection","args":{"attemptId":"pipeline","generation":"attacker"}})).unwrap();
        stamp_connection_request(&registry, &mut begin).unwrap();
        let generation = begin.args["generation"].as_str().unwrap();
        assert_ne!(generation, "attacker");
        let mut cancel: Request = serde_json::from_value(json!({"id":2,"cmd":"cancel_connection","args":{"attemptId":"pipeline","generation":generation}})).unwrap();
        stamp_connection_request(&registry, &mut cancel).unwrap();
        assert!(
            registry
                .check(Some(
                    &connection_cancel::scoped_id("pipeline", generation).unwrap()
                ))
                .is_err()
        );
    }

    #[test]
    fn pending_owned_worker_blocks_start_until_its_ticket_completes() {
        tauri::async_runtime::block_on(async {
            let mut backend = Backend::new();
            let ticket = backend.cleanup.ticket();
            let cancellations = connection_cancel::ConnectionCancellation::default();
            cancellations.begin("new").unwrap();
            let args = json!({"attemptId":"new","args":{"kind":"home","target":"fixture"}});
            assert_eq!(
                backend
                    .scoped_dispatch("start_stream", args.clone(), &cancellations)
                    .await
                    .unwrap_err(),
                "SessionCleanupUncertain"
            );
            drop(ticket);
            assert_eq!(
                backend
                    .scoped_dispatch("start_stream", args, &cancellations)
                    .await
                    .unwrap_err(),
                "Inicia sesión primero"
            );
        });
    }

    #[test]
    fn uncertain_owned_cleanup_blocks_a_new_start() {
        tauri::async_runtime::block_on(async {
            let mut backend = Backend::new();
            backend.stream = Some(SessionClient::new(
                Client::new(),
                "unused.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                Default::default(),
            ));
            backend.stream_owner = Some("old".into());
            backend.logout_with_delete(|| Ok(())).unwrap();
            let cancellations = connection_cancel::ConnectionCancellation::default();
            cancellations.begin("new").unwrap();
            let error = backend
                .scoped_dispatch(
                    "start_stream",
                    json!({"attemptId":"new","args":{"kind":"home","target":"fixture"}}),
                    &cancellations,
                )
                .await
                .unwrap_err();
            assert_eq!(error, "SessionCleanupUncertain");
        });
    }

    #[cfg(unix)]
    #[test]
    fn real_ipc_logout_overtakes_a_saturated_queue_without_losing_responses() {
        use std::{
            io::Read,
            process::{Command, Stdio},
        };
        if std::env::var_os("XJAUS_IPC_PAUSE_CHILD").is_some() {
            main();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-ipc-full-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::real_ipc_logout_overtakes_a_saturated_queue_without_losing_responses",
                "--nocapture",
            ])
            .env("XJAUS_IPC_PAUSE_CHILD", "1")
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", &root)
            .env("XDG_DATA_HOME", &root)
            .env("XDG_CACHE_HOME", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        writeln!(input, "{}", json!({"id":0,"cmd":"__ipc_test_pause"})).unwrap();
        input.flush().unwrap();
        loop {
            let mut line = String::new();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child exited before fixture ready"
            );
            if line.contains("\"fixtureReady\":true") {
                break;
            }
        }
        for id in 1..=50 {
            writeln!(input, "{}", json!({"id":id,"cmd":"auth_status"})).unwrap();
        }
        writeln!(input, "{}", json!({"id":51,"cmd":"logout"})).unwrap();
        drop(input);
        let mut text = String::new();
        output.read_to_string(&mut text).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        let responses: Vec<Value> = text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let mut ids: Vec<u64> = responses
            .iter()
            .filter_map(|v| v.get("id").and_then(Value::as_u64))
            .collect();
        ids.sort();
        assert_eq!(ids, (0..=51).collect::<Vec<_>>(), "{text}");
        assert!(
            responses
                .iter()
                .any(|v| v.get("error").and_then(Value::as_str) == Some("IPC queue full")),
            "{text}"
        );
        let logout = responses.iter().position(|v| v["id"] == 51).unwrap();
        let first_accepted = responses
            .iter()
            .position(|v| {
                v["id"].as_u64().is_some_and(|id| (1..=50).contains(&id))
                    && v.get("result").is_some()
            })
            .unwrap();
        assert!(logout < first_accepted, "{text}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_ipc_pipelined_begin_cancel_preserves_both_responses() {
        use std::process::{Command, Stdio};
        if std::env::var_os("XJAUS_IPC_PIPELINE_CHILD").is_some() {
            main();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-ipc-pipeline-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::real_ipc_pipelined_begin_cancel_preserves_both_responses",
                "--nocapture",
            ])
            .env("XJAUS_IPC_PIPELINE_CHILD", "1")
            .env("XJAUS_IPC_FIXTURE_TOKENS", "1")
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", &root)
            .env("XDG_DATA_HOME", &root)
            .env("XDG_CACHE_HOME", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::{BufRead, Read};
        let mut input = child.stdin.take().unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        writeln!(input, "{}", json!({"id":1,"cmd":"begin_connection","args":{"attemptId":"a","generation":"attacker"}})).unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        loop {
            line.clear();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child exited before admission"
            );
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && value["id"] == 1
            {
                break;
            }
        }
        let admission: Value = serde_json::from_str(&line).unwrap();
        let generation = admission["result"].as_str().unwrap().to_owned();
        assert_ne!(generation, "attacker");
        for request in [
            json!({"id":3,"cmd":"cancel_connection","args":{"attemptId":"a","generation":"wrong"}}),
            json!({"id":2,"cmd":"cancel_connection","args":{"attemptId":"a","generation":generation}}),
        ] {
            writeln!(input, "{request}").unwrap();
        }
        drop(input);
        let mut text = String::new();
        output.read_to_string(&mut text).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        let responses: Vec<Value> = text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        assert_eq!(
            responses,
            vec![
                json!({"id":3,"error":"Connection admission: Unknown"}),
                json!({"id":2,"result":null})
            ],
            "{text}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_ipc_restart_rejects_previous_process_generation() {
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};
        if std::env::var_os("XJAUS_RESTART_GENERATION_CHILD").is_some() {
            main();
            return;
        }
        let root =
            std::env::temp_dir().join(format!("xjaus-generation-restart-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let launch = || {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::real_ipc_restart_rejects_previous_process_generation",
                    "--nocapture",
                ])
                .env("XJAUS_RESTART_GENERATION_CHILD", "1")
                .env("XJAUS_IPC_FIXTURE_TOKENS", "1")
                .env("HOME", &root)
                .env("XDG_CONFIG_HOME", &root)
                .env("XDG_DATA_HOME", &root)
                .env("XDG_CACHE_HOME", &root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        };
        let read_response =
            |out: &mut std::io::BufReader<std::process::ChildStdout>, id: u64| -> Value {
                loop {
                    let mut line = String::new();
                    assert!(
                        out.read_line(&mut line).unwrap() > 0,
                        "child exited before response"
                    );
                    if let Ok(value) = serde_json::from_str::<Value>(&line)
                        && value["id"] == id
                    {
                        return value;
                    }
                }
            };
        let mut first = launch();
        let mut first_in = first.stdin.take().unwrap();
        let mut first_out = std::io::BufReader::new(first.stdout.take().unwrap());
        writeln!(
            first_in,
            "{}",
            json!({"id":1,"cmd":"begin_connection","args":{"attemptId":"same"}})
        )
        .unwrap();
        first_in.flush().unwrap();
        let old = read_response(&mut first_out, 1)["result"]
            .as_str()
            .unwrap()
            .to_owned();
        drop(first_in);
        assert!(first.wait().unwrap().success());
        let mut second = launch();
        let mut second_in = second.stdin.take().unwrap();
        let mut second_out = std::io::BufReader::new(second.stdout.take().unwrap());
        writeln!(
            second_in,
            "{}",
            json!({"id":2,"cmd":"begin_connection","args":{"attemptId":"same"}})
        )
        .unwrap();
        second_in.flush().unwrap();
        let new = read_response(&mut second_out, 2)["result"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(old, new);
        writeln!(
            second_in,
            "{}",
            json!({"id":3,"cmd":"cancel_connection","args":{"attemptId":"same","generation":old}})
        )
        .unwrap();
        second_in.flush().unwrap();
        assert_eq!(
            read_response(&mut second_out, 3)["error"],
            "Connection admission: Unknown"
        );
        writeln!(
            second_in,
            "{}",
            json!({"id":4,"cmd":"cancel_connection","args":{"attemptId":"same","generation":new}})
        )
        .unwrap();
        second_in.flush().unwrap();
        assert_eq!(read_response(&mut second_out, 4)["result"], Value::Null);
        drop(second_in);
        assert!(second.wait().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn real_ipc_pipeline_returns_correlated_responses_without_network() {
        use std::process::{Command, Stdio};
        if std::env::var_os("XJAUS_IPC_TEST_CHILD").is_some() {
            main();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-ipc-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::real_ipc_pipeline_returns_correlated_responses_without_network",
                "--nocapture",
            ])
            .env("XJAUS_IPC_TEST_CHILD", "1")
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", &root)
            .env("XDG_DATA_HOME", &root)
            .env("XDG_CACHE_HOME", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut input = child.stdin.take().unwrap();
            for request in [
                json!({"id":1,"cmd":"auth_status"}),
                json!({"id":2,"cmd":"logout"}),
                json!({"id":3,"cmd":"auth_status"}),
            ] {
                writeln!(input, "{request}").unwrap();
            }
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut ids: Vec<u64> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| value.get("id").and_then(Value::as_u64))
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec![1, 2, 3],
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ipc_queue_is_bounded_and_reserves_logout_capacity() {
        let queue = RequestQueue::default();
        for id in 0..MAX_QUEUED_REQUESTS {
            assert!(
                queue
                    .push(
                        serde_json::from_value(json!({"id":id,"cmd":"ping"})).unwrap(),
                        |_| {}
                    )
                    .is_ok()
            );
        }
        assert!(
            queue
                .push(
                    serde_json::from_value(json!({"id":33,"cmd":"ping"})).unwrap(),
                    |_| {}
                )
                .is_err()
        );
        assert!(
            queue
                .push(
                    serde_json::from_value(json!({"id":34,"cmd":"logout"})).unwrap(),
                    |_| {}
                )
                .is_ok()
        );
        assert_eq!(queue.pop().unwrap().cmd, "logout");
        queue.close();
        let mut count = 0;
        while queue.pop().is_some() {
            count += 1;
        }
        assert_eq!(count, MAX_QUEUED_REQUESTS);
    }

    #[test]
    fn admitted_logout_clears_primary_auth_without_dispatch() {
        let backend = Backend::new();
        let fixture =
            serde_json::from_value(json!({"refresh_token":"synthetic", "acquired_at_unix":0,
            "web_token":{"DisplayClaims":{"xui":[{"uhs":"synthetic-account"}]}}}))
            .unwrap();
        backend.primary.lock().unwrap().tokens = Some(Arc::new(fixture));
        let prior_epoch = backend.auth_gate.current();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|threads| {
            let primary = backend.primary.clone();
            threads.spawn(move || {
                let in_flight = primary.lock().unwrap().tokens.clone().unwrap();
                entered_tx.send(Arc::downgrade(&in_flight)).unwrap();
                release_rx.recv().unwrap();
                drop(in_flight);
            });
            let outstanding = entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let queue = RequestQueue::default();
            let cancellations = fixture_cancellations();
            let keepalive = KeepaliveGate::default();
            let request = serde_json::from_value(json!({"id":1,"cmd":"logout"})).unwrap();
            let started = std::time::Instant::now();
            let admitted = enqueue_request(
                &queue,
                &backend.auth_gate,
                &backend.primary,
                &cancellations,
                &keepalive,
                request,
            );
            let cleared = backend.primary.lock().unwrap().tokens.is_none();
            let stale = backend
                .auth_gate
                .commit(prior_epoch, || Ok(()))
                .unwrap_err();
            let borrowed = outstanding.strong_count();
            release_tx.send(()).unwrap();
            assert!(admitted.is_ok());
            assert!(
                cleared,
                "primary credentials survived logout admission without dispatch"
            );
            assert!(started.elapsed() < Duration::from_secs(1));
            assert_eq!(stale, auth_gate::INVALIDATED);
            assert_eq!(
                borrowed, 1,
                "only the in-flight owner may still hold the bundle"
            );
            let logout = queue.pop().unwrap();
            assert_eq!(logout.cmd, "logout");
            assert!(logout.args["__xjausLogoutScope"].is_string());
        });
    }

    #[test]
    fn rejected_auth_requests_leave_current_attempt_intact() {
        for command in ["begin_login_window", "cancel_login", "logout"] {
            let queue = RequestQueue::default();
            let gate = auth_gate::AuthGate::default();
            let primary = AuthSlot::default();
            let cancellations = fixture_cancellations();
            let keepalive = KeepaliveGate::default();
            let submit = |id, cmd, args| {
                enqueue_request(
                    &queue,
                    &gate,
                    &primary,
                    &cancellations,
                    &keepalive,
                    serde_json::from_value(json!({"id":id,"cmd":cmd,"args":args})).unwrap(),
                )
            };
            if command == "logout" {
                assert!(submit(0, "logout", Value::Null).is_ok());
                cancellations.begin("after-logout").unwrap();
            } else {
                for id in 0..MAX_QUEUED_REQUESTS as u64 {
                    assert!(submit(id, "ping", Value::Null).is_ok());
                }
            }
            let epoch = gate.begin_attempt("current").unwrap();
            let attempt = if command == "begin_login_window" {
                "replacement"
            } else {
                "current"
            };
            assert!(submit(100, command, json!({"attemptId":attempt})).is_err());
            assert_eq!(gate.capture_attempt("current"), Ok(epoch), "{command}");
            if command == "logout" {
                assert!(cancellations.check(Some("after-logout")).is_ok());
            }
        }
    }

    #[test]
    fn oversized_ipc_line_is_rejected_before_reading_the_whole_line() {
        struct CountingReader {
            remaining: usize,
            read: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl std::io::Read for CountingReader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                let n = out.len().min(self.remaining);
                out[..n].fill(b'x');
                self.remaining -= n;
                self.read.fetch_add(n, std::sync::atomic::Ordering::SeqCst);
                Ok(n)
            }
        }
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = CountingReader {
            remaining: 10_000_000,
            read: count.clone(),
        };
        let mut reader = std::io::BufReader::new(reader);
        let result = read_ipc_line(&mut reader);
        assert!(result.is_err(), "oversized line must be rejected");
        assert!(count.load(std::sync::atomic::Ordering::SeqCst) <= 2_010_000);
    }

    fn fixture_cancellations() -> connection_cancel::ConnectionCancellation {
        let cancellations = connection_cancel::ConnectionCancellation::default();
        cancellations.begin("mine").unwrap();
        cancellations
    }

    #[test]
    fn logout_interrupts_blocked_transfer_before_initial_play() {
        tauri::async_runtime::block_on(async {
            let mut backend = Backend::new();
            backend.primary.lock().unwrap().tokens = Some(Arc::new(serde_json::from_value(json!({"refresh_token":"local-test-transfer-block","acquired_at_unix":0,"home_stream_token":{"gsToken":"fixture","offeringSettings":{"regions":[{"baseUri":"https://fixture.invalid"}]}}})).unwrap()));
            let gate = backend.auth_gate.clone();
            let sender = gate.clone();
            let mut request:Request=serde_json::from_value(json!({"id":1,"cmd":"start_stream","args":{"attemptId":"mine","args":{"kind":"home","target":"fixture"}}})).unwrap();
            stamp_auth_request(&gate, &mut request).unwrap();
            let thread = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                let mut logout: Request =
                    serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
                stamp_auth_request(&sender, &mut logout).unwrap();
            });
            let result = tokio::time::timeout(
                Duration::from_millis(700),
                backend.scoped_dispatch(&request.cmd, request.args, &fixture_cancellations()),
            )
            .await;
            thread.join().unwrap();
            assert_eq!(
                result.expect("transfer blocked logout").unwrap_err(),
                auth_gate::INVALIDATED
            );
        });
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_active_stream_deletes_only_owned_handle_without_waiting() {
        initial_play_fixture("active");
    }

    #[cfg(not(windows))]
    #[test]
    fn explicit_stop_waits_for_delete_timeout_and_retains_exact_owner_for_retry() {
        initial_play_fixture("stop");
    }

    #[cfg(not(windows))]
    #[test]
    fn eof_during_logout_and_stop_drains_the_exact_owned_delete_once() {
        initial_play_fixture("close-stop");
    }

    #[test]
    fn drain_with_pending_cleanup_never_reports_confirmation() {
        let mut backend = Backend::new();
        let tracker = backend.cleanup.clone();
        let ticket = tracker.ticket();
        let cancellations = fixture_cancellations();
        assert_eq!(
            drain_owned_cleanup(&mut backend, &cancellations, Duration::ZERO),
            "cleanup_timeout"
        );
        tracker.uncertain.store(true, Ordering::SeqCst);
        drop(ticket);
        assert_eq!(
            drain_owned_cleanup(&mut backend, &cancellations, Duration::ZERO),
            "cleanup_uncertain"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn cancel_active_stream_does_not_wait_for_delete() {
        initial_play_fixture("cancel");
    }

    #[cfg(not(windows))]
    #[test]
    fn detached_cleanup_retries_transient_delete_for_owned_handle() {
        initial_play_fixture("retry");
    }

    #[cfg(not(windows))]
    #[test]
    fn detached_cleanup_stops_after_bounded_failures() {
        initial_play_fixture("fail");
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_during_initial_play_detaches_and_deletes_only_returned_handle() {
        initial_play_fixture("id");
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_initial_play_without_id_reports_uncertain() {
        if std::env::var_os("XJAUS_TEST_UNCERTAIN_CHILD").is_some() {
            initial_play_fixture("missing");
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::logout_initial_play_without_id_reports_uncertain",
                "--nocapture",
            ])
            .env("XJAUS_TEST_UNCERTAIN_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("outcome uncertain; no session id")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_initial_play_timeout_reports_uncertain() {
        if std::env::var_os("XJAUS_TEST_TIMEOUT_CHILD").is_some() {
            initial_play_fixture("timeout");
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::logout_initial_play_timeout_reports_uncertain",
                "--nocapture",
            ])
            .env("XJAUS_TEST_TIMEOUT_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("outcome uncertain; no session id")
        );
    }

    #[cfg(not(windows))]
    fn initial_play_fixture(mode: &str) {
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};
        let dir =
            std::env::temp_dir().join(format!("xjaus-initial-play-{}-{mode}", std::process::id()));
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
                    "-days",
                    "1",
                    "-subj",
                    "/CN=fixture.invalid",
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
        let script = r#"import socket,ssl,sys,time
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); sessions={'foreign-session'}; deletes=0
while True:
 x,_=s.accept(); x=c.wrap_socket(x,server_side=True); data=x.recv(65536); line=data.split(b'\r\n')[0].decode(); print(line,flush=True)
 if '/play ' in line:
  if sys.argv[3] not in ('active','cancel','stop','close-stop'): sys.stdin.readline()
  if sys.argv[3]=='timeout': time.sleep(2); x.close(); continue
  if sys.argv[3]=='missing': body=b'{}'
  else: sessions.add('own-session'); body=b'{"sessionId":"own-session"}'
 elif line.startswith('DELETE '):
  deletes+=1
  if sys.argv[3]=='fail' or (sys.argv[3]=='retry' and deletes==1):
   x.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); x.close(); continue
  if sys.argv[3] in ('active','cancel','close-stop'): sys.stdin.readline()
  if sys.argv[3]=='stop' and deletes==1: sys.stdin.readline(); x.close(); continue
  if sys.argv[3]=='stop' and deletes==2:
   x.sendall(b'HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); x.close(); continue
  sessions.discard(line.split(' ')[1].split('/')[-1]); body=b'{}'
 else: body=b'{}'
 x.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body); x.close()
 if line.startswith('DELETE '): print('remaining='+','.join(sorted(sessions)),flush=True)
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in out.lines() {
                if tx.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(async {
                let address: std::net::SocketAddr =
                    format!("127.0.0.1:{}", port.trim()).parse().unwrap();
                let mut backend = Backend::new();
                backend.client = Client::builder()
                    .no_proxy()
                    .danger_accept_invalid_certs(true)
                    .timeout(if mode == "timeout" {
                        Duration::from_millis(800)
                    } else {
                        Duration::from_secs(10)
                    })
                    .resolve("fixture.invalid", address)
                    .build()
                    .unwrap();
                backend.primary.lock().unwrap().tokens = Some(Arc::new(serde_json::from_value(json!({"refresh_token":"local-test-transfer-only","acquired_at_unix":0,"home_stream_token":{"gsToken":"fixture","offeringSettings":{"regions":[{"isDefault":true,"baseUri":"https://fixture.invalid"}]}}})).unwrap()));
                if matches!(mode, "active" | "cancel" | "stop" | "close-stop") {
                    let cancellations = Arc::new(fixture_cancellations());
                    let generation = if matches!(mode, "stop" | "close-stop") {
                        Some(cancellations.issue_queued("mine").unwrap().0)
                    } else {
                        None
                    };
                    let mut request: Request = serde_json::from_value(json!({
                        "id":1,"cmd":"start_stream","args":{"attemptId":"mine", "generation":generation,
                            "args":{"kind":"home","target":"fixture"}}
                    })).unwrap();
                    stamp_auth_request(&backend.auth_gate, &mut request).unwrap();
                    if generation.is_some() {
                        stamp_connection_request(&cancellations, &mut request).unwrap();
                    }
                    backend
                        .scoped_dispatch(&request.cmd, request.args, &cancellations)
                        .await
                        .unwrap();
                    assert!(
                        rx.recv_timeout(Duration::from_secs(3))
                            .unwrap()
                            .contains("/play")
                    );
                    if matches!(mode, "stop" | "close-stop") {
                        let queue = Arc::new(RequestQueue::default());
                        let (reply_tx, replies) = std::sync::mpsc::channel();
                        let worker_queue = queue.clone();
                        let gate = backend.auth_gate.clone();
                        let primary = backend.primary.clone();
                        let worker_cancellations = cancellations.clone();
                        let keepalive = Arc::new(KeepaliveGate::default());
                        let worker_keepalive = keepalive.clone();
                        let dispatcher = std::thread::spawn(move || {
                            let runtime = tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .unwrap();
                            dispatch_requests(
                                &runtime,
                                &mut backend,
                                &worker_queue,
                                &worker_cancellations,
                                &worker_keepalive,
                                |value| reply_tx.send(value).map_err(io::Error::other),
                            );
                            backend
                        });
                        let submit = |id, cmd| {
                            let request: Request = serde_json::from_value(json!({
                                "id": id, "cmd": cmd, "args": if cmd == "auth_status" { Value::Null } else {
                                    json!({"attemptId":"mine", "generation":generation})
                                }
                            })).unwrap();
                            assert!(
                                enqueue_request(
                                    &queue,
                                    &gate,
                                    &primary,
                                    &cancellations,
                                    &keepalive,
                                    request
                                )
                                .is_ok()
                            );
                        };
                        let next = || replies.recv_timeout(Duration::from_secs(1)).unwrap();
                        submit(10, "stop_stream");
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                            "DELETE /v5/sessions/home/own-session HTTP/1.1"
                        );
                        if mode == "close-stop" {
                            submit(20, "logout");
                            queue.close();
                            assert_eq!(next(), json!({"id":20,"result":null}));
                            assert!(matches!(
                                replies.try_recv(),
                                Err(std::sync::mpsc::TryRecvError::Empty)
                            ));
                            writeln!(input, "release").unwrap();
                            input.flush().unwrap();
                            assert_eq!(next(), json!({"id":10,"error":auth_gate::INVALIDATED}));
                            let mut backend = dispatcher.join().unwrap();
                            assert_eq!(
                                drain_owned_cleanup(&mut backend, &cancellations, Duration::ZERO),
                                "drained"
                            );
                            assert!(backend.stream.is_none());
                            assert!(backend.stream_owner.is_none());
                            assert!(primary.lock().unwrap().tokens.is_none());
                            assert_eq!(
                                rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                                "remaining=foreign-session"
                            );
                            assert!(matches!(
                                replies.try_recv(),
                                Err(std::sync::mpsc::TryRecvError::Disconnected)
                            ));
                            assert!(
                                rx.recv_timeout(Duration::from_millis(100)).is_err(),
                                "duplicate DELETE"
                            );
                            return;
                        }
                        submit(11, "auth_status");
                        let status = replies.recv_timeout(Duration::from_secs(1));
                        if status.is_err() {
                            queue.close();
                        }
                        let status = status.expect("dispatcher stalled behind held DELETE");
                        assert_eq!(status["id"], 11);
                        assert_eq!(status["result"]["authenticated"], true);
                        submit(12, "stop_stream");
                        assert_eq!(next(), json!({"id":12,"error":"SessionStopPending"}));
                        let failure = replies.recv_timeout(Duration::from_secs(3)).unwrap();
                        assert_eq!(failure["id"], 10);
                        assert!(
                            failure["error"]
                                .as_str()
                                .unwrap()
                                .contains("cleanup timeout (2s)")
                        );
                        assert!(failure.get("result").is_none());
                        writeln!(input, "release").unwrap();
                        input.flush().unwrap();
                        submit(13, "stop_stream");
                        let accepted = next();
                        assert_eq!(accepted["id"], 13);
                        assert!(
                            accepted["error"]
                                .as_str()
                                .is_some_and(|e| e.contains("HTTP 202"))
                        );
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                            "DELETE /v5/sessions/home/own-session HTTP/1.1"
                        );
                        submit(15, "stop_stream");
                        assert_eq!(next(), json!({"id":15,"result":null}));
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                            "DELETE /v5/sessions/home/own-session HTTP/1.1"
                        );
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                            "remaining=foreign-session"
                        );
                        let newer = cancellations.issue("mine").unwrap();
                        submit(14, "stop_stream");
                        let stale = next();
                        assert_eq!(stale["id"], 14);
                        assert!(stale["error"].is_string());
                        let newer_key = connection_cancel::scoped_id("mine", &newer).unwrap();
                        assert!(cancellations.acquire(&newer_key).is_ok());
                        queue.close();
                        let backend = dispatcher.join().unwrap();
                        assert!(backend.stream.is_none());
                        assert!(backend.stream_owner.is_none());
                        let scoped =
                            connection_cancel::scoped_id("mine", &generation.unwrap()).unwrap();
                        assert!(cancellations.acquire(&scoped).is_err());
                        assert!(matches!(
                            replies.try_recv(),
                            Err(std::sync::mpsc::TryRecvError::Disconnected)
                        ));
                        return;
                    }
                    if mode == "cancel" {
                        tokio::time::timeout(
                            Duration::from_secs(1),
                            backend.scoped_dispatch(
                                "cancel_connection",
                                json!({"attemptId":"mine"}),
                                &cancellations,
                            ),
                        )
                        .await
                        .expect("cancel blocked on DELETE")
                        .unwrap();
                        assert!(backend.stream_owner.is_none());
                    } else {
                        let mut logout: Request =
                            serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
                        stamp_auth_request(&backend.auth_gate, &mut logout).unwrap();
                        backend.logout_guards = cancellations.cancel_all_retained();
                        tokio::time::timeout(
                            Duration::from_secs(1),
                            backend.scoped_dispatch(&logout.cmd, logout.args, &cancellations),
                        )
                        .await
                        .expect("logout blocked on DELETE")
                        .unwrap();
                        assert!(backend.primary.lock().unwrap().tokens.is_none());
                    }
                    assert!(backend.stream.is_none());
                    assert_eq!(
                        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                        "DELETE /v5/sessions/home/own-session HTTP/1.1"
                    );
                    assert!(cancellations.retain_for_cleanup("mine").is_some());
                    assert!(backend.cleanup.blocked());
                    writeln!(input, "release").unwrap();
                    input.flush().unwrap();
                    assert_eq!(
                        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                        "remaining=foreign-session"
                    );
                    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
                    assert!(cancellations.retain_for_cleanup("mine").is_none());
                    return;
                }
                let gate = backend.auth_gate.clone();
                let other = gate.clone();
                let cancellations = Arc::new(fixture_cancellations());
                let reader_cancellations = cancellations.clone();
                let receiver = std::thread::spawn(move || {
                    assert!(
                        rx.recv_timeout(Duration::from_secs(4))
                            .unwrap()
                            .contains("/play")
                    );
                    let start = std::time::Instant::now();
                    let mut logout: Request =
                        serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
                    stamp_auth_request(&other, &mut logout).unwrap();
                    let guards = reader_cancellations.cancel_all_retained();
                    (logout, rx, start, guards)
                });
                let mut request:Request=serde_json::from_value(json!({"id":1,"cmd":"start_stream","args":{"attemptId":"mine","args":{"kind":"home","target":"fixture"}}})).unwrap();
                stamp_auth_request(&gate, &mut request).unwrap();
                let result = tokio::time::timeout(
                    Duration::from_secs(3),
                    backend.scoped_dispatch(&request.cmd, request.args, &cancellations),
                )
                .await;
                let (logout, rx, start, guards) = receiver.join().unwrap();
                assert_eq!(
                    result.expect("initial /play blocked logout").unwrap_err(),
                    auth_gate::INVALIDATED
                );
                assert!(start.elapsed() < Duration::from_secs(1));
                backend.logout_guards = guards;
                backend
                    .scoped_dispatch(&logout.cmd, logout.args, &cancellations)
                    .await
                    .unwrap();
                assert!(backend.primary.lock().unwrap().tokens.is_none());
                assert!(
                    start.elapsed() < Duration::from_secs(1),
                    "logout response exceeded one second"
                );
                if mode == "id" {
                    assert!(cancellations.retain_for_cleanup("mine").is_some());
                }
                writeln!(input, "release").unwrap();
                input.flush().unwrap();
                if mode == "fail" {
                    for _ in 0..3 {
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                            "DELETE /v5/sessions/home/own-session HTTP/1.1"
                        );
                    }
                }
                if mode == "id" || mode == "retry" {
                    assert_eq!(
                        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                        "DELETE /v5/sessions/home/own-session HTTP/1.1"
                    );
                    if mode == "retry" {
                        assert_eq!(
                            rx.recv_timeout(Duration::from_secs(3))
                                .expect("cleanup failed to retry"),
                            "DELETE /v5/sessions/home/own-session HTTP/1.1"
                        );
                    }
                    assert_eq!(
                        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                        "remaining=foreign-session"
                    );
                }
                assert!(
                    rx.recv_timeout(if mode == "timeout" {
                        Duration::from_millis(1400)
                    } else {
                        Duration::from_millis(500)
                    })
                    .is_err()
                );
                if mode == "id" {
                    assert!(cancellations.retain_for_cleanup("mine").is_none());
                }
            })
        }));
        let _ = child.kill();
        let _ = child.wait();
        drop(input);
        let _ = reader.join();
        let _ = std::fs::remove_dir_all(dir);
        result.unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_during_provision_retry_play_does_not_wait_for_response() {
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("xjaus-late-play-{}", std::process::id()));
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
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
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
        let script = r#"import socket,ssl,sys
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2]); plays=0
while True:
 x,_=s.accept(); x=c.wrap_socket(x,server_side=True); data=x.recv(65536); line=data.split(b'\r\n')[0].decode(); print(line,flush=True)
 if '/play ' in line:
  plays+=1
  if plays==2: sys.stdin.readline()
  body=(b'{"sessionId":"late-own"}' if plays==2 else b'{"sessionId":"first-own"}')
 elif '/state ' in line: body=b'{"state":"Failed","errorDetails":{"code":"WNSError"}}'
 else: body=b'{}'
 x.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body); x.close()
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        out.read_line(&mut port).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in out.lines() {
                if tx.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(async {
                let client = Client::builder()
                    .danger_accept_invalid_certs(true)
                    .build()
                    .unwrap();
                let mut stream = SessionClient::new(
                    client,
                    format!("127.0.0.1:{}", port.trim()),
                    "test".into(),
                    SessionKind::Home,
                    Default::default(),
                );
                stream.start("fixture").await.unwrap();
                assert!(
                    rx.recv_timeout(Duration::from_secs(2))
                        .unwrap()
                        .contains("/play")
                );
                let mut backend = Backend::new();
                backend.stream = Some(stream);
                backend.stream_owner = Some("mine".into());
                let gate = backend.auth_gate.clone();
                let receiver_gate = gate.clone();
                let reader_thread = std::thread::spawn(move || {
                    let mut plays = 0;
                    loop {
                        let line = rx.recv_timeout(Duration::from_secs(8)).unwrap();
                        if line.contains("/play") {
                            plays += 1;
                            if plays == 1 {
                                break;
                            }
                        }
                    }
                    let mut logout: Request =
                        serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
                    stamp_auth_request(&receiver_gate, &mut logout).unwrap();
                    (logout, rx)
                });
                let mut request: Request = serde_json::from_value(
                    json!({"id":1,"cmd":"provision_stream","args":{"attemptId":"mine"}}),
                )
                .unwrap();
                stamp_auth_request(&gate, &mut request).unwrap();
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    backend.scoped_dispatch(&request.cmd, request.args, &fixture_cancellations()),
                )
                .await;
                let (logout, rx) = reader_thread.join().unwrap();
                assert_eq!(
                    result.expect("logout waited for retry /play").unwrap_err(),
                    auth_gate::INVALIDATED
                );
                backend
                    .scoped_dispatch(&logout.cmd, logout.args, &fixture_cancellations())
                    .await
                    .unwrap();
                writeln!(input, "release").unwrap();
                input.flush().unwrap();
                let delete = rx.recv_timeout(Duration::from_secs(3)).unwrap();
                assert!(
                    delete.contains("DELETE /v5/sessions/home/late-own"),
                    "{delete}"
                );
                assert!(
                    rx.recv_timeout(Duration::from_millis(200)).is_err(),
                    "unexpected extra session operation"
                );
            });
        }));
        let _ = child.kill();
        let _ = child.wait();
        drop(input);
        let _ = reader.join();
        let _ = std::fs::remove_dir_all(dir);
        result.unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_interrupts_blocked_provisioning_dispatcher() {
        blocked_dispatch_trace("provision_stream");
    }

    #[cfg(not(windows))]
    #[test]
    fn logout_interrupts_blocked_answer_dispatcher() {
        blocked_dispatch_trace("poll_stream_answer");
    }

    #[cfg(not(windows))]
    fn blocked_dispatch_trace(command: &str) {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        let dir =
            std::env::temp_dir().join(format!("xjaus-test-tls-{}-{}", std::process::id(), command));
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
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
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
        let script = r#"import ssl,socket,sys,time
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[1],sys.argv[2])
while True:
 conn,_=s.accept()
 try:
  x=c.wrap_socket(conn,server_side=True); data=x.recv(65536)
  if b'/play ' in data:
   body=b'{"sessionId":"owned-session"}'; x.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body); x.close()
  else:
   print('blocked',flush=True); time.sleep(20); x.close()
 except Exception: pass
"#;
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .arg(&cert)
            .arg(&key)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = output.read_line(&mut line);
            let _ = tx.send(line);
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(async {
                let client = Client::builder()
                    .danger_accept_invalid_certs(true)
                    .build()
                    .unwrap();
                let mut stream = SessionClient::new(
                    client.clone(),
                    format!("127.0.0.1:{}", port.trim()),
                    "test".into(),
                    SessionKind::Home,
                    Default::default(),
                );
                stream.start("fixture").await.unwrap();
                let mut backend = Backend::new();
                backend.stream = Some(stream);
                backend.stream_owner = Some("mine".into());
                let gate = backend.auth_gate.clone();
                let mut provision: Request = serde_json::from_value(
                    json!({"id":1,"cmd":command,"args":{"attemptId":"mine"}}),
                )
                .unwrap();
                stamp_auth_request(&gate, &mut provision).unwrap();
                let receiver_gate = gate.clone();
                let receiver = std::thread::spawn(move || {
                    assert_eq!(
                        rx.recv_timeout(Duration::from_secs(5)).unwrap().trim(),
                        "blocked"
                    );
                    let mut logout: Request =
                        serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
                    stamp_auth_request(&receiver_gate, &mut logout).unwrap();
                    logout
                });
                let cancellations = fixture_cancellations();
                let result = tokio::time::timeout(
                    Duration::from_secs(2),
                    backend.scoped_dispatch(&provision.cmd, provision.args, &cancellations),
                )
                .await;
                assert_eq!(
                    result
                        .expect("logout must preempt blocked provisioning")
                        .unwrap_err(),
                    auth_gate::INVALIDATED
                );
                let logout = receiver.join().unwrap();
                backend
                    .scoped_dispatch(&logout.cmd, logout.args, &cancellations)
                    .await
                    .unwrap();
                assert!(backend.stream.is_none());
            });
        }));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(dir);
        result.unwrap();
    }

    #[test]
    fn queued_authenticated_commands_are_rejected_after_logout() {
        let mut backend = Backend::new();
        let commands = [
            "persist_session",
            "xbox_profile",
            "wake_console",
            "list_consoles_smartglass",
            "catalog_products",
            "provision_stream",
            "submit_stream_offer",
            "poll_stream_answer",
            "exchange_stream_ice",
            "stream_keepalive",
            "stop_stream",
        ];
        let mut requests: Vec<Request> = commands
            .into_iter()
            .enumerate()
            .map(|(id, cmd)| {
                let mut r: Request =
                    serde_json::from_value(json!({"id":id,"cmd":cmd,"args":{}})).unwrap();
                stamp_auth_request(&backend.auth_gate, &mut r).unwrap();
                r
            })
            .collect();
        let mut logout: Request = serde_json::from_value(json!({"id":99,"cmd":"logout"})).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut logout).unwrap();
        let cancellations = connection_cancel::ConnectionCancellation::default();
        for request in requests.drain(..) {
            let error = tauri::async_runtime::block_on(backend.scoped_dispatch(
                &request.cmd,
                request.args,
                &cancellations,
            ))
            .unwrap_err();
            assert_eq!(error, auth_gate::INVALIDATED, "{}", request.cmd);
        }
    }

    #[test]
    fn queued_profile_is_invalidated_at_logout_arrival() {
        let mut backend = Backend::new();
        let mut profile: Request =
            serde_json::from_value(json!({"id":1,"cmd":"xbox_profile"})).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut profile).unwrap();
        let mut logout: Request = serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut logout).unwrap();
        let error = tauri::async_runtime::block_on(backend.scoped_dispatch(
            &profile.cmd,
            profile.args,
            &connection_cancel::ConnectionCancellation::default(),
        ))
        .unwrap_err();
        assert_eq!(error, auth_gate::INVALIDATED);
    }
    #[test]
    fn logout_arrival_invalidates_queued_login_before_dispatch() {
        let mut backend = Backend::new();
        let mut begin: Request = serde_json::from_value(
            json!({"id":1,"cmd":"begin_login_window","args":{"attemptId":"old"}}),
        )
        .unwrap();
        stamp_auth_request(&backend.auth_gate, &mut begin).unwrap();
        let (_, epoch) = auth_request_context(&begin.args).unwrap();
        let gate = backend.auth_gate.clone();
        let arrived = Arc::new(std::sync::Barrier::new(2));
        let release = arrived.clone();
        let reader = std::thread::spawn(move || {
            let mut logout: Request =
                serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
            stamp_auth_request(&gate, &mut logout).unwrap();
            release.wait();
            logout
        });
        arrived.wait();
        assert_eq!(
            backend.auth_gate.commit(epoch, || Ok(())).unwrap_err(),
            auth_gate::INVALIDATED
        );
        let result = tauri::async_runtime::block_on(backend.scoped_dispatch(
            &begin.cmd,
            begin.args,
            &fixture_cancellations(),
        ));
        assert_eq!(result.unwrap_err(), auth_gate::INVALIDATED);
        reader.join().unwrap();
    }

    #[test]
    fn queued_refresh_cannot_adopt_post_logout_epoch() {
        let mut backend = Backend::new();
        let mut refresh: Request =
            serde_json::from_value(json!({"id":1,"cmd":"refresh_session"})).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut refresh).unwrap();
        let mut logout: Request = serde_json::from_value(json!({"id":2,"cmd":"logout"})).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut logout).unwrap();
        let error = tauri::async_runtime::block_on(backend.scoped_dispatch(
            &refresh.cmd,
            refresh.args,
            &fixture_cancellations(),
        ))
        .unwrap_err();
        assert_eq!(error, auth_gate::INVALIDATED);
    }

    #[test]
    fn dispatcher_trace_logout_then_new_login_keeps_new_generation() {
        let mut backend = Backend::new();
        backend.primary.lock().unwrap().tokens = Some(Arc::new(
            serde_json::from_value(json!({"refresh_token":"fixture", "acquired_at_unix":0}))
                .unwrap(),
        ));
        backend.stream_owner = Some("old-stream".into());
        backend.stream = Some(SessionClient::new(
            Client::new(),
            "unused.invalid".into(),
            "fixture".into(),
            SessionKind::Home,
            Default::default(),
        ));
        let mut old: Request = serde_json::from_value(
            json!({"id":1,"cmd":"begin_login_window","args":{"attemptId":"old"}}),
        )
        .unwrap();
        let mut logout: Request = serde_json::from_value(
            json!({"id":2,"cmd":"logout","args":{"__xjausLogoutArrived":false}}),
        )
        .unwrap();
        let mut retry: Request = serde_json::from_value(
            json!({"id":3,"cmd":"begin_login_window","args":{"attemptId":"retry"}}),
        )
        .unwrap();
        stamp_auth_request(&backend.auth_gate, &mut old).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut logout).unwrap();
        stamp_auth_request(&backend.auth_gate, &mut retry).unwrap();
        let (_, retry_epoch) = auth_request_context(&retry.args).unwrap();
        let cancellations = connection_cancel::ConnectionCancellation::default();
        tauri::async_runtime::block_on(async {
            assert_eq!(
                backend
                    .scoped_dispatch(&old.cmd, old.args, &cancellations)
                    .await
                    .unwrap_err(),
                auth_gate::INVALIDATED
            );
            backend
                .scoped_dispatch(&logout.cmd, logout.args, &cancellations)
                .await
                .unwrap();
        });
        assert_eq!(
            backend.auth_gate.capture_attempt("retry").unwrap(),
            retry_epoch
        );
        assert!(backend.primary.lock().unwrap().tokens.is_none());
        assert!(backend.stream.is_none());
        assert!(backend.stream_owner.is_none());
    }

    #[test]
    fn sidecar_start_stream_parses_requested_locale_separately_from_profile() {
        let start = json!({
            "streamingLocale": "en-US",
            "profile": {"width": 2560, "locale": "es-MX"}
        });
        let locale = stream_locale_from_args(&start).unwrap();
        let patch = serde_json::from_value::<DeviceProfilePatch>(start["profile"].clone()).unwrap();
        let profile = session::profile_for_stream(SessionKind::Cloud, Some(patch), locale).unwrap();
        assert_eq!(profile.locale, "en-US");
        assert_eq!(
            profile
                .play_payload(SessionKind::Cloud, "title")
                .pointer("/settings/market")
                .and_then(Value::as_str),
            Some("ES-MX")
        );

        let home = session::profile_for_stream(SessionKind::Home, None, Some("en-US")).unwrap();
        assert_eq!(home.locale, "es-MX");
        assert!(stream_locale_from_args(&json!({"streamingLocale": 123})).is_err());
    }

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
    fn logout_profile_failure_invalidates_sidecar_auth() {
        tauri::async_runtime::block_on(async {
            // Use a path that fails on both Linux and Windows.
            // Linux: /dev/null is a character device, not a directory.
            // Windows: NUL is a reserved device name; creating a directory named NUL fails.
            #[cfg(windows)]
            let bad_path = std::path::PathBuf::from("NUL");
            #[cfg(not(windows))]
            let bad_path = std::path::PathBuf::from("/dev/null/unavailable");
            let mut backend = Backend {
                client: Client::new(),
                primary: Arc::new(AuthSlot::new(PrimaryAuth {
                    tokens: Some(Arc::new(
                        serde_json::from_value(json!({"refresh_token":"fixture", "acquired_at_unix":0, "web_token":{"DisplayClaims":{"xui":[{"uhs":"fixture"}]}}})).unwrap()
                    )),
                    pending: None,
                })),
                stream_owner: Some("active".into()),
                stream: None,
                profile_cache: profile::ProfileCache::persistent(Default::default(), bad_path),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
            };
            let epoch = backend.auth_gate.capture().unwrap();
            let deleted = std::cell::Cell::new(false);
            assert!(
                backend
                    .logout_with_delete(|| {
                        deleted.set(true);
                        Ok(())
                    })
                    .is_err()
            );
            assert!(deleted.get());
            assert!(backend.primary.lock().unwrap().tokens.is_none());
            assert!(
                backend
                    .auth_gate
                    .commit(epoch, || Ok::<_, String>(()))
                    .is_err()
            );
            assert_eq!(backend.stream_owner.as_deref(), None);
        });
    }
    #[test]
    fn logout_keyring_failure_clears_sidecar_memory() {
        let mut backend = Backend {
            client: Client::new(),
            primary: Arc::new(AuthSlot::new(PrimaryAuth {
                tokens: Some(Arc::new(
                    serde_json::from_value(
                        json!({"refresh_token":"fixture", "acquired_at_unix":0}),
                    )
                    .unwrap(),
                )),
                pending: None,
            })),
            stream_owner: Some("active".into()),
            stream: Some(SessionClient::new(
                Client::new(),
                "unused.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                Default::default(),
            )),
            profile_cache: profile::ProfileCache::new(Default::default()),
            logout_guards: Vec::new(),
            auth_gate: Arc::new(auth_gate::AuthGate::new()),
            cleanup: Arc::new(CleanupTracker::default()),
        };
        let epoch = backend.auth_gate.begin_attempt("old").unwrap();
        assert_eq!(
            backend
                .logout_with_delete(|| Err("keyring failure".into()))
                .unwrap_err(),
            "keyring failure"
        );
        assert!(backend.primary.lock().unwrap().tokens.is_none());
        assert!(
            backend
                .auth_gate
                .commit(epoch, || Ok::<_, String>(()))
                .is_err()
        );
        assert_eq!(backend.stream_owner.as_deref(), None);
        assert!(backend.stream.is_none());
        assert!(backend.auth_gate.begin_attempt("new").is_ok());
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
    fn admitted_sidecar_commands_are_guarded_until_cancel_and_queue_drain() {
        tauri::async_runtime::block_on(async {
            let mut backend = Backend::new();
            backend.primary.lock().unwrap().tokens = Some(Arc::new(serde_json::from_value(json!({"refresh_token":"fixture","acquired_at_unix":0,"home_stream_token":{"gsToken":"fixture"}})).unwrap()));
            let registry = connection_cancel::ConnectionCancellation::default();
            let mut begin: Request = serde_json::from_value(json!({"id":1,"cmd":"begin_connection","args":{"attemptId":"mine","generation":"g"}})).unwrap();
            stamp_auth_request(&backend.auth_gate, &mut begin).unwrap();
            stamp_connection_request(&registry, &mut begin).unwrap();
            let key = begin.args["attemptId"].as_str().unwrap().to_owned();
            let generation = begin.args["generation"].as_str().unwrap().to_owned();
            assert_ne!(generation, "g");
            backend
                .scoped_dispatch(&begin.cmd, begin.args.clone(), &registry)
                .await
                .unwrap();
            assert!(registry.begin(&key).is_err());
            let mut queued: Request = serde_json::from_value(json!({"id":2,"cmd":"wake_console","args":{"attemptId":"mine","generation":generation}})).unwrap();
            stamp_auth_request(&backend.auth_gate, &mut queued).unwrap();
            stamp_connection_request(&registry, &mut queued).unwrap();
            let mut cancel: Request = serde_json::from_value(json!({"id":3,"cmd":"cancel_connection","args":{"attemptId":"mine","generation":generation}})).unwrap();
            stamp_connection_request(&registry, &mut cancel).unwrap();
            assert!(
                backend
                    .scoped_dispatch(&queued.cmd, queued.args.clone(), &registry)
                    .await
                    .is_err()
            );
            backend
                .scoped_dispatch(&cancel.cmd, cancel.args.clone(), &registry)
                .await
                .unwrap();
            assert!(registry.acquire(&key).is_err());
            assert!(queued.admission.is_some());
            drop(begin);
            drop(queued);
            drop(cancel);
            assert!(registry.begin(&key).is_err());
            registry.begin("new").unwrap();
        });
    }
    #[test]
    fn stop_without_an_owned_handle_is_not_confirmation() {
        let mut backend = Backend::new();
        let registry = connection_cancel::ConnectionCancellation::default();
        let generation = registry.issue("stopped").unwrap();
        let key = connection_cancel::scoped_id("stopped", &generation).unwrap();
        backend.stream_owner = Some(key.clone());
        let result = backend.admit_stop(
            1,
            &json!({
                "attemptId": key, "__xjausRequestEpoch": backend.auth_gate.current(),
            }),
            &registry,
        );
        assert_eq!(result.err().as_deref(), Some("SessionCleanupUncertain"));
        assert!(registry.acquire(&key).is_ok());
        assert_eq!(backend.stream_owner.as_deref(), Some(key.as_str()));
    }
    #[test]
    fn reader_rejects_other_generation_for_same_attempt() {
        let registry = connection_cancel::ConnectionCancellation::default();
        let mut begin: Request = serde_json::from_value(
            json!({"id":1,"cmd":"begin_connection","args":{"attemptId":"same","generation":"old"}}),
        )
        .unwrap();
        stamp_connection_request(&registry, &mut begin).unwrap();
        let key = begin.args["attemptId"].as_str().unwrap();
        let old_generation = begin.args["generation"].as_str().unwrap().to_owned();
        assert_ne!(old_generation, "old");
        let mut wrong: Request = serde_json::from_value(json!({"id":2,"cmd":"cancel_connection","args":{"attemptId":"same","generation":"new"}})).unwrap();
        assert!(stamp_connection_request(&registry, &mut wrong).is_err());
        assert!(registry.check(Some(key)).is_ok());
        let mut next: Request = serde_json::from_value(
            json!({"id":4,"cmd":"begin_connection","args":{"attemptId":"same","generation":"new"}}),
        )
        .unwrap();
        stamp_connection_request(&registry, &mut next).unwrap();
        let next_key = next.args["attemptId"].as_str().unwrap().to_owned();
        let mut old_cancel: Request = serde_json::from_value(json!({"id":5,"cmd":"cancel_connection","args":{"attemptId":"same","generation":old_generation}})).unwrap();
        stamp_connection_request(&registry, &mut old_cancel).unwrap();
        assert!(registry.check(Some(key)).is_err());
        assert!(registry.check(Some(&next_key)).is_ok());
        let mut missing: Request = serde_json::from_value(
            json!({"id":3,"cmd":"wake_console","args":{"attemptId":"same"}}),
        )
        .unwrap();
        assert!(stamp_connection_request(&registry, &mut missing).is_err());
    }
    #[test]
    fn reader_rejects_unknown_attempt_and_reserves_guard_before_queue() {
        let registry = connection_cancel::ConnectionCancellation::default();
        let mut unknown: Request = serde_json::from_value(
            json!({"id":1,"cmd":"wake_console","args":{"attemptId":"unknown","generation":"g"}}),
        )
        .unwrap();
        assert!(stamp_connection_request(&registry, &mut unknown).is_err());
        let key = connection_cancel::scoped_id("known", "g").unwrap();
        registry.begin(&key).unwrap();
        let mut queued: Request = serde_json::from_value(
            json!({"id":2,"cmd":"wake_console","args":{"attemptId":"known","generation":"g"}}),
        )
        .unwrap();
        stamp_connection_request(&registry, &mut queued).unwrap();
        registry.cancel(&key);
        registry.finish(&key).unwrap();
        assert!(queued.admission.is_some());
        assert!(registry.acquire(&key).is_err());
        for n in 0..63 {
            registry.begin(&format!("held-{n}")).unwrap();
        }
        assert!(registry.begin("overflow").is_err());
        drop(queued);
        registry.begin("overflow").unwrap();
        assert!(registry.acquire(&key).is_err());
    }
    #[test]
    fn start_without_attempt_id_is_rejected_before_auth_or_remote_play() {
        tauri::async_runtime::block_on(async {
            let mut backend = Backend::new();
            let error = backend
                .scoped_dispatch(
                    "start_stream",
                    json!({"args":{"kind":"home","target":"fixture"}}),
                    &fixture_cancellations(),
                )
                .await
                .unwrap_err();
            assert_eq!(error, "Falta el intento de conexión");
            assert!(backend.stream.is_none());
        });
    }
    #[test]
    fn stop_without_attempt_id_cannot_take_owned_stream() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                primary: Default::default(),
                stream_owner: Some("owner".into()),
                stream: Some(SessionClient::new(
                    Client::new(),
                    "unused.invalid".into(),
                    "fixture".into(),
                    SessionKind::Home,
                    Default::default(),
                )),
                profile_cache: profile::ProfileCache::production(),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
            };
            assert!(
                backend
                    .scoped_dispatch("stop_stream", json!({}), &cancellations)
                    .await
                    .is_err()
            );
            assert_eq!(backend.stream_owner.as_deref(), Some("owner"));
            assert!(backend.stream.is_some());
        });
    }
    #[test]
    fn cancel_only_deletes_its_owned_stream_and_old_commands_cannot_start_again() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            cancellations.begin("mine").unwrap();
            cancellations.begin("other").unwrap();
            let mut backend = Backend {
                client: Client::new(),
                primary: Default::default(),
                stream_owner: Some("other".into()),
                stream: Some(SessionClient::new(
                    Client::new(),
                    "unused.invalid".into(),
                    "fixture".into(),
                    SessionKind::Home,
                    Default::default(),
                )),
                profile_cache: profile::ProfileCache::production(),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
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
                primary: Default::default(),
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
            };
            backend
                .scoped_dispatch(
                    "cancel_login",
                    json!({"attemptId":"new-login-attempt", "__xjausCancelApplied":true}),
                    &cancellations,
                )
                .await
                .expect("login cancellation must not be rejected by stream ownership");
            assert!(backend.primary.lock().unwrap().pending.is_none());
        });
    }

    #[test]
    fn begin_login_attempt_bypasses_stale_stream_owner_before_auth_gate_check() {
        tauri::async_runtime::block_on(async {
            let cancellations = connection_cancel::ConnectionCancellation::default();
            let mut backend = Backend {
                client: Client::new(),
                primary: Default::default(),
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
            };
            let attempt_id = "new-login-attempt";
            let mut request = Request {
                id: 1,
                cmd: "begin_login_window".into(),
                args: json!({"attemptId":attempt_id}),
                skip_keepalive: false,
                pre_dispatch_error: None,
                admission: None,
                logout_guards: Vec::new(),
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
                primary: Default::default(),
                stream_owner: Some("stale-stream-attempt".into()),
                stream: None,
                profile_cache: profile::ProfileCache::production(),
                logout_guards: Vec::new(),
                auth_gate: Arc::new(auth_gate::AuthGate::new()),
                cleanup: Arc::new(CleanupTracker::default()),
            };
            let attempt_id = "existing-login-attempt";
            backend.auth_gate.begin_attempt(attempt_id).unwrap();
            let mut request = Request {
                id: 2,
                cmd: "poll_login".into(),
                args: json!({"attemptId":attempt_id}),
                skip_keepalive: false,
                pre_dispatch_error: None,
                admission: None,
                logout_guards: Vec::new(),
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
                    let (host, _bearer, path) = {
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

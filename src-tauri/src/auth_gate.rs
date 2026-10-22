//! F3: puerta de autenticación con epoch monótono + gate de commit.
//!
//! La auditoría (auth-race) mostró que un refresh tardío podía reescribir
//! tokens y bóveda después de un logout, resucitando la sesión. Este módulo
//! centraliza la defensa:
//!
//! - `capture()` toma epoch + lock de commit antes de cualquier await.
//! - `commit(expected, persist)` revalida el epoch bajo el lock y sólo
//!   entonces ejecuta la persistencia; si hubo logout devuelve
//!   [`INVALIDATED`] **sin escribir** (descarte silencioso).
//! - `invalidate()` (llamado por logout con el lock tomado) incrementa el
//!   epoch y difunde el cambio por un watch: los refresh/login en vuelo se
//!   cancelan vía `tokio::select!` en lugar de terminar su red y competir.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use tokio::sync::watch;

pub const INVALIDATED: &str = "Authentication request invalidated by logout";
const STATE_ERROR: &str = "Authentication state is unavailable";
fn valid_attempt_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub struct AuthGate {
    epoch: AtomicU64,
    signal: watch::Sender<u64>,
    commit: Mutex<()>,
    active_attempt: Mutex<Option<String>>,
}

impl Default for AuthGate {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthGate {
    pub fn new() -> Self {
        let (signal, _) = watch::channel(0u64);
        Self {
            epoch: AtomicU64::new(0),
            signal,
            commit: Mutex::new(()),
            active_attempt: Mutex::new(None),
        }
    }
    /// Lock exclusivo del tramo síncrono de commit/logout.
    pub fn lock_commit(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.commit.lock().map_err(|_| STATE_ERROR.to_owned())
    }
    pub fn current(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    /// Captura el epoch actual bajo el lock de commit (antes de awaits).
    pub fn capture(&self) -> Result<u64, String> {
        let _guard = self.lock_commit()?;
        Ok(self.current())
    }
    /// Starts a new renderer-owned login attempt and returns its epoch. A new
    /// begin always supersedes all previously queued or in-flight auth work.
    pub fn begin_attempt(&self, attempt_id: &str) -> Result<u64, String> {
        self.begin_attempt_with(attempt_id, || Ok(()))
            .map(|(epoch, ())| epoch)
    }
    /// Atomically replaces the active attempt and its runner-owned pending data.
    pub fn begin_attempt_with<T>(
        &self,
        attempt_id: &str,
        replace: impl FnOnce() -> Result<T, String>,
    ) -> Result<(u64, T), String> {
        if !valid_attempt_id(attempt_id) {
            return Err("Invalid login attempt identifier".into());
        }
        let _guard = self.lock_commit()?;
        let epoch = self.invalidate();
        *self
            .active_attempt
            .lock()
            .map_err(|_| STATE_ERROR.to_owned())? = Some(attempt_id.to_owned());
        Ok((epoch, replace()?))
    }
    /// Captures an epoch only for the currently active attempt. The caller must
    /// stamp this value before queuing work behind a long-running request.
    pub fn capture_attempt(&self, attempt_id: &str) -> Result<u64, String> {
        self.with_attempt(attempt_id, Ok)
    }
    /// Runs a short synchronous state operation atomically with attempt check.
    pub fn with_attempt<T>(
        &self,
        attempt_id: &str,
        operation: impl FnOnce(u64) -> Result<T, String>,
    ) -> Result<T, String> {
        if !valid_attempt_id(attempt_id) {
            return Err("Invalid login attempt identifier".into());
        }
        let _guard = self.lock_commit()?;
        let active = self
            .active_attempt
            .lock()
            .map_err(|_| STATE_ERROR.to_owned())?;
        if active.as_deref() != Some(attempt_id) {
            return Err(INVALIDATED.to_owned());
        }
        operation(self.current())
    }
    /// Cancels only the matching attempt; a stale cancel cannot invalidate a
    /// newer login started while the old request was still queued.
    pub fn cancel_attempt(&self, attempt_id: &str) -> Result<bool, String> {
        self.cancel_attempt_with(attempt_id, || Ok(()))
    }
    /// Atomically invalidates a matching attempt and clears its pending state.
    pub fn cancel_attempt_with(
        &self,
        attempt_id: &str,
        clear_pending: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        if !valid_attempt_id(attempt_id) {
            return Err("Invalid login attempt identifier".into());
        }
        let _guard = self.lock_commit()?;
        let active = self
            .active_attempt
            .lock()
            .map_err(|_| STATE_ERROR.to_owned())?;
        if active.as_deref() != Some(attempt_id) {
            return Ok(false);
        }
        drop(active);
        self.invalidate();
        clear_pending()?;
        Ok(true)
    }
    /// Suscripción para cancelar trabajo en vuelo (CancellationToken por watch).
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.signal.subscribe()
    }
    /// Resuelve cuando el epoch deja de ser `expected` (logout invalió el flujo).
    pub async fn invalidated(&self, rx: &mut watch::Receiver<u64>, expected: u64) {
        while *rx.borrow() == expected {
            if rx.changed().await.is_err() {
                // El emisor desapareció (apagado): tratar como invalidado para
                // que ningún commit sobreviva al apagado del runner.
                return;
            }
        }
    }
    /// Publica un login pendiente sólo si sigue perteneciendo al epoch actual.
    pub fn publish_pending<T>(
        &self,
        expected: u64,
        publish: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.commit(expected, publish)
    }
    /// Logout: incrementa el epoch y difunde la cancelación.
    /// El caller debe mantener `lock_commit()` durante todo su tramo síncrono
    /// para que ningún commit se intercale entre el check y la escritura.
    pub fn invalidate(&self) -> u64 {
        let next = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.signal.send_replace(next);
        if let Ok(mut active) = self.active_attempt.lock() {
            *active = None;
        }
        next
    }
    /// Commit bajo gate: revalida el epoch bajo el lock y sólo entonces
    /// ejecuta `persist` (que debe escribir bóveda y tokens juntos).
    pub fn commit<T>(
        &self,
        expected: u64,
        persist: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self.lock_commit()?;
        if self.current() != expected {
            // Descarte silencioso: sin escribir bóveda ni tokens.
            return Err(INVALIDATED.to_owned());
        }
        persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn commit_with_unchanged_epoch_persists_and_returns_payload() {
        let gate = AuthGate::new();
        let expected = gate.capture().unwrap();
        let stored = gate.commit(expected, || Ok::<_, String>("bundle")).unwrap();
        assert_eq!(stored, "bundle");
    }

    #[test]
    fn late_refresh_after_logout_cannot_persist() {
        // Reproducción del hallazgo F3: el refresh parte, logout completa y el
        // refresh termina después; el commit debe descartarse sin escribir.
        let gate = AuthGate::new();
        let expected = gate.capture().unwrap();
        // El refresh sigue en vuelo (aún no se completa su await)...
        // ...y el logout corre completo bajo el gate:
        {
            let _commit = gate.lock_commit().unwrap();
            gate.invalidate();
        }
        let persisted = AtomicBool::new(false);
        let result = gate.commit(expected, || {
            persisted.store(true, Ordering::SeqCst);
            Ok::<_, String>(())
        });
        assert_eq!(result.unwrap_err(), INVALIDATED);
        assert!(
            !persisted.load(Ordering::SeqCst),
            "late refresh must not write vault or tokens after logout"
        );
    }

    #[test]
    fn logout_bumps_epoch_and_cancel_in_flight_watcher_wakes() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let gate = std::sync::Arc::new(AuthGate::new());
            let expected = gate.capture().unwrap();
            // Refresh en vuelo: select entre la red (nunca lista aquí) y la invalidación.
            let logout_gate = gate.clone();
            let waiter = tokio::spawn(async move {
                let mut rx = logout_gate.subscribe();
                logout_gate.invalidated(&mut rx, expected).await;
            });
            tokio::time::timeout(std::time::Duration::from_millis(50), async {
                tokio::task::yield_now().await;
            })
            .await
            .unwrap();
            assert!(!waiter.is_finished(), "not yet invalidated");
            {
                let _commit = gate.lock_commit().unwrap();
                let bumped = gate.invalidate();
                assert_eq!(bumped, expected + 1);
            }
            tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("in-flight refresh cancellation must wake")
                .unwrap();
        });
    }

    #[test]
    fn commit_cannot_interleave_between_check_and_write_during_logout() {
        // El lock de commit serializa: si logout está esperando el lock, el
        // commit con epoch vigente escribe primero y logout limpia después
        // (los tokens terminan ausentes); si logout va primero, el commit es
        // rechazado. Nunca queda la sesión resucitada tras logout.
        let gate = AuthGate::new();
        let expected = gate.capture().unwrap();
        // Orden A: commit (epoch vigente) → logout.
        let write_marker = AtomicBool::new(false);
        gate.commit(expected, || {
            write_marker.store(true, Ordering::SeqCst);
            Ok::<_, String>(())
        })
        .unwrap();
        {
            let _commit = gate.lock_commit().unwrap();
            gate.invalidate();
        }
        // Orden B: un segundo commit con el epoch viejo ya no puede escribir.
        let second: Result<(), String> = gate.commit(expected, || {
            panic!("second late commit must never run");
        });
        assert_eq!(second.unwrap_err(), INVALIDATED);
        assert!(write_marker.load(Ordering::SeqCst));
    }

    #[test]
    fn late_login_poll_does_not_restore_pending_after_logout() {
        let gate = AuthGate::new();
        let epoch = gate.capture().unwrap();
        let pending = std::sync::Mutex::new(None::<&str>);
        {
            let _guard = gate.lock_commit().unwrap();
            gate.invalidate();
        }
        assert_eq!(
            gate.publish_pending(epoch, || {
                *pending.lock().unwrap() = Some("old-login");
                Ok(())
            })
            .unwrap_err(),
            INVALIDATED
        );
        assert_eq!(*pending.lock().unwrap(), None);
    }

    #[test]
    fn queued_old_attempt_cannot_commit_or_publish_after_cancel_and_retry() {
        let gate = AuthGate::new();
        let old_epoch = gate.begin_attempt("attempt-old").unwrap();
        let queued_poll_epoch = gate.capture_attempt("attempt-old").unwrap();
        assert_eq!(queued_poll_epoch, old_epoch);
        assert!(gate.cancel_attempt("attempt-old").unwrap());
        let new_epoch = gate.begin_attempt("attempt-new").unwrap();
        assert_ne!(new_epoch, old_epoch);

        let persisted = AtomicBool::new(false);
        assert_eq!(
            gate.commit(queued_poll_epoch, || {
                persisted.store(true, Ordering::SeqCst);
                Ok::<_, String>(())
            })
            .unwrap_err(),
            INVALIDATED,
        );
        assert!(!persisted.load(Ordering::SeqCst));

        let published = AtomicBool::new(false);
        assert_eq!(
            gate.publish_pending(old_epoch, || {
                published.store(true, Ordering::SeqCst);
                Ok::<_, String>(())
            })
            .unwrap_err(),
            INVALIDATED,
        );
        assert!(!published.load(Ordering::SeqCst));
        assert!(gate.capture_attempt("attempt-old").is_err());
        assert_eq!(gate.capture_attempt("attempt-new").unwrap(), new_epoch);
    }

    #[test]
    fn stale_cancel_does_not_invalidate_a_newer_login_attempt() {
        let gate = AuthGate::new();
        let epoch = gate.begin_attempt("attempt-new").unwrap();
        assert!(!gate.cancel_attempt("attempt-old").unwrap());
        assert_eq!(gate.capture_attempt("attempt-new").unwrap(), epoch);
    }

    #[test]
    fn poisoned_commit_lock_reports_state_error() {
        let gate = AuthGate::new();
        let clone_gate = std::sync::Arc::new(gate);
        let panic_gate = clone_gate.clone();
        let handle = std::thread::spawn(move || {
            let _guard = panic_gate.lock_commit().unwrap();
            panic!("poison the commit mutex for the test");
        });
        let _ = handle.join();
        assert!(clone_gate.lock_commit().is_err());
        assert!(clone_gate.capture().is_err());
        let result = clone_gate.commit(0, || Ok::<_, String>(()));
        assert_eq!(result.unwrap_err(), STATE_ERROR);
    }
}

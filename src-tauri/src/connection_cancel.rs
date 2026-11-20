//! Attempt-scoped cancellation. Cancelling an unknown/old id never cancels another attempt.
use std::future::Future;

/// Injective, bounded encoding; never trust a renderer-provided precomposed key.
pub fn scoped_id(id: &str, generation: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Missing or invalid connection attempt identifier".into());
    }
    if generation.is_empty() || generation.len() > 48 {
        return Err("Missing or invalid connection generation".into());
    }
    Ok(format!("{}:{}{}", id.len(), id, generation))
}

#[derive(Clone)]
pub struct ConnectionCancellation {
    registry: bounded_registry::Registry,
    issuer: std::sync::Arc<GenerationIssuer>,
}
struct GenerationIssuer {
    nonce: Option<[u8; 16]>,
    counter: std::sync::atomic::AtomicU64,
}
impl Default for ConnectionCancellation {
    fn default() -> Self {
        let mut nonce = [0u8; 16];
        let nonce = getrandom::getrandom(&mut nonce).ok().map(|_| nonce);
        Self {
            registry: bounded_registry::Registry::new(64),
            issuer: std::sync::Arc::new(GenerationIssuer {
                nonce,
                counter: std::sync::atomic::AtomicU64::new(0),
            }),
        }
    }
}
impl ConnectionCancellation {
    sidecar_only! {
        #[cfg(test)]
        pub(crate) fn with_test_clock(
            capacity: usize,
            ttl: std::time::Duration,
            clock: std::sync::Arc<dyn Fn() -> std::time::Instant + Send + Sync>,
        ) -> Self {
            let mut fixture = Self::fixture_with_nonce([7; 16]);
            fixture.registry = bounded_registry::Registry::with_clock(capacity, ttl, clock);
            fixture
        }
    }
    #[cfg(test)]
    fn fixture_with_nonce(nonce: [u8; 16]) -> Self {
        Self {
            registry: bounded_registry::Registry::new(64),
            issuer: std::sync::Arc::new(GenerationIssuer {
                nonce: Some(nonce),
                counter: std::sync::atomic::AtomicU64::new(0),
            }),
        }
    }
    tauri_or_test! {
        pub fn issue(&self, id: &str) -> Result<String, String> {
            let (generation, key) = self.next_generation(id)?;
            self.registry
                .begin_leased(&key, false)
                .map_err(|e| format!("Connection admission: {e:?}"))?;
            Ok(generation)
        }
    }
    sidecar_only! {
        pub(crate) fn issue_queued(
            &self,
            id: &str,
        ) -> Result<(String, bounded_registry::Guard), String> {
            let (generation, key) = self.next_generation(id)?;
            let guard = self
                .registry
                .begin_leased(&key, true)
                .map_err(|e| format!("Connection admission: {e:?}"))?
                .expect("queued issuance reserves a guard");
            Ok((generation, guard))
        }
    }
    fn next_generation(&self, id: &str) -> Result<(String, String), String> {
        let nonce = self
            .issuer
            .nonce
            .ok_or("Connection generation entropy unavailable")?;
        let counter = self
            .issuer
            .counter
            .fetch_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |n| n.checked_add(1),
            )
            .map_err(|_| "Connection generation exhausted")?;
        let generation = format!("{}{:016x}", hex::encode(nonce), counter);
        let key = scoped_id(id, &generation)?;
        Ok((generation, key))
    }
    sidecar_or_test! {
        pub fn begin(&self, id: &str) -> Result<(), String> {
            self.registry
                .begin(id)
                .map_err(|e| format!("Connection admission: {e:?}"))
        }
    }
    pub fn acquire(&self, id: &str) -> Result<bounded_registry::Guard, String> {
        self.registry
            .acquire(id)
            .map_err(|e| format!("Connection admission: {e:?}"))
    }
    pub fn finish(&self, id: &str) -> Result<(), String> {
        self.registry
            .finish(id)
            .map_err(|e| format!("Connection admission: {e:?}"))
    }
    pub(crate) fn retain_for_cleanup(&self, id: &str) -> Option<bounded_registry::Guard> {
        self.registry.retain_for_cleanup(id).ok()
    }
    sidecar_only! {
        pub(crate) fn cancel_all_retained(&self) -> Vec<bounded_registry::Guard> {
            self.registry.cancel_all_retained()
        }
    }
    tauri_only! {
        pub fn cancel_all(&self) {
            self.registry.cancel_all();
        }
    }
    pub fn cancel(&self, id: &str) {
        let _ = self.registry.cancel(id);
    }
    pub async fn run<T>(
        &self,
        id: Option<&str>,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let Some(id) = id else {
            return future.await;
        };
        let mut guard = self.acquire(id)?;
        tokio::select! {
            biased;
            _ = guard.cancelled() => Err("ConnectionCancelled".into()),
            result = future => result,
        }
    }
    pub fn check(&self, id: Option<&str>) -> Result<(), String> {
        match id {
            None => Ok(()),
            Some(id) => self
                .acquire(id)
                .map(|_| ())
                .map_err(|_| "ConnectionCancelled".into()),
        }
    }
    sidecar_or_test! {
        pub async fn cancelled(&self, id: Option<&str>) {
            let Some(id) = id else {
                std::future::pending::<()>().await;
                return;
            };
            if let Ok(mut guard) = self.acquire(id) {
                guard.cancelled().await;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backend_issues_non_repeating_generations_across_instances_and_rejects_replay() {
        let a = ConnectionCancellation::fixture_with_nonce([1; 16]);
        let b = ConnectionCancellation::fixture_with_nonce([2; 16]);
        let first = a.issue("same").unwrap();
        let first_key = scoped_id("same", &first).unwrap();
        a.finish(&first_key).unwrap();
        let next = a.issue("same").unwrap();
        let restarted = b.issue("same").unwrap();
        assert_ne!(first, next);
        assert_ne!(first, restarted);
        assert!(a.acquire(&first_key).is_err());
        assert!(a.acquire(&scoped_id("same", &next).unwrap()).is_ok());
    }
    #[test]
    fn issuance_fails_closed_on_missing_entropy_or_counter_exhaustion() {
        let no_entropy = ConnectionCancellation {
            registry: bounded_registry::Registry::new(1),
            issuer: std::sync::Arc::new(GenerationIssuer {
                nonce: None,
                counter: std::sync::atomic::AtomicU64::new(0),
            }),
        };
        assert!(no_entropy.issue("id").is_err());
        let exhausted = ConnectionCancellation::fixture_with_nonce([3; 16]);
        exhausted
            .issuer
            .counter
            .store(u64::MAX, std::sync::atomic::Ordering::Relaxed);
        assert!(exhausted.issue("id").is_err());
    }
    #[test]
    fn expired_generation_cannot_adopt_new_admission() {
        use std::{
            sync::{Arc, Mutex},
            time::{Duration, Instant},
        };
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock = now.clone();
        let mut cancellation = ConnectionCancellation::fixture_with_nonce([7; 16]);
        cancellation.registry = bounded_registry::Registry::with_clock(
            1,
            Duration::from_secs(5),
            Arc::new(move || *clock.lock().unwrap()),
        );
        let old = cancellation.issue("same").unwrap();
        let old_key = scoped_id("same", &old).unwrap();
        assert_eq!(
            cancellation.issue("other").unwrap_err(),
            "Connection admission: Full"
        );
        *now.lock().unwrap() += Duration::from_secs(5);
        assert_eq!(
            cancellation.acquire(&old_key).err().as_deref(),
            Some("Connection admission: Unknown")
        );
        let new = cancellation.issue("same").unwrap();
        assert_ne!(new, old);
        cancellation.cancel(&old_key);
        assert!(cancellation.finish(&old_key).is_err());
        assert!(cancellation.acquire(&old_key).is_err());
        assert!(
            cancellation
                .acquire(&scoped_id("same", &new).unwrap())
                .is_ok()
        );
    }
    #[test]
    fn admission_lease_preserves_claimed_work_and_idle_owner() {
        use std::{
            sync::{Arc, Mutex},
            time::{Duration, Instant},
        };
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock = now.clone();
        let mut cancellation = ConnectionCancellation::fixture_with_nonce([8; 16]);
        cancellation.registry = bounded_registry::Registry::with_clock(
            1,
            Duration::from_secs(5),
            Arc::new(move || *clock.lock().unwrap()),
        );
        let generation = cancellation.issue("mine").unwrap();
        let key = scoped_id("mine", &generation).unwrap();
        let guard = cancellation.acquire(&key).unwrap();
        *now.lock().unwrap() += Duration::from_secs(100);
        assert_eq!(
            cancellation.issue("other").unwrap_err(),
            "Connection admission: Full"
        );
        assert!(guard.check().is_ok());
        drop(guard);
        assert_eq!(
            cancellation.issue("other").unwrap_err(),
            "Connection admission: Full"
        );
        assert!(cancellation.acquire(&key).is_ok());
        cancellation.finish(&key).unwrap();
        assert!(cancellation.issue("other").is_ok());
    }
    #[test]
    fn generation_scopes_same_attempt_without_collisions() {
        let one = super::scoped_id("same", "generation-1").unwrap();
        let two = super::scoped_id("same", "generation-2").unwrap();
        assert_ne!(one, two);
        assert_ne!(
            super::scoped_id("a", "bc").unwrap(),
            super::scoped_id("ab", "c").unwrap()
        );
        assert!(super::scoped_id("", "g").is_err());
        assert!(super::scoped_id("a", "").is_err());
        let r = ConnectionCancellation::default();
        r.begin(&one).unwrap();
        r.begin(&two).unwrap();
        let second = r.acquire(&two).unwrap();
        r.cancel(&one);
        r.finish(&one).unwrap();
        assert!(second.check().is_ok());
    }
    #[test]
    fn aborts_pending_work_without_polling_a_late_completion() {
        let registry = std::sync::Arc::new(ConnectionCancellation::default());
        registry.begin("mine").unwrap();
        registry.begin("another-session").unwrap();
        let other = registry.clone();
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Pending(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl std::future::Future for Pending {
            type Output = Result<(), String>;
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Self::Output> {
                std::task::Poll::Pending
            }
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let task = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            other.cancel("mine");
        });
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(registry.run(Some("mine"), Pending(dropped.clone())));
        task.join().unwrap();
        assert_eq!(result.unwrap_err(), "ConnectionCancelled");
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert!(registry.check(Some("another-session")).is_ok());
    }
    #[test]
    fn cancellation_is_immediate_scoped_and_remembered_for_late_work() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let registry = ConnectionCancellation::default();
                registry.begin("other").unwrap();
                registry.begin("mine").unwrap();
                let _other = registry.acquire("other").unwrap();
                registry.cancel("mine");
                assert!(registry.check(Some("mine")).is_err());
                assert!(registry.check(Some("other")).is_ok());
                tokio::time::timeout(
                    std::time::Duration::from_millis(20),
                    registry.cancelled(Some("mine")),
                )
                .await
                .unwrap();
                registry.cancel("mine");
                assert!(registry.check(Some("other")).is_ok());
            });
    }
}

#[cfg(test)]
mod bounded_registry_tests {
    use super::bounded_registry::{Error, Registry};
    #[test]
    fn expiry_begins_only_after_last_guard_drains() {
        use std::{
            sync::{Arc, Mutex},
            time::{Duration, Instant},
        };
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock = now.clone();
        let r = Registry::with_clock(
            1,
            Duration::from_secs(5),
            Arc::new(move || *clock.lock().unwrap()),
        );
        r.begin("old").unwrap();
        let guard = r.acquire("old").unwrap();
        r.finish("old").unwrap();
        *now.lock().unwrap() += Duration::from_secs(100);
        assert_eq!(r.begin("other"), Err(Error::Full));
        assert_eq!(r.begin("old"), Err(Error::Duplicate));
        drop(guard);
        *now.lock().unwrap() += Duration::from_secs(4);
        assert_eq!(r.begin("old"), Err(Error::Duplicate));
        *now.lock().unwrap() += Duration::from_secs(2);
        assert_eq!(r.begin("old"), Ok(()));
    }
    #[test]
    fn sustained_distinct_attempts_do_not_exhaust_history() {
        let registry = Registry::new(1);
        for n in 0..4097 {
            let id = format!("attempt-{n}");
            assert_eq!(registry.begin(&id), Ok(()), "admission {n}");
            registry.finish(&id).unwrap();
        }
    }
    #[test]
    fn unknown_ids_fail_closed_without_consuming_capacity() {
        let registry = Registry::new(1);
        assert!(matches!(registry.acquire("missing"), Err(Error::Unknown)));
        assert_eq!(registry.cancel("missing"), Err(Error::Unknown));
        assert_eq!(registry.finish("missing"), Err(Error::Unknown));
        assert_eq!(registry.begin("valid"), Ok(()));
    }
}

#[cfg(test)]
mod bounded_lifecycle_tests {
    use super::bounded_registry::{Error, Registry};
    #[test]
    fn capacity_never_evicts_and_finish_waits_for_inflight() {
        let r = Registry::new(1);
        assert_eq!(r.begin("a"), Ok(()));
        assert_eq!(r.begin("a"), Err(Error::Duplicate));
        let guard = r.acquire("a").unwrap();
        assert_eq!(r.begin("b"), Err(Error::Full));
        assert_eq!(r.finish("a"), Ok(()));
        assert!(matches!(r.acquire("a"), Err(Error::Finishing)));
        assert_eq!(r.begin("b"), Err(Error::Full));
        assert_eq!(guard.check(), Ok(()));
        drop(guard);
        assert_eq!(r.begin("b"), Ok(()));
        assert!(matches!(r.acquire("a"), Err(Error::Unknown)));
    }
    #[test]
    fn cancellation_reaches_all_guards_and_prevents_new_work() {
        let r = Registry::new(2);
        r.begin("a").unwrap();
        r.begin("b").unwrap();
        let a = r.acquire("a").unwrap();
        let b = r.acquire("b").unwrap();
        assert_eq!(r.cancel("a"), Ok(()));
        assert_eq!(r.cancel("a"), Ok(()));
        assert_eq!(a.check(), Err(Error::Cancelled));
        assert_eq!(b.check(), Ok(()));
        assert!(matches!(r.acquire("a"), Err(Error::Cancelled)));
        r.finish("a").unwrap();
        drop(a);
        assert!(matches!(r.acquire("a"), Err(Error::Unknown)));
    }
    #[test]
    fn async_waiter_wakes_on_cancel_and_late_waiter_is_ready() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let r = Registry::new(1);
            r.begin("a").unwrap();
            let mut guard = r.acquire("a").unwrap();
            let clone = r.clone();
            let task = std::thread::spawn(move || {
                clone.cancel("a").unwrap();
            });
            tokio::time::timeout(std::time::Duration::from_secs(1), guard.cancelled())
                .await
                .unwrap();
            task.join().unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(1), guard.cancelled())
                .await
                .unwrap();
        });
    }
    #[test]
    fn multiple_guards_retain_slot_until_last_drop() {
        let r = Registry::new(1);
        r.begin("a").unwrap();
        let first = r.acquire("a").unwrap();
        let second = r.acquire("a").unwrap();
        r.finish("a").unwrap();
        drop(first);
        assert_eq!(r.begin("b"), Err(Error::Full));
        r.cancel("a").unwrap();
        assert_eq!(second.check(), Err(Error::Cancelled));
        drop(second);
        assert_eq!(r.begin("b"), Ok(()));
    }
    #[test]
    fn finished_id_cannot_be_readmitted() {
        let r = Registry::new(2);
        r.begin("old").unwrap();
        r.finish("old").unwrap();
        assert_eq!(r.begin("old"), Err(Error::Duplicate));
        assert!(matches!(r.acquire("old"), Err(Error::Unknown)));
    }
    #[test]
    fn logout_cleanup_lease_keeps_capacity_while_delete_is_pending() {
        let r = Registry::new(1);
        r.begin("active").unwrap();
        let leases = r.cancel_all_retained();
        assert_eq!(r.begin("new"), Err(Error::Full));
        assert!(r.acquire("active").is_err());
        drop(leases);
        assert_eq!(r.begin("new"), Ok(()));
    }
    #[test]
    fn cleanup_can_retain_an_already_finishing_owner_without_reopening_admission() {
        let r = Registry::new(1);
        r.begin("a").unwrap();
        let first = r.acquire("a").unwrap();
        r.cancel("a").unwrap();
        r.finish("a").unwrap();
        let cleanup = r.retain_for_cleanup("a").unwrap();
        drop(first);
        assert_eq!(r.begin("b"), Err(Error::Full));
        assert!(r.acquire("a").is_err());
        drop(cleanup);
        assert_eq!(r.begin("b"), Ok(()));
    }
    #[test]
    fn logout_cancels_all_and_holds_slots_until_workers_drop() {
        let r = Registry::new(2);
        r.begin("a").unwrap();
        r.begin("b").unwrap();
        let a = r.acquire("a").unwrap();
        let b = r.acquire("b").unwrap();
        r.cancel_all();
        assert_eq!(a.check(), Err(Error::Cancelled));
        assert_eq!(b.check(), Err(Error::Cancelled));
        assert!(matches!(r.acquire("a"), Err(Error::Finishing)));
        assert_eq!(r.begin("c"), Err(Error::Full));
        drop(a);
        assert_eq!(r.begin("c"), Ok(()));
        assert_eq!(r.begin("d"), Err(Error::Full));
        drop(b);
        assert_eq!(r.begin("d"), Ok(()));
    }
    #[test]
    fn zero_capacity_rejects_admission() {
        assert_eq!(Registry::new(0).begin("x"), Err(Error::Full));
    }
}

/// Parallel opt-in registry. The legacy API above intentionally remains unchanged.
/// An admitted ID occupies a slot until finished and its last guard is dropped.
#[allow(dead_code)]
pub mod bounded_registry {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tokio::sync::watch;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Error {
        Unknown,
        Duplicate,
        Full,
        Cancelled,
        Finishing,
    }

    struct Entry {
        signal: watch::Sender<bool>,
        in_flight: usize,
        finishing: bool,
        unclaimed_until: Option<Instant>,
    }
    struct Inner {
        capacity: usize,
        entries: Mutex<HashMap<String, Entry>>,
        seen: Mutex<HashMap<String, Option<Instant>>>,
        ttl: Duration,
        clock: Arc<dyn Fn() -> Instant + Send + Sync>,
    }
    impl Inner {
        fn retire(&self, id: &str) {
            let deadline = (self.clock)().checked_add(self.ttl);
            if let Some(entry) = self.seen.lock().unwrap().get_mut(id) {
                *entry = deadline;
            }
        }
    }
    #[derive(Clone)]
    pub struct Registry {
        inner: Arc<Inner>,
    }
    pub struct Guard {
        inner: Arc<Inner>,
        id: String,
        signal: watch::Receiver<bool>,
    }
    impl Registry {
        pub fn new(capacity: usize) -> Self {
            Self::with_clock(capacity, Duration::from_secs(120), Arc::new(Instant::now))
        }
        pub(crate) fn with_clock(
            capacity: usize,
            ttl: Duration,
            clock: Arc<dyn Fn() -> Instant + Send + Sync>,
        ) -> Self {
            Self {
                inner: Arc::new(Inner {
                    capacity,
                    entries: Mutex::new(HashMap::new()),
                    seen: Mutex::new(HashMap::new()),
                    ttl,
                    clock,
                }),
            }
        }
        pub fn begin(&self, id: &str) -> Result<(), Error> {
            self.insert(id, false, false).map(|_| ())
        }
        pub(super) fn begin_leased(&self, id: &str, queued: bool) -> Result<Option<Guard>, Error> {
            self.insert(id, true, queued)
        }
        fn insert(&self, id: &str, leased: bool, queued: bool) -> Result<Option<Guard>, Error> {
            // Retain active IDs indefinitely and finished IDs until their TTL expires.
            // Fail closed rather than evicting an unexpired tombstone.
            let mut seen = self.inner.seen.lock().unwrap();
            let now = (self.inner.clock)();
            seen.retain(|_, deadline| deadline.is_none_or(|deadline| deadline > now));
            let mut entries = self.inner.entries.lock().unwrap();
            entries.retain(|id, entry| {
                if entry.in_flight == 0 && entry.unclaimed_until.is_some_and(|until| until <= now) {
                    // Keep the replay tombstone, just as for explicit retirement.
                    seen.insert(id.clone(), now.checked_add(self.inner.ttl));
                    false
                } else {
                    true
                }
            });
            if seen.contains_key(id) {
                return Err(Error::Duplicate);
            }
            if id.is_empty() || id.len() > 128 || seen.len() >= 65536 {
                return Err(Error::Full);
            }
            if entries.len() >= self.inner.capacity {
                return Err(Error::Full);
            }
            let unclaimed_until = if leased {
                Some(now.checked_add(self.inner.ttl).ok_or(Error::Full)?)
            } else {
                None
            };
            let (signal, receiver) = watch::channel(false);
            seen.insert(id.to_owned(), None);
            entries.insert(
                id.to_owned(),
                Entry {
                    signal,
                    in_flight: usize::from(queued),
                    finishing: false,
                    unclaimed_until,
                },
            );
            Ok(queued.then(|| Guard {
                inner: self.inner.clone(),
                id: id.to_owned(),
                signal: receiver,
            }))
        }
        pub fn acquire(&self, id: &str) -> Result<Guard, Error> {
            let mut entries = self.inner.entries.lock().unwrap();
            let entry = entries.get_mut(id).ok_or(Error::Unknown)?;
            if entry
                .unclaimed_until
                .is_some_and(|until| until <= (self.inner.clock)())
            {
                return Err(Error::Unknown);
            }
            if entry.finishing {
                return Err(Error::Finishing);
            }
            if *entry.signal.borrow() {
                return Err(Error::Cancelled);
            }
            // Claim with the first work guard. Even an idle claimed owner has
            // to retire explicitly; the lease is not a session timeout.
            entry.unclaimed_until = None;
            entry.in_flight += 1;
            Ok(Guard {
                inner: self.inner.clone(),
                id: id.to_owned(),
                signal: entry.signal.subscribe(),
            })
        }
        pub(crate) fn retain_for_cleanup(&self, id: &str) -> Result<Guard, Error> {
            let mut entries = self.inner.entries.lock().unwrap();
            let entry = entries.get_mut(id).ok_or(Error::Unknown)?;
            entry.in_flight += 1;
            Ok(Guard {
                inner: self.inner.clone(),
                id: id.to_owned(),
                signal: entry.signal.subscribe(),
            })
        }
        pub fn cancel(&self, id: &str) -> Result<(), Error> {
            let entries = self.inner.entries.lock().unwrap();
            let entry = entries.get(id).ok_or(Error::Unknown)?;
            entry.signal.send_replace(true);
            Ok(())
        }
        pub(crate) fn cancel_all_retained(&self) -> Vec<Guard> {
            let mut entries = self.inner.entries.lock().unwrap();
            entries
                .iter_mut()
                .map(|(id, entry)| {
                    entry.finishing = true;
                    entry.signal.send_replace(true);
                    entry.in_flight += 1;
                    Guard {
                        inner: self.inner.clone(),
                        id: id.clone(),
                        signal: entry.signal.subscribe(),
                    }
                })
                .collect()
        }
        pub fn cancel_all(&self) {
            let mut entries = self.inner.entries.lock().unwrap();
            let mut retired = Vec::new();
            entries.retain(|id, entry| {
                entry.finishing = true;
                entry.signal.send_replace(true);
                if entry.in_flight == 0 {
                    retired.push(id.clone());
                    false
                } else {
                    true
                }
            });
            drop(entries);
            for id in retired {
                self.inner.retire(&id);
            }
        }
        pub fn finish(&self, id: &str) -> Result<(), Error> {
            let mut entries = self.inner.entries.lock().unwrap();
            let entry = entries.get_mut(id).ok_or(Error::Unknown)?;
            entry.finishing = true;
            if entry.in_flight == 0 {
                entries.remove(id);
                drop(entries);
                self.inner.retire(id);
            }
            Ok(())
        }
    }
    impl Guard {
        pub fn check(&self) -> Result<(), Error> {
            if *self.signal.borrow() {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        }
        pub async fn cancelled(&mut self) {
            if *self.signal.borrow() {
                return;
            }
            while self.signal.changed().await.is_ok() {
                if *self.signal.borrow() {
                    return;
                }
            }
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            let mut entries = self.inner.entries.lock().unwrap();
            let entry = entries
                .get_mut(&self.id)
                .expect("guard entry must remain registered");
            entry.in_flight -= 1;
            if entry.finishing && entry.in_flight == 0 {
                entries.remove(&self.id);
                drop(entries);
                self.inner.retire(&self.id);
            }
        }
    }
}

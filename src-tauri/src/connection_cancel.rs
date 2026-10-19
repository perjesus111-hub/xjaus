//! Attempt-scoped cancellation. Cancelling an unknown/old id never cancels another attempt.
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::watch;
#[derive(Default)]
pub struct ConnectionCancellation {
    attempts: Mutex<HashMap<String, watch::Sender<bool>>>,
}
impl ConnectionCancellation {
    pub fn subscribe(&self, id: &str) -> watch::Receiver<bool> {
        self.attempts
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe()
    }
    pub fn cancel(&self, id: &str) {
        self.attempts
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_insert_with(|| watch::channel(false).0)
            .send_replace(true);
    }
    pub async fn run<T>(
        &self,
        id: Option<&str>,
        future: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        use std::{
            future::{Future, poll_fn},
            task::Poll,
        };
        let mut cancellation = std::pin::pin!(self.cancelled(id));
        let mut operation = std::pin::pin!(future);
        poll_fn(|cx| {
            if cancellation.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err("ConnectionCancelled".into()));
            }
            operation.as_mut().poll(cx)
        })
        .await
    }
    pub fn check(&self, id: Option<&str>) -> Result<(), String> {
        if id.is_some_and(|id| *self.subscribe(id).borrow()) {
            Err("ConnectionCancelled".into())
        } else {
            Ok(())
        }
    }
    pub async fn cancelled(&self, id: Option<&str>) {
        let Some(id) = id else {
            std::future::pending::<()>().await;
            return;
        };
        let mut receiver = self.subscribe(id);
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aborts_pending_work_without_polling_a_late_completion() {
        let registry = std::sync::Arc::new(ConnectionCancellation::default());
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
                let _other = registry.subscribe("other");
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

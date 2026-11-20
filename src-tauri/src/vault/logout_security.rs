// Process-shared synthetic store; not a runtime dispatcher test.
use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
};

struct FileStore {
    path: PathBuf,
    fail_set: bool,
    fail_delete: bool,
}
impl SecretStore for FileStore {
    fn set(&self, bytes: &[u8]) -> Result<(), String> {
        if self.fail_set {
            return Err("synthetic set failure".into());
        }
        fs::write(&self.path, bytes).map_err(|e| e.to_string())
    }
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match fs::read(&self.path) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn delete(&self) -> Result<(), String> {
        if self.fail_delete {
            return Err("synthetic delete failure".into());
        }
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
fn bundle(name: &str) -> TokenBundle {
    serde_json::from_value(serde_json::json!({"refresh_token": name, "acquired_at_unix": 1}))
        .unwrap()
}
pub fn execute(root: &Path, action: &str) {
    let store = FileStore {
        path: root.join("secret"),
        fail_set: action == "failed-login",
        fail_delete: action == "failed-logout",
    };
    let barrier = root.join("barrier");
    match action {
        "seed" => {
            let epoch = begin_login_at(&barrier).unwrap();
            login_at(&store, &barrier, &bundle("synthetic-old"), epoch).unwrap();
        }
        "failed-logout" => {
            let err = delete_guarded(&store, Ok(None), &barrier).unwrap_err();
            assert!(err.contains("synthetic delete failure"));
            assert!(store.path.exists());
        }
        "failed-login" => {
            let epoch = begin_login_at(&barrier).unwrap();
            let err = login_at(&store, &barrier, &bundle("synthetic-new"), epoch).unwrap_err();
            assert!(err.contains("synthetic set failure"));
            assert!(store.path.exists());
        }
        "restart" => assert!(
            load_guarded(&store, &barrier).unwrap().is_none(),
            "persisted session resurrected"
        ),
        "capture" => {
            let epoch = crate::logout_barrier::LogoutBarrier::acquire(&barrier)
                .unwrap()
                .generation()
                .unwrap();
            fs::write(root.join("epoch"), epoch.to_string()).unwrap();
        }
        "late-refresh" => {
            let epoch = fs::read_to_string(root.join("epoch"))
                .unwrap()
                .parse()
                .unwrap();
            let err = save_if_generation_at(
                &store,
                &barrier,
                &bundle("synthetic-new"),
                &bundle("synthetic-old"),
                epoch,
            )
            .unwrap_err();
            assert!(err.contains("invalidated"));
        }
        "late-login" => {
            let epoch = fs::read_to_string(root.join("epoch"))
                .unwrap()
                .parse()
                .unwrap();
            let err = login_at(&store, &barrier, &bundle("synthetic-new"), epoch).unwrap_err();
            assert!(err.contains("invalidated"));
        }
        _ => panic!("unknown action"),
    }
}

#[test]
fn worker() {
    if let (Ok(root), Ok(action)) = (
        std::env::var("XJAUS_TEST_ROOT"),
        std::env::var("XJAUS_TEST_ACTION"),
    ) {
        execute(std::path::Path::new(&root), &action);
    }
}

fn run(root: &std::path::Path, action: &str) {
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "vault::logout_security::worker", "--nocapture"])
        .env("XJAUS_TEST_ROOT", root)
        .env("XJAUS_TEST_ACTION", action)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
    assert!(
        result.status.success(),
        "worker {action} failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn isolated() -> std::path::PathBuf {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).unwrap();
    let root = std::env::temp_dir().join(format!("xjaus-logout-security-{}", hex::encode(nonce)));
    std::fs::create_dir(&root).unwrap();
    root
}
#[test]
fn failed_delete_restart_rejects_stale_cross_process_auth() {
    let root = isolated();
    for action in [
        "seed",
        "capture",
        "failed-logout",
        "late-refresh",
        "late-login",
        "restart",
    ] {
        run(&root, action);
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_login_write_restart_does_not_restore_old_secret() {
    let root = isolated();
    for action in ["seed", "failed-login", "restart"] {
        run(&root, action);
    }
    std::fs::remove_dir_all(root).unwrap();
}

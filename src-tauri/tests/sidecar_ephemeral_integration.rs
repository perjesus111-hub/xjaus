#![cfg(target_os = "linux")]
// Real sidecar, synthetic HOME and unreachable bus. Requires strace.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[test]
fn eof_reports_drain_after_the_last_ipc_reply() {
    let home = std::env::temp_dir().join(format!("xjaus-eof-{}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_xjaus_backend"))
        .arg("--shutdown-report")
        .env_clear()
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"id":7,"cmd":"auth_status"})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    fs::remove_dir_all(home).unwrap();
    assert!(output.status.success());
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames[0]["id"], 7);
    assert_eq!(frames.get(1), Some(&json!({"shutdown":"drained"})));
    assert_eq!(frames.len(), 2);
}

fn run(home: &Path, trace: &Path, commands: &[&str]) -> Vec<Value> {
    let mut child = Command::new("strace")
        .args(["-f", "-e", "trace=file,network", "-o"])
        .arg(trace)
        .arg(env!("CARGO_BIN_EXE_xjaus_backend"))
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_RUNTIME_DIR", home.join("runtime"))
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", home.join("unreachable-bus").display()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("strace required");
    let mut stdin = child.stdin.take().unwrap();
    for (id, cmd) in commands.iter().enumerate() {
        writeln!(stdin, "{}", json!({"id":id, "cmd":cmd})).unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    // Logout has priority; wire order is deliberately not request order.
    // Correlate by the protocol ID and reject missing/duplicate responses.
    responses.sort_by_key(|response| response["id"].as_u64().expect("response ID"));
    assert_eq!(responses.len(), commands.len());
    for (id, response) in responses.iter().enumerate() {
        assert_eq!(response["id"].as_u64(), Some(id as u64));
    }
    responses
}

#[test]
fn sidecar_ignores_unavailable_old_stores_before_and_after_restart() {
    let root = std::env::temp_dir().join(format!(
        "xjaus-sidecar-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let old = root.join(".local/share/io.github.xjaus.xjaus");
    fs::create_dir_all(&old).unwrap();
    let legacy = old.join("auth.enc");
    fs::write(&legacy, b"synthetic-legacy-credential").unwrap();
    // A regular file makes acquiring a durable barrier at this path impossible.
    fs::write(old.join("logout-barrier"), b"synthetic-obstacle").unwrap();
    let secret = root.join("synthetic-keyring");
    fs::write(&secret, b"synthetic-keyring-credential").unwrap();
    let trace1 = root.join("first.trace");
    let first = run(
        &root,
        &trace1,
        &[
            "auth_status",
            "load_session",
            "logout",
            "auth_status",
            "persist_session",
        ],
    );
    assert_eq!(first.len(), 5);
    assert_eq!(first[0]["result"]["authenticated"], false);
    assert_eq!(first[0]["result"]["account"], "");
    assert_eq!(
        first[1]["error"],
        "Session restoration is disabled; sign in again"
    );
    assert!(
        first[2]["error"]
            .as_str()
            .unwrap()
            .contains("Secret Service")
    );
    assert_eq!(first[3]["result"]["authenticated"], false);
    assert_eq!(
        first[4]["error"],
        "Session persistence is disabled; sessions are memory only"
    );
    let trace2 = root.join("restart.trace");
    let second = run(&root, &trace2, &["auth_status", "load_session"]);
    assert_eq!(second.len(), 2);
    assert_eq!(second[0]["result"]["authenticated"], false);
    assert_eq!(second[0]["result"]["account"], "");
    assert_eq!(
        second[1]["error"],
        "Session restoration is disabled; sign in again"
    );
    for trace in [&trace2] {
        let text = fs::read_to_string(trace).unwrap();
        for forbidden in [
            "auth.enc",
            "logout-barrier",
            "synthetic-keyring",
            "unreachable-bus",
            "connect(",
        ] {
            assert!(
                !text.contains(forbidden),
                "unexpected access {forbidden}: {text}"
            );
        }
    }
    assert!(!legacy.exists());
    assert_eq!(fs::read(secret).unwrap(), b"synthetic-keyring-credential");
    fs::remove_dir_all(root).unwrap();
}

use std::{fs::File, io::Write, process::Command};

#[test]
fn rejects_malformed_regular_image() {
    let path = std::env::temp_dir().join(format!("squash-malformed-{}", std::process::id()));
    File::create(&path)
        .unwrap()
        .write_all(b"not an image")
        .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_squash-worker-prototype"))
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("worker failed"));
}

#[test]
fn fifo_without_writer_is_rejected_without_blocking() {
    use std::{
        ffi::CString,
        os::unix::ffi::OsStrExt,
        time::{Duration, Instant},
    };
    let path = std::env::temp_dir().join(format!("squash-fifo-{}", std::process::id()));
    let cpath = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
    let mut child = Command::new(env!("CARGO_BIN_EXE_squash-worker-prototype"))
        .arg(&path)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    std::fs::remove_file(path).unwrap();
    assert!(status.is_some(), "opening a FIFO blocked");
    assert!(!status.unwrap().success());
}

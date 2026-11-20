//! One lifetime lock shared by the Tauri and sidecar runners. Never unlink it.
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::{fs, path::PathBuf};

#[cfg(unix)]
pub fn acquire() -> Result<File, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME unavailable")?);
    if !home.is_absolute() {
        return Err("HOME must be absolute".into());
    }
    let home_meta = fs::symlink_metadata(&home).map_err(|_| "Cannot inspect HOME")?;
    let uid = unsafe { geteuid() };
    if !home_meta.is_dir() || home_meta.uid() != uid {
        return Err("Unsafe HOME".into());
    }
    let dir = home.join(".xjaus-instance");
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("Cannot create instance directory".into()),
    }
    let meta = fs::symlink_metadata(&dir).map_err(|_| "Cannot inspect instance directory")?;
    if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o777 != 0o700 {
        return Err("Unsafe instance directory".into());
    }
    let path = dir.join("runner.lock");
    // Reject symlinks before opening; directory is private to the current user.
    if let Ok(meta) = fs::symlink_metadata(&path)
        && (!meta.is_file()
            || meta.uid() != uid
            || meta.nlink() != 1
            || meta.permissions().mode() & 0o777 != 0o600)
    {
        return Err("Unsafe instance lock".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Cannot open instance lock")?;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect instance lock")?;
    if !meta.is_file()
        || meta.uid() != uid
        || meta.nlink() != 1
        || meta.permissions().mode() & 0o777 != 0o600
    {
        return Err("Unsafe instance lock".into());
    }
    file.try_lock()
        .map_err(|_| "Another XJAUS instance is already running")?;
    Ok(file)
}

#[cfg(windows)]
pub fn acquire() -> Result<File, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const REPARSE: u32 = 0x400;
    const OPEN_REPARSE: u32 = 0x00200000;
    let dir = crate::windows_fs::root("instance")?;
    crate::windows_fs::directory(&dir)?;
    let path = dir.join("runner.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(OPEN_REPARSE)
        .open(&path)
        .map_err(|_| "Cannot open instance lock")?;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect instance lock")?;
    if !meta.is_file() || meta.file_attributes() & REPARSE != 0 {
        return Err("Unsafe instance lock".into());
    }
    crate::windows_fs::protect(&path)?;
    file.try_lock()
        .map_err(|_| "Another XJAUS instance is already running")?;
    Ok(file)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    fn test_name(name: &str) -> String {
        format!("{}::{name}", module_path!().split_once("::").unwrap().1)
    }

    #[test]
    fn process_lock_excludes_other_runner_until_process_dies() {
        if std::env::var_os("XJAUS_LOCK_CHILD").is_some() {
            let _guard = acquire().expect("first instance must acquire");
            println!("READY");
            std::thread::park();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(test_name(
                "process_lock_excludes_other_runner_until_process_dies",
            ))
            .arg("--nocapture")
            .env("HOME", &root)
            .env("XJAUS_LOCK_CHILD", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        assert!(lines.any(|line| line.unwrap().contains("READY")));
        // An independent process uses the same HOME, so a held lock must fail.
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(test_name("contender"))
            .arg("--nocapture")
            .env("HOME", &root)
            .env("XJAUS_LOCK_CONTENDER", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        child.kill().unwrap();
        child.wait().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(test_name("contender"))
            .arg("--nocapture")
            .env("HOME", &root)
            .env("XJAUS_LOCK_CONTENDER", "2")
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn contender() {
        match std::env::var("XJAUS_LOCK_CONTENDER").as_deref() {
            Ok("1") => assert!(acquire().is_err()),
            Ok("2") => assert!(acquire().is_ok()),
            _ => (),
        }
    }
}

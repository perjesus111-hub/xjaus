//! Durable Windows logout barrier.
use std::{
    fs::{self, File, OpenOptions},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
};

pub struct LogoutBarrier {
    root: PathBuf,
    _lock: File,
}
impl LogoutBarrier {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        crate::windows_fs::directory(root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(root.join("logout.lock"))
            .map_err(|e| format!("open barrier lock: {e}"))?;
        let metadata = lock
            .metadata()
            .map_err(|e| format!("inspect barrier lock: {e}"))?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Unsafe barrier lock".into());
        }
        lock.lock().map_err(|e| format!("lock barrier: {e}"))?;
        Ok(Self {
            root: root.to_owned(),
            _lock: lock,
        })
    }
    fn state(&self) -> Result<(u64, bool), String> {
        let path = self.root.join("state");
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, true)),
            Err(e) => return Err(format!("inspect barrier state: {e}")),
            Ok(_) => (),
        }
        let data = crate::windows_fs::read(&path, 64)?;
        let text = std::str::from_utf8(&data).map_err(|_| "Invalid barrier state")?;
        let (generation_text, flag) = text.split_once(':').ok_or("Invalid barrier state")?;
        let generation = generation_text
            .parse()
            .map_err(|_| "Invalid barrier generation")?;
        let blocked = match flag {
            "0" => false,
            "1" => true,
            _ => return Err("Invalid barrier state".into()),
        };
        Ok((generation, blocked))
    }
    fn commit(&self, generation: u64, blocked: bool) -> Result<(), String> {
        crate::windows_fs::write(
            &self.root.join("state"),
            format!("{generation}:{}", u8::from(blocked)).as_bytes(),
        )
    }
    pub fn generation(&self) -> Result<u64, String> {
        Ok(self.state()?.0)
    }
    pub fn blocked(&self) -> Result<bool, String> {
        Ok(self.state()?.1)
    }
    pub fn advance(&self) -> Result<(), String> {
        let (generation, blocked) = self.state()?;
        self.commit(
            generation
                .checked_add(1)
                .ok_or("logout generation exhausted")?,
            blocked,
        )
    }
    pub fn block(&self) -> Result<(), String> {
        let (g, _) = self.state()?;
        self.commit(g, true)
    }
    pub fn unblock(&self) -> Result<(), String> {
        let (g, _) = self.state()?;
        self.commit(g, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_overflow_preserves_blocked_state() {
        let root = std::env::temp_dir().join(format!("xjaus-win-overflow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let barrier = LogoutBarrier::acquire(&root).unwrap();
        std::fs::write(root.join("state"), format!("{}:1", u64::MAX)).unwrap();
        assert!(barrier.advance().is_err());
        assert_eq!(barrier.generation().unwrap(), u64::MAX);
        assert!(barrier.blocked().unwrap());
        drop(barrier);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_state_fails_closed() {
        let root = std::env::temp_dir().join(format!("xjaus-win-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let b = LogoutBarrier::acquire(&root).unwrap();
        std::fs::write(root.join("state"), b"corrupt").unwrap();
        assert!(b.blocked().is_err());
        assert!(b.generation().is_err());
        assert!(b.unblock().is_err());
        drop(b);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lock_serializes_processes() {
        use std::time::{Duration, Instant};
        if let Some(root) = std::env::var_os("XJAUS_WIN_BARRIER_CHILD") {
            let root = std::path::PathBuf::from(root);
            std::fs::write(root.join("waiting"), std::process::id().to_string()).unwrap();
            let _guard = LogoutBarrier::acquire(&root).unwrap();
            std::fs::write(root.join("acquired"), b"1").unwrap();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-win-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let guard = LogoutBarrier::acquire(&root).unwrap();
        // libtest names omit the crate prefix that module_path! includes.
        let module = module_path!().split_once("::").unwrap().1;
        let test_name = format!("{module}::lock_serializes_processes");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test_name, "--nocapture"])
            .env("XJAUS_WIN_BARRIER_CHILD", &root)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("waiting").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.join("waiting").exists());
        let child_pid: u32 = std::fs::read_to_string(root.join("waiting"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(child_pid, child.id());
        assert_ne!(child_pid, std::process::id());
        println!(
            "lock parent pid={}, child pid={child_pid}",
            std::process::id()
        );
        std::thread::sleep(Duration::from_millis(150));
        assert!(!root.join("acquired").exists());
        drop(guard);
        assert!(child.wait().unwrap().success());
        assert!(root.join("acquired").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn marker_and_generation_survive_reopen() {
        let root = std::env::temp_dir().join(format!("xjaus-win-barrier-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        {
            let b = LogoutBarrier::acquire(&root).unwrap();
            assert_eq!(b.generation().unwrap(), 0);
            b.block().unwrap();
            b.advance().unwrap();
        }
        let b = LogoutBarrier::acquire(&root).unwrap();
        assert!(b.blocked().unwrap());
        assert_eq!(b.generation().unwrap(), 1);
        b.unblock().unwrap();
        drop(b);
        std::fs::remove_dir_all(root).unwrap();
    }
}

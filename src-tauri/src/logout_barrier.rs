//! Durable logout barrier, with an explicitly supplied isolated root.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

// O_NOFOLLOW differs across Unix platforms.
#[cfg(any(target_os = "linux", target_os = "android"))]
const NOFOLLOW: i32 = 0o400000;
#[cfg(any(target_os = "linux", target_os = "android"))]
const NONBLOCK: i32 = 0o4000;
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
const NONBLOCK: i32 = 4;
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
const NOFOLLOW: i32 = 0x100;
unsafe extern "C" {
    fn geteuid() -> u32;
}
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct LogoutBarrier {
    root: PathBuf,
    dir: File,
    _lock: File,
}

impl LogoutBarrier {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)
            .map_err(|e| format!("create barrier directory: {e}"))?;
        let dir = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(root)
            .map_err(|e| format!("open barrier directory: {e}"))?;
        let meta = dir
            .metadata()
            .map_err(|e| format!("stat barrier directory: {e}"))?;
        if !meta.is_dir() || meta.uid() != unsafe { geteuid() } || meta.mode() & 0o077 != 0 {
            return Err("unsafe barrier directory ownership or permissions".into());
        }
        // Pin all operations to the verified directory, even if its pathname is replaced.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let pinned = PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()));
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let pinned = PathBuf::from(format!("/dev/fd/{}", dir.as_raw_fd()));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(NOFOLLOW | NONBLOCK)
            .open(pinned.join("logout.lock"))
            .map_err(|e| format!("open lock: {e}"))?;
        Self::check_file(&lock)?;
        lock.lock().map_err(|e| format!("lock barrier: {e}"))?;
        Ok(Self {
            root: pinned,
            dir,
            _lock: lock,
        })
    }
    fn check_file(file: &File) -> Result<(), String> {
        let meta = file
            .metadata()
            .map_err(|e| format!("stat barrier file: {e}"))?;
        if !meta.is_file()
            || meta.uid() != unsafe { geteuid() }
            || meta.nlink() != 1
            || meta.mode() & 0o077 != 0
        {
            return Err("unsafe barrier file ownership, type or permissions".into());
        }
        Ok(())
    }
    fn read_state(&self, name: &str) -> Result<Option<String>, String> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW | NONBLOCK)
            .open(self.root.join(name))
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("open barrier state: {e}")),
        };
        Self::check_file(&file)?;
        let mut value = String::new();
        file.take(4097)
            .read_to_string(&mut value)
            .map_err(|e| format!("read barrier state: {e}"))?;
        if value.len() > 4096 {
            return Err("oversized barrier state".into());
        }
        Ok(Some(value))
    }
    fn atomic_write(&self, name: &str, data: &[u8]) -> Result<(), String> {
        for _ in 0..128 {
            let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let temp = self
                .root
                .join(format!(".{name}.{}.{id}.tmp", std::process::id()));
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(NOFOLLOW)
                .open(&temp)
            {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("create temporary barrier state: {e}")),
            };
            let result = (|| {
                Self::check_file(&file)?;
                file.write_all(data)
                    .map_err(|e| format!("write barrier state: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("sync barrier state: {e}"))?;
                fs::rename(&temp, self.root.join(name))
                    .map_err(|e| format!("commit barrier state: {e}"))?;
                self.sync_dir()
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temp);
            }
            return result;
        }
        Err("temporary barrier names exhausted".into())
    }
    pub fn blocked(&self) -> Result<bool, String> {
        match fs::symlink_metadata(self.root.join("logout.marker")) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("read marker: {e}")),
        }
        let generation = self.generation()?;
        if generation == 0 {
            return Ok(true);
        }
        Ok(self.read_state("authorized")?.as_deref()
            != Some(&format!("XJAUS authorized v1:{generation}")))
    }
    pub fn generation(&self) -> Result<u64, String> {
        match self.read_state("generation")? {
            Some(value) => value
                .parse()
                .map_err(|_| "invalid logout generation".into()),
            None => Ok(0),
        }
    }
    pub fn advance(&self) -> Result<(), String> {
        let next = self
            .generation()?
            .checked_add(1)
            .ok_or("logout generation exhausted")?;
        self.atomic_write("generation", next.to_string().as_bytes())
    }
    fn sync_dir(&self) -> Result<(), String> {
        self.dir
            .sync_all()
            .map_err(|e| format!("sync barrier directory: {e}"))
    }
    pub fn unblock(&self) -> Result<(), String> {
        let generation = self.generation()?;
        if generation == 0 {
            return Err("invalid authorization generation".into());
        }
        self.atomic_write(
            "authorized",
            format!("XJAUS authorized v1:{generation}").as_bytes(),
        )?;
        match fs::remove_file(self.root.join("logout.marker")) {
            Ok(()) => self.sync_dir(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove logout marker: {e}")),
        }
    }
    pub fn block(&self) -> Result<(), String> {
        let path = self.root.join("logout.marker");
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(NOFOLLOW)
            .open(&path)
        {
            Ok(mut file) => {
                Self::check_file(&file)?;
                file.write_all(b"XJAUS logout v1\n")
                    .map_err(|e| format!("write marker: {e}"))?;
                file.sync_all().map_err(|e| format!("sync marker: {e}"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let file = OpenOptions::new()
                    .read(true)
                    .custom_flags(NOFOLLOW | NONBLOCK)
                    .open(path)
                    .map_err(|e| format!("open marker: {e}"))?;
                Self::check_file(&file)?;
                file.sync_all().map_err(|e| format!("sync marker: {e}"))?;
            }
            Err(e) => return Err(format!("create marker: {e}")),
        }
        self.sync_dir()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_symlinks_cannot_truncate_victim() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("xjaus-symlink-victim-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let barrier = LogoutBarrier::acquire(&root).unwrap();
        let victim = root.join("victim");
        fs::write(&victim, b"protected victim").unwrap();
        symlink(&victim, root.join("generation.next")).unwrap();
        barrier.advance().unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"protected victim");
        symlink(&victim, root.join("authorized.next")).unwrap();
        barrier.unblock().unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"protected victim");
        drop(barrier);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlinked_lock_and_state_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("xjaus-symlink-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let victim = root.join("victim");
        fs::write(&victim, b"protected victim").unwrap();
        symlink(&victim, root.join("logout.lock")).unwrap();
        assert!(LogoutBarrier::acquire(&root).is_err());
        fs::remove_file(root.join("logout.lock")).unwrap();
        let barrier = LogoutBarrier::acquire(&root).unwrap();
        symlink(&victim, root.join("generation")).unwrap();
        assert!(barrier.generation().is_err());
        assert!(barrier.blocked().is_err());
        fs::remove_file(root.join("generation")).unwrap();
        barrier.advance().unwrap();
        symlink(&victim, root.join("authorized")).unwrap();
        assert!(barrier.blocked().is_err());
        symlink(&victim, root.join("logout.marker")).unwrap();
        assert!(barrier.blocked().unwrap());
        assert!(barrier.block().is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"protected victim");
        drop(barrier);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retrying_block_rejects_a_non_file_marker() {
        let root =
            std::env::temp_dir().join(format!("xjaus-marker-invalid-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let barrier = LogoutBarrier::acquire(&root).unwrap();
        fs::create_dir(root.join("logout.marker")).unwrap();
        assert!(barrier.blocked().unwrap());
        assert!(barrier.block().is_err());
        drop(barrier);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cross_process_lock_serializes_barrier_access() {
        use std::{
            process::Command,
            time::{Duration, Instant},
        };
        if let Some(root) = std::env::var_os("XJAUS_BARRIER_CHILD") {
            let root = PathBuf::from(root);
            fs::write(root.join("waiting"), b"1").unwrap();
            let _guard = LogoutBarrier::acquire(&root).unwrap();
            fs::write(root.join("acquired"), b"1").unwrap();
            return;
        }
        let root = std::env::temp_dir().join(format!("xjaus-barrier-lock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let guard = LogoutBarrier::acquire(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logout_barrier::tests::cross_process_lock_serializes_barrier_access",
            ])
            .env("XJAUS_BARRIER_CHILD", &root)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("waiting").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.join("waiting").exists());
        std::thread::sleep(Duration::from_millis(150));
        assert!(!root.join("acquired").exists());
        drop(guard);
        assert!(child.wait().unwrap().success());
        assert!(root.join("acquired").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn marker_survives_reopen_and_corruption_fails_closed() {
        let root = std::env::temp_dir().join(format!("xjaus-barrier-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        {
            let barrier = LogoutBarrier::acquire(&root).unwrap();
            assert!(barrier.blocked().unwrap());
            barrier.block().unwrap();
        }
        std::fs::write(root.join("logout.marker"), b"corrupt").unwrap();
        assert!(LogoutBarrier::acquire(&root).unwrap().blocked().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! Experimental isolation prototype, NOT a sandbox or a release trust decision. Linux only.
//! The wall deadline covers the spawned worker only, not opening or copying input.
//! Executable identity is not pinned: current_exe() is resolved again at exec and may
//! be replaced. This remains an outstanding issue; do not integrate or publish.
//! The parent snapshots input in a sealed memfd and gives the worker CPU, address
//! space and wall limits. Same-UID interference and a compromised worker are not
//! defended; the caller must still authenticate the image and compare the digest.
use backhand::{FilesystemReader, InnerNode};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const INPUT_LIMIT: u64 = 512 * 1024 * 1024;
const APPRUN_LIMIT: u64 = 16 * 1024 * 1024;
const MEMORY_LIMIT: u64 = 512 * 1024 * 1024;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn memfd(name: &std::ffi::CStr, sealing: bool) -> io::Result<File> {
    let flags = libc::MFD_CLOEXEC | if sealing { libc::MFD_ALLOW_SEALING } else { 0 };
    let fd = unsafe { libc::memfd_create(name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn worker(mut input: File) -> Result<[u8; 32]> {
    let mut header = [0; 64];
    input.read_exact(&mut header)?;
    if &header[..6] != b"\x7fELF\x02\x01" {
        return Err("ELF".into());
    }
    let off = u64::from_le_bytes(header[40..48].try_into()?);
    let size = u16::from_le_bytes(header[58..60].try_into()?) as u64;
    let count = u16::from_le_bytes(header[60..62].try_into()?) as u64;
    if size != 64 || count == 0 {
        return Err("section table".into());
    }
    let off = off
        .checked_add(size.checked_mul(count).ok_or("overflow")?)
        .ok_or("overflow")?;
    input.seek(SeekFrom::Start(off))?;
    let mut magic = [0; 4];
    input.read_exact(&mut magic)?;
    if &magic != b"hsqs" {
        return Err("squashfs".into());
    }
    let fs = FilesystemReader::from_reader_with_offset(BufReader::new(input), off)?;
    let mut nodes = fs.files().filter(|n| n.fullpath == Path::new("/AppRun"));
    let node = nodes.next().ok_or("missing AppRun")?;
    if nodes.next().is_some() {
        return Err("duplicate AppRun".into());
    }
    let InnerNode::File(file) = &node.inner else {
        return Err("nonregular AppRun".into());
    };
    let expected = u64::try_from(file.file_len())?;
    if expected == 0 || expected > APPRUN_LIMIT {
        return Err("AppRun size limit".into());
    }
    let handle = fs.file(file);
    let mut reader = handle.reader_checked()?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0; 8192];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or("overflow")?;
        if total > expected || total > APPRUN_LIMIT {
            return Err("AppRun size limit".into());
        }
        hash.update(&buf[..n]);
    }
    if total != expected {
        return Err("AppRun size mismatch".into());
    }
    Ok(hash.finalize().into())
}
struct Reap(std::process::Child);
impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn run(path: &Path) -> Result<[u8; 32]> {
    let source = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)?;
    if !source.metadata()?.is_file() {
        return Err("input must be regular file".into());
    }
    let mut image = memfd(c"squash-input", true)?;
    let copied = io::copy(&mut source.take(INPUT_LIMIT + 1), &mut image)?;
    if copied > INPUT_LIMIT {
        return Err("input size limit".into());
    }
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL;
    if unsafe { libc::fcntl(image.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    image.rewind()?;
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("--worker").env_clear();
    spawn_bounded(image, command)
}
fn spawn_bounded(image: File, mut command: Command) -> Result<[u8; 32]> {
    let mut output = memfd(c"squash-output", false)?;
    command
        .stdin(Stdio::from(image))
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::null());
    // pre_exec calls only async-signal-safe libc functions. Failure aborts exec.
    unsafe {
        command.pre_exec(|| {
            // CLOEXEC preserves Rust's internal exec-error pipe until exec while
            // preventing all descriptors above stderr from reaching the worker.
            // Unsupported kernels or denied syscalls fail closed.
            if libc::syscall(
                libc::SYS_close_range,
                3u32,
                u32::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            ) != 0
            {
                return Err(io::Error::last_os_error());
            }
            for (resource, limit) in [
                (libc::RLIMIT_CPU, 1),
                (libc::RLIMIT_AS, MEMORY_LIMIT),
                (libc::RLIMIT_FSIZE, 32),
                (libc::RLIMIT_CORE, 0),
            ] {
                let r = libc::rlimit {
                    rlim_cur: limit,
                    rlim_max: limit,
                };
                if libc::setrlimit(resource, &r) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = Reap(command.spawn()?);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.0.try_wait()? {
            if !status.success() {
                return Err("worker failed".into());
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err("worker deadline".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    output.rewind()?;
    let mut bytes = Vec::new();
    output.take(33).read_to_end(&mut bytes)?;
    if bytes.len() != 32 {
        return Err("worker protocol".into());
    }
    Ok(bytes.try_into().map_err(|_| "worker protocol")?)
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let result: Result<()> = (|| {
        if args.len() != 2 {
            return Err("usage: squash-worker-prototype IMAGE".into());
        }
        if args[1] == "--worker" {
            let input = unsafe { File::from_raw_fd(0) };
            let digest =
                std::panic::catch_unwind(|| worker(input)).map_err(|_| "worker panic")??;
            io::stdout().write_all(&digest)?;
        } else {
            let digest = run(Path::new(&args[1]))?;
            for b in digest {
                print!("{b:02x}");
            }
            println!();
        }
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hung_worker_is_killed() {
        if std::env::var_os("WORKER_HANG").is_some() {
            std::fs::write(
                std::env::var_os("WORKER_PID_FILE").unwrap(),
                std::process::id().to_string(),
            )
            .unwrap();
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let image = memfd(c"test-image", false).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        let pid_file =
            std::env::temp_dir().join(format!("squash-worker-pid-{}", std::process::id()));
        cmd.args(["--exact", "tests::hung_worker_is_killed", "--nocapture"])
            .env("WORKER_HANG", "1")
            .env("WORKER_PID_FILE", &pid_file);
        let start = Instant::now();
        let error = spawn_bounded(image, cmd).unwrap_err();
        assert_eq!(error.to_string(), "worker deadline");
        assert!(start.elapsed() >= Duration::from_secs(3));
        assert!(start.elapsed() < Duration::from_secs(6));
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        std::fs::remove_file(pid_file).unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "worker still exists");
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "worker was not reaped"
        );
    }
    #[test]
    fn worker_does_not_inherit_unrelated_descriptor() {
        if std::env::var_os("WORKER_CHECK_FD").is_some() {
            let fd: i32 = std::env::var("WORKER_CHECK_FD").unwrap().parse().unwrap();
            let result = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            let closed =
                result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
            unsafe {
                libc::ftruncate(1, 0);
                libc::lseek(1, 0, libc::SEEK_SET);
                let bytes = [u8::from(closed); 32];
                libc::write(1, bytes.as_ptr().cast(), 32);
                libc::_exit(0);
            }
        }
        let file = File::open("/dev/null").unwrap();
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 200) };
        assert!(fd >= 200);
        let image = memfd(c"test-image", false).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "tests::worker_does_not_inherit_unrelated_descriptor",
            "--nocapture",
        ])
        .env("WORKER_CHECK_FD", fd.to_string());
        let result = spawn_bounded(image, cmd);
        unsafe {
            libc::close(fd);
        }
        assert_eq!(result.unwrap(), [1; 32]);
    }
    #[test]
    fn worker_memory_limit_is_enforced() {
        if std::env::var_os("WORKER_MEMORY").is_some() {
            let ptr = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    (MEMORY_LIMIT * 2) as usize,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                )
            };
            if ptr != libc::MAP_FAILED {
                unsafe { libc::_exit(9) }
            }
            unsafe {
                libc::ftruncate(1, 0);
                libc::lseek(1, 0, libc::SEEK_SET);
                libc::write(1, [7u8; 32].as_ptr().cast(), 32);
                libc::_exit(0)
            }
        }
        let image = memfd(c"test-image", false).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "tests::worker_memory_limit_is_enforced",
            "--nocapture",
        ])
        .env("WORKER_MEMORY", "1");
        assert_eq!(spawn_bounded(image, cmd).unwrap(), [7; 32]);
    }
    #[test]
    fn worker_cpu_limit_is_enforced() {
        if std::env::var_os("WORKER_CPU").is_some() {
            loop {
                std::hint::black_box(1);
            }
        }
        let image = memfd(c"test-image", false).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "tests::worker_cpu_limit_is_enforced",
            "--nocapture",
        ])
        .env("WORKER_CPU", "1");
        let start = Instant::now();
        assert!(spawn_bounded(image, cmd).is_err());
        assert!(start.elapsed() < Duration::from_millis(2800));
    }
}

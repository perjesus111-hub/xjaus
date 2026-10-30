//! Non-publishing research prototype. Production has no approved trust anchor
//! or independently reviewed AppRun reference and always rejects.
//!
//! The production entry point is fail-closed until separately approved trust
//! policy is configured in source. The test key and AppRun digest are NOT trusted release
//! credentials. Before enabling any integration: obtain an operator-verified
//! Ed25519 public key out of band; independently reproduce and review AppRun from authenticated builder source
//! and patch as described in scripts/APP-RUN-REFERENCE.md; record provenance,
//! digest and reviewer approval; explicitly approve the version, full commit and
//! exact paths; review limits, parser robustness and Linux memfd resource usage;
//! and perform a separate security review. Never derive the policy reference from
//! the candidate being checked. This code has no publisher and does not change
//! the existing disabled release gate.
//!
//! Test manifest: domain `XJAUS-RELEASE-MANIFEST-v1\0`, five ASCII version
//! bytes, 40 lowercase ASCII commit bytes, then five ordered records, each a
//! big-endian u16 path length, exact UTF-8 path, big-endian u64 size and 32 raw
//! SHA-256 bytes. Detached Ed25519 signs the complete byte sequence.
pub fn production_verify() -> Result<(), &'static str> {
    Err("no approved trust anchor or AppRun reference")
}

/// Authenticate and validate five release candidates before delivering sealed snapshots.
///
/// This function currently always rejects: neither a production public key nor an
/// independently approved AppRun digest is configured. It never publishes files.
/// The caller must supply a trusted, quiescent directory descriptor and ensure
/// sufficient private memory; directory rechecks cannot eliminate concurrent races.
/// Consumers must read only the supplied sealed files, not reopen source paths.
pub fn verify_release(
    root: &std::fs::File,
    manifest: &[u8],
    signature: &[u8],
    consumer: impl FnOnce(&[std::fs::File; 5]),
) -> Result<(), Box<dyn std::error::Error>> {
    const PRODUCTION_KEY: Option<[u8; 32]> = None;
    const PRODUCTION_APPRUN: Option<[u8; 32]> = None;
    let key = PRODUCTION_KEY.ok_or("no approved production trust anchor")?;
    let reference = PRODUCTION_APPRUN.ok_or("no approved AppRun reference")?;
    implementation::verify_policy(root, manifest, signature, &key, &reference, || {}, consumer)
}

mod implementation {
    use ring::signature;
    const DOMAIN: &[u8] = b"XJAUS-RELEASE-MANIFEST-v1\0";
    pub const COMMIT: &str = "3259031dda1650176811da81cc91b35219eed10c";
    pub const NAMES: [&str; 5] = [
        "linux/XJAUS-1.2.3-x86_64.AppImage",
        "linux/XJAUS-1.2.3-linux-x86_64.rpm",
        "linux/XJAUS-1.2.3-linux-amd64.deb",
        "win/XJAUS-1.2.3-win-x64-setup.msi",
        "win/XJAUS-1.2.3-win-x64-setup.exe",
    ];
    #[derive(Clone)]
    pub struct Record {
        pub name: &'static str,
        pub size: u64,
        pub digest: [u8; 32],
    }
    #[cfg(test)]
    pub fn encode(commit: &str, records: &[Record; 5]) -> Vec<u8> {
        let mut m = DOMAIN.to_vec();
        m.extend_from_slice(b"1.2.3");
        m.extend_from_slice(commit.as_bytes());
        for r in records {
            m.extend_from_slice(&(r.name.len() as u16).to_be_bytes());
            m.extend_from_slice(r.name.as_bytes());
            m.extend_from_slice(&r.size.to_be_bytes());
            m.extend_from_slice(&r.digest);
        }
        m
    }
    pub fn authenticate(
        m: &[u8],
        sig: &[u8],
        key: &[u8],
        commit: &str,
    ) -> Result<[Record; 5], &'static str> {
        if commit != COMMIT
            || commit.len() != 40
            || !commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("commit policy");
        }
        if m.len() > 4096 || sig.len() != 64 || key.len() != 32 {
            return Err("length");
        }
        signature::UnparsedPublicKey::new(&signature::ED25519, key)
            .verify(m, sig)
            .map_err(|_| "signature")?;
        let mut p = 0;
        fn take<'a>(m: &'a [u8], p: &mut usize, n: usize) -> Result<&'a [u8], &'static str> {
            let end = p.checked_add(n).ok_or("overflow")?;
            let x = m.get(*p..end).ok_or("truncated")?;
            *p = end;
            Ok(x)
        }
        if take(m, &mut p, DOMAIN.len())? != DOMAIN
            || take(m, &mut p, 5)? != b"1.2.3"
            || take(m, &mut p, 40)? != commit.as_bytes()
        {
            return Err("header");
        }
        let mut result = Vec::new();
        for name in NAMES {
            let n = u16::from_be_bytes(take(m, &mut p, 2)?.try_into().unwrap()) as usize;
            if take(m, &mut p, n)? != name.as_bytes() {
                return Err("name");
            };
            let size = u64::from_be_bytes(take(m, &mut p, 8)?.try_into().unwrap());
            if size == 0 || size > 512 * 1024 * 1024 {
                return Err("size");
            };
            let digest = take(m, &mut p, 32)?.try_into().unwrap();
            result.push(Record { name, size, digest });
        }
        if p != m.len() {
            return Err("extra");
        };
        if result.iter().map(|r| r.size).sum::<u64>() > 1024 * 1024 * 1024 {
            return Err("total");
        };
        Ok(result.try_into().map_err(|_| "count")?)
    }

    use backhand::{FilesystemReader, InnerNode};
    use sha2::{Digest, Sha256};
    use std::{
        fs::File,
        io::{BufReader, Read, Seek, SeekFrom},
        os::fd::{AsRawFd, FromRawFd},
        path::Path,
    };
    type R<T> = Result<T, Box<dyn std::error::Error>>;
    const LIMIT: u64 = 512 * 1024 * 1024;
    const APPRUN_LIMIT: u64 = 64 * 1024 * 1024;
    const SEALS: i32 =
        libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    fn digest_file(f: &mut File) -> R<[u8; 32]> {
        f.seek(SeekFrom::Start(0))?;
        let mut h = Sha256::new();
        let mut b = [0u8; 65536];
        loop {
            let n = f.read(&mut b)?;
            if n == 0 {
                break;
            }
            h.update(&b[..n]);
        }
        Ok(h.finalize().into())
    }
    pub fn seal(mut input: impl Read, expected: u64) -> R<File> {
        if expected > LIMIT {
            return Err("oversize".into());
        }
        let fd = unsafe {
            libc::memfd_create(
                c"verified-image".as_ptr(),
                libc::MFD_ALLOW_SEALING | libc::MFD_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut f = unsafe { File::from_raw_fd(fd) };
        let n = std::io::copy(&mut input.by_ref().take(expected + 1), &mut f)?;
        if n != expected {
            return Err("size".into());
        }
        if unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, SEALS) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(f)
    }
    fn apprun(f: &File) -> R<[u8; 32]> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            apprun_limited(f, APPRUN_LIMIT)
        }))
        .map_err(|_| "malformed squashfs")?
    }
    fn apprun_limited(f: &File, limit: u64) -> R<[u8; 32]> {
        let mut f = f.try_clone()?;
        f.seek(SeekFrom::Start(0))?;
        let mut h = [0; 64];
        f.read_exact(&mut h)?;
        if &h[..6] != b"\x7fELF\x02\x01" {
            return Err("ELF".into());
        }
        let off = u64::from_le_bytes(h[40..48].try_into()?);
        let sz = u16::from_le_bytes(h[58..60].try_into()?) as u64;
        let n = u16::from_le_bytes(h[60..62].try_into()?) as u64;
        if sz != 64 || n == 0 {
            return Err("section table".into());
        }
        let off = off
            .checked_add(sz.checked_mul(n).ok_or("overflow")?)
            .ok_or("overflow")?;
        f.seek(SeekFrom::Start(off))?;
        let mut magic = [0; 4];
        f.read_exact(&mut magic)?;
        if &magic != b"hsqs" {
            return Err("squashfs".into());
        }
        let fs = FilesystemReader::from_reader_with_offset(BufReader::new(f), off)?;
        let mut nodes = fs.files().filter(|x| x.fullpath == Path::new("/AppRun"));
        let node = nodes.next().ok_or("missing AppRun")?;
        if nodes.next().is_some() {
            return Err("duplicate AppRun".into());
        }
        let InnerNode::File(file) = &node.inner else {
            return Err("nonregular AppRun".into());
        };
        let expected = u64::try_from(file.file_len())?;
        if expected == 0 || expected > limit {
            return Err("AppRun size limit".into());
        }
        let handle = fs.file(file);
        let mut r = handle.reader_checked()?;
        let mut h = Sha256::new();
        let mut b = [0u8; 8192];
        let mut total = 0u64;
        loop {
            let n = r.read(&mut b)?;
            if n == 0 {
                break;
            }
            total = total.checked_add(n as u64).ok_or("AppRun size limit")?;
            if total > limit || total > expected {
                return Err("AppRun size limit".into());
            }
            h.update(&b[..n]);
        }
        if total != expected {
            return Err("AppRun size mismatch".into());
        }
        Ok(h.finalize().into())
    }

    // Test-only policy: this seed and digest are public experimental fixtures, not release trust.
    #[cfg(test)]
    fn test_key() -> Vec<u8> {
        use ring::signature::KeyPair;
        signature::Ed25519KeyPair::from_seed_unchecked(&[42; 32])
            .unwrap()
            .public_key()
            .as_ref()
            .to_vec()
    }
    #[cfg(test)]
    pub(super) const REFERENCE: [u8; 32] = [
        0x7b, 0xc1, 0xa3, 0xc5, 0x81, 0x7e, 0x3c, 0x60, 0xed, 0x28, 0x5c, 0xa3, 0x5a, 0x21, 0x76,
        0x39, 0xbe, 0x1d, 0x1d, 0x3f, 0x47, 0x8f, 0xdb, 0x81, 0xb7, 0x68, 0xb0, 0x1e, 0x8e, 0x2f,
        0xeb, 0x1d,
    ];

    fn open_component(dir: &File, name: &str, directory: bool) -> R<File> {
        let name = std::ffi::CString::new(name)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let f = unsafe { File::from_raw_fd(fd) };
        if directory && !f.metadata()?.is_dir() || !directory && !f.metadata()?.is_file() {
            return Err("file type".into());
        }
        Ok(f)
    }
    fn entries(dir: &File) -> R<Vec<String>> {
        // Open a fresh description: dup would share the directory offset.
        let fresh = open_component(dir, ".", true)?;
        let fd = unsafe { libc::dup(fresh.as_raw_fd()) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let dp = unsafe { libc::fdopendir(fd) };
        if dp.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(std::io::Error::last_os_error().into());
        }
        let result = (|| -> R<Vec<String>> {
            let mut names = Vec::new();
            loop {
                unsafe {
                    *libc::__errno_location() = 0;
                }
                let e = unsafe { libc::readdir(dp) };
                if e.is_null() {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() != Some(0) {
                        return Err(err.into());
                    }
                    break;
                }
                let name = unsafe { std::ffi::CStr::from_ptr((*e).d_name.as_ptr()) }
                    .to_str()?
                    .to_owned();
                if name != "." && name != ".." {
                    if names.len() >= 5 {
                        return Err("directory entries".into());
                    }
                    names.push(name);
                }
            }
            names.sort();
            Ok(names)
        })();
        unsafe {
            libc::closedir(dp);
        }
        result
    }
    fn exact(dir: &File, wanted: &[&str]) -> R<()> {
        let mut expected: Vec<String> = wanted.iter().map(|x| x.to_string()).collect();
        expected.sort();
        if entries(dir)? != expected {
            return Err("directory entries".into());
        }
        Ok(())
    }
    fn same_identity(a: &File, b: &File) -> R<()> {
        use std::os::unix::fs::MetadataExt;
        let a = a.metadata()?;
        let b = b.metadata()?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err("identity changed".into());
        }
        Ok(())
    }
    fn revalidate(root: &File, linux: &File, win: &File, inputs: &[File]) -> R<()> {
        if !root.metadata()?.is_dir() || inputs.len() != NAMES.len() {
            return Err("identity changed".into());
        }
        exact(root, &["linux", "win"])?;
        for (name, pinned) in [("linux", linux), ("win", win)] {
            same_identity(pinned, &open_component(root, name, true)?)?;
        }
        for (i, dir) in [linux, win].iter().enumerate() {
            let range = if i == 0 { 0..3 } else { 3..5 };
            let names: Vec<&str> = range
                .clone()
                .map(|j| NAMES[j].split_once('/').unwrap().1)
                .collect();
            exact(dir, &names)?;
            for j in range {
                let name = NAMES[j].split_once('/').unwrap().1;
                same_identity(&inputs[j], &open_component(dir, name, false)?)?;
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn verify(root: &File, m: &[u8], sig: &[u8], consumer: impl FnOnce(&[File; 5])) -> R<()> {
        verify_with_hook(root, m, sig, || {}, consumer)
    }
    #[cfg(test)]
    pub fn verify_with_hook(
        root: &File,
        m: &[u8],
        sig: &[u8],
        hook: impl FnOnce(),
        consumer: impl FnOnce(&[File; 5]),
    ) -> R<()> {
        verify_policy(
            root,
            m,
            sig,
            &test_key().try_into().unwrap(),
            &REFERENCE,
            hook,
            consumer,
        )
    }
    pub(super) fn verify_policy(
        root: &File,
        m: &[u8],
        sig: &[u8],
        key: &[u8; 32],
        reference: &[u8; 32],
        hook: impl FnOnce(),
        consumer: impl FnOnce(&[File; 5]),
    ) -> R<()> {
        let records = authenticate(m, sig, key, COMMIT)?;
        exact(root, &["linux", "win"])?;
        let linux = open_component(root, "linux", true)?;
        let win = open_component(root, "win", true)?;
        exact(
            &linux,
            &[
                NAMES[0].split_once('/').unwrap().1,
                NAMES[1].split_once('/').unwrap().1,
                NAMES[2].split_once('/').unwrap().1,
            ],
        )?;
        exact(
            &win,
            &[
                NAMES[3].split_once('/').unwrap().1,
                NAMES[4].split_once('/').unwrap().1,
            ],
        )?;
        let mut files = Vec::new();
        let mut inputs = Vec::new();
        for (i, r) in records.iter().enumerate() {
            let name = r.name.split_once('/').ok_or("path")?.1;
            let input = open_component(if i < 3 { &linux } else { &win }, name, false)?;
            let mut f = seal(&input, r.size)?;
            inputs.push(input);
            let seals = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_GET_SEALS) };
            if seals < 0 || seals & SEALS != SEALS {
                return Err("seals".into());
            }
            if f.metadata()?.len() != r.size || digest_file(&mut f)? != r.digest {
                return Err("size or digest".into());
            }
            files.push(f);
        }
        hook();
        // Check from pinned descriptors, not paths or external tools. This only
        // detects changes observable at the checks; sources must be quiescent.
        revalidate(root, &linux, &win, &inputs)?;
        exact(root, &["linux", "win"])?;
        exact(
            &linux,
            &[
                NAMES[0].split_once('/').unwrap().1,
                NAMES[1].split_once('/').unwrap().1,
                NAMES[2].split_once('/').unwrap().1,
            ],
        )?;
        exact(
            &win,
            &[
                NAMES[3].split_once('/').unwrap().1,
                NAMES[4].split_once('/').unwrap().1,
            ],
        )?;
        if apprun(&files[0])? != *reference {
            return Err("AppRun reference".into());
        }
        revalidate(root, &linux, &win, &inputs)?;
        let files: [File; 5] = files.try_into().map_err(|_| "count")?;
        consumer(&files);
        Ok(())
    }
}
#[cfg(test)]
use implementation::*;
#[cfg(test)]
mod tests;

//! DRAFT opaque-image approval; no production anchor is configured.
use ring::signature;
const DOMAIN: &[u8] = b"XJAUS-OPAQUE-APPIMAGE-APPROVAL-v1\0";
const COMMIT: &[u8] = b"80529c750da5a6bf684391333d5f4e49c574fbee";
const NAME: &[u8] = b"linux/XJAUS-1.2.3-x86_64.AppImage";
pub(super) fn approval_bytes(size: u64, digest: &[u8; 32]) -> Vec<u8> {
    let mut out = DOMAIN.to_vec();
    out.extend_from_slice(b"1.2.3");
    out.extend_from_slice(COMMIT);
    out.extend_from_slice(&(NAME.len() as u16).to_be_bytes());
    out.extend_from_slice(NAME);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(digest);
    out
}
pub(super) fn authenticate_approval(
    approval: &[u8],
    signature: &[u8],
    key: &[u8],
    manifest_key: &[u8],
    size: u64,
    digest: &[u8; 32],
) -> Result<(), &'static str> {
    if key.len() != 32 || manifest_key.len() != 32 || key == manifest_key || signature.len() != 64 {
        return Err("approval key or signature length");
    }
    if approval != approval_bytes(size, digest) {
        return Err("approval fields");
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(approval, signature)
        .map_err(|_| "approval signature")
}

const MANIFEST_DOMAIN: &[u8] = b"XJAUS-RELEASE-MANIFEST-v1\0";
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
pub(super) fn encode(records: &[Record; 5]) -> Vec<u8> {
    let mut m = MANIFEST_DOMAIN.to_vec();
    m.extend_from_slice(b"1.2.3");
    m.extend_from_slice(COMMIT);
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
    if commit.as_bytes() != COMMIT
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
    if take(m, &mut p, MANIFEST_DOMAIN.len())? != MANIFEST_DOMAIN
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

use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::fd::{AsRawFd, FromRawFd},
};
type R<T> = Result<T, Box<dyn std::error::Error>>;
const LIMIT: u64 = 512 * 1024 * 1024;
const SEALS: i32 = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
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
pub(super) fn fixed_consume(files: &[File; 5], records: &[Record; 5]) -> R<()> {
    for (file, record) in files.iter().zip(records) {
        let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
        if seals < 0 || seals & SEALS != SEALS || file.metadata()?.len() != record.size {
            return Err("consumer seals or size".into());
        }
        if digest_file(&mut file.try_clone()?)? != record.digest {
            return Err("consumer digest".into());
        }
    }
    Ok(())
}

// The key and approval inputs are internal; callers cannot select production trust.
pub(super) fn verify(
    root: &File,
    manifest: &[u8],
    manifest_signature: &[u8],
    manifest_key: &[u8],
    approval: &[u8],
    approval_signature: &[u8],
    approval_key: &[u8],
) -> R<()> {
    let records = authenticate(
        manifest,
        manifest_signature,
        manifest_key,
        std::str::from_utf8(COMMIT)?,
    )?;
    authenticate_approval(
        approval,
        approval_signature,
        approval_key,
        manifest_key,
        records[0].size,
        &records[0].digest,
    )?;
    exact(root, &["linux", "win"])?;
    let linux = open_component(root, "linux", true)?;
    let win = open_component(root, "win", true)?;
    let mut inputs = Vec::new();
    let mut files = Vec::new();
    for (i, record) in records.iter().enumerate() {
        let input = open_component(
            if i < 3 { &linux } else { &win },
            record.name.split_once('/').ok_or("path")?.1,
            false,
        )?;
        let mut sealed = seal(&input, record.size)?;
        if digest_file(&mut sealed)? != record.digest {
            return Err("digest".into());
        }
        inputs.push(input);
        files.push(sealed);
    }
    revalidate(root, &linux, &win, &inputs)?;
    // The caller retains the borrowed root; close all staging handles we own.
    drop(inputs);
    drop(linux);
    drop(win);
    let files: [File; 5] = files.try_into().map_err(|_| "count")?;
    fixed_consume(&files, &records)
}

//! XJAUS provenance only; never enumerate or delete a provider's global session list.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub version: u8,
    pub app: String,
    pub account: String,
    pub host: String,
    pub session_id: String,
    pub kind: String,
}
impl Entry {
    pub fn valid(&self) -> bool {
        self.version == 1
            && self.app == "xjaus"
            && self.kind == "cloud"
            && self.account.len() == 64
            && self.account.bytes().all(|b| b.is_ascii_hexdigit())
            && !self.session_id.is_empty()
            && self.session_id.len() <= 128
            && self
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && self.host.ends_with(".gssv-play-prod.xboxlive.com")
            && self
                .host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    }
}
pub fn root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Journal HOME unavailable")?;
    Ok(PathBuf::from(home).join(".local/state/xjaus/owned-cloud-sessions"))
}
fn private_dir(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "Cannot create XJAUS journal")?;
    let meta = fs::symlink_metadata(root).map_err(|_| "Cannot inspect journal")?;
    let home = fs::metadata(std::env::var_os("HOME").ok_or("HOME unavailable")?)
        .map_err(|_| "Cannot inspect HOME")?;
    if !meta.is_dir() || meta.uid() != home.uid() {
        return Err("Unsafe journal directory".into());
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Cannot protect journal".into())
}
pub fn lock(root: &Path) -> Result<fs::File, String> {
    private_dir(root)?;
    let path = root.join(".lock");
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if !meta.is_file()
            || meta.uid()
                != fs::metadata(root)
                    .map_err(|_| "Cannot inspect journal")?
                    .uid()
            || meta.permissions().mode() & 0o777 != 0o600
        {
            return Err("Unsafe journal lock".into());
        }
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Cannot open journal lock")?;
    file.try_lock()
        .map_err(|_| "Another XJAUS cloud session owns the journal; play blocked")?;
    Ok(file)
}
fn filename(entry: &Entry) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}.json",
        Sha256::digest(format!(
            "{}:{}:{}",
            entry.account, entry.host, entry.session_id
        ))
    )
}
pub fn save(root: &Path, entry: &Entry) -> Result<(), String> {
    if !entry.valid() {
        return Err("Invalid XJAUS journal entry".into());
    }
    private_dir(root)?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| "Cannot create journal nonce")?;
    let tmp = root.join(format!(".{}.tmp", hex::encode(random)));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|_| "Cannot create journal file")?;
        file.write_all(&serde_json::to_vec(entry).map_err(|_| "Cannot encode journal")?)
            .map_err(|_| "Cannot write journal")?;
        file.sync_all().map_err(|_| "Cannot sync journal")?;
        fs::rename(&tmp, root.join(filename(entry))).map_err(|_| "Cannot commit journal")?;
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync journal directory")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
pub fn matching(root: &Path, account: &str, host: &str) -> Result<Vec<Entry>, String> {
    private_dir(root)?;
    let uid = fs::metadata(root)
        .map_err(|_| "Cannot inspect journal")?
        .uid();
    let mut result = vec![];
    for item in fs::read_dir(root).map_err(|_| "Cannot read journal")? {
        let path = item.map_err(|_| "Cannot read journal entry")?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| "Cannot inspect journal entry")?;
        if !meta.is_file()
            || meta.uid() != uid
            || meta.permissions().mode() & 0o777 != 0o600
            || meta.len() > 2048
        {
            return Err("Unsafe XJAUS journal entry; cleanup blocked".into());
        }
        let entry: Entry =
            serde_json::from_slice(&fs::read(&path).map_err(|_| "Cannot read journal entry")?)
                .map_err(|_| "Invalid XJAUS journal; cleanup blocked")?;
        if !entry.valid()
            || path.file_name().and_then(|n| n.to_str()) != Some(filename(&entry).as_str())
        {
            return Err("Invalid journal provenance".into());
        }
        if entry.account == account && entry.host == host {
            result.push(entry);
        }
    }
    Ok(result)
}
pub fn remove(root: &Path, entry: &Entry) -> Result<(), String> {
    if !entry.valid() {
        return Err("Invalid journal removal".into());
    }
    match fs::remove_file(root.join(filename(entry))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot remove journal entry".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_reads_only_exact_account_host_and_rejects_unsafe_entries() {
        let root = std::env::temp_dir().join(format!("xjaus-journal-test-{}", std::process::id()));
        let entry = Entry {
            version: 1,
            app: "xjaus".into(),
            account: "a".repeat(64),
            host: "wus.gssv-play-prod.xboxlive.com".into(),
            session_id: "own-session".into(),
            kind: "cloud".into(),
        };
        save(&root, &entry).unwrap();
        let held = lock(&root).unwrap();
        assert!(lock(&root).is_err(), "never clean an active XJAUS instance");
        drop(held);
        assert!(lock(&root).is_ok(), "restart releases the ownership lock");
        assert_eq!(
            matching(&root, &entry.account, &entry.host).unwrap().len(),
            1
        );
        assert_eq!(
            matching(&root, &"b".repeat(64), &entry.host).unwrap().len(),
            0
        );
        assert_eq!(
            matching(&root, &entry.account, "other.gssv-play-prod.xboxlive.com")
                .unwrap()
                .len(),
            0
        );
        let file = root.join(filename(&entry));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matching(&root, &entry.account, &entry.host).is_err());
        fs::remove_dir_all(root).unwrap();
        let mut invalid = entry;
        invalid.session_id = "../foreign".into();
        assert!(!invalid.valid());
    }
}

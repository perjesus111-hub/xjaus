//! XJAUS provenance only; never enumerate or delete a provider's global session list.
use serde::{Deserialize, Serialize};

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
    crate::windows_fs::root("owned-cloud-sessions")
}
fn private_dir(root: &Path) -> Result<(), String> {
    crate::windows_fs::directory(root)
}
pub fn lock(root: &Path) -> Result<fs::File, String> {
    private_dir(root)?;
    let p = root.join(".lock");
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&p)
        .map_err(|_| "Cannot open journal lock")?;
    crate::windows_fs::protect(&p)?;
    f.try_lock()
        .map_err(|_| "Another XJAUS cloud session owns the journal; play blocked")?;
    Ok(f)
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
    crate::windows_fs::write(
        &root.join(filename(entry)),
        &serde_json::to_vec(entry).map_err(|_| "Cannot encode journal")?,
    )
}
pub fn matching(root: &Path, account: &str, host: &str) -> Result<Vec<Entry>, String> {
    private_dir(root)?;
    let mut result = vec![];
    for item in fs::read_dir(root).map_err(|_| "Cannot read journal")? {
        let path = item.map_err(|_| "Cannot read journal entry")?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let entry: Entry = serde_json::from_slice(&crate::windows_fs::read(&path, 2048)?)
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
    fn windows_owned_journal_lock_and_restart() {
        let root = crate::windows_fs::root("test-journal")
            .unwrap()
            .join(std::process::id().to_string());
        let e = Entry {
            version: 1,
            app: "xjaus".into(),
            account: "a".repeat(64),
            host: "wus.gssv-play-prod.xboxlive.com".into(),
            session_id: "test-only".into(),
            kind: "cloud".into(),
        };
        save(&root, &e).unwrap();
        save(&root, &e).unwrap();
        let held = lock(&root).unwrap();
        assert!(lock(&root).is_err());
        drop(held);
        assert_eq!(matching(&root, &e.account, &e.host).unwrap().len(), 1);
        assert!(
            matching(&root, &"b".repeat(64), &e.host)
                .unwrap()
                .is_empty()
        );
        remove(&root, &e).unwrap();
        assert!(matching(&root, &e.account, &e.host).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

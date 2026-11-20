//! Windows sessions are memory-only. Logout still removes legacy persisted data.
static SESSION_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
use crate::auth::TokenBundle;
#[cfg(test)]
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
#[cfg(test)]
use serde::{Deserialize, Serialize};
#[cfg(test)]
use zeroize::Zeroizing;

#[cfg(test)]
const MAGIC: &[u8; 8] = b"XJAUSV01";
#[cfg(test)]
#[derive(Serialize, Deserialize, Clone)]
struct Generation {
    id: String,
    key: String,
}
#[cfg(test)]
impl Drop for Generation {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.key.zeroize();
    }
}
#[cfg(test)]
#[derive(Serialize, Deserialize)]
struct Pointer {
    xjaus_vault: u8,
    current: Generation,
    previous: Option<Generation>,
}
#[cfg(test)]
fn seal(plain: &[u8], key: &[u8; 32], nonce: &[u8; 24]) -> Result<Vec<u8>, String> {
    let mut blob = Vec::with_capacity(plain.len() + 48);
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(
        &XChaCha20Poly1305::new(key.into())
            .encrypt(XNonce::from_slice(nonce), plain)
            .map_err(|_| "Vault encryption failed".to_string())?,
    );
    Ok(blob)
}
#[cfg(test)]
fn open(blob: &[u8], key: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, String> {
    if blob.len() < 48 || &blob[..8] != MAGIC {
        return Err("Invalid vault envelope".into());
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&blob[8..32]), &blob[32..])
        .map(Zeroizing::new)
        .map_err(|_| "Vault authentication failed".into())
}
#[cfg(test)]
fn pointer(bytes: &[u8]) -> Result<Option<Pointer>, String> {
    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid stored session")?;
    if v.get("xjaus_vault").is_none() {
        return Ok(None);
    }
    let p: Pointer = serde_json::from_value(v).map_err(|_| "Invalid vault pointer")?;
    if p.xjaus_vault != 1 {
        return Err("Unsupported vault pointer".into());
    }
    for g in std::iter::once(&p.current).chain(p.previous.iter()) {
        if g.id.len() != 32
            || !g.id.bytes().all(|b| b.is_ascii_hexdigit())
            || g.key.len() != 64
            || hex::decode(&g.key).is_err()
        {
            return Err("Invalid vault pointer".into());
        }
    }
    Ok(Some(p))
}
production_or_tauri! {
const SERVICE: &str = "io.github.xjaus.xjaus";
const ACCOUNT: &str = "xbox-auth-v1";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Windows Credential Manager unavailable".into())
}

fn overflow_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "xbox-auth-overflow")
        .map_err(|_| "Windows Credential Manager unavailable".into())
}
}

tauri_or_test! {
    /// Maximum Windows Credential Manager blob size (CREDENTIALW).
    pub const CRED_MAX_CREDENTIAL_BLOB_SIZE: usize = 2560;

    pub fn fits_single_credential(blob_len: usize) -> bool {
        blob_len <= CRED_MAX_CREDENTIAL_BLOB_SIZE
    }
}

#[cfg(test)]
#[path = "logout_barrier_windows.rs"]
mod logout_barrier_windows;
pub fn generation() -> Result<u64, String> {
    Ok(SESSION_GENERATION.load(std::sync::atomic::Ordering::SeqCst))
}
pub fn begin_login() -> Result<u64, String> {
    Ok(SESSION_GENERATION
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .wrapping_add(1))
}
pub fn save_if_generation(
    _bundle: &TokenBundle,
    _current: &TokenBundle,
    expected: u64,
) -> Result<(), String> {
    if generation()? != expected {
        return Err("Session invalidated by logout or another login".into());
    }
    Ok(())
}
pub fn login(_bundle: &TokenBundle, expected: u64) -> Result<(), String> {
    if generation()? != expected {
        return Err("Login invalidated by logout".into());
    }
    Ok(())
}
tauri_only! {
pub fn save(_bundle: &TokenBundle) -> Result<(), String> {
    Ok(())
}

pub fn load() -> Result<Option<TokenBundle>, String> {
    Ok(None)
}
}
#[cfg(test)]
fn load_committed<T>(
    p: &Pointer,
    read: impl FnOnce(&Generation) -> Result<T, String>,
) -> Result<T, String> {
    read(&p.current)
}

#[cfg(test)]
fn delete_with_barrier(
    barrier_result: Result<(), String>,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let deletion_result = delete();
    match (barrier_result, deletion_result) {
        (Ok(()), result) => result,
        (Err(error), Ok(())) => Err(error),
        (Err(barrier_error), Err(delete_error)) => Err(format!("{barrier_error}; {delete_error}")),
    }
}

pub fn invalidate_memory_generation() {
    SESSION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

tauri_only! {
pub fn delete() -> Result<(), String> {
    invalidate_memory_generation();
    delete_persistent()
}
}

production_or_tauri! {
pub fn delete_persistent() -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(e) = delete_raw() {
        errors.push(e);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let path =
            std::path::PathBuf::from(home).join(".local/share/io.github.xjaus.xjaus/auth.enc");
        if let Err(e) = std::fs::remove_file(path)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            errors.push(format!("Cannot remove legacy auth.enc: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn delete_raw() -> Result<(), String> {
    let mut errors = Vec::new();
    for (name, result) in [("session", entry()), ("overflow marker", overflow_entry())] {
        match result.and_then(|entry| match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(format!(
                "Cannot remove {name} from Windows Credential Manager"
            )),
        }) {
            Ok(()) => (),
            Err(e) => errors.push(e),
        }
    }
    #[cfg(windows)]
    match crate::windows_fs::root("auth") {
        Err(e) => errors.push(e),
        Ok(dir) => match std::fs::read_dir(dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => errors.push(format!("Cannot enumerate vault files: {e}")),
            Ok(items) => {
                for item in items {
                    match item {
                        Err(e) => errors.push(format!("Cannot enumerate vault files: {e}")),
                        Ok(item) => {
                            let name = item.file_name();
                            let name = name.to_string_lossy();
                            if (name == "auth-overflow.enc"
                                || (name.len() == 42
                                    && name.starts_with("vault-")
                                    && name.ends_with(".enc")
                                    && name.as_bytes()[6..38].iter().all(u8::is_ascii_hexdigit)))
                                && let Err(e) = std::fs::remove_file(item.path())
                                && e.kind() != std::io::ErrorKind::NotFound
                            {
                                errors.push(format!("Cannot remove vault file: {e}"));
                            }
                        }
                    }
                }
            }
        },
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
}

#[cfg(test)]
mod tests {
    use super::{CRED_MAX_CREDENTIAL_BLOB_SIZE, fits_single_credential};

    #[test]
    fn full_token_bundle_can_exceed_one_windows_credential() {
        // Auditoría F6: payload sintético superior al máximo debe detectarse
        // para activar la ruta de overflow en vez de fallar el login Windows.
        let bundle = serde_json::json!({
            "refresh_token": "synthetic-not-a-token".repeat(200),
            "acquired_at_unix": 0
        });
        let bytes = serde_json::to_vec(&bundle).unwrap();
        assert!(bytes.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE);
        assert!(!fits_single_credential(bytes.len()));
    }

    #[test]
    fn overflow_envelope_round_trips_and_rejects_tampering() {
        let key = [7u8; 32];
        let nonce = [9u8; 24];
        let encrypted = super::seal(b"synthetic-large-bundle", &key, &nonce).unwrap();
        assert_ne!(encrypted, b"synthetic-large-bundle");
        assert_eq!(
            &*super::open(&encrypted, &key).unwrap(),
            b"synthetic-large-bundle"
        );
        let mut damaged = encrypted.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(super::open(&damaged, &key).is_err());
    }

    #[test]
    fn pointer_retains_previous_generation_for_rollback() {
        let old = super::Generation {
            id: "a".repeat(32),
            key: "b".repeat(64),
        };
        let p = super::Pointer {
            xjaus_vault: 1,
            current: super::Generation {
                id: "c".repeat(32),
                key: "d".repeat(64),
            },
            previous: Some(old.clone()),
        };
        let encoded = serde_json::to_vec(&p).unwrap();
        assert!(super::fits_single_credential(encoded.len()));
        let parsed = super::pointer(&encoded).unwrap().unwrap();
        assert_eq!(parsed.previous.unwrap().id, old.id);
        let mut wrong: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        wrong["xjaus_vault"] = 2.into();
        assert!(super::pointer(&serde_json::to_vec(&wrong).unwrap()).is_err());
        wrong["xjaus_vault"] = 1.into();
        wrong["current"]["id"] = "../invalid".into();
        assert!(super::pointer(&serde_json::to_vec(&wrong).unwrap()).is_err());
    }

    #[test]
    fn corrupted_current_generation_must_not_restore_previous() {
        let current = super::Generation {
            id: "a".repeat(32),
            key: "11".repeat(32),
        };
        let previous = super::Generation {
            id: "b".repeat(32),
            key: "22".repeat(32),
        };
        let p = super::Pointer {
            xjaus_vault: 1,
            current,
            previous: Some(previous),
        };
        let mut damaged = super::seal(b"synthetic current", &[0x11; 32], &[3; 24]).unwrap();
        *damaged.last_mut().unwrap() ^= 1;
        let previous_blob = super::seal(b"synthetic previous", &[0x22; 32], &[4; 24]).unwrap();
        let mut reads = Vec::new();
        let result = super::load_committed(&p, |generation| {
            reads.push(generation.id.clone());
            if generation.id == p.current.id {
                super::open(&damaged, &[0x11; 32])
            } else {
                super::open(&previous_blob, &[0x22; 32])
            }
        });
        assert_eq!(result.unwrap_err(), "Vault authentication failed");
        assert_eq!(reads, vec![p.current.id.clone()]);
    }

    #[test]
    fn delete_attempts_cleanup_when_barrier_fails() {
        for (barrier, deletion, expected) in [
            (Err("guard failed"), Ok(()), Err("guard failed")),
            (Err("block failed"), Ok(()), Err("block failed")),
            (
                Err("advance failed"),
                Err("delete failed"),
                Err("advance failed; delete failed"),
            ),
            (Ok(()), Err("delete failed"), Err("delete failed")),
            (Ok(()), Ok(()), Ok(())),
        ] {
            let mut attempted = false;
            let result = super::delete_with_barrier(barrier.map_err(str::to_owned), || {
                attempted = true;
                deletion.map_err(str::to_owned)
            });
            assert!(attempted);
            assert_eq!(result, expected.map_err(str::to_owned));
        }
    }

    #[test]
    fn small_bundles_keep_the_single_credential_path() {
        // Compatibilidad: un bundle pequeño (el caso real actual) sigue por la
        // ruta de credencial única, sin archivos nuevos.
        let bundle = serde_json::json!({"refresh_token": "synthetic", "acquired_at_unix": 0});
        let bytes = serde_json::to_vec(&bundle).unwrap();
        assert!(fits_single_credential(bytes.len()));
        assert_eq!(CRED_MAX_CREDENTIAL_BLOB_SIZE, 2560);
    }
}

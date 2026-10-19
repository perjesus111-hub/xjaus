//! Windows Credential Manager holds the small authoritative commit pointer.
//! Oversized bundles are AEAD-encrypted in immutable per-generation files with
//! private Windows DACLs. Previous generation remains available for rollback.
//! Direct JSON credentials from earlier versions remain readable.
//! Native Windows save/load/replace/delete and power-loss behavior still require
//! validation on Windows; cross compilation alone cannot prove Win32 semantics.
use crate::auth::TokenBundle;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"XJAUSV01";
const MAX_FILE: u64 = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize, Clone)]
struct Generation {
    id: String,
    key: String,
}
impl Drop for Generation {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.key.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
struct Pointer {
    xjaus_vault: u8,
    current: Generation,
    previous: Option<Generation>,
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0; N];
    getrandom::getrandom(&mut b).map_err(|_| "Vault randomness unavailable".to_string())?;
    Ok(b)
}
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
fn open(blob: &[u8], key: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, String> {
    if blob.len() < 48 || &blob[..8] != MAGIC {
        return Err("Invalid vault envelope".into());
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&blob[8..32]), &blob[32..])
        .map(Zeroizing::new)
        .map_err(|_| "Vault authentication failed".into())
}
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
#[cfg(windows)]
fn generation_path(id: &str) -> Result<std::path::PathBuf, String> {
    Ok(crate::windows_fs::root("auth")?.join(format!("vault-{id}.enc")))
}
#[cfg(windows)]
fn read_generation(g: &Generation) -> Result<TokenBundle, String> {
    let key: [u8; 32] = hex::decode(&g.key)
        .map_err(|_| "Invalid vault key")?
        .try_into()
        .map_err(|_| "Invalid vault key")?;
    let blob = crate::windows_fs::read(&generation_path(&g.id)?, MAX_FILE)?;
    serde_json::from_slice(&open(&blob, &key)?).map_err(|_| "Invalid stored session".into())
}

const SERVICE: &str = "io.github.xjaus.xjaus";
const ACCOUNT: &str = "xbox-auth-v1";
/// Microsoft: CredentialBlobSize máximo por credencial (CREDENTIALW).
pub const CRED_MAX_CREDENTIAL_BLOB_SIZE: usize = 2560;

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Windows Credential Manager unavailable".into())
}

fn overflow_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "xbox-auth-overflow")
        .map_err(|_| "Windows Credential Manager unavailable".into())
}

/// true si el blob cabe en una credencial única (compatibilidad plena).
pub fn fits_single_credential(blob_len: usize) -> bool {
    blob_len <= CRED_MAX_CREDENTIAL_BLOB_SIZE
}

pub fn save(bundle: &TokenBundle) -> Result<(), String> {
    let bytes = Zeroizing::new(serde_json::to_vec(bundle).map_err(|_| "Cannot encode session")?);
    if fits_single_credential(bytes.len()) {
        return entry()?
            .set_secret(&bytes)
            .map_err(|_| "Cannot save session in Windows Credential Manager".into());
    }
    #[cfg(windows)]
    {
        if bytes.len() as u64 > MAX_FILE - 48 {
            return Err("Vault payload too large".into());
        }
        let previous = match entry()?.get_secret() {
            Ok(old) => pointer(&old)?.map(|p| p.current),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err("Cannot read Windows Credential Manager".into()),
        };
        let key = Zeroizing::new(random::<32>()?);
        let nonce = random::<24>()?;
        let id = hex::encode(random::<16>()?);
        let encrypted = seal(&bytes, &key, &nonce)?;
        let path = generation_path(&id)?;
        crate::windows_fs::write(&path, &encrypted)?;
        let p = Pointer {
            xjaus_vault: 1,
            current: Generation {
                id,
                key: hex::encode(&*key),
            },
            previous,
        };
        let marker =
            Zeroizing::new(serde_json::to_vec(&p).map_err(|_| "Cannot encode vault pointer")?);
        if !fits_single_credential(marker.len()) {
            let _ = std::fs::remove_file(&path);
            return Err("Vault pointer too large".into());
        }
        if entry()?.set_secret(&marker).is_err() {
            let _ = std::fs::remove_file(&path);
            return Err("Cannot commit Windows vault".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err("Windows vault unavailable".into())
    }
}

pub fn load() -> Result<Option<TokenBundle>, String> {
    match entry()?.get_secret() {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            if let Some(p) = pointer(&bytes)? {
                #[cfg(windows)]
                {
                    return read_generation(&p.current)
                        .or_else(|error| match p.previous {
                            Some(previous) => read_generation(&previous),
                            None => Err(error),
                        })
                        .map(Some);
                }
                #[cfg(not(windows))]
                {
                    let _ = p;
                    return Err("Windows vault unavailable".into());
                }
            }
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Stored session is invalid".into())
        }
        Err(keyring::Error::NoEntry) => {
            // Transitional overflow format written by older builds: a separate
            // marker and plaintext DACL-protected file. Read only; next save
            // migrates into the authenticated per-generation format.
            #[cfg(windows)]
            {
                match overflow_entry()?.get_secret() {
                    Ok(marker) if marker == b"overflow-file-v1" => {
                        let path = crate::windows_fs::root("auth")?.join("auth-overflow.enc");
                        let old = Zeroizing::new(crate::windows_fs::read(&path, MAX_FILE)?);
                        return serde_json::from_slice(&old)
                            .map(Some)
                            .map_err(|_| "Invalid legacy overflow vault".into());
                    }
                    Ok(_) | Err(keyring::Error::NoEntry) => (),
                    Err(_) => return Err("Cannot read legacy overflow marker".into()),
                }
            }
            Ok(None)
        }
        Err(_) => Err("Cannot read Windows Credential Manager".into()),
    }
}

pub fn delete() -> Result<(), String> {
    // Delete authority before files; partial cleanup cannot resurrect tokens.
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => (),
        Err(_) => return Err("Cannot remove session from Windows Credential Manager".into()),
    }
    #[cfg(windows)]
    {
        let dir = crate::windows_fs::root("auth")?;
        if dir.exists() {
            for item in std::fs::read_dir(dir).map_err(|_| "Cannot enumerate vault files")? {
                let item = item.map_err(|_| "Cannot enumerate vault files")?;
                let name = item.file_name();
                let name = name.to_string_lossy();
                if name == "auth-overflow.enc"
                    || (name.len() == 42
                        && name.starts_with("vault-")
                        && name.ends_with(".enc")
                        && name[6..38].bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    std::fs::remove_file(item.path()).map_err(|_| "Cannot remove vault file")?;
                }
            }
        }
        if let Ok(old) = overflow_entry() {
            match old.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err("Cannot remove old overflow marker".into()),
            }
        }
    }
    Ok(())
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
    fn small_bundles_keep_the_single_credential_path() {
        // Compatibilidad: un bundle pequeño (el caso real actual) sigue por la
        // ruta de credencial única, sin archivos nuevos.
        let bundle = serde_json::json!({"refresh_token": "synthetic", "acquired_at_unix": 0});
        let bytes = serde_json::to_vec(&bundle).unwrap();
        assert!(fits_single_credential(bytes.len()));
        assert_eq!(CRED_MAX_CREDENTIAL_BLOB_SIZE, 2560);
    }
}

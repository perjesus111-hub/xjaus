use crate::auth::TokenBundle;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::PathBuf};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "io.github.xjaus.xjaus";
const ACCOUNT: &str = "xbox-auth-v1";
const MAGIC: &[u8; 8] = b"XJAUSV01";

fn vault_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
    Ok(PathBuf::from(home).join(".local/share/io.github.xjaus.xjaus/auth.enc"))
}

/// F4: escritura atómica tmp+rename. El contrato de `OpenOptions::truncate`
/// deja el archivo a longitud cero en el open; un crash en ese instante
/// destruía la última bóveda válida. Aquí el destino final sólo se toca en el
/// rename, después de sincronizar el staging completo.
fn atomic_blob(path: &std::path::Path, blob: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("vault directory unavailable")?;
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".auth-{}.tmp", hex::encode(nonce)));
    let result = (|| {
        #[cfg(unix)]
        let file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| e.to_string())?
        };
        #[cfg(not(unix))]
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        let mut file = file;
        file.write_all(blob).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn machine_key() -> Result<[u8; 32], String> {
    // Clave derivada del entorno local del usuario: HOME + máquina + nombre de servicio.
    // Permite el respaldo local automático sin requerir frase de respaldo del usuario.
    let mut h = Sha256::new();
    h.update(b"io.github.xjaus.xjaus.vault.v1");
    if let Ok(home) = std::env::var("HOME") {
        h.update(home.as_bytes());
    }
    if let Ok(machine_id) = std::fs::read_to_string("/etc/machine-id") {
        h.update(machine_id.trim().as_bytes());
    } else if let Ok(hostname) = std::env::var("HOSTNAME") {
        h.update(hostname.as_bytes());
    }
    let result = h.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    Ok(key)
}
pub fn save(bundle: &TokenBundle) -> Result<(), String> {
    // F1: autoridad única = keyring. La indisponibilidad del Secret Service se
    // reporta (fail-closed); sin escritura silenciosa a archivo que luego pueda
    // resucitar una versión vieja. El fallback cifrado se mantiene sólo como
    // copia de reconciliación y se escribe junto al keyring cuando ambos están
    // disponibles, nunca en su lugar.
    let versioned = VersionedBundle {
        bundle_version: bundle_version_for(bundle).saturating_add(1),
        updated_at_utc: now_unix(),
        bundle: bundle.clone(),
    };
    let mut serialized = Zeroizing::new(serde_json::to_vec(&versioned).map_err(|e| e.to_string())?);
    let keyring_result = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Secret Service unavailable".to_string())
        .and_then(|entry| {
            entry
                .set_secret(&serialized)
                .map_err(|_| "Cannot persist session in Secret Service".to_string())
        });
    serialized.zeroize();
    keyring_result?;
    // Keyring OK: actualizar también el fallback cifrado (mejor esfuerzo) para
    // que la reconciliación tras reinicio tenga una copia local comparable.
    let _ = save_fallback_copy(&versioned);
    Ok(())
}
/// Versión persistida más reciente conocida: máx(keyring, fallback). Un blob
/// legacy sin envoltorio cuenta como 0. Fallos de lectura cuentan como 0.
fn bundle_version_for(bundle: &TokenBundle) -> u64 {
    let keyring_version = keyring::Entry::new(SERVICE, ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_secret().ok())
        .and_then(|bytes| serde_json::from_slice::<VersionedBundle<TokenBundle>>(&bytes).ok())
        .map(|v| v.bundle_version)
        .unwrap_or(0);
    let fallback_version = fallback_versioned_copy()
        .map(|v| v.bundle_version)
        .unwrap_or(0);
    let _ = bundle;
    keyring_version.max(fallback_version)
}
/// Copia fallback descifrada (con envoltorio versionado), si existe y es legible.
fn fallback_versioned_copy() -> Option<VersionedBundle<TokenBundle>> {
    let path = vault_path().ok()?;
    let blob = fs::read(path).ok()?;
    let plain = decrypt_fallback_blob(&blob)?;
    serde_json::from_slice(&plain).ok()
}
/// Descifra un blob XJAUSV01 (con o sin envoltorio versionado).
fn decrypt_fallback_blob(blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 48 || &blob[..8] != MAGIC {
        return None;
    }
    let key = machine_key().ok()?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(XNonce::from_slice(&blob[24..48]), &blob[48..])
        .ok()
}
/// Copia local cifrada del bundle versionado (mejor esfuerzo, jamás autoridad).
fn save_fallback_copy(versioned: &VersionedBundle<TokenBundle>) -> Result<(), String> {
    let mut serialized = serde_json::to_vec(versioned).map_err(|e| e.to_string())?;
    let key = machine_key()?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let encrypted = cipher
        .encrypt(XNonce::from_slice(&nonce), &*serialized)
        .map_err(|_| "encrypt failed".to_string())?;
    drop(serialized);
    let mut blob = Vec::with_capacity(48 + encrypted.len());
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&encrypted);
    let path = vault_path()?;
    let parent = path.parent().ok_or("vault directory unavailable")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let _ = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent);
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    // F4: nunca truncar el destino final; escribir a staging y renombrar.
    atomic_blob(&path, &blob)?;
    Ok(())
}
pub fn load() -> Result<Option<TokenBundle>, String> {
    // F1/Hallazgo1: reconciliación por versión al leer. El keyring ya no gana
    // por defecto: si el fallback local persistido es más reciente (p. ej. el
    // Secret Service estuvo caído durante una rotación), el keyring viejo se
    // descarta, se usa el nuevo y se reescribe el keyring. Un blob legacy sin
    // envoltorio cuenta como versión 0: las bóvedas existentes siguen leyéndose.
    let keyring_result = keyring::Entry::new(SERVICE, ACCOUNT).ok().map(|entry| {
        entry.get_secret().map(|mut secret| {
            let decoded = decode_persisted_bundle(&secret);
            secret.zeroize();
            decoded
        })
    });
    let keyring_versioned = match keyring_result {
        Some(Ok(decoded)) => decoded,
        Some(Err(_)) => None, // Secret Service caído: usar fallback local.
        None => None,
    };
    let fallback_versioned = fallback_versioned_copy();
    match (keyring_versioned, fallback_versioned) {
        (None, None) => {
            // Sin envoltorio en ninguna copia: puede ser una bóveda legacy
            // (pre-versionado). Delegar en la ruta legacy del fallback.
            load_legacy_or_none()
        }
        (None, Some(fallback)) => {
            // Keyring vacío o ilegible pero fallback local más reciente conocido:
            // usar el fallback y reescribir el keyring (mejor esfuerzo).
            let _ = write_keyring_versioned(&fallback);
            Ok(Some(fallback.bundle))
        }
        (Some(keyring), None) => {
            let _ = write_keyring_versioned(&keyring);
            Ok(Some(keyring.bundle))
        }
        (Some(keyring), Some(fallback)) => {
            if keyring.version_stamp() >= fallback.version_stamp() {
                Ok(Some(keyring.bundle))
            } else {
                // Hallazgo1: el keyring es MENOR que el local más reciente →
                // descartarlo, usar el nuevo y reescribir el keyring.
                let _ = write_keyring_versioned(&fallback);
                Ok(Some(fallback.bundle))
            }
        }
    }
}
/// Lee un blob del keyring: con envoltorio versionado o legacy plano.
fn decode_persisted_bundle(secret: &[u8]) -> Option<VersionedBundle<TokenBundle>> {
    if let Ok(versioned) = serde_json::from_slice::<VersionedBundle<TokenBundle>>(secret) {
        return Some(versioned);
    }
    serde_json::from_slice::<TokenBundle>(secret)
        .ok()
        .map(|bundle| VersionedBundle {
            bundle_version: 0,
            updated_at_utc: 0,
            bundle,
        })
}
/// Reescribe el keyring con un bundle versionado (mejor esfuerzo).
fn write_keyring_versioned(versioned: &VersionedBundle<TokenBundle>) -> Result<(), String> {
    let blob = serde_json::to_vec(versioned).map_err(|e| e.to_string())?;
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Secret Service unavailable".to_string())?
        .set_secret(Zeroizing::new(blob).as_slice())
        .map_err(|_| "Cannot persist session in Secret Service".to_string())
}
/// Ruta legacy: sin versiones en ninguna copia. Sigue leyendo el fallback
/// cifrado plano (comportamiento previo) para no romper bóvedas existentes.
fn load_legacy_or_none() -> Result<Option<TokenBundle>, String> {
    let path = vault_path()?;
    if !path.exists() {
        // Tampoco había keyring legible: sin sesión.
        let keyring_absent = keyring::Entry::new(SERVICE, ACCOUNT)
            .ok()
            .map(|entry| matches!(entry.get_secret(), Err(keyring::Error::NoEntry)))
            .unwrap_or(false);
        return if keyring_absent {
            Ok(None)
        } else {
            Err("Cannot read Secret Service".into())
        };
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o777
            != 0o600
        {
            return Err("fallback vault permissions are not 0600".into());
        }
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut blob = Vec::new();
    file.take(16 * 1024 * 1024)
        .read_to_end(&mut blob)
        .map_err(|e| e.to_string())?;
    if blob.len() < 48 || &blob[..8] != MAGIC {
        return Err("encrypted vault format is invalid".into());
    }
    let key = machine_key()?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher
        .decrypt(XNonce::from_slice(&blob[24..48]), &blob[48..])
        .map_err(|_| -> String { "wrong fallback vault key or damaged vault".to_string() })?;
    let result = serde_json::from_slice(&plain)
        .map(Some)
        .map_err(|e| e.to_string());
    let _ = plain;
    result
}
pub fn delete() -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Could not remove the secret from Secret Service".into()),
        }
    }
    let path = vault_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// F1/Hallazgo1: envoltorio versionado del bundle. `updated_at_utc` ordena
/// cronológicamente; `bundle_version` es un contador monótono por runner.
/// Un blob sin envoltorio (bóveda anterior al versionado) se lee como v0,
/// de modo que las bóvedas existentes siguen siendo compatibles.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct VersionedBundle<T> {
    pub bundle_version: u64,
    pub updated_at_utc: u64,
    pub bundle: T,
}
impl<T> VersionedBundle<T> {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn next(previous: Option<u64>, bundle: T) -> Self {
        Self {
            bundle_version: previous.map_or(1, |v| v.saturating_add(1)),
            updated_at_utc: now_unix(),
            bundle,
        }
    }
}
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// Interfaz del store autorizado (Secret Service / Credential Manager),
/// inyectable para probar la reconciliación sin tocar el keyring real.
#[cfg_attr(not(test), allow(dead_code))]
pub trait SecretStore {
    fn set_secret(&self, blob: &[u8]) -> Result<(), String>;
    fn get_secret(&self) -> Result<Option<Vec<u8>>, String>;
    fn delete_secret(&self) -> Result<(), String>;
}

/// Adaptador del keyring real de este módulo.
pub struct KeyringStore;
impl SecretStore for KeyringStore {
    fn set_secret(&self, blob: &[u8]) -> Result<(), String> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|_| "Secret Service unavailable".to_owned())?
            .set_secret(blob)
            .map_err(|_| "Cannot persist session in Secret Service".into())
    }
    fn get_secret(&self) -> Result<Option<Vec<u8>>, String> {
        match keyring::Entry::new(SERVICE, ACCOUNT) {
            Err(_) => Err("Secret Service unavailable".into()),
            Ok(entry) => match entry.get_secret() {
                Ok(bytes) => Ok(Some(bytes)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("Cannot read Secret Service".into()),
            },
        }
    }
    fn delete_secret(&self) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, ACCOUNT) {
            Err(_) => Err("Secret Service unavailable".into()),
            Ok(entry) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not remove the secret from Secret Service".into()),
            },
        }
    }
}

/// Persistencia fail-closed a través del store autorizado: sin escritura
/// silenciosa a archivo cuando el keyring falla (F1). El blob debe venir
/// versionado; la bóveda fallback sólo se escribe por la ruta de reconciliación.
/// (El runner Tauri usa `save`; este helper es la forma inyectable para tests.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn save_with_store<T, En>(
    store: &dyn SecretStore,
    versioned: &VersionedBundle<T>,
    encode: En,
) -> Result<(), String>
where
    En: Fn(&VersionedBundle<T>) -> Vec<u8>,
{
    let blob = encode(versioned);
    let secret = Zeroizing::new(blob);
    store.set_secret(&secret)
}

/// Metadatos de versión legibles de un blob persistido. Los blobs legacy sin
/// envoltorio cuentan como versión 0: nunca rompen bóvedas existentes.
pub trait Versioned {
    fn version_stamp(&self) -> (u64, u64);
}
impl<T> Versioned for VersionedBundle<T> {
    fn version_stamp(&self) -> (u64, u64) {
        (self.bundle_version, self.updated_at_utc)
    }
}

/// Reconciliación al cargar (F1): elige la copia más reciente entre keyring y
/// fallback comparando (bundle_version, updated_at_utc). Devuelve el ganador.
/// (Forma inyectable para tests; la ruta de producción está en `load`.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn reconcile_with_fallback<T, Dk>(
    keyring_plain: Option<Vec<u8>>,
    fallback_plain: Vec<u8>,
    decode: Dk,
) -> Result<T, String>
where
    Dk: Fn(Vec<u8>) -> Option<T>,
    T: Versioned + std::fmt::Debug,
{
    let keyring = keyring_plain.as_ref().and_then(|blob| decode(blob.clone()));
    let fallback = decode(fallback_plain);
    match (keyring, fallback) {
        (None, None) => Err("No saved session found".to_owned()),
        (Some(bundle), None) | (None, Some(bundle)) => Ok(bundle),
        (Some(keyring), Some(fallback)) => {
            if keyring.version_stamp() >= fallback.version_stamp() {
                Ok(keyring)
            } else {
                Ok(fallback)
            }
        }
    }
}

/// Sincronización al reiniciar el daemon (F1/Hallazgo1): compara el keyring
/// contra el fallback local persistido más reciente conocido; si el keyring es
/// menor, se descarta, se usa el nuevo y se reescribe el keyring.
/// Devuelve (ganador, keyring_reescrito). (Forma inyectable para tests.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn sync_secret_after_restart<T, St, Fk, Dk>(
    store: &St,
    fallback_plain: Vec<u8>,
    encode: Fk,
    decode: Dk,
) -> Result<Option<(T, bool)>, String>
where
    St: SecretStore + ?Sized,
    Fk: Fn(&T) -> Vec<u8>,
    Dk: Fn(Vec<u8>) -> Option<T>,
    T: Versioned + std::fmt::Debug,
{
    let keyring_plain = store.get_secret()?;
    let keyring = keyring_plain.and_then(|blob| decode(blob));
    let fallback = decode(fallback_plain);
    let winner = match (keyring, fallback) {
        (None, None) => return Ok(None),
        (None, Some(bundle)) => {
            // El keyring quedó vacío tras la indisponibilidad: reescribir con
            // el fallback local más reciente conocido (sin borrar el archivo
            // hasta que la escritura al store confirme).
            let blob = encode(&bundle);
            store.set_secret(&blob)?;
            return Ok(Some((bundle, true)));
        }
        (Some(bundle), None) => bundle,
        (Some(keyring), Some(fallback)) => {
            if keyring.version_stamp() >= fallback.version_stamp() {
                keyring
            } else {
                let blob = encode(&fallback);
                store.set_secret(&blob)?;
                return Ok(Some((fallback, true)));
            }
        }
    };
    Ok(Some((winner, false)))
}
#[cfg(test)]
mod tests {
    use super::{
        MAGIC, SecretStore, Versioned, VersionedBundle, atomic_blob, machine_key,
        reconcile_with_fallback, save_with_store, sync_secret_after_restart,
    };
    use chacha20poly1305::{
        XChaCha20Poly1305, XNonce,
        aead::{Aead, KeyInit},
    };
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    #[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
    struct Fixture {
        account: String,
        version: u64,
    }
    struct FixtureStore {
        available: AtomicBool,
        stored: Mutex<Option<Vec<u8>>>,
        calls: AtomicU64,
    }
    impl FixtureStore {
        fn new() -> Self {
            Self {
                available: AtomicBool::new(true),
                stored: Mutex::new(None),
                calls: AtomicU64::new(0),
            }
        }
    }
    impl SecretStore for FixtureStore {
        fn set_secret(&self, blob: &[u8]) -> Result<(), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.available.load(Ordering::SeqCst) {
                return Err("Secret Service unavailable".into());
            }
            *self.stored.lock().unwrap() = Some(blob.to_vec());
            Ok(())
        }
        fn get_secret(&self) -> Result<Option<Vec<u8>>, String> {
            if !self.available.load(Ordering::SeqCst) {
                return Err("Secret Service unavailable".into());
            }
            Ok(self.stored.lock().unwrap().clone())
        }
        fn delete_secret(&self) -> Result<(), String> {
            *self.stored.lock().unwrap() = None;
            Ok(())
        }
    }
    impl Versioned for Fixture {
        fn version_stamp(&self) -> (u64, u64) {
            (self.version, self.version)
        }
    }
    fn encode(value: &Fixture) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }
    fn decode(blob: Vec<u8>) -> Option<Fixture> {
        serde_json::from_value(serde_json::from_slice::<serde_json::Value>(&blob).ok()?).ok()
    }
    fn decode_version(blob: &[u8]) -> Option<u64> {
        let value: serde_json::Value = serde_json::from_slice(blob).ok()?;
        for key in ["version", "bundle_version"] {
            if let Some(v) = value.get(key) {
                return v.as_u64();
            }
        }
        value.get(0).and_then(|v| v.as_u64())
    }
    fn encode_version(value: &VersionedBundle<Fixture>) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    #[test]
    fn machine_key_is_deterministic() {
        let k1 = machine_key().expect("machine key derives");
        let k2 = machine_key().expect("machine key derives again");
        assert_eq!(k1, k2);
        assert_ne!(k1, [0u8; 32]);
    }

    #[test]
    fn encrypted_payload_round_trip_never_touches_real_vault() {
        let cipher = XChaCha20Poly1305::new((&machine_key().unwrap()).into());
        let nonce = XNonce::from_slice(&[7u8; 24]);
        let plain = b"synthetic-test-only";
        let encrypted = cipher.encrypt(nonce, plain.as_slice()).unwrap();
        assert_ne!(encrypted, plain);
        assert_eq!(cipher.decrypt(nonce, encrypted.as_slice()).unwrap(), plain);
        assert_eq!(MAGIC, b"XJAUSV01");
    }

    #[test]
    fn keyring_older_than_local_fallback_is_discarded_and_rewritten() {
        // F1/Hallazgo1: tras reiniciar con Secret Service recuperado, el keyring
        // contiene A(v1) mientras el fallback local tiene B(v2) más reciente.
        // La reconciliación debe descartar A y reescribir el keyring con B.
        let store = FixtureStore::new();
        store
            .set_secret(&encode(&Fixture {
                account: "account-A-fixture".into(),
                version: 1,
            }))
            .unwrap();
        let fallback = encode(&Fixture {
            account: "account-B-fixture".into(),
            version: 2,
        });
        let (winner, rewritten) =
            sync_secret_after_restart(&store, fallback.clone(), encode, decode)
                .unwrap()
                .unwrap();
        assert_eq!(winner.account, "account-B-fixture");
        assert_eq!(winner.version, 2);
        assert!(
            rewritten,
            "keyring must be rewritten with the newer local bundle"
        );
        let refreshed = store.get_secret().unwrap().unwrap();
        assert_eq!(decode_version(&refreshed), Some(2));
        assert_eq!(decode(refreshed).unwrap().account, "account-B-fixture");
    }

    #[test]
    fn regression_keyring_older_than_fallback_is_ignored() {
        // Variante exacta del A/B/recuperación de la auditoría: sin la
        // reconciliación, `load` habría devuelto account-A (stale keyring).
        let store = FixtureStore::new();
        store
            .set_secret(&encode(&Fixture {
                account: "account-A-fixture".into(),
                version: 1,
            }))
            .unwrap();
        let fallback = encode(&Fixture {
            account: "account-B-fixture".into(),
            version: 2,
        });
        let winner =
            reconcile_with_fallback(store.get_secret().unwrap(), fallback, decode).unwrap();
        assert_ne!(winner.account, "account-A-fixture");
    }

    #[test]
    fn keyring_newer_than_local_fallback_wins_without_rewrite() {
        let store = FixtureStore::new();
        store
            .set_secret(&encode(&Fixture {
                account: "account-A-fixture".into(),
                version: 5,
            }))
            .unwrap();
        let fallback = encode(&Fixture {
            account: "account-B-fixture".into(),
            version: 2,
        });
        let (winner, rewritten) =
            sync_secret_after_restart(&store, fallback.clone(), encode, decode)
                .unwrap()
                .unwrap();
        assert_eq!(winner.account, "account-A-fixture");
        assert_eq!(winner.version, 5);
        assert!(!rewritten);
        assert_eq!(
            decode_version(&store.get_secret().unwrap().unwrap()),
            Some(5)
        );
    }

    #[test]
    fn equal_versions_prefer_keyring_without_rewrite() {
        let store = FixtureStore::new();
        store
            .set_secret(&encode(&Fixture {
                account: "account-A-fixture".into(),
                version: 3,
            }))
            .unwrap();
        let fallback = encode(&Fixture {
            account: "account-B-fixture".into(),
            version: 3,
        });
        let (winner, rewritten) =
            sync_secret_after_restart(&store, fallback.clone(), encode, decode)
                .unwrap()
                .unwrap();
        assert_eq!(winner.account, "account-A-fixture");
        assert!(!rewritten);
    }

    #[test]
    fn unavailable_keyring_leaves_fallback_in_place() {
        let store = FixtureStore::new();
        store.available.store(false, Ordering::SeqCst);
        let fallback = encode(&Fixture {
            account: "account-B-fixture".into(),
            version: 2,
        });
        // Con el Secret Service caído la sincronización no puede leerlo: error.
        assert!(sync_secret_after_restart(&store, fallback.clone(), encode, decode).is_err());
        store.available.store(true, Ordering::SeqCst);
        // Al recuperarse, el keyring vacío hace que el fallback local gane y
        // se reescriba al keyring.
        let (winner, rewritten) = sync_secret_after_restart(&store, fallback, encode, decode)
            .unwrap()
            .unwrap();
        assert_eq!(winner.account, "account-B-fixture");
        assert!(
            rewritten,
            "recovered Secret Service must adopt the newer local bundle"
        );
        assert_eq!(
            decode_version(&store.get_secret().unwrap().unwrap()),
            Some(2)
        );
    }

    #[test]
    fn versioned_bundle_backward_reads_legacy_bundles() {
        // Compatibilidad: un bundle persistido antes del versionado no trae
        // wrapper; debe leerse como v0 (nunca romper bóvedas existentes).
        let legacy = encode(&Fixture {
            account: "legacy".into(),
            version: 0,
        });
        assert_eq!(decode_version(&legacy), Some(0));
        let wrapped = VersionedBundle {
            bundle_version: 7,
            updated_at_utc: 42,
            bundle: Fixture {
                account: "wrapped".into(),
                version: 7,
            },
        };
        let blob = encode_version(&wrapped);
        assert_eq!(decode_version(&blob), Some(7));
    }

    #[test]
    fn save_with_store_fails_closed_when_secret_service_unavailable() {
        // F1 corrección mínima: sin fallback silencioso a archivo en `save`;
        // la indisponibilidad del store autorizado debe reportarse.
        let store = FixtureStore::new();
        store.available.store(false, Ordering::SeqCst);
        let result = save_with_store(
            &store,
            &VersionedBundle {
                bundle_version: 1,
                updated_at_utc: 0,
                bundle: Fixture {
                    account: "x".into(),
                    version: 1,
                },
            },
            encode_version,
        );
        assert!(result.is_err());
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn save_with_store_writes_versioned_blob_through_store() {
        let store = FixtureStore::new();
        let bundle = VersionedBundle {
            bundle_version: 9,
            updated_at_utc: 1_700_000_000,
            bundle: Fixture {
                account: "current".into(),
                version: 9,
            },
        };
        save_with_store(&store, &bundle, encode_version).unwrap();
        let raw = store.get_secret().unwrap().unwrap();
        assert_eq!(decode_version(&raw), Some(9));
    }

    #[test]
    fn atomic_blob_never_truncates_the_target_before_the_write_completes() {
        // F4: el write anterior usaba OpenOptions::truncate(true) sobre el
        // destino final; un crash entre open y write dejaba la bóveda a cero.
        // El helper tmp+rename debe conservar el destino si el staging falla.
        let root = std::env::temp_dir().join(format!("xjaus-atomic-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("auth.enc");
        std::fs::write(&target, b"prior-97-bytes-fixture-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").unwrap();
        // Directorio sin permiso de escritura → el staging no puede crearse →
        // el destino original queda intacto (el defecto F4 lo habría truncado).
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).unwrap();
        }
        let result = atomic_blob(&target, b"new-blob");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(result.is_err(), "unwritable staging must abort the commit");
        assert_eq!(
            std::fs::read(&target).unwrap().len(),
            97,
            "destination must survive a failed commit"
        );
        // Escritura feliz: reemplaza atómicamente y limpia tmp.
        atomic_blob(&target, b"new-blob").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new-blob");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "staging files must not survive: {leftovers:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

use serde::{Deserialize, Serialize};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub resolution: String,
    pub bitrate: u32,
    pub codec: String,
    pub audio: String,
    #[serde(default, rename = "audioGain", skip_serializing_if = "Option::is_none")]
    pub audio_gain: Option<f64>,
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !["1280x720", "1920x1080", "2560x1440"].contains(&self.resolution.as_str())
            || !(15000..=45000).contains(&self.bitrate)
            || !["h264", "hevc", "auto"].contains(&self.codec.as_str())
            || !["opus", "default"].contains(&self.audio.as_str())
            || self
                .audio_gain
                .is_some_and(|g| !g.is_finite() || !(1.0..=1.5).contains(&g))
        {
            return Err("Ajustes no válidos".into());
        }
        Ok(())
    }
}
pub fn root() -> Result<PathBuf, String> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    config_root(
        xdg.as_deref().map(Path::new),
        home.as_deref().map(Path::new),
    )
}
fn config_root(xdg: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(x) = xdg.filter(|p| p.is_absolute()) {
        return Ok(x.join("xjaus"));
    }
    Ok(home
        .filter(|p| p.is_absolute())
        .ok_or("HOME unavailable")?
        .join(".config/xjaus"))
}
fn directory(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "No se pudo crear ajustes")?;
    let m = fs::symlink_metadata(root).map_err(|_| "Ajustes no disponibles")?;
    let owner = fs::metadata(std::env::var_os("HOME").ok_or("HOME unavailable")?)
        .map_err(|_| "HOME unavailable")?
        .uid();
    if !m.is_dir() || m.uid() != owner {
        return Err("Directorio de ajustes inseguro".into());
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Permisos de ajustes".into())
}
pub fn load_at(root: &Path) -> Result<Option<Settings>, String> {
    directory(root)?;
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x20000)
        .open(root.join("settings.json"))
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("No se pudo leer ajustes".into()),
    };
    let meta = file.metadata().map_err(|_| "No se pudo leer ajustes")?;
    if !meta.is_file()
        || meta.len() > 4096
        || meta.uid() != fs::metadata(root).map_err(|_| "Directorio inseguro")?.uid()
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err("Archivo de ajustes inseguro".into());
    }
    let mut data = String::new();
    file.take(4097)
        .read_to_string(&mut data)
        .map_err(|_| "Ajustes corruptos")?;
    let mut value: Settings = serde_json::from_str(&data).map_err(|_| "Ajustes corruptos")?;
    // Preserve valid legacy preferences while bringing the bitrate into the new UI range.
    if (1000..=50000).contains(&value.bitrate) {
        value.bitrate = value.bitrate.clamp(15000, 45000);
    }
    value.validate()?;
    Ok(Some(value))
}
pub fn save_at(root: &Path, value: &Settings) -> Result<(), String> {
    value.validate()?;
    directory(root)?;
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| "No se pudo crear ajustes")?;
    let tmp = root.join(format!(".settings-{}.tmp", hex::encode(nonce)));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|_| "No se pudo crear ajustes")?;
        f.write_all(&serde_json::to_vec(value).map_err(|_| "No se pudo codificar ajustes")?)
            .map_err(|_| "No se pudo guardar ajustes")?;
        f.sync_all().map_err(|_| "No se pudo sincronizar ajustes")?;
        fs::rename(&tmp, root.join("settings.json")).map_err(|_| "No se pudo confirmar ajustes")?;
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| "No se pudo sincronizar directorio")?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modern_settings_and_legacy_read_migration() {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let root = PathBuf::from(std::env::var_os("TMPDIR").unwrap())
            .join(format!("xjaus-modern-settings-{}", hex::encode(nonce)));
        let raw = r#"{"resolution":"2560x1440","bitrate":30000,"codec":"hevc","audio":"opus","audioGain":1.5}"#;
        let mut value: Settings = serde_json::from_str(raw).unwrap();
        save_at(&root, &value).unwrap();
        assert_eq!(load_at(&root).unwrap(), Some(value.clone()));
        value.audio_gain = Some(1.51);
        assert!(value.validate().is_err());
        value.audio_gain = Some(f64::NAN);
        assert!(value.validate().is_err());
        fs::write(root.join("settings.json"), raw.replace("30000", "12000")).unwrap();
        assert_eq!(load_at(&root).unwrap().unwrap().bitrate, 15000);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn xdg_absolute_or_home_fallback() {
        assert_eq!(
            config_root(
                Some(Path::new("/user-config")),
                Some(Path::new("/user-home"))
            )
            .unwrap(),
            PathBuf::from("/user-config/xjaus")
        );
        assert_eq!(
            config_root(Some(Path::new("relative")), Some(Path::new("/user-home"))).unwrap(),
            PathBuf::from("/user-home/.config/xjaus")
        );
        assert!(config_root(None, None).is_err());
    }
    #[test]
    fn rejects_bad_input_without_overwriting_valid_file() {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("xjaus-settings-invalid-{}", hex::encode(nonce)));
        let mut v = Settings {
            resolution: "2560x1440".into(),
            bitrate: 30000,
            codec: "h264".into(),
            audio: "opus".into(),
            audio_gain: None,
        };
        save_at(&root, &v).unwrap();
        v.bitrate = 50001;
        assert!(save_at(&root, &v).is_err());
        assert_eq!(load_at(&root).unwrap().unwrap().bitrate, 30000);
        assert!(serde_json::from_str::<Settings>(r#"{"resolution":"2560x1440","bitrate":30000,"codec":"h264","audio":"opus","path":"/untrusted"}"#).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn private_atomic_restart() {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let root = PathBuf::from(std::env::var_os("TMPDIR").expect("TMPDIR required"))
            .join(format!("xjaus-settings-test-{}", hex::encode(nonce)));
        let v = Settings {
            resolution: "2560x1440".into(),
            bitrate: 30000,
            codec: "h264".into(),
            audio: "opus".into(),
            audio_gain: None,
        };
        save_at(&root, &v).unwrap();
        assert_eq!(load_at(&root).unwrap(), Some(v));
        assert_eq!(
            fs::metadata(root.join("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::write(root.join("settings.json"), "broken").unwrap();
        assert!(load_at(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

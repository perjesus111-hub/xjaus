use serde::{Deserialize, Serialize};

use std::path::{Path, PathBuf};
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
    crate::windows_fs::root("settings")
}
pub fn load_at(root: &Path) -> Result<Option<Settings>, String> {
    crate::windows_fs::directory(root)?;
    let path = root.join("settings.json");
    if !path.exists() {
        return Ok(None);
    }
    let mut v: Settings = serde_json::from_slice(&crate::windows_fs::read(&path, 4096)?)
        .map_err(|_| "Ajustes corruptos")?;
    if (1000..=50000).contains(&v.bitrate) {
        v.bitrate = v.bitrate.clamp(15000, 45000);
    }
    v.validate()?;
    Ok(Some(v))
}
pub fn save_at(root: &Path, value: &Settings) -> Result<(), String> {
    value.validate()?;
    crate::windows_fs::write(
        &root.join("settings.json"),
        &serde_json::to_vec(value).map_err(|_| "Ajustes corruptos")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_settings_roundtrip_replace_and_validation() {
        let root = crate::windows_fs::root("test-settings")
            .unwrap()
            .join(std::process::id().to_string());
        let mut v = Settings {
            resolution: "1920x1080".into(),
            bitrate: 30000,
            codec: "h264".into(),
            audio: "opus".into(),
            audio_gain: None,
        };
        save_at(&root, &v).unwrap();
        v.bitrate = 18000;
        save_at(&root, &v).unwrap();
        assert_eq!(load_at(&root).unwrap(), Some(v.clone()));
        v.bitrate = 50001;
        assert!(save_at(&root, &v).is_err());
        assert_eq!(load_at(&root).unwrap().unwrap().bitrate, 18000);
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! Perfil Xbox (Gamertag, avatar, gamerscore) para Ajustes XJAUS.
//! Caché privada persistente por cuenta opaca (account_scope de session_journal),
//! headers no-store, telemetría mínima (contadores sin contenido) y
//! revalidación periódica del nombre visible. Nunca expone el XUID ni tokens.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileIdentity {
    pub gamertag: String,
    pub game_display_name: String,
    pub gamerscore: String,
    pub game_display_pic_raw: String,
    // Read old identity caches without ever persisting a legacy service tier again.
    #[serde(default, skip_serializing)]
    pub account_tier: String,
}

/// Hosts exactos de gamerpic; SSL verificado contra la API real.
const PIC_HOST: &str = "images-eds.xboxlive.com";
fn allowed_pic_host(host: Option<&str>) -> bool {
    matches!(host, Some(PIC_HOST) | Some("images-eds-ssl.xboxlive.com"))
}

fn setting_text(body: &Value, id: &str) -> Result<String, String> {
    let users = body
        .get("profileUsers")
        .and_then(Value::as_array)
        .ok_or("profile payload missing profileUsers")?;
    let settings = users
        .first()
        .ok_or("profile payload has no user")?
        .get("settings")
        .and_then(Value::as_array)
        .ok_or("profile payload missing settings")?;
    for setting in settings {
        if setting.get("id").and_then(Value::as_str) == Some(id) {
            return setting
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("profile setting {id} is not a string"));
        }
    }
    Err(format!("profile setting {id} missing"))
}

pub fn parse_profile_settings(body: &Value) -> Result<ProfileIdentity, String> {
    let gamertag = setting_text(body, "Gamertag")?;
    if gamertag.is_empty() || gamertag.len() > 64 {
        return Err("profile Gamertag has invalid length".into());
    }
    let pic = setting_text(body, "GameDisplayPicRaw")?;
    // Xbox devuelve http:// con frecuencia; el navegador exigía https en la CSP
    // de imágenes, así que se normaliza antes de validar.
    let pic = pic.replacen("http://", "https://", 1);
    let pic_url = url::Url::parse(&pic).map_err(|_| "profile GameDisplayPicRaw is not a URL")?;
    if pic_url.scheme() != "https" || !allowed_pic_host(pic_url.host_str()) {
        return Err("profile GameDisplayPicRaw host is not allowed".into());
    }
    let gamerscore = setting_text(body, "Gamerscore")?;
    if !gamerscore.is_empty()
        && (gamerscore.len() > 10 || !gamerscore.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("profile Gamerscore is not a digits string".into());
    }
    Ok(ProfileIdentity {
        gamertag,
        game_display_name: setting_text(body, "GameDisplayName")?,
        gamerscore,
        game_display_pic_raw: pic,
        account_tier: String::new(),
    })
}

/// Cache por cuenta opaca (account_scope). Los datos sensibles de sesión no
/// viven aquí: sólo identidad visible. TTL de revalidación del gamertag.
#[derive(Clone, Copy)]
pub struct CachePolicy {
    pub identity_ttl_secs: u64,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            identity_ttl_secs: 15 * 60,
        }
    }
}

pub struct ProfileCache {
    policy: CachePolicy,
    root: Option<PathBuf>,
    epoch: std::sync::atomic::AtomicU64,
    entry: std::sync::Mutex<Option<(String, ProfileIdentity, u64)>>,
    telemetry: std::sync::Mutex<ProfileTelemetry>,
}

#[derive(Default, Clone, Copy, Serialize)]
pub struct ProfileTelemetry {
    pub fetches: u64,
    pub cache_hits: u64,
    pub display_name_revalidations: u64,
}

/// El gamertag/display name se revalida contra Xbox aunque el resto de la
/// identidad siga viva en caché (renombres son raros pero visibles).
pub const REVALIDATE_DISPLAY_NAME_SECS: u64 = 5 * 60;

impl ProfileCache {
    pub fn new(policy: CachePolicy) -> Self {
        Self {
            policy,
            root: None,
            epoch: std::sync::atomic::AtomicU64::new(0),
            entry: std::sync::Mutex::new(None),
            telemetry: std::sync::Mutex::new(ProfileTelemetry::default()),
        }
    }

    pub fn persistent(policy: CachePolicy, root: PathBuf) -> Self {
        Self {
            root: Some(root),
            ..Self::new(policy)
        }
    }
    pub fn production() -> Self {
        match crate::windows_fs::root("profile-cache") {
            Ok(root) => Self::persistent(CachePolicy::default(), root),
            Err(_) => Self::new(CachePolicy::default()),
        }
    }
    fn path(&self, scope: &str) -> Result<Option<PathBuf>, String> {
        if scope.len() != 64 || !scope.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid opaque profile scope".into());
        }
        if let Some(root) = &self.root {
            crate::windows_fs::directory(root)?;
            Ok(Some(root.join(format!("{scope}.json"))))
        } else {
            Ok(None)
        }
    }
    pub fn clear_scope(&self, scope: &str) -> Result<(), String> {
        let mut entry = self.entry.lock().unwrap();
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *entry = None;
        if let Some(path) = self.path(scope)? {
            match fs::remove_file(path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("Cannot clear profile cache".into()),
            }
        }
        Ok(())
    }
    fn read_disk(&self, path: &Path) -> Option<(ProfileIdentity, u64)> {
        let body = crate::windows_fs::read(path, 16384).ok()?;
        let value: (ProfileIdentity, u64) = serde_json::from_slice(&body).ok()?;
        let pic = url::Url::parse(&value.0.game_display_pic_raw).ok()?;
        if pic.scheme() != "https" || !allowed_pic_host(pic.host_str()) {
            return None;
        }
        Some(value)
    }
    fn write_disk(&self, path: &Path, identity: &ProfileIdentity, now: u64) -> Result<(), String> {
        crate::windows_fs::write(
            path,
            &serde_json::to_vec(&(identity, now)).map_err(|_| "Profile cache encode")?,
        )
    }
    pub fn telemetry(&self) -> ProfileTelemetry {
        self.telemetry.lock().unwrap().clone()
    }

    /// Devuelve la identidad cacheada si sigue vigente; si expiró (o cambió de
    /// cuenta), llama a `fetch`. `now` viene del caller para tests deterministas.
    pub async fn identity<F, Fut>(
        &self,
        account_scope: &str,
        now: u64,
        fetch: F,
    ) -> Result<ProfileIdentity, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<ProfileIdentity, String>>,
    {
        let epoch = self.epoch.load(std::sync::atomic::Ordering::SeqCst);
        let path = self.path(account_scope)?;
        {
            let mut entry = self.entry.lock().unwrap();
            if epoch != self.epoch.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Profile request invalidated by logout".into());
            }
            if let Some((identity, cached_at)) = path.as_ref().and_then(|p| self.read_disk(p)) {
                if now >= cached_at
                    && now - cached_at
                        < self
                            .policy
                            .identity_ttl_secs
                            .min(REVALIDATE_DISPLAY_NAME_SECS)
                {
                    *entry = Some((account_scope.to_owned(), identity, cached_at));
                }
            }
            if let Some((account, identity, cached_at)) = entry.as_ref() {
                if account == account_scope
                    && now >= *cached_at
                    && now.saturating_sub(*cached_at)
                        < self
                            .policy
                            .identity_ttl_secs
                            .min(REVALIDATE_DISPLAY_NAME_SECS)
                {
                    self.telemetry.lock().unwrap().cache_hits += 1;
                    return Ok(identity.clone());
                }
            }
        }
        let identity = fetch().await?;
        let mut entry = self.entry.lock().unwrap();
        if epoch != self.epoch.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Profile request invalidated by logout".into());
        }
        if let Some(path) = path {
            self.write_disk(&path, &identity, now)?;
        }
        *entry = Some((account_scope.to_owned(), identity.clone(), now));
        self.telemetry.lock().unwrap().fetches += 1;
        Ok(identity)
    }
}

/// Endpoint contractual del perfil Xbox. Host fijo: la petición jamás se
/// redirige a dominios elegidos por la respuesta.
pub const PROFILE_HOST: &str = "profile.xboxlive.com";
const PROFILE_PATH: &str = "/users/me/profile/settings";
/// Contrato 2/3: lista blanca exacta de ajustes pedidos.
pub const PROFILE_SETTINGS: &str = "Gamertag,GameDisplayName,Gamerscore,GameDisplayPicRaw";

/// Construye la petición contractual sin ejecutarla (host/path/headers
/// verificables en tests y en el sidecar antes de tocar la red).
pub fn profile_request(
    web_token_uhs: &str,
    web_token_bearer: &str,
) -> Result<(String, [(String, String); 5]), String> {
    if web_token_uhs.is_empty() || web_token_bearer.is_empty() {
        return Err("profile: web_token sin uhs o Token".into());
    }
    Ok((
        format!("https://{PROFILE_HOST}{PROFILE_PATH}?settings={PROFILE_SETTINGS}"),
        [
            (
                "Authorization".into(),
                format!("XBL3.0 x={web_token_uhs};{web_token_bearer}"),
            ),
            ("x-xbl-contract-version".into(), "2".into()),
            ("Accept".into(), "application/json".into()),
            (
                "Cache-Control".into(),
                "no-store, must-revalidate, no-cache".into(),
            ),
            ("Accept-Language".into(), "es-MX".into()),
        ],
    ))
}

/// GET profile.xboxlive.com/users/me/profile/settings?settings=... con
/// Authorization XBL3.0 x=<uhs>;<bearer>. `base_override` existe sólo para
/// tests (mock HTTP local); en producción es None.
pub async fn fetch_profile(
    client: &reqwest::Client,
    web_token_uhs: &str,
    web_token_bearer: &str,
    base_override: Option<&str>,
) -> Result<ProfileIdentity, String> {
    let (url, headers) = profile_request(web_token_uhs, web_token_bearer)?;
    // Sobre el mock HTTP local se respeta el mismo path+query contractual,
    // sólo cambia el origen. En producción la URL construida es la real.
    let url = match base_override {
        Some(base) => format!(
            "{}/users/me/profile/settings?settings={PROFILE_SETTINGS}",
            base.trim_end_matches('/')
        ),
        None => url,
    };
    let mut request = client.get(&url);
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .send()
        .await
        .map_err(|_| "profile: Xbox API request failed".to_owned())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        format!(
            "profile: Xbox API returned invalid JSON (HTTP {})",
            status.as_u16()
        )
    })?;
    if !status.is_success() {
        let xerr = body.get("XErr").and_then(Value::as_i64);
        return Err(match xerr {
            Some(code) => format!("profile: Xbox API HTTP {} (XErr {code})", status.as_u16()),
            None => format!("profile: Xbox API HTTP {}", status.as_u16()),
        });
    }
    parse_profile_settings(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn subscription_is_not_legacy_account_tier_or_identity_cache_data() {
        let mut body = fixture_body("Fixture", "https://images-eds.xboxlive.com/a");
        body["profileUsers"][0]["settings"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v["id"] != "AccountTier");
        let identity = parse_profile_settings(&body).unwrap();
        assert!(
            !serde_json::to_string(&identity)
                .unwrap()
                .contains("account_tier")
        );
    }

    fn fixture_body(gamertag: &str, pic: &str) -> Value {
        json!({
            "profileUsers": [{
                "id": "0000000000000001",
                "isSponsoredUser": false,
                "settings": [
                    {"id": "Gamertag", "value": gamertag},
                    {"id": "GameDisplayName", "value": "Example Player"},
                    {"id": "Gamerscore", "value": "12345"},
                    {"id": "GameDisplayPicRaw", "value": pic},
                    {"id": "AccountTier", "value": "Gold"}
                ]
            }]
        })
    }

    #[test]
    fn logout_during_profile_fetch_cannot_repopulate_cache() {
        tauri::async_runtime::block_on(async {
            let cache = ProfileCache::new(CachePolicy::default());
            let scope = "a".repeat(64);
            let value = parse_profile_settings(&fixture_body(
                "Fixture",
                "https://images-eds.xboxlive.com/a",
            ))
            .unwrap();
            let result = cache
                .identity(&scope, 1000, || {
                    cache.clear_scope(&scope).unwrap();
                    std::future::ready(Ok(value))
                })
                .await;
            assert!(result.is_err());
            assert!(
                cache
                    .identity(&scope, 1001, || std::future::ready(Err("no entry".into())))
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn persistent_cache_survives_restart_and_clear_removes_only_scope() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("xjaus-profile-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let scope = "a".repeat(64);
            let other = "b".repeat(64);
            let cache = ProfileCache::persistent(CachePolicy::default(), root.clone());
            let value = parse_profile_settings(&fixture_body(
                "Fixture",
                "https://images-eds.xboxlive.com/a",
            ))
            .unwrap();
            cache
                .identity(&scope, 1000, || std::future::ready(Ok(value.clone())))
                .await
                .unwrap();
            cache
                .identity(&other, 1000, || std::future::ready(Ok(value.clone())))
                .await
                .unwrap();
            let cache = ProfileCache::persistent(CachePolicy::default(), root.clone());
            assert_eq!(
                cache
                    .identity(&scope, 1001, || std::future::ready(Err(
                        "must not fetch".into()
                    )))
                    .await
                    .unwrap(),
                value
            );
            assert!(
                cache
                    .identity("../escape", 1001, || std::future::ready(Ok(value.clone())))
                    .await
                    .is_err()
            );
            cache.clear_scope(&scope).unwrap();
            let cache = ProfileCache::persistent(CachePolicy::default(), root.clone());
            assert!(
                cache
                    .identity(&scope, 1002, || std::future::ready(Err("cleared".into())))
                    .await
                    .is_err()
            );
            assert!(
                cache
                    .identity(&other, 1002, || std::future::ready(Err(
                        "must not fetch".into()
                    )))
                    .await
                    .is_ok()
            );
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn parse_whitelists_fields_and_never_echoes_account_ids() {
        let pic = "https://images-eds.xboxlive.com/image?url=abc";
        let identity = parse_profile_settings(&fixture_body("ExampleConsole", pic)).unwrap();
        assert_eq!(identity.gamertag, "ExampleConsole");
        assert_eq!(identity.game_display_name, "Example Player");
        assert_eq!(identity.gamerscore, "12345");
        assert_eq!(identity.game_display_pic_raw, pic);
        assert_eq!(identity.account_tier, "");
        // Cuenta opaca: el XUID del perfil jamás cruza a la UI.
        let serialized = serde_json::to_string(&identity).unwrap();
        assert!(!serialized.contains("0000000000000001"));
        assert!(!serialized.to_lowercase().contains("xuid"));
        // Los ajustes fuera de la lista blanca no se reenvían.
        let mut body = fixture_body("ExampleConsole", pic);
        body["profileUsers"][0]["settings"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "RealName", "value": "Nombre Real Privado"}));
        let filtered = parse_profile_settings(&body).unwrap();
        assert_eq!(filtered.game_display_name, "Example Player");
        assert!(
            !serde_json::to_string(&filtered)
                .unwrap()
                .contains("Privado")
        );
    }

    #[test]
    fn real_ssl_gamerpic_host_is_supported() {
        assert!(
            parse_profile_settings(&fixture_body(
                "Fixture",
                "https://images-eds-ssl.xboxlive.com/image/a"
            ))
            .is_ok()
        );
    }

    #[test]
    fn parse_requires_gamertag_and_rejects_invalid_payloads() {
        // Sin gamertag no hay identidad que mostrar.
        let mut body = fixture_body("", "https://images-eds.xboxlive.com/a");
        assert!(parse_profile_settings(&body).is_err());
        // Estructura rota.
        assert!(parse_profile_settings(&json!({})).is_err());
        assert!(parse_profile_settings(&json!({"profileUsers": []})).is_err());
        body["profileUsers"][0]["settings"] = json!([{"id": "Gamertag"}]);
        assert!(parse_profile_settings(&body).is_err());
    }

    #[test]
    fn parse_upgrades_pic_to_https_and_rejects_foreign_hosts() {
        let upgraded = parse_profile_settings(&fixture_body(
            "ExampleConsole",
            "http://images-eds.xboxlive.com/image?url=abc",
        ))
        .unwrap();
        assert!(upgraded.game_display_pic_raw.starts_with("https://"));
        // Host ajeno: nunca se hace proxy de dominios desconocidos.
        for hostile in [
            "https://evil.invalid/pic.png",
            "http://evil.invalid/pic.png",
            "data:image/png;base64,AAAA",
            "no-es-una-url",
        ] {
            assert!(
                parse_profile_settings(&fixture_body("ExampleConsole", hostile)).is_err(),
                "pic host debe rechazarse: {hostile}"
            );
        }
        // El host real de gamerpic es el único permitido.
        assert!(
            parse_profile_settings(&fixture_body(
                "ExampleConsole",
                "https://images-eds.xboxlive.com/image?url=abc"
            ))
            .is_ok()
        );
    }

    #[test]
    fn parse_rejects_oversized_or_non_scalar_values() {
        let long_tag = "G".repeat(65);
        assert!(
            parse_profile_settings(&fixture_body(
                &long_tag,
                "https://images-eds.xboxlive.com/a"
            ))
            .is_err()
        );
        let mut body = fixture_body("ExampleConsole", "https://images-eds.xboxlive.com/a");
        body["profileUsers"][0]["settings"][2]["value"] = json!(12345);
        assert!(
            parse_profile_settings(&body).is_err(),
            "gamerscore debe ser string"
        );
        let mut score = fixture_body("ExampleConsole", "https://images-eds.xboxlive.com/a");
        score["profileUsers"][0]["settings"][2]["value"] = json!("12a45");
        assert!(
            parse_profile_settings(&score).is_err(),
            "gamerscore sólo dígitos"
        );
    }

    #[test]
    fn cache_hits_within_window_and_refetches_after_expiry_or_account_change() {
        tauri::async_runtime::block_on(async {
            let cache = ProfileCache::new(CachePolicy::default());
            let fetches = std::cell::Cell::new(0u64);
            let identity = || {
                fetches.set(fetches.get() + 1);
                std::future::ready(Ok::<_, String>(ProfileIdentity {
                    gamertag: "ExampleConsole".into(),
                    game_display_name: "Example Player".into(),
                    gamerscore: "1".into(),
                    game_display_pic_raw: "https://images-eds.xboxlive.com/a".into(),
                    account_tier: "Gold".into(),
                }))
            };
            let account = "a".repeat(64);
            let first = cache.identity(&account, 1000, identity).await.unwrap();
            assert_eq!(fetches.get(), 1);
            // Hit inmediato (299 s < 300 s de ventana): no re-consulta.
            let second = cache.identity(&account, 1299, identity).await.unwrap();
            assert_eq!(fetches.get(), 1);
            assert_eq!(first, second);
            // Pasada la ventana de revalidación, consulta de nuevo.
            let _ = cache
                .identity(&account, 1000 + REVALIDATE_DISPLAY_NAME_SECS, identity)
                .await
                .unwrap();
            assert_eq!(fetches.get(), 2);
            // Otra cuenta opaca jamás reutiliza la entrada.
            let _ = cache
                .identity(
                    &"b".repeat(64),
                    1000 + REVALIDATE_DISPLAY_NAME_SECS,
                    identity,
                )
                .await
                .unwrap();
            assert_eq!(fetches.get(), 3);
            let telemetry = cache.telemetry();
            assert_eq!(telemetry.fetches, 3);
            assert_eq!(telemetry.cache_hits, 1);
            // Telemetría mínima: contadores, sin contenido de identidad.
            let serialized = serde_json::to_string(&telemetry).unwrap();
            assert!(!serialized.contains("ExampleConsole"));
        });
    }

    #[test]
    fn fetch_failure_does_not_poison_cache() {
        tauri::async_runtime::block_on(async {
            let cache = ProfileCache::new(CachePolicy::default());
            let account = "a".repeat(64);
            let fail =
                || std::future::ready(Err::<ProfileIdentity, String>("Xbox HTTP 500".into()));
            assert!(cache.identity(&account, 1000, fail).await.is_err());
            // Un fallo no cachea nada: el reintento vuelve a consultar.
            let fetches = std::cell::Cell::new(0u64);
            let ok = || {
                fetches.set(fetches.get() + 1);
                std::future::ready(Ok::<_, String>(ProfileIdentity {
                    gamertag: "ExampleConsole".into(),
                    game_display_name: "Example Player".into(),
                    gamerscore: "1".into(),
                    game_display_pic_raw: "https://images-eds.xboxlive.com/a".into(),
                    account_tier: "Gold".into(),
                }))
            };
            assert!(cache.identity(&account, 1001, ok).await.is_ok());
            assert_eq!(fetches.get(), 1);
        });
    }

    #[test]
    fn profile_request_matches_contract_2_3_and_never_echoes_token() {
        let (url, headers) =
            profile_request("fixture-uhs", "fixture-bearer").expect("request builds");
        assert_eq!(
            url,
            "https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag,GameDisplayName,Gamerscore,GameDisplayPicRaw"
        );
        let map: std::collections::HashMap<_, _> = headers.to_vec().into_iter().collect();
        assert_eq!(
            map.get("Authorization").map(String::as_str),
            Some("XBL3.0 x=fixture-uhs;fixture-bearer")
        );
        assert_eq!(
            map.get("x-xbl-contract-version").map(String::as_str),
            Some("2")
        );
        assert_eq!(
            map.get("Accept").map(String::as_str),
            Some("application/json")
        );
        // no-store: la respuesta de perfil no se delega a cachés intermedias.
        assert_eq!(
            map.get("Cache-Control").map(String::as_str),
            Some("no-store, must-revalidate, no-cache")
        );
    }

    #[test]
    fn fetch_profile_sends_contract_headers_and_parses_identity() {
        use std::time::Duration;
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut data = Vec::new();
                let mut saw_request_head = false;
                loop {
                    let mut chunk = [0; 4096];
                    match socket.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => data.extend_from_slice(&chunk[..n]),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if saw_request_head {
                                break; // el cliente ya envió todo lo necesario
                            }
                            continue;
                        }
                        Err(error) => panic!("mock server read: {error}"),
                    }
                    let request = String::from_utf8_lossy(&data);
                    if request.contains("\r\n\r\n") {
                        saw_request_head = true;
                        // El GET no lleva cuerpo: con el head completo basta.
                        break;
                    }
                }
                let request = String::from_utf8(data).unwrap();
                let (head, _) = request.split_once("\r\n\r\n").unwrap();
                // hyper normaliza nombres de header a minúsculas en el cable.
                let head_lower = head.to_ascii_lowercase();
                assert!(
                    head.starts_with("GET /users/me/profile/settings?settings=Gamertag,GameDisplayName,Gamerscore,GameDisplayPicRaw "),
                    "contrato 2/3: ruta y ajustes exactos"
                );
                assert!(head_lower.contains("authorization: xbl3.0 x=fixture-uhs;fixture-bearer"));
                assert!(head_lower.contains("x-xbl-contract-version: 2"));
                assert!(head_lower.contains("cache-control: no-store, must-revalidate, no-cache"));
                let body = serde_json::to_string(&json!({
                    "profileUsers": [{"id": "0000000000000001", "settings": [
                        {"id": "Gamertag", "value": "ExampleConsole"},
                        {"id": "GameDisplayName", "value": "Example Player"},
                        {"id": "Gamerscore", "value": "12345"},
                        {"id": "GameDisplayPicRaw", "value": "http://images-eds.xboxlive.com/image?url=abc"},
                        {"id": "AccountTier", "value": "Gold"}
                    ]}]
                })).unwrap();
                write!(socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body).unwrap();
            });
            let identity = fetch_profile(
                &reqwest::Client::new(),
                "fixture-uhs",
                "fixture-bearer",
                Some(&base),
            )
            .await
            .expect("perfil parseado");
            server.join().unwrap();
            assert_eq!(identity.gamertag, "ExampleConsole");
            assert!(identity.game_display_pic_raw.starts_with("https://"));
        });
    }

    #[test]
    fn fetch_profile_rejects_error_status_and_bad_payloads_without_token_leaks() {
        use std::time::Duration;
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            for (status, body) in [
                ("401", r#"{"XErr":2148916233}"#),
                ("500", "Internal Server Error"),
            ] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let base = format!("http://{}", listener.local_addr().unwrap());
                let status = status.to_owned();
                let body = body.to_owned();
                let server =
                    std::thread::spawn(move || {
                        let (mut socket, _) = listener.accept().unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut buf = [0; 2048];
                        let _ = socket.read(&mut buf).unwrap();
                        write!(socket,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body).unwrap();
                    });
                let error = fetch_profile(
                    &reqwest::Client::new(),
                    "fixture-uhs",
                    "fixture-bearer",
                    Some(&base),
                )
                .await
                .expect_err("debe fallar");
                server.join().unwrap();
                // Mensaje técnico sí, credenciales jamás.
                assert!(!error.contains("fixture-bearer"));
                assert!(!error.contains("fixture-uhs"));
            }
        });
    }
}

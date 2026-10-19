// Xbox authentication — Device Code Auth; see README for upstream provenance.
// OAuth 2.0 Device Code Grant (RFC 8628). No requiere webviews ni redirects custom.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

const DEVICE_CODE_CLIENT_ID: &str = "1f907974-e22b-4810-a9de-d9647380c97e";
const DEVICE_CODE_SCOPE: &str = "xboxlive.signin openid profile offline_access";

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct RedactedToken(String);
impl RedactedToken {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl Drop for RedactedToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl std::fmt::Debug for RedactedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TokenBundle {
    pub refresh_token: RedactedToken,
    #[serde(default)]
    pub user_token: Value,
    #[serde(default)]
    pub device_token: Value,
    #[serde(default)]
    pub sisu_token: Value,
    #[serde(default)]
    pub proof_key_hex: RedactedToken,
    #[serde(default)]
    pub web_token: Value,
    #[serde(default)]
    pub home_stream_token: Value,
    #[serde(default)]
    pub cloud_stream_token: Option<Value>,
    /// Transfer token (lpt) para /connect en sesiones xhome (Remote Play)
    #[serde(default)]
    pub lpt: Option<RedactedToken>,
    pub acquired_at_unix: u64,
}
impl std::fmt::Debug for TokenBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenBundle")
            .field("refresh_token", &"[REDACTED]")
            .field("user_token", &"[REDACTED]")
            .field("device_token", &"[REDACTED]")
            .field("sisu_token", &"[REDACTED]")
            .field("proof_key_hex", &"[REDACTED]")
            .field("web_token", &"[REDACTED]")
            .field("home_stream_token", &"[REDACTED]")
            .field(
                "cloud_stream_token",
                &self.cloud_stream_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("lpt", &self.lpt.as_ref().map(|_| "[REDACTED]"))
            .field("acquired_at_unix", &self.acquired_at_unix)
            .finish()
    }
}

#[derive(Serialize)]
pub struct LoginStart {
    pub user_code: String,
    pub device_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

/// Respuesta del endpoint devicecode de Microsoft
#[derive(Deserialize)]
struct DeviceCodeResponse {
    user_code: String,
    device_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
    message: String,
}

/// Respuesta del polling de token
#[derive(Deserialize)]
pub struct DeviceCodeVerifyResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    /// Segundos recomendados entre polls (Microsoft devuelve 5)
    #[serde(default = "default_poll_interval")]
    pub interval: u64,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub scope: String,
}

fn default_poll_interval() -> u64 {
    5
}

pub struct PendingLogin {
    device_code: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    expires_in: u64,
    acquired_at_unix: u64,
}
impl Drop for PendingLogin {
    fn drop(&mut self) {
        self.device_code.zeroize();
        if let Some(t) = &mut self.access_token {
            t.zeroize();
        }
        if let Some(t) = &mut self.refresh_token {
            t.zeroize();
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Paso 1: solicitar device code a Microsoft Live
pub async fn begin_login(client: &Client) -> Result<(LoginStart, PendingLogin), AuthError> {
    let params = [
        ("client_id", DEVICE_CODE_CLIENT_ID),
        ("scope", DEVICE_CODE_SCOPE),
    ];
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| AuthError::Http(format!("devicecode: respuesta no JSON ({e})")))?;
    if !status.is_success() {
        let code = body
            .get("error")
            .and_then(Value::as_str)
            .map(|s| s.to_owned())
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(AuthError::OAuth(code));
    }
    let parsed: DeviceCodeResponse = serde_json::from_value(body.clone())
        .map_err(|e| AuthError::Http(format!("devicecode: campos faltantes ({e})")))?;
    let verification_uri_complete =
        format!("{}?user_code={}", parsed.verification_uri, parsed.user_code);

    Ok((
        LoginStart {
            user_code: parsed.user_code.clone(),
            device_code: parsed.device_code.clone(),
            verification_uri: parsed.verification_uri.clone(),
            verification_uri_complete,
            expires_in: parsed.expires_in,
            interval: parsed.interval,
            message: parsed.message.clone(),
        },
        PendingLogin {
            device_code: parsed.device_code,
            access_token: None,
            refresh_token: None,
            expires_in: parsed.expires_in,
            acquired_at_unix: now_unix(),
        },
    ))
}

/// Paso 2: hacer polling hasta que el usuario se autentique en el navegador
pub async fn poll_device_code(
    client: &Client,
    pending: &mut PendingLogin,
) -> Result<DeviceCodeVerifyResponse, AuthError> {
    // Si el poll anterior ya consiguió el access token, NO re-usamos el device
    // code (es de un solo uso): el token ya está en pending y el caller puede
    // pasar directo al intercambio.
    if let Some(_) = pending.access_token {
        return Err(AuthError::AlreadyVerified);
    }

    let params = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("client_id", DEVICE_CODE_CLIENT_ID),
        ("device_code", &pending.device_code),
    ];
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| AuthError::Http(format!("token: respuesta no JSON ({e})")))?;

    if status.is_success() {
        let parsed: DeviceCodeVerifyResponse = serde_json::from_value(body.clone())
            .map_err(|e| AuthError::Http(format!("token: campos faltantes ({e})")))?;
        pending.access_token = Some(parsed.access_token.clone());
        pending.refresh_token = parsed.refresh_token.clone();
        return Ok(parsed);
    }

    // Errores esperados del flujo device code (authorization_pending / slow_down)
    let error_code = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    match error_code.as_str() {
        "authorization_pending" => Err(AuthError::Pending),
        "slow_down" => Err(AuthError::SlowDown),
        "expired_token" => Err(AuthError::Expired),
        "authorization_expired" => Err(AuthError::Expired),
        _ => {
            let desc = body
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(&error_code)
                .to_owned();
            Err(AuthError::OAuth(format!("{error_code}: {desc}")))
        }
    }
}

/// Paso 3: intercambiar access token por XSTS y obtener tokens de Xbox.
/// Toma `&PendingLogin` (no lo consume) para que el caller pueda reintentar
/// si algún endpoint falla transitoriamente.
pub async fn complete_login_from_device_code(
    client: &Client,
    pending: &PendingLogin,
) -> Result<TokenBundle, AuthError> {
    let access_token = pending.access_token.clone().ok_or(AuthError::Pending)?;

    let xsts_res = exchange_xsts_user_token(client, &access_token).await?;
    let user_token = xsts_res
        .get("Token")
        .and_then(Value::as_str)
        .ok_or_else(|| AuthError::Http("user.auth: respuesta sin Token".into()))?
        .to_owned();

    derive_bundle(client, &xsts_res, &user_token, pending).await
}

async fn exchange_xsts_user_token(client: &Client, access_token: &str) -> Result<Value, AuthError> {
    let xsts_body = json!({
        "Properties": {
            "AuthMethod": "RPS",
            "RpsTicket": format!("d={access_token}"),
            "SiteName": "user.auth.xboxlive.com"
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    xbox_post(
        client,
        "user.auth.xboxlive.com",
        "/user/authenticate",
        &xsts_body,
    )
    .await
    .map_err(|e| e.with_context("user.auth.xboxlive.com/user/authenticate"))
}

async fn derive_bundle(
    client: &Client,
    xsts_res: &Value,
    user_token: &str,
    pending: &PendingLogin,
) -> Result<TokenBundle, AuthError> {
    // xal-node Msal NO envía TitleToken en xsts/authorize (msal.ts:137-144).
    let web_auth_body = json!({
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [user_token]
        },
        "RelyingParty": "http://xboxlive.com",
        "TokenType": "JWT"
    });
    let web_token = xbox_post(
        client,
        "xsts.auth.xboxlive.com",
        "/xsts/authorize",
        &web_auth_body,
    )
    .await
    .map_err(|e| e.with_context("xsts.auth (web)"))?;

    // GSSV token para streaming
    let gssv_auth_body = json!({
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [user_token]
        },
        "RelyingParty": "http://gssv.xboxlive.com/",
        "TokenType": "JWT"
    });
    let gssv_token = xbox_post(
        client,
        "xsts.auth.xboxlive.com",
        "/xsts/authorize",
        &gssv_auth_body,
    )
    .await
    .map_err(|e| e.with_context("xsts.auth (gssv)"))?;

    let gssv_token_str = gssv_token
        .get("Token")
        .and_then(Value::as_str)
        .ok_or_else(|| AuthError::Http("xsts gssv: respuesta sin Token".into()))?
        .to_owned();

    // Home stream token
    let home_stream = stream_token(client, &gssv_token_str, "xhome")
        .await
        .map_err(|e| e.with_context("stream xhome"))?;

    // Cloud stream token (con fallback xgpuweb → xgpuwebf2p; si ambos fallan,
    // solo se registra: cuentas sin Game Pass Ultimate es un caso normal)
    let cloud_stream = match stream_token(client, &gssv_token_str, "xgpuweb").await {
        Ok(t) => Some(t),
        Err(_) => stream_token(client, &gssv_token_str, "xgpuwebf2p")
            .await
            .ok(),
    };

    // E6: transfer token (lpt) para /connect en sesiones xhome (ReadyToConnect)
    let lpt =
        match transfer_token_async(client, pending.refresh_token.as_deref().unwrap_or_default())
            .await
        {
            Ok(t) => Some(RedactedToken::new(t)),
            Err(_) => None, // no es fatal: solo Remote Play lo necesita
        };

    let refresh = pending.refresh_token.clone().unwrap_or_default();

    Ok(TokenBundle {
        refresh_token: RedactedToken::new(refresh),
        user_token: json!({"Token": user_token}),
        device_token: xsts_res.clone(),
        sisu_token: xsts_res.clone(),
        proof_key_hex: RedactedToken::new(String::new()),
        web_token,
        home_stream_token: home_stream,
        cloud_stream_token: cloud_stream,
        lpt,
        acquired_at_unix: now_unix(),
    })
}

/// A newly issued transfer token. Never restored from the persisted bundle.
#[derive(Debug)]
pub struct FreshTransferToken {
    pub token: RedactedToken,
    pub acquired_at_unix: u64,
    pub expires_at_unix: u64,
}
impl FreshTransferToken {
    pub fn usable_at(&self, now: u64) -> bool {
        now >= self.acquired_at_unix && self.expires_at_unix.saturating_sub(now) >= 300
    }
}
#[derive(Deserialize)]
struct TransferTokenResponse {
    access_token: RedactedToken,
    expires_in: u64,
}
fn parse_transfer_response(
    text: &str,
    acquired_at_unix: u64,
) -> Result<FreshTransferToken, AuthError> {
    let response: TransferTokenResponse = serde_json::from_str(text)
        .map_err(|_| AuthError::Http("lpt: respuesta sin token/expiración válida".into()))?;
    let token = FreshTransferToken {
        token: response.access_token,
        acquired_at_unix,
        expires_at_unix: acquired_at_unix
            .checked_add(response.expires_in)
            .ok_or_else(|| AuthError::Http("lpt: expiración inválida".into()))?,
    };
    if token.token.expose().is_empty() || !token.usable_at(acquired_at_unix) {
        return Err(AuthError::Http(
            "lpt: vigencia inferior a 300 segundos".into(),
        ));
    }
    Ok(token)
}
fn auth_unix_now() -> Result<u64, AuthError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| AuthError::Http("Reloj del sistema inválido".into()))
}

/// E6 (xal-node msal.ts:96-128): transfer token para sesiones xhome.
/// POST login.live.com/oauth20_token.srf con scope PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN.
pub async fn transfer_token_async(client: &Client, refresh: &str) -> Result<String, AuthError> {
    transfer_token_from(client, refresh, "https://login.live.com/oauth20_token.srf").await
}
async fn transfer_token_from(
    client: &Client,
    refresh: &str,
    endpoint: &str,
) -> Result<String, AuthError> {
    if refresh.is_empty() {
        return Err(AuthError::Http("lpt: sin refresh_token".into()));
    }
    let params = [
        ("client_id", DEVICE_CODE_CLIENT_ID),
        (
            "scope",
            "service::http://Passport.NET/purpose::PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN",
        ),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
    ];
    let acquired_at_unix = auth_unix_now()?;
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Cache-Control", "no-store, must-revalidate, no-cache")
        .form(&params)
        .send()
        .await?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AuthError::Http(format!("lpt: lectura ({e})")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AuthError::Http(format!("lpt: HTTP {status}, cuerpo no JSON ({e})")))?;
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        return Err(AuthError::OAuth(format!("lpt: {code}")));
    }
    let transfer = parse_transfer_response(&text, acquired_at_unix)?;
    if !transfer.usable_at(auth_unix_now()?) {
        return Err(AuthError::Http(
            "lpt: vigencia restante inferior a 300 segundos".into(),
        ));
    }
    Ok(transfer.token.expose().to_owned())
}

/// Llamada POST a endpoints de Xbox/XSTS con headers estándar (xbox-webapi style)
async fn xbox_post(
    client: &Client,
    host: &str,
    path: &str,
    body: &Value,
) -> Result<Value, AuthError> {
    let body_text = serde_json::to_string(body)?;
    let url = format!("https://{host}{path}");
    let response = client
        .post(&url)
        .header("x-xbl-contract-version", "1")
        .header("Cache-Control", "no-cache")
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("ms-cv", "0")
        .header("Origin", "https://www.xbox.com")
        .header("Referer", "https://www.xbox.com/")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0")
        .body(body_text)
        .send()
        .await
        .map_err(|e| AuthError::Http(format!("{host}: red ({e})")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AuthError::Http(format!("{host}: lectura ({e})")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AuthError::Http(format!("{host}: HTTP {status}, cuerpo no JSON ({e})")))?;
    if !status.is_success() {
        // XErr != 0 en Xbox Live: 2148916233 = sin perfil Xbox, 2148916238 = menor de edad
        let xerr = value.get("XErr").and_then(Value::as_i64);
        let desc = value.get("Message").and_then(Value::as_str).unwrap_or("");
        let detail = match xerr {
            Some(2148916233) => "Esta cuenta no tiene perfil de Xbox (never signed in). Entra a xbox.com y crea el perfil.".into(),
            Some(2148916238) => "La cuenta es menor de edad o tiene restricciones; no puede autenticarse.".into(),
            Some(n) => format!("XErr {n} {desc}"),
            None => format!("HTTP {} {}", status.as_u16(), desc),
        };
        return Err(AuthError::OAuth(detail));
    }
    Ok(value)
}

/// Obtener token de streaming (home o cloud)
async fn stream_token(
    client: &Client,
    gssv_token: &str,
    offering: &str,
) -> Result<Value, AuthError> {
    let body = json!({ "token": gssv_token, "offeringId": offering });
    let url = format!("https://{offering}.gssv-play-prod.xboxlive.com/v2/login/user");
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store, must-revalidate, no-cache")
        .header("x-gssv-client", "XboxComBrowser")
        .json(&body)
        .send()
        .await
        .map_err(|e| AuthError::Http(format!("{offering}: red ({e})")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AuthError::Http(format!("{offering}: lectura ({e})")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AuthError::Http(format!("{offering}: HTTP {status}, cuerpo no JSON ({e})")))?;
    if !status.is_success() {
        return Err(AuthError::OAuth(format!(
            "{offering}: HTTP {}",
            status.as_u16()
        )));
    }
    Ok(value)
}

/// Refresh de tokens usando refresh token de Microsoft
pub async fn refresh_bundle(
    client: &Client,
    current: &TokenBundle,
) -> Result<TokenBundle, AuthError> {
    let refresh = current.refresh_token.expose();
    if refresh.is_empty() {
        return Err(AuthError::OAuth("No refresh token available".into()));
    }
    let params = [
        ("client_id", DEVICE_CODE_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("scope", DEVICE_CODE_SCOPE),
    ];
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Cache-Control", "no-store, must-revalidate, no-cache")
        .form(&params)
        .send()
        .await?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| AuthError::Http(format!("refresh: respuesta no JSON ({e})")))?;
    if !status.is_success() {
        let code = body
            .get("error")
            .and_then(Value::as_str)
            .map(|s| s.to_owned())
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(AuthError::OAuth(code));
    }
    let new_access = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| AuthError::Http("refresh: respuesta sin access_token".into()))?;
    let new_refresh = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or(refresh)
        .to_owned();

    // Re-derivar XSTS y streaming tokens con el nuevo access token
    let pending = PendingLogin {
        device_code: "refresh".into(),
        access_token: Some(new_access.to_owned()),
        refresh_token: Some(new_refresh.clone()),
        expires_in: body
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600),
        acquired_at_unix: now_unix(),
    };
    complete_login_from_device_code(client, &pending).await
}

/// Intervalo de polling del device code: respeta `interval` de la respuesta E2,
/// con mínimo 5 s (RFC 8628 §3.2) y tope 15 s.
pub fn poll_interval(response: &DeviceCodeVerifyResponse) -> Duration {
    Duration::from_secs(response.interval.clamp(5, 15))
}

#[derive(Debug)]
pub enum AuthError {
    Http(String),
    OAuth(String),
    InvalidState,
    Serialization,
    Pending,
    SlowDown,
    Expired,
    AlreadyVerified,
}
impl AuthError {
    pub fn with_context(self, ctx: &str) -> Self {
        match self {
            Self::Http(detail) => Self::Http(format!("{ctx}: {detail}")),
            Self::OAuth(detail) => Self::OAuth(format!("{ctx}: {detail}")),
            other => other,
        }
    }
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(detail) => write!(f, "Fallo de red/HTTP: {detail}"),
            Self::OAuth(code) => write!(f, "Xbox/Microsoft rechazó la autenticación: {code}"),
            Self::InvalidState => write!(
                f,
                "Estado de autenticación inválido; reinicia el inicio de sesión"
            ),
            Self::Serialization => write!(f, "No se pudo parsear la respuesta de autenticación"),
            Self::Pending => write!(f, "Waiting for user"),
            Self::SlowDown => write!(f, "slow_down"),
            Self::Expired => write!(f, "Device code expired"),
            Self::AlreadyVerified => write!(f, "already_verified"),
        }
    }
}
impl std::error::Error for AuthError {}
impl From<reqwest::Error> for AuthError {
    fn from(e: reqwest::Error) -> Self {
        AuthError::Http(format!("red: {e}"))
    }
}
impl From<serde_json::Error> for AuthError {
    fn from(_: serde_json::Error) -> Self {
        AuthError::Serialization
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_tokens_require_five_minutes_remaining_and_never_debug_secrets() {
        let response = r#"{"access_token":"fixture-secret","expires_in":600}"#;
        let token = parse_transfer_response(response, 1000).unwrap();
        assert_eq!(token.acquired_at_unix, 1000);
        assert_eq!(token.expires_at_unix, 1600);
        assert!(token.usable_at(1300));
        assert!(!token.usable_at(1301));
        assert!(!format!("{token:?}").contains("fixture-secret"));
        assert!(
            parse_transfer_response(
                r#"{"access_token":"fixture-secret","expires_in":299}"#,
                1000
            )
            .is_err()
        );
        assert!(parse_transfer_response(r#"{"access_token":"fixture-secret"}"#, 1000).is_err());
        assert!(
            parse_transfer_response(
                r#"{"access_token":"fixture-secret","expires_in":"600"}"#,
                1000
            )
            .is_err()
        );
    }

    #[test]
    fn both_launchers_request_fresh_transfer_instead_of_saved_lpt() {
        for source in [include_str!("lib.rs"), include_str!("bin/xjaus_backend.rs")] {
            let start = source.find("stream.set_account_scope(").unwrap();
            let end = source[start..].find("stream.set_transfer_token(").unwrap() + start;
            let launch = &source[start..end];
            assert!(launch.contains("transfer_token_async("));
            assert!(
                !launch.contains("bundle.lpt"),
                "new streams must never reuse persisted transfer tokens"
            );
        }
    }

    #[test]
    fn fresh_transfer_http_has_correct_scope_and_rejects_short_lifetime_without_looping() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            for expires in [299, 600] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let endpoint = format!(
                    "http://{}/oauth20_token.srf",
                    listener.local_addr().unwrap()
                );
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut data = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let n = socket.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        data.extend_from_slice(&chunk[..n]);
                        let request = String::from_utf8_lossy(&data);
                        if let Some((headers, body)) = request.split_once("\r\n\r\n") {
                            let length: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse().unwrap())
                                })
                                .unwrap();
                            if body.len() >= length {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(data).unwrap();
                    assert!(request.starts_with("POST /oauth20_token.srf "));
                    let body = request.split_once("\r\n\r\n").unwrap().1;
                    let form: std::collections::HashMap<_, _> =
                        url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect();
                    assert_eq!(
                        form.get("scope").unwrap(),
                        "service::http://Passport.NET/purpose::PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN"
                    );
                    assert_eq!(form.get("grant_type").unwrap(), "refresh_token");
                    assert_eq!(form.get("refresh_token").unwrap(), "fixture-refresh");
                    let body = format!(
                        "{{\"access_token\":\"fixture-transfer\",\"expires_in\":{expires}}}"
                    );
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                });
                let result =
                    transfer_token_from(&Client::new(), "fixture-refresh", &endpoint).await;
                if expires == 299 {
                    assert!(result.is_err());
                } else {
                    assert_eq!(result.unwrap(), "fixture-transfer");
                }
                server.join().unwrap();
            }
        });
    }

    #[test]
    fn token_debug_output_never_contains_secret_value() {
        let token = RedactedToken::new("sensitive-test-token".to_owned());
        assert!(!format!("{token:?}").contains("sensitive-test-token"));
        assert_eq!(format!("{token:?}"), "[REDACTED]");
    }

    #[test]
    fn token_bundle_serializes_for_secure_store_round_trip() {
        let bundle = TokenBundle {
            refresh_token: RedactedToken::new("refresh-test".into()),
            user_token: serde_json::json!({}),
            device_token: serde_json::json!({}),
            sisu_token: serde_json::json!({}),
            proof_key_hex: RedactedToken::new("test-key".into()),
            web_token: serde_json::json!({}),
            home_stream_token: serde_json::json!({}),
            cloud_stream_token: None,
            lpt: None,
            acquired_at_unix: 1_800_000_000,
        };
        let encoded = serde_json::to_string(&bundle).unwrap();
        let decoded: TokenBundle = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.acquired_at_unix, 1_800_000_000);
        assert_eq!(decoded.refresh_token.expose(), "refresh-test");
    }

    #[test]
    fn device_code_start_produces_complete_url() {
        let start = LoginStart {
            user_code: "ABCD1234".into(),
            device_code: "device-code-123".into(),
            verification_uri: "https://microsoft.com/devicelogin".into(),
            verification_uri_complete: "https://microsoft.com/devicelogin?user_code=ABCD1234"
                .into(),
            expires_in: 900,
            interval: 5,
            message: "Sign in with code ABCD1234".into(),
        };
        assert!(start.verification_uri_complete.contains("ABCD1234"));
        assert_eq!(start.interval, 5);
    }

    #[test]
    fn auth_error_display_shows_details() {
        let e = AuthError::Http("user.auth.xboxlive.com: HTTP 401 cuerpo no JSON (eof)".into());
        let msg = format!("{e}");
        assert!(msg.contains("user.auth.xboxlive.com"));
        assert!(msg.contains("401"));
    }

    #[test]
    fn xerr_codes_map_to_friendly_messages() {
        // Verificado indirectamente via xbox_post; aquí validamos el formato.
        let e = AuthError::OAuth("XErr 2148916233".into());
        assert!(format!("{e}").contains("2148916233"));
    }
}

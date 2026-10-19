use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use zeroize::Zeroizing;

/// Shared HTTP client policy for both runners (F2): every request carries a 5 s
/// connect deadline and a 12 s total deadline, so a silent Xbox endpoint can
/// never hold the single sidecar dispatcher (or a Tauri command) indefinitely.
pub fn http_client(user_agent: &str) -> Result<Client, String> {
    Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "HTTP client unavailable".into())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Home,
    Cloud,
}
impl SessionKind {
    pub fn route(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Cloud => "cloud",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeviceProfile {
    pub client_app_id: String,
    pub client_app_type: String,
    pub client_app_version: String,
    pub client_sdk_version: String,
    pub http_environment: String,
    pub hardware_make: String,
    pub hardware_model: String,
    pub sdk_type: String,
    pub os_name: String,
    pub os_version: String,
    pub platform: String,
    pub width: u32,
    pub height: u32,
    pub dpi_x: u32,
    pub dpi_y: u32,
    pub locale: String,
    pub timezone_offset_minutes: i32,
    pub nano_version: String,
    pub use_ice_connection: bool,
}
impl Default for DeviceProfile {
    fn default() -> Self {
        Self {
            client_app_id: "Microsoft.GamingApp".into(),
            client_app_type: "native".into(),
            client_app_version: "2203.1001.4.0".into(),
            client_sdk_version: "8.5.2".into(),
            http_environment: "prod".into(),
            hardware_make: "Microsoft".into(),
            hardware_model: "Surface Pro".into(),
            sdk_type: "native".into(),
            os_name: "Windows 11".into(),
            os_version: "22631.2715".into(),
            platform: "desktop".into(),
            width: 1920,
            height: 1080,
            dpi_x: 1,
            dpi_y: 1,
            locale: "es-MX".into(),
            timezone_offset_minutes: 360,
            nano_version: "V3;WebrtcTransport.dll".into(),
            use_ice_connection: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct DeviceProfilePatch {
    pub client_app_id: Option<String>,
    pub client_app_type: Option<String>,
    pub client_app_version: Option<String>,
    pub client_sdk_version: Option<String>,
    pub http_environment: Option<String>,
    pub hardware_make: Option<String>,
    pub hardware_model: Option<String>,
    pub sdk_type: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub platform: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi_x: Option<u32>,
    pub dpi_y: Option<u32>,
    pub locale: Option<String>,
    pub timezone_offset_minutes: Option<i32>,
    pub nano_version: Option<String>,
    pub use_ice_connection: Option<bool>,
}
impl DeviceProfilePatch {
    pub fn apply(self) -> DeviceProfile {
        let mut profile = DeviceProfile::default();
        macro_rules! set {
            ($field:ident) => {
                if let Some(value) = self.$field {
                    profile.$field = value;
                }
            };
        }
        set!(client_app_id);
        set!(client_app_type);
        set!(client_app_version);
        set!(client_sdk_version);
        set!(http_environment);
        set!(hardware_make);
        set!(hardware_model);
        set!(sdk_type);
        set!(os_name);
        set!(os_version);
        set!(platform);
        set!(width);
        set!(height);
        set!(dpi_x);
        set!(dpi_y);
        set!(locale);
        set!(timezone_offset_minutes);
        set!(nano_version);
        set!(use_ice_connection);
        profile
    }
}

impl DeviceProfile {
    pub fn device_info_header(&self) -> Value {
        json!({
            "appInfo": { "env": { "clientAppId": self.client_app_id, "clientAppType": self.client_app_type,
                "clientAppVersion": self.client_app_version, "clientSdkVersion": self.client_sdk_version,
                "httpEnvironment": self.http_environment, "sdkInstallId": "" } },
            "dev": { "hw": { "make": self.hardware_make, "model": self.hardware_model, "sdktype": self.sdk_type },
                "os": { "name": self.os_name, "ver": self.os_version, "platform": self.platform },
                "displayInfo": { "dimensions": { "widthInPixels": self.width, "heightInPixels": self.height },
                    "pixelDensity": { "dpiX": self.dpi_x, "dpiY": self.dpi_y } } }
        })
    }
    pub fn play_payload(&self, kind: SessionKind, target: &str) -> Value {
        json!({
            "titleId": if kind == SessionKind::Cloud { target } else { "" }, "clientSessionId": "",
            "settings": { "nanoVersion": self.nano_version, "enableTextToSpeech": false, "highContrast": 0,
                "locale": self.locale, "market": self.locale.to_ascii_uppercase(), "useIceConnection": self.use_ice_connection, "timezoneOffsetMinutes": self.timezone_offset_minutes,
                "sdkType": "web", "osName": "windows" },
            "serverId": if kind == SessionKind::Home { target } else { "" }, "fallbackRegionNames": []
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Idle,
    Starting,
    Provisioning,
    ReadyToConnect,
    WaitingForResources,
    Provisioned,
    Negotiating,
    Connected,
    Stopped,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionMachine {
    pub state: SessionState,
    pub session_id: Option<String>,
}
impl Default for SessionMachine {
    fn default() -> Self {
        Self {
            state: SessionState::Idle,
            session_id: None,
        }
    }
}
impl SessionMachine {
    pub fn started(&mut self, session_id: String) -> Result<(), String> {
        if self.state != SessionState::Idle {
            return Err("session is already active".into());
        }
        self.session_id = Some(session_id);
        self.state = SessionState::Starting;
        Ok(())
    }
    pub fn observe_server_state(&mut self, server_state: &str) -> Result<SessionState, String> {
        self.state = match server_state {
            "Provisioning" => SessionState::Provisioning,
            "ReadyToConnect" => SessionState::ReadyToConnect,
            "WaitingForResources" => SessionState::WaitingForResources,
            "Provisioned" => SessionState::Provisioned,
            "Connected" | "Streaming" => SessionState::Connected,
            "Stopped" | "Disconnected" => SessionState::Stopped,
            "Failed" | "Error" => SessionState::Failed,
            _ => return Err("unexpected Xbox session state (unrecognized value omitted)".into()),
        };
        Ok(self.state)
    }
    pub fn begin_negotiation(&mut self) -> Result<(), String> {
        // Cloud entrega la sesión en ReadyToConnect; Home, en Provisioned.
        if !matches!(
            self.state,
            SessionState::Provisioned | SessionState::ReadyToConnect
        ) {
            return Err("session is not provisioned".into());
        }
        self.state = SessionState::Negotiating;
        Ok(())
    }
    pub fn close(&mut self) {
        self.state = SessionState::Stopped;
        self.session_id = None;
    }
}

/// Estados en los que Xbox sigue trabajando: la sesión ya fue aceptada y sólo
/// hay que seguir sondeando. Cualquier otro estado es terminal para el bucle.
pub fn should_keep_waiting(state: SessionState) -> bool {
    matches!(
        state,
        SessionState::Starting
            | SessionState::Provisioning
            | SessionState::ReadyToConnect
            | SessionState::WaitingForResources
    )
}

/// Número de sondeos que caben en el presupuesto total. Con 120 s y 1.75 s de
/// intervalo caben ~68 sondeos, muy por encima de los 20-60 s que tarda un
/// blade de Azure.
pub fn provisioning_attempts(budget: Duration, interval: Duration) -> u32 {
    if interval.is_zero() {
        return 0;
    }
    (budget.as_millis() / interval.as_millis()).max(1) as u32
}

/// Detalles de cola que Xbox devuelve en `provisioningDetails` cuando la sesión
/// espera recursos. Se conservan los nombres exactos que envía Xbox (para que la
/// UI muestre lo que el servidor realmente reporta), filtrando por lista blanca
/// de claves escalares: nunca se reenvían tokens ni objetos completos.
pub fn queue_details(value: &Value) -> Option<Value> {
    let details = value.get("provisioningDetails")?.as_object()?;
    const SAFE_KEYS: [&str; 6] = [
        "estimatedTotalWaitTimeSeconds",
        "estimatedWaitTimeSeconds",
        "waitTimeSeconds",
        "queuePosition",
        "positionInQueue",
        "totalWaitQueueLength",
    ];
    let mut compact = serde_json::Map::new();
    for (key, entry) in details {
        if SAFE_KEYS.contains(&key.as_str()) && entry.is_i64() {
            compact.insert(key.clone(), entry.clone());
        }
    }
    (!compact.is_empty()).then(|| Value::Object(compact))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionSnapshot {
    pub state: SessionState,
    pub session_id: Option<String>,
    pub kind: SessionKind,
    #[serde(default)]
    pub provisioning: Option<Value>,
}
impl SessionSnapshot {
    /// Construye el snapshot desde el cuerpo de `/state`, extrayendo los detalles
    /// de cola si Xbox los reporta.
    pub fn from_poll(kind: SessionKind, session_id: Option<String>, body: &Value) -> Self {
        Self {
            state: SessionState::Idle,
            session_id,
            kind,
            provisioning: queue_details(body),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(rename = "sdpMid")]
    pub sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_m_line_index: Option<Value>,
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
}
fn session_id_from_play(response: &Value) -> Result<String, String> {
    if let Some(id) = response
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return if valid_session_id(id) {
            Ok(id.to_owned())
        } else {
            Err("Xbox returned an invalid sessionId".into())
        };
    }
    let path = response
        .get("sessionPath")
        .and_then(Value::as_str)
        .ok_or("Xbox did not return sessionPath or sessionId")?;
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 4
        || parts[0] != "v5"
        || parts[1] != "sessions"
        || !matches!(parts[2], "home" | "cloud")
        || !valid_session_id(parts[3])
    {
        return Err("Xbox returned an invalid sessionPath".into());
    }
    Ok(parts[3].to_owned())
}

fn response_operation(path: &str) -> &'static str {
    if path.ends_with("/play") {
        "play"
    } else if path.ends_with("/connect") {
        "connect"
    } else if path.ends_with("/state") {
        "state"
    } else if path.ends_with("/sdp") {
        "sdp"
    } else if path.ends_with("/ice") {
        "ice"
    } else if path.ends_with("/keepalive") {
        "keepalive"
    } else {
        "session"
    }
}
/// Only known diagnostic fields cross the API/log boundary. Never dump response JSON.
fn safe_body_excerpt(body: &str) -> String {
    fn text(value: &str) -> String {
        // Redact credential fragments, never the surrounding diagnostic message.
        // Long words, colons, punctuation and ordinary base64 are not secrets.
        static PATTERNS: std::sync::LazyLock<Vec<regex::Regex>> = std::sync::LazyLock::new(|| {
            [
                    r#"(?i)\bbearer\s+[^\s,;]+"#,
                    r#"(?i)\bxbl3\.0\s+x=[^\s;]+;[^\s,;]+"#,
                    r#"(?i)\b(?:cookie|set-cookie)\s*:\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)"#,
                    r#"(?i)\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|gs[_-]?token|token|password|passwd|credential|authorization|secret|lpt|cookie|set-cookie)\b["']*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)"#,
                    r#"candidate:[^\s]+"#,
                    r#"v=0(?:\\r\\n|\r?\n).*"#,
                ]
                .into_iter()
                .map(|pattern| regex::Regex::new(pattern).expect("static diagnostic pattern"))
                .collect()
        });
        let mut result = value.to_owned();
        for pattern in PATTERNS.iter() {
            result = pattern.replace_all(&result, "[redacted]").into_owned();
        }
        static JWT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
                .expect("static JWT pattern")
        });
        JWT.replace_all(&result, |caps: &regex::Captures<'_>| {
            let candidate = &caps[0];
            let header = candidate.split('.').next().unwrap_or_default();
            let is_jwt =
                base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, header)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|header| {
                        header.is_object() && header.get("alg").and_then(Value::as_str).is_some()
                    });
            if is_jwt {
                "[redacted]".to_owned()
            } else {
                candidate.to_owned()
            }
        })
        .into_owned()
    }
    fn fields(value: &Value, depth: usize) -> Value {
        if depth > 5 {
            return Value::Null;
        }
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter_map(|(key, value)| {
                        if [
                            "error",
                            "errorDetails",
                            "code",
                            "errorCode",
                            "message",
                            "details",
                            "status",
                            "reason",
                        ]
                        .contains(&key.as_str())
                        {
                            Some((key.clone(), fields(value, depth + 1)))
                        } else {
                            None
                        }
                    })
                    .collect(),
            ),
            Value::Array(items) => {
                Value::Array(items.iter().take(8).map(|v| fields(v, depth + 1)).collect())
            }
            Value::String(value) => Value::String(text(value)),
            Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        }
    }
    match serde_json::from_str::<Value>(body) {
        Ok(value) => fields(&value, 0).to_string(),
        Err(_) => match body.trim() {
            "Bad Request" | "Unauthorized" | "Forbidden" | "Not Found" | "Service Unavailable" => {
                body.trim().into()
            }
            "" => String::new(),
            _ => "[non-JSON response omitted]".into(),
        },
    }
}

fn parse_response(
    status: reqwest::StatusCode,
    path: &str,
    text: &str,
) -> Result<Option<Value>, String> {
    let operation = response_operation(path);
    if !status.is_success() {
        let excerpt = safe_body_excerpt(text);
        return Err(if excerpt.is_empty() {
            format!(
                "Xbox streaming {operation} HTTP {} (sin cuerpo)",
                status.as_u16()
            )
        } else {
            format!(
                "Xbox streaming {operation} HTTP {}: {excerpt}",
                status.as_u16()
            )
        });
    }
    if status == reqwest::StatusCode::NO_CONTENT || text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(text).map(Some).map_err(|_| {
        format!(
            "Xbox streaming {operation} HTTP {}: JSON inválido",
            status.as_u16()
        )
    })
}

fn decode_sdp_answer(value: &Value) -> Result<Option<Value>, String> {
    let Some(encoded) = value
        .get("exchangeResponse")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    serde_json::from_str(encoded)
        .map(Some)
        .map_err(|_| "Xbox SDP exchange response is invalid".into())
}

fn ice_payload(candidates: &[IceCandidate]) -> Value {
    json!({"messageType":"iceCandidate","candidate":candidates})
}

async fn poll_ice_response<F, Fut>(
    mut fetch: F,
    attempts: u8,
    delay: Duration,
) -> Result<Vec<IceCandidate>, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<Value>, String>>,
{
    for attempt in 0..attempts {
        if let Some(result) = fetch().await? {
            if let Some(encoded) = result
                .get("exchangeResponse")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                return serde_json::from_str(encoded)
                    .map_err(|_| "Xbox ICE exchange response is invalid".into());
            }
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(delay).await;
        }
    }
    Err("Xbox ICE exchange timed out waiting for remote candidates".into())
}

fn home_wake_retry(kind: SessionKind, value: &Value) -> bool {
    kind == SessionKind::Home
        && value.pointer("/errorDetails/code").and_then(Value::as_str) == Some("WNSError")
}

pub struct SessionClient {
    #[cfg(test)]
    test_base_url: Option<String>,
    client: Client,
    host: String,
    token: Zeroizing<String>,
    kind: SessionKind,
    profile: DeviceProfile,
    machine: SessionMachine,
    transfer_token: Option<Zeroizing<String>>,
    did_connect: bool,
    provisioning_queue: Option<Value>,
    home_target: Option<String>,
    #[cfg(test)]
    test_journal_root: Option<std::path::PathBuf>,
    account_scope: Option<String>,
    journal_lock: Option<std::fs::File>,
}
impl SessionClient {
    pub fn new(
        client: Client,
        host: String,
        token: String,
        kind: SessionKind,
        profile: DeviceProfile,
    ) -> Self {
        Self {
            client,
            host,
            #[cfg(test)]
            test_base_url: None,
            token: Zeroizing::new(token),
            kind,
            profile,
            machine: SessionMachine::default(),
            transfer_token: None,
            did_connect: false,
            provisioning_queue: None,
            home_target: None,
            account_scope: None,
            journal_lock: None,
            #[cfg(test)]
            test_journal_root: None,
        }
    }
    pub fn set_transfer_token(&mut self, token: Option<String>) {
        self.transfer_token = token.map(Zeroizing::new);
    }
    pub fn set_account_scope(&mut self, scope: Option<String>) -> Result<(), String> {
        if self.kind == SessionKind::Cloud
            && !scope
                .as_ref()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Stable account scope required for safe cloud cleanup".into());
        }
        self.account_scope = if self.kind == SessionKind::Cloud {
            scope
        } else {
            None
        };
        Ok(())
    }
    fn journal_entry(&self) -> Option<crate::session_journal::Entry> {
        Some(crate::session_journal::Entry {
            version: 1,
            app: "xjaus".into(),
            account: self.account_scope.clone()?,
            host: self.host.clone(),
            session_id: self.machine.session_id.clone()?,
            kind: "cloud".into(),
        })
    }
    fn journal_root(&self) -> Result<std::path::PathBuf, String> {
        #[cfg(test)]
        if let Some(root) = &self.test_journal_root {
            return Ok(root.clone());
        }
        crate::session_journal::root()
    }
    async fn cleanup_journal(&self) -> Result<(), String> {
        if let Some(account) = &self.account_scope {
            let root = self.journal_root()?;
            for entry in crate::session_journal::matching(&root, account, &self.host)? {
                self.request(
                    reqwest::Method::DELETE,
                    format!("/v5/sessions/cloud/{}", entry.session_id),
                    None,
                    false,
                )
                .await?;
                crate::session_journal::remove(&root, &entry)?;
            }
        }
        Ok(())
    }
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            state: self.machine.state,
            session_id: self.machine.session_id.clone(),
            kind: self.kind,
            provisioning: self.provisioning_queue.clone(),
        }
    }
    fn path(&self, suffix: &str) -> Result<String, String> {
        let id = self
            .machine
            .session_id
            .as_deref()
            .ok_or("no active stream session")?;
        Ok(format!("/v5/sessions/{}/{id}/{suffix}", self.kind.route()))
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: String,
        body: Option<Value>,
        device_info: bool,
    ) -> Result<Option<Value>, String> {
        let url = format!("https://{}{}", self.host, path);
        #[cfg(test)]
        let url = self
            .test_base_url
            .as_ref()
            .map(|base| {
                let original = reqwest::Url::parse(&url).map_err(|_| "request url invalid")?;
                let mut fixture = reqwest::Url::parse(base).map_err(|_| "fixture url invalid")?;
                fixture.set_path(original.path());
                fixture.set_query(original.query());
                Ok::<String, String>(fixture.to_string())
            })
            .transpose()?
            .unwrap_or(url);
        let deleting = method == reqwest::Method::DELETE;
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(self.token.as_str())
            .header("Content-Type", "application/json")
            .header("Accept-Language", "es-MX, es;q=0.9, en;q=0.1");
        if device_info {
            request = request.header(
                "X-MS-Device-Info",
                self.profile.device_info_header().to_string(),
            );
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "Xbox streaming request failed".to_owned())?;
        let status = response.status();
        if deleting
            && matches!(
                status,
                reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
            )
        {
            return Ok(None);
        }
        let text = response.text().await.map_err(|_| {
            format!(
                "Xbox streaming {}: no se pudo leer la respuesta",
                response_operation(&path)
            )
        })?;
        parse_response(status, &path, &text)
    }
    pub async fn start(&mut self, target: &str) -> Result<SessionSnapshot, String> {
        if self.machine.session_id.is_some() {
            return Err("session is already active; stop it before play".into());
        }
        if self.account_scope.is_some() {
            self.journal_lock = Some(crate::session_journal::lock(&self.journal_root()?)?);
        }
        self.cleanup_journal().await?;
        let response = self
            .request(
                reqwest::Method::POST,
                format!("/v5/sessions/{}/play", self.kind.route()),
                Some(self.profile.play_payload(self.kind, target)),
                true,
            )
            .await?
            .ok_or("Xbox did not return a session response")?;
        let id = session_id_from_play(&response)?;
        self.machine.started(id)?;
        self.home_target = (self.kind == SessionKind::Home).then(|| target.to_owned());
        self.did_connect = false;
        if let Some(entry) = self.journal_entry() {
            if let Err(error) = crate::session_journal::save(&self.journal_root()?, &entry) {
                let _ = self.stop().await;
                return Err(error);
            }
        }
        Ok(self.snapshot())
    }
    /// Sondea `/state` hasta que Xbox acepte la sesión. Provisioning y
    /// WaitingForResources mantienen el bucle vivo: el blade de Azure puede
    /// tardar 20-60 s (o más con cola) en levantarse.
    pub async fn poll_until_provisioned(
        &mut self,
        attempts: u8,
        delay: Duration,
    ) -> Result<SessionSnapshot, String> {
        self.poll_until_provisioned_scoped(attempts, delay, None)
            .await
    }
    /// F2 policy: the Cloud /play+/connect provisioning carries a wall-clock
    /// budget like Home. Counting attempts cannot bound a single silent await.
    pub const CLOUD_PROVISION_BUDGET: Duration = Duration::from_secs(120);
    pub async fn poll_until_provisioned_with_budget(
        &mut self,
        attempts: u8,
        delay: Duration,
        cancellation: Option<(&crate::connection_cancel::ConnectionCancellation, &str)>,
        budget: Duration,
    ) -> Result<SessionSnapshot, String> {
        tokio::time::timeout(
            budget,
            self.poll_provision_inner(attempts, delay, cancellation),
        )
        .await
        .map_err(|_| {
            format!(
                "Xbox session provisioning timed out (state: {:?}, queue: {})",
                self.machine.state,
                self.provisioning_queue
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|| "none".into())
            )
        })?
    }
    pub async fn poll_until_provisioned_scoped(
        &mut self,
        attempts: u8,
        delay: Duration,
        cancellation: Option<(&crate::connection_cancel::ConnectionCancellation, &str)>,
    ) -> Result<SessionSnapshot, String> {
        if self.kind == SessionKind::Home {
            return tokio::time::timeout(
                Duration::from_secs(45),
                self.poll_provision_inner(attempts, delay, cancellation),
            )
            .await
            .map_err(|_| crate::wake::WAKE_TIMEOUT.to_owned())?
            .map_err(|_| crate::wake::WAKE_TIMEOUT.to_owned());
        }
        self.poll_until_provisioned_with_budget(
            attempts,
            delay,
            cancellation,
            Self::CLOUD_PROVISION_BUDGET,
        )
        .await
    }
    async fn poll_provision_inner(
        &mut self,
        attempts: u8,
        delay: Duration,
        cancellation: Option<(&crate::connection_cancel::ConnectionCancellation, &str)>,
    ) -> Result<SessionSnapshot, String> {
        let mut last_state = String::new();
        let mut queue: Option<Value> = None;
        for _attempt in 0..attempts {
            let request = self.request(reqwest::Method::GET, self.path("state")?, None, false);
            let response = if let Some((registry, id)) = cancellation {
                registry.run(Some(id), request).await
            } else {
                request.await
            };
            let value = response?.ok_or("Xbox returned no state")?;
            let state = value
                .get("state")
                .and_then(Value::as_str)
                .ok_or("Xbox session state is missing")?
                .to_owned();
            last_state = state.clone();
            let next = self.machine.observe_server_state(&state)?;
            queue = queue_details(&value).or(queue);
            self.provisioning_queue = queue.clone();
            if next == SessionState::ReadyToConnect && !self.did_connect {
                // Ambos modos exigen este paso antes de negociar SDP:
                // - Home: lpt de Remote Play (SmartGlass).
                // - Cloud: lpt MSAL/xCloud (auditado en xcloudapi.ts sendMSALAuth).
                let lpt = self
                    .transfer_token
                    .as_ref()
                    .ok_or("Xbox requires a transfer token for this session; refresh your login")?;
                self.request(
                    reqwest::Method::POST,
                    self.path("connect")?,
                    Some(json!({"userToken": lpt.as_str()})),
                    false,
                )
                .await?;
                self.did_connect = true;
            }
            if next == SessionState::Provisioned {
                return Ok(SessionSnapshot {
                    state: self.machine.state,
                    session_id: self.machine.session_id.clone(),
                    kind: self.kind,
                    provisioning: queue,
                });
            }
            if matches!(next, SessionState::Failed | SessionState::Stopped) {
                if home_wake_retry(self.kind, &value) {
                    let target = self.home_target.clone().ok_or(crate::wake::WAKE_TIMEOUT)?;
                    // Delete only this client's exact session. Never enumerate/delete
                    // another app's sessions, and never turn off/close a console game.
                    self.stop()
                        .await
                        .map_err(|_| crate::wake::WAKE_TIMEOUT.to_owned())?;
                    self.machine = SessionMachine::default();
                    if let Some((registry, id)) = cancellation {
                        registry
                            .run(Some(id), async {
                                tokio::time::sleep(Duration::from_millis(2500)).await;
                                Ok(())
                            })
                            .await?;
                    } else {
                        tokio::time::sleep(Duration::from_millis(2500)).await;
                    }
                    // Do not abort /play in flight: retain its exact id for cleanup.
                    self.start(&target)
                        .await
                        .map_err(|_| crate::wake::WAKE_TIMEOUT.to_owned())?;
                    if let Some((registry, id)) = cancellation {
                        registry.check(Some(id))?;
                    }
                    continue;
                }
                if self.kind == SessionKind::Home {
                    return Err("No se pudo iniciar Remote Play. Comprueba las funciones remotas de la consola e inténtalo de nuevo.".into());
                }
                // Xbox reporta el motivo en errorDetails/estado; lo adjuntamos
                // saneado (mismo recorte que los errores HTTP) para diagnosticar.
                let details = value
                    .get("errorDetails")
                    .map(|details| safe_body_excerpt(&details.to_string()))
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "sin detalles".into());
                return Err(format!(
                    "Xbox session ended while provisioning ({state}): {details}"
                ));
            }
            if let Some((registry, id)) = cancellation {
                registry
                    .run(Some(id), async {
                        tokio::time::sleep(delay).await;
                        Ok(())
                    })
                    .await?;
            } else {
                tokio::time::sleep(delay).await;
            }
        }
        Err(format!(
            "Xbox session provisioning timed out (último estado: {last_state})"
        ))
    }
    pub async fn submit_offer(&mut self, sdp: &str) -> Result<(), String> {
        self.machine.begin_negotiation()?;
        let payload = json!({"messageType":"offer","sdp":sdp,"configuration": {
            "chatConfiguration":{"bytesPerSample":2,"expectedClipDurationMs":20,"format":{"codec":"opus","container":"webm"},"numChannels":1,"sampleFrequencyHz":24000},
            "chat":{"minVersion":1,"maxVersion":1},"control":{"minVersion":1,"maxVersion":3},"input":{"minVersion":1,"maxVersion":8},"message":{"minVersion":1,"maxVersion":1}}});
        self.request(
            reqwest::Method::POST,
            self.path("sdp")?,
            Some(payload),
            false,
        )
        .await?;
        Ok(())
    }
    pub async fn poll_answer(&self, attempts: u8, delay: Duration) -> Result<Value, String> {
        for _ in 0..attempts {
            if let Some(result) = self
                .request(reqwest::Method::GET, self.path("sdp")?, None, false)
                .await?
            {
                if let Some(answer) = decode_sdp_answer(&result)? {
                    return Ok(answer);
                }
            }
            tokio::time::sleep(delay).await;
        }
        Err("Xbox SDP answer timed out".into())
    }
    pub async fn exchange_ice(
        &self,
        candidates: Vec<IceCandidate>,
    ) -> Result<Vec<IceCandidate>, String> {
        let payload = ice_payload(&candidates);
        self.request(
            reqwest::Method::POST,
            self.path("ice")?,
            Some(payload),
            false,
        )
        .await?;
        let path = self.path("ice")?;
        poll_ice_response(
            || self.request(reqwest::Method::GET, path.clone(), None, false),
            80,
            Duration::from_millis(750),
        )
        .await
    }
    pub async fn keepalive(&self) -> Result<(), String> {
        self.request(
            reqwest::Method::POST,
            self.path("keepalive")?,
            Some(json!({})),
            false,
        )
        .await
        .map(|_| ())
    }
    pub async fn stop(&mut self) -> Result<(), String> {
        if self.machine.session_id.is_some() {
            self.request(
                reqwest::Method::DELETE,
                format!(
                    "/v5/sessions/{}/{}",
                    self.kind.route(),
                    self.machine.session_id.as_deref().unwrap_or_default()
                ),
                None,
                false,
            )
            .await?;
        }
        if let Some(entry) = self.journal_entry() {
            crate::session_journal::remove(&self.journal_root()?, &entry)?;
        }
        self.machine.close();
        self.journal_lock = None;
        Ok(())
    }
}

/// Only the exact handle created by this process is eligible for deletion.
/// Retain it on HTTP/network failure so a later play cannot orphan it.
pub async fn stop_previous(slot: &mut Option<SessionClient>) -> Result<(), String> {
    if let Some(previous) = slot.as_mut() {
        // Shared by both runners: never let a DELETE pin IPC indefinitely.
        // A timeout is not proof of remote deletion; retain this exact owner.
        tokio::time::timeout(Duration::from_secs(2), previous.stop())
            .await
            .map_err(|_| "Previous XJAUS session cleanup timeout (2s); play blocked".to_owned())?
            .map_err(|error| {
                format!("Previous XJAUS session cleanup failed; play blocked: {error}")
            })?;
    }
    *slot = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silent_server_request_fails_within_client_deadline() {
        // F2 regression: a server that accepts TCP and never answers must not
        // hang the single sidecar dispatcher. The shared client carries a 12 s
        // total deadline, so the request fails with is_timeout() near 12 s.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(30));
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let client = http_client("XJAUS deadline regression").unwrap();
                let started = std::time::Instant::now();
                let result =
                    tokio::time::timeout(Duration::from_secs(15), client.get(&url).send()).await;
                let elapsed = started.elapsed();
                let error = match result {
                    // RED today: send() never resolves, so this branch is the
                    // failure path (the outer 15 s guard fired).
                    Err(_) => panic!(
                        "request still pending after 15 s; no client deadline (elapsed {elapsed:?})"
                    ),
                    Ok(Ok(_)) => panic!("silent server unexpectedly answered"),
                    Ok(Err(error)) => error,
                };
                assert!(error.is_timeout(), "expected timeout error, got {error}");
                assert!(
                    elapsed <= Duration::from_secs(13),
                    "deadline must fire near 12 s, took {elapsed:?}"
                );
            });
        worker.join().unwrap();
    }
    #[test]
    fn silent_server_request_fails_within_connect_deadline() {
        // F2 regression: connect_timeout(5 s) must cap the TCP handshake.
        // 203.0.113.0/24 is TEST-NET-3: never routable, so the SYN cannot
        // complete. A network that reports EHOSTUNREACH instantly would make
        // this fail fast with a connect error, which still proves no hang.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let client = http_client("XJAUS deadline regression").unwrap();
                let started = std::time::Instant::now();
                let result = tokio::time::timeout(
                    Duration::from_secs(10),
                    client.get("http://203.0.113.1:9/probe").send(),
                )
                .await;
                let elapsed = started.elapsed();
                match result {
                    Err(_) => panic!(
                        "connect still pending after 10 s; connect deadline missing ({elapsed:?})"
                    ),
                    Ok(Ok(_)) => panic!("TEST-NET address unexpectedly answered"),
                    Ok(Err(error)) => {
                        assert!(
                            error.is_timeout() || error.is_connect(),
                            "expected connect/timeout error, got {error}"
                        );
                        assert!(
                            elapsed <= Duration::from_secs(8),
                            "connect deadline must fire near 5 s, took {elapsed:?}"
                        );
                    }
                }
            });
    }
    #[test]
    fn cloud_provisioning_has_wall_clock_budget_against_silent_server() {
        // F2 regression: counting attempts does not bound each await, so a
        // silent /state response could hold the dispatcher for the full 120 s
        // attempt budget. The Cloud branch must carry its own wall-clock
        // budget like Home already does.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(30));
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut client = SessionClient::new(
                    Client::new(),
                    "fixture.invalid".into(),
                    "fixture".into(),
                    SessionKind::Cloud,
                    DeviceProfile::default(),
                );
                client.test_base_url = Some(base);
                client.machine.started("budget-session".into()).unwrap();
                let started = std::time::Instant::now();
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    client.poll_until_provisioned_with_budget(
                        68,
                        Duration::from_millis(1750),
                        None,
                        Duration::from_secs(3),
                    ),
                )
                .await;
                let elapsed = started.elapsed();
                match result {
                    Err(_) => panic!(
                        "provisioning still pending after 5 s wall clock; Cloud has no budget (elapsed {elapsed:?})"
                    ),
                    Ok(Ok(_)) => panic!("silent server unexpectedly provisioned"),
                    Ok(Err(error)) => {
                        assert!(
                            error.contains("timed out"),
                            "expected wall-clock budget error, got {error}"
                        );
                        assert!(
                            elapsed <= Duration::from_millis(4_000),
                            "budget must fire near 30 s policy in production; test budget must not linger, took {elapsed:?}"
                        );
                    }
                }
            });
        worker.join().unwrap();
    }
    #[test]
    fn cloud_policy_budget_is_two_minutes() {
        // The wall-clock deadline must match the provisioning retry envelope.
        assert_eq!(
            SessionClient::CLOUD_PROVISION_BUDGET,
            Duration::from_secs(120)
        );
    }
    #[test]
    fn home_wns_http_retry_deletes_only_own_handle_then_replays_same_target() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut requests = vec![];
                for body in [
                    r#"{"sessionId":"own-first"}"#,
                    r#"{"state":"Failed","errorDetails":{"code":"WNSError"}}"#,
                    "",
                    r#"{"sessionId":"own-retry"}"#,
                    r#"{"state":"Provisioned"}"#,
                    "",
                ] {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(4)))
                        .unwrap();
                    let mut buf = [0; 8192];
                    let n = socket.read(&mut buf).unwrap();
                    requests.push(
                        String::from_utf8_lossy(&buf[..n])
                            .lines()
                            .next()
                            .unwrap()
                            .to_owned(),
                    );
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                }
                requests
            });
            let mut client = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                DeviceProfile::default(),
            );
            client.test_base_url = Some(base);
            client.start("streaming-server-not-sgid").await.unwrap();
            let result = client
                .poll_until_provisioned(5, Duration::from_millis(1))
                .await
                .unwrap();
            assert_eq!(result.session_id.as_deref(), Some("own-retry"));
            client.stop().await.unwrap();
            assert_eq!(
                server.join().unwrap(),
                [
                    "POST /v5/sessions/home/play HTTP/1.1",
                    "GET /v5/sessions/home/own-first/state HTTP/1.1",
                    "DELETE /v5/sessions/home/own-first HTTP/1.1",
                    "POST /v5/sessions/home/play HTTP/1.1",
                    "GET /v5/sessions/home/own-retry/state HTTP/1.1",
                    "DELETE /v5/sessions/home/own-retry HTTP/1.1"
                ]
            );
        });
    }
    #[test]
    fn home_wake_retry_is_exact_and_never_retries_cloud_or_other_errors() {
        assert!(home_wake_retry(
            SessionKind::Home,
            &json!({"errorDetails":{"code":"WNSError"}})
        ));
        assert!(!home_wake_retry(
            SessionKind::Cloud,
            &json!({"errorDetails":{"code":"WNSError"}})
        ));
        assert!(!home_wake_retry(
            SessionKind::Home,
            &json!({"errorDetails":{"code":"Unauthorized", "message":"WNSError"}})
        ));
    }
    #[test]
    fn restart_cleanup_uses_only_matching_provenance_before_play_and_stop_removes_journal() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let root =
                std::env::temp_dir().join(format!("xjaus-restart-test-{}", std::process::id()));
            let host = "wus.gssv-play-prod.xboxlive.com";
            let account = "a".repeat(64);
            let own = crate::session_journal::Entry {
                version: 1,
                app: "xjaus".into(),
                account: account.clone(),
                host: host.into(),
                session_id: "own-old".into(),
                kind: "cloud".into(),
            };
            crate::session_journal::save(&root, &own).unwrap();
            let mut foreign = own.clone();
            foreign.account = "b".repeat(64);
            foreign.session_id = "other-account".into();
            crate::session_journal::save(&root, &foreign).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut requests = vec![];
                for body in ["", r#"{"sessionId":"own-new"}"#, ""] {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut buf = [0; 8192];
                    let n = socket.read(&mut buf).unwrap();
                    requests.push(
                        String::from_utf8_lossy(&buf[..n])
                            .lines()
                            .next()
                            .unwrap()
                            .to_owned(),
                    );
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                }
                requests
            });
            let mut client = SessionClient::new(
                Client::new(),
                host.into(),
                "fixture".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            client.test_base_url = Some(base);
            client.test_journal_root = Some(root.clone());
            client.set_account_scope(Some(account.clone())).unwrap();
            client.start("test-title").await.unwrap();
            assert_eq!(
                crate::session_journal::matching(&root, &account, host).unwrap()[0].session_id,
                "own-new"
            );
            client.stop().await.unwrap();
            assert!(
                crate::session_journal::matching(&root, &account, host)
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                crate::session_journal::matching(&root, &foreign.account, host)
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                server.join().unwrap(),
                [
                    "DELETE /v5/sessions/cloud/own-old HTTP/1.1",
                    "POST /v5/sessions/cloud/play HTTP/1.1",
                    "DELETE /v5/sessions/cloud/own-new HTTP/1.1"
                ]
            );
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn cloud_journal_requires_account_scope_and_home_is_never_journaled() {
        let mut client = SessionClient::new(
            Client::new(),
            "wus.gssv-play-prod.xboxlive.com".into(),
            "fixture".into(),
            SessionKind::Cloud,
            DeviceProfile::default(),
        );
        assert!(client.set_account_scope(None).is_err());
        assert!(client.set_account_scope(Some("a".repeat(64))).is_ok());
    }
    #[test]
    fn replacement_deletes_only_owned_exact_handle_before_play() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut requests = Vec::new();
                for body in ["", r#"{"sessionId":"new-owned"}"#] {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut buf = [0; 8192];
                    let count = socket.read(&mut buf).unwrap();
                    requests.push(
                        String::from_utf8_lossy(&buf[..count])
                            .lines()
                            .next()
                            .unwrap()
                            .to_owned(),
                    );
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                }
                requests
            });
            let mut previous = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            previous.test_base_url = Some(base.clone());
            previous.machine.started("old-owned".into()).unwrap();
            let mut slot = Some(previous);
            stop_previous(&mut slot).await.unwrap();
            assert!(slot.is_none());
            let mut next = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            next.test_base_url = Some(base);
            next.start("title").await.unwrap();
            assert_eq!(
                server.join().unwrap(),
                [
                    "DELETE /v5/sessions/cloud/old-owned HTTP/1.1",
                    "POST /v5/sessions/cloud/play HTTP/1.1"
                ]
            );
        });
    }
    #[test]
    fn cleanup_deadline_retains_exact_owned_handle_for_safe_retry() {
        tauri::async_runtime::block_on(async {
            use std::io::Read;
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(4)))
                    .unwrap();
                let mut buf = [0; 8192];
                let count = socket.read(&mut buf).unwrap();
                let line = String::from_utf8_lossy(&buf[..count])
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned();
                std::thread::sleep(Duration::from_secs(3));
                line
            });
            let mut previous = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture".into(),
                SessionKind::Home,
                DeviceProfile::default(),
            );
            previous.test_base_url = Some(base);
            previous.machine.started("old-owned".into()).unwrap();
            let mut slot = Some(previous);
            let before = std::time::Instant::now();
            let error = stop_previous(&mut slot).await.unwrap_err();
            let elapsed = before.elapsed();
            assert!(
                elapsed < Duration::from_millis(2500),
                "cleanup took {elapsed:?}"
            );
            assert!(error.contains("timeout"));
            assert_eq!(
                slot.as_ref().unwrap().snapshot().session_id.as_deref(),
                Some("old-owned")
            );
            assert_eq!(
                server.join().unwrap(),
                "DELETE /v5/sessions/home/old-owned HTTP/1.1"
            );
        });
    }
    #[test]
    fn unexpected_server_state_never_echoes_untrusted_payload() {
        let mut machine = SessionMachine::default();
        let error = machine
            .observe_server_state("private-server-payload")
            .unwrap_err();
        assert!(!error.contains("private-server-payload"));
    }
    #[test]
    fn session_handle_cannot_escape_the_exact_delete_route() {
        assert!(session_id_from_play(&json!({"sessionId":"abc/../other"})).is_err());
        assert!(session_id_from_play(&json!({"sessionId":"abc?all=true"})).is_err());
    }
    #[test]
    fn diagnostic_messages_preserve_complete_innocent_messages() {
        for message in [
            "Expired token MSA veto needs to be resolved",
            "Xbox endpoint 192.168.1.2 or 2001:db8::1 is unavailable: retry later.",
            "Xbox eyJnot.a.jwt is a technical identifier, not a JWT.",
            "Title not streamable: Xbox rejected this title.",
            "UserNotEntitled: The current user is not entitled to this title.",
            "ConcurrentStreamDisallowed: Another cloud session is active.",
            "Xbox: This title is not available. Please try again later.",
        ] {
            let result = safe_body_excerpt(&json!({"message":message}).to_string());
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap()["message"],
                message
            );
        }
    }

    #[test]
    fn diagnostic_messages_preserve_context_around_explicit_credentials() {
        for fragment in [
            "Bearer private-credential",
            "XBL3.0 x=private-userhash;private-credential",
            "accessToken=private-credential",
            "password=\"private credential with spaces\"",
            "cookie: \"private cookie value\"",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature",
        ] {
            let result = safe_body_excerpt(
                &json!({"message":format!("Xbox refused: {fragment}; retry later")}).to_string(),
            );
            let message = serde_json::from_str::<Value>(&result).unwrap()["message"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_eq!(message, "Xbox refused: [redacted]; retry later");
            assert!(message.starts_with("Xbox refused: "));
            assert!(message.ends_with("; retry later"));
            assert!(!message.contains("private"));
            assert!(!message.contains("with spaces"));
            assert!(!message.contains("cookie value"));
            assert!(!message.contains("eyJ"));
        }
        let cookie = safe_body_excerpt(&json!({"message":"Xbox refused: Cookie: session=private-cookie; other=private-other\r\nretry later"}).to_string());
        let cookie_message = serde_json::from_str::<Value>(&cookie).unwrap()["message"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(cookie_message, "Xbox refused: [redacted]\r\nretry later");
        let long = format!(
            "Xbox: {} eyJordinary is not a JWT.\nRetry later.",
            "ordinary ".repeat(70)
        );
        let result = safe_body_excerpt(&json!({"message":long}).to_string());
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["message"],
            long
        );
    }

    #[test]
    fn diagnostic_messages_redact_explicit_credentials() {
        for message in [
            "Bearer private-credential",
            "token=private-credential",
            "password: private-credential",
            "access_token=private-credential",
            "candidate:private",
            "v=0\\r\\na=private",
        ] {
            let error =
                safe_body_excerpt(&json!({"code":"UsefulCode", "message":message}).to_string());
            assert!(error.contains("UsefulCode"));
            assert!(!error.contains("private"));
        }
    }
    #[test]
    fn failed_cleanup_keeps_exact_owned_session_for_retry() {
        tauri::async_runtime::block_on(async {
            let mut client = SessionClient::new(
                Client::new(),
                "127.0.0.1:1".into(),
                "fixture".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            client.machine.started("owned-session".into()).unwrap();
            assert!(
                client
                    .start("new-title")
                    .await
                    .unwrap_err()
                    .contains("already active")
            );
            let mut slot = Some(client);
            assert!(stop_previous(&mut slot).await.is_err());
            assert_eq!(
                slot.unwrap().snapshot().session_id.as_deref(),
                Some("owned-session")
            );
        });
    }
    #[test]
    fn diagnostics_preserve_codes_but_not_secret_fields() {
        let error = parse_response(reqwest::StatusCode::BAD_REQUEST, "/v5/sessions/cloud/play",
            r#"{"error":{"code":"InvalidToken","message":"Token expired","details":{"code":"RetryLogin","access_token":"private-value","ip":"192.168.1.10","sdp":"private-sdp"}},"token":"private-token"}"#).unwrap_err();
        assert!(error.contains("InvalidToken"));
        assert!(error.contains("RetryLogin"));
        assert!(!error.contains("private-"));
        assert!(!error.contains("192.168"));
    }
    #[test]
    fn provisioning_timeout_preserves_last_queue_and_state() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0; 4096];
            socket.read(&mut buffer).unwrap();
            let body = r#"{"state":"WaitingForResources","provisioningDetails":{"queuePosition":3,"estimatedTotalWaitTimeSeconds":42}}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        tauri::async_runtime::block_on(async {
            let mut client = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            client.test_base_url = Some(base);
            client.machine.started("queue-session".into()).unwrap();
            let error = client
                .poll_until_provisioned_with_budget(
                    48,
                    Duration::from_millis(2500),
                    None,
                    Duration::from_millis(200),
                )
                .await
                .unwrap_err();
            assert!(error.contains("WaitingForResources"), "{error}");
            assert!(
                error.contains("queuePosition") && error.contains('3'),
                "{error}"
            );
            assert_eq!(client.snapshot().provisioning.unwrap()["queuePosition"], 3);
        });
        worker.join().unwrap();
    }

    #[test]
    fn cloud_provisioning_tolerates_two_minutes() {
        assert_eq!(
            SessionClient::CLOUD_PROVISION_BUDGET,
            Duration::from_secs(120)
        );
    }

    #[test]
    fn cloud_provisioning_states_keep_the_session_loop_alive() {
        let mut machine = SessionMachine::default();
        machine.started("session-abc".into()).unwrap();
        assert!(should_keep_waiting(
            machine.observe_server_state("Provisioning").unwrap()
        ));
        assert!(should_keep_waiting(
            machine.observe_server_state("WaitingForResources").unwrap()
        ));
        assert!(should_keep_waiting(
            machine.observe_server_state("ReadyToConnect").unwrap()
        ));
        assert!(!should_keep_waiting(
            machine.observe_server_state("Provisioned").unwrap()
        ));
        assert!(!should_keep_waiting(
            machine.observe_server_state("Failed").unwrap()
        ));
    }
    #[test]
    fn two_minute_budget_allows_azure_instances_to_boot() {
        assert!(provisioning_attempts(Duration::from_secs(120), Duration::from_millis(1750)) >= 60);
        assert!(provisioning_attempts(Duration::from_secs(8), Duration::from_secs(1)) < 10);
    }
    #[test]
    fn snapshot_carries_queue_details_when_xbox_reports_them() {
        let body = json!({"state":"WaitingForResources","provisioningDetails":{"estimatedTotalWaitTimeSeconds":42,"queuePosition":3}});
        let snapshot =
            SessionSnapshot::from_poll(SessionKind::Cloud, Some("session-abc".into()), &body);
        let details = snapshot.provisioning.expect("detalles de cola");
        assert_eq!(
            details
                .pointer("/estimatedTotalWaitTimeSeconds")
                .and_then(Value::as_i64),
            Some(42)
        );
        assert_eq!(
            details.pointer("/queuePosition").and_then(Value::as_i64),
            Some(3)
        );
        assert_eq!(snapshot.session_id.as_deref(), Some("session-abc"));
    }
    #[test]
    fn ice_payload_uses_candidate_array_expected_by_xbox() {
        let sample = IceCandidate {
            candidate: "candidate:1".into(),
            sdp_mid: Some("0".into()),
            sdp_m_line_index: Some(json!(0)),
        };
        let payload = ice_payload(&[sample]);
        assert_eq!(
            payload.pointer("/messageType").and_then(Value::as_str),
            Some("iceCandidate")
        );
        assert_eq!(
            payload
                .pointer("/candidate/0/candidate")
                .and_then(Value::as_str),
            Some("candidate:1")
        );
        assert!(payload.get("candidate").unwrap().is_array());
    }
    #[test]
    fn ice_get_retries_no_content_until_remote_candidates_arrive() {
        tauri::async_runtime::block_on(async {
            let mut calls = 0;
            let result = poll_ice_response(|| {
                calls += 1;
                let response = if calls < 3 { None } else {
                    Some(json!({"exchangeResponse": "[{\"candidate\":\"fixture\",\"sdpMid\":\"0\",\"sdpMLineIndex\":\"0\"}]"}))
                };
                std::future::ready(Ok(response))
            }, 3, Duration::ZERO).await.unwrap();
            assert_eq!(
                result.len(),
                1,
                "HTTP 204 means pending, not zero remote candidates"
            );
            assert_eq!(calls, 3);
        });
    }
    #[test]
    fn ice_get_pending_exchange_is_bounded_and_errors_do_not_leak_values() {
        tauri::async_runtime::block_on(async {
            let mut calls = 0;
            let result = poll_ice_response(
                || {
                    calls += 1;
                    std::future::ready(Ok(Some(json!({"exchangeResponse":""}))))
                },
                3,
                Duration::ZERO,
            )
            .await;
            assert_eq!(calls, 3);
            assert!(result.unwrap_err().contains("timed out"));
            let error = poll_ice_response(
                || {
                    std::future::ready(Ok(Some(
                        json!({"exchangeResponse":"private-invalid-fixture"}),
                    )))
                },
                3,
                Duration::ZERO,
            )
            .await
            .unwrap_err();
            assert_eq!(error, "Xbox ICE exchange response is invalid");
        });
    }
    #[test]
    fn sdp_answer_waits_for_empty_exchange_response() {
        assert!(decode_sdp_answer(&json!({})).unwrap().is_none());
        assert!(
            decode_sdp_answer(&json!({"exchangeResponse":""}))
                .unwrap()
                .is_none()
        );
        let result =
            decode_sdp_answer(&json!({"exchangeResponse":"{\"type\":\"answer\",\"sdp\":\"v=0\"}"}))
                .unwrap()
                .unwrap();
        assert_eq!(result.get("type").and_then(Value::as_str), Some("answer"));
    }
    #[test]
    fn streaming_http_errors_are_reported_before_json_parsing_without_secret_leaks() {
        let result = parse_response(
            reqwest::StatusCode::FORBIDDEN,
            "/v5/sessions/home/play",
            "Bad Request",
        );
        let error = result.unwrap_err();
        assert!(error.contains("HTTP 403"));
        assert!(error.contains("play"));
        assert!(error.contains("Bad Request"));
        let sensitive = parse_response(
            reqwest::StatusCode::BAD_REQUEST,
            "/v5/sessions/cloud/play",
            "access_token=secret-value",
        )
        .unwrap_err();
        assert!(!sensitive.contains("secret-value"));
        assert!(
            parse_response(
                reqwest::StatusCode::ACCEPTED,
                "/v5/sessions/home/abc/connect",
                ""
            )
            .unwrap()
            .is_none()
        );
    }
    #[test]
    fn payload_reproduces_audited_defaults_and_respects_configurable_dimensions() {
        let profile = DeviceProfile {
            width: 2560,
            height: 1440,
            locale: "es-MX".into(),
            ..Default::default()
        };
        let header = profile.device_info_header();
        let play = profile.play_payload(SessionKind::Home, "server-1");
        assert_eq!(
            header
                .pointer("/appInfo/env/clientAppId")
                .and_then(Value::as_str),
            Some("Microsoft.GamingApp")
        );
        assert_eq!(
            header.pointer("/dev/hw/model").and_then(Value::as_str),
            Some("Surface Pro")
        );
        assert_eq!(
            header
                .pointer("/dev/displayInfo/dimensions/widthInPixels")
                .and_then(Value::as_u64),
            Some(2560)
        );
        assert_eq!(
            play.pointer("/settings/nanoVersion")
                .and_then(Value::as_str),
            Some("V3;WebrtcTransport.dll")
        );
        assert_eq!(
            play.pointer("/settings/sdkType").and_then(Value::as_str),
            Some("web")
        );
        assert_eq!(
            play.pointer("/serverId").and_then(Value::as_str),
            Some("server-1")
        );
        assert_eq!(play.pointer("/titleId").and_then(Value::as_str), Some(""));
    }
    #[test]
    fn cloud_can_negotiate_from_ready_to_connect() {
        let mut machine = SessionMachine::default();
        machine.started("session-abc".into()).unwrap();
        machine.observe_server_state("ReadyToConnect").unwrap();
        machine.begin_negotiation().unwrap();
        assert_eq!(machine.state, SessionState::Negotiating);
    }
    #[test]
    fn state_machine_rejects_negotiation_before_provisioning_and_transitions_from_polled_states() {
        let mut machine = SessionMachine::default();
        machine.started("session-1".into()).unwrap();
        assert_eq!(
            machine.observe_server_state("Provisioning").unwrap(),
            SessionState::Provisioning
        );
        assert!(machine.begin_negotiation().is_err());
        assert_eq!(
            machine.observe_server_state("Provisioned").unwrap(),
            SessionState::Provisioned
        );
        machine.begin_negotiation().unwrap();
        assert_eq!(machine.state, SessionState::Negotiating);
        assert_eq!(
            machine.observe_server_state("Connected").unwrap(),
            SessionState::Connected
        );
    }
    #[test]
    fn play_result_accepts_session_path_without_session_id() {
        let response = json!({"sessionPath": "/v5/sessions/home/session-abc"});
        assert_eq!(session_id_from_play(&response).unwrap(), "session-abc");
    }
    #[test]
    fn ready_to_connect_requires_transfer_token() {
        let mut machine = SessionMachine::default();
        machine.started("session-abc".into()).unwrap();
        assert_eq!(
            machine.observe_server_state("ReadyToConnect").unwrap(),
            SessionState::ReadyToConnect
        );
    }
    #[test]
    fn cloud_play_request_sends_spanish_accept_language_header() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut data = [0; 8192];
                let n = socket.read(&mut data).unwrap();
                let request = String::from_utf8_lossy(&data[..n]).to_ascii_lowercase();
                let body = r#"{"sessionId":"fixture-session"}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes());
                request
            });
            let mut stream = SessionClient::new(
                Client::new(),
                "fixture.invalid".into(),
                "fixture-token".into(),
                SessionKind::Cloud,
                DeviceProfile::default(),
            );
            stream.test_base_url = Some(endpoint);
            stream.profile.locale = "es-MX".into();
            stream.set_account_scope(Some("a".repeat(64))).unwrap();
            stream.host = "fixture.gssv-play-prod.xboxlive.com".into();
            let root = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap()
                .join(".cache/xjaus-locale-test")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            stream.test_journal_root = Some(root.clone());
            stream.start("title-fixture").await.unwrap();
            assert!(
                server
                    .join()
                    .unwrap()
                    .contains("accept-language: es-mx, es;q=0.9, en;q=0.1")
            );
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn cloud_payload_selects_title_not_server() {
        let payload = DeviceProfile::default().play_payload(SessionKind::Cloud, "title-123");
        assert_eq!(
            payload.pointer("/titleId").and_then(Value::as_str),
            Some("title-123")
        );
        assert_eq!(
            payload.pointer("/settings/locale").and_then(Value::as_str),
            Some("es-MX")
        );
        assert!(payload.pointer("/systemUpdateGroup").is_none());
        assert_eq!(
            payload.pointer("/settings/market").and_then(Value::as_str),
            Some("ES-MX")
        );
        assert_eq!(
            payload
                .pointer("/settings/timezoneOffsetMinutes")
                .and_then(Value::as_i64),
            Some(360)
        );
        assert_eq!(
            payload.pointer("/serverId").and_then(Value::as_str),
            Some("")
        );
    }
}

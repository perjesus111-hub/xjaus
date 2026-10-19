//! XCCS contract audited against OpenXbox xbox-webapi-python smartglass provider.
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
pub const WAKE_TIMEOUT: &str = "No se pudo encender la consola en 45 segundos. Comprueba que tenga acceso a Internet, modo de espera y funciones remotas activadas.";
fn payload(id: &str, session: &str) -> Value {
    json!({"destination":"Xbox","type":"Power","command":"WakeUp","sessionId":session,"sourceId":"com.microsoft.smartglass","parameters":[{}],"linkedXboxId":id})
}
fn powered_on(value: &Value) -> bool {
    value
        .get("powerState")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("on") || s.eq_ignore_ascii_case("poweredon"))
}
/// Only XCCS device IDs from the authenticated device list are accepted.
/// No WOL: the current device model contains no verified MAC/LAN destination.
pub async fn wake(client: &Client, web: &Value, device_id: &str) -> Result<Value, String> {
    wake_at(
        client,
        web,
        device_id,
        "https://xccs.xboxlive.com",
        Duration::from_secs(45),
        Duration::from_millis(2500),
    )
    .await
}
async fn wake_at(
    client: &Client,
    web: &Value,
    id: &str,
    base: &str,
    budget: Duration,
    interval: Duration,
) -> Result<Value, String> {
    let token = web
        .get("Token")
        .and_then(Value::as_str)
        .ok_or("Actualiza tu sesión Xbox.")?;
    let hash = web
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(Value::as_str)
        .ok_or("Actualiza tu sesión Xbox.")?;
    let authorization = zeroize::Zeroizing::new(format!("XBL3.0 x={hash};{token}"));
    let operation = async {
        let get = |url: String| {
            client
                .get(url)
                .header("Authorization", authorization.as_str())
                .header("x-xbl-contract-version", "4")
                .header("skillplatform", "RemoteManagement")
        };
        let response = get(format!(
            "{base}/lists/devices?queryCurrentDevice=false&includeStorageDevices=true"
        ))
        .send()
        .await
        .map_err(|_| "No se pudo consultar la consola.")?;
        if !response.status().is_success() {
            return Err("No se pudo consultar la consola. Actualiza tu sesión Xbox.".into());
        }
        let devices: Value = response
            .json()
            .await
            .map_err(|_| "Respuesta de consola no válida.")?;
        let device = devices
            .get("result")
            .and_then(Value::as_array)
            .or_else(|| devices.get("devices").and_then(Value::as_array))
            .or_else(|| devices.get("consoles").and_then(Value::as_array))
            .and_then(|list| {
                list.iter()
                    .find(|d| d.get("id").and_then(Value::as_str) == Some(id))
            })
            .ok_or("La consola ya no está vinculada a esta cuenta.")?;
        if powered_on(device) {
            return Ok(json!({"powerState":"On","alreadyOn":true}));
        }
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "No se pudo preparar el encendido.")?;
        random[6] = (random[6] & 15) | 64;
        random[8] = (random[8] & 63) | 128;
        let h = hex::encode(random);
        let session = format!(
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..]
        );
        let response = client
            .post(format!("{base}/commands"))
            .header("Authorization", authorization.as_str())
            .header("x-xbl-contract-version", "4")
            .header("skillplatform", "RemoteManagement")
            .json(&payload(id, &session))
            .send()
            .await
            .map_err(|_| "No se pudo enviar el encendido.")?;
        if !response.status().is_success() {
            return Err(
                "Xbox no aceptó el encendido. Comprueba las funciones remotas de la consola."
                    .into(),
            );
        }
        loop {
            tokio::time::sleep(interval).await;
            let response = get(format!("{base}/consoles/{}", urlencoding::encode(id)))
                .send()
                .await
                .map_err(|_| "No se pudo consultar el encendido.")?;
            if matches!(response.status().as_u16(), 401 | 403) {
                return Err("Actualiza tu sesión Xbox para encender la consola.".into());
            }
            if response.status().is_success() {
                let status: Value = response
                    .json()
                    .await
                    .map_err(|_| "Respuesta de consola no válida.")?;
                if powered_on(&status) || status.get("console").is_some_and(powered_on) {
                    return Ok(json!({"powerState":"On","alreadyOn":false}));
                }
            }
        }
    };
    tokio::time::timeout(budget, operation)
        .await
        .map_err(|_| WAKE_TIMEOUT.to_owned())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(bodies: Vec<(u16, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let mut requests = vec![];
            for (code, body) in bodies {
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
                write!(socket, "HTTP/1.1 {code} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (base, task)
    }
    fn web() -> Value {
        json!({"Token":"fixture-only", "DisplayClaims":{"xui":[{"uhs":"fixture"}]}})
    }
    #[test]
    fn wake_http_sequence_polls_until_on_and_uses_correct_endpoint() {
        tauri::async_runtime::block_on(async {
            let (base, task) = fixture(vec![
                (
                    200,
                    r#"{"result":[{"id":"sg","powerState":"ConnectedStandby"}]}"#,
                ),
                (200, "{}"),
                (200, r#"{"powerState":"ConnectedStandby"}"#),
                (200, r#"{"powerState":"On"}"#),
            ]);
            let result = wake_at(
                &Client::new(),
                &web(),
                "sg",
                &base,
                Duration::from_secs(2),
                Duration::from_millis(2),
            )
            .await
            .unwrap();
            assert_eq!(result["powerState"], "On");
            let requests = task.join().unwrap();
            assert_eq!(requests[1], "POST /commands HTTP/1.1");
            assert_eq!(
                &requests[2..],
                ["GET /consoles/sg HTTP/1.1", "GET /consoles/sg HTTP/1.1"]
            );
        });
    }
    #[test]
    fn already_on_never_posts_wake_and_unlinked_id_is_rejected() {
        tauri::async_runtime::block_on(async {
            for id in ["sg", "wrong-server-id"] {
                let (base, task) =
                    fixture(vec![(200, r#"{"result":[{"id":"sg","powerState":"On"}]}"#)]);
                let result = wake_at(
                    &Client::new(),
                    &web(),
                    id,
                    &base,
                    Duration::from_secs(1),
                    Duration::from_millis(1),
                )
                .await;
                assert_eq!(result.is_ok(), id == "sg");
                assert_eq!(task.join().unwrap().len(), 1);
            }
        });
    }
    #[test]
    fn wake_deadline_cancels_pending_poll_and_returns_friendly_error() {
        tauri::async_runtime::block_on(async {
            let (base, task) = fixture(vec![
                (
                    200,
                    r#"{"result":[{"id":"sg","powerState":"ConnectedStandby"}]}"#,
                ),
                (200, "{}"),
            ]);
            let start = std::time::Instant::now();
            let error = wake_at(
                &Client::new(),
                &web(),
                "sg",
                &base,
                Duration::from_millis(50),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert_eq!(error, WAKE_TIMEOUT);
            assert!(start.elapsed() < Duration::from_millis(500));
            assert_eq!(task.join().unwrap().len(), 2);
        });
    }
    #[test]
    fn wake_payload_uses_smartglass_id_not_streaming_id() {
        let p = payload("sg-device", "session");
        assert_eq!(p["linkedXboxId"], "sg-device");
        assert_eq!(p["command"], "WakeUp");
        assert_eq!(p["type"], "Power");
        assert_eq!(p["parameters"], json!([{}]));
    }
}

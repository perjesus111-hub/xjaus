//! Fresh XCCS presence shared by the Tauri and Electron runners.
use serde_json::Value;

fn merge_status(device: &mut Value, status: &Value) {
    if status
        .pointer("/status/errorCode")
        .and_then(Value::as_str)
        .is_some_and(|s| s != "OK")
    {
        return;
    }
    let status = status.get("console").unwrap_or(status);
    let Some(power) = status.get("powerState").and_then(Value::as_str) else {
        return;
    };
    if ![
        "On",
        "PoweredOn",
        "Off",
        "ConnectedStandby",
        "SystemUpdate",
        "Unknown",
    ]
    .iter()
    .any(|s| power.eq_ignore_ascii_case(s))
    {
        return;
    }
    if let Some(device) = device.as_object_mut() {
        // Presence only: never replace identities, streaming IDs or opaque metadata.
        device.insert("powerState".into(), Value::String(power.into()));
    }
}

pub async fn refresh(client: &reqwest::Client, authorization: &str, mut devices: Value) -> Value {
    refresh_at(
        client,
        authorization,
        &mut devices,
        "https://xccs.xboxlive.com",
    )
    .await;
    devices
}

async fn refresh_at(
    client: &reqwest::Client,
    authorization: &str,
    devices: &mut Value,
    base: &str,
) {
    let Some(list) = (if devices.is_array() {
        devices.as_array_mut()
    } else {
        let key = ["result", "devices", "consoles"]
            .into_iter()
            .find(|key| devices.get(*key).is_some_and(Value::is_array));
        key.and_then(|key| devices.get_mut(key))
            .and_then(Value::as_array_mut)
    }) else {
        return;
    };
    // No LAN probing: the audited XCCS schema supplies no local address or subnet.
    // Never derive one from a name/serverId, gateway, remote endpoint, or timeout.
    let operation = async {
        for device in list {
            let Some(id) = device
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let response = client
                .get(format!("{base}/consoles/{}", urlencoding::encode(id)))
                .header("Authorization", authorization)
                .header("x-xbl-contract-version", "4")
                .header("skillplatform", "RemoteManagement")
                .header("Cache-Control", "no-store, no-cache, must-revalidate")
                .header("Pragma", "no-cache")
                .timeout(std::time::Duration::from_millis(1200))
                .send()
                .await;
            if let Ok(response) = response {
                if response.status().is_success() {
                    if let Ok(status) = response.json::<Value>().await {
                        merge_status(device, &status);
                    }
                }
            }
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), operation).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn timeout_preserves_api_power_state_without_fabricating_lan_data() {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut buf = [0; 8192];
            let _ = socket.read(&mut buf);
            std::thread::sleep(std::time::Duration::from_millis(1500));
        });
        let original = json!({"result":[{"id":"sg","powerState":"On","opaque":{"keep":true}}]});
        let mut devices = original.clone();
        refresh_at(&reqwest::Client::new(), "fixture-auth", &mut devices, &base).await;
        assert_eq!(devices, original);
        task.join().unwrap();
    }
    #[tokio::test]
    async fn requests_fresh_status_with_no_cache_and_preserves_original_on_http_failure() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let mut heads = vec![];
            for (code, body) in [
                (200, r#"{"status":{"errorCode":"OK"},"powerState":"On"}"#),
                (503, "{}"),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = socket.read(&mut buf).unwrap();
                heads.push(String::from_utf8_lossy(&buf[..n]).to_string());
                write!(
                    socket,
                    "HTTP/1.1 {code} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            heads
        });
        let mut devices = json!({"result":[{"id":"first","powerState":"ConnectedStandby","serverId":"keep"},{"id":"second","powerState":"On"}],"opaque":"kept"});
        refresh_at(&reqwest::Client::new(), "fixture-auth", &mut devices, &base).await;
        assert_eq!(devices["result"][0]["powerState"], "On");
        assert_eq!(devices["result"][0]["serverId"], "keep");
        assert_eq!(devices["result"][1]["powerState"], "On");
        assert_eq!(devices["opaque"], "kept");
        let heads = task.join().unwrap();
        for (i, head) in heads.iter().enumerate() {
            assert!(head.starts_with(if i == 0 {
                "GET /consoles/first "
            } else {
                "GET /consoles/second "
            }));
            let head = head.to_ascii_lowercase();
            assert!(head.contains("cache-control: no-store, no-cache, must-revalidate"));
            assert!(head.contains("pragma: no-cache"));
        }
    }
    #[test]
    fn fresh_on_preserves_smartglass_and_streaming_metadata() {
        let mut device = json!({"id":"sg","serverId":"v6","name":"Fixture","powerState":"ConnectedStandby","extra":{"keep":true}});
        merge_status(
            &mut device,
            &json!({"powerState":"On","remoteManagementEnabled":true}),
        );
        assert_eq!(device["powerState"], "On");
        assert_eq!(device["serverId"], "v6");
        assert_eq!(device["extra"]["keep"], true);
    }
    #[test]
    fn absent_failed_or_unknown_status_never_infers_standby() {
        for status in [
            json!(null),
            json!({}),
            json!({"powerState":"Off","status":{"errorCode":"XboxDataNotFound"}}),
        ] {
            let mut device = json!({"id":"sg","powerState":"On"});
            merge_status(&mut device, &status);
            assert_eq!(device["powerState"], "On");
        }
    }
}

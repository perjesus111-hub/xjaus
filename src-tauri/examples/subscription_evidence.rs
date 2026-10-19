// Read-only local evidence probe. Never serialize TokenBundle or credential values.
#[path = "../src/auth.rs"]
mod auth;
#[path = "../src/vault.rs"]
mod vault;
use serde_json::{Value, json};
fn keys(v: &Value) -> Vec<String> {
    v.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}
fn shape(v: &Value, depth: u8) -> Value {
    if depth == 0 {
        return json!("...");
    }
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), shape(v, depth - 1)))
                .collect(),
        ),
        Value::Array(a) => json!({"arrayElement":a.first().map(|v|shape(v,depth-1))}),
        Value::String(_) => json!("string"),
        Value::Bool(_) => json!("boolean"),
        Value::Number(_) => json!("number"),
        Value::Null => Value::Null,
    }
}
fn main() {
    match vault::load() {
        Ok(Some(t)) => {
            let c = t.cloud_stream_token.as_ref();
            println!(
                "{}",
                json!({"webClaimsShape":t.web_token.get("DisplayClaims").map(|v|shape(v,5)),"sisuClaimsShape":t.sisu_token.get("DisplayClaims").map(|v|shape(v,5)),"userClaimsShape":t.user_token.get("DisplayClaims").map(|v|shape(v,5)),"cloudSettingsShape":c.and_then(|v|v.pointer("/offeringSettings/clientCloudSettings")).map(|v|shape(v,4))})
            );
            println!(
                "{}",
                json!({"authenticated":true,"webClaimKeys":t.web_token.pointer("/DisplayClaims/xui/0").map(keys),"userClaimKeys":t.user_token.pointer("/DisplayClaims/xui/0").map(keys),"sisuKeys":keys(&t.sisu_token),"cloudKeys":c.map(keys),"cloudOfferingKeys":c.and_then(|v|v.get("offeringSettings")).map(keys),"cloudDuration":c.and_then(|v|v.get("durationInSeconds")).and_then(Value::as_u64),"acquiredAt":t.acquired_at_unix,"subscriptionRecordsPresent":([&t.web_token,&t.user_token,&t.sisu_token].iter().any(|v|v.get("subscriptions").is_some()||v.pointer("/DisplayClaims/xui/0/subscriptions").is_some()))})
            );
        }
        Ok(None) => println!("{{\"authenticated\":false}}"),
        Err(_) => println!("{{\"error\":\"secure store unavailable\"}}"),
    }
}

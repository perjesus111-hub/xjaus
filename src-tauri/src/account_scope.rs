use serde_json::Value;

pub fn catalog_account_scope(web: &Value) -> Option<String> {
    use sha2::{Digest, Sha256};
    for claim in ["uhs", "xid"] {
        if let Some(id) = web
            .pointer(&format!("/DisplayClaims/xui/0/{claim}"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        {
            return Some(format!(
                "{:x}",
                Sha256::digest(format!("xjaus:account:v1:{claim}:{id}").as_bytes())
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scope_is_stable_across_token_rotation_and_account_specific() {
        let first = json!({"Token":"secret-one", "DisplayClaims":{"xui":[{"uhs":"account-a"}]}});
        let rotated = json!({"Token":"secret-two", "DisplayClaims":{"xui":[{"uhs":"account-a"}]}});
        let other = json!({"DisplayClaims":{"xui":[{"uhs":"account-b"}]}});
        let scope = catalog_account_scope(&first).unwrap();
        assert_eq!(scope.len(), 64);
        assert!(scope.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(Some(scope.clone()), catalog_account_scope(&rotated));
        assert_ne!(Some(scope), catalog_account_scope(&other));
        assert!(catalog_account_scope(&json!({"Token":"secret"})).is_none());
        assert!(catalog_account_scope(&json!({"DisplayClaims":{"xui":[{"xid":"123"}]}})).is_some());
    }
}

//! Subscription evidence is independent of legacy Xbox AccountTier and offeringId.
use serde::Serialize;
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub plan: Option<String>,
    pub cloud_access: bool,
    pub label: String,
    pub source: String,
}
// Exact Microsoft Store ProductIDs, not fuzzy matching of SKU fragments, offering IDs or AccountTier.
// Source: Microsoft Learn, xstore-detecting-game-pass (see docs/subscription-settings.md).
fn product_plan(product: &str) -> Option<&'static str> {
    match product {
        "CFQ7TTC0KHS0" => Some("Xbox Game Pass Ultimate"),
        "CFQ7TTC0P85B" => Some("Xbox Game Pass Premium"),
        "CFQ7TTC0K5DJ" => Some("Xbox Game Pass Essential"),
        "CFQ7TTC0KGQ8" => Some("PC Game Pass"),
        "CFQ7TTC10QFD" => Some("Xbox Game Pass (Starter Edition)"),
        "CFQ7TTC0K6L8" => Some("Xbox Game Pass for Console"),
        _ => None,
    }
}
pub fn resolve(claims: &[&Value], cloud: Option<&Value>, acquired: u64, now: u64) -> Subscription {
    // An authenticated streaming login is evidence of Cloud access only while its lease is current.
    let cloud_access = cloud
        .map(|c| {
            c.get("gsToken")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                && now >= acquired
                && c.get("durationInSeconds")
                    .and_then(Value::as_u64)
                    .is_some_and(|ttl| now - acquired < ttl.min(86400))
        })
        .unwrap_or(false);
    let mut plans = std::collections::BTreeSet::new();
    // Only explicit subscription records in trusted auth response claims. Catalog titles,
    // satisfiedByProductIds and offering settings never prove the subscriber's exact plan.
    for claim in claims
        .iter()
        .copied()
        .chain(cloud)
        .filter(|_| now >= acquired && now - acquired < 300)
    {
        for path in ["/subscriptions", "/DisplayClaims/xui/0/subscriptions"] {
            if let Some(records) = claim.pointer(path).and_then(Value::as_array) {
                for record in records.iter().take(64) {
                    if record.get("status").and_then(Value::as_str) != Some("Active") {
                        continue;
                    }
                    let date = |key: &str| {
                        record.get(key).map(|v| {
                            v.as_str()
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .and_then(|t| u64::try_from(t.timestamp()).ok())
                        })
                    };
                    if date("startDate").is_some_and(|t| t.is_none_or(|t| t > now))
                        || date("endDate").is_some_and(|t| t.is_none_or(|t| t <= now))
                    {
                        continue;
                    }
                    if let Some(plan) = record
                        .get("productId")
                        .and_then(Value::as_str)
                        .and_then(product_plan)
                    {
                        plans.insert(plan);
                    }
                }
            }
        }
    }
    // Conflicting claims remain unconfirmed rather than choosing the most expensive tier.
    let plan = if plans.len() == 1 {
        plans.first().map(|p| p.to_string())
    } else {
        None
    };
    let label = plan.clone().unwrap_or_else(|| {
        if cloud_access {
            "Acceso Cloud activo · plan no confirmado".into()
        } else {
            "Plan no confirmado".into()
        }
    });
    Subscription {
        source: if plan.is_some() {
            "explicit-subscription-product".into()
        } else if cloud_access {
            "streaming-login".into()
        } else {
            "unavailable".into()
        },
        plan,
        cloud_access,
        label,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn offering_is_not_a_plan() {
        let c = json!({"offeringId":"xgpuweb","gsToken":"fixture","durationInSeconds":3600});
        let p = resolve(&[], Some(&c), 100, 101);
        assert_eq!(p.plan, None);
        assert_eq!(p.label, "Acceso Cloud activo · plan no confirmado");
    }
    #[test]
    fn explicit_active_product_maps_exactly() {
        let claim = json!({"subscriptions":[{"productId":"CFQ7TTC0KHS0","status":"Active"}]});
        assert_eq!(
            resolve(&[&claim], None, 100, 101).plan.as_deref(),
            Some("Xbox Game Pass Ultimate")
        );
    }
    #[test]
    fn expired_unknown_or_inactive_never_invents_plan() {
        for c in [
            json!({"subscriptions":[{"productId":"CFQ7TTC0KHS0","status":"Expired"}]}),
            json!({"subscriptions":[{"productId":"CFQ7TTC0KHS0-extra","status":"Active"}]}),
            json!({"AccountTier":"Gold","offeringId":"xgpuweb"}),
        ] {
            assert_eq!(resolve(&[&c], None, 100, 101).plan, None);
        }
    }
    #[test]
    fn stale_cloud_never_claims_active() {
        let c = json!({"gsToken":"fixture","durationInSeconds":3600});
        assert!(!resolve(&[], Some(&c), 100, 4000).cloud_access);
    }
    #[test]
    fn stale_explicit_subscription_never_claims_current_plan() {
        let c = json!({"subscriptions":[{"productId":"CFQ7TTC0KHS0","status":"Active"}]});
        assert!(resolve(&[&c], None, 100, 4000).plan.is_none());
    }
    #[test]
    fn explicit_product_dates_must_cover_now() {
        let c = json!({"subscriptions":[{"productId":"CFQ7TTC0KHS0","status":"Active","startDate":"2026-01-01T00:00:00Z","endDate":"2027-01-01T00:00:00Z"}]});
        assert_eq!(
            resolve(&[&c], None, 1792237600, 1792237610).plan.as_deref(),
            Some("Xbox Game Pass Ultimate")
        );
    }
}

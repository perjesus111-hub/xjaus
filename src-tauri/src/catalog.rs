use reqwest::{Client, Url};
use serde_json::{Value, json};

pub fn valid_product_ids(input: &[String]) -> Result<Vec<String>, String> {
    if input.len() > 5000 {
        return Err("Demasiados productos solicitados".into());
    }
    let mut result = Vec::new();
    for id in input {
        if id.len() < 10 || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("ID de producto inválido".into());
        }
        if !result.contains(id) {
            result.push(id.to_owned());
        }
    }
    Ok(result)
}

fn compact_product(product: &Value) -> Value {
    let localized = product.pointer("/LocalizedProperties/0");
    let images = localized.and_then(|p| p.get("Images")).and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|image| matches!(image.get("ImagePurpose").and_then(Value::as_str), Some("Poster" | "BoxArt" | "Hero" | "SuperHeroArt" | "TitledHeroArt" | "FeaturePromo" | "FeaturePromotionalArt")))
            .take(12).map(|image| json!({"ImagePurpose":image.get("ImagePurpose"),"Uri":image.get("Uri"),"Width":image.get("Width"),"Height":image.get("Height")})).collect::<Vec<_>>())
        .unwrap_or_default();
    // Public DisplayCatalog fields only. Never copy rights or account data.
    let properties = product.get("Properties");
    let strings = |key: &str| -> Vec<String> {
        properties
            .and_then(|p| p.get(key))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(64)
                    .filter_map(Value::as_str)
                    .map(|s| s.chars().take(120).collect())
                    .collect()
            })
            .unwrap_or_default()
    };
    let attributes: Vec<Value> = properties.and_then(|p| p.get("Attributes")).and_then(Value::as_array)
        .map(|items| items.iter().take(100).filter_map(|item| item.get("Name").and_then(Value::as_str).map(|name| json!({"Name":name.chars().take(120).collect::<String>(),"ApplicablePlatforms":item.get("ApplicablePlatforms").and_then(Value::as_array).map(|items|items.iter().take(32).filter_map(Value::as_str).map(|s|s.chars().take(120).collect::<String>()).collect::<Vec<_>>())}))).collect())
        .unwrap_or_default();
    json!({"ProductId":product.get("ProductId"),"Properties":{
        "Category": properties.and_then(|p| p.get("Category")).and_then(Value::as_str).map(|s| s.chars().take(120).collect::<String>()),
        "Categories": strings("Categories"), "XboxConsoleGenOptimized": strings("XboxConsoleGenOptimized"), "Attributes": attributes
    },"LocalizedProperties":[{
        "ProductTitle": localized.and_then(|p| p.get("ProductTitle")),
        "ShortDescription": localized.and_then(|p| p.get("ShortDescription")),
        "Images": images
    }]})
}

const DISPLAY_CATALOG_BATCH_SIZE: usize = 25;

pub fn catalog_request_locale(language: &str) -> Result<(&'static str, &'static str), String> {
    match language {
        "en" => Ok(("en-US", "en-US, en;q=0.9, es;q=0.1")),
        "es" => Ok(("es-MX", "es-MX, es;q=0.9, en;q=0.1")),
        _ => Err("Idioma de catálogo no válido".into()),
    }
}

pub async fn catalog_products(
    client: &Client,
    input: &[String],
    language: &str,
) -> Result<Value, String> {
    catalog_products_from(
        client,
        input,
        "https://displaycatalog.mp.microsoft.com/v7.0/products",
        language,
    )
    .await
}
async fn catalog_products_from(
    client: &Client,
    input: &[String],
    endpoint: &str,
    language: &str,
) -> Result<Value, String> {
    let (locale, accept_language) = catalog_request_locale(language)?;
    let ids = valid_product_ids(input)?;
    let mut products = Vec::new();
    for batch in ids.chunks(DISPLAY_CATALOG_BATCH_SIZE) {
        let mut url = Url::parse(endpoint).map_err(|_| "URL de catálogo inválida")?;
        url.query_pairs_mut()
            .append_pair("bigIds", &batch.join(","))
            .append_pair("market", "MX")
            .append_pair("languages", locale);
        let response = client
            .get(url)
            .header("Accept-Language", accept_language)
            .send()
            .await
            .map_err(|_| "Error de red en DisplayCatalog")?;
        if !response.status().is_success() {
            return Err(format!(
                "DisplayCatalog HTTP {}",
                response.status().as_u16()
            ));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "DisplayCatalog devolvió JSON inválido")?;
        let items = value
            .get("Products")
            .and_then(Value::as_array)
            .ok_or("DisplayCatalog no devolvió Products")?;
        products.extend(items.iter().map(compact_product));
    }
    Ok(json!({"Products": products}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn factual_game_features_survive_compaction_without_credentials() {
        let product = compact_product(&json!({"ProductId":"9N2Z748SPMTM", "Properties": {
            "Category":"Action & adventure", "Categories":["Action & adventure"],
            "XboxConsoleGenOptimized":["ConsoleGen9"],
            "Attributes":[{"Name":"XblOnlineMultiPlayer","Maximum":8}],
            "token":"SECRET", "hasEntitlement":true
        }}));
        assert_eq!(
            product.pointer("/Properties/Category"),
            Some(&json!("Action & adventure"))
        );
        assert_eq!(
            product.pointer("/Properties/Attributes/0/Name"),
            Some(&json!("XblOnlineMultiPlayer"))
        );
        assert!(!product.to_string().contains("SECRET"));
        assert!(product.pointer("/Properties/hasEntitlement").is_none());
    }
    #[test]
    fn actual_http_requests_are_batched_as_twenty_five_then_one() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/products", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut batches = vec![];
                for _ in 0..2 {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                        .unwrap();
                    let mut data = [0; 8192];
                    let n = socket.read(&mut data).unwrap();
                    let line = String::from_utf8_lossy(&data[..n])
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned();
                    let path = line.split_whitespace().nth(1).unwrap();
                    let url = Url::parse(&format!("http://fixture{path}")).unwrap();
                    let ids = url
                        .query_pairs()
                        .find(|(key, _)| key == "bigIds")
                        .unwrap()
                        .1
                        .into_owned();
                    batches.push(ids.split(',').count());
                    let body = r#"{"Products":[]}"#;
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                }
                batches
            });
            let ids = (0..26)
                .map(|n| format!("9N2Z748{:05}", n))
                .collect::<Vec<_>>();
            catalog_products_from(&Client::new(), &ids, &endpoint, "es")
                .await
                .unwrap();
            assert_eq!(server.join().unwrap(), vec![25, 1]);
        });
    }
    #[test]
    fn catalog_locale_changes_metadata_language_without_changing_market() {
        tauri::async_runtime::block_on(async {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/products", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut observed = Vec::new();
                for _ in 0..2 {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                        .unwrap();
                    let mut data = [0; 4096];
                    let n = socket.read(&mut data).unwrap();
                    let request = String::from_utf8_lossy(&data[..n]);
                    let path = request
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let url = Url::parse(&format!("http://fixture{path}")).unwrap();
                    let query = url
                        .query_pairs()
                        .into_owned()
                        .collect::<std::collections::HashMap<_, _>>();
                    let accept_language = request
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("accept-language:"))
                        .unwrap()
                        .split_once(':')
                        .unwrap()
                        .1
                        .trim()
                        .to_owned();
                    let body = r#"{"Products":[]}"#;
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                    observed.push((
                        query.get("market").cloned().unwrap(),
                        query.get("languages").cloned().unwrap(),
                        accept_language,
                    ));
                }
                observed
            });
            let client = Client::new();
            let ids = vec!["9N2Z748SPMTM".to_string()];
            catalog_products_from(&client, &ids, &endpoint, "en")
                .await
                .unwrap();
            catalog_products_from(&client, &ids, &endpoint, "es")
                .await
                .unwrap();
            assert_eq!(
                server.join().unwrap(),
                vec![
                    (
                        "MX".into(),
                        "en-US".into(),
                        "en-US, en;q=0.9, es;q=0.1".into()
                    ),
                    (
                        "MX".into(),
                        "es-MX".into(),
                        "es-MX, es;q=0.9, en;q=0.1".into()
                    ),
                ]
            );
        });
    }
    #[test]
    fn rejects_unrecognized_catalog_language_before_network_access() {
        tauri::async_runtime::block_on(async {
            let error = catalog_products_from(
                &Client::new(),
                &["9N2Z748SPMTM".to_string()],
                "http://127.0.0.1:1/products",
                "fr",
            )
            .await
            .unwrap_err();
            assert_eq!(error, "Idioma de catálogo no válido");
        });
    }
    #[test]
    fn retains_horizontal_artwork_dimensions_without_dropping_posters() {
        let raw = json!({"ProductId":"9N2Z748SPMTM","LocalizedProperties":[{"Images":[
            {"ImagePurpose":"Poster","Uri":"//store-images.s-microsoft.com/poster"},
            {"ImagePurpose":"BoxArt","Uri":"//store-images.s-microsoft.com/box"},
            {"ImagePurpose":"Hero","Uri":"//store-images.s-microsoft.com/hero","Width":1920,"Height":1080},
            {"ImagePurpose":"FeaturePromo","Uri":"//store-images.s-microsoft.com/promo","Width":1920,"Height":1080}
        ]}]});
        let compact = compact_product(&raw);
        let images = compact
            .pointer("/LocalizedProperties/0/Images")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(images.len(), 4);
        assert_eq!(images[2]["Width"], 1920);
        assert_eq!(images[2]["Height"], 1080);
    }
    #[test]
    fn display_catalog_requests_never_exceed_twenty_five_products() {
        assert_eq!(DISPLAY_CATALOG_BATCH_SIZE, 25);
    }
    #[test]
    fn extracts_only_localized_fields_and_safe_cover_reference() {
        let raw = json!({"ProductId":"9N2Z748SPMTM","secretExtra":"discard",
            "LocalizedProperties":[{"ProductTitle":"Juego real","ShortDescription":"Texto",
                "Images":[{"ImagePurpose":"Poster","Uri":"//store-images.s-microsoft.com/image/poster"},{"ImagePurpose":"Logo","Uri":"//unwanted"}]}]});
        let compact = compact_product(&raw);
        assert_eq!(
            compact
                .pointer("/LocalizedProperties/0/ProductTitle")
                .and_then(Value::as_str),
            Some("Juego real")
        );
        assert!(compact.get("secretExtra").is_none());
        assert_eq!(
            compact
                .pointer("/LocalizedProperties/0/Images")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn accepts_the_live_catalog_size_without_unbounded_ipc_input() {
        let ids = (0..2757)
            .map(|n| format!("9N2Z748{:05}", n))
            .collect::<Vec<_>>();
        assert_eq!(valid_product_ids(&ids).unwrap().len(), 2757);
    }
    #[test]
    fn product_ids_are_bounded_and_cannot_change_the_request_target() {
        assert_eq!(
            valid_product_ids(&["9N2Z748SPMTM".into()]).unwrap(),
            vec!["9N2Z748SPMTM"]
        );
        assert!(valid_product_ids(&["https://evil.invalid/".into()]).is_err());
    }
}

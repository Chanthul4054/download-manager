//! Opt-in structured diagnostics: set OPENDM_DIAG=1 to print one JSON line per event to stderr.
//! Addresses are reduced to origin + path, so query strings (signed URLs, tokens), user info,
//! cookies and headers never reach the log.

use serde_json::{Map, Value};

pub fn enabled() -> bool {
    std::env::var_os("OPENDM_DIAG").is_some_and(|v| !v.is_empty())
}

pub fn redact_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!("{}{}", u.origin().ascii_serialization(), u.path()),
        Err(_) => "(invalid url)".into(),
    }
}

pub fn diag(event: &str, fields: Map<String, Value>) {
    if !enabled() {
        return;
    }
    let mut m = Map::new();
    m.insert("t".into(), Value::String(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()));
    m.insert("event".into(), Value::String(event.into()));
    m.extend(fields);
    eprintln!("{}", Value::Object(m));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_addresses_drop_query_strings_and_credentials() {
        assert_eq!(redact_url("https://user:secret@cdn.example.com/f/a.zip?token=abc&sig=1"), "https://cdn.example.com/f/a.zip");
        assert_eq!(redact_url("not a url"), "(invalid url)");
    }
}

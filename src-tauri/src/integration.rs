//! Localhost endpoint used by the browser extension (port of src/main/integration.js).
//! Requests must come from an extension origin and carry `X-OpenDM: 1`, which forces a CORS
//! preflight that we never approve — so ordinary web pages cannot drive the app.
//!
//! The socket runs on its own thread; each request is handed to the app core, which answers it.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

use crate::js;

pub struct IntegrationRequest {
    pub method: String,
    pub path: String,
    pub origin: String,
    /// The Host header: a DNS-rebinding page reaches us under its own name.
    pub host: String,
    pub x_opendm: String,
    /// None when the body was larger than 4 MB.
    pub body: Option<Vec<u8>>,
}

pub type Answer = (u16, Value);
pub type Handler = Arc<dyn Fn(IntegrationRequest) -> Answer + Send + Sync>;

const MAX_BODY: usize = 4 * 1024 * 1024;

static EXT_ORIGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(chrome|moz|ms-browser|safari-web)-extension://").unwrap());
static BARE_EXT_ORIGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^extension://").unwrap());
static LOCAL_HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(127\.0\.0\.1|localhost)(:\d+)?$").unwrap());

pub fn allowed(req: &IntegrationRequest) -> bool {
    if !LOCAL_HOST.is_match(&req.host) {
        return false;
    }
    if !req.origin.is_empty() && !EXT_ORIGIN.is_match(&req.origin) && !BARE_EXT_ORIGIN.is_match(&req.origin) {
        return false;
    }
    req.x_opendm == "1"
}

/// What the extension reads at /api/config.
pub fn config(settings: &Value, version: &str) -> Value {
    let g = js::get(settings, "general");
    let f = js::get(settings, "fileTypes");
    json!({
        "app": "OpenDM",
        "version": version,
        "enabled": g["browserIntegration"],
        "captureTypes": f["capture"],
        "excludedSites": f["excludedSites"],
        "excludedAddresses": f["excludedAddresses"],
        "forceKey": g["forceKey"],
        "preventKey": g["preventKey"],
        "contextMenu": g["contextMenu"],
        "videoPanel": settings["videoPanel"],
    })
}

#[derive(Default)]
pub struct IntegrationServer {
    server: Option<Arc<tiny_http::Server>>,
    thread: Option<JoinHandle<()>>,
}

impl IntegrationServer {
    /// Listens on 127.0.0.1:port. Fails (EADDRINUSE) when the port is taken.
    pub fn start(&mut self, port: u16, handler: Handler) -> std::io::Result<()> {
        self.stop();
        let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| {
            let msg = e.to_string();
            let kind = if msg.contains("10048") || msg.to_lowercase().contains("in use") { std::io::ErrorKind::AddrInUse } else { std::io::ErrorKind::Other };
            std::io::Error::new(kind, msg)
        })?;
        let server = Arc::new(server);
        let s2 = server.clone();
        let busy = Arc::new(Mutex::new(()));
        self.thread = Some(std::thread::spawn(move || {
            for mut req in s2.incoming_requests() {
                let _g = busy.lock();
                let header = |name: &'static str| {
                    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string()).unwrap_or_default()
                };
                let mut r = IntegrationRequest {
                    method: req.method().as_str().to_uppercase(),
                    path: req.url().split('?').next().unwrap_or("").to_string(),
                    origin: header("Origin"),
                    host: header("Host"),
                    x_opendm: header("X-OpenDM"),
                    body: Some(Vec::new()),
                };
                if allowed(&r) && r.method == "POST" {
                    let mut body = Vec::new();
                    let n = req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).unwrap_or(0);
                    r.body = if n > MAX_BODY { None } else { Some(body) };
                }
                let (code, obj) = handler(r);
                let resp = tiny_http::Response::from_string(obj.to_string())
                    .with_status_code(code)
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                    .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap());
                let _ = req.respond(resp);
            }
        }));
        self.server = Some(server);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(s) = self.server.take() {
            s.unblock();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The request routing of `handle()`, given the current settings. `on_download`/`on_links` are
/// called for accepted payloads.
pub fn route(req: IntegrationRequest, settings: &Value, version: &str, on_download: impl FnOnce(Value), on_links: impl FnOnce(Value)) -> Answer {
    if !allowed(&req) {
        return (403, json!({ "error": "forbidden" }));
    }
    if req.method == "GET" && req.path == "/api/ping" {
        return (200, json!({ "app": "OpenDM", "version": version }));
    }
    if req.method == "GET" && req.path == "/api/config" {
        return (200, config(settings, version));
    }
    if req.method != "POST" {
        return (404, json!({ "error": "not found" }));
    }
    let Some(body) = req.body else { return (413, json!({ "error": "too large" })) };
    let Ok(data) = serde_json::from_slice::<Value>(&body) else { return (400, json!({ "error": "bad json" })) };
    if !js::truthy(&settings["general"]["browserIntegration"]) && !js::truthy(js::get(&data, "force")) {
        return (409, json!({ "error": "integration disabled" }));
    }
    if req.path == "/api/download" && js::get(&data, "url").is_string() {
        on_download(data);
        return (200, json!({ "ok": true }));
    }
    if req.path == "/api/links" && js::get(&data, "links").is_array() {
        on_links(data);
        return (200, json!({ "ok": true }));
    }
    (404, json!({ "error": "not found" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(origin: &str, x: &str, method: &str, path: &str, body: &str) -> IntegrationRequest {
        IntegrationRequest { method: method.into(), path: path.into(), origin: origin.into(), host: "127.0.0.1:52790".into(), x_opendm: x.into(), body: Some(body.as_bytes().to_vec()) }
    }

    #[test]
    fn only_extensions_with_the_header_get_in() {
        let s = crate::defaults::default_settings();
        let ok = |r| route(r, &s, "1", |_| {}, |_| {}).0;
        assert_eq!(ok(req("https://evil.com", "1", "GET", "/api/ping", "")), 403);
        assert_eq!(ok(req("chrome-extension://abc", "", "GET", "/api/ping", "")), 403);
        assert_eq!(ok(req("chrome-extension://abc", "1", "GET", "/api/ping", "")), 200);
        assert_eq!(ok(req("", "1", "POST", "/api/download", "{bad")), 400);
        assert_eq!(ok(req("moz-extension://x", "1", "POST", "/api/download", r#"{"url":"http://a/b"}"#)), 200);
        assert_eq!(ok(req("moz-extension://x", "1", "POST", "/api/nope", "{}")), 404);
        let mut rebound = req("", "1", "GET", "/api/config", "");
        rebound.host = "evil.com:52790".into();
        assert_eq!(ok(rebound), 403);
    }
}

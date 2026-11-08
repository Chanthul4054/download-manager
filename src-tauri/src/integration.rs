//! Localhost endpoint used by the browser extension (port of src/main/integration.js).
//! Requests must come from an extension origin and carry `X-OpenDM: 1`, which forces a CORS
//! preflight that we never approve — so ordinary web pages cannot drive the app.
//!
//! Any local program (also one run by another user) can still reach the port, so everything but
//! /api/ping and /api/pair needs `X-OpenDM-Token`: a per-install secret that a browser only gets
//! after the user allows it in a prompt (see `Pairing`).
//!
//! The socket runs on its own thread; each request is handed to the app core, which answers it.

use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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
    pub token: String,
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

/// Compares secrets without stopping at the first differing byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// The integration secret kept in `dir`, made on first use. If it cannot be saved, it lasts for
/// this run and browsers are asked again next time.
pub fn load_token(dir: &Path) -> String {
    let file = dir.join("integration.json");
    if let Some(t) = crate::util::read_json(&file).and_then(|v| v["token"].as_str().map(String::from)).filter(|t| t.len() == 64) {
        return t;
    }
    let mut b = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    let token = hex::encode(b);
    let _ = std::fs::create_dir_all(dir);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    if let Ok(mut f) = o.open(&file) {
        let _ = std::io::Write::write_all(&mut f, json!({ "token": token }).to_string().as_bytes());
    }
    token
}

const ASK_TIMEOUT: Duration = Duration::from_secs(120);
const DENY_COOLDOWN: Duration = Duration::from_secs(60);

/// A browser asking for the token. It polls /api/pair with a random nonce of its own; the user's
/// answer, and the token, go only to that nonce, so another local program polling cannot take
/// an approval meant for the browser. One prompt at a time, and a pause after a refusal, so a
/// program cannot flood the user with prompts.
#[derive(Default)]
pub struct Pairing {
    nonce: String,
    answer: Option<bool>,
    asked: Option<Instant>,
    denied: Option<Instant>,
}

impl Pairing {
    /// The reply to a poll, and whether the user must be asked now (then call `answer`).
    pub fn poll(&mut self, nonce: &str, token: &str, now: Instant) -> (Answer, bool) {
        if !(16..=128).contains(&nonce.len()) {
            return ((400, json!({ "error": "bad nonce" })), false);
        }
        if !self.nonce.is_empty() && same(&self.nonce, nonce) {
            let reply = match self.answer {
                Some(true) => (200, json!({ "token": token })),
                Some(false) => (403, json!({ "error": "denied" })),
                None => return ((202, json!({ "pending": true })), false),
            };
            self.nonce.clear();
            return (reply, false);
        }
        let open = self.answer.is_none() && !self.nonce.is_empty() && self.asked.is_some_and(|t| now.duration_since(t) < ASK_TIMEOUT);
        if open || self.denied.is_some_and(|t| now.duration_since(t) < DENY_COOLDOWN) {
            return ((429, json!({ "error": "busy" })), false);
        }
        *self = Pairing { nonce: nonce.to_string(), answer: None, asked: Some(now), denied: self.denied };
        ((202, json!({ "pending": true })), true)
    }

    pub fn answer(&mut self, nonce: &str, allow: bool, now: Instant) {
        if self.nonce == nonce {
            self.answer = Some(allow);
        }
        if !allow {
            self.denied = Some(now);
        }
    }
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
                    token: header("X-OpenDM-Token"),
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

/// The request routing of `handle()`, given the current settings and the integration token.
/// `on_pair` answers a pairing poll (given its nonce); `on_download`/`on_links` are called for
/// accepted payloads.
pub fn route(
    req: IntegrationRequest,
    settings: &Value,
    version: &str,
    token: &str,
    on_pair: impl FnOnce(&str) -> Answer,
    on_download: impl FnOnce(Value),
    on_links: impl FnOnce(Value),
) -> Answer {
    if !allowed(&req) {
        return (403, json!({ "error": "forbidden" }));
    }
    if req.method == "GET" && req.path == "/api/ping" {
        return (200, json!({ "app": "OpenDM", "version": version }));
    }
    if req.method == "POST" && req.path == "/api/pair" {
        if !js::truthy(&settings["general"]["browserIntegration"]) {
            return (409, json!({ "error": "integration disabled" }));
        }
        let data = req.body.as_deref().and_then(|b| serde_json::from_slice::<Value>(b).ok()).unwrap_or_default();
        return on_pair(&js::str_of(js::get(&data, "nonce")));
    }
    if token.is_empty() || !same(&req.token, token) {
        return (401, json!({ "error": "unpaired" }));
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
    // Browsers never hand over files from this computer; a local caller must not open one either.
    if req.path == "/api/download" && js::str_of(js::get(&data, "url")).trim_start().to_lowercase().starts_with("file:") {
        return (400, json!({ "error": "bad url" }));
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

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn req(origin: &str, x: &str, method: &str, path: &str, body: &str) -> IntegrationRequest {
        IntegrationRequest {
            method: method.into(),
            path: path.into(),
            origin: origin.into(),
            host: "127.0.0.1:52790".into(),
            x_opendm: x.into(),
            token: TOKEN.into(),
            body: Some(body.as_bytes().to_vec()),
        }
    }

    #[test]
    fn only_paired_extensions_with_the_header_get_in() {
        let s = crate::defaults::default_settings();
        let ok = |r| route(r, &s, "1", TOKEN, |_| (202, json!({})), |_| {}, |_| {}).0;
        let mut unpaired = req("chrome-extension://abc", "1", "GET", "/api/config", "");
        unpaired.token = "wrong".into();
        assert_eq!(ok(unpaired), 401);
        let mut pair = req("chrome-extension://abc", "1", "POST", "/api/pair", r#"{"nonce":"n"}"#);
        pair.token = String::new();
        assert_eq!(ok(pair), 202);
        let mut ping = req("chrome-extension://abc", "1", "GET", "/api/ping", "");
        ping.token = String::new();
        assert_eq!(ok(ping), 200);
        assert_eq!(ok(req("https://evil.com", "1", "GET", "/api/ping", "")), 403);
        assert_eq!(ok(req("chrome-extension://abc", "", "GET", "/api/ping", "")), 403);
        assert_eq!(ok(req("chrome-extension://abc", "1", "GET", "/api/ping", "")), 200);
        assert_eq!(ok(req("", "1", "POST", "/api/download", "{bad")), 400);
        assert_eq!(ok(req("moz-extension://x", "1", "POST", "/api/download", r#"{"url":"http://a/b"}"#)), 200);
        assert_eq!(ok(req("moz-extension://x", "1", "POST", "/api/nope", "{}")), 404);
        assert_eq!(ok(req("moz-extension://x", "1", "POST", "/api/download", r#"{"url":"file://host/s/x.torrent"}"#)), 400);
        let mut rebound = req("", "1", "GET", "/api/config", "");
        rebound.host = "evil.com:52790".into();
        assert_eq!(ok(rebound), 403);
    }
}

#[cfg(test)]
mod pairing_tests {
    use super::*;

    #[test]
    fn only_the_asking_nonce_gets_the_token_and_prompts_do_not_pile_up() {
        let (t, mut p) = (Instant::now(), Pairing::default());
        let n1 = "browser-nonce-0001";
        assert_eq!(p.poll("short", "T", t).0 .0, 400);
        assert_eq!(p.poll(n1, "T", t), ((202, json!({ "pending": true })), true));
        assert_eq!(p.poll(n1, "T", t), ((202, json!({ "pending": true })), false));
        // A second asker while the prompt is open is turned away, and learns nothing.
        assert_eq!(p.poll("intruder-nonce-0002", "T", t).0 .0, 429);

        p.answer(n1, true, t);
        assert_eq!(p.poll(n1, "T", t).0, (200, json!({ "token": "T" })));
        assert!(p.poll(n1, "T", t).1, "a used nonce starts over");

        let mut p = Pairing::default();
        p.poll(n1, "T", t);
        p.answer(n1, false, t);
        assert_eq!(p.poll(n1, "T", t).0 .0, 403);
        assert_eq!(p.poll("another-nonce-003", "T", t + Duration::from_secs(5)).0 .0, 429);
        assert!(p.poll("another-nonce-003", "T", t + DENY_COOLDOWN + Duration::from_secs(1)).1);
    }

    #[test]
    fn tokens_are_kept_between_runs() {
        let dir = std::env::temp_dir().join(format!("opendm-token-{}", std::process::id()));
        let a = load_token(&dir);
        assert_eq!(a.len(), 64);
        assert_eq!(load_token(&dir), a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

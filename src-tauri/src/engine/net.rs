//! HTTP(S) requests through the configured proxy (port of engine/net.js). Redirects and the
//! 401-then-credentials retry are handled here, one hop at a time, as before. Connections are
//! pooled per proxy (the JS version kept one keep-alive agent per proxy).

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::time::Duration;

use bytes::Bytes;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::sync::LazyLock;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::item::Auth;
use crate::js;
use crate::store::Store;
use crate::util::{decode_uri_component, host_matches, split_list, wildcard_match};

pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

pub type Signal = CancellationToken;

/// Response headers as Node exposes them: lower-case names, values read as latin1, repeated
/// headers joined with ", " except those Node keeps only once.
pub type Headers = HashMap<String, String>;

const SINGLE: &[&str] = &[
    "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host",
    "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards",
    "proxy-authorization", "referer", "retry-after", "server", "user-agent",
];

fn node_headers(h: &HeaderMap) -> Headers {
    let mut out: Headers = HashMap::new();
    for (k, v) in h {
        let name = k.as_str().to_string();
        let val: String = v.as_bytes().iter().map(|b| *b as char).collect();
        match out.get_mut(&name) {
            Some(existing) => {
                if !SINGLE.contains(&name.as_str()) {
                    existing.push_str(", ");
                    existing.push_str(&val);
                }
            }
            None => {
                out.insert(name, val);
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProxyKind {
    Direct,
    Http,
    Socks,
}

#[derive(Debug, Clone)]
pub struct Proxy {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub version: u8,
}

impl Proxy {
    fn direct() -> Proxy {
        Proxy { kind: ProxyKind::Direct, host: String::new(), port: 0, user: String::new(), pass: String::new(), version: 5 }
    }

    fn from_settings(kind: ProxyKind, p: &Value) -> Proxy {
        let port = js::num(js::get(p, "port"));
        Proxy {
            kind,
            host: js::s(js::get(p, "host")).to_string(),
            port: if port.is_finite() && port > 0.0 { port as u16 } else { 0 },
            user: js::str_of(js::get(p, "user")),
            pass: js::str_of(js::get(p, "pass")),
            version: if js::num(js::get(p, "version")) == 4.0 { 4 } else { 5 },
        }
    }
}

/// Parses PAC/Chromium resolveProxy output: "PROXY h:p; SOCKS5 h:p; DIRECT". An address may carry a
/// percent-encoded login ("PROXY user:pass@h:p"), as the proxy environment variables do.
pub fn parse_proxy_string(s: &str) -> Proxy {
    let s = if s.is_empty() { "DIRECT" } else { s };
    for part in s.split(';').map(|x| x.trim()).filter(|x| !x.is_empty()) {
        let mut it = part.split_whitespace();
        let kind = it.next().unwrap_or("");
        let addr = it.next();
        if kind.eq_ignore_ascii_case("DIRECT") {
            return Proxy::direct();
        }
        let Some(addr) = addr else { continue };
        let (login, addr) = addr.rsplit_once('@').unwrap_or(("", addr));
        let (user, pass) = login.split_once(':').unwrap_or((login, ""));
        let (user, pass) = (decode_uri_component(user).unwrap_or_default(), decode_uri_component(pass).unwrap_or_default());
        let i = addr.rfind(':').unwrap_or(addr.len());
        let host = addr[..i].to_string();
        let port = addr.get(i + 1..).and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
        let mk = |k: ProxyKind, version: u8| Proxy { kind: k, host: host.clone(), port, user: user.clone(), pass: pass.clone(), version };
        match kind.to_ascii_uppercase().as_str() {
            "PROXY" | "HTTP" | "HTTPS" => return mk(ProxyKind::Http, 5),
            "SOCKS" | "SOCKS5" => return mk(ProxyKind::Socks, 5),
            "SOCKS4" => return mk(ProxyKind::Socks, 4),
            _ => {}
        }
    }
    Proxy::direct()
}

pub type Resolver = Rc<dyn Fn(String) -> Pin<Box<dyn Future<Output = String>>>>;

#[derive(Default, Clone)]
pub struct ReqOpts {
    pub method: Option<reqwest::Method>,
    /// In insertion order; a later header replaces an earlier one with the same name.
    pub headers: Vec<(String, String)>,
    pub auth: Option<Auth>,
    pub signal: Option<Signal>,
    pub max_redirects: Option<u32>,
    pub timeout_sec: Option<f64>,
    pub body: Option<Vec<u8>>,
    pub max_bytes: Option<usize>,
}

impl ReqOpts {
    pub fn header(mut self, k: &str, v: &str) -> Self {
        set_header(&mut self.headers, k, v);
        self
    }
}

pub fn set_header(h: &mut Vec<(String, String)>, k: &str, v: &str) {
    // JS objects are keyed case-sensitively; HTTP is not. The last value for a name wins either way.
    h.retain(|(x, _)| !x.eq_ignore_ascii_case(k));
    h.push((k.to_string(), v.to_string()));
}

pub struct Response {
    pub status: u16,
    pub status_text: String,
    pub headers: Headers,
    pub url: String,
    pub redirects: u32,
    /// The request went to an HTTP forward proxy with the full address as its path.
    pub via_forward_proxy: bool,
    inner: Option<reqwest::Response>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|s| s.as_str())
    }

    /// The next body chunk; None at the end. Fails with an abort error when `signal` fires.
    pub async fn chunk(&mut self, signal: Option<&Signal>) -> Result<Option<Bytes>> {
        let Some(inner) = self.inner.as_mut() else { return Ok(None) };
        let read = inner.chunk();
        let r = match signal {
            Some(s) => tokio::select! {
                r = read => r,
                _ = s.cancelled() => return Err(Error::abort()),
            },
            None => read.await,
        };
        r.map_err(|e| map_err(&e, true, ""))
    }

    /// Closes the response (`res.destroy()` / `res.resume()`).
    pub fn destroy(&mut self) {
        self.inner = None;
    }
}

pub struct Fetched {
    pub body: Vec<u8>,
    pub headers: Headers,
    pub status: u16,
    pub url: String,
}

pub struct Probe {
    pub status: u16,
    pub size: Option<f64>,
    pub content_type: String,
    pub headers: Headers,
    pub url: String,
    pub resumable: bool,
}

pub struct NetContext {
    store: Rc<Store>,
    resolve_proxy: Option<Resolver>,
    clients: RefCell<HashMap<String, reqwest::Client>>,
}

static REALM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)realm="([^"]*)""#).unwrap());

impl NetContext {
    pub fn new(store: Rc<Store>, resolve_proxy: Option<Resolver>) -> Rc<NetContext> {
        Rc::new(NetContext { store, resolve_proxy, clients: RefCell::new(HashMap::new()) })
    }

    pub fn reset_agents(&self) {
        self.clients.borrow_mut().clear();
    }

    pub async fn proxy_for(&self, url_str: &str) -> Result<Proxy> {
        let s = self.store.s(&["proxy"]);
        let u = url::Url::parse(url_str)?;
        let host = u.host_str().unwrap_or("").to_string();
        let bypass = split_list(js::get(&s, "bypass"));
        if bypass.iter().any(|b| {
            if b == "<local>" {
                !host.contains('.')
            } else {
                host_matches(&Value::Array(vec![Value::String(b.clone())]), &host) || wildcard_match(&format!("{}*", b), url_str)
            }
        }) {
            return Ok(Proxy::direct());
        }
        let mode = js::s(js::get(&s, "mode"));
        if mode == "none" {
            return Ok(Proxy::direct());
        }
        if mode == "system" || mode == "pac" {
            let answer = match &self.resolve_proxy {
                Some(r) => r(url_str.to_string()).await,
                None => "DIRECT".into(),
            };
            return Ok(parse_proxy_string(&answer));
        }
        let socks = js::get(&s, "socks");
        if js::truthy(js::get(socks, "enabled")) && js::truthy(js::get(socks, "host")) {
            return Ok(Proxy::from_settings(ProxyKind::Socks, socks));
        }
        let p = match u.scheme() {
            "https" => js::get(&s, "https"),
            "ftp" => js::get(&s, "ftp"),
            _ => js::get(&s, "http"),
        };
        if js::truthy(js::get(p, "enabled")) && js::truthy(js::get(p, "host")) {
            return Ok(Proxy::from_settings(ProxyKind::Http, p));
        }
        Ok(Proxy::direct())
    }

    fn client_for(&self, proxy: &Proxy, timeout: Duration) -> Result<reqwest::Client> {
        let key = format!("{:?}|{}|{}|{}|{}|{}", proxy.kind, proxy.host, proxy.port, proxy.user, proxy.version, timeout.as_millis());
        if let Some(c) = self.clients.borrow().get(&key) {
            return Ok(c.clone());
        }
        let mut b = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout)
            .read_timeout(timeout)
            .http1_only()
            .http1_title_case_headers()
            .pool_max_idle_per_host(64)
            .no_proxy();
        match proxy.kind {
            ProxyKind::Direct => {}
            ProxyKind::Http => {
                let mut p = reqwest::Proxy::all(format!("http://{}:{}", proxy.host, proxy.port)).map_err(|e| Error::new(e.to_string()))?;
                if !proxy.user.is_empty() {
                    p = p.basic_auth(&proxy.user, &proxy.pass);
                }
                b = b.proxy(p);
            }
            ProxyKind::Socks => {
                // The proxy resolves host names, as the JS socks client sent them unresolved.
                let scheme = if proxy.version == 4 { "socks4a" } else { "socks5h" };
                let enc = |s: &str| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
                let auth = if proxy.user.is_empty() { String::new() } else { format!("{}:{}@", enc(&proxy.user), enc(&proxy.pass)) };
                let p = reqwest::Proxy::all(format!("{}://{}{}:{}", scheme, auth, proxy.host, proxy.port)).map_err(|e| Error::new(e.to_string()))?;
                b = b.proxy(p);
            }
        }
        let c = b.build().map_err(|e| Error::new(e.to_string()))?;
        self.clients.borrow_mut().insert(key, c.clone());
        Ok(c)
    }

    pub fn login_for(&self, url_str: &str) -> Option<Auth> {
        let u = url::Url::parse(url_str).ok()?;
        if !u.username().is_empty() {
            return Some(Auth {
                user: decode_uri_component(u.username()).unwrap_or_default(),
                pass: decode_uri_component(u.password().unwrap_or("")).unwrap_or_default(),
            });
        }
        let host = host_with_port(&u);
        let target = format!("{}{}", host, u.path());
        let logins = self.store.s(&["siteLogins"]);
        let list = logins.as_array().cloned().unwrap_or_default();
        list.iter()
            .find(|l| {
                let server = js::str_of(js::get(l, "server"));
                let pat = SCHEME_PREFIX.replace(&server, "").into_owned();
                wildcard_match(&pat, &host) || wildcard_match(&format!("{}*", pat), &target) || wildcard_match(&format!("*.{}", pat), &host)
            })
            .map(|l| Auth { user: js::str_of(js::get(l, "user")), pass: js::str_of(js::get(l, "pass")) })
    }

    /// Single HTTP(S) request following redirects. Resolves once the response headers arrive.
    pub async fn request(&self, url_str: &str, opts: &ReqOpts) -> Result<Response> {
        let max_redirects = opts.max_redirects.unwrap_or(10) as i64;
        let timeout_sec = match opts.timeout_sec {
            Some(t) if t > 0.0 => t,
            _ => js::num(&self.store.s(&["connection", "timeoutSec"])),
        };
        let timeout = Duration::from_millis((timeout_sec * 1000.0).max(1.0) as u64);
        let user_agent = js::str_of(&self.store.s(&["downloads", "userAgent"]));
        let mut url = url_str.to_string();
        let first = url::Url::parse(url_str).ok();
        let creds = opts.auth.clone().or_else(|| self.login_for(&url));
        let mut tried_auth = false;
        let mut method = opts.method.clone().unwrap_or(reqwest::Method::GET);
        let mut body = opts.body.as_ref();
        let mut hop: i64 = 0;
        while hop <= max_redirects {
            if opts.signal.as_ref().is_some_and(|s| s.is_cancelled()) {
                return Err(Error::abort());
            }
            let u = url::Url::parse(&url).map_err(|_| Error::with_code("Invalid URL", "ERR_INVALID_URL"))?;
            if u.scheme() != "http" && u.scheme() != "https" {
                return Err(Error::new(format!("Unsupported protocol {}:", u.scheme())));
            }
            let secure = u.scheme() == "https";
            let proxy = self.proxy_for(&url).await?;
            let mut h: Vec<(String, String)> = vec![
                ("User-Agent".into(), if user_agent.is_empty() { DEFAULT_UA.into() } else { user_agent.clone() }),
                ("Accept".into(), "*/*".into()),
                ("Accept-Encoding".into(), "identity".into()),
            ];
            // Credentials stay with the address they were given for: a redirect to another host, or
            // from https down to http, must not carry the caller's cookies or login.
            let same_site = first.as_ref().is_some_and(|f| f.host_str() == u.host_str() && (secure || f.scheme() != "https"));
            for (k, v) in &opts.headers {
                if !same_site && (k.eq_ignore_ascii_case("cookie") || k.eq_ignore_ascii_case("authorization")) {
                    continue;
                }
                set_header(&mut h, k, v);
            }
            if let Some(c) = creds.as_ref().filter(|_| same_site) {
                if tried_auth || opts.auth.is_some() {
                    set_header(&mut h, "Authorization", &basic(&c.user, &c.pass));
                }
            }
            let client = self.client_for(&proxy, timeout)?;
            let mut req = client.request(method.clone(), u.clone());
            let mut hm = HeaderMap::new();
            for (k, v) in &h {
                let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| Error::with_code(format!("Header name must be a valid HTTP token [\"{}\"]", k), "ERR_INVALID_HTTP_TOKEN"))?;
                hm.insert(name, header_value(k, v)?);
            }
            req = req.headers(hm);
            if let Some(b) = body {
                req = req.body(b.clone());
            }
            let send = req.send();
            let res = match &opts.signal {
                Some(s) => tokio::select! {
                    r = send => r,
                    _ = s.cancelled() => return Err(Error::abort()),
                },
                None => send.await,
            };
            let res = res.map_err(|e| map_err(&e, false, u.host_str().unwrap_or("")))?;
            let status = res.status().as_u16();
            let headers = node_headers(res.headers());
            if [301, 302, 303, 307, 308].contains(&status) {
                if let Some(loc) = headers.get("location").filter(|l| !l.is_empty()) {
                    let loc = latin1_url(loc);
                    url = u.join(&loc).map_err(|_| Error::with_code("Invalid URL", "ERR_INVALID_URL"))?.to_string();
                    // Browsers follow a redirected form post with a plain GET.
                    if status != 307 && status != 308 && method == reqwest::Method::POST {
                        method = reqwest::Method::GET;
                        body = None;
                    }
                    hop += 1;
                    continue;
                }
            }
            if status == 401 && creds.is_some() && same_site && !tried_auth {
                tried_auth = true;
                continue;
            }
            if status == 401 && creds.is_none() {
                let realm = headers.get("www-authenticate").and_then(|w| REALM.captures(w)).map(|c| c[1].to_string()).unwrap_or_default();
                let mut e = Error::with_code("Authorization required", "EAUTH");
                e.realm = Some(realm);
                return Err(e);
            }
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            return Ok(Response {
                status,
                status_text,
                headers,
                url,
                redirects: hop as u32,
                via_forward_proxy: proxy.kind == ProxyKind::Http && !secure,
                inner: Some(res),
            });
        }
        Err(Error::new("Too many redirects"))
    }

    /// Fetches a full (small) body — used by the grabber, HLS and probes.
    pub async fn fetch_buffer(&self, url: &str, opts: &ReqOpts) -> Result<Fetched> {
        let mut res = self.request(url, opts).await?;
        if res.status >= 400 {
            let mut e = Error::new(format!("HTTP {}", res.status));
            e.status = Some(res.status);
            return Err(e);
        }
        let limit = opts.max_bytes.unwrap_or(32 * 1024 * 1024);
        let mut body = Vec::new();
        while let Some(c) = res.chunk(opts.signal.as_ref()).await? {
            if body.len() + c.len() > limit {
                return Err(Error::new("Response too large"));
            }
            body.extend_from_slice(&c);
        }
        Ok(Fetched { body, headers: res.headers.clone(), status: res.status, url: res.url.clone() })
    }

    /// HEAD-like probe using a ranged GET (many servers mishandle HEAD).
    pub async fn probe(&self, url: &str, opts: &ReqOpts) -> Result<Probe> {
        let opts = opts.clone().header("Range", "bytes=0-");
        let res = self.request(url, &opts).await?;
        let h = &res.headers;
        let mut size = None;
        if res.status == 206 && h.contains_key("content-range") {
            let n = js::num(&Value::String(h["content-range"].split('/').nth(1).unwrap_or("").to_string()));
            size = if n == 0.0 || n.is_nan() { None } else { Some(n) };
        } else if let Some(cl) = h.get("content-length").filter(|c| !c.is_empty()) {
            size = Some(js::num(&Value::String(cl.clone())));
        }
        Ok(Probe {
            status: res.status,
            size,
            content_type: h.get("content-type").cloned().unwrap_or_default(),
            headers: res.headers.clone(),
            url: res.url.clone(),
            resumable: res.status == 206,
        })
    }
}

static SCHEME_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\w+://").unwrap());

/// `url.host` in JS: hostname plus a non-default port.
pub fn host_with_port(u: &url::Url) -> String {
    let h = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{}:{}", h, p),
        None => h.to_string(),
    }
}

fn basic(user: &str, pass: &str) -> String {
    use base64::Engine;
    "Basic ".to_string() + &base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass))
}

/// Header values are sent as latin1, like Node; characters above U+00FF are refused.
fn header_value(name: &str, v: &str) -> Result<HeaderValue> {
    let mut bytes = Vec::with_capacity(v.len());
    for c in v.chars() {
        let n = c as u32;
        if n > 0xFF || (n < 0x20 && n != 0x09) || n == 0x7F {
            return Err(Error::with_code(format!("Invalid character in header content [\"{}\"]", name), "ERR_INVALID_CHAR"));
        }
        bytes.push(n as u8);
    }
    HeaderValue::from_bytes(&bytes).map_err(|_| Error::with_code(format!("Invalid character in header content [\"{}\"]", name), "ERR_INVALID_CHAR"))
}

/// A Location header read as latin1 holds UTF-8 bytes when the server sent non-ASCII.
fn latin1_url(v: &str) -> String {
    let bytes: Vec<u8> = v.chars().map(|c| c as u32 as u8).collect();
    String::from_utf8(bytes).unwrap_or_else(|_| v.to_string())
}

/// Turns a client error into the message and code Node would have reported, so the UI text and
/// the retry/offline decisions that look at `code` stay the same.
pub fn map_err(e: &reqwest::Error, in_body: bool, host: &str) -> Error {
    let mut chain: Vec<String> = Vec::new();
    let mut io_kind = None;
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = src {
        chain.push(s.to_string());
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            io_kind.get_or_insert(io.kind());
        }
        src = s.source();
    }
    let all = chain.join(" | ").to_lowercase();
    if e.is_timeout() || io_kind == Some(std::io::ErrorKind::TimedOut) {
        return if in_body { Error::with_code("Read timed out", "ETIMEDOUT") } else { Error::with_code("Connection timed out", "ETIMEDOUT") };
    }
    if all.contains("dns error") || all.contains("failed to lookup address") || all.contains("no such host") {
        return Error::with_code(format!("getaddrinfo ENOTFOUND {}", host), "ENOTFOUND");
    }
    match io_kind {
        Some(std::io::ErrorKind::ConnectionRefused) => return Error::with_code(format!("connect ECONNREFUSED {}", host), "ECONNREFUSED"),
        Some(std::io::ErrorKind::ConnectionReset) | Some(std::io::ErrorKind::ConnectionAborted) => {
            return if in_body { Error::with_code("read ECONNRESET", "ECONNRESET") } else { Error::with_code("socket hang up", "ECONNRESET") };
        }
        _ => {}
    }
    if all.contains("certificate") || all.contains("invalid peer") || all.contains("tls") {
        if all.contains("expired") {
            return Error::with_code("certificate has expired", "CERT_HAS_EXPIRED");
        }
        if all.contains("unknownissuer") || all.contains("unknown issuer") {
            return Error::with_code("unable to get local issuer certificate", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
        }
        if all.contains("notvalidforname") || all.contains("not valid for name") {
            return Error::with_code(format!("Hostname/IP does not match certificate's altnames: Host: {}.", host), "ERR_TLS_CERT_ALTNAME_INVALID");
        }
        return Error::with_code(chain.last().cloned().unwrap_or_default(), "ERR_TLS");
    }
    if in_body || all.contains("closed before message completed") || all.contains("incomplete") || all.contains("end of file") {
        return if in_body { Error::with_code("aborted", "ECONNRESET") } else { Error::with_code("socket hang up", "ECONNRESET") };
    }
    Error::new(chain.last().cloned().unwrap_or_else(|| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_strings() {
        assert_eq!(parse_proxy_string("DIRECT").kind, ProxyKind::Direct);
        let p = parse_proxy_string("PROXY 10.0.0.1:3128; DIRECT");
        assert_eq!((p.kind, p.host.as_str(), p.port), (ProxyKind::Http, "10.0.0.1", 3128));
        let s = parse_proxy_string("SOCKS4 h:1080");
        assert_eq!((s.kind, s.version), (ProxyKind::Socks, 4));
        assert_eq!(parse_proxy_string("").kind, ProxyKind::Direct);
        let a = parse_proxy_string("PROXY alice:s%3Acret@proxy.corp:3128");
        assert_eq!((a.host.as_str(), a.port, a.user.as_str(), a.pass.as_str()), ("proxy.corp", 3128, "alice", "s:cret"));
    }

    #[test]
    fn repeated_headers_follow_node() {
        let mut h = HeaderMap::new();
        h.append("content-type", HeaderValue::from_static("a"));
        h.append("content-type", HeaderValue::from_static("b"));
        h.append("x-y", HeaderValue::from_static("1"));
        h.append("x-y", HeaderValue::from_static("2"));
        let n = node_headers(&h);
        assert_eq!(n["content-type"], "a");
        assert_eq!(n["x-y"], "1, 2");
    }
}

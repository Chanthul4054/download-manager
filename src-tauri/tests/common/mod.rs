//! Test helpers: a small HTTP/1.1 server (on its own thread) that can pace, truncate and redirect
//! responses, a port of bench/bench-server.js (now examples/bench_server.rs), and setup for a manager in a temporary folder.
#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use opendm_lib::emitter::Emitter;
use opendm_lib::engine::net::NetContext;
use opendm_lib::manager::{DownloadManager, MgrEvent};
use opendm_lib::store::Store;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Req {
    pub method: String,
    /// Path and query, e.g. "/file/100?rate=5".
    pub url: String,
    pub headers: HashMap<String, String>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_lowercase()).map(|s| s.as_str())
    }
    pub fn path(&self) -> &str {
        self.url.split('?').next().unwrap_or("")
    }
    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.url.split_once('?')?.1;
        url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }
    pub fn has_query(&self, key: &str) -> bool {
        self.query(key).is_some()
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
    /// Bytes sent per `delay_ms` (0 = all at once).
    pub chunk: usize,
    pub delay_ms: u64,
    /// Pace the connection to this many bytes per second (0 = unpaced).
    pub rate: u64,
    /// Close the socket after the body instead of finishing the response.
    pub cut: bool,
}

impl Resp {
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Resp {
        Resp { status, headers: Vec::new(), body: body.into(), chunk: 0, delay_ms: 0, rate: 0, cut: false }
    }
    pub fn header(mut self, k: &str, v: impl AsRef<[u8]>) -> Resp {
        self.headers.push((k.to_string(), v.as_ref().to_vec()));
        self
    }
    /// Node test servers' `slow()`: 64 KB every 15 ms (about 4 MB/s per connection).
    pub fn slow(mut self) -> Resp {
        self.chunk = 64 * 1024;
        self.delay_ms = 15;
        self
    }
}

pub type Handler = Arc<dyn Fn(&Req) -> Resp + Send + Sync>;

pub struct TestServer {
    pub base: String,
}

impl TestServer {
    pub fn start(handler: Handler) -> TestServer {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap().port()).unwrap();
                loop {
                    let Ok((sock, _)) = listener.accept().await else { continue };
                    let h = handler.clone();
                    tokio::spawn(async move {
                        let _ = serve_conn(sock, h).await;
                    });
                }
            });
        });
        let port = rx.recv().unwrap();
        TestServer { base: format!("http://127.0.0.1:{}", port) }
    }
}

async fn serve_conn(mut sock: tokio::net::TcpStream, h: Handler) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // Read one request head.
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let mut tmp = [0u8; 8192];
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        buf.drain(..head_end + 4);
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or("").split(' ');
        let method = first.next().unwrap_or("").to_string();
        let url = first.next().unwrap_or("").to_string();
        let mut headers = HashMap::new();
        for l in lines {
            if let Some((k, v)) = l.split_once(':') {
                headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
        let clen: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while buf.len() < clen {
            let mut tmp = [0u8; 8192];
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        buf.drain(..clen);
        let req = Req { method, url, headers };
        let r = h(&req);
        let mut out = format!("HTTP/1.1 {} {}\r\n", r.status, reason(r.status)).into_bytes();
        let mut has_len = false;
        for (k, v) in &r.headers {
            has_len |= k.eq_ignore_ascii_case("content-length");
            out.extend_from_slice(k.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(v);
            out.extend_from_slice(b"\r\n");
        }
        if !has_len {
            out.extend_from_slice(format!("Content-Length: {}\r\n", r.body.len()).as_bytes());
        }
        out.extend_from_slice(b"Connection: keep-alive\r\n\r\n");
        sock.write_all(&out).await?;
        let started = std::time::Instant::now();
        let chunk = if r.chunk > 0 { r.chunk } else if r.rate > 0 { 64 * 1024 } else { r.body.len().max(1) };
        let mut i = 0;
        while i < r.body.len() {
            if r.rate > 0 {
                // Pace this connection to `rate` bytes per second.
                let due = Duration::from_secs_f64(i as f64 / r.rate as f64);
                let el = started.elapsed();
                if due > el + Duration::from_millis(2) {
                    tokio::time::sleep(due - el).await;
                }
            }
            let end = (i + chunk).min(r.body.len());
            sock.write_all(&r.body[i..end]).await?;
            i = end;
            if r.delay_ms > 0 && i < r.body.len() {
                tokio::time::sleep(Duration::from_millis(r.delay_ms)).await;
            }
        }
        if r.cut {
            let _ = sock.shutdown().await;
            return Ok(());
        }
    }
}

fn reason(s: u16) -> &'static str {
    match s {
        200 => "OK",
        206 => "Partial Content",
        302 => "Found",
        403 => "Forbidden",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        429 => "Too Many Requests",
        _ => "Status",
    }
}

/// One request as the bench handler saw it (after its response was chosen).
#[derive(Clone, Debug)]
pub struct Logged {
    pub url: String,
    pub host: String,
    pub range: Option<String>,
    pub if_range: Option<String>,
    pub status: u16,
}

impl Logged {
    /// First byte asked for, from the Range header or a `range=a-b` query parameter.
    pub fn start(&self) -> Option<u64> {
        let r = self.range.as_deref().and_then(|r| r.strip_prefix("bytes=")).map(String::from).or_else(|| {
            let q = self.url.split_once('?')?.1;
            url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "range").map(|(_, v)| v.into_owned())
        })?;
        r.split('-').next()?.parse().ok()
    }
}

/// State shared by a `bench_handler_with` server: the request log, the version of each
/// `/versioned/<key>/` file and the targets `/althost/` alternates between.
#[derive(Default)]
pub struct BenchState {
    log: Mutex<Vec<Logged>>,
    versions: Mutex<HashMap<String, u64>>,
    pub hosts: Mutex<Vec<String>>,
    hops: Mutex<usize>,
}

impl BenchState {
    pub fn new() -> Arc<BenchState> {
        Arc::new(BenchState::default())
    }
    /// The file behind `/versioned/<key>/` changes: new bytes, ETag and Last-Modified.
    pub fn bump(&self, key: &str) {
        *self.versions.lock().unwrap().entry(key.to_string()).or_insert(0) += 1;
    }
    fn version(&self, key: &str) -> u64 {
        self.versions.lock().unwrap().get(key).copied().unwrap_or(0)
    }
    /// Logged requests whose address contains `needle`, oldest first.
    pub fn requests(&self, needle: &str) -> Vec<Logged> {
        self.log.lock().unwrap().iter().filter(|l| l.url.contains(needle)).cloned().collect()
    }
}

/// The bytes `/versioned/` serves at version `v` (version 0 is `data` itself).
pub fn version_bytes(data: &[u8], v: u64) -> Vec<u8> {
    data.iter().map(|b| b ^ (v as u8)).collect()
}

/// bench/bench-server.js (now examples/bench_server.rs): /file/<bytes>[?norange][&rate=][&badrange][&truncate],
/// /redirect/<n>/<rest>, /status/<code>, /flaky/<failures>/<code>/file/<bytes>. Every file is a prefix of `data`.
///
/// Test-only modes that examples/bench_server.rs does not have (yet):
/// - If-Range is evaluated on every Range request (an entity tag compares strongly, so `W/` never
///   matches; a date must equal Last-Modified). A mismatch answers 200 with the whole file.
/// - `?etag=<v>`: ETag `"<v>"`. `?weaketag`: the ETag is weak (`W/"…"`). `?etagbyhost`: the ETag
///   includes the Host header, like CDN edges that disagree.
/// - `?ignoreifrange`: honours Range and ignores If-Range. `?ifrange200`: answers 200 to every
///   request that carries If-Range (a server that mishandles it).
/// - `/versioned/<key>/…`: bytes, ETag and Last-Modified change with `BenchState::bump(key)`.
/// - `/althost/<rest>`: redirects to `BenchState::hosts` in turn (the first request to the first).
/// - `range=a-b` query parameter without a Range header: a googlevideo-style 200 with those bytes.
/// - `?badoverlap`: the first 64 bytes of a 206 that starts after 0 are wrong.
/// - `?cutevery=<n>`: every response closes the connection after `n` body bytes.
pub fn bench_handler(data: Arc<Vec<u8>>) -> Handler {
    bench_handler_with(data, BenchState::new())
}

pub fn bench_handler_with(data: Arc<Vec<u8>>, st: Arc<BenchState>) -> Handler {
    let inner = bench_responder(data, st.clone());
    Arc::new(move |req: &Req| {
        let r = inner(req);
        st.log.lock().unwrap().push(Logged {
            url: req.url.clone(),
            host: req.header("host").unwrap_or("").to_string(),
            range: req.header("range").map(String::from),
            if_range: req.header("if-range").map(String::from),
            status: r.status,
        });
        r
    })
}

fn bench_responder(data: Arc<Vec<u8>>, st: Arc<BenchState>) -> Handler {
    let flaky: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
    Arc::new(move |req: &Req| {
        let path = req.path().to_string();
        let mut parts: Vec<String> = path.split('/').filter(|s| !s.is_empty()).map(String::from).collect();
        let search = req.url.split_once('?').map(|(_, q)| format!("?{}", q)).unwrap_or_default();
        match parts.first().map(|s| s.as_str()) {
            Some("althost") => {
                let hosts = st.hosts.lock().unwrap().clone();
                let mut n = st.hops.lock().unwrap();
                let target = hosts[*n % hosts.len()].clone();
                *n += 1;
                return Resp::new(302, "").header("Location", format!("{}/{}{}", target, parts[1..].join("/"), search));
            }
            Some("redirect") => {
                let n: u32 = parts[1].parse().unwrap_or(1);
                let rest = parts[2..].join("/") + &search;
                let loc = if n > 1 { format!("/redirect/{}/{}", n - 1, rest) } else { format!("/{}", rest) };
                return Resp::new(302, "").header("Location", loc);
            }
            Some("status") => {
                let code: u16 = parts[1].parse().unwrap_or(500);
                let mut r = Resp::new(code, "");
                if code == 429 {
                    r = r.header("Retry-After", "1");
                }
                return r;
            }
            Some("flaky") => {
                let n = {
                    let mut f = flaky.lock().unwrap();
                    let e = f.entry(req.url.clone()).or_insert(0);
                    *e += 1;
                    *e
                };
                let fails: u32 = parts[1].parse().unwrap_or(0);
                let code: u16 = parts[2].parse().unwrap_or(500);
                if n <= fails {
                    let mut r = Resp::new(code, "");
                    if code == 429 {
                        r = r.header("Retry-After", "1");
                    }
                    return r;
                }
                parts.drain(..3);
            }
            _ => {}
        }
        let mut version = 0;
        if parts.first().map(|s| s.as_str()) == Some("versioned") && parts.len() > 2 {
            version = st.version(&parts[1]);
            parts.drain(..2);
        }
        if parts.first().map(|s| s.as_str()) != Some("file") {
            return Resp::new(404, "");
        }
        let size = parts[1].parse::<usize>().unwrap_or(0).min(data.len());
        let rate: u64 = req.query("rate").and_then(|r| r.parse().ok()).unwrap_or(0);
        let cut_every: Option<usize> = req.query("cutevery").and_then(|n| n.parse().ok());
        let bytes = |a: usize, b: usize| {
            let s = &data[a..=b];
            if version > 0 { version_bytes(s, version) } else { s.to_vec() }
        };
        let mut tag = req.query("etag").unwrap_or_else(|| if version > 0 { format!("{}-v{}", size, version) } else { size.to_string() });
        if req.has_query("etagbyhost") {
            tag = format!("{}@{}", tag, req.header("host").unwrap_or(""));
        }
        let etag = if req.has_query("weaketag") { format!("W/\"{}\"", tag) } else { format!("\"{}\"", tag) };
        let last_mod = format!("Mon, 01 Jan 2024 00:00:{:02} GMT", version % 60);
        let base = |r: Resp| r.header("Content-Type", "application/octet-stream").header("ETag", &etag).header("Last-Modified", &last_mod);
        // Close after `n` body bytes on every response.
        let cut_to = |r: &mut Resp| {
            if let Some(n) = cut_every.filter(|n| r.body.len() > *n) {
                r.body.truncate(n);
                r.cut = true;
            }
        };
        if let Some(q) = req.query("range").filter(|_| req.header("range").is_none() && size > 0) {
            let (a, b) = q.split_once('-').unwrap_or(("0", ""));
            let a: usize = a.parse().unwrap_or(0);
            let b: usize = b.parse::<usize>().unwrap_or(size - 1).min(size - 1);
            if a > b {
                return Resp::new(416, "");
            }
            let mut r = base(Resp::new(200, bytes(a, b)));
            r.rate = rate;
            cut_to(&mut r);
            return r;
        }
        let if_range_ok = match req.header("if-range") {
            None => true,
            Some(_) if req.has_query("ignoreifrange") => true,
            Some(_) if req.has_query("ifrange200") => false,
            Some(x) if x.starts_with('"') || x.starts_with("W/") => !x.starts_with("W/") && !etag.starts_with("W/") && x == etag,
            Some(x) => x == last_mod,
        };
        let range = req.header("range").and_then(|r| r.strip_prefix("bytes=")).map(|r| r.to_string());
        if let Some(rg) = range.filter(|_| !req.has_query("norange") && if_range_ok) {
            let (a, b) = rg.split_once('-').unwrap_or(("0", ""));
            let mut a: usize = a.parse().unwrap_or(0);
            let b: usize = if b.is_empty() { size - 1 } else { b.parse::<usize>().unwrap_or(size - 1).min(size - 1) };
            if a >= size {
                return Resp::new(416, "").header("Content-Range", format!("bytes */{}", size));
            }
            // A broken server that ignores the requested start but still answers 206.
            if req.has_query("badrange") {
                a = 0;
            }
            let mut slice = bytes(a, b);
            if req.has_query("badoverlap") && a > 0 {
                for x in slice.iter_mut().take(64) {
                    *x ^= 0xFF;
                }
            }
            let key = format!("cut:{}", req.url);
            let cut = req.has_query("truncate") && a == 0 && !flaky.lock().unwrap().contains_key(&key);
            if cut {
                flaky.lock().unwrap().insert(key, 1);
                slice.truncate(slice.len() / 2);
            }
            let mut r = base(Resp::new(206, slice))
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {}-{}/{}", a, b, size))
                .header("Content-Length", (b - a + 1).to_string());
            r.rate = rate;
            r.cut = cut;
            cut_to(&mut r);
            return r;
        }
        let key = format!("cut:{}", req.url);
        let cut = req.has_query("truncate") && !flaky.lock().unwrap().contains_key(&key);
        if cut {
            flaky.lock().unwrap().insert(key, 1);
        }
        let mut body = if size > 0 { bytes(0, size - 1) } else { Vec::new() };
        if cut {
            body.truncate(size / 2);
        }
        let mut r = base(Resp::new(200, body)).header("Content-Length", size.to_string());
        r.rate = rate;
        r.cut = cut;
        cut_to(&mut r);
        r
    })
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

/// Runs a test body on a single-threaded executor, as the app runs.
pub fn run<F: std::future::Future<Output = ()>>(f: F) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        tokio::time::timeout(Duration::from_secs(120), f).await.expect("test timed out");
    });
}

pub fn temp_dir(prefix: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("{}{}", prefix, opendm_lib::util::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub struct Env {
    pub dir: PathBuf,
    pub store: Rc<Store>,
    pub net: Rc<NetContext>,
    pub mgr: Rc<DownloadManager>,
}

/// A manager in a temporary folder: proxy off, files saved to <dir>/out.
pub fn setup(prefix: &str, patch: Value) -> Env {
    let dir = temp_dir(prefix);
    let store = Store::new(&dir.join("data"));
    {
        let mut s = store.settings.borrow_mut();
        s["saveTo"]["tempDir"] = json!(dir.join("tmp").to_string_lossy());
        s["proxy"]["mode"] = json!("none");
        s["connection"]["minSegmentKB"] = json!(128);
        let merged = opendm_lib::store::deep_merge(&s, &patch);
        *s = merged;
    }
    {
        let out = dir.join("out").to_string_lossy().into_owned();
        let mut c = store.categories.borrow_mut();
        for cat in c.as_array_mut().unwrap() {
            cat["folder"] = json!(out);
        }
    }
    let net = NetContext::new(store.clone(), None);
    let mgr = DownloadManager::new(store.clone(), net.clone());
    Env { dir, store, net, mgr }
}

/// The first event matching `pred`.
pub async fn once<E: Clone + 'static>(em: &Emitter<E>, pred: impl Fn(&E) -> bool + 'static) -> E {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = RefCell::new(Some(tx));
    let id = em.on(move |e| {
        if pred(e) {
            if let Some(t) = tx.borrow_mut().take() {
                let _ = t.send(e.clone());
            }
        }
    });
    let e = rx.await.unwrap();
    em.off(id);
    e
}

/// Resolves when download `id` completes (Ok(item)) or fails (Err(item)).
pub async fn finished(mgr: &DownloadManager, id: &str) -> Result<Value, Value> {
    let id = id.to_string();
    let id2 = id.clone();
    let e = once(&mgr.events, move |e| match e {
        MgrEvent::Complete(it) | MgrEvent::Failed(it, _) => it["id"] == json!(id2),
        _ => false,
    })
    .await;
    let _ = id;
    match e {
        MgrEvent::Complete(it) => Ok(it),
        MgrEvent::Failed(it, _) => Err(it),
        _ => unreachable!(),
    }
}

pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub fn read(path: &Value) -> Vec<u8> {
    std::fs::read(path.as_str().unwrap()).unwrap()
}

pub struct Watch(pub Rc<Cell<usize>>);

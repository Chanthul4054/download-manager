//! Test helpers: a small HTTP/1.1 server (on its own thread) that can pace, truncate and redirect
//! responses, a port of bench/bench-server.js, and setup for a manager in a temporary folder.
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

/// bench/bench-server.js: /file/<bytes>[?norange][&rate=][&badrange][&truncate], /redirect/<n>/<rest>,
/// /status/<code>, /flaky/<failures>/<code>/file/<bytes>. Every file is a prefix of `data`.
pub fn bench_handler(data: Arc<Vec<u8>>) -> Handler {
    let flaky: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
    Arc::new(move |req: &Req| {
        let path = req.path().to_string();
        let mut parts: Vec<String> = path.split('/').filter(|s| !s.is_empty()).map(String::from).collect();
        let search = req.url.split_once('?').map(|(_, q)| format!("?{}", q)).unwrap_or_default();
        match parts.first().map(|s| s.as_str()) {
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
        if parts.first().map(|s| s.as_str()) != Some("file") {
            return Resp::new(404, "");
        }
        let size = parts[1].parse::<usize>().unwrap_or(0).min(data.len());
        let rate: u64 = req.query("rate").and_then(|r| r.parse().ok()).unwrap_or(0);
        let body = &data[..size];
        let base = |r: Resp| r.header("Content-Type", "application/octet-stream").header("ETag", format!("\"{}\"", size)).header("Last-Modified", "Mon, 01 Jan 2024 00:00:00 GMT");
        let range = req.header("range").and_then(|r| r.strip_prefix("bytes=")).map(|r| r.to_string());
        if let Some(rg) = range.filter(|_| !req.has_query("norange")) {
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
            let slice = &body[a..=b];
            let key = format!("cut:{}", req.url);
            let cut = req.has_query("truncate") && a == 0 && !flaky.lock().unwrap().contains_key(&key);
            if cut {
                flaky.lock().unwrap().insert(key, 1);
            }
            let mut r = base(Resp::new(206, if cut { slice[..slice.len() / 2].to_vec() } else { slice.to_vec() }))
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {}-{}/{}", a, b, size))
                .header("Content-Length", (b - a + 1).to_string());
            r.rate = rate;
            r.cut = cut;
            return r;
        }
        let key = format!("cut:{}", req.url);
        let cut = req.has_query("truncate") && !flaky.lock().unwrap().contains_key(&key);
        if cut {
            flaky.lock().unwrap().insert(key, 1);
        }
        let mut r = base(Resp::new(200, if cut { body[..size / 2].to_vec() } else { body.to_vec() })).header("Content-Length", size.to_string());
        r.rate = rate;
        r.cut = cut;
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

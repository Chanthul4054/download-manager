//! Local test server for download benchmarks (port of bench/bench-server.js). Started as a child
//! process by download_bench so its CPU time is not counted against the downloader.
//!
//!   GET /file/<bytes>[?norange][&rate=<bytes per second per connection>][&badrange][&truncate]
//!   GET /hash/<bytes>                → sha256 of /file/<bytes>
//!   GET /redirect/<n>/<rest>         → n redirects, then /<rest>
//!   GET /status/<code>               → that status (429 sends Retry-After: 1)
//!   GET /flaky/<n>/<code>/file/<bytes> → the first n requests get <code>
//!
//! Every file is a prefix of one random buffer, so data written at a wrong offset fails the hash.
//! Prints "PORT <n>" on stdout once listening.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct State {
    data: Vec<u8>,
    hashes: Mutex<HashMap<usize, String>>,
    flaky: Mutex<HashMap<String, u32>>,
}

fn main() {
    let max: usize = std::env::var("BENCH_MAX_BYTES").ok().and_then(|v| v.parse().ok()).unwrap_or(512 * 1024 * 1024);
    let mut data = vec![0u8; max];
    rand::thread_rng().fill_bytes(&mut data);
    let st = Arc::new(State { data, hashes: Mutex::new(HashMap::new()), flaky: Mutex::new(HashMap::new()) });
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async move {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        println!("PORT {}", l.local_addr().unwrap().port());
        loop {
            let (s, _) = l.accept().await.unwrap();
            let st = st.clone();
            tokio::spawn(async move {
                let _ = conn(s, st).await;
            });
        }
    });
}

async fn conn(mut s: TcpStream, st: Arc<State>) -> std::io::Result<()> {
    s.set_nodelay(true)?;
    let mut buf = Vec::new();
    loop {
        let end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let mut t = [0u8; 4096];
            let n = s.read(&mut t).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&t[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..end]).into_owned();
        buf.drain(..end + 4);
        let mut lines = head.split("\r\n");
        let url = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
        let range = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("range"))
            .map(|(_, v)| v.trim().to_string());
        if !respond(&mut s, &st, &url, range).await? {
            return Ok(());
        }
    }
}

async fn head(s: &mut TcpStream, status: u16, headers: &[(&str, String)], len: usize) -> std::io::Result<()> {
    let mut h = format!("HTTP/1.1 {} X\r\n", status);
    for (k, v) in headers {
        h += &format!("{}: {}\r\n", k, v);
    }
    h += &format!("Content-Length: {}\r\nConnection: keep-alive\r\n\r\n", len);
    s.write_all(h.as_bytes()).await
}

/// Writes `body`, paced to `rate` bytes/sec when set. Returns false when the connection was cut.
async fn send(s: &mut TcpStream, body: &[u8], rate: u64, cut: bool) -> std::io::Result<bool> {
    const CH: usize = 64 * 1024;
    let started = Instant::now();
    let mut i = 0;
    while i < body.len() {
        if rate > 0 {
            let due = Duration::from_secs_f64(i as f64 / rate as f64);
            let el = started.elapsed();
            if due > el + Duration::from_millis(2) {
                tokio::time::sleep(due - el).await;
            }
        }
        let e = (i + CH).min(body.len());
        s.write_all(&body[i..e]).await?;
        i = e;
    }
    if cut {
        let _ = s.shutdown().await;
        return Ok(false);
    }
    Ok(true)
}

async fn respond(s: &mut TcpStream, st: &State, url: &str, range: Option<String>) -> std::io::Result<bool> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let q: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let has = |k: &str| q.iter().any(|(x, _)| x == k);
    let mut parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.first().copied() {
        Some("hash") => {
            let n: usize = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0).min(st.data.len());
            let h = st.hashes.lock().unwrap().entry(n).or_insert_with(|| hex::encode(Sha256::digest(&st.data[..n]))).clone();
            head(s, 200, &[], h.len()).await?;
            s.write_all(h.as_bytes()).await?;
            return Ok(true);
        }
        Some("redirect") => {
            let n: u32 = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(1);
            let rest = parts[2..].join("/") + if query.is_empty() { "" } else { "?" } + query;
            let loc = if n > 1 { format!("/redirect/{}/{}", n - 1, rest) } else { format!("/{}", rest) };
            head(s, 302, &[("Location", loc)], 0).await?;
            return Ok(true);
        }
        Some("status") => {
            let code: u16 = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(500);
            let h = if code == 429 { vec![("Retry-After", "1".to_string())] } else { vec![] };
            head(s, code, &h, 0).await?;
            return Ok(true);
        }
        Some("flaky") => {
            let n = {
                let mut f = st.flaky.lock().unwrap();
                let e = f.entry(url.to_string()).or_insert(0);
                *e += 1;
                *e
            };
            if n <= parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0) {
                let code: u16 = parts.get(2).and_then(|x| x.parse().ok()).unwrap_or(500);
                let h = if code == 429 { vec![("Retry-After", "1".to_string())] } else { vec![] };
                head(s, code, &h, 0).await?;
                return Ok(true);
            }
            parts.drain(..3);
        }
        _ => {}
    }
    if parts.first().copied() != Some("file") {
        head(s, 404, &[], 0).await?;
        return Ok(true);
    }
    let size: usize = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0).min(st.data.len());
    let rate: u64 = q.iter().find(|(k, _)| k == "rate").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let body = &st.data[..size];
    let base = vec![
        ("Content-Type", "application/octet-stream".to_string()),
        ("ETag", format!("\"{}\"", size)),
        ("Last-Modified", "Mon, 01 Jan 2024 00:00:00 GMT".to_string()),
    ];
    let cut_once = |key: String| -> bool {
        let mut f = st.flaky.lock().unwrap();
        if f.contains_key(&key) {
            false
        } else {
            f.insert(key, 1);
            true
        }
    };
    if let Some(r) = range.as_deref().and_then(|r| r.strip_prefix("bytes=")).filter(|_| !has("norange")) {
        let (a, b) = r.split_once('-').unwrap_or(("0", ""));
        let mut a: usize = a.parse().unwrap_or(0);
        let b: usize = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<usize>().unwrap_or(0).min(size.saturating_sub(1)) };
        if a >= size {
            head(s, 416, &[("Content-Range", format!("bytes */{}", size))], 0).await?;
            return Ok(true);
        }
        // A broken server that ignores the requested start but still answers 206.
        if has("badrange") {
            a = 0;
        }
        let slice = &body[a..=b];
        let cut = has("truncate") && a == 0 && cut_once(format!("cut:{}", url));
        let mut h = base.clone();
        h.push(("Accept-Ranges", "bytes".into()));
        h.push(("Content-Range", format!("bytes {}-{}/{}", a, b, size)));
        head(s, 206, &h, b - a + 1).await?;
        return send(s, if cut { &slice[..slice.len() / 2] } else { slice }, rate, cut).await;
    }
    let cut = has("truncate") && cut_once(format!("cut:{}", url));
    head(s, 200, &base, size).await?;
    send(s, if cut { &body[..size / 2] } else { body }, rate, cut).await
}

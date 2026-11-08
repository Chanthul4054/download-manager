//! Downloads through local HTTP and SOCKS5 proxies and a PAC script. The file's host
//! (`files.test`) does not exist, so a download only succeeds if it really went through the proxy.

mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(4 * MB)));
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler(DATA.clone())));

fn upstream() -> String {
    SRV.base.trim_start_matches("http://").to_string()
}

/// Runs `serve` for every connection on a background runtime; returns the port.
fn listen<F, Fut>(serve: F) -> u16
where
    F: Fn(TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(l.local_addr().unwrap().port()).unwrap();
            loop {
                let (s, _) = l.accept().await.unwrap();
                tokio::spawn(serve(s));
            }
        });
    });
    rx.recv().unwrap()
}

/// An HTTP forward proxy (absolute-form requests). With `auth`, it wants that Basic credential.
fn http_proxy(hits: Arc<AtomicU32>, auth: Option<&'static str>) -> u16 {
    let up = upstream();
    listen(move |mut c| {
        let (hits, up) = (hits.clone(), up.clone());
        async move {
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if c.read(&mut b).await.unwrap_or(0) == 0 {
                    return;
                }
                head.push(b[0]);
            }
            let text = String::from_utf8_lossy(&head).into_owned();
            let mut lines = text.split("\r\n");
            let req = lines.next().unwrap_or("");
            let mut parts = req.split(' ');
            let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            if let Some(want) = auth {
                let ok = text.lines().any(|l| l.to_ascii_lowercase().starts_with("proxy-authorization:") && l.ends_with(&format!("Basic {}", b64(want))));
                if !ok {
                    let _ = c.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
            }
            let Some(rest) = target.strip_prefix("http://files.test") else {
                let _ = c.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                return;
            };
            hits.fetch_add(1, Ordering::SeqCst);
            let mut out = format!("{method} {rest} HTTP/1.1\r\n");
            for l in lines.filter(|l| !l.is_empty()) {
                let k = l.split(':').next().unwrap_or("").to_ascii_lowercase();
                if !["connection", "proxy-connection", "proxy-authorization"].contains(&k.as_str()) {
                    out += &format!("{l}\r\n");
                }
            }
            out += "Connection: close\r\n\r\n";
            let Ok(mut u) = TcpStream::connect(&up).await else { return };
            if u.write_all(out.as_bytes()).await.is_ok() {
                let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
            }
        }
    })
}

/// A SOCKS5 proxy (no auth, CONNECT) that sends every connection for files.test to the server.
fn socks5_proxy(hits: Arc<AtomicU32>) -> u16 {
    let up = upstream();
    listen(move |mut c| {
        let (hits, up) = (hits.clone(), up.clone());
        async move {
            let mut g = [0u8; 2];
            if c.read_exact(&mut g).await.is_err() || g[0] != 5 {
                return;
            }
            let mut m = vec![0u8; g[1] as usize];
            let _ = c.read_exact(&mut m).await;
            let _ = c.write_all(&[5, 0]).await;
            let mut r = [0u8; 4];
            if c.read_exact(&mut r).await.is_err() || r[1] != 1 {
                return;
            }
            let host = match r[3] {
                3 => {
                    let mut n = [0u8; 1];
                    let _ = c.read_exact(&mut n).await;
                    let mut h = vec![0u8; n[0] as usize];
                    let _ = c.read_exact(&mut h).await;
                    String::from_utf8_lossy(&h).into_owned()
                }
                1 => {
                    let mut a = [0u8; 4];
                    let _ = c.read_exact(&mut a).await;
                    std::net::Ipv4Addr::from(a).to_string()
                }
                _ => return,
            };
            let mut port = [0u8; 2];
            let _ = c.read_exact(&mut port).await;
            if host != "files.test" {
                let _ = c.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return;
            }
            hits.fetch_add(1, Ordering::SeqCst);
            let Ok(mut u) = TcpStream::connect(&up).await else { return };
            let _ = c.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await;
            let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
        }
    })
}

fn b64(s: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b = s.as_bytes();
    let mut o = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            o.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    o
}

/// `paced`: 1 MB/s per connection, so the download lasts long enough to open several connections.
async fn get_through(env: &Env, n: usize, paced: bool) -> Result<Value, Value> {
    let q = if paced { "?rate=1048576" } else { "" };
    let id = env.mgr.add(&json!({ "url": format!("http://files.test/file/{n}{q}") })).unwrap()["item"]["id"].as_str().unwrap().to_string();
    let end = finished(&env.mgr, &id);
    env.mgr.start(&id);
    end.await
}

fn manual(kind: &str, port: u16, extra: Value) -> Value {
    let mut p = json!({ "mode": "manual", "bypass": "" });
    p[kind] = json!({ "enabled": true, "host": "127.0.0.1", "port": port });
    if let (Some(t), Some(x)) = (p[kind].as_object_mut(), extra.as_object()) {
        t.extend(x.clone());
    }
    json!({ "proxy": p, "connection": { "maxConnections": 4, "connectionRetries": 1 } })
}

#[test]
fn a_download_through_an_http_proxy_is_intact() {
    run(async {
        let hits = Arc::new(AtomicU32::new(0));
        let port = http_proxy(hits.clone(), None);
        let env = setup("odm-proxy-", manual("http", port, json!({})));
        let it = get_through(&env, 4 * MB, true).await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..]);
        assert!(hits.load(Ordering::SeqCst) >= 2, "several connections went through the proxy");
        env.mgr.dispose();
    });
}

#[test]
fn an_http_proxy_that_wants_a_login_gets_it_and_refuses_without() {
    run(async {
        let hits = Arc::new(AtomicU32::new(0));
        let port = http_proxy(hits.clone(), Some("user:pa ss"));
        let env = setup("odm-proxy-", manual("http", port, json!({ "user": "user", "pass": "pa ss" })));
        let it = get_through(&env, MB, false).await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..MB]);
        env.mgr.dispose();

        let env = setup("odm-proxy-", manual("http", port, json!({ "user": "user", "pass": "wrong" })));
        let it = get_through(&env, MB, false).await.expect_err("a wrong proxy password must fail");
        assert!(it["error"].as_str().unwrap_or("").contains("407"), "{}", it["error"]);
        env.mgr.dispose();
    });
}

#[test]
fn a_download_through_a_socks5_proxy_is_intact() {
    run(async {
        let hits = Arc::new(AtomicU32::new(0));
        let port = socks5_proxy(hits.clone());
        let env = setup("odm-proxy-", manual("socks", port, json!({ "version": 5, "proxyDns": true })));
        let it = get_through(&env, 4 * MB, true).await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..]);
        assert!(hits.load(Ordering::SeqCst) >= 2);
        env.mgr.dispose();
    });
}

/// PAC goes through Windows' resolver (WinHTTP), as in the app.
#[cfg(windows)]
#[test]
fn a_pac_script_sends_downloads_to_its_proxy() {
    run(async {
        let hits = Arc::new(AtomicU32::new(0));
        let port = http_proxy(hits.clone(), None);
        let pac = format!("function FindProxyForURL(url, host) {{ return host == 'files.test' ? 'PROXY 127.0.0.1:{port}' : 'DIRECT'; }}");
        let pac_srv = TestServer::start(Arc::new(move |_r: &Req| Resp::new(200, pac.clone().into_bytes()).header("Content-Type", "application/x-ns-proxy-autoconfig")));
        let pac_url = format!("{}/proxy.pac", pac_srv.base);
        let env = setup("odm-proxy-", json!({ "proxy": { "mode": "pac", "pacUrl": pac_url, "bypass": "" }, "connection": { "maxConnections": 4, "connectionRetries": 1 } }));
        let answer = opendm_lib::engine::proxy_resolver::resolve("http://files.test/file/1".into(), "pac".into(), pac_url.clone()).await;
        assert_eq!(answer, format!("PROXY 127.0.0.1:{port}"));
        let resolver: opendm_lib::engine::net::Resolver = Rc::new(move |url: String| {
            let pac = pac_url.clone();
            Box::pin(async move { opendm_lib::engine::proxy_resolver::resolve(url, "pac".into(), pac).await })
        });
        let net = opendm_lib::engine::net::NetContext::new(env.store.clone(), Some(resolver));
        let mgr = opendm_lib::manager::DownloadManager::new(env.store.clone(), net);
        let id = mgr.add(&json!({ "url": format!("http://files.test/file/{}", 2 * MB) })).unwrap()["item"]["id"].as_str().unwrap().to_string();
        let end = finished(&mgr, &id);
        mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..2 * MB]);
        assert!(hits.load(Ordering::SeqCst) >= 1);
        mgr.dispose();
        env.mgr.dispose();
    });
}

use std::rc::Rc;

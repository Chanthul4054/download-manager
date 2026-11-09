//! FTP downloads against a minimal local FTP server: a multi-segment download, and resuming after
//! a crash when the temp file is gone or shorter than the saved list says.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(6 * MB)));

/// Serves DATA as /file.bin: USER, PASS, TYPE, SIZE, MDTM, EPSV, REST, RETR, QUIT. Each data
/// connection is paced to `rate` bytes per second (0 = unpaced).
fn ftp_server(rate: u64) -> u16 {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(l.local_addr().unwrap().port()).unwrap();
            loop {
                let (s, _) = l.accept().await.unwrap();
                tokio::spawn(session(s, rate));
            }
        });
    });
    rx.recv().unwrap()
}

async fn session(s: tokio::net::TcpStream, rate: u64) {
    let (r, mut w) = s.into_split();
    let mut lines = BufReader::new(r).lines();
    let _ = w.write_all(b"220 test ftp\r\n").await;
    let mut rest = 0usize;
    let mut pasv: Option<TcpListener> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let (cmd, arg) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        let reply = match cmd.to_ascii_uppercase().as_str() {
            "USER" => "331 password please".to_string(),
            "PASS" => "230 logged in".into(),
            "TYPE" => "200 type set".into(),
            "SIZE" => format!("213 {}", DATA.len()),
            "MDTM" => "213 20260101000000".into(),
            "REST" => {
                rest = arg.trim().parse().unwrap_or(0);
                format!("350 restarting at {rest}")
            }
            "EPSV" => {
                let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let p = l.local_addr().unwrap().port();
                pasv = Some(l);
                format!("229 Entering Extended Passive Mode (|||{p}|)")
            }
            "RETR" => {
                let Some(l) = pasv.take() else { continue };
                let _ = w.write_all(b"150 sending\r\n").await;
                if let Ok((mut d, _)) = l.accept().await {
                    let mut at = rest;
                    let t0 = std::time::Instant::now();
                    while at < DATA.len() {
                        let n = (64 * 1024).min(DATA.len() - at);
                        if d.write_all(&DATA[at..at + n]).await.is_err() {
                            break;
                        }
                        at += n;
                        if rate > 0 {
                            let due = std::time::Duration::from_secs_f64((at - rest) as f64 / rate as f64);
                            if let Some(wait) = due.checked_sub(t0.elapsed()) {
                                tokio::time::sleep(wait).await;
                            }
                        }
                    }
                    let _ = d.shutdown().await;
                }
                rest = 0;
                "226 done".into()
            }
            "QUIT" => {
                let _ = w.write_all(b"221 bye\r\n").await;
                return;
            }
            _ => "502 not implemented".into(),
        };
        if w.write_all(format!("{reply}\r\n").as_bytes()).await.is_err() {
            return;
        }
    }
}

fn settings() -> Value {
    json!({ "connection": { "maxConnections": 4, "checkpointSec": 1, "connectionRetries": 3 } })
}

fn add(env: &Env, port: u16) -> String {
    env.mgr.add(&json!({ "url": format!("ftp://127.0.0.1:{port}/file.bin") })).unwrap()["item"]["id"].as_str().unwrap().to_string()
}

fn saved_progress(it: &Value) -> u64 {
    it["segments"].as_array().map(|s| s.iter().map(|s| s["pos"].as_u64().unwrap() - s["start"].as_u64().unwrap()).sum()).unwrap_or(0)
}

#[test]
fn an_ftp_download_with_several_connections_is_intact() {
    run(async {
        let port = ftp_server(0);
        let env = setup("odm-ftp-", settings());
        let id = add(&env, port);
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..]);
        env.mgr.dispose();
    });
}

fn ftp_crash_and_resume(damage: impl FnOnce(&std::path::Path)) {
    run(async {
        let port = ftp_server(256 * 1024);
        let env = setup("odm-ftp-", settings());
        let id = add(&env, port);
        env.mgr.start(&id);
        let list = env.store.file("downloads");
        let (text, snap) = loop {
            sleep(200).await;
            let Ok(t) = std::fs::read_to_string(&list) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
            if let Some(it) = v.as_array().and_then(|a| a.iter().find(|x| x["id"] == json!(id))) {
                if saved_progress(it) > MB as u64 {
                    break (t.clone(), it.clone());
                }
            }
        };
        sleep(800).await;
        env.mgr.stop_all();
        env.mgr.wait_stopped(&id).await;
        env.mgr.dispose();
        env.store.flush_all().await;
        std::fs::write(&list, &text).unwrap();
        damage(&PathBuf::from(snap["tempPath"].as_str().unwrap()));

        let store = opendm_lib::store::Store::new(&env.dir.join("data"));
        let net = opendm_lib::engine::net::NetContext::new(store.clone(), None);
        let mgr = opendm_lib::manager::DownloadManager::new(store.clone(), net);
        let end = finished(&mgr, &id);
        mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..], "resumed FTP file differs from the server copy");
        mgr.dispose();
    });
}

#[test]
fn an_ftp_download_resumes_intact_when_its_temp_file_is_gone() {
    ftp_crash_and_resume(|t| std::fs::remove_file(t).unwrap());
}

#[test]
fn an_ftp_download_resumes_intact_when_its_temp_file_is_short() {
    ftp_crash_and_resume(|t| std::fs::OpenOptions::new().write(true).open(t).unwrap().set_len(MB as u64 / 2).unwrap());
}

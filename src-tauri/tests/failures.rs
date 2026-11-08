//! Failure paths and crash recovery against a local server: HTTP errors, lying or stalling
//! servers, bad destinations, and resuming from the on-disk list after an unclean exit.

mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use common::*;
use serde_json::{json, Value};

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(8 * MB)));
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler(DATA.clone())));

fn add(env: &Env, url: String, extra: Value) -> String {
    let mut o = json!({ "url": url });
    if let (Some(t), Some(x)) = (o.as_object_mut(), extra.as_object()) {
        t.extend(x.clone());
    }
    env.mgr.add(&o).unwrap()["item"]["id"].as_str().unwrap().to_string()
}

async fn download(env: &Env, url: String, extra: Value) -> Result<Value, Value> {
    let id = add(env, url, extra);
    let end = finished(&env.mgr, &id);
    env.mgr.start(&id);
    end.await
}

#[test]
fn http_403_fails_with_the_status_in_the_error() {
    run(async {
        let env = setup("odm-fail-", json!({ "connection": { "connectionRetries": 2 } }));
        let it = download(&env, format!("{}/status/403", SRV.base), json!({})).await.expect_err("403 must fail");
        assert!(it["error"].as_str().unwrap().contains("403"), "{}", it["error"]);
        assert_ne!(it["status"], json!("complete"));
        env.mgr.dispose();
    });
}

#[test]
fn a_transient_500_is_retried_and_the_file_is_intact() {
    run(async {
        let env = setup("odm-fail-", json!({ "connection": { "maxConnections": 4 } }));
        let it = download(&env, format!("{}/flaky/1/500/file/{}", SRV.base, 2 * MB), json!({})).await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..2 * MB]);
        env.mgr.dispose();
    });
}

#[test]
fn a_persistent_500_gives_up_after_the_retry_limit() {
    run(async {
        let env = setup("odm-fail-", json!({ "connection": { "connectionRetries": 1 } }));
        let t0 = Instant::now();
        let it = download(&env, format!("{}/status/500", SRV.base), json!({})).await.expect_err("500 must fail");
        assert!(it["error"].as_str().unwrap().contains("500"), "{}", it["error"]);
        assert!(t0.elapsed().as_secs() < 20, "took {:?}", t0.elapsed());
        env.mgr.dispose();
    });
}

#[test]
fn a_server_that_always_sends_less_than_its_content_length_is_never_marked_complete() {
    run(async {
        // No range support and every response cut in half: there is no way to finish the file.
        let srv = TestServer::start(Arc::new(|_req: &Req| {
            let mut r = Resp::new(200, vec![7u8; 512 * 1024]).header("Content-Length", (MB).to_string());
            r.cut = true;
            r
        }));
        let env = setup("odm-fail-", json!({ "connection": { "connectionRetries": 1, "maxConnections": 4 } }));
        let it = download(&env, format!("{}/short.bin", srv.base), json!({})).await.expect_err("short body must not complete");
        assert_ne!(it["status"], json!("complete"));
        env.mgr.dispose();
    });
}

#[test]
fn a_connection_that_stalls_times_out_and_is_retried() {
    run(async {
        let hits = Arc::new(AtomicU32::new(0));
        let h = hits.clone();
        let body = Arc::new(DATA[..MB].to_vec());
        let srv = TestServer::start(Arc::new(move |_req: &Req| {
            let mut r = Resp::new(200, body.to_vec());
            if h.fetch_add(1, Ordering::SeqCst) == 0 {
                // First request: 16 KB, then silence for a minute.
                r.chunk = 16 * 1024;
                r.delay_ms = 60_000;
            }
            r
        }));
        let env = setup("odm-fail-", json!({ "connection": { "timeoutSec": 2, "maxConnections": 1 } }));
        let t0 = Instant::now();
        let it = download(&env, format!("{}/stall.bin", srv.base), json!({})).await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(t0.elapsed().as_secs() < 30, "took {:?}", t0.elapsed());
        assert!(hits.load(Ordering::SeqCst) >= 2);
        assert!(read(&it["savedPath"]) == DATA[..MB]);
        env.mgr.dispose();
    });
}

#[test]
fn an_unreachable_host_fails_with_a_useful_error() {
    run(async {
        let env = setup("odm-fail-", json!({ "connection": { "connectionRetries": 1 } }));
        // Port 1 on loopback: connection refused.
        let it = download(&env, "http://127.0.0.1:1/file.bin".into(), json!({})).await.expect_err("must fail");
        assert!(!it["error"].as_str().unwrap_or("").is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn an_invalid_url_is_rejected_when_added() {
    run(async {
        let env = setup("odm-fail-", json!({}));
        assert!(env.mgr.add(&json!({ "url": "not a url" })).is_err());
        assert!(env.mgr.add(&json!({ "url": "" })).is_err());
        env.mgr.dispose();
    });
}

#[test]
fn a_save_folder_that_cannot_be_created_fails_instead_of_hanging() {
    run(async {
        let env = setup("odm-fail-", json!({}));
        // A file where the folder should be.
        let blocker = env.dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let dest = blocker.join("sub");
        let it = download(&env, format!("{}/file/{}", SRV.base, MB), json!({ "saveDir": dest.to_string_lossy() })).await.expect_err("must fail");
        assert!(!it["error"].as_str().unwrap_or("").is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn spaces_and_unicode_in_the_url_path_name_the_file() {
    run(async {
        let env = setup("odm-fail-", json!({}));
        let srv = TestServer::start(bench_handler_alias());
        let it = download(&env, format!("{}/%D0%BE%D1%82%D1%87%D1%91%D1%82%20%E2%84%962%20%F0%9F%93%A6.bin", srv.base), json!({}))
            .await
            .unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_eq!(it["fileName"], json!("отчёт №2 📦.bin"));
        assert!(std::path::Path::new(it["savedPath"].as_str().unwrap()).exists());
        assert!(read(&it["savedPath"]) == DATA[..MB]);
        env.mgr.dispose();
    });
}

/// Any path serves the first MB of DATA with range support.
fn bench_handler_alias() -> Handler {
    let inner = bench_handler(DATA.clone());
    Arc::new(move |req: &Req| {
        let fake = Req { method: req.method.clone(), url: format!("/file/{}", MB), headers: req.headers.clone() };
        inner(&fake)
    })
}

#[test]
fn after_an_unclean_exit_the_saved_list_resumes_and_the_file_is_intact() {
    run(async {
        let env = setup("odm-fail-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 6 * MB;
        let id = add(&env, format!("{}/file/{}?rate={}", SRV.base, size, 512 * 1024), json!({}));
        env.mgr.start(&id);
        // Let the periodic save capture partial progress, then snapshot the list as a crash would leave it.
        let list = env.store.file("downloads");
        let snapshot = loop {
            sleep(500).await;
            if let Ok(t) = std::fs::read_to_string(&list) {
                let v: Value = serde_json::from_str(&t).unwrap();
                let pos: u64 = v[0]["segments"].as_array().map(|s| s.iter().map(|s| s["pos"].as_u64().unwrap() - s["start"].as_u64().unwrap()).sum()).unwrap_or(0);
                if pos > 0 {
                    break t;
                }
            }
        };
        // The file on disk is now ahead of the saved list, as after a crash.
        sleep(1500).await;
        env.mgr.stop_all();
        env.mgr.wait_stopped(&id).await;
        env.mgr.dispose();
        env.store.flush_all().await;
        std::fs::write(&list, &snapshot).unwrap();

        // "Restart": a new store and manager over the same folder.
        let store = opendm_lib::store::Store::new(&env.dir.join("data"));
        let net = opendm_lib::engine::net::NetContext::new(store.clone(), None);
        let mgr = opendm_lib::manager::DownloadManager::new(store.clone(), net);
        let item = mgr.get(&id).expect("download restored");
        assert_eq!(item.borrow().status, "paused", "a download that was running comes back paused");
        assert!(item.borrow().downloaded > 0 || item.borrow().segments_downloaded() > 0);
        let end = finished(&mgr, &id);
        mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..size], "resumed file differs from the server copy");
        mgr.dispose();
    });
}

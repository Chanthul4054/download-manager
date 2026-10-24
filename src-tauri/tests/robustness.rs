//! Port of test/robustness.test.js (against the bench server's behaviors).

mod common;

use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::{json, Value};

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(16 * MB)));
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler(DATA.clone())));

fn add(env: &Env, url: String, extra: Value) -> String {
    let mut o = json!({ "url": url });
    if let (Some(t), Some(x)) = (o.as_object_mut(), extra.as_object()) {
        t.extend(x.clone());
    }
    env.mgr.add(&o).unwrap()["item"]["id"].as_str().unwrap().to_string()
}

fn matches_prefix(item: &Value, bytes: usize) -> bool {
    read(&item["savedPath"]) == DATA[..bytes]
}

#[test]
fn a_206_with_the_wrong_byte_range_falls_back_to_one_connection_instead_of_corrupting_the_file() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?badrange&rate={}", SRV.base, size, 4 * MB), json!({}));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size), "file content differs from the server copy");
        env.mgr.dispose();
    });
}

#[test]
fn a_dropped_connection_is_resumed_and_the_file_is_intact() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 1 } }));
        let size = 4 * MB;
        let id = add(&env, format!("{}/file/{}?truncate", SRV.base, size), json!({}));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        env.mgr.dispose();
    });
}

#[test]
fn http_429_waits_for_retry_after_and_then_succeeds() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 1 } }));
        let size = MB;
        let id = add(&env, format!("{}/flaky/1/429/file/{}", SRV.base, size), json!({}));
        let end = finished(&env.mgr, &id);
        let t0 = std::time::Instant::now();
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(t0.elapsed().as_millis() >= 900, "retried before Retry-After elapsed");
        assert!(matches_prefix(&it, size));
        env.mgr.dispose();
    });
}

#[test]
fn a_permanent_404_fails_without_retrying_forever() {
    run(async {
        let env = setup("odm-rob-", json!({}));
        let id = add(&env, format!("{}/status/404", SRV.base), json!({}));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.expect_err("should fail");
        assert!(it["error"].as_str().unwrap().contains("404"), "{}", it["error"]);
        env.mgr.dispose();
    });
}

#[test]
fn max_simultaneous_limits_running_downloads_the_rest_wait_and_then_finish() {
    run(async {
        let env = setup("odm-rob-", json!({ "downloads": { "maxSimultaneous": 2 }, "connection": { "maxConnections": 2 } }));
        let ids: Vec<String> = (0..5).map(|i| add(&env, format!("{}/file/{}?rate={}", SRV.base, MB + i, 8 * MB), json!({}))).collect();
        let peak = std::rc::Rc::new(std::cell::Cell::new(0usize));
        let (p, m) = (peak.clone(), env.mgr.clone());
        let watch = tokio::task::spawn_local(async move {
            loop {
                p.set(p.get().max(m.active_count()));
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        });
        let mut ends = Vec::new();
        for id in &ids {
            ends.push(Box::pin(finished(&env.mgr, id)));
        }
        // Register every listener before any download can finish.
        for e in ends.iter_mut() {
            let _ = futures_poll_once(e.as_mut()).await;
        }
        for id in &ids {
            env.mgr.start(id);
        }
        assert_eq!(env.mgr.get(&ids[4]).unwrap().borrow().status, "waiting");
        assert!(env.mgr.is_active(&ids[4]));
        let mut rs = Vec::new();
        for e in ends {
            rs.push(e.await);
        }
        watch.abort();
        assert!(rs.iter().all(|r| r.is_ok()), "{:?}", rs.iter().filter_map(|r| r.as_ref().err()).collect::<Vec<_>>());
        assert!(peak.get() <= 2, "peak {} running downloads", peak.get());
        for (i, r) in rs.iter().enumerate() {
            assert!(matches_prefix(r.as_ref().unwrap(), MB + i));
        }
        env.mgr.dispose();
    });
}

#[test]
fn stopping_a_waiting_download_keeps_it_from_starting_later() {
    run(async {
        let env = setup("odm-rob-", json!({ "downloads": { "maxSimultaneous": 1 } }));
        let a = add(&env, format!("{}/file/{}?rate={}", SRV.base, 2 * MB, 8 * MB), json!({}));
        let b = add(&env, format!("{}/file/{}", SRV.base, MB), json!({}));
        let end_a = finished(&env.mgr, &a);
        env.mgr.start(&a);
        env.mgr.start(&b);
        assert_eq!(env.mgr.get(&b).unwrap().borrow().status, "waiting");
        env.mgr.stop(&b, None);
        assert_eq!(env.mgr.get(&b).unwrap().borrow().status, "paused");
        end_a.await.unwrap();
        sleep(100).await;
        assert_eq!(env.mgr.get(&b).unwrap().borrow().status, "paused");
        assert!(!env.mgr.is_active(&b));
        env.mgr.dispose();
    });
}

#[test]
fn split_archive_parts_keep_their_names_in_one_folder() {
    run(async {
        let env = setup("odm-rob-", json!({ "downloads": { "maxSimultaneous": 3 } }));
        let dir = temp_dir("odm-parts-");
        let names = ["show.part1.rar", "show.part2.rar", "show.part3.rar"];
        let ids: Vec<String> = names
            .iter()
            .enumerate()
            .map(|(i, n)| add(&env, format!("{}/file/{}", SRV.base, MB + i), json!({ "fileName": n, "saveDir": dir.to_string_lossy() })))
            .collect();
        let mut ends: Vec<_> = ids.iter().map(|id| Box::pin(finished(&env.mgr, id))).collect();
        for e in ends.iter_mut() {
            let _ = futures_poll_once(e.as_mut()).await;
        }
        for id in &ids {
            env.mgr.start(id);
        }
        for e in ends {
            e.await.unwrap();
        }
        let mut got: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        got.sort();
        assert_eq!(got, names);
        let _ = std::fs::remove_dir_all(&dir);
        env.mgr.dispose();
    });
}

/// Polls a future once so it registers its listener, without waiting for it.
async fn futures_poll_once<F: std::future::Future>(f: std::pin::Pin<&mut F>) -> bool {
    let mut f = f;
    std::future::poll_fn(|cx| std::task::Poll::Ready(f.as_mut().poll(cx).is_ready())).await
}

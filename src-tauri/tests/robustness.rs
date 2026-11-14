//! Port of test/robustness.test.js (against the bench server's behaviors).

mod common;

use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::{json, Value};

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(16 * MB)));
static STATE: LazyLock<Arc<BenchState>> = LazyLock::new(BenchState::new);
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler_with(DATA.clone(), STATE.clone())));
/// A second server with the same files and state: another "host" for `/althost/`.
static SRV2: LazyLock<TestServer> = LazyLock::new(|| {
    let s = TestServer::start(bench_handler_with(DATA.clone(), STATE.clone()));
    *STATE.hosts.lock().unwrap() = vec![SRV.base.clone(), s.base.clone()];
    s
});

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

#[test]
fn progress_of_several_running_downloads_is_saved_to_disk_while_they_run() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 1 } }));
        // Four slow downloads started 800 ms apart: their 3-second save requests interleave.
        let ids: Vec<String> = (0..4).map(|i| add(&env, format!("{}/file/{}?rate={}", SRV.base, 4 * MB + i, 400 * 1024), json!({}))).collect();
        for id in &ids {
            env.mgr.start(id);
            sleep(800).await;
        }
        sleep(6000).await;
        let text = std::fs::read_to_string(env.store.file("downloads")).expect("downloads.json was never written while downloads ran");
        let saved: Value = serde_json::from_str(&text).unwrap();
        let progress: Vec<u64> = saved
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["segments"].as_array().map(|s| s.iter().map(|s| s["pos"].as_u64().unwrap_or(0) - s["start"].as_u64().unwrap_or(0)).sum()).unwrap_or(0))
            .collect();
        assert!(progress.iter().all(|&p| p > 0), "progress on disk while running: {progress:?}");
        env.mgr.stop_all();
        env.mgr.dispose();
    });
}

// Resume integrity (R1): If-Range on continuations, host-scoped ETags, and a changed file is never
// truncated without the user's say.

const LAST_MOD: &str = "Mon, 01 Jan 2024 00:00:00 GMT";

/// Starts `id`, waits until more than `bytes` are downloaded and pauses it.
async fn pause_after(env: &Env, id: &str, bytes: u64) {
    env.mgr.start(id);
    while env.mgr.get(id).unwrap().borrow().segments_downloaded() <= bytes {
        sleep(50).await;
    }
    env.mgr.stop(id, None);
    env.mgr.wait_stopped(id).await;
}

/// (start, pos) of every segment.
fn positions(env: &Env, id: &str) -> Vec<(u64, u64)> {
    let it = env.mgr.get(id).unwrap();
    let b = it.borrow();
    b.segments.iter().flatten().map(|s| (s.borrow().start, s.borrow().pos)).collect()
}

fn temp_of(env: &Env, id: &str) -> std::path::PathBuf {
    env.mgr.get(id).unwrap().borrow().temp_path.clone().into()
}

fn file_len(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or_else(|e| panic!("temp file {}: {e}", p.display()))
}

/// Every segment's bytes in the temp file are still `data`'s.
fn assert_partial_holds(temp: &std::path::Path, segs: &[(u64, u64)], data: &[u8]) {
    let file = std::fs::read(temp).unwrap();
    for &(a, p) in segs {
        assert!(file[a as usize..p as usize] == data[a as usize..p as usize], "segment {a}..{p} no longer holds the downloaded bytes");
    }
}

/// Requests for `needle` that continue a file (they start after byte 0), from the `from`th on.
fn continuations(needle: &str, from: usize) -> Vec<Logged> {
    STATE.requests(needle).into_iter().skip(from).filter(|l| l.start().is_some_and(|s| s > 0)).collect()
}

/// Resolves when `id` finishes, or panics after `secs` (a download that restarts forever).
async fn finished_within(env: &Env, id: &str, secs: u64) -> Result<Value, Value> {
    tokio::time::timeout(std::time::Duration::from_secs(secs), finished(&env.mgr, id)).await.expect("download did not finish in time")
}

#[test]
fn every_continuation_request_carries_if_range_with_the_strong_etag() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?rate={}&t=ir-f", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        let c = continuations("t=ir-f", 0);
        assert!(!c.is_empty(), "no continuation requests were made");
        let tag = format!("\"{}\"", size);
        for l in &c {
            assert_eq!(l.if_range.as_deref(), Some(tag.as_str()), "continuation {:?} without the ETag in If-Range", l.range);
        }
        env.mgr.dispose();
    });
}

#[test]
fn a_file_changed_on_the_server_fails_with_echanged_and_keeps_the_partial_file() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/versioned/changed-a/file/{}?rate={}", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let before = positions(&env, &id);
        let temp = temp_of(&env, &id);
        let len = file_len(&temp);
        STATE.bump("changed-a");
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.expect_err("a file that changed on the server must not complete");
        assert_eq!(it["errorCode"], "ECHANGED", "{}", it["error"]);
        assert_eq!(it["error"], "File changed on the server");
        assert_eq!(file_len(&temp), len, "the partial file was truncated");
        assert_eq!(positions(&env, &id), before, "segment positions moved");
        assert_partial_holds(&temp, &before, &DATA);
        env.mgr.dispose();
    });
}

#[test]
fn keep_partial_pauses_with_the_data_and_a_resume_checks_once_and_never_restarts() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/versioned/changed-k/file/{}?rate={}", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let before = positions(&env, &id);
        let temp = temp_of(&env, &id);
        let len = file_len(&temp);
        STATE.bump("changed-k");
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.expect_err("a file that changed on the server must not complete");
        assert_eq!(it["errorCode"], "ECHANGED", "{}", it["error"]);

        env.mgr.keep_partial(&id);
        let it = env.mgr.public_item(&env.mgr.get(&id).unwrap());
        assert_eq!(it["status"], "paused");
        assert_eq!(it["statusText"], "File changed on the server — partial kept");
        assert_eq!(file_len(&temp), len);

        // Even with automatic restarts on, a kept partial is only checked, never thrown away.
        env.store.settings.borrow_mut()["downloads"]["autoRestartOnChange"] = json!(true);
        // The first attempt's cancelled connections may still be reaching the server.
        sleep(300).await;
        let n = STATE.requests("changed-k").len();
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.expect_err("still changed: must fail again");
        assert_eq!(it["errorCode"], "ECHANGED", "{}", it["error"]);
        assert_eq!(STATE.requests("changed-k").len() - n, 1, "the server is checked with one request");
        assert_eq!(file_len(&temp), len, "the partial file was truncated");
        assert_eq!(positions(&env, &id), before, "segment positions moved");
        assert_partial_holds(&temp, &before, &DATA);
        env.mgr.dispose();
    });
}

#[test]
fn with_auto_restart_on_change_a_changed_file_restarts_and_completes() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 }, "downloads": { "autoRestartOnChange": true } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/versioned/changed-b/file/{}?rate={}", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        STATE.bump("changed-b");
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == version_bytes(&DATA[..size], 1), "the restarted file is not the new version");
        env.mgr.dispose();
    });
}

#[test]
fn a_server_that_ignores_if_range_still_completes() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?ignoreifrange&rate={}", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        env.mgr.dispose();
    });
}

#[test]
fn a_change_is_still_caught_on_a_206_when_the_server_ignores_if_range() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/versioned/changed-c/file/{}?ignoreifrange&rate={}", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let before = positions(&env, &id);
        let temp = temp_of(&env, &id);
        STATE.bump("changed-c");
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.expect_err("a file that changed on the server must not complete");
        assert_eq!(it["errorCode"], "ECHANGED", "{}", it["error"]);
        assert_eq!(positions(&env, &id), before, "segment positions moved");
        assert_partial_holds(&temp, &before, &DATA);
        env.mgr.dispose();
    });
}

#[test]
fn a_server_that_answers_200_to_every_if_range_is_resumed_without_it() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?ifrange200&rate={}&t=ir-200", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let n = STATE.requests("t=ir-200").len();
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        let after: Vec<Logged> = STATE.requests("t=ir-200").into_iter().skip(n).collect();
        let with: Vec<&Logged> = after.iter().filter(|l| l.if_range.is_some()).collect();
        assert!(!with.is_empty(), "the resume never sent If-Range");
        assert!(with.len() <= 4, "If-Range was sent again after the server mishandled it: {}", with.len());
        assert!(after.iter().any(|l| l.if_range.is_none() && l.status == 206), "no range request without If-Range was retried");
        assert!(after.iter().all(|l| l.start() != Some(0)), "the download restarted from the beginning");
        env.mgr.dispose();
    });
}

#[test]
fn a_weak_etag_is_never_sent_in_if_range_and_last_modified_is_used_instead() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?weaketag&rate={}&t=ir-weak", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        let c = continuations("t=ir-weak", 0);
        assert!(!c.is_empty(), "no continuation requests were made");
        for l in &c {
            assert_eq!(l.if_range.as_deref(), Some(LAST_MOD), "continuation {:?}", l.range);
        }
        env.mgr.dispose();
    });
}

#[test]
fn etags_from_different_hosts_are_not_taken_for_a_change() {
    run(async {
        let _ = &*SRV2;
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/althost/file/{}?etagbyhost&rate={}&t=ir-host", SRV.base, size, 512 * 1024), json!({}));
        let end = finished_within(&env, &id, 40);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        let files: Vec<Logged> = STATE.requests("t=ir-host").into_iter().filter(|l| l.url.starts_with("/file/")).collect();
        assert!(files.iter().any(|l| !SRV.base.ends_with(&l.host)), "no request reached the second host");
        assert_eq!(files.iter().filter(|l| l.start() == Some(0)).count(), 1, "the download restarted from the beginning");
        env.mgr.dispose();
    });
}

#[test]
fn a_download_saved_without_etag_host_learns_it_from_a_206_with_the_same_etag() {
    run(async {
        let env = setup("odm-rob-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 8 * MB;
        let id = add(&env, format!("{}/file/{}?rate={}&t=ir-legacy", SRV.base, size, 512 * 1024), json!({}));
        pause_after(&env, &id, MB as u64).await;
        env.mgr.dispose();
        env.store.flush_all().await;
        // A list written before etagHost existed.
        let list = env.store.file("downloads");
        let mut saved: Value = serde_json::from_str(&std::fs::read_to_string(&list).unwrap()).unwrap();
        for d in saved.as_array_mut().unwrap() {
            d.as_object_mut().unwrap().remove("etagHost");
        }
        std::fs::write(&list, serde_json::to_string(&saved).unwrap()).unwrap();

        let store = opendm_lib::store::Store::new(&env.dir.join("data"));
        let net = opendm_lib::engine::net::NetContext::new(store.clone(), None);
        let mgr = opendm_lib::manager::DownloadManager::new(store.clone(), net);
        let n = STATE.requests("t=ir-legacy").len();
        let end = finished(&mgr, &id);
        mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(matches_prefix(&it, size));
        assert_eq!(it["etagHost"], SRV.base.trim_start_matches("http://"), "etagHost was not learned");
        let c = continuations("t=ir-legacy", n);
        assert_eq!(c.first().and_then(|l| l.if_range.as_deref()), Some(LAST_MOD), "an ETag without its host was used");
        let tag = format!("\"{}\"", size);
        assert!(c.iter().all(|l| l.if_range.as_deref() == Some(LAST_MOD) || l.if_range.as_deref() == Some(tag.as_str())), "{c:?}");
        mgr.dispose();
    });
}

//! Speed limits, quotas and categories, end to end against a local server.

mod common;

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

#[test]
fn the_global_speed_limit_holds_across_connections() {
    run(async {
        let env = setup("odm-feat-", json!({ "connection": { "maxConnections": 4 }, "speedLimiter": { "enabled": true, "kbps": 2048 } }));
        env.mgr.apply_speed_limiter();
        let size = 6 * MB;
        let id = add(&env, format!("{}/file/{}", SRV.base, size), json!({}));
        let end = finished(&env.mgr, &id);
        let t0 = Instant::now();
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        let secs = t0.elapsed().as_secs_f64();
        // The bucket starts full (one second of burst), then holds 2 MB/s: (6 - 2) / 2 = 2 s.
        assert!((1.9..=2.6).contains(&secs), "{secs:.2}s for 6 MB at 2 MB/s");
        assert!(read(&it["savedPath"]) == DATA[..size]);
        env.mgr.dispose();
    });
}

#[test]
fn a_per_download_speed_limit_holds() {
    run(async {
        let env = setup("odm-feat-", json!({ "connection": { "maxConnections": 4 } }));
        let size = 3 * MB;
        let id = add(&env, format!("{}/file/{}", SRV.base, size), json!({}));
        env.mgr.update(&id, &json!({ "speedLimitKB": 1024 })).await.unwrap();
        let end = finished(&env.mgr, &id);
        let t0 = Instant::now();
        env.mgr.start(&id);
        end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        let secs = t0.elapsed().as_secs_f64();
        // One second of burst, then 1 MB/s: (3 - 1) / 1 = 2 s.
        assert!((1.9..=2.6).contains(&secs), "{secs:.2}s for 3 MB at 1 MB/s");
        env.mgr.dispose();
    });
}

#[test]
fn the_quota_pauses_running_downloads_and_resumes_them_when_lifted() {
    run(async {
        let env = setup("odm-feat-", json!({ "connection": { "maxConnections": 1, "quota": { "enabled": true, "mb": 1, "hours": 1 } } }));
        let size = 4 * MB;
        let id = add(&env, format!("{}/file/{}?rate={}", SRV.base, size, MB), json!({}));
        env.mgr.start(&id);
        sleep(2000).await;
        env.mgr.check_quota();
        env.mgr.wait_stopped(&id).await;
        {
            let it = env.mgr.get(&id).unwrap();
            let it = it.borrow();
            assert_eq!(it.status, "paused");
            assert!(it.status_text.as_deref().unwrap_or("").contains("limit"), "{:?}", it.status_text);
            assert!(it.segments_downloaded() < size as u64);
        }
        let end = finished(&env.mgr, &id);
        env.store.settings.borrow_mut()["connection"]["quota"]["enabled"] = json!(false);
        env.mgr.check_quota();
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..size]);
        env.mgr.dispose();
    });
}

#[test]
fn files_go_to_the_category_for_their_extension() {
    run(async {
        let env = setup("odm-feat-", json!({}));
        let cases = [("a.zip", "compressed"), ("b.MP3", "music"), ("c.pdf", "documents"), ("d.mkv", "video"), ("noext", "general"), ("e.weird", "general")];
        for (name, cat) in cases {
            let r = env.mgr.add(&json!({ "url": format!("{}/file/10", SRV.base), "fileName": name })).unwrap();
            assert_eq!(r["item"]["category"], json!(cat), "{name}");
        }
        env.mgr.dispose();
    });
}

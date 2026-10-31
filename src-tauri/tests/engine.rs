//! Port of test/engine.test.js.

mod common;

use std::sync::{Arc, Mutex};

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use common::*;
use opendm_lib::manager::MgrEvent;
use opendm_lib::queues::{QEvent, QueueManager};
use serde_json::json;
use std::sync::LazyLock;

static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(6 * 1024 * 1024 + 123)));
static KEY: LazyLock<Vec<u8>> = LazyLock::new(|| random_bytes(16));

struct Srv {
    base: String,
    ranges: Arc<Mutex<Vec<usize>>>,
}

fn serve() -> Srv {
    let ranges: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
    let hits = ranges.clone();
    let data = DATA.clone();
    let key = KEY.clone();
    let s = TestServer::start(Arc::new(move |req: &Req| {
        let url = req.url.as_str();
        if url == "/redir" {
            return Resp::new(302, "").header("Location", "/named");
        }
        if url.starts_with("/file") || url == "/named" {
            let named = url == "/named";
            let with_name = |r: Resp| if named { r.header("Content-Disposition", "attachment; filename=\"réport final.bin\"".as_bytes()) } else { r };
            if let Some(rg) = req.header("range").and_then(|r| r.strip_prefix("bytes=")) {
                let (a, b) = rg.split_once('-').unwrap();
                let start: usize = a.parse().unwrap();
                let end: usize = if b.is_empty() { data.len() - 1 } else { b.parse().unwrap() };
                hits.lock().unwrap().push(start);
                return with_name(
                    Resp::new(206, data[start..=end].to_vec())
                        .header("Content-Range", format!("bytes {}-{}/{}", start, end, data.len()))
                        .header("ETag", "\"v1\""),
                )
                .slow();
            }
            return with_name(Resp::new(200, data.to_vec())).slow();
        }
        if url == "/norange" {
            return Resp::new(200, data.to_vec()).slow();
        }
        if url == "/master.m3u8" {
            return Resp::new(200, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720\nhi.m3u8\n")
                .header("Content-Type", "application/vnd.apple.mpegurl");
        }
        if url == "/hi.m3u8" {
            let mut s = String::from("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n");
            for i in 0..5 {
                s += &format!("#EXTINF:2.0,\nseg{}.ts\n", i);
            }
            return Resp::new(200, s + "#EXT-X-ENDLIST\n");
        }
        if url == "/key.bin" {
            return Resp::new(200, key.clone());
        }
        if let Some(i) = url.strip_prefix("/seg").and_then(|r| r.strip_suffix(".ts")).and_then(|n| n.parse::<usize>().ok()) {
            let mut iv = [0u8; 16];
            iv[12..].copy_from_slice(&(i as u32).to_be_bytes());
            let enc = cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(&data[i * 1000..i * 1000 + 1000]);
            return Resp::new(200, enc);
        }
        Resp::new(404, "")
    }));
    Srv { base: s.base, ranges }
}

static SRV: LazyLock<Srv> = LazyLock::new(serve);

#[test]
fn multi_connection_download_is_byte_identical_and_uses_several_connections() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        SRV.ranges.lock().unwrap().clear();
        let r = env.mgr.add(&json!({ "url": format!("{}/file.bin", SRV.base) })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let item = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        let n = SRV.ranges.lock().unwrap().len();
        assert!(n > 1, "expected more than one ranged connection, got {n}");
        assert!(read(&item["savedPath"]) == **DATA);
        env.mgr.dispose();
    });
}

#[test]
fn pause_and_resume_continues_from_saved_segments() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 }, "speedLimiter": { "enabled": true, "kbps": 3000 } }));
        env.mgr.apply_speed_limiter();
        let r = env.mgr.add(&json!({ "url": format!("{}/file.bin", SRV.base) })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        env.mgr.start(&id);
        sleep(600).await;
        let stopped = once(&env.mgr.events, |e| matches!(e, MgrEvent::Stopped(_)));
        env.mgr.stop(&id, None);
        stopped.await;
        let partial = env.mgr.get(&id).unwrap().borrow().downloaded as usize;
        assert!(partial > 0 && partial < DATA.len(), "partial {partial}");
        SRV.ranges.lock().unwrap().clear();
        env.store.settings.borrow_mut()["speedLimiter"]["enabled"] = json!(false);
        env.mgr.apply_speed_limiter();
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let fin = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(!SRV.ranges.lock().unwrap().contains(&0), "resume should not restart at 0");
        assert!(read(&fin["savedPath"]) == **DATA);
        env.mgr.dispose();
    });
}

#[test]
fn server_without_range_support_downloads_on_one_connection() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        let r = env.mgr.add(&json!({ "url": format!("{}/norange", SRV.base), "fileName": "x.bin" })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let item = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_eq!(env.mgr.get(&id).unwrap().borrow().resumable, Some(false));
        assert!(read(&item["savedPath"]) == **DATA);
        env.mgr.dispose();
    });
}

#[test]
fn redirect_and_content_disposition_name_the_file() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        let r = env.mgr.add(&json!({ "url": format!("{}/redir", SRV.base) })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let item = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_eq!(item["fileName"], json!("réport final.bin"));
        env.mgr.dispose();
    });
}

#[test]
fn existing_file_gets_a_numbered_name() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        let mut saved = Vec::new();
        for f in ["file1.bin", "file2.bin"] {
            let r = env.mgr.add(&json!({ "url": format!("{}/{}", SRV.base, f), "fileName": "same.bin" })).unwrap();
            let id = r["item"]["id"].as_str().unwrap().to_string();
            let done = finished(&env.mgr, &id);
            env.mgr.start(&id);
            saved.push(done.await.unwrap_or_else(|it| panic!("{}", it["error"]))["savedPath"].as_str().unwrap().to_string());
        }
        assert_ne!(saved[0], saved[1]);
        assert!(saved[1].ends_with("same (2).bin"), "{}", saved[1]);
        env.mgr.dispose();
    });
}

#[test]
fn hls_master_playlist_picks_best_variant_and_decrypts_aes128() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        let r = env.mgr.add(&json!({ "url": format!("{}/master.m3u8", SRV.base) })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let item = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(item["fileName"].as_str().unwrap().ends_with(".ts"));
        assert!(read(&item["savedPath"]) == DATA[..5000]);
        env.mgr.dispose();
    });
}

#[test]
fn download_queue_runs_items_and_empties_itself() {
    run(async {
        let env = setup("odm-test-", json!({ "connection": { "maxConnections": 6 } }));
        let qm = QueueManager::new(env.store.clone(), env.mgr.clone());
        let mut ids = Vec::new();
        for i in 0..3 {
            let r = env.mgr.add(&json!({ "url": format!("{}/file{}q.bin", SRV.base, i) })).unwrap();
            ids.push(r["item"]["id"].as_str().unwrap().to_string());
        }
        qm.add_items("main", &ids, false);
        env.store.queues.borrow_mut()[0]["maxConcurrent"] = json!(2);
        let fin = once(&qm.events, |e| matches!(e, QEvent::Finished(_)));
        qm.start("main");
        let QEvent::Finished(q) = fin.await else { unreachable!() };
        assert_eq!(q["items"].as_array().unwrap().len(), 0);
        assert!(ids.iter().all(|id| env.mgr.get(id).unwrap().borrow().status == "complete"));
        qm.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn scheduler_starts_a_queue_at_its_start_time() {
    run(async {
        let env = setup("odm-test-", json!({}));
        let qm = QueueManager::new(env.store.clone(), env.mgr.clone());
        {
            let mut qs = env.store.queues.borrow_mut();
            let s = &mut qs[0]["schedule"];
            s["startEnabled"] = json!(true);
            s["startTime"] = json!("03:15");
            s["mode"] = json!("daily");
            s["days"] = json!([0, 1, 2, 3, 4, 5, 6]);
        }
        let started = std::rc::Rc::new(std::cell::Cell::new(0));
        let c = started.clone();
        qm.events.on(move |e| {
            if matches!(e, QEvent::Started(_)) {
                c.set(c.get() + 1);
            }
        });
        let at = |h, m| chrono::NaiveDate::from_ymd_opt(2026, 1, 5).unwrap().and_hms_opt(h, m, 0).unwrap();
        qm.check_schedules(at(3, 14));
        assert_eq!(started.get(), 0);
        qm.check_schedules(at(3, 15));
        qm.check_schedules(at(3, 15));
        assert_eq!(started.get(), 1);
        qm.stop("main", true);
        qm.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn cookies_do_not_follow_a_redirect_to_another_host() {
    let s = TestServer::start(Arc::new(|req: &Req| {
        let port = req.header("host").and_then(|h| h.rsplit(':').next()).unwrap_or("").to_string();
        match req.path() {
            "/same" => Resp::new(302, "").header("Location", "/land"),
            "/away" => Resp::new(302, "").header("Location", format!("http://localhost:{}/land", port)),
            _ => Resp::new(200, req.header("cookie").unwrap_or("none").to_string()),
        }
    }));
    run(async move {
        let env = setup("odm-test-", json!({}));
        let opts = opendm_lib::engine::net::ReqOpts { headers: vec![("Cookie".into(), "sid=secret".into())], ..Default::default() };
        let body = |path: &'static str| {
            let (net, opts, base) = (env.net.clone(), opts.clone(), s.base.clone());
            async move { String::from_utf8(net.fetch_buffer(&format!("{}{}", base, path), &opts).await.unwrap().body).unwrap() }
        };
        assert_eq!(body("/same").await, "sid=secret");
        assert_eq!(body("/away").await, "none");
        env.mgr.dispose();
    });
}

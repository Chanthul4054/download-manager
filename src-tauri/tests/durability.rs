//! Partial downloads survive a crash or power loss: the saved list never claims more than the
//! temp file holds, and resuming from a list and file left in any state gives the server's bytes.

mod common;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, LazyLock};

use common::*;
use opendm_lib::manager::MgrEvent;
use serde_json::{json, Value};

const MB: usize = 1024 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(8 * MB)));
static STATE: LazyLock<Arc<BenchState>> = LazyLock::new(BenchState::new);
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler_with(DATA.clone(), STATE.clone())));

fn settings() -> Value {
    json!({ "connection": { "maxConnections": 4, "checkpointSec": 1 }, "downloads": { "maxSimultaneous": 8 } })
}

fn add(env: &Env, url: String) -> String {
    env.mgr.add(&json!({ "url": url })).unwrap()["item"]["id"].as_str().unwrap().to_string()
}

fn saved(list: &Path) -> Option<Vec<Value>> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(list).ok()?).ok()?.as_array().cloned()
}

/// Sum of saved segment progress.
fn saved_progress(it: &Value) -> u64 {
    it["segments"].as_array().map(|s| s.iter().map(|s| s["pos"].as_u64().unwrap() - s["start"].as_u64().unwrap()).sum()).unwrap_or(0)
}

/// Every saved segment's bytes are the server's bytes in the temp file.
fn assert_saved_data_is_in_file(it: &Value) {
    let Some(temp) = it["tempPath"].as_str() else { return };
    let Ok(file) = std::fs::read(temp) else { return };
    for s in it["segments"].as_array().into_iter().flatten() {
        let (a, p) = (s["start"].as_u64().unwrap() as usize, s["pos"].as_u64().unwrap() as usize);
        assert!(file.len() >= p, "saved pos {p} is past the end of the file ({})", file.len());
        assert!(file[a..p] == DATA[a..p], "saved segment {a}..{p} does not hold the server's bytes");
    }
}

#[test]
fn saved_offsets_never_run_ahead_of_the_file_with_several_downloads_running() {
    run(async {
        let env = setup("odm-dur-", settings());
        let list = env.store.file("downloads");
        // Four downloads at once, ~3 s each at 4 × 512 KB/s.
        let sizes = [6 * MB, 6 * MB - 1, 6 * MB - 2, 6 * MB - 3];
        let ids: Vec<String> = sizes.iter().map(|n| add(&env, format!("{}/file/{}?rate={}", SRV.base, n, 512 * 1024))).collect();
        let ends: Vec<_> = ids
            .iter()
            .map(|id| {
                let (mgr, id) = (env.mgr.clone(), id.clone());
                tokio::task::spawn_local(async move { finished(&mgr, &id).await })
            })
            .collect();
        for id in &ids {
            env.mgr.start(id);
        }
        let all = async {
            let mut out = Vec::new();
            for e in ends {
                out.push(e.await.unwrap());
            }
            out
        };
        tokio::pin!(all);
        let mut checked = 0;
        let results = loop {
            tokio::select! {
                r = &mut all => break r,
                _ = sleep(200) => {
                    for it in saved(&list).unwrap_or_default() {
                        if it["status"] != json!("complete") && saved_progress(&it) > 0 {
                            assert_saved_data_is_in_file(&it);
                            checked += 1;
                        }
                    }
                }
            }
        };
        assert!(checked >= 4, "only {checked} partial snapshots checked");
        for (r, n) in results.into_iter().zip(sizes) {
            let it = r.unwrap_or_else(|it| panic!("{}", it["error"]));
            assert!(read(&it["savedPath"]) == DATA[..n]);
            assert!(it["lastRun"]["syncs"].as_u64().unwrap() >= 2, "{}", it["lastRun"]);
        }
        env.mgr.dispose();
    });
}

#[test]
fn pausing_saves_the_exact_position_and_resumes_intact() {
    run(async {
        let env = setup("odm-dur-", settings());
        let size = 6 * MB;
        let id = add(&env, format!("{}/file/{}?rate={}", SRV.base, size, 512 * 1024));
        env.mgr.start(&id);
        sleep(1800).await;
        env.mgr.stop(&id, None);
        env.mgr.wait_stopped(&id).await;
        env.store.flush("downloads").await.unwrap();
        let item = env.mgr.get(&id).unwrap();
        let written = item.borrow().segments_downloaded();
        let it = saved(&env.store.file("downloads")).unwrap().into_iter().find(|x| x["id"] == json!(id)).unwrap();
        assert!(written > 0);
        // The final flush on pause makes everything written durable.
        assert_eq!(saved_progress(&it), written);
        assert_saved_data_is_in_file(&it);
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..size]);
        env.mgr.dispose();
    });
}

/// Runs a download, captures the saved list mid-way as a crash leaves it, lets `damage` change the
/// temp file, restarts over the same folder and checks the finished file.
fn crash_and_resume(damage: impl FnOnce(&Path, &Value)) {
    crash_and_resume_with(false, damage, |_, _| {});
}

/// `crash_and_resume`, optionally as a query-range (`&range=a-b`) download. `check` gets the
/// snapshot and the requests made after the restart.
fn crash_and_resume_with(query: bool, damage: impl FnOnce(&Path, &Value), check: impl FnOnce(&Value, &[Logged])) {
    run(async {
        let env = setup("odm-dur-", settings());
        let size = 6 * MB;
        let tag = format!("t={}", opendm_lib::util::id());
        let id = add(&env, format!("{}/file/{}?rate={}&{}", SRV.base, size, 256 * 1024, tag));
        if query {
            let it = env.mgr.get(&id).unwrap();
            let mut b = it.borrow_mut();
            b.range_mode = Some("query".into());
            b.size = Some(size as u64);
        }
        env.mgr.start(&id);
        let list = env.store.file("downloads");
        let snapshot = loop {
            sleep(200).await;
            if let Some(it) = saved(&list).and_then(|l| l.into_iter().find(|x| x["id"] == json!(id))) {
                if saved_progress(&it) > MB as u64 {
                    break it;
                }
            }
        };
        let text = std::fs::read_to_string(&list).unwrap();
        // Keep writing past the snapshot, as a process does until the power goes.
        sleep(1200).await;
        env.mgr.stop_all();
        env.mgr.wait_stopped(&id).await;
        env.mgr.dispose();
        env.store.flush_all().await;
        std::fs::write(&list, &text).unwrap();
        let temp = PathBuf::from(snapshot["tempPath"].as_str().unwrap());
        damage(&temp, &snapshot);

        let store = opendm_lib::store::Store::new(&env.dir.join("data"));
        let net = opendm_lib::engine::net::NetContext::new(store.clone(), None);
        let mgr = opendm_lib::manager::DownloadManager::new(store.clone(), net);
        let item = mgr.get(&id).expect("download restored");
        assert_eq!(item.borrow().status, "paused");
        assert_eq!(item.borrow().downloaded, saved_progress(&snapshot), "shown progress matches the durable progress");
        let n = STATE.requests(&tag).len();
        let end = finished(&mgr, &id);
        mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..size], "resumed file differs from the server copy");
        let after: Vec<Logged> = STATE.requests(&tag).into_iter().skip(n).collect();
        check(&snapshot, &after);
        mgr.dispose();
    });
}

fn first_saved_end(snapshot: &Value) -> u64 {
    let s = &snapshot["segments"][0];
    s["pos"].as_u64().unwrap()
}

#[test]
fn a_temp_file_shorter_than_the_saved_offsets_is_downloaded_again_from_where_it_ends() {
    crash_and_resume(|temp, snap| {
        // The file lost its tail (e.g. its size was not on the disk yet).
        let f = std::fs::OpenOptions::new().write(true).open(temp).unwrap();
        f.set_len(first_saved_end(snap) / 2).unwrap();
    });
}

#[test]
fn garbage_after_the_saved_offsets_is_overwritten() {
    crash_and_resume(|temp, snap| {
        // Bytes after a durable offset are not trusted: corrupt them all, and append a tail.
        let mut file = std::fs::read(temp).unwrap();
        for s in snap["segments"].as_array().unwrap() {
            let p = s["pos"].as_u64().unwrap() as usize;
            let e = s["end"].as_u64().unwrap() as usize;
            for b in file.iter_mut().take(e).skip(p) {
                *b = 0xA5;
            }
        }
        file.extend(std::iter::repeat_n(0xEE, MB));
        std::fs::write(temp, file).unwrap();
    });
}

#[test]
fn a_missing_temp_file_starts_the_download_over() {
    crash_and_resume(|temp, _| std::fs::remove_file(temp).unwrap());
}

#[test]
fn a_list_that_cannot_be_saved_does_not_stop_downloads_or_litter_the_folder() {
    run(async {
        let env = setup("odm-dur-", settings());
        env.store.flush("downloads").await.unwrap();
        let list = env.store.file("downloads");
        let before = std::fs::read(&list).unwrap();
        let mut perm = std::fs::metadata(&list).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&list, perm.clone()).unwrap();

        let id = add(&env, format!("{}/file/{}?rate={}", SRV.base, 3 * MB, 512 * 1024));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == DATA[..3 * MB]);
        sleep(1500).await;
        let data_dir = list.parent().unwrap();
        let tmp: Vec<_> = std::fs::read_dir(data_dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(tmp.is_empty(), "temp files left: {:?}", tmp.iter().map(|e| e.file_name()).collect::<Vec<_>>());
        #[cfg(windows)]
        assert_eq!(std::fs::read(&list).unwrap(), before, "a read-only list is left as it was");
        let _ = &before;

        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&list, perm).unwrap();
        env.store.flush("downloads").await.unwrap();
        let saved = saved(&list).unwrap();
        assert_eq!(saved[0]["status"], json!("complete"));
        env.mgr.dispose();
    });
}

// Overlap verification (R2): before continuing a segment, the bytes just before its position are
// fetched again and compared with the temp file.

/// Corrupts the 16 bytes before the position of the segment with the most progress. Returns that
/// segment's start and the starts of the other segments that had more than 64 bytes.
fn corrupt_before_cursor(temp: &Path, snap: &Value) -> (u64, Vec<u64>) {
    let segs: Vec<(u64, u64)> = snap["segments"].as_array().unwrap().iter().map(|s| (s["start"].as_u64().unwrap(), s["pos"].as_u64().unwrap())).collect();
    let &(start, pos) = segs.iter().max_by_key(|(a, p)| p - a).unwrap();
    assert!(pos - start >= 64, "not enough progress to corrupt");
    let mut file = std::fs::read(temp).unwrap();
    for b in &mut file[pos as usize - 16..pos as usize] {
        *b ^= 0xFF;
    }
    std::fs::write(temp, file).unwrap();
    (start, segs.iter().filter(|(a, p)| *a != start && p - a > 64).map(|(a, _)| *a).collect())
}

fn corrupt_bytes_before_a_cursor_rewind_only_that_segment(query: bool) {
    let hit = std::cell::Cell::new((0u64, Vec::new()));
    crash_and_resume_with(
        query,
        |temp, snap| hit.set(corrupt_before_cursor(temp, snap)),
        |_, after| {
            let (start, others) = hit.take();
            assert!(after.iter().any(|l| l.start() == Some(start)), "segment {start} was not downloaded again from its start");
            for a in others {
                assert!(after.iter().all(|l| l.start() != Some(a)), "intact segment {a} was rewound too");
            }
        },
    );
}

#[test]
fn corrupt_bytes_just_before_a_saved_offset_rewind_only_that_segment() {
    corrupt_bytes_before_a_cursor_rewind_only_that_segment(false);
}

#[test]
fn in_query_range_mode_corrupt_bytes_before_a_saved_offset_rewind_only_that_segment() {
    corrupt_bytes_before_a_cursor_rewind_only_that_segment(true);
}

#[test]
fn a_second_overlap_mismatch_in_one_session_fails_with_echanged() {
    run(async {
        let env = setup("odm-dur-", json!({ "connection": { "maxConnections": 1 } }));
        // Every response stops after 1 MB, and every range after byte 0 starts with 64 wrong bytes.
        let id = add(&env, format!("{}/file/{}?badoverlap&cutevery={}&t=ov-twice", SRV.base, 4 * MB, MB));
        let end = tokio::time::timeout(std::time::Duration::from_secs(60), finished(&env.mgr, &id));
        env.mgr.start(&id);
        let it = end.await.expect("no infinite loop").expect_err("bytes that do not match twice must not complete");
        assert_eq!(it["errorCode"], "ECHANGED", "{}", it["error"]);
        let n = STATE.requests("t=ov-twice").len();
        assert!(n <= 8, "{n} requests");
        env.mgr.dispose();
    });
}

#[test]
fn downloaded_is_exactly_the_file_size_and_progress_never_goes_backwards() {
    run(async {
        let env = setup("odm-dur-", settings());
        let size = 6 * MB + 123;
        // A dropped first connection and a pause: two kinds of continuation.
        let id = add(&env, format!("{}/file/{}?truncate&rate={}&t=ov-count", SRV.base, size, 512 * 1024));
        let seen = Rc::new(RefCell::new(Vec::<u64>::new()));
        let (s2, id2) = (seen.clone(), id.clone());
        let sub = env.mgr.events.on(move |e| {
            if let MgrEvent::Progress(i, st) = e {
                if *i == id2 {
                    s2.borrow_mut().push(st["downloaded"].as_u64().unwrap_or(0));
                }
            }
        });
        env.mgr.start(&id);
        while env.mgr.get(&id).unwrap().borrow().segments_downloaded() <= 2 * MB as u64 {
            sleep(50).await;
        }
        env.mgr.stop(&id, None);
        env.mgr.wait_stopped(&id).await;
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        env.mgr.events.off(sub);
        assert!(read(&it["savedPath"]) == DATA[..size]);
        assert_eq!(it["downloaded"], json!(size), "downloaded is not the file size");
        let seen = seen.borrow();
        assert!(seen.len() >= 2, "no progress reported");
        assert!(seen.iter().all(|&d| d <= size as u64), "progress past 100 %: {:?}", seen.iter().max());
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress went backwards: {seen:?}");
        env.mgr.dispose();
    });
}

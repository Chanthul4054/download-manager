//! Where the unfinished file is kept (`saveTo.partialLocation`): next to the destination by
//! default, so completion is a rename; in the temporary folder for cloud-synced destinations.
//! Remove, Restart and a folder or name change never leave a partial behind.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::{json, Value};

const MB: usize = 1024 * 1024;
const RATE: usize = 512 * 1024;
static DATA: LazyLock<Arc<Vec<u8>>> = LazyLock::new(|| Arc::new(random_bytes(4 * MB)));
static STATE: LazyLock<Arc<BenchState>> = LazyLock::new(BenchState::new);
static SRV: LazyLock<TestServer> = LazyLock::new(|| TestServer::start(bench_handler_with(DATA.clone(), STATE.clone())));

fn settings() -> Value {
    json!({ "connection": { "maxConnections": 2 } })
}

fn add(env: &Env, url: String, extra: Value) -> String {
    let mut o = json!({ "url": url });
    if let (Some(t), Some(x)) = (o.as_object_mut(), extra.as_object()) {
        t.extend(x.clone());
    }
    env.mgr.add(&o).unwrap()["item"]["id"].as_str().unwrap().to_string()
}

/// A slow download of `n` bytes (about `n / 1 MB` seconds with two connections).
fn slow(n: usize) -> String {
    format!("{}/file/{}?rate={}", SRV.base, n, RATE)
}

fn temp_of(env: &Env, id: &str) -> PathBuf {
    env.mgr.get(id).unwrap().borrow().temp_path.clone().into()
}

/// The partial files in `dir` (not in its sub-folders).
fn partials(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".opendm-part")).collect()
}

async fn pause(env: &Env, id: &str) {
    env.mgr.stop(id, None);
    env.mgr.wait_stopped(id).await;
}

async fn finish(env: &Env, id: &str) -> Value {
    let end = finished(&env.mgr, id);
    env.mgr.start(id);
    end.await.unwrap_or_else(|it| panic!("{}", it["error"]))
}

/// What a rename keeps and a copy does not.
fn identity(p: &Path) -> impl PartialEq + std::fmt::Debug {
    let m = std::fs::metadata(p).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.ino()
    }
    #[cfg(not(unix))]
    {
        m.created().unwrap()
    }
}

#[test]
fn the_partial_is_a_hidden_file_beside_the_destination_and_completion_renames_it() {
    run(async {
        let env = setup("odm-part-", settings());
        let out = env.dir.join("out");
        let id = add(&env, slow(2 * MB), json!({}));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        sleep(700).await;
        let temp = temp_of(&env, &id);
        let name = env.mgr.get(&id).unwrap().borrow().file_name.clone();
        assert_eq!(temp, out.join(format!(".{}.{}.opendm-part", name, &id[..8])));
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert!(std::fs::metadata(&temp).unwrap().file_attributes() & 2 != 0, "the partial is not hidden");
        }
        let before = identity(&temp);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        let saved = PathBuf::from(it["savedPath"].as_str().unwrap());
        assert_eq!(identity(&saved), before, "the finished file is not the partial renamed");
        assert!(std::fs::read(&saved).unwrap() == DATA[..2 * MB]);
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert!(std::fs::metadata(&saved).unwrap().file_attributes() & 2 == 0, "the finished file is still hidden");
        }
        assert!(partials(&out).is_empty(), "{:?}", partials(&out));
        env.mgr.dispose();
    });
}

#[test]
fn a_copy_across_volumes_keeps_the_source_until_the_destination_is_in_place() {
    run(async {
        let dir = temp_dir("odm-part-copy-");
        let (src, dest_dir) = (dir.join("src.bin"), dir.join("dest"));
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("file.bin");
        std::fs::write(&src, &DATA[..MB]).unwrap();
        // The delete fails: the source is open elsewhere without delete sharing.
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&src).unwrap();
            let r = opendm_lib::util::copy_move(&src.to_string_lossy(), &dest.to_string_lossy()).await;
            assert!(r.is_err(), "a source that could not be deleted is reported");
            assert!(std::fs::read(&src).unwrap() == DATA[..MB], "the source was damaged");
            assert!(std::fs::read(&dest).unwrap() == DATA[..MB], "the destination is not complete");
            drop(held);
            std::fs::remove_file(&dest).unwrap();
        }
        opendm_lib::util::copy_move(&src.to_string_lossy(), &dest.to_string_lossy()).await.unwrap();
        assert!(!src.exists());
        assert!(std::fs::read(&dest).unwrap() == DATA[..MB]);
        // Nothing but the file itself: the copy's working name is gone.
        let names: Vec<_> = std::fs::read_dir(&dest_dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["file.bin"]);
        // A stale working copy from an interrupted move does not get in the way.
        std::fs::write(&src, &DATA[..MB]).unwrap();
        std::fs::remove_file(&dest).unwrap();
        std::fs::write(dest_dir.join("file.bin.opendm-copy"), b"half").unwrap();
        opendm_lib::util::copy_move(&src.to_string_lossy(), &dest.to_string_lossy()).await.unwrap();
        assert!(std::fs::read(&dest).unwrap() == DATA[..MB]);
        let names: Vec<_> = std::fs::read_dir(&dest_dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["file.bin"]);
    });
}

#[test]
fn two_downloads_with_the_same_name_in_one_folder_do_not_collide() {
    run(async {
        let env = setup("odm-part-", settings());
        let a = add(&env, slow(MB), json!({ "fileName": "same.bin" }));
        // Twice the size, so the two do not finish in the same instant.
        let b = add(&env, slow(2 * MB), json!({ "fileName": "same.bin" }));
        // Spawned, so both are listening before either download ends.
        let wait = |id: &String| {
            let (mgr, id) = (env.mgr.clone(), id.clone());
            tokio::task::spawn_local(async move { finished(&mgr, &id).await })
        };
        let (ea, eb) = (wait(&a), wait(&b));
        env.mgr.start(&a);
        env.mgr.start(&b);
        sleep(400).await;
        let (ta, tb) = (temp_of(&env, &a), temp_of(&env, &b));
        assert_ne!(ta, tb);
        assert_eq!(ta.parent(), Some(env.dir.join("out").as_path()));
        assert_eq!(ta.parent(), tb.parent());
        let ia = ea.await.unwrap().unwrap_or_else(|it| panic!("{}", it["error"]));
        let ib = eb.await.unwrap().unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_ne!(ia["savedPath"], ib["savedPath"]);
        assert!(read(&ia["savedPath"]) == DATA[..MB]);
        assert!(read(&ib["savedPath"]) == DATA[..2 * MB]);
        assert!(partials(&env.dir.join("out")).is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn two_downloads_with_the_same_name_finishing_together_keep_both_files() {
    run(async {
        let env = setup("odm-part-", settings());
        let ids: Vec<String> = (0..4).map(|i| add(&env, format!("{}/file/{}", SRV.base, MB + i), json!({ "fileName": "together.bin" }))).collect();
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
        let mut paths = std::collections::HashSet::new();
        for (i, e) in ends.into_iter().enumerate() {
            let it = e.await.unwrap().unwrap_or_else(|it| panic!("{}", it["error"]));
            assert!(read(&it["savedPath"]) == DATA[..MB + i], "file {} was overwritten", i);
            paths.insert(it["savedPath"].as_str().unwrap().to_string());
        }
        assert_eq!(paths.len(), 4);
        env.mgr.dispose();
    });
}

#[test]
fn remove_and_restart_leave_no_partial_behind() {
    run(async {
        let env = setup("odm-part-", settings());
        let out = env.dir.join("out");
        // Removed while running.
        let a = add(&env, slow(3 * MB), json!({}));
        env.mgr.start(&a);
        sleep(600).await;
        assert_eq!(partials(&out).len(), 1);
        env.mgr.remove(&[a], false).await;
        assert!(partials(&out).is_empty(), "after removing a running download: {:?}", partials(&out));
        // Removed while paused.
        let b = add(&env, slow(3 * MB), json!({}));
        env.mgr.start(&b);
        sleep(600).await;
        pause(&env, &b).await;
        assert_eq!(partials(&out).len(), 1);
        env.mgr.remove(&[b], false).await;
        assert!(partials(&out).is_empty(), "after removing a paused download: {:?}", partials(&out));
        // Restarted: the old data goes, and the hidden partial can be written again.
        let c = add(&env, slow(MB), json!({}));
        env.mgr.start(&c);
        sleep(600).await;
        pause(&env, &c).await;
        env.mgr.redownload(&c, false).await;
        assert!(partials(&out).is_empty(), "after Restart: {:?}", partials(&out));
        let it = finish(&env, &c).await;
        assert!(read(&it["savedPath"]) == DATA[..MB]);
        assert!(partials(&out).is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn restarting_over_an_existing_hidden_partial_works() {
    run(async {
        let env = setup("odm-part-", settings());
        let id = add(&env, slow(MB), json!({}));
        env.mgr.start(&id);
        sleep(600).await;
        pause(&env, &id).await;
        // The saved progress is lost but the file stays: the engine starts over in the same file.
        {
            let item = env.mgr.get(&id).unwrap();
            let mut it = item.borrow_mut();
            it.segments = None;
            it.downloaded = 0;
        }
        assert!(temp_of(&env, &id).exists());
        let it = finish(&env, &id).await;
        assert!(read(&it["savedPath"]) == DATA[..MB]);
        env.mgr.dispose();
    });
}

#[test]
fn changing_the_folder_or_name_of_a_paused_download_moves_its_partial() {
    run(async {
        let env = setup("odm-part-", settings());
        let (out, out2) = (env.dir.join("out"), env.dir.join("out2"));
        let size = 3 * MB;
        let id = add(&env, slow(size), json!({}));
        env.mgr.start(&id);
        sleep(900).await;
        pause(&env, &id).await;
        let done = env.mgr.get(&id).unwrap().borrow().segments_downloaded();
        assert!(done > 0);
        let old = temp_of(&env, &id);
        env.mgr.update(&id, &json!({ "saveDir": out2.to_string_lossy() })).await.unwrap();
        let moved = temp_of(&env, &id);
        assert_eq!(moved.parent(), Some(out2.as_path()));
        assert!(moved.exists() && !old.exists());
        assert!(partials(&out).is_empty());
        env.mgr.update(&id, &json!({ "fileName": "renamed.bin" })).await.unwrap();
        let renamed = temp_of(&env, &id);
        assert_eq!(renamed, out2.join(format!(".renamed.bin.{}.opendm-part", &id[..8])));
        assert!(renamed.exists() && !moved.exists());
        // Nothing already downloaded is fetched again.
        assert_eq!(env.mgr.get(&id).unwrap().borrow().segments_downloaded(), done);
        let it = finish(&env, &id).await;
        assert_eq!(it["savedPath"], json!(out2.join("renamed.bin").to_string_lossy()));
        assert!(read(&it["savedPath"]) == DATA[..size]);
        assert!(partials(&out).is_empty() && partials(&out2).is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn changing_the_folder_of_a_running_download_moves_its_partial_and_continues() {
    run(async {
        let env = setup("odm-part-", settings());
        let (out, out2) = (env.dir.join("out"), env.dir.join("out2"));
        let size = 3 * MB;
        let id = add(&env, slow(size), json!({}));
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        sleep(900).await;
        env.mgr.update(&id, &json!({ "saveDir": out2.to_string_lossy() })).await.unwrap();
        assert_eq!(temp_of(&env, &id).parent(), Some(out2.as_path()));
        assert!(partials(&out).is_empty());
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_eq!(PathBuf::from(it["savedPath"].as_str().unwrap()).parent(), Some(out2.as_path()));
        assert!(read(&it["savedPath"]) == DATA[..size]);
        assert!(partials(&out2).is_empty());
        env.mgr.dispose();
    });
}

#[test]
fn automatic_keeps_partials_out_of_cloud_synced_folders() {
    run(async {
        let env = setup("odm-part-", settings());
        let tmp = env.dir.join("tmp");
        let cloud = env.dir.join("OneDrive");
        let listed = env.dir.join("Dropbox");
        std::env::set_var("OneDrive", &cloud);
        env.store.settings.borrow_mut()["saveTo"]["syncedFolders"] = json!([listed.to_string_lossy()]);
        for dir in [cloud.join("Documents"), listed.join("a").join("b")] {
            let id = add(&env, slow(MB), json!({ "saveDir": dir.to_string_lossy() }));
            assert_eq!(temp_of(&env, &id).parent(), Some(tmp.as_path()), "partial for {}", dir.display());
            env.mgr.start(&id);
            sleep(400).await;
            assert!(partials(&dir).is_empty());
            let it = finished(&env.mgr, &id).await.unwrap_or_else(|it| panic!("{}", it["error"]));
            assert_eq!(PathBuf::from(it["savedPath"].as_str().unwrap()).parent(), Some(dir.as_path()));
            assert!(read(&it["savedPath"]) == DATA[..MB]);
        }
        // A folder that only starts with the same text is not inside the synced one.
        let near = env.dir.join("OneDrive-not");
        let id = add(&env, slow(MB), json!({ "saveDir": near.to_string_lossy() }));
        assert_eq!(temp_of(&env, &id).parent(), Some(near.as_path()));
        // "Next to the file" is the user's explicit choice, synced or not.
        env.store.settings.borrow_mut()["saveTo"]["partialLocation"] = json!("beside");
        let id = add(&env, slow(MB), json!({ "saveDir": cloud.to_string_lossy() }));
        assert_eq!(temp_of(&env, &id).parent(), Some(cloud.as_path()));
        // "Temporary folder" is today's behaviour, name included.
        env.store.settings.borrow_mut()["saveTo"]["partialLocation"] = json!("tempDir");
        let id = add(&env, slow(MB), json!({ "fileName": "t.bin" }));
        assert_eq!(temp_of(&env, &id), tmp.join(format!("{}_t.bin", id)));
        env.mgr.dispose();
    });
}

#[test]
fn a_download_with_its_partial_in_the_temporary_folder_still_resumes() {
    run(async {
        let mut s = settings();
        s["saveTo"] = json!({ "partialLocation": "tempDir" });
        let env = setup("odm-part-", s);
        let size = 3 * MB;
        let id = add(&env, slow(size), json!({}));
        env.mgr.start(&id);
        sleep(900).await;
        pause(&env, &id).await;
        let temp = temp_of(&env, &id);
        assert_eq!(temp.parent(), Some(env.dir.join("tmp").as_path()));
        let done = env.mgr.get(&id).unwrap().borrow().segments_downloaded();
        assert!(done > 0);
        // The setting changes; the item added before keeps its partial where it is.
        env.store.settings.borrow_mut()["saveTo"]["partialLocation"] = json!("beside");
        env.mgr.update(&id, &json!({ "description": "x" })).await.unwrap();
        assert_eq!(temp_of(&env, &id), temp);
        let n = STATE.requests(&format!("/file/{}?", size)).len();
        let it = finish(&env, &id).await;
        assert!(read(&it["savedPath"]) == DATA[..size]);
        assert!(!temp.exists());
        // It continued: no request after the pause asked for the start of the file.
        let later = STATE.requests(&format!("/file/{}?", size)).split_off(n);
        assert!(!later.is_empty() && later.iter().all(|l| l.start().is_some_and(|s| s > 0)), "{:?}", later);
        env.mgr.dispose();
    });
}

#[test]
fn a_destination_that_cannot_be_written_fails_at_start_without_asking_the_server() {
    run(async {
        let mut s = settings();
        s["saveTo"] = json!({ "partialLocation": "tempDir" });
        let env = setup("odm-part-", s);
        // A file where the folder should be.
        let blocker = env.dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let size = MB + 77;
        let id = add(&env, format!("{}/file/{}", SRV.base, size), json!({ "saveDir": blocker.join("sub").to_string_lossy() }));
        env.mgr.start(&id);
        sleep(300).await;
        {
            let item = env.mgr.get(&id).unwrap();
            let it = item.borrow();
            assert_eq!(it.status, "error");
            assert!(it.error.as_deref().unwrap_or("").contains("destination folder"), "{:?}", it.error);
        }
        assert!(STATE.requests(&format!("/file/{}", size)).is_empty(), "the server was asked before the folder was checked");
        env.mgr.dispose();
    });
}

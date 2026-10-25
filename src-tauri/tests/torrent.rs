//! Live BitTorrent check against a real, well-seeded torrent. Needs the internet, so it is ignored
//! by default: cargo test --test torrent -- --ignored

mod common;

use common::*;
use opendm_lib::manager::MgrEvent;
use serde_json::json;

const URL: &str = "https://releases.ubuntu.com/noble/ubuntu-24.04.5-live-server-amd64.iso.torrent";

#[test]
#[ignore]
fn downloads_from_the_swarm_then_stops_and_cleans_up() {
    run(async move {
        let env = setup("odm-torrent-", json!({}));
        // A local .torrent file: list its files without starting it, then download the chosen one.
        let f = env.net.fetch_buffer(URL, &Default::default()).await.unwrap();
        let local = env.dir.join("my file #1.torrent");
        std::fs::write(&local, &f.body).unwrap();
        let file_url = url::Url::from_file_path(&local).unwrap().to_string();
        let list = opendm_lib::engine::torrent::list_files(&env.store, &file_url).await.unwrap();
        let files = list["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "{list}");
        assert!(files[0]["path"].as_str().unwrap().ends_with(".iso") && files[0]["size"].as_u64().unwrap() > 1 << 30);

        let r = env.mgr.add(&json!({ "url": file_url, "start": true, "torrentFiles": [files[0]["index"]] })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        assert_eq!(r["item"]["kind"], "torrent");
        let item = env.mgr.get(&id).unwrap();
        while item.borrow().downloaded < 1 << 20 {
            assert_ne!(item.borrow().status, "error", "{:?}", item.borrow().error);
            sleep(500).await;
        }
        let name = item.borrow().file_name.clone();
        assert!(name.ends_with(".iso"), "{name}");
        assert!(item.borrow().size.unwrap_or(0) > 1 << 30);
        assert!(item.borrow().extra.contains_key("infoHash"));
        assert!(env.dir.join("out").join(&name).exists());

        let want = id.clone();
        let stopped = once(&env.mgr.events, move |e| matches!(e, MgrEvent::Stopped(s) if *s == want));
        env.mgr.stop(&id, None);
        stopped.await;
        assert_eq!(item.borrow().status, "paused");

        env.mgr.remove(&[id], true).await;
        for _ in 0..20 {
            if !env.dir.join("out").join(&name).exists() {
                return;
            }
            sleep(250).await;
        }
        panic!("the partial download was not deleted");
    });
}

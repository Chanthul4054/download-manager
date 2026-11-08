//! BitTorrent without the internet: a seeder (a second librqbit session on 127.0.0.1) and a tiny
//! HTTP tracker that points at it. DHT, local discovery, uTP and port forwarding are off, so the
//! only way OpenDM can get the file is from that seeder.
//!
//! Runs with PEX off (the regression: turning PEX off made every extended handshake fail to
//! encode, so no torrent could download). ODM_PEX=1 runs it with PEX on, ODM_PLAIN=1 with peer
//! encryption off; the session is per process, so each needs its own run.

mod common;

use std::sync::Arc;

use common::*;
use librqbit::{AddTorrent, AddTorrentOptions, CreateTorrentOptions, EncryptionPolicy, ListenerMode, ListenerOptions, Session, SessionOptions};
use serde_json::json;

const SIZE: usize = 3 * 1024 * 1024 + 12345;

fn plain() -> bool {
    std::env::var("ODM_PLAIN").is_ok()
}

/// Starts the seeder on its own runtime; returns the .torrent bytes and the seeder's port.
fn seeder(dir: std::path::PathBuf, data: Vec<u8>) -> (Vec<u8>, u16) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let files = dir.join("seed");
            std::fs::create_dir_all(&files).unwrap();
            let file = files.join("payload.bin");
            std::fs::write(&file, &data).unwrap();
            let spawner = librqbit::spawn_utils::BlockingSpawner::new(4);
            let t = librqbit::create_torrent(&file, CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(256 * 1024) }, &spawner).await.unwrap();
            let bytes = t.as_bytes().unwrap().to_vec();
            let opts = SessionOptions {
                dht: None,
                listen: Some(ListenerOptions { mode: ListenerMode::TcpOnly, listen_addr: "127.0.0.1:0".parse().unwrap(), enable_upnp_port_forwarding: false, ..Default::default() }),
                disable_local_service_discovery: true,
                disable_pex: true,
                encryption: if plain() { EncryptionPolicy::Disable } else { EncryptionPolicy::Prefer },
                ..Default::default()
            };
            let sess = Session::new_with_opts(dir.join("seed-session"), opts).await.unwrap();
            let h = sess
                .add_torrent(AddTorrent::from_bytes(bytes.clone()), Some(AddTorrentOptions { output_folder: Some(files.to_string_lossy().into_owned()), overwrite: true, ..Default::default() }))
                .await
                .unwrap()
                .into_handle()
                .unwrap();
            h.wait_until_completed().await.unwrap();
            tx.send((bytes, sess.listen_addr().unwrap().port())).unwrap();
            std::future::pending::<()>().await;
        });
    });
    rx.recv_timeout(std::time::Duration::from_secs(60)).expect("seeder ready")
}

#[test]
fn a_torrent_downloads_from_a_local_seeder_and_the_file_is_intact() {
    let data = random_bytes(SIZE);
    let dir = temp_dir("odm-torrent-local-");
    let (torrent, port) = seeder(dir, data.clone());
    // The tracker answers every announce with the seeder (compact peer list).
    let tracker = TestServer::start(Arc::new(move |_r: &Req| {
        let mut b = b"d8:intervali30e5:peers6:".to_vec();
        b.extend_from_slice(&[127, 0, 0, 1]);
        b.extend_from_slice(&port.to_be_bytes());
        b.extend_from_slice(b"e");
        Resp::new(200, b).header("Content-Type", "text/plain")
    }));

    run(async move {
        let env = setup(
            "odm-torrent-local-",
            json!({ "torrent": {
                "enableDht": false, "enableLsd": false, "enableUtp": false, "enablePortForwarding": false,
                "enablePex": std::env::var("ODM_PEX").is_ok(), "encryption": if plain() { "disable" } else { "prefer" },
                "seedRatio": 0, "trackers": format!("{}/announce", tracker.base),
            } }),
        );
        let local = env.dir.join("payload.torrent");
        std::fs::write(&local, &torrent).unwrap();
        let file_url = url::Url::from_file_path(&local).unwrap().to_string();
        let list = opendm_lib::engine::torrent::list_files(&env.store, &env.net, &file_url).await.unwrap();
        let files = list["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "{list}");
        assert_eq!(files[0]["size"].as_u64().unwrap() as usize, SIZE);

        let r = env.mgr.add(&json!({ "url": file_url, "torrentFiles": [files[0]["index"]] })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        assert_eq!(r["item"]["kind"], "torrent");
        let end = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = end.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert_eq!(it["status"], json!("complete"));
        let got = std::fs::read(env.dir.join("out").join("payload.bin")).unwrap();
        assert!(got == data, "torrent file differs from the seeder's ({} vs {} bytes)", got.len(), data.len());
        env.mgr.dispose();
    });
}

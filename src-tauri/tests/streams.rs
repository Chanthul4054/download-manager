//! Port of test/streams.test.js.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use common::*;
use serde_json::json;

/// The bundled ffmpeg from the npm ffmpeg-static package, when it is installed.
fn ffmpeg() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules/ffmpeg-static").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    p.exists().then_some(p)
}

static MEDIA: LazyLock<Arc<HashMap<String, Vec<u8>>>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    if let Some(ff) = ffmpeg() {
        let dir = temp_dir("odm-streams-");
        let v = dir.join("v.mp4");
        let a = dir.join("a.m4a");
        let ok = std::process::Command::new(&ff)
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"])
            .arg(&v)
            .status()
            .is_ok_and(|s| s.success());
        let ok2 = std::process::Command::new(&ff)
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac"])
            .arg(&a)
            .status()
            .is_ok_and(|s| s.success());
        if ok && ok2 {
            m.insert("137".into(), std::fs::read(&v).unwrap());
            m.insert("140".into(), std::fs::read(&a).unwrap());
        }
    }
    m.insert("999".into(), (0..3 * 1024 * 1024 + 7).map(|i| (i % 251) as u8).collect());
    Arc::new(m)
});

/// Mimics googlevideo: byte ranges only via the `range` query parameter, never a Range header.
static SRV: LazyLock<TestServer> = LazyLock::new(|| {
    let media = MEDIA.clone();
    TestServer::start(Arc::new(move |req: &Req| {
        let body = req.query("itag").and_then(|t| media.get(&t).cloned());
        let range = req.query("range");
        match (body, range) {
            (Some(body), Some(r)) if req.header("range").is_none() => {
                let (a, b) = r.split_once('-').unwrap();
                let a: usize = a.parse().unwrap();
                let b: usize = b.parse().unwrap();
                Resp::new(200, body[a..=b.min(body.len() - 1)].to_vec()).header("Content-Type", "application/octet-stream")
            }
            _ => Resp::new(403, ""),
        }
    }))
});

#[test]
fn query_range_mode_downloads_in_bounded_range_chunks() {
    run(async {
        let env = setup("odm-streams-", json!({ "connection": { "maxConnections": 4, "minSegmentKB": 64 } }));
        let len = MEDIA["999"].len();
        let url = format!("{}/videoplayback?itag=999&clen={}", SRV.base, len);
        let r = env.mgr.add(&json!({ "url": url, "fileName": "q.bin", "size": len })).unwrap();
        let id = r["item"]["id"].as_str().unwrap().to_string();
        {
            let it = env.mgr.get(&id).unwrap();
            let mut b = it.borrow_mut();
            b.range_mode = Some("query".into());
            b.size = Some(len as u64);
        }
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        assert!(read(&it["savedPath"]) == MEDIA["999"]);
        env.mgr.dispose();
    });
}

#[test]
fn video_and_audio_streams_are_downloaded_and_merged() {
    let Some(ff) = ffmpeg() else {
        eprintln!("skipped: ffmpeg not available");
        return;
    };
    if !MEDIA.contains_key("137") {
        eprintln!("skipped: could not make test media");
        return;
    }
    opendm_lib::engine::ffmpeg::set_bundled(ff.clone());
    run(async move {
        let env = setup("odm-streams-", json!({ "connection": { "maxConnections": 4, "minSegmentKB": 64 } }));
        let part = |itag: &str, role: &str, ext: &str| json!({ "role": role, "ext": ext, "url": format!("{}/videoplayback?itag={}&clen={}", SRV.base, itag, MEDIA[itag].len()), "size": MEDIA[itag].len() });
        let r = env
            .mgr
            .add(&json!({ "url": "https://www.youtube.com/watch?v=test", "fileName": "Test video.mp4", "kind": "muxed", "parts": [part("137", "video", "mp4"), part("140", "audio", "m4a")] }))
            .unwrap();
        assert_eq!(r["item"]["fileName"], json!("Test video.mp4"));
        let id = r["item"]["id"].as_str().unwrap().to_string();
        for p in env.mgr.get(&id).unwrap().borrow().parts.as_ref().unwrap() {
            p.borrow_mut().range_mode = Some("query".into());
        }
        let done = finished(&env.mgr, &id);
        env.mgr.start(&id);
        let it = done.await.unwrap_or_else(|it| panic!("{}", it["error"]));
        let probe = std::process::Command::new(&ff).args(["-hide_banner", "-i"]).arg(it["savedPath"].as_str().unwrap()).output().unwrap();
        let text = String::from_utf8_lossy(&probe.stderr);
        assert!(text.contains("Video: h264"), "{text}");
        assert!(text.contains("Audio: aac"), "{text}");
        env.mgr.dispose();
    });
}

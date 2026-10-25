//! Site grabber: explores pages and downloads the files it found.

mod common;

use std::sync::Arc;

use common::*;
use opendm_lib::grabber::{new_project, GrabberRun};
use serde_json::json;

#[test]
fn explores_pages_and_reports_each_downloaded_file() {
    let srv = TestServer::start(Arc::new(|req: &Req| match req.path() {
        "/index.html" => Resp::new(200, r#"<title>Home</title><a href="a.jpg">A</a> <a href="sub/p2.html">more</a> <a href="x.pdf">doc</a>"#).header("Content-Type", "text/html"),
        "/sub/p2.html" => Resp::new(200, r#"<img src="b.png">"#).header("Content-Type", "text/html"),
        _ => Resp::new(200, vec![1u8; 3000]).header("Content-Type", "application/octet-stream"),
    }));
    run(async move {
        let env = setup("odm-grab-", json!({}));
        let out = env.dir.join("grab");
        let p = std::rc::Rc::new(std::cell::RefCell::new(new_project(&json!({
            "startUrl": format!("{}/index.html", srv.base), "saveDir": out.to_string_lossy(), "levelsThis": 2,
        }))));
        let run = GrabberRun::new(p.clone(), env.net.clone(), env.mgr.clone());
        run.start().unwrap().await;
        {
            let pb = p.borrow();
            assert_eq!(pb["stats"]["explored"], json!(2));
            assert_eq!(pb["results"]["pages"][0]["title"], json!("Home"));
            let mut files: Vec<String> = pb["results"]["files"].as_array().unwrap().iter().map(|f| f["url"].as_str().unwrap().rsplit('/').next().unwrap().to_string()).collect();
            files.sort();
            // The default file types are images: the PDF is not collected.
            assert_eq!(files, vec!["a.jpg", "b.png"]);
        }
        run.download_checked(None).await;
        let pb = p.borrow();
        for f in pb["results"]["files"].as_array().unwrap() {
            assert_eq!(f["status"], json!("downloaded"), "{f}");
            assert!(std::path::Path::new(f["savedPath"].as_str().unwrap()).exists());
        }
        assert_eq!(pb["stats"]["downloaded"], json!(2));
        env.mgr.dispose();
    });
}

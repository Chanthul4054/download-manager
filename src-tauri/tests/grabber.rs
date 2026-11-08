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

#[test]
fn the_project_login_goes_only_to_its_own_site() {
    let other_auth = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = other_auth.clone();
    let other = TestServer::start(Arc::new(move |req: &Req| {
        seen.lock().unwrap().push(req.header("authorization").unwrap_or("").to_string());
        Resp::new(200, vec![1u8; 100]).header("Content-Type", "application/octet-stream")
    }));
    // Another host name for the same machine, so it is not the project's site.
    let other_base = other.base.replace("127.0.0.1", "localhost");
    let page = format!(r#"<a href="a.jpg">A</a> <a href="{other_base}/b.jpg">B</a>"#);
    let own_auth = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = own_auth.clone();
    let srv = TestServer::start(Arc::new(move |req: &Req| {
        seen.lock().unwrap().push(req.header("authorization").unwrap_or("").to_string());
        match req.path() {
            "/index.html" => Resp::new(200, page.clone()).header("Content-Type", "text/html"),
            _ => Resp::new(200, vec![1u8; 100]).header("Content-Type", "application/octet-stream"),
        }
    }));
    run(async move {
        let env = setup("odm-grab-auth-", json!({}));
        let p = std::rc::Rc::new(std::cell::RefCell::new(new_project(&json!({
            "startUrl": format!("{}/index.html", srv.base), "saveDir": env.dir.join("grab").to_string_lossy(),
            "auth": { "user": "u", "pass": "p" }, "minSizeKB": 0.01,
        }))));
        let run = GrabberRun::new(p.clone(), env.net.clone(), env.mgr.clone());
        run.start().unwrap().await;
        run.download_checked(None).await;
        assert_eq!(p.borrow()["stats"]["downloaded"], json!(2));
        let own = own_auth.lock().unwrap();
        assert!(!own.is_empty() && own.iter().all(|a| a.starts_with("Basic ")), "{own:?}");
        let other = other_auth.lock().unwrap();
        assert!(!other.is_empty() && other.iter().all(|a| a.is_empty()), "{other:?}");
        env.mgr.dispose();
    });
}

//! Port of test/linkgrabber.test.js.

mod common;

use std::rc::Rc;
use std::sync::{Arc, LazyLock};

use common::*;
use opendm_lib::linkgrabber::{LgEvent, LinkGrabber};
use serde_json::json;

static SRV: LazyLock<TestServer> = LazyLock::new(|| {
    TestServer::start(Arc::new(|req: &Req| match req.path() {
        "/gone.zip" => Resp::new(404, ""),
        "/page.html" => Resp::new(200, r#"<a href="/files/a.pdf">A</a> <a href="/files/b.pdf">B</a> <a href="/other.html">next</a>"#).header("Content-Type", "text/html"),
        "/dl" => Resp::new(200, "0123456789").header("Content-Type", "application/octet-stream").header("Content-Disposition", "attachment; filename=\"Real Name.part2.rar\""),
        _ => Resp::new(200, vec![0u8; 1000]).header("Content-Type", "application/octet-stream"),
    }))
});

fn lg_setup() -> (Env, Rc<LinkGrabber>) {
    let env = setup("odm-lg-", json!({}));
    let lg = LinkGrabber::new(env.store.clone(), env.net.clone(), env.mgr.clone());
    (env, lg)
}

/// Waits until no link is being checked.
async fn idle(lg: &LinkGrabber) {
    loop {
        if !lg.snapshot()["busy"].as_bool().unwrap() {
            return;
        }
        once(&lg.events, |e| matches!(e, LgEvent::Changed)).await;
    }
}

fn packages(env: &Env) -> Vec<opendm_lib::linkgrabber::Package> {
    env.store.linkgrabber.borrow().packages.clone()
}

#[test]
fn links_are_checked_grouped_into_packages_and_skipped_when_added_twice() {
    run(async {
        let (env, lg) = lg_setup();
        let b = &SRV.base;
        let n = lg.add(&json!({ "text": format!("{b}/x.part1.rar\n{b}/x.part2.rar {b}/single.mp4 {b}/gone.zip {b}/single.mp4") }));
        assert_eq!(n, 4);
        idle(&lg).await;
        let pk = packages(&env);
        let by = |name: &str| pk.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no package {name}: {:?}", pk.iter().map(|p| &p.name).collect::<Vec<_>>()));
        let mut names: Vec<String> = by("x").links.iter().map(|l| l.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["x.part1.rar", "x.part2.rar"]);
        assert!(by("x").links.iter().all(|l| l.status == "online" && l.size == Some(1000.0)));
        assert_eq!(by("Various files").links[0].name, "single.mp4");
        assert_eq!(by("Offline").links[0].status, "offline");
        assert_eq!(lg.add(&json!({ "text": format!("{b}/single.mp4") })), 0);
        lg.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn a_server_provided_name_moves_a_link_into_the_matching_package() {
    run(async {
        let (env, lg) = lg_setup();
        let b = &SRV.base;
        lg.add(&json!({ "text": format!("{b}/Real%20Name.part1.rar") }));
        idle(&lg).await;
        lg.add(&json!({ "text": format!("{b}/dl") }));
        idle(&lg).await;
        let pk = packages(&env);
        let pkg = pk.iter().find(|p| p.name == "Real Name").unwrap_or_else(|| panic!("expected a \"Real Name\" package, got {:?}", pk.iter().map(|p| &p.name).collect::<Vec<_>>()));
        assert_eq!(pkg.links.len(), 2);
        lg.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn deep_analysis_replaces_a_web_page_with_the_files_it_links_to() {
    run(async {
        let (env, lg) = lg_setup();
        let b = &SRV.base;
        lg.add(&json!({ "text": format!("{b}/page.html"), "deep": true }));
        idle(&lg).await;
        let mut urls: Vec<String> = lg.links().iter().map(|l| l.url.clone()).collect();
        urls.sort();
        assert_eq!(urls, vec![format!("{b}/files/a.pdf"), format!("{b}/files/b.pdf")]);
        assert!(lg.links().iter().all(|l| l.referer == format!("{b}/page.html")));
        lg.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn confirming_moves_online_links_to_the_download_list_into_a_package_folder() {
    run(async {
        let (env, lg) = lg_setup();
        let b = &SRV.base;
        lg.add(&json!({ "text": format!("{b}/y.part1.rar {b}/y.part2.rar {b}/gone.zip") }));
        idle(&lg).await;
        let ids = lg.confirm(&[], &json!({}));
        assert_eq!(ids.len(), 2);
        let want = env.dir.join("out").join("y").to_string_lossy().into_owned();
        for id in &ids {
            assert_eq!(env.mgr.get(id).unwrap().borrow().save_dir, want);
        }
        // The offline link stays behind.
        assert_eq!(lg.links().iter().map(|l| l.status.clone()).collect::<Vec<_>>(), vec!["offline"]);
        // Links already in the download list are skipped by default.
        lg.add(&json!({ "text": format!("{b}/y.part1.rar") }));
        idle(&lg).await;
        assert!(lg.links().iter().find(|l| l.url.ends_with("y.part1.rar")).unwrap().in_list);
        assert!(lg.confirm(&[], &json!({})).is_empty());
        lg.dispose();
        env.mgr.dispose();
    });
}

#[test]
fn merge_and_rename_keep_links_in_a_user_package() {
    run(async {
        let (env, lg) = lg_setup();
        let b = &SRV.base;
        lg.add(&json!({ "text": format!("{b}/one.bin {b}/two.bin") }));
        idle(&lg).await;
        let all: Vec<String> = lg.links().iter().map(|l| l.id.clone()).collect();
        let id = lg.merge(&all, "Mine").unwrap();
        assert_eq!(packages(&env).len(), 1);
        assert_eq!(packages(&env)[0].id, id);
        lg.recheck(&[id]);
        idle(&lg).await;
        assert_eq!(packages(&env).len(), 1);
        assert_eq!(packages(&env)[0].name, "Mine");
        lg.dispose();
        env.mgr.dispose();
    });
}

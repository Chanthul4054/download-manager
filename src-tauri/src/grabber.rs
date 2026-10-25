//! Site grabber (port of src/main/grabber.js): explores pages breadth-first within
//! level/domain/path filters and collects files that match type/path/size filters.

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::rc::{Rc, Weak};

use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio_util::sync::CancellationToken;

use crate::emitter::Emitter;
use crate::engine::net::{NetContext, ReqOpts};
use crate::error::{Error, Result};
use crate::hosters;
use crate::item::Auth;
use crate::js;
use crate::manager::{DownloadManager, MgrEvent};
use crate::store::ProjectRef;
use crate::util::{self as u, decode_uri_component};

const PAGE_EXT: &[&str] = &["", "html", "htm", "shtml", "xhtml", "php", "php3", "php4", "asp", "aspx", "jsp", "jspx", "cfm", "cgi", "pl"];

pub fn file_presets() -> Value {
    json!({
        "images": "*.jpg,*.jpeg,*.png,*.gif,*.webp,*.bmp,*.tif,*.tiff,*.svg",
        "audio": "*.mp3,*.wav,*.wma,*.aac,*.m4a,*.flac,*.ogg,*.opus",
        "video": "*.mp4,*.avi,*.mkv,*.webm,*.mov,*.wmv,*.flv,*.mpg,*.mpeg,*.m4v,*.3gp",
        "documents": "*.pdf,*.doc,*.docx,*.xls,*.xlsx,*.ppt,*.pptx,*.txt,*.rtf,*.odt,*.epub",
        "archives": "*.zip,*.rar,*.7z,*.gz,*.tar,*.bz2,*.xz",
        "programs": "*.exe,*.msi,*.dmg,*.deb,*.rpm,*.apk,*.iso",
        "all": "*.*",
    })
}

pub fn new_project(patch: &Value) -> Value {
    let mut p = json!({
        "id": u::id(),
        "name": "New project",
        "startUrl": "",
        "auth": null,
        "saveDir": "",
        "category": "general",
        "useSubfolders": false,
        "overwrite": false,
        "levelsThis": 1,
        "levelsOther": 0,
        "dontExploreParent": true,
        "exploreMainDomain": false,
        "pageInclude": "",
        "pageExclude": "",
        "fileTypes": file_presets()["images"],
        "fileExcludeTypes": "",
        "pathInclude": "",
        "pathExclude": "",
        "thisSiteOnly": false,
        "hideDuplicates": true,
        "minSizeKB": 0,
        "maxSizeKB": 0,
        "startDownloadAll": false,
        "concurrentExplore": 4,
        "concurrentDownload": 2,
        "schedule": { "enabled": false, "mode": "once", "action": "explore-download", "startTime": "02:00", "days": [0, 1, 2, 3, 4, 5, 6], "periodicMinutes": 0, "stopEnabled": false, "stopTime": "08:00" },
        "results": { "pages": [], "files": [] },
        "stats": { "explored": 0, "matched": 0, "downloaded": 0, "pagesFound": 0, "filesFound": 0, "errors": 0 },
    });
    if let (Some(o), Some(patch)) = (p.as_object_mut(), patch.as_object()) {
        for (k, v) in patch {
            o.insert(k.clone(), v.clone());
        }
    }
    p
}

#[derive(Debug, Clone)]
pub struct Link {
    pub url: String,
    pub text: String,
    pub tag: &'static str,
}

static BASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)"#).unwrap());
static A_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)</a>"#).unwrap());
static SRC_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:src|href|data-src|data-original|data-href|poster|data-url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static SRCSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bsrcset\s*=\s*["']([^"']+)["']"#).unwrap());
static CSS_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)url\(\s*['"]?([^'")]+)['"]?\s*\)"#).unwrap());
static FRAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)<(?:frame|iframe)\b[^>]*src\s*=\s*["']?([^"'\s>]+)"#).unwrap());
static SKIP_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(javascript|mailto|tel|data|blob|about):").unwrap());
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<title[^>]*>([^<]*)</title>").unwrap());
static PAGE_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)html|xml|text/plain").unwrap());

/// Pulls candidate URLs from HTML: href/src/srcset/data-* attributes, CSS url(), and <base>.
pub fn extract_links(html: &str, page_url: &str) -> Vec<Link> {
    let base_url = match BASE.captures(html) {
        Some(b) => url::Url::parse(page_url).ok().and_then(|p| p.join(&b[1]).ok()).map(|x| x.to_string()).unwrap_or_else(|| page_url.to_string()),
        None => page_url.to_string(),
    };
    let base = url::Url::parse(&base_url).ok();
    let mut out: Vec<Link> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |raw: Option<&str>, text: &str, tag: &'static str| {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else { return };
        let raw = raw.trim().replace("&amp;", "&");
        if SKIP_SCHEME.is_match(&raw) || raw.starts_with('#') {
            return;
        }
        let Some(base) = &base else { return };
        let Ok(mut abs) = base.join(&raw) else { return };
        if !hosters::keeps_fragment(abs.as_str()) {
            abs.set_fragment(None);
        }
        if !matches!(abs.scheme(), "http" | "https" | "ftp") {
            return;
        }
        let href = abs.to_string();
        if seen.insert(href.clone()) {
            let t = TAGS.replace_all(text, "");
            let t = SPACES.replace_all(&t, " ");
            out.push(Link { url: href, text: u::js_slice(t.trim(), 0, 200), tag });
        }
    };
    let pick = |c: &regex::Captures| c.get(1).or(c.get(2)).or(c.get(3)).map(|m| m.as_str().to_string());
    for m in A_TAG.captures_iter(html) {
        add(pick(&m).as_deref(), m.get(4).map(|x| x.as_str()).unwrap_or(""), "a");
    }
    for m in SRC_ATTR.captures_iter(html) {
        add(pick(&m).as_deref(), "", "src");
    }
    for m in SRCSET.captures_iter(html) {
        for part in m[1].split(',') {
            add(part.trim().split_whitespace().next(), "", "src");
        }
    }
    for m in CSS_URL.captures_iter(html) {
        add(Some(&m[1]), "", "css");
    }
    for m in FRAME.captures_iter(html) {
        add(Some(&m[1]), "", "frame");
    }
    out
}

fn main_domain(host: &str) -> String {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 2 {
        parts[parts.len() - 2..].join(".")
    } else {
        host.to_string()
    }
}

fn matches_any(patterns: &Value, value: &str) -> bool {
    let p = js::str_of(patterns).replace(',', " ");
    u::split_str(&p).iter().any(|p| u::wildcard_match(&p.replacen("<start page>", "", 1), value) || u::wildcard_match(p, value))
}

#[derive(Clone)]
pub enum GEvent {
    Update,
    Done,
}

struct Job {
    url: String,
    level: f64,
    other_level: f64,
}

/// Runs one grabber project. Emits update and done.
pub struct GrabberRun {
    me: RefCell<Weak<GrabberRun>>,
    pub p: ProjectRef,
    net: Rc<NetContext>,
    manager: Rc<DownloadManager>,
    abort: RefCell<CancellationToken>,
    seen_pages: RefCell<HashSet<String>>,
    seen_files: RefCell<HashSet<String>>,
    dup_keys: RefCell<HashSet<String>>,
    start_host: RefCell<String>,
    start_dir: RefCell<String>,
    main: RefCell<String>,
    pub running: Cell<bool>,
    inflight: Cell<i64>,
    pub events: Emitter<GEvent>,
}

fn pv(p: &ProjectRef, key: &str) -> Value {
    js::get(&p.borrow(), key).clone()
}

impl GrabberRun {
    pub fn new(project: ProjectRef, net: Rc<NetContext>, manager: Rc<DownloadManager>) -> Rc<GrabberRun> {
        let (pages, files): (HashSet<String>, HashSet<String>) = {
            let p = project.borrow();
            let urls = |k: &str| -> HashSet<String> {
                p["results"][k].as_array().map(|a| a.iter().map(|x| js::str_of(&x["url"])).collect()).unwrap_or_default()
            };
            (urls("pages"), urls("files"))
        };
        let g = Rc::new(GrabberRun {
            me: RefCell::new(Weak::new()),
            p: project,
            net,
            manager,
            abort: RefCell::new(CancellationToken::new()),
            seen_pages: RefCell::new(pages),
            seen_files: RefCell::new(files),
            dup_keys: RefCell::new(HashSet::new()),
            start_host: RefCell::new(String::new()),
            start_dir: RefCell::new(String::new()),
            main: RefCell::new(String::new()),
            running: Cell::new(false),
            inflight: Cell::new(0),
            events: Emitter::default(),
        });
        *g.me.borrow_mut() = Rc::downgrade(&g);
        g
    }

    fn rc(&self) -> Rc<GrabberRun> {
        self.me.borrow().upgrade().expect("run alive")
    }

    fn update(&self) {
        self.events.emit(GEvent::Update);
    }

    fn auth(&self) -> Option<Auth> {
        let a = pv(&self.p, "auth");
        if a.is_object() {
            serde_json::from_value(a).ok()
        } else {
            None
        }
    }

    fn stat_inc(&self, key: &str) {
        let mut p = self.p.borrow_mut();
        let s = js::get_mut(js::get_mut(&mut p, "stats"), key);
        let n = js::num(s);
        let n = if n.is_nan() { 0.0 } else { n } + 1.0;
        *s = if n.fract() == 0.0 { json!(n as i64) } else { json!(n) };
    }

    /// Starts exploring; the returned future runs the whole exploration (JS `start()`).
    pub fn start(&self) -> Result<impl std::future::Future<Output = ()>> {
        let start_url = js::str_of(&pv(&self.p, "startUrl"));
        let start = url::Url::parse(&start_url).map_err(|_| Error::with_code("Invalid URL", "ERR_INVALID_URL"))?;
        let host = start.host_str().unwrap_or("").to_string();
        let path = start.path();
        *self.start_dir.borrow_mut() = path[..path.rfind('/').map(|i| i + 1).unwrap_or(0)].to_string();
        *self.main.borrow_mut() = main_domain(&host);
        *self.start_host.borrow_mut() = host;
        self.running.set(true);
        self.inflight.set(0);
        let href = start.to_string();
        {
            let mut p = self.p.borrow_mut();
            p["stats"] = json!({ "explored": 0, "matched": 0, "downloaded": 0, "pagesFound": 1, "filesFound": 0, "errors": 0 });
            p["results"] = json!({ "pages": [{ "url": href, "level": 0, "parent": null, "status": "queued" }], "files": [] });
        }
        self.seen_pages.borrow_mut().clear();
        self.seen_files.borrow_mut().clear();
        self.seen_pages.borrow_mut().insert(href.clone());
        let queue = Rc::new(RefCell::new(VecDeque::from([Job { url: href, level: 0.0, other_level: 0.0 }])));
        let me = self.rc();
        Ok(async move { me.explore(queue).await })
    }

    fn is_this_site(&self, host: &str) -> bool {
        let main = self.main.borrow();
        host == *self.start_host.borrow()
            || (js::truthy(&pv(&self.p, "exploreMainDomain")) && (host == *main || host.ends_with(&format!(".{}", main))))
    }

    fn page_allowed(&self, url: &str, level: f64, other_level: f64) -> bool {
        let Ok(x) = url::Url::parse(url) else { return false };
        let ext = u::ext_of(x.path());
        if !PAGE_EXT.contains(&ext.as_str()) {
            return false;
        }
        let host = x.host_str().unwrap_or("");
        if self.is_this_site(host) {
            if level > js::num(&pv(&self.p, "levelsThis")) {
                return false;
            }
            if js::truthy(&pv(&self.p, "dontExploreParent")) && host == *self.start_host.borrow() && !x.path().starts_with(self.start_dir.borrow().as_str()) {
                return false;
            }
        } else if other_level > js::num(&pv(&self.p, "levelsOther")) {
            return false;
        }
        let hp = format!("{}{}", host, x.path());
        let inc = pv(&self.p, "pageInclude");
        let exc = pv(&self.p, "pageExclude");
        if js::truthy(&inc) && !matches_any(&inc, &hp) && !matches_any(&inc, url) {
            return false;
        }
        if js::truthy(&exc) && (matches_any(&exc, &hp) || matches_any(&exc, url)) {
            return false;
        }
        true
    }

    fn file_matches(&self, url: &str) -> bool {
        let Ok(x) = url::Url::parse(url) else { return false };
        let last = x.path().split('/').next_back().unwrap_or("");
        let Some(name) = decode_uri_component(last) else { return false };
        if name.is_empty() {
            return false;
        }
        if !matches_any(&pv(&self.p, "fileTypes"), &name) {
            return false;
        }
        let ex = pv(&self.p, "fileExcludeTypes");
        if js::truthy(&ex) && matches_any(&ex, &name) {
            return false;
        }
        let host = x.host_str().unwrap_or("");
        if js::truthy(&pv(&self.p, "thisSiteOnly")) && !self.is_this_site(host) {
            return false;
        }
        let hp = format!("{}{}", host, x.path());
        let inc = pv(&self.p, "pathInclude");
        let exc = pv(&self.p, "pathExclude");
        if js::truthy(&inc) && !matches_any(&inc, &hp) {
            return false;
        }
        if js::truthy(&exc) && matches_any(&exc, &hp) {
            return false;
        }
        true
    }

    async fn explore(self: Rc<Self>, queue: Rc<RefCell<VecDeque<Job>>>) {
        let n = js::num(&pv(&self.p, "concurrentExplore")).max(1.0) as usize;
        let worker = || async {
            while self.running.get() {
                let job = queue.borrow_mut().pop_front();
                let Some(job) = job else {
                    if self.inflight.get() > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                    return;
                };
                self.inflight.set(self.inflight.get() + 1);
                self.process_page(job, &queue).await;
                self.inflight.set(self.inflight.get() - 1);
            }
        };
        let workers: Vec<_> = (0..n).map(|_| worker()).collect();
        join_all(workers).await;
        if self.running.get() && js::truthy(&pv(&self.p, "startDownloadAll")) {
            self.download_checked(None).await;
        }
        self.running.set(false);
        self.events.emit(GEvent::Done);
    }

    fn with_page(&self, url: &str, f: impl FnOnce(&mut Value)) {
        let mut p = self.p.borrow_mut();
        if let Some(pages) = p["results"]["pages"].as_array_mut() {
            if let Some(rec) = pages.iter_mut().find(|x| js::s(&x["url"]) == url) {
                f(rec);
            }
        }
    }

    async fn process_page(&self, job: Job, queue: &Rc<RefCell<VecDeque<Job>>>) {
        self.with_page(&job.url, |r| r["status"] = json!("exploring"));
        self.update();
        let r: Result<()> = async {
            let opts = ReqOpts { signal: Some(self.abort.borrow().clone()), auth: self.auth(), max_bytes: Some(8 * 1024 * 1024), timeout_sec: Some(30.0), ..Default::default() };
            let f = self.net.fetch_buffer(&job.url, &opts).await?;
            self.stat_inc("explored");
            let ty = f.headers.get("content-type").cloned().unwrap_or_default();
            if !PAGE_TYPE.is_match(&ty) {
                self.with_page(&job.url, |r| r["status"] = json!("not a page"));
                return Ok(());
            }
            let html = String::from_utf8_lossy(&f.body).into_owned();
            let title = TITLE.captures(&html).map(|c| c[1].trim().to_string()).unwrap_or_default();
            self.with_page(&job.url, |r| {
                r["status"] = json!("explored");
                r["title"] = json!(title);
            });
            for l in extract_links(&html, &f.url) {
                if !self.running.get() {
                    break;
                }
                let host = u::hostname(&l.url);
                let on_this = self.is_this_site(&host);
                if self.file_matches(&l.url) {
                    self.add_file(&l, &job.url).await;
                    continue;
                }
                if self.seen_pages.borrow().contains(&l.url) {
                    continue;
                }
                let level = if on_this { job.level + 1.0 } else { job.level };
                let other = if on_this { 0.0 } else { job.other_level + 1.0 };
                if !self.page_allowed(&l.url, level, other) {
                    continue;
                }
                self.seen_pages.borrow_mut().insert(l.url.clone());
                {
                    let mut p = self.p.borrow_mut();
                    if let Some(pages) = p["results"]["pages"].as_array_mut() {
                        pages.push(json!({ "url": l.url, "level": level, "parent": job.url, "status": "queued", "text": l.text }));
                    }
                }
                self.stat_inc("pagesFound");
                queue.borrow_mut().push_back(Job { url: l.url.clone(), level, other_level: other });
            }
            Ok(())
        }
        .await;
        if let Err(e) = r {
            if !self.abort.borrow().is_cancelled() {
                self.with_page(&job.url, |r| r["status"] = json!(format!("error: {}", e.message)));
                self.stat_inc("errors");
            }
        }
        self.update();
    }

    async fn add_file(&self, link: &Link, page: &str) {
        if !self.seen_files.borrow_mut().insert(link.url.clone()) {
            return;
        }
        let mut f = json!({ "url": link.url, "page": page, "description": link.text, "size": null, "type": "", "checked": true, "status": "found" });
        self.stat_inc("filesFound");
        let min = js::num(&pv(&self.p, "minSizeKB"));
        let max = js::num(&pv(&self.p, "maxSizeKB"));
        let hide = js::truthy(&pv(&self.p, "hideDuplicates"));
        if min > 0.0 || max > 0.0 || hide {
            let opts = ReqOpts { signal: Some(self.abort.borrow().clone()), auth: self.auth(), timeout_sec: Some(20.0), ..Default::default() };
            match self.net.probe(&link.url, &opts).await {
                Ok(pr) => {
                    f["size"] = json!(pr.size);
                    f["type"] = json!(pr.content_type);
                }
                Err(_) => f["status"] = json!("unreachable"),
            }
            let size = f["size"].as_f64();
            if min > 0.0 && size.is_some_and(|s| s < min * 1024.0) {
                return;
            }
            if max > 0.0 && size.is_some_and(|s| s > max * 1024.0) {
                return;
            }
            if hide && !js::truthy(&pv(&self.p, "useSubfolders")) {
                let key = format!(
                    "{}|{}",
                    u::file_name_from_url(&link.url).unwrap_or_else(|| "null".into()),
                    size.map(js::fmt_num).unwrap_or_else(|| "null".into())
                );
                if !self.dup_keys.borrow_mut().insert(key) {
                    return;
                }
            }
        }
        {
            let mut p = self.p.borrow_mut();
            if let Some(files) = p["results"]["files"].as_array_mut() {
                files.push(f);
            }
        }
        self.stat_inc("matched");
        self.update();
    }

    fn target_dir(&self, file_url: &str) -> String {
        let save_dir = js::str_of(&pv(&self.p, "saveDir"));
        let base = if save_dir.is_empty() { self.manager.folder_for_category(&js::str_of(&pv(&self.p, "category"))) } else { save_dir };
        if !js::truthy(&pv(&self.p, "useSubfolders")) {
            return base;
        }
        let Ok(x) = url::Url::parse(file_url) else { return base };
        let path = decode_uri_component(x.path()).unwrap_or_else(|| x.path().to_string());
        let segs: Vec<&str> = path.split('/').collect();
        let mut dir = std::path::PathBuf::from(base).join(u::sanitize_file_name(x.host_str().unwrap_or("")));
        for d in segs[..segs.len().saturating_sub(1)].iter().filter(|s| !s.is_empty()) {
            dir = dir.join(u::sanitize_file_name(d));
        }
        dir.to_string_lossy().into_owned()
    }

    fn with_file(&self, url: &str, f: impl FnOnce(&mut Value)) {
        let mut p = self.p.borrow_mut();
        if let Some(files) = p["results"]["files"].as_array_mut() {
            if let Some(x) = files.iter_mut().find(|x| js::s(&x["url"]) == url) {
                f(x);
            }
        }
    }

    /// Downloads checked files `concurrentDownload` at a time; each file gets 2 attempts.
    pub async fn download_checked(&self, urls: Option<Vec<String>>) {
        let files: Vec<Value> = {
            let p = self.p.borrow();
            p["results"]["files"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|f| {
                            let pick = match &urls {
                                Some(list) => list.contains(&js::str_of(&f["url"])),
                                None => js::truthy(&f["checked"]),
                            };
                            pick && js::s(&f["status"]) != "downloaded"
                        })
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        };
        self.running.set(true);
        let queue = RefCell::new(VecDeque::from(files));
        let n = js::num(&pv(&self.p, "concurrentDownload")).max(1.0) as usize;
        let worker = || async {
            loop {
                if !self.running.get() {
                    return;
                }
                let Some(f) = queue.borrow_mut().pop_front() else { return };
                let url = js::str_of(&f["url"]);
                let mut attempt = 0;
                while attempt < 2 && self.running.get() {
                    attempt += 1;
                    self.with_file(&url, |x| x["status"] = json!("downloading"));
                    self.update();
                    let opts = json!({
                        "url": url, "saveDir": self.target_dir(&url), "category": pv(&self.p, "category"),
                        "description": f["description"], "referer": f["page"], "auth": pv(&self.p, "auth"),
                        "duplicateAction": if js::truthy(&pv(&self.p, "overwrite")) { "overwrite" } else { "number" },
                    });
                    let ok = match self.manager.add(&opts) {
                        Ok(r) => {
                            let id = js::str_of(&r["item"]["id"]);
                            self.with_file(&url, |x| x["itemId"] = json!(id));
                            let ok = self.wait_item(&id).await;
                            if ok {
                                let saved = self.manager.get(&id).and_then(|it| it.borrow().saved_path.clone());
                                self.with_file(&url, |x| x["savedPath"] = json!(saved));
                            }
                            ok
                        }
                        Err(_) => false,
                    };
                    self.with_file(&url, |x| x["status"] = json!(if ok { "downloaded" } else { "failed" }));
                    if ok {
                        self.stat_inc("downloaded");
                        break;
                    }
                }
                self.update();
            }
        };
        let workers: Vec<_> = (0..n).map(|_| worker()).collect();
        join_all(workers).await;
    }

    async fn wait_item(&self, id: &str) -> bool {
        let m = &self.manager;
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        let tx = RefCell::new(Some(tx));
        let want = id.to_string();
        let h = m.events.on(move |e| {
            let r = match e {
                MgrEvent::Complete(it) if js::s(&it["id"]) == want => Some(true),
                MgrEvent::Failed(it, _) if js::s(&it["id"]) == want => Some(false),
                MgrEvent::Stopped(sid) if *sid == want => Some(false),
                _ => None,
            };
            if let Some(v) = r {
                if let Some(t) = tx.borrow_mut().take() {
                    let _ = t.send(v);
                }
            }
        });
        if !m.start(id) {
            m.events.off(h);
            return m.get(id).is_some_and(|it| it.borrow().status == "complete");
        }
        let v = rx.await.unwrap_or(false);
        m.events.off(h);
        v
    }

    /// Adds checked files to the main list (and optionally to a queue) without downloading.
    pub fn add_to_list(&self) -> Vec<String> {
        let files: Vec<Value> = self.p.borrow()["results"]["files"].as_array().map(|a| a.iter().filter(|x| js::truthy(&x["checked"])).cloned().collect()).unwrap_or_default();
        let mut ids = Vec::new();
        for f in files {
            let url = js::str_of(&f["url"]);
            let opts = json!({
                "url": url, "saveDir": self.target_dir(&url), "category": pv(&self.p, "category"), "description": f["description"],
                "referer": f["page"], "auth": pv(&self.p, "auth"), "duplicateAction": "resume",
            });
            if let Ok(r) = self.manager.add(&opts) {
                ids.push(js::str_of(&r["item"]["id"]));
            }
        }
        ids
    }

    pub fn stop(&self) {
        self.running.set(false);
        self.abort.borrow().cancel();
        let downloading: Vec<String> = self.p.borrow()["results"]["files"]
            .as_array()
            .map(|a| a.iter().filter(|f| js::s(&f["status"]) == "downloading" && js::truthy(&f["itemId"])).map(|f| js::str_of(&f["itemId"])).collect())
            .unwrap_or_default();
        for id in downloading {
            self.manager.stop(&id, None);
        }
    }
}

async fn join_all<F: std::future::Future<Output = ()>>(futs: Vec<F>) {
    let mut set: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    std::future::poll_fn(|cx| {
        set.retain_mut(|f| f.as_mut().poll(cx).is_pending());
        if set.is_empty() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_from_html() {
        let html = r##"<base href="/sub/"><a href="a.pdf">A <b>doc</b></a> <img src='i.png'> <a href="#x">skip</a>
            <a href="mailto:x@y">m</a> <div style="background:url('bg.jpg')"></div> <img srcset="s1.jpg 1x, s2.jpg 2x">"##;
        let l = extract_links(html, "http://h/p/page.html");
        let urls: Vec<&str> = l.iter().map(|x| x.url.as_str()).collect();
        assert!(urls.contains(&"http://h/sub/a.pdf"));
        assert!(urls.contains(&"http://h/sub/i.png"));
        assert!(urls.contains(&"http://h/sub/bg.jpg"));
        assert!(urls.contains(&"http://h/sub/s2.jpg"));
        assert!(!urls.iter().any(|u| u.starts_with("mailto")));
        assert_eq!(l.iter().find(|x| x.url.ends_with("a.pdf")).unwrap().text, "A doc");
        let l = extract_links(r#"<a href="https://fuckingfast.co/x1#G.part01.rar">1</a><a href="/p#top">p</a>"#, "http://h/");
        assert_eq!(l.iter().map(|x| x.url.as_str()).collect::<Vec<_>>(), ["https://fuckingfast.co/x1#G.part01.rar", "http://h/p"]);
    }

    #[test]
    fn domains_and_patterns() {
        assert_eq!(main_domain("a.b.example.com"), "example.com");
        assert!(matches_any(&json!("*.jpg,*.png"), "x.PNG"));
        assert!(!matches_any(&json!(""), "x"));
    }
}

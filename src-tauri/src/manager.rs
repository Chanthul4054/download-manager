//! Owns the download list and running engines (port of src/main/manager.js). Emits:
//!  changed(item) · removed(ids) · progress(id, stats) · complete(item) · failed(item, err) · quota(state)

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::{Rc, Weak};

use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use tokio::task::JoinHandle;

use crate::diag::{diag, redact_url};
use crate::emitter::Emitter;
use crate::engine::ftp_download::FtpDownload;
use crate::engine::hls_download::HlsDownload;
use crate::engine::http_download::HttpDownload;
use crate::engine::limiter::{LimiterRef, RateLimiter};
use crate::engine::muxed_download::{muxed_stats, MuxedDownload};
use crate::engine::net::{NetContext, ReqOpts};
use crate::engine::ytdlp::{is_video_page, YtDlpDownload};
use crate::engine::{interval, Ctx, Engine, EngineEvent, Sink};
use crate::error::{Error, Result};
use crate::item::{seg, Auth, Item, ItemRef};
use crate::js::{self, now_ms};
use crate::store::Store;
use crate::util::{self as u, join};

const ACTIVE: &[&str] = &["downloading", "connecting", "waiting"];

#[derive(Clone)]
pub enum MgrEvent {
    Changed(Value),
    Removed(Vec<String>),
    Progress(String, Value),
    Complete(Value),
    Failed(Value, String),
    Quota(Value),
    Started(String),
    Stopped(String),
    Enqueue(String, String),
}

pub struct DownloadManager {
    me: RefCell<Weak<DownloadManager>>,
    pub store: Rc<Store>,
    pub net: Rc<NetContext>,
    engines: RefCell<Vec<(String, Rc<dyn Engine>)>>,
    /// Ids started while every slot was busy, in order.
    waiting: RefCell<Vec<String>>,
    pub global_limiter: LimiterRef,
    quota_log: RefCell<Vec<(i64, u64)>>,
    quota_paused: RefCell<Vec<String>>,
    quota_timer: RefCell<Option<JoinHandle<()>>>,
    pub events: Emitter<MgrEvent>,
}

static M3U8_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.m3u8?$").unwrap());
static M3U8_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.m3u8(\?|#|$)").unwrap());
static FTP_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^ftp:").unwrap());
static MEDIA_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(mp4|webm|mkv|m4a|weba|bin)$").unwrap());
static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[^a-z0-9]").unwrap());
static GOOGLEVIDEO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|\.)googlevideo\.com$").unwrap());

pub fn is_google_video(url: &str) -> bool {
    let Ok(x) = url::Url::parse(url) else { return false };
    let clen = x.query_pairs().find(|(k, _)| k == "clen").map(|(_, v)| js::num(&Value::String(v.into_owned()))).unwrap_or(0.0);
    GOOGLEVIDEO.is_match(x.host_str().unwrap_or("")) && x.path().starts_with("/videoplayback") && clen > 0.0
}

/// Container that can hold every part without re-encoding.
pub fn container_for(parts: &[(String, String)]) -> String {
    let exts: Vec<String> = parts.iter().map(|(ext, _)| ext.to_lowercase()).collect();
    if parts.len() == 1 {
        return if exts[0] == "webm" && parts[0].1 == "audio" { "weba".into() } else { exts[0].clone() };
    }
    if exts.iter().all(|e| ["mp4", "m4a", "m4v"].contains(&e.as_str())) {
        return "mp4".into();
    }
    if exts.iter().all(|e| ["webm", "weba"].contains(&e.as_str())) {
        return "webm".into();
    }
    "mkv".into()
}

impl DownloadManager {
    pub fn new(store: Rc<Store>, net: Rc<NetContext>) -> Rc<DownloadManager> {
        for d in store.downloads.borrow().iter() {
            let mut d = d.borrow_mut();
            if ACTIVE.contains(&d.status.as_str()) {
                d.status = "paused".into();
            }
        }
        let m = Rc::new(DownloadManager {
            me: RefCell::new(Weak::new()),
            store,
            net,
            engines: RefCell::new(Vec::new()),
            waiting: RefCell::new(Vec::new()),
            global_limiter: RateLimiter::shared(0.0),
            quota_log: RefCell::new(Vec::new()),
            quota_paused: RefCell::new(Vec::new()),
            quota_timer: RefCell::new(None),
            events: Emitter::default(),
        });
        *m.me.borrow_mut() = Rc::downgrade(&m);
        m.apply_speed_limiter();
        let w = Rc::downgrade(&m);
        *m.quota_timer.borrow_mut() = Some(interval(10000, move || {
            if let Some(m) = w.upgrade() {
                m.check_quota();
            }
        }));
        m
    }

    fn rc(&self) -> Rc<DownloadManager> {
        self.me.borrow().upgrade().expect("manager alive")
    }

    fn emit(&self, e: MgrEvent) {
        self.events.emit(e);
    }

    fn setting(&self, path: &[&str]) -> Value {
        self.store.s(path)
    }

    pub fn items(&self) -> Vec<ItemRef> {
        self.store.downloads.borrow().clone()
    }

    pub fn get(&self, id: &str) -> Option<ItemRef> {
        self.store.downloads.borrow().iter().find(|d| d.borrow().id == id).cloned()
    }

    fn engine(&self, id: &str) -> Option<Rc<dyn Engine>> {
        self.engines.borrow().iter().find(|(x, _)| x == id).map(|(_, e)| e.clone())
    }

    pub fn has_engine(&self, id: &str) -> bool {
        self.engines.borrow().iter().any(|(x, _)| x == id)
    }

    fn remove_engine(&self, id: &str) {
        self.engines.borrow_mut().retain(|(x, _)| x != id);
    }

    pub fn persist(&self) {
        self.store.save_after("downloads", 1000);
    }

    pub fn touch(&self, item: &ItemRef) {
        self.persist();
        let p = self.public_item(item);
        self.emit(MgrEvent::Changed(p));
    }

    pub fn public_item(&self, d: &ItemRef) -> Value {
        let it = d.borrow();
        let mut v = it.to_value();
        let o = v.as_object_mut().unwrap();
        o.remove("segments");
        o.remove("auth");
        o.remove("cookies");
        o.remove("parts");
        o.insert("hasAuth".into(), json!(it.auth.is_some()));
        o.insert("segmentCount".into(), json!(it.segments.as_ref().map(|s| s.len()).unwrap_or(0)));
        o.insert("active".into(), json!(self.has_engine(&it.id)));
        if let Some(parts) = &it.parts {
            let list: Vec<Value> = parts
                .iter()
                .map(|x| {
                    let x = x.borrow();
                    json!({ "role": x.role, "label": x.label, "size": x.size, "ext": x.ext, "done": x.done })
                })
                .collect();
            o.insert("parts".into(), Value::Array(list));
        }
        v
    }

    pub fn list(&self) -> Vec<Value> {
        self.items().iter().map(|d| self.public_item(d)).collect()
    }

    // ---- speed / quota -------------------------------------------------------------------------

    pub fn apply_speed_limiter(&self) {
        let s = self.setting(&["speedLimiter"]);
        let rate = if js::truthy(js::get(&s, "enabled")) { js::num(js::get(&s, "kbps")) * 1024.0 } else { 0.0 };
        self.global_limiter.borrow_mut().set_rate(if rate.is_nan() { 0.0 } else { rate });
    }

    pub fn on_bytes(&self, n: u64) {
        let minute = (now_ms() / 60000.0).floor() as i64;
        let mut log = self.quota_log.borrow_mut();
        match log.last_mut() {
            Some(last) if last.0 == minute => last.1 += n,
            _ => log.push((minute, n)),
        }
    }

    fn quota_usage(&self) -> u64 {
        let hours = js::num(&self.setting(&["connection", "quota", "hours"]));
        let since = (now_ms() / 60000.0).floor() - hours * 60.0;
        let mut log = self.quota_log.borrow_mut();
        log.retain(|e| e.0 as f64 > since);
        log.iter().map(|e| e.1).sum()
    }

    pub fn check_quota(&self) {
        let q = self.setting(&["connection", "quota"]);
        if !js::truthy(js::get(&q, "enabled")) {
            if !self.quota_paused.borrow().is_empty() {
                self.resume_quota_paused();
            }
            return;
        }
        let used = self.quota_usage();
        if used as f64 >= js::num(js::get(&q, "mb")) * 1024.0 * 1024.0 {
            let ids: Vec<String> = self.engines.borrow().iter().map(|(id, _)| id.clone()).collect();
            for id in ids {
                {
                    let mut qp = self.quota_paused.borrow_mut();
                    if !qp.contains(&id) {
                        qp.push(id.clone());
                    }
                }
                self.stop(&id, Some("Waiting: download limit reached"));
            }
            if !self.quota_paused.borrow().is_empty() {
                self.emit(MgrEvent::Quota(json!({ "exceeded": true, "used": used })));
            }
        } else if !self.quota_paused.borrow().is_empty() {
            self.resume_quota_paused();
        }
    }

    fn resume_quota_paused(&self) {
        let ids: Vec<String> = std::mem::take(&mut *self.quota_paused.borrow_mut());
        for id in ids {
            self.start(&id);
        }
        self.emit(MgrEvent::Quota(json!({ "exceeded": false })));
    }

    pub fn max_conn_for(&self, url: &str) -> f64 {
        let c = self.setting(&["connection"]);
        if let Ok(x) = url::Url::parse(url) {
            let host = x.host_str().unwrap_or("").to_string();
            let ex = js::get(&c, "serverExceptions").as_array().and_then(|list| {
                list.iter()
                    .find(|e| {
                        let server = js::str_of(js::get(e, "server"));
                        u::wildcard_match(&server, &host) || u::wildcard_match(&server, &format!("*.{}", host))
                    })
                    .cloned()
            });
            if let Some(ex) = ex {
                return js::num_or(js::get(&ex, "maxConnections"), 1.0).max(1.0);
            }
        }
        js::num_or(js::get(&c, "maxConnections"), 8.0).max(1.0)
    }

    // ---- categories / naming -------------------------------------------------------------------

    pub fn category_for_name(&self, name: &str) -> String {
        let ext = u::ext_of(name);
        if ext.is_empty() {
            return "general".into();
        }
        let cats = self.store.categories.borrow();
        cats.as_array()
            .and_then(|list| {
                list.iter().find(|c| {
                    js::s(js::get(c, "id")) != "general" && u::split_list(js::get(c, "exts")).iter().any(|p| u::wildcard_match(p, &ext))
                })
            })
            .map(|c| js::str_of(js::get(c, "id")))
            .unwrap_or_else(|| "general".into())
    }

    pub fn folder_for_category(&self, cat_id: &str) -> String {
        let last = self.setting(&["lastSaveDirs", cat_id]);
        if js::truthy(&self.setting(&["saveTo", "rememberLastPath"])) && js::truthy(&last) {
            return js::str_of(&last);
        }
        let cats = self.store.categories.borrow();
        let list = cats.as_array().cloned().unwrap_or_default();
        let cat = list.iter().find(|c| js::s(js::get(c, "id")) == cat_id).or(list.first());
        cat.map(|c| js::str_of(js::get(c, "folder"))).unwrap_or_default()
    }

    pub fn guess_name(&self, url: &str, given: Option<&str>, mime: Option<&str>) -> String {
        let mut name = given
            .filter(|g| !g.is_empty())
            .map(|g| g.to_string())
            .or_else(|| u::file_name_from_url(url).filter(|n| !n.is_empty()))
            .unwrap_or_else(|| "download".into());
        if M3U8_END.is_match(&name) {
            name = M3U8_END.replace(&name, ".ts").into_owned();
        }
        if let Some(m) = mime.filter(|m| !m.is_empty()) {
            if u::ext_of(&name).is_empty() {
                name.push_str(u::ext_for_mime(m));
            }
        }
        u::sanitize_file_name(&name)
    }

    /// Helps the "Download File Info" dialog: suggested name/category/folder for a URL.
    pub async fn describe(&self, url: &str, opts: &Value) -> Value {
        let parts_len = js::get(opts, "parts").as_array().map(|a| a.len()).unwrap_or(0);
        let explicit = js::str_of(js::get(opts, "kind"));
        let kind = if parts_len > 0 {
            "muxed".to_string()
        } else {
            self.kind_for(url, if explicit == "muxed" || explicit.is_empty() { None } else { Some(&explicit) })
        };
        let size = js::get(opts, "size");
        let mut info = Map::new();
        info.insert("size".into(), if js::truthy(size) { size.clone() } else { Value::Null });
        info.insert("type".into(), json!(js::str_of(js::get(opts, "mime"))));
        info.insert("resumable".into(), Value::Null);
        info.insert("fileName".into(), Value::Null);
        if kind == "http" && js::get(opts, "probe") != &Value::Bool(false) && !is_google_video(url) {
            let mut o = ReqOpts { timeout_sec: Some(15.0), ..Default::default() };
            if js::truthy(js::get(opts, "referer")) {
                o = o.header("Referer", js::s(js::get(opts, "referer")));
            }
            if js::truthy(js::get(opts, "cookies")) {
                o = o.header("Cookie", js::s(js::get(opts, "cookies")));
            }
            let auth = js::get(opts, "auth");
            if auth.is_object() {
                o.auth = serde_json::from_value::<Auth>(auth.clone()).ok();
            }
            match self.net.probe(url, &o).await {
                Ok(p) => {
                    info = Map::new();
                    info.insert("size".into(), json!(p.size));
                    info.insert("type".into(), json!(p.content_type));
                    info.insert("resumable".into(), json!(p.resumable));
                    info.insert("fileName".into(), json!(u::file_name_from_disposition(p.headers.get("content-disposition").map(|s| s.as_str()))));
                    info.insert("status".into(), json!(p.status));
                    info.insert("finalUrl".into(), json!(p.url));
                }
                Err(e) => {
                    info.insert("error".into(), json!(e.message));
                    info.insert("authRequired".into(), json!(e.code() == "EAUTH"));
                    info.insert("realm".into(), json!(e.realm));
                }
            }
        }
        let final_url = info.get("finalUrl").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(url).to_string();
        let given = js::str_of(js::get(opts, "fileName"));
        let given = if given.is_empty() { info.get("fileName").map(js::str_of).unwrap_or_default() } else { given };
        let file_name = self.guess_name(&final_url, Some(&given), info.get("type").and_then(|v| v.as_str()));
        let category = {
            let c = js::str_of(js::get(opts, "category"));
            if c.is_empty() { self.category_for_name(&file_name) } else { c }
        };
        let save_dir = {
            let s = js::str_of(js::get(opts, "saveDir"));
            if s.is_empty() { self.folder_for_category(&category) } else { s }
        };
        info.insert("kind".into(), json!(kind));
        info.insert("fileName".into(), json!(file_name));
        info.insert("category".into(), json!(category));
        info.insert("saveDir".into(), json!(save_dir));
        Value::Object(info)
    }

    pub fn kind_for(&self, url: &str, explicit: Option<&str>) -> String {
        kind_for(url, explicit)
    }

    pub fn find_duplicate(&self, url: &str) -> Option<ItemRef> {
        self.store.downloads.borrow().iter().find(|d| d.borrow().url == url).cloned()
    }

    /// Adds a download. opts: url, fileName, saveDir, category, description, referer, parentPage,
    /// cookies, userAgent, auth, start (bool), queueId, kind, mime, duplicateAction override.
    /// Returns { item, duplicate } — duplicate is set when the existing item was reused.
    pub fn add(&self, opts: &Value) -> Result<Value> {
        let url = js::str_of(js::get(opts, "url")).trim().to_string();
        match url::Url::parse(&url) {
            Ok(p) if ["http", "https", "ftp"].contains(&p.scheme()) => {}
            _ => return Err(Error::new(format!("Invalid address: {}", url))),
        }
        let dup = self.find_duplicate(&url);
        let action = {
            let a = js::str_of(js::get(opts, "duplicateAction"));
            if a.is_empty() { js::str_of(&self.setting(&["downloads", "duplicateAction"])) } else { a }
        };
        let start = js::truthy(js::get(opts, "start"));
        if let Some(d) = &dup {
            if action == "resume" {
                let (id, status) = {
                    let b = d.borrow();
                    (b.id.clone(), b.status.clone())
                };
                if start && status != "complete" {
                    self.start(&id);
                }
                return Ok(json!({ "item": self.public_item(d), "duplicate": true }));
            }
            if action == "overwrite" {
                let id = d.borrow().id.clone();
                let me = self.rc();
                tokio::task::spawn_local(async move { me.remove(&[id], false).await });
            }
        }
        let opt_kind = {
            let k = js::str_of(js::get(opts, "kind"));
            if k.is_empty() { None } else { Some(k) }
        };
        let parts: Option<Vec<ItemRef>> = js::get(opts, "parts").as_array().filter(|a| !a.is_empty()).map(|list| {
            list.iter()
                .map(|x| {
                    let ext = NON_ALNUM.replace_all(&js::str_of(js::get(x, "ext")), "").into_owned();
                    let ext = u::js_slice(&ext, 0, 5);
                    let size = js::num(js::get(x, "size"));
                    Rc::new(RefCell::new(Item {
                        role: Some(if js::s(js::get(x, "role")) == "audio" { "audio".into() } else { "video".into() }),
                        url: js::str_of(js::get(x, "url")),
                        size: if size > 0.0 { Some(size as u64) } else { None },
                        ext: Some(if ext.is_empty() { "bin".into() } else { ext }),
                        label: Some(if js::truthy(js::get(x, "label")) { u::js_slice(&js::str_of(js::get(x, "label")), 0, 80) } else { String::new() }),
                        content_type: Some(js::str_of(js::get(x, "mime"))),
                        ..Default::default()
                    }))
                })
                .collect()
        });
        let given = js::str_of(js::get(opts, "fileName"));
        let mime = js::str_of(js::get(opts, "mime"));
        let mut file_name = self.guess_name(&url, Some(&given), Some(&mime));
        let url_kind = self.kind_for(&url, opt_kind.as_deref());
        if parts.is_none() && url_kind == "ytdlp" && given.is_empty() {
            file_name = "video.mp4".into();
        }
        if let Some(p) = &parts {
            let pe: Vec<(String, String)> = p.iter().map(|x| {
                let x = x.borrow();
                (x.ext.clone().unwrap_or_default(), x.role.clone().unwrap_or_default())
            }).collect();
            file_name = u::sanitize_file_name(&(MEDIA_EXT.replace(&file_name, "").into_owned() + "." + &container_for(&pe)));
        }
        let category = {
            let c = js::str_of(js::get(opts, "category"));
            if c.is_empty() { self.category_for_name(&file_name) } else { c }
        };
        let save_dir = {
            let s = js::str_of(js::get(opts, "saveDir"));
            if s.is_empty() { self.folder_for_category(&category) } else { s }
        };
        let gv = parts.is_none() && is_google_video(&url);
        let opt_size = js::num(js::get(opts, "size"));
        let opt_size = if opt_size > 0.0 { Some(opt_size as u64) } else { None };
        let size = if let Some(p) = &parts {
            let sizes: Vec<Option<u64>> = p.iter().map(|x| x.borrow().size).collect();
            if sizes.iter().all(|s| s.is_some()) { Some(sizes.iter().map(|s| s.unwrap()).sum()) } else { None }
        } else if gv {
            let clen = url::Url::parse(&url).ok().and_then(|x| x.query_pairs().find(|(k, _)| k == "clen").map(|(_, v)| js::num(&Value::String(v.into_owned()))));
            match clen {
                Some(c) if c > 0.0 => Some(c as u64),
                _ => opt_size,
            }
        } else {
            opt_size
        };
        let ytdlp = if parts.is_none() && url_kind == "ytdlp" {
            let q = js::str_of(js::get(js::get(opts, "ytdlp"), "quality"));
            Some(json!({ "quality": if q.is_empty() { "best".to_string() } else { q } }))
        } else {
            None
        };
        let parent = {
            let p = js::str_of(js::get(opts, "parentPage"));
            if p.is_empty() { js::str_of(js::get(opts, "referer")) } else { p }
        };
        let hls = js::get(opts, "hls");
        let id = u::id();
        let temp_dir = js::str_of(&self.setting(&["saveTo", "tempDir"]));
        let item = Item {
            id: id.clone(),
            url: url.clone(),
            kind: Some(if parts.is_some() { "muxed".into() } else { url_kind.clone() }),
            parts,
            ytdlp,
            range_mode: if gv { Some("query".into()) } else { None },
            file_name: file_name.clone(),
            name_locked: !given.is_empty(),
            save_dir: save_dir.clone(),
            category: category.clone(),
            description: js::str_of(js::get(opts, "description")),
            referer: js::str_of(js::get(opts, "referer")),
            parent_page: parent,
            cookies: js::str_of(js::get(opts, "cookies")),
            user_agent: js::str_of(js::get(opts, "userAgent")),
            auth: Auth::from_value(js::get(opts, "auth")),
            status: "paused".into(),
            size,
            downloaded: 0,
            resumable: None,
            added: now_ms(),
            last_try: None,
            max_connections: 0.0,
            speed_limit_kb: 0.0,
            on_complete: json!({ "showDialog": null, "exitApp": false, "power": "none" }),
            hls: if js::truthy(hls) { Some(hls.clone()) } else { None },
            queues: Some(json!([])),
            overwrite: action == "overwrite",
            temp_path: join(&temp_dir, &format!("{}_{}", id, file_name)),
            ..Default::default()
        };
        if js::truthy(js::get(opts, "rememberPath")) && js::truthy(&self.setting(&["saveTo", "rememberLastPath"])) {
            {
                let mut s = self.store.settings.borrow_mut();
                *js::get_mut(js::get_mut(&mut s, "lastSaveDirs"), &category) = json!(save_dir);
            }
            self.store.save("settings");
        }
        let item = Rc::new(RefCell::new(item));
        self.store.downloads.borrow_mut().push(item.clone());
        let qid = js::str_of(js::get(opts, "queueId"));
        if !qid.is_empty() {
            self.emit(MgrEvent::Enqueue(id.clone(), qid));
        }
        self.touch(&item);
        if start {
            self.start(&id);
        }
        Ok(json!({ "item": self.public_item(&item), "duplicate": dup.is_some() }))
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    pub fn is_active(&self, id: &str) -> bool {
        self.has_engine(id) || self.waiting.borrow().iter().any(|x| x == id)
    }

    /// downloads.maxSimultaneous caps running downloads across the app; 0 means no limit.
    fn has_free_slot(&self) -> bool {
        let max = js::num(&self.setting(&["downloads", "maxSimultaneous"]));
        let max = if max.is_nan() { 0.0 } else { max };
        max <= 0.0 || (self.engines.borrow().len() as f64) < max
    }

    /// Starts waiting downloads while slots are free.
    fn admit(&self) {
        loop {
            if self.waiting.borrow().is_empty() || !self.has_free_slot() {
                return;
            }
            let id = self.waiting.borrow_mut().remove(0);
            self.start(&id);
        }
    }

    pub fn active_count(&self) -> usize {
        self.engines.borrow().len()
    }

    pub fn start(&self, id: &str) -> bool {
        let Some(item) = self.get(id) else { return false };
        if self.has_engine(id) || item.borrow().status == "complete" {
            return false;
        }
        self.quota_paused.borrow_mut().retain(|x| x != id);
        if !self.has_free_slot() {
            {
                let mut w = self.waiting.borrow_mut();
                if !w.iter().any(|x| x == id) {
                    w.push(id.to_string());
                }
            }
            {
                let mut it = item.borrow_mut();
                it.status = "waiting".into();
                it.status_text = Some("Waiting for a free slot".into());
                it.error = None;
            }
            self.touch(&item);
            return true;
        }
        self.waiting.borrow_mut().retain(|x| x != id);
        let me = self.rc();
        let w1 = Rc::downgrade(&me);
        let w2 = Rc::downgrade(&me);
        let w3 = Rc::downgrade(&me);
        let ctx = Ctx {
            net: self.net.clone(),
            store: self.store.clone(),
            limiters: Rc::new(move || w1.upgrade().map(|m| vec![m.global_limiter.clone()]).unwrap_or_default()),
            max_conn_for: Rc::new(move |url| w2.upgrade().map(|m| m.max_conn_for(url)).unwrap_or(8.0)),
            on_bytes: Some(Rc::new(move |n| {
                if let Some(m) = w3.upgrade() {
                    m.on_bytes(n)
                }
            })),
            bin_dir: self.store.dir.join("bin"),
        };
        let sink = self.sink_for(item.clone());
        let kind = item.borrow().kind.clone().unwrap_or_default();
        let eng: Rc<dyn Engine> = match kind.as_str() {
            "ftp" => FtpDownload::new(item.clone(), ctx, sink),
            "hls" => HlsDownload::new(item.clone(), ctx, sink),
            "muxed" => MuxedDownload::new(item.clone(), ctx, sink),
            "ytdlp" => YtDlpDownload::new(item.clone(), ctx, sink),
            _ => HttpDownload::new(item.clone(), ctx, sink),
        };
        self.engines.borrow_mut().push((id.to_string(), eng.clone()));
        {
            let mut it = item.borrow_mut();
            it.status = "downloading".into();
            it.status_text = Some("Connecting...".into());
            it.error = None;
            it.last_try = Some(now_ms());
            it.rate = Some(0.0);
        }
        self.touch(&item);
        self.emit(MgrEvent::Started(id.to_string()));
        eng.start();
        true
    }

    /// Engine events for one download (the `eng.on(...)` handlers).
    fn sink_for(&self, item: ItemRef) -> Sink {
        let me = self.me.borrow().clone();
        Rc::new(move |e| {
            let Some(m) = me.upgrade() else { return };
            let id = item.borrow().id.clone();
            match e {
                EngineEvent::Status(t) => {
                    item.borrow_mut().status_text = Some(t);
                    let p = m.public_item(&item);
                    m.emit(MgrEvent::Changed(p));
                }
                EngineEvent::Meta(meta) => {
                    let (url, name_locked, file_name) = {
                        let it = item.borrow();
                        (it.url.clone(), it.name_locked, it.file_name.clone())
                    };
                    if meta.file_name.as_ref().is_some_and(|f| !f.is_empty()) && !name_locked {
                        let n = m.guess_name(&url, meta.file_name.as_deref(), Some(&meta.content_type));
                        item.borrow_mut().file_name = n;
                    } else if u::ext_of(&file_name).is_empty() && !meta.content_type.is_empty() {
                        let n = m.guess_name(&url, Some(&file_name), Some(&meta.content_type));
                        item.borrow_mut().file_name = n;
                    }
                    let _ = (meta.size, meta.resumable);
                    m.touch(&item);
                }
                EngineEvent::Progress(st) => {
                    {
                        let mut it = item.borrow_mut();
                        let d = js::num(js::get(&st, "downloaded"));
                        it.downloaded = if d.is_finite() && d > 0.0 { d as u64 } else { 0 };
                        it.rate = st["rate"].as_f64();
                        it.eta = st["eta"].as_f64();
                        if let Some(s) = st["size"].as_f64() {
                            it.size = Some(s as u64);
                        }
                        if let Some(es) = st["estimatedSize"].as_f64().filter(|x| *x != 0.0) {
                            it.estimated_size = Some(es);
                        }
                    }
                    m.emit(MgrEvent::Progress(id, st));
                }
                EngineEvent::Persist => m.persist(),
                EngineEvent::Metrics(mv) => {
                    // Kept on the item (last run only) and written to the diagnostic log when enabled.
                    let (url, kind) = {
                        let mut it = item.borrow_mut();
                        it.last_run = Some(mv.clone());
                        (it.url.clone(), it.kind.clone())
                    };
                    let mut f = Map::new();
                    f.insert("id".into(), json!(id));
                    f.insert("url".into(), json!(redact_url(&url)));
                    f.insert("kind".into(), json!(kind));
                    if let Some(o) = mv.as_object() {
                        f.extend(o.clone());
                    }
                    diag("download", f);
                }
                EngineEvent::Complete => {
                    let m2 = m.clone();
                    let it2 = item.clone();
                    tokio::task::spawn_local(async move { m2.finalize(&it2).await });
                }
                EngineEvent::Stopped => {
                    m.remove_engine(&id);
                    {
                        let mut it = item.borrow_mut();
                        it.status = "paused".into();
                        it.rate = Some(0.0);
                        it.status_text = Some(it.pending_status.take().unwrap_or_default());
                    }
                    m.touch(&item);
                    m.emit(MgrEvent::Stopped(id));
                    m.admit();
                }
                EngineEvent::Failed(err) => {
                    m.remove_engine(&id);
                    {
                        let mut it = item.borrow_mut();
                        it.status = "error".into();
                        it.rate = Some(0.0);
                        it.error = Some(err.message.clone());
                        it.status_text = Some(err.message.clone());
                    }
                    m.touch(&item);
                    let p = m.public_item(&item);
                    m.emit(MgrEvent::Failed(p, err.message));
                    m.admit();
                }
            }
        })
    }

    async fn finalize(&self, item: &ItemRef) {
        item.borrow_mut().status_text = Some("Moving file...".into());
        let p = self.public_item(item);
        self.emit(MgrEvent::Changed(p));
        let existing = js::str_of(&self.setting(&["downloads", "existingFileAction"]));
        let r: Result<()> = async {
            let (save_dir, file_name, overwrite, temp) = {
                let it = item.borrow();
                (it.save_dir.clone(), it.file_name.clone(), it.overwrite, it.temp_path.clone())
            };
            let mut dest = join(&save_dir, &file_name);
            let exists = tokio::fs::metadata(&dest).await.is_ok();
            if exists && !overwrite && existing != "overwrite" {
                dest = u::unique_path(&dest, &HashSet::new()).await;
            }
            if exists && (overwrite || existing == "overwrite") {
                u::rm_force(&dest, false).await;
            }
            u::move_file(&temp, &dest).await?;
            let extra = item.borrow().extra_files.clone().unwrap_or_default();
            for x in extra {
                let target = u::unique_path(&join(&save_dir, &u::sanitize_file_name(&x.name)), &HashSet::new()).await;
                u::move_file(&x.temp, &target).await?;
            }
            let mut it = item.borrow_mut();
            it.extra_files = None;
            it.file_name = u::basename(&dest);
            it.saved_path = Some(dest);
            it.status = "complete".into();
            it.completed_at = Some(now_ms());
            it.status_text = Some("Complete".into());
            it.segments = it.size.filter(|s| *s > 0).map(|s| vec![seg(0, s, s)]);
            it.downloaded = it.size.filter(|s| *s > 0).unwrap_or(it.downloaded);
            it.rate = Some(0.0);
            it.overwrite = false;
            Ok(())
        }
        .await;
        let id = item.borrow().id.clone();
        self.remove_engine(&id);
        match r {
            Ok(()) => {
                self.touch(item);
                let p = self.public_item(item);
                self.emit(MgrEvent::Complete(p));
            }
            Err(e) => {
                {
                    let mut it = item.borrow_mut();
                    it.status = "error".into();
                    it.error = Some(format!("Could not save file: {}", e.message));
                    it.status_text = it.error.clone();
                }
                self.touch(item);
                let p = self.public_item(item);
                self.emit(MgrEvent::Failed(p, e.message));
            }
        }
        self.admit();
    }

    pub fn stop(&self, id: &str, status_text: Option<&str>) -> bool {
        let eng = self.engine(id);
        let item = self.get(id);
        if eng.is_none() && self.waiting.borrow().iter().any(|x| x == id) {
            self.waiting.borrow_mut().retain(|x| x != id);
            if let Some(item) = item {
                {
                    let mut it = item.borrow_mut();
                    it.status = "paused".into();
                    it.status_text = Some(status_text.unwrap_or("").to_string());
                }
                self.touch(&item);
            }
            self.emit(MgrEvent::Stopped(id.to_string()));
            return true;
        }
        if let Some(e) = &eng {
            if let (Some(t), Some(item)) = (status_text, &item) {
                item.borrow_mut().pending_status = Some(t.to_string());
            }
            e.stop();
        }
        eng.is_some()
    }

    pub fn stop_all(&self) {
        let waiting = self.waiting.borrow().clone();
        for id in waiting {
            self.stop(&id, None);
        }
        let ids: Vec<String> = self.engines.borrow().iter().map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.stop(&id, None);
        }
    }

    pub async fn wait_stopped(&self, id: &str) {
        if !self.has_engine(id) {
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = RefCell::new(Some(tx));
        let want = id.to_string();
        let h = self.events.on(move |e| {
            let hit = match e {
                MgrEvent::Stopped(x) => *x == want,
                MgrEvent::Failed(it, _) | MgrEvent::Complete(it) => js::s(js::get(it, "id")) == want,
                _ => false,
            };
            if hit {
                if let Some(t) = tx.borrow_mut().take() {
                    let _ = t.send(());
                }
            }
        });
        let _ = rx.await;
        self.events.off(h);
    }

    pub async fn remove(&self, ids: &[String], delete_files: bool) {
        for id in ids {
            let Some(item) = self.get(id) else { continue };
            if self.is_active(id) {
                self.stop(id, None);
                self.wait_stopped(id).await;
            }
            let (temp, parts, saved) = {
                let it = item.borrow();
                (it.temp_path.clone(), it.parts.clone().unwrap_or_default(), it.saved_path.clone())
            };
            u::rm_force(&temp, false).await;
            u::rm_force(&format!("{}.segs", temp), true).await;
            for x in &parts {
                let t = x.borrow().temp_path.clone();
                if !t.is_empty() {
                    u::rm_force(&t, false).await;
                }
            }
            u::rm_force(&format!("{}.ytdlp", temp), true).await;
            if delete_files {
                if let Some(s) = saved {
                    u::rm_force(&s, false).await;
                }
            }
            self.store.downloads.borrow_mut().retain(|d| d.borrow().id != *id);
        }
        self.persist();
        self.emit(MgrEvent::Removed(ids.to_vec()));
    }

    pub async fn remove_completed(&self) -> Vec<String> {
        let ids: Vec<String> = self.items().iter().filter(|d| d.borrow().status == "complete").map(|d| d.borrow().id.clone()).collect();
        self.remove(&ids, false).await;
        ids
    }

    pub async fn redownload(&self, id: &str, start_now: bool) {
        let Some(item) = self.get(id) else { return };
        if self.has_engine(id) {
            self.stop(id, None);
            self.wait_stopped(id).await;
        }
        let temp = item.borrow().temp_path.clone();
        u::rm_force(&temp, false).await;
        u::rm_force(&format!("{}.segs", temp), true).await;
        {
            let mut it = item.borrow_mut();
            it.status = "paused".into();
            it.segments = None;
            it.downloaded = 0;
            it.size = None;
            it.resumable = None;
            it.error = None;
            it.status_text = Some(String::new());
            it.saved_path = None;
            it.completed_at = None;
            if let Some(h) = &it.hls {
                it.hls = Some(json!({ "variant": js::get(h, "variant") }));
            }
        }
        u::rm_force(&format!("{}.ytdlp", temp), true).await;
        let parts = item.borrow().parts.clone().unwrap_or_default();
        for x in &parts {
            let t = x.borrow().temp_path.clone();
            if !t.is_empty() {
                u::rm_force(&t, false).await;
            }
            let mut x = x.borrow_mut();
            x.segments = None;
            x.done = false;
            x.downloaded = 0;
            x.resumable = None;
        }
        {
            let mut it = item.borrow_mut();
            if let Some(p) = &it.parts {
                let sizes: Vec<Option<u64>> = p.iter().map(|x| x.borrow().size.filter(|s| *s > 0)).collect();
                it.size = if sizes.iter().all(|s| s.is_some()) { Some(sizes.iter().map(|s| s.unwrap()).sum()) } else { None };
            }
            it.overwrite = true;
        }
        self.touch(&item);
        if start_now {
            self.start(id);
        }
    }

    /// Properties dialog edits, including "refresh download address" (new URL keeps progress).
    pub async fn update(&self, id: &str, patch: &Value) -> Result<Value> {
        let Some(item) = self.get(id) else { return Ok(Value::Null) };
        let has = |k: &str| patch.get(k).is_some();
        let was_active = self.has_engine(id);
        let url_changed = has("url") && js::str_of(&patch["url"]) != item.borrow().url;
        if was_active && (url_changed || has("auth")) {
            self.stop(id, None);
            self.wait_stopped(id).await;
        }
        {
            let mut it = item.borrow_mut();
            for k in ["url", "fileName", "saveDir", "description", "category", "referer", "cookies", "userAgent", "maxConnections", "speedLimitKB", "onComplete", "auth"] {
                let Some(v) = patch.get(k) else { continue };
                match k {
                    "url" => it.url = js::str_of(v),
                    "fileName" => it.file_name = js::str_of(v),
                    "saveDir" => it.save_dir = js::str_of(v),
                    "description" => it.description = js::str_of(v),
                    "category" => it.category = js::str_of(v),
                    "referer" => it.referer = js::str_of(v),
                    "cookies" => it.cookies = js::str_of(v),
                    "userAgent" => it.user_agent = js::str_of(v),
                    "maxConnections" => it.max_connections = js::num(v),
                    "speedLimitKB" => it.speed_limit_kb = js::num(v),
                    "onComplete" => it.on_complete = v.clone(),
                    "auth" => it.auth = if v.is_object() { serde_json::from_value(v.clone()).ok() } else { None },
                    _ => {}
                }
            }
        }
        if has("fileName") {
            let (dest, saved) = {
                let mut it = item.borrow_mut();
                it.file_name = u::sanitize_file_name(&js::str_of(&patch["fileName"]));
                it.name_locked = true;
                let saved = if it.status == "complete" { it.saved_path.clone() } else { None };
                (join(&it.save_dir, &it.file_name), saved)
            };
            if let Some(saved) = saved {
                if dest != saved {
                    u::move_file(&saved, &dest).await?;
                    item.borrow_mut().saved_path = Some(dest);
                }
            }
        }
        if has("saveDir") {
            let (dest, saved) = {
                let it = item.borrow();
                let saved = if it.status == "complete" { it.saved_path.clone() } else { None };
                (join(&js::str_of(&patch["saveDir"]), &it.file_name), saved)
            };
            if let Some(saved) = saved {
                if dest != saved {
                    u::move_file(&saved, &dest).await?;
                    item.borrow_mut().saved_path = Some(dest);
                }
            }
        }
        if let Some(eng) = self.engine(id) {
            if has("speedLimitKB") {
                eng.set_speed_limit(js::num(&patch["speedLimitKB"]));
            }
            if has("maxConnections") {
                eng.set_max_connections(js::num(&patch["maxConnections"]));
            }
        }
        if has("url") {
            let mut it = item.borrow_mut();
            let keep_hls = it.kind.as_deref() == Some("hls");
            it.kind = Some(kind_for(&it.url, if keep_hls { Some("hls") } else { None }));
        }
        self.touch(&item);
        if was_active && !self.has_engine(id) {
            self.start(id);
        }
        Ok(self.public_item(&item))
    }

    pub fn stats(&self, id: &str) -> Value {
        if let Some(e) = self.engine(id) {
            return e.stats();
        }
        let Some(item) = self.get(id) else { return Value::Null };
        if item.borrow().parts.is_some() {
            return muxed_stats(&item, &[]);
        }
        let it = item.borrow();
        let mut v = json!({
            "downloaded": it.downloaded, "size": it.size, "rate": 0, "eta": null, "resumable": it.resumable,
            "connections": [], "segments": it.segment_triples(),
        });
        if let Some(h) = &it.hls {
            let total = js::num(js::get(h, "total"));
            let done = js::get(h, "done");
            v["hlsSegments"] = json!({
                "total": if total.is_nan() { 0.0 } else { total },
                "done": if done.is_array() { done.clone() } else { json!([]) },
            });
        }
        v
    }

    /// Checks whether a completed file changed on the server (synchronization queues).
    pub async fn remote_changed(&self, id: &str) -> Result<bool> {
        let Some(item) = self.get(id) else { return Ok(false) };
        let (kind, url, referer, size, etag, lm) = {
            let it = item.borrow();
            (it.kind.clone(), it.url.clone(), it.referer.clone(), it.size, it.etag.clone(), it.last_modified.clone())
        };
        if kind.as_deref() != Some("http") {
            return Ok(true);
        }
        let mut o = ReqOpts::default();
        if !referer.is_empty() {
            o = o.header("Referer", &referer);
        }
        let p = self.net.probe(&url, &o).await?;
        let plm = p.headers.get("last-modified").filter(|x| !x.is_empty()).cloned();
        let pet = p.headers.get("etag").filter(|x| !x.is_empty()).cloned();
        let size_diff = matches!((p.size, size), (Some(a), Some(b)) if a != b as f64);
        let etag_diff = matches!((&pet, &etag), (Some(a), Some(b)) if a != b);
        let lm_diff = matches!((&plm, &lm), (Some(a), Some(b)) if a != b);
        Ok(size_diff || etag_diff || lm_diff || (pet.is_none() && plm.is_none() && p.size.is_none()))
    }

    /// Export of the download list.
    pub fn export_list(&self) -> Vec<Value> {
        self.items()
            .iter()
            .map(|d| {
                let d = d.borrow();
                json!({ "url": d.url, "fileName": d.file_name, "saveDir": d.save_dir, "category": d.category, "description": d.description, "referer": d.referer, "status": d.status, "size": d.size })
            })
            .collect()
    }

    pub fn dispose(&self) {
        if let Some(t) = self.quota_timer.borrow_mut().take() {
            t.abort();
        }
        self.stop_all();
    }
}

pub fn kind_for(url: &str, explicit: Option<&str>) -> String {
    if let Some(e) = explicit.filter(|e| !e.is_empty()) {
        return e.to_string();
    }
    if is_google_video(url) {
        return "http".into();
    }
    if is_video_page(url) {
        return "ytdlp".into();
    }
    if FTP_URL.is_match(url) {
        return "ftp".into();
    }
    if M3U8_URL.is_match(url) {
        return "hls".into();
    }
    "http".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert!(is_google_video("https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&clen=100"));
        assert!(!is_google_video("https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137"));
        assert!(!is_google_video("https://evilgooglevideo.com/videoplayback?clen=5"));
        let p = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(container_for(&p(&[("mp4", "video"), ("m4a", "audio")])), "mp4");
        assert_eq!(container_for(&p(&[("webm", "video"), ("webm", "audio")])), "webm");
        assert_eq!(container_for(&p(&[("webm", "video"), ("m4a", "audio")])), "mkv");
        assert_eq!(container_for(&p(&[("m4a", "audio")])), "m4a");
    }
}

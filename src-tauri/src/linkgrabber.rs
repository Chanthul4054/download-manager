//! Collects links before they become downloads, like JDownloader's LinkGrabber (port of
//! src/main/linkgrabber.js): links are checked online in the background, grouped into packages
//! (split archives together, single files under "Various files", dead links under "Offline"), and
//! only become downloads once confirmed. Emits changed whenever the list changes and
//! confirmed(ids) after links are moved to the list.

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::rc::{Rc, Weak};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use tokio::task::JoinHandle;

use crate::captcha;
use crate::emitter::Emitter;
use crate::engine::net::{NetContext, ReqOpts};
use crate::error::{Error, Result};
use crate::grabber::extract_links;
use crate::hosters;
use crate::item::Auth;
use crate::js::{self, de_bool, de_f64, de_opt_bool, de_opt_f64, de_opt_string, de_string, now_ms};
use crate::manager::DownloadManager;
use crate::store::Store;
use crate::util::{self as u, join};

/// Patterns that reduce every part of a split archive or recovery set to one base name, so the
/// parts land in the same package. Order matters: the first match wins.
static ARCHIVE_PARTS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)^(.*)[._-]part\.?0*\d+\.(?:rar|rev|exe)$", // name.part01.rar, name.part2.exe (SFX)
        r"(?i)^(.*)\.(?:rar|rev)$",                      // name.rar
        r"(?i)^(.*)\.r\d{2,3}$",                         // name.r00 (old-style volumes)
        r"(?i)^(.*)\.(?:zip|z\d{2})$",                   // name.zip + name.z01
        r"(?i)^(.*)\.(?:7z|zip|rar|tar|iso)\.\d{2,3}$",  // name.7z.001
        r"(?i)^(.*?)(?:\.vol\d+(?:[+-]\d+)?)?\.par2$",   // name.par2, name.vol00+01.par2
        r"(?i)^(.*)\.(?:par|p\d{2})$",                   // name.par, name.p01
        r"(?i)^(.*)\.(?:isz|i\d{2})$",                   // name.isz + name.i01
        r"(?i)^(.*)\.\d+\.xtm$",                         // name.001.xtm
        r"(?i)^(.*)\.(?:_[a-z]|[a-z]{2})_$",             // hjsplit-style name.aa_
        r"^(.*)\.\d{3}$",                                // name.001
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

const PAGE_EXT: &[&str] = &["", "html", "htm", "shtml", "xhtml", "php", "asp", "aspx", "jsp", "cfm", "cgi", "pl"];

static EXT_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(\.tar)?\.[a-z0-9]{1,5}$").unwrap());
static SEP_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s._-]+$").unwrap());
static SEP_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s._-]+").unwrap());
static TRANSIENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)time|abort|reset|ETIMEDOUT|ECONNRESET").unwrap());
static HTML_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)text/html|xhtml").unwrap());
static LINK_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(https?|ftp)://").unwrap());

/// Derives a package name from a file name: archive part numbers and the extension are removed.
pub fn package_name_for(file_name: &str) -> String {
    let mut name = file_name.trim().to_string();
    if let Some(re) = ARCHIVE_PARTS.iter().find(|re| re.is_match(&name)) {
        name = re.captures(&name).unwrap()[1].to_string();
    } else {
        name = EXT_TAIL.replace(&name, "").into_owned();
    }
    name = SEP_TAIL.replace(&name, "").trim().to_string();
    if name.is_empty() {
        if file_name.is_empty() { "Download".into() } else { file_name.to_string() }
    } else {
        name
    }
}

pub fn package_key(file_name: &str) -> String {
    SEP_RUN.replace_all(&package_name_for(file_name).to_lowercase(), " ").into_owned()
}

fn host_of(url: &str) -> String {
    let h = u::hostname(url);
    h.strip_prefix("www.").unwrap_or(&h).to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    #[serde(default, deserialize_with = "de_string")]
    pub id: String,
    #[serde(default, deserialize_with = "de_string")]
    pub url: String,
    #[serde(default, deserialize_with = "de_string")]
    pub name: String,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub size: Option<f64>,
    #[serde(default, deserialize_with = "de_string", rename = "type")]
    pub kind: String,
    #[serde(default, deserialize_with = "de_string")]
    pub host: String,
    #[serde(default, deserialize_with = "de_string")]
    pub status: String,
    #[serde(default, deserialize_with = "de_string")]
    pub error: String,
    #[serde(default, deserialize_with = "de_bool")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "de_bool")]
    pub in_list: bool,
    #[serde(default, deserialize_with = "de_string")]
    pub description: String,
    #[serde(default, deserialize_with = "de_string")]
    pub referer: String,
    #[serde(default, deserialize_with = "de_string")]
    pub cookies: String,
    #[serde(default, deserialize_with = "de_string")]
    pub user_agent: String,
    #[serde(default)]
    pub auth: Option<Auth>,
    #[serde(default, deserialize_with = "de_bool")]
    pub deep: bool,
    #[serde(default, deserialize_with = "de_f64")]
    pub depth: f64,
    #[serde(default, deserialize_with = "de_string")]
    pub source: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub added: f64,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub forced_package: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub forced_save_dir: Option<String>,
    #[serde(default, deserialize_with = "de_bool", skip_serializing_if = "std::ops::Not::not")]
    pub name_locked: bool,
    #[serde(default, deserialize_with = "de_bool", skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    #[serde(default, deserialize_with = "de_opt_bool", skip_serializing_if = "Option::is_none")]
    pub resumable: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    #[serde(default, deserialize_with = "de_string")]
    pub id: String,
    #[serde(default, deserialize_with = "de_string")]
    pub name: String,
    #[serde(default, deserialize_with = "de_string")]
    pub kind: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub key: Option<String>,
    #[serde(default, deserialize_with = "de_string")]
    pub save_dir: String,
    #[serde(default, deserialize_with = "de_bool")]
    pub expanded: bool,
    #[serde(default, deserialize_with = "de_f64")]
    pub added: f64,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LgState {
    #[serde(default)]
    pub packages: Vec<Package>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone)]
pub enum LgEvent {
    Changed,
    Confirmed(Vec<String>),
}

pub struct LinkGrabber {
    me: RefCell<Weak<LinkGrabber>>,
    store: Rc<Store>,
    net: Rc<NetContext>,
    manager: Rc<DownloadManager>,
    todo: RefCell<VecDeque<String>>,
    checking: Cell<usize>,
    auto_timer: RefCell<Option<JoinHandle<()>>>,
    pub events: Emitter<LgEvent>,
}

// ---- package placement on the raw list (the JS methods that took package/link objects) ---------

fn new_package(pkgs: &mut Vec<Package>, settings: &Value, name: &str, kind: &str, key: Option<String>) -> String {
    let pkg = Package {
        id: u::id(),
        name: name.to_string(),
        kind: kind.to_string(),
        key,
        save_dir: String::new(),
        expanded: kind != "normal" || js::truthy(js::get(settings, "expandPackages")),
        added: now_ms(),
        links: Vec::new(),
        extra: Map::new(),
    };
    let id = pkg.id.clone();
    let various = pkgs.iter().position(|p| p.kind != "normal" && p.kind != "custom");
    // Special packages stay at the bottom, new ones at the end of the regular list.
    if kind == "normal" || kind == "custom" {
        pkgs.insert(various.unwrap_or(pkgs.len()), pkg);
    } else {
        pkgs.push(pkg);
    }
    id
}

fn special(pkgs: &mut Vec<Package>, settings: &Value, kind: &str) -> String {
    match pkgs.iter().find(|p| p.kind == kind) {
        Some(p) => p.id.clone(),
        None => new_package(pkgs, settings, if kind == "offline" { "Offline" } else { "Various files" }, kind, None),
    }
}

/// Removes a link from a package (and the package once it is empty). Returns the link.
fn detach(pkgs: &mut Vec<Package>, pkg_id: &str, link_id: &str) -> Option<Link> {
    let pi = pkgs.iter().position(|p| p.id == pkg_id)?;
    let li = pkgs[pi].links.iter().position(|l| l.id == link_id);
    let link = li.map(|i| pkgs[pi].links.remove(i));
    if pkgs[pi].links.is_empty() {
        pkgs.remove(pi);
    }
    link
}

fn pkg_mut<'a>(pkgs: &'a mut [Package], id: &str) -> Option<&'a mut Package> {
    pkgs.iter_mut().find(|p| p.id == id)
}

fn target_for(pkgs: &mut Vec<Package>, settings: &Value, link: &Link) -> String {
    if let Some(forced) = &link.forced_package {
        if let Some(p) = pkgs.iter().find(|p| p.kind == "custom" && p.name == *forced) {
            return p.id.clone();
        }
        let id = new_package(pkgs, settings, forced, "custom", None);
        pkg_mut(pkgs, &id).unwrap().save_dir = link.forced_save_dir.clone().unwrap_or_default();
        return id;
    }
    if link.status == "offline" {
        return special(pkgs, settings, "offline");
    }
    let key = package_key(&link.name);
    if let Some(p) = pkgs.iter().find(|p| p.kind == "normal" && p.key.as_deref() == Some(key.as_str())) {
        return p.id.clone();
    }
    if !js::truthy(js::get(settings, "variousPackage")) {
        return new_package(pkgs, settings, &package_name_for(&link.name), "normal", Some(key));
    }
    // A second file with the same base name (another archive part, say) forms its own package.
    let various = pkgs.iter().find(|p| p.kind == "various").map(|p| p.id.clone());
    let siblings: Vec<String> = various
        .as_ref()
        .and_then(|vid| pkgs.iter().find(|p| &p.id == vid))
        .map(|v| v.links.iter().filter(|l| l.id != link.id && !l.pinned && package_key(&l.name) == key).map(|l| l.id.clone()).collect())
        .unwrap_or_default();
    if siblings.is_empty() {
        return special(pkgs, settings, "various");
    }
    let fresh = new_package(pkgs, settings, &package_name_for(&link.name), "normal", Some(key));
    let vid = various.unwrap();
    for s in siblings {
        if let Some(l) = detach(pkgs, &vid, &s) {
            pkg_mut(pkgs, &fresh).unwrap().links.push(l);
        }
    }
    fresh
}

/// Puts a link into the package it belongs to, moving it out of its current one if needed.
/// `new_link` is a link not yet in any package; otherwise the link is found by id.
fn place(pkgs: &mut Vec<Package>, settings: &Value, link_id: &str, new_link: Option<Link>) {
    let cur = pkgs.iter().find(|p| p.links.iter().any(|l| l.id == link_id)).map(|p| (p.id.clone(), p.kind.clone()));
    let link = match (&new_link, &cur) {
        (Some(l), _) => l.clone(),
        (None, Some((pid, _))) => pkgs.iter().find(|p| &p.id == pid).unwrap().links.iter().find(|l| l.id == link_id).unwrap().clone(),
        (None, None) => return,
    };
    // Links the user moved by hand stay where they are.
    if let Some((_, kind)) = &cur {
        if link.pinned || kind == "custom" {
            return;
        }
    }
    let target = target_for(pkgs, settings, &link);
    if cur.as_ref().is_some_and(|(pid, _)| *pid == target) {
        return;
    }
    let moving = match &cur {
        Some((pid, _)) => detach(pkgs, pid, link_id).unwrap_or(link),
        None => new_link.unwrap_or(link),
    };
    if let Some(t) = pkg_mut(pkgs, &target) {
        t.links.push(moving);
    }
}

/// Resolves a mixed list of package and link ids to link ids.
fn select(pkgs: &[Package], ids: &[String]) -> Vec<String> {
    let set: HashSet<&String> = ids.iter().collect();
    let mut out = Vec::new();
    for p in pkgs {
        let whole = set.contains(&p.id);
        out.extend(p.links.iter().filter(|l| whole || set.contains(&l.id)).map(|l| l.id.clone()));
    }
    out
}

impl LinkGrabber {
    pub fn new(store: Rc<Store>, net: Rc<NetContext>, manager: Rc<DownloadManager>) -> Rc<LinkGrabber> {
        let lg = Rc::new(LinkGrabber {
            me: RefCell::new(Weak::new()),
            store,
            net,
            manager,
            todo: RefCell::new(VecDeque::new()),
            checking: Cell::new(0),
            auto_timer: RefCell::new(None),
            events: Emitter::default(),
        });
        *lg.me.borrow_mut() = Rc::downgrade(&lg);
        // Links that were mid-check when the app closed are checked again.
        let pending: Vec<String> = lg.links().into_iter().filter(|l| l.status == "checking").map(|l| l.id).collect();
        lg.todo.borrow_mut().extend(pending);
        lg.pump();
        lg
    }

    fn settings(&self) -> Value {
        self.store.s(&["linkGrabber"])
    }

    pub fn links(&self) -> Vec<Link> {
        self.store.linkgrabber.borrow().packages.iter().flat_map(|p| p.links.clone()).collect()
    }

    fn has_link(&self, id: &str) -> bool {
        self.store.linkgrabber.borrow().packages.iter().any(|p| p.links.iter().any(|l| l.id == id))
    }

    fn with_link<R>(&self, id: &str, f: impl FnOnce(&mut Link) -> R) -> Option<R> {
        let mut st = self.store.linkgrabber.borrow_mut();
        let l = st.packages.iter_mut().flat_map(|p| p.links.iter_mut()).find(|l| l.id == id)?;
        Some(f(l))
    }

    pub fn snapshot(&self) -> Value {
        let pending = self.checking.get() + self.todo.borrow().len();
        json!({
            "packages": serde_json::to_value(&self.store.linkgrabber.borrow().packages).unwrap_or(json!([])),
            "busy": pending > 0,
            "pending": pending,
        })
    }

    fn touch(&self) {
        self.store.save("linkgrabber");
        self.events.emit(LgEvent::Changed);
    }

    // ---- adding ----------------------------------------------------------------------------------

    /// Adds links from text or a list. opts: text, links [{url, text}], referer, cookies, userAgent,
    /// auth, packageName, saveDir, deep (look inside web pages), source.
    /// Returns the number of new links; addresses already in the LinkGrabber are skipped.
    pub fn add(&self, opts: &Value) -> usize {
        let mut raw: Vec<Value> = js::get(opts, "links").as_array().cloned().unwrap_or_default();
        raw.extend(u::extract_urls(&js::str_of(js::get(opts, "text"))).into_iter().map(|url| json!({ "url": url })));
        let mut known: HashSet<String> = self.links().into_iter().map(|l| l.url).collect();
        let settings = self.settings();
        let deep = match js::get(opts, "deep") {
            Value::Null => js::truthy(js::get(&settings, "deepAnalyse")),
            v => js::truthy(v),
        };
        let mut n = 0;
        for r in raw {
            let url = js::str_of(js::get(&r, "url")).trim().to_string();
            if !LINK_URL.is_match(&url) || known.contains(&url) {
                continue;
            }
            known.insert(url.clone());
            let text = js::str_of(js::get(&r, "text"));
            let mut link = Link {
                id: u::id(),
                url: url.clone(),
                name: hosters::file_name(&url).unwrap_or_else(|| self.manager.guess_name(&url, None, None)),
                size: None,
                kind: String::new(),
                host: host_of(&url),
                status: "checking".into(),
                error: String::new(),
                enabled: true,
                in_list: self.manager.find_duplicate(&url).is_some(),
                description: if text.is_empty() { js::str_of(js::get(opts, "description")) } else { text },
                referer: js::str_of(js::get(opts, "referer")),
                cookies: js::str_of(js::get(opts, "cookies")),
                user_agent: js::str_of(js::get(opts, "userAgent")),
                auth: Auth::from_value(js::get(opts, "auth")),
                deep,
                depth: js::num_or(js::get(&r, "depth"), 0.0),
                source: js::str_of(js::get(opts, "source")),
                added: now_ms(),
                ..Default::default()
            };
            if js::truthy(js::get(opts, "packageName")) {
                link.forced_package = Some(js::str_of(js::get(opts, "packageName")).trim().to_string());
            }
            if js::truthy(js::get(opts, "saveDir")) {
                link.forced_save_dir = Some(js::str_of(js::get(opts, "saveDir")));
            }
            let id = link.id.clone();
            {
                let mut st = self.store.linkgrabber.borrow_mut();
                place(&mut st.packages, &settings, &id, Some(link));
            }
            self.todo.borrow_mut().push_back(id);
            n += 1;
        }
        if n > 0 {
            self.cancel_auto_confirm();
            self.touch();
            self.pump();
        }
        n
    }

    // ---- online check ----------------------------------------------------------------------------

    pub fn recheck(&self, ids: &[String]) {
        let chosen = select(&self.store.linkgrabber.borrow().packages, ids);
        for id in chosen {
            let queued = self.with_link(&id, |l| {
                if l.status == "checking" {
                    return false;
                }
                l.status = "checking".into();
                l.error = String::new();
                true
            });
            if queued == Some(true) {
                self.todo.borrow_mut().push_back(id);
            }
        }
        self.touch();
        self.pump();
    }

    fn pump(&self) {
        let max = js::num_or(js::get(&self.settings(), "checkThreads"), 4.0).max(1.0) as usize;
        while self.checking.get() < max {
            let Some(id) = self.todo.borrow_mut().pop_front() else { break };
            let is_checking = self.with_link(&id, |l| l.status == "checking").unwrap_or(false);
            if !is_checking {
                continue;
            }
            self.checking.set(self.checking.get() + 1);
            let me = self.me.borrow().upgrade().unwrap();
            tokio::task::spawn_local(async move {
                if let Err(e) = me.check(&id).await {
                    me.with_link(&id, |l| {
                        l.status = "unknown".into();
                        l.error = e.message.clone();
                    });
                }
                me.checking.set(me.checking.get() - 1);
                if me.has_link(&id) {
                    let settings = me.settings();
                    let mut st = me.store.linkgrabber.borrow_mut();
                    place(&mut st.packages, &settings, &id, None);
                }
                me.touch();
                me.pump();
                if me.checking.get() == 0 && me.todo.borrow().is_empty() {
                    me.schedule_auto_confirm();
                }
            });
        }
    }

    async fn check(&self, id: &str) -> Result<()> {
        let Some(link) = self.with_link(id, |l| l.clone()) else { return Ok(()) };
        if hosters::is_paste(&link.url) {
            return self.open_paste(id, &link).await;
        }
        // A hoster page names its file in the fragment; its own size and type are the HTML's.
        let hosted = hosters::file_name(&link.url);
        let kind = self.manager.kind_for(&link.url, None);
        if kind != "http" {
            // FTP, streams and video pages are resolved when the download starts.
            self.with_link(id, |l| {
                l.status = "unknown".into();
                l.error = if kind == "ytdlp" { "Video page".into() } else { String::new() };
            });
            return Ok(());
        }
        let mut o = ReqOpts { auth: link.auth.clone(), timeout_sec: Some(20.0), ..Default::default() };
        if !link.referer.is_empty() {
            o = o.header("Referer", &link.referer);
        }
        if !link.cookies.is_empty() {
            o = o.header("Cookie", &link.cookies);
        }
        let p = match self.net.probe(&link.url, &o).await {
            Ok(p) => p,
            Err(e) => {
                let probe = if e.code().is_empty() { e.message.as_str() } else { e.code() };
                let transient = TRANSIENT.is_match(probe);
                self.with_link(id, |l| {
                    l.status = if transient { "unknown".into() } else { "offline".into() };
                    l.error = e.message.clone();
                });
                return Ok(());
            }
        };
        if p.status >= 400 {
            let gone = [404, 410, 451].contains(&p.status);
            self.with_link(id, |l| {
                l.status = if gone { "offline".into() } else { "unknown".into() };
                l.error = format!("HTTP {}", p.status);
            });
            return Ok(());
        }
        let from_header = u::file_name_from_disposition(p.headers.get("content-disposition").map(|s| s.as_str()));
        let final_url = if p.url.is_empty() { link.url.clone() } else { p.url.clone() };
        let name = hosted.clone().unwrap_or_else(|| self.manager.guess_name(&final_url, from_header.as_deref(), Some(&p.content_type)));
        let (deep, depth) = self
            .with_link(id, |l| {
                l.status = "online".into();
                l.error = String::new();
                if hosted.is_none() {
                    l.size = p.size;
                    l.kind = p.content_type.split(';').next().unwrap_or("").to_string();
                }
                l.resumable = Some(p.resumable);
                if !l.name_locked {
                    l.name = name.clone();
                }
                (l.deep, l.depth)
            })
            .unwrap_or((false, 1.0));
        if HTML_TYPE.is_match(&p.content_type) && from_header.is_none() && hosted.is_none() {
            if deep && depth == 0.0 && self.crawl(id, &final_url).await? {
                return Ok(());
            }
            // A web page is rarely what the user wants to download.
            self.with_link(id, |l| {
                l.enabled = false;
                l.error = "Web page".into();
            });
        }
        Ok(())
    }

    /// Replaces a web page with the files it links to. Returns true if any were found.
    async fn crawl(&self, id: &str, page_url: &str) -> Result<bool> {
        let Some(link) = self.with_link(id, |l| l.clone()) else { return Ok(false) };
        let mut o = ReqOpts { auth: link.auth.clone(), max_bytes: Some(4 * 1024 * 1024), timeout_sec: Some(20.0), ..Default::default() };
        if !link.referer.is_empty() {
            o = o.header("Referer", &link.referer);
        }
        if !link.cookies.is_empty() {
            o = o.header("Cookie", &link.cookies);
        }
        let mut f = self.net.fetch_buffer(page_url, &o).await?;
        let mut html = String::from_utf8_lossy(&f.body).into_owned();
        let mut cookies = link.cookies.clone();
        // A captcha guards the real page: solve it and look inside the page it leads to.
        if let Some(c) = captcha::detect(&html) {
            let key = js::str_of(js::get(&self.settings(), "captchaApiKey")).trim().to_string();
            if key.is_empty() {
                return Err(Error::new(format!("{} — add a 2Captcha API key in the LinkGrabber settings", c.label())));
            }
            self.with_link(id, |l| {
                l.status = "checking".into();
                l.error = format!("Solving {}…", c.label());
            });
            self.touch();
            let token = captcha::solve(&self.net, &key, &c, page_url).await?;
            let form = captcha::answer_form(&html, page_url, &c, &token);
            let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(&form.fields).finish();
            cookies = captcha::merge_cookies(&cookies, f.headers.get("set-cookie").map(|s| s.as_str()));
            let mut so = ReqOpts { auth: link.auth.clone(), max_bytes: Some(4 * 1024 * 1024), timeout_sec: Some(30.0), ..Default::default() }.header("Referer", page_url);
            if !cookies.is_empty() {
                so = so.header("Cookie", &cookies);
            }
            let mut target = form.action.clone();
            if form.method == "GET" {
                let mut u = url::Url::parse(&form.action).map_err(|_| Error::new("Invalid form address"))?;
                u.set_query(Some(&body));
                target = u.to_string();
            } else {
                so.method = Some(reqwest::Method::POST);
                so.body = Some(body.into_bytes());
                so = so.header("Content-Type", "application/x-www-form-urlencoded");
            }
            f = self.net.fetch_buffer(&target, &so).await?;
            cookies = captcha::merge_cookies(&cookies, f.headers.get("set-cookie").map(|s| s.as_str()));
            html = String::from_utf8_lossy(&f.body).into_owned();
            if captcha::detect(&html).is_some() {
                return Err(Error::new(format!("{} was not accepted", c.label())));
            }
        }
        let page_url = if f.url.is_empty() { page_url } else { f.url.as_str() };
        let files: Vec<_> = extract_links(&html, page_url)
            .into_iter()
            .filter(|x| x.tag != "css" && (hosters::keeps_fragment(&x.url) || !PAGE_EXT.contains(&u::ext_of(&url::Url::parse(&x.url).map(|p| p.path().to_string()).unwrap_or_default()).as_str())))
            .collect();
        if files.is_empty() {
            return Ok(false);
        }
        let links = files.iter().map(|f| json!({ "url": f.url, "text": f.text, "depth": 1 })).collect();
        self.replace_with(id, &link, links, page_url, &cookies);
        Ok(true)
    }

    /// Opens a PrivateBin paste and puts the links inside in its place.
    async fn open_paste(&self, id: &str, link: &Link) -> Result<()> {
        let text = hosters::fetch_paste(&self.net, &link.url, &ReqOpts { timeout_sec: Some(30.0), ..Default::default() }).await?;
        let links: Vec<Value> = u::extract_urls(&text).into_iter().map(|url| json!({ "url": url, "text": link.description, "depth": 1 })).collect();
        if links.is_empty() {
            return Err(Error::new("The paste has no links"));
        }
        self.replace_with(id, link, links, &link.referer, &link.cookies);
        Ok(())
    }

    /// Adds links found inside a link (page or paste) and drops the link itself.
    fn replace_with(&self, id: &str, link: &Link, links: Vec<Value>, referer: &str, cookies: &str) {
        let hit = self.store.linkgrabber.borrow().packages.iter().find(|p| p.links.iter().any(|l| l.id == id)).map(|p| p.id.clone());
        let mut opts = json!({
            "links": links, "referer": referer, "cookies": cookies, "userAgent": link.user_agent, "auth": link.auth, "deep": false,
            "source": link.source,
        });
        if let Some(fp) = &link.forced_package {
            opts["packageName"] = json!(fp);
        }
        if let Some(sd) = &link.forced_save_dir {
            opts["saveDir"] = json!(sd);
        }
        self.add(&opts);
        if let Some(pid) = hit {
            detach(&mut self.store.linkgrabber.borrow_mut().packages, &pid, id);
        }
    }

    // ---- editing ---------------------------------------------------------------------------------

    pub fn set_enabled(&self, ids: &[String], enabled: bool) {
        {
            let mut st = self.store.linkgrabber.borrow_mut();
            let chosen: HashSet<String> = select(&st.packages, ids).into_iter().collect();
            for l in st.packages.iter_mut().flat_map(|p| p.links.iter_mut()) {
                if chosen.contains(&l.id) {
                    l.enabled = enabled;
                }
            }
        }
        self.touch();
    }

    pub fn update_package(&self, id: &str, patch: &Value) {
        {
            let mut st = self.store.linkgrabber.borrow_mut();
            let Some(p) = pkg_mut(&mut st.packages, id) else { return };
            let name = js::get(patch, "name");
            if !name.is_null() {
                let n = js::str_of(name).trim().to_string();
                if !n.is_empty() && n != p.name {
                    p.name = n;
                    // A renamed package keeps its links and no longer collects new ones automatically.
                    if p.kind != "custom" {
                        p.kind = "custom".into();
                        for l in p.links.iter_mut() {
                            l.pinned = true;
                        }
                    }
                }
            }
            let sd = js::get(patch, "saveDir");
            if !sd.is_null() {
                p.save_dir = js::str_of(sd);
            }
            let ex = js::get(patch, "expanded");
            if !ex.is_null() {
                p.expanded = js::truthy(ex);
            }
        }
        self.touch();
    }

    pub fn rename_link(&self, id: &str, name: &str) {
        if name.trim().is_empty() {
            return;
        }
        let ok = self.with_link(id, |l| {
            l.name = u::sanitize_file_name(name);
            l.name_locked = true;
        });
        if ok.is_some() {
            self.touch();
        }
    }

    /// Moves links (or whole packages) into a new package with the given name.
    pub fn merge(&self, ids: &[String], name: &str) -> Option<String> {
        let settings = self.settings();
        let pid = {
            let mut st = self.store.linkgrabber.borrow_mut();
            let pkgs = &mut st.packages;
            let chosen = select(pkgs, ids);
            if chosen.is_empty() {
                return None;
            }
            let first_name = pkgs.iter().flat_map(|p| p.links.iter()).find(|l| l.id == chosen[0]).map(|l| l.name.clone()).unwrap_or_default();
            let n = name.trim();
            let fallback = package_name_for(&first_name);
            let pid = new_package(pkgs, &settings, if n.is_empty() { &fallback } else { n }, "custom", None);
            let mut save_dir = String::new();
            for lid in &chosen {
                let cur = pkgs.iter().find(|p| p.id != pid && p.links.iter().any(|l| &l.id == lid)).map(|p| p.id.clone());
                let link = match cur {
                    Some(c) => detach(pkgs, &c, lid),
                    None => None,
                };
                if let Some(mut l) = link {
                    l.pinned = true;
                    if save_dir.is_empty() {
                        if let Some(sd) = l.forced_save_dir.clone().filter(|s| !s.is_empty()) {
                            save_dir = sd;
                        }
                    }
                    pkg_mut(pkgs, &pid).unwrap().links.push(l);
                }
            }
            pkg_mut(pkgs, &pid).unwrap().save_dir = save_dir;
            pid
        };
        self.touch();
        Some(pid)
    }

    /// Splits each selected package into one package per host ("name-host").
    pub fn split_by_host(&self, ids: &[String]) {
        let settings = self.settings();
        {
            let mut st = self.store.linkgrabber.borrow_mut();
            let pkgs = &mut st.packages;
            let set: HashSet<&String> = ids.iter().collect();
            let snapshot: Vec<String> = pkgs.iter().map(|p| p.id.clone()).collect();
            for pid in snapshot {
                let Some(p) = pkgs.iter().find(|p| p.id == pid) else { continue };
                if !set.contains(&p.id) && !p.links.iter().any(|l| set.contains(&l.id)) {
                    continue;
                }
                let mut hosts: Vec<String> = Vec::new();
                for l in &p.links {
                    if !hosts.contains(&l.host) {
                        hosts.push(l.host.clone());
                    }
                }
                if hosts.len() < 2 {
                    continue;
                }
                let (pname, psave) = (p.name.clone(), p.save_dir.clone());
                for host in &hosts[1..] {
                    let part = new_package(pkgs, &settings, &format!("{}-{}", pname, host), "custom", None);
                    pkg_mut(pkgs, &part).unwrap().save_dir = psave.clone();
                    let movers: Vec<String> = pkgs.iter().find(|x| x.id == pid).map(|x| x.links.iter().filter(|l| &l.host == host).map(|l| l.id.clone()).collect()).unwrap_or_default();
                    for lid in movers {
                        if let Some(mut l) = detach(pkgs, &pid, &lid) {
                            l.pinned = true;
                            pkg_mut(pkgs, &part).unwrap().links.push(l);
                        }
                    }
                }
            }
        }
        self.touch();
    }

    pub fn remove(&self, ids: &[String]) {
        let drop: HashSet<String> = select(&self.store.linkgrabber.borrow().packages, ids).into_iter().collect();
        {
            let mut st = self.store.linkgrabber.borrow_mut();
            for p in st.packages.iter_mut() {
                p.links.retain(|l| !drop.contains(&l.id));
            }
            st.packages.retain(|p| !p.links.is_empty());
        }
        self.todo.borrow_mut().retain(|id| !drop.contains(id));
        self.touch();
    }

    pub fn remove_offline(&self) {
        let ids: Vec<String> = self.links().into_iter().filter(|l| l.status == "offline").map(|l| l.id).collect();
        self.remove(&ids);
    }

    pub fn clear(&self) {
        self.store.linkgrabber.borrow_mut().packages.clear();
        self.todo.borrow_mut().clear();
        self.cancel_auto_confirm();
        self.touch();
    }

    // ---- confirming ------------------------------------------------------------------------------

    /// The folder a package's file is saved to, or None for the category default.
    fn save_dir_for(&self, pkg: &Package, link: &Link) -> Option<String> {
        if !pkg.save_dir.is_empty() {
            return Some(pkg.save_dir.clone());
        }
        let own = pkg.kind == "normal" || pkg.kind == "custom";
        if !own || !js::truthy(js::get(&self.settings(), "packageFolders")) || pkg.links.len() < 2 {
            return None;
        }
        let base = self.manager.folder_for_category(&self.manager.category_for_name(&link.name));
        Some(join(&base, &u::sanitize_file_name(&pkg.name)))
    }

    /// Moves links to the download list. ids: packages and/or links (empty = everything).
    /// opts: queueId, start, includeOffline, includeDupes, includeDisabled.
    /// Returns the new download ids.
    pub fn confirm(&self, ids: &[String], opts: &Value) -> Vec<String> {
        self.cancel_auto_confirm();
        let s = self.settings();
        let include_offline = match js::get(opts, "includeOffline") {
            Value::Null => js::s(js::get(&s, "offlineAction")) == "include",
            v => js::truthy(v),
        };
        let include_dupes = match js::get(opts, "includeDupes") {
            Value::Null => js::s(js::get(&s, "dupeAction")) == "add",
            v => js::truthy(v),
        };
        let packages = self.store.linkgrabber.borrow().packages.clone();
        let chosen: HashSet<String> = if ids.is_empty() {
            packages.iter().flat_map(|p| p.links.iter().map(|l| l.id.clone())).collect()
        } else {
            select(&packages, ids).into_iter().collect()
        };
        let mut added = Vec::new();
        let mut done: HashSet<String> = HashSet::new();
        for pkg in &packages {
            for l in &pkg.links {
                if !chosen.contains(&l.id) || l.status == "checking" {
                    continue;
                }
                if !l.enabled && !js::truthy(js::get(opts, "includeDisabled")) {
                    continue;
                }
                if l.status == "offline" && !include_offline {
                    continue;
                }
                if (l.in_list || self.manager.find_duplicate(&l.url).is_some()) && !include_dupes {
                    done.insert(l.id.clone());
                    continue;
                }
                let mut o = json!({
                    "url": l.url, "description": if !l.description.is_empty() { l.description.clone() } else if pkg.kind == "various" { String::new() } else { pkg.name.clone() },
                    "referer": l.referer, "parentPage": l.referer, "cookies": l.cookies, "userAgent": l.user_agent,
                    "mime": l.kind, "duplicateAction": "number",
                });
                if l.status == "online" {
                    o["fileName"] = json!(l.name);
                }
                if let Some(d) = self.save_dir_for(pkg, l) {
                    o["saveDir"] = json!(d);
                }
                if let Some(a) = &l.auth {
                    o["auth"] = json!(a);
                }
                if let Some(sz) = l.size.filter(|x| *x != 0.0) {
                    o["size"] = json!(sz);
                }
                let q = js::get(opts, "queueId");
                if js::truthy(q) {
                    o["queueId"] = q.clone();
                }
                if let Ok(res) = self.manager.add(&o) {
                    added.push(js::str_of(&res["item"]["id"]));
                    done.insert(l.id.clone());
                }
            }
        }
        {
            let mut st = self.store.linkgrabber.borrow_mut();
            for p in st.packages.iter_mut() {
                p.links.retain(|l| !done.contains(&l.id));
            }
            st.packages.retain(|p| !p.links.is_empty());
        }
        if js::truthy(js::get(opts, "start")) {
            for id in &added {
                self.manager.start(id);
            }
        }
        self.touch();
        self.events.emit(LgEvent::Confirmed(added.clone()));
        added
    }

    fn schedule_auto_confirm(&self) {
        let s = self.settings();
        if !js::truthy(js::get(&s, "autoConfirm")) || !self.links().iter().any(|l| l.enabled && l.status != "offline") {
            return;
        }
        self.cancel_auto_confirm();
        let delay = js::num_or(js::get(&s, "autoConfirmDelaySec"), 15.0).max(1.0) * 1000.0;
        let w = self.me.borrow().clone();
        *self.auto_timer.borrow_mut() = Some(tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay as u64)).await;
            let Some(me) = w.upgrade() else { return };
            me.auto_timer.borrow_mut().take();
            let s = me.settings();
            let q = js::get(&s, "queueId");
            let mut o = json!({ "start": js::get(&s, "autoStart"), "auto": true });
            if js::truthy(q) {
                o["queueId"] = q.clone();
            }
            me.confirm(&[], &o);
        }));
        self.events.emit(LgEvent::Changed);
    }

    fn cancel_auto_confirm(&self) {
        if let Some(t) = self.auto_timer.borrow_mut().take() {
            t.abort();
        }
    }

    pub fn dispose(&self) {
        self.cancel_auto_confirm();
        self.todo.borrow_mut().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_names_drop_archive_part_numbers_and_extensions() {
        assert_eq!(package_name_for("Movie.2020.part01.rar"), "Movie.2020");
        assert_eq!(package_name_for("Movie.2020.part2.rar"), "Movie.2020");
        assert_eq!(package_name_for("backup.7z.003"), "backup");
        assert_eq!(package_name_for("data.z01"), "data");
        assert_eq!(package_name_for("data.zip"), "data");
        assert_eq!(package_name_for("set.vol03+04.par2"), "set");
        assert_eq!(package_name_for("source.tar.gz"), "source");
        assert_eq!(package_name_for("song.mp3"), "song");
    }
}

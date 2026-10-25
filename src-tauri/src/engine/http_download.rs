//! Multi-connection HTTP(S) download with dynamic segmentation (port of engine/http-download.js).
//!
//! The first connection requests an open-ended range from 0. Each additional connection
//! splits the largest remaining segment in half and starts at its midpoint. A connection
//! that reaches the end of its segment takes over the next segment if that segment's
//! connection has not received any data yet (reusing the already-open stream); otherwise
//! it splits the largest remaining segment again. Segment positions are persisted so a
//! download survives pause, crash or power loss.
//!
//! Persisted state lives on `item`: size, resumable, segments[{start,end,pos}], etag, lastModified.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use bytes::Bytes;
use rand::Rng;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::limiter::{perf_now, take_all, RateLimiter, LimiterRef, SpeedMeter};
use super::net::{ReqOpts, Response};
use super::{file_len, interval, open, set_len, sleep_ms, write_at, Ctx, Engine, EngineEvent, Fh, Meta, Sink, MAX_PIECE};
use crate::error::{Error, Result};
use crate::item::{seg, ItemRef, SegRef, INF};
use crate::js;
use crate::util::{dirname, file_name_from_disposition};

/// Errors that retrying will not fix.
const DISK_ERRORS: &[&str] = &["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "EFBIG", "EIO"];

/// Retry-After as milliseconds (delta seconds or an HTTP date), or 0.
pub fn retry_after_ms(header: Option<&str>) -> u64 {
    let Some(h) = header.filter(|h| !h.is_empty()) else { return 0 };
    let secs = js::num(&Value::String(h.to_string()));
    let ms = if secs.is_finite() {
        secs * 1000.0
    } else {
        match chrono::DateTime::parse_from_rfc2822(h.trim()) {
            Ok(d) => d.timestamp_millis() as f64 - js::now_ms(),
            Err(_) => f64::NAN,
        }
    };
    if ms > 0.0 {
        ms.min(5.0 * 60.0 * 1000.0) as u64
    } else {
        0
    }
}

pub struct ContentRange {
    pub start: u64,
    pub end: u64,
    pub total: Option<u64>,
}

static CONTENT_RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^bytes\s+(\d+)-(\d+)/(\d+|\*)$").unwrap());

/// "bytes a-b/total" → { start, end, total } (total None when "*").
pub fn parse_content_range(header: Option<&str>) -> Option<ContentRange> {
    let m = CONTENT_RANGE.captures(header.unwrap_or("").trim())?;
    Some(ContentRange {
        start: m[1].parse().ok()?,
        end: m[2].parse().ok()?,
        total: if &m[3] == "*" { None } else { m[3].parse().ok() },
    })
}

/// A piece being written while the connection reads on.
struct PendingWrite {
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    seg: SegRef,
    len: u64,
    t: f64,
}

struct Worker {
    id: u64,
    seg: RefCell<Option<SegRef>>,
    abort: CancellationToken,
    receiving: Cell<bool>,
    retries: Cell<u32>,
    gave_up: Cell<bool>,
}

type W = Rc<Worker>;

impl Worker {
    fn aborted(&self) -> bool {
        self.abort.is_cancelled()
    }
    fn seg(&self) -> Option<SegRef> {
        self.seg.borrow().clone()
    }
}

#[derive(Default)]
struct Metrics {
    t0: f64,
    bytes: u64,
    ttfb_ms: Option<u64>,
    redirects: u32,
    retries: u32,
    disk_ms: f64,
    peak_connections: usize,
}

pub struct HttpDownload {
    me: RefCell<std::rc::Weak<HttpDownload>>,
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    workers: RefCell<Vec<W>>,
    meter: RefCell<SpeedMeter>,
    limiter: LimiterRef,
    stopped: Cell<bool>,
    fh: RefCell<Option<Fh>>,
    fatal: RefCell<Option<Error>>,
    last_error: RefCell<Option<Error>>,
    wid: Cell<u64>,
    resuming: Cell<bool>,
    stream_ended: Cell<bool>,
    metrics: RefCell<Metrics>,
    timers: RefCell<Vec<JoinHandle<()>>>,
    idle: Notify,
    /// The file's own address when `item.url` is a hoster page (resolved at every start).
    direct: RefCell<Option<String>>,
}

impl HttpDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<HttpDownload> {
        let kb = item.borrow().speed_limit_kb;
        let me = Rc::new(HttpDownload {
            me: RefCell::new(std::rc::Weak::new()),
            item,
            ctx,
            sink,
            workers: RefCell::new(Vec::new()),
            meter: RefCell::new(SpeedMeter::default()),
            limiter: RateLimiter::shared(if kb > 0.0 { kb * 1024.0 } else { 0.0 }),
            stopped: Cell::new(false),
            fh: RefCell::new(None),
            fatal: RefCell::new(None),
            last_error: RefCell::new(None),
            wid: Cell::new(0),
            resuming: Cell::new(false),
            stream_ended: Cell::new(false),
            metrics: RefCell::new(Metrics::default()),
            timers: RefCell::new(Vec::new()),
            idle: Notify::new(),
            direct: RefCell::new(None),
        });
        *me.me.borrow_mut() = Rc::downgrade(&me);
        me
    }

    fn rc(&self) -> Rc<HttpDownload> {
        self.me.borrow().upgrade().expect("engine alive")
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    fn setting(&self, path: &[&str]) -> Value {
        self.ctx.store.s(path)
    }

    fn max_connections(&self) -> f64 {
        let (mc, url) = {
            let it = self.item.borrow();
            (it.max_connections, it.url.clone())
        };
        let n = if mc != 0.0 && !mc.is_nan() { mc } else { (self.ctx.max_conn_for)(&url) };
        n.max(1.0)
    }

    fn headers(&self) -> Vec<(String, String)> {
        let it = self.item.borrow();
        let mut h = Vec::new();
        if !it.referer.is_empty() {
            super::net::set_header(&mut h, "Referer", &it.referer);
        }
        if !it.cookies.is_empty() {
            super::net::set_header(&mut h, "Cookie", &it.cookies);
        }
        if !it.user_agent.is_empty() {
            super::net::set_header(&mut h, "User-Agent", &it.user_agent);
        }
        if let Some(x) = &it.extra_headers {
            for (k, v) in x {
                super::net::set_header(&mut h, k, &js::str_of(v));
            }
        }
        h
    }

    fn downloaded(&self) -> u64 {
        self.item.borrow().segments_downloaded()
    }

    fn fh(&self) -> Result<Fh> {
        self.fh.borrow().clone().ok_or_else(|| Error::new("Cannot read properties of null (reading 'stat')"))
    }

    async fn open_file(&self, truncate: bool) -> Result<()> {
        let temp = self.item.borrow().temp_path.clone();
        tokio::fs::create_dir_all(dirname(&temp)).await?;
        if truncate {
            *self.fh.borrow_mut() = Some(open(&temp, "w+").await?);
            return Ok(());
        }
        match open(&temp, "r+").await {
            Ok(f) => *self.fh.borrow_mut() = Some(f),
            Err(e) if e.code() == "ENOENT" => {
                // Temp file vanished: any recorded progress is invalid.
                if let Some(segs) = &self.item.borrow().segments {
                    for s in segs {
                        let mut s = s.borrow_mut();
                        s.pos = s.start;
                    }
                }
                *self.fh.borrow_mut() = Some(open(&temp, "w+").await?);
            }
            Err(e) => return Err(e),
        }
        Ok(())
    }

    async fn run(self: Rc<Self>) {
        let r = self.clone().run_inner().await;
        if let Err(e) = r {
            let kind = if self.stopped.get() { "stopped" } else { "error" };
            self.finish(kind, Some(e)).await;
        }
    }

    /// The address requests go to.
    fn url(&self) -> String {
        self.direct.borrow().clone().unwrap_or_else(|| self.item.borrow().url.clone())
    }

    async fn run_inner(self: Rc<Self>) -> Result<()> {
        let page = self.item.borrow().url.clone();
        if crate::hosters::needs_resolve(&page) {
            self.emit(EngineEvent::Status("Resolving download link...".into()));
            let key = js::str_of(&self.ctx.store.s(&["linkGrabber", "captchaApiKey"]));
            let direct = crate::hosters::resolve(&self.ctx.net, &page, key.trim()).await?;
            if self.stopped.get() {
                self.finish("stopped", None).await;
                return Ok(());
            }
            *self.direct.borrow_mut() = Some(direct);
        }
        let query = self.item.borrow().range_mode.as_deref() == Some("query");
        if query {
            // Size is known up front (e.g. googlevideo `clen`); every request is a bounded `&range=a-b` chunk.
            let size = self.item.borrow().size.unwrap_or(0);
            if size == 0 {
                return Err(Error::new("Stream size is unknown"));
            }
            self.item.borrow_mut().resumable = Some(true);
            let has = self.item.borrow().segments.is_some() && self.downloaded() > 0;
            self.open_file(!has).await?;
            if !has {
                self.item.borrow_mut().segments = Some(vec![seg(0, size, 0)]);
            }
            let ct = self.item.borrow().content_type.clone().unwrap_or_default();
            self.emit(EngineEvent::Meta(Meta { size: Some(size), resumable: true, content_type: ct, file_name: None }));
            self.emit(EngineEvent::Status("Receiving data...".into()));
            self.fill_connections();
        } else {
            let can_resume = {
                let it = self.item.borrow();
                it.resumable == Some(true) && it.size.unwrap_or(0) > 0 && it.segments.is_some()
            } && self.downloaded() > 0;
            self.open_file(!can_resume).await?;
            if !can_resume {
                let mut it = self.item.borrow_mut();
                it.segments = None;
                it.downloaded = 0;
            }
            self.emit(EngineEvent::Status("Connecting...".into()));
            if can_resume {
                self.resuming.set(true);
                self.fill_connections();
            } else {
                self.spawn(None);
            }
        }
        self.when_idle().await;
        if self.stopped.get() {
            self.finish("stopped", None).await;
            return Ok(());
        }
        let fatal = self.fatal.borrow().clone();
        if let Some(f) = fatal {
            self.finish("error", Some(f)).await;
            return Ok(());
        }
        if !self.is_complete() {
            let e = self.last_error.borrow().clone().unwrap_or_else(|| Error::new("Download interrupted"));
            self.finish("error", Some(e)).await;
            return Ok(());
        }
        self.finish("complete", None).await;
        Ok(())
    }

    async fn finish(&self, kind: &str, err: Option<Error>) {
        let mut kind = kind.to_string();
        let mut err = err;
        for t in self.timers.borrow_mut().drain(..) {
            t.abort();
        }
        if kind == "complete" {
            // The bytes on disk must match what the server said it would send.
            let want = self.item.borrow().size.unwrap_or_else(|| self.downloaded());
            let check = async {
                let fh = self.fh()?;
                let size = file_len(&fh).await?;
                if size > want {
                    set_len(&fh, want).await?;
                } else if size < want {
                    return Err(Error::new(format!("The file is incomplete ({} of {} bytes)", size, want)));
                }
                Ok(())
            };
            if let Err(e) = check.await {
                kind = "error".into();
                err = Some(e);
            }
        }
        *self.fh.borrow_mut() = None;
        self.emit_progress();
        self.emit(EngineEvent::Persist);
        let m = {
            let m = self.metrics.borrow();
            let elapsed = perf_now() - m.t0;
            json!({
                "status": kind,
                "error": if kind == "error" { Value::String(err.as_ref().map(|e| e.message.clone()).unwrap_or_default()) } else { Value::Null },
                "bytes": m.bytes,
                "elapsedMs": elapsed.round() as u64,
                "avgMBps": if elapsed > 0.0 { ((m.bytes as f64 / 1048576.0 / (elapsed / 1000.0)) * 100.0).round() / 100.0 } else { 0.0 },
                "ttfbMs": m.ttfb_ms,
                "redirects": m.redirects,
                "retries": m.retries,
                "diskMs": m.disk_ms.round() as u64,
                "peakConnections": m.peak_connections,
                "resumable": self.item.borrow().resumable == Some(true),
            })
        };
        self.emit(EngineEvent::Metrics(m));
        match kind.as_str() {
            "complete" => {
                if self.item.borrow().size.is_none() {
                    let d = self.downloaded();
                    self.item.borrow_mut().size = Some(d);
                }
                self.emit(EngineEvent::Complete);
            }
            "error" => self.emit(EngineEvent::Failed(err.unwrap_or_else(|| Error::new("Download failed")))),
            _ => self.emit(EngineEvent::Stopped),
        }
    }

    async fn when_idle(&self) {
        loop {
            let n = self.idle.notified();
            if self.workers.borrow().is_empty() {
                return;
            }
            n.await;
        }
    }

    fn is_complete(&self) -> bool {
        let it = self.item.borrow();
        let Some(segs) = &it.segments else { return false };
        if it.size.is_none() {
            return self.stream_ended.get();
        }
        segs.iter().all(|s| {
            let s = s.borrow();
            s.pos >= s.end
        })
    }

    /// Picks work for a new/finished connection: an orphan segment, or half of the largest one.
    fn next_segment(&self) -> Option<SegRef> {
        let min_kb = js::num_or(&self.setting(&["connection", "minSegmentKB"]), 256.0);
        let mut it = self.item.borrow_mut();
        if it.resumable != Some(true) || it.size.is_none() {
            return None;
        }
        let segs = it.segments.as_mut()?;
        let owned: Vec<SegRef> = self.workers.borrow().iter().filter_map(|w| w.seg()).collect();
        let is_owned = |s: &SegRef| owned.iter().any(|o| Rc::ptr_eq(o, s));
        if let Some(orphan) = segs.iter().find(|s| {
            let b = s.borrow();
            b.pos < b.end && !is_owned(s)
        }) {
            return Some(orphan.clone());
        }
        let min_split = (64.0 * 1024.0f64).max(min_kb * 1024.0) as u64;
        let mut best: Option<usize> = None;
        for (i, s) in segs.iter().enumerate() {
            if !is_owned(s) {
                continue;
            }
            let b = s.borrow();
            let rem = b.end.saturating_sub(b.pos);
            let better = match best {
                None => true,
                Some(j) => {
                    let bj = segs[j].borrow();
                    rem > bj.end.saturating_sub(bj.pos)
                }
            };
            if rem >= 2 * min_split && better {
                best = Some(i);
            }
        }
        let i = best?;
        let (mid, end) = {
            let b = segs[i].borrow();
            (b.pos + (b.end - b.pos) / 2, b.end)
        };
        let s = seg(mid, end, mid);
        segs[i].borrow_mut().end = mid;
        segs.insert(i + 1, s.clone());
        Some(s)
    }

    fn fill_connections(&self) {
        if self.stopped.get() || self.fatal.borrow().is_some() {
            return;
        }
        let mut guard = 64;
        while (self.workers.borrow().len() as f64) < self.max_connections() && guard > 0 {
            guard -= 1;
            let Some(s) = self.next_segment() else { break };
            self.spawn(Some(s));
        }
    }

    fn spawn(&self, s: Option<SegRef>) {
        let id = self.wid.get() + 1;
        self.wid.set(id);
        let w = Rc::new(Worker {
            id,
            seg: RefCell::new(s),
            abort: CancellationToken::new(),
            receiving: Cell::new(false),
            retries: Cell::new(0),
            gave_up: Cell::new(false),
        });
        self.workers.borrow_mut().push(w.clone());
        {
            let n = self.workers.borrow().len();
            let mut m = self.metrics.borrow_mut();
            m.peak_connections = m.peak_connections.max(n);
        }
        let me = self.rc();
        tokio::task::spawn_local(async move {
            if let Err(e) = me.run_worker(&w).await {
                *me.last_error.borrow_mut() = Some(e);
            }
            me.workers.borrow_mut().retain(|x| !Rc::ptr_eq(x, &w));
            if !me.stopped.get() && me.fatal.borrow().is_none() && !me.is_complete() {
                // Hand leftover work to new connections; give up only if nothing is running.
                if me.workers.borrow().is_empty() && w.gave_up.get() {
                    me.idle.notify_waiters();
                    return;
                }
                me.fill_connections();
            }
            if me.workers.borrow().is_empty() {
                me.idle.notify_waiters();
            }
        });
    }

    fn set_fatal(&self, e: Error) {
        *self.fatal.borrow_mut() = Some(e);
    }

    fn fatal_set(&self) -> bool {
        self.fatal.borrow().is_some()
    }

    async fn request(&self, url: &str, headers: Vec<(String, String)>, w: &W) -> Result<Response> {
        let opts = ReqOpts { headers, auth: self.item.borrow().auth.clone(), signal: Some(w.abort.clone()), ..Default::default() };
        self.ctx.net.request(url, &opts).await
    }

    async fn wait_limiters(&self, n: usize) {
        let mut all = vec![self.limiter.clone()];
        all.extend((self.ctx.limiters)());
        let wait = take_all(&all, n);
        if wait > 0 {
            sleep_ms(wait).await;
        }
    }

    /// Bounded chunk requests addressed with a `range=a-b` query parameter instead of a Range header.
    async fn run_query_worker(&self, w: &W) -> Result<()> {
        let max_retries = retries_setting(&self.setting(&["connection", "connectionRetries"]));
        const CHUNK: u64 = 8 * 1024 * 1024;
        while !self.stopped.get() && !self.fatal_set() && !w.aborted() {
            let done = w.seg().is_none_or(|s| {
                let s = s.borrow();
                s.pos >= s.end
            });
            if done {
                let Some(next) = self.next_segment() else { return Ok(()) };
                *w.seg.borrow_mut() = Some(next);
                w.receiving.set(false);
            }
            let s = w.seg().unwrap();
            let (pos, end) = {
                let b = s.borrow();
                (b.pos, b.end)
            };
            let chunk_end = end.min(pos + CHUNK);
            let mut u = url::Url::parse(&self.url())?;
            set_search_param(&mut u, "range", &format!("{}-{}", pos, chunk_end - 1));
            let attempt: Result<()> = async {
                let mut res = self.request(u.as_str(), self.headers(), w).await?;
                if res.status >= 400 {
                    res.destroy();
                    let mut err = Error::new(format!("HTTP {}", res.status));
                    err.status = Some(res.status);
                    if [401, 403, 404, 410].contains(&res.status) {
                        err.message = format!("HTTP {}: the stream link was refused or has expired — send the video to OpenDM again from its page", res.status);
                        self.set_fatal(err);
                        return Ok(());
                    }
                    return Err(err);
                }
                while let Some(chunk) = res.chunk(Some(&w.abort)).await? {
                    if w.aborted() || self.stopped.get() {
                        break;
                    }
                    let mut chunk = chunk;
                    while !chunk.is_empty() {
                        w.receiving.set(true);
                        // seg.end may shrink when another connection splits it
                        let room = {
                            let b = s.borrow();
                            chunk_end.min(b.end).saturating_sub(b.pos)
                        };
                        if room == 0 {
                            break;
                        }
                        let take = (chunk.len() as u64).min(room).min(MAX_PIECE as u64) as usize;
                        let part = chunk.split_to(take);
                        self.wait_limiters(part.len()).await;
                        self.write(w, part).await?;
                    }
                    let full = {
                        let b = s.borrow();
                        chunk_end.min(b.end) <= b.pos
                    };
                    if full {
                        break;
                    }
                }
                res.destroy();
                if w.aborted() || self.stopped.get() {
                    return Ok(());
                }
                let short = {
                    let b = s.borrow();
                    b.pos < chunk_end.min(b.end)
                };
                if short {
                    return Err(Error::new("Connection closed prematurely"));
                }
                w.retries.set(0);
                Ok(())
            }
            .await;
            if let Err(e) = attempt {
                if w.aborted() || self.stopped.get() || self.fatal_set() {
                    return Ok(());
                }
                if self.backoff(w, &e, max_retries).await {
                    continue;
                }
                w.gave_up.set(true);
                return Err(e);
            }
            if self.fatal_set() || w.aborted() || self.stopped.get() {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn run_worker(&self, w: &W) -> Result<()> {
        if self.item.borrow().range_mode.as_deref() == Some("query") {
            return self.run_query_worker(w).await;
        }
        let max_retries = retries_setting(&self.setting(&["connection", "connectionRetries"]));
        while !self.stopped.get() && !self.fatal_set() && !w.aborted() {
            let first = w.seg().is_none();
            let from = w.seg().map(|s| s.borrow().pos).unwrap_or(0);
            if !first {
                let s = w.seg().unwrap();
                let done = {
                    let b = s.borrow();
                    b.pos >= b.end
                };
                if done {
                    let Some(next) = self.next_segment() else { return Ok(()) };
                    *w.seg.borrow_mut() = Some(next);
                    w.receiving.set(false);
                    continue;
                }
            }
            let url = self.url();
            let mut headers = self.headers();
            super::net::set_header(&mut headers, "Range", &format!("bytes={}-", from));
            let mut res = match self.request(&url, headers, w).await {
                Ok(r) => {
                    if first {
                        self.metrics.borrow_mut().redirects = r.redirects;
                    }
                    r
                }
                Err(e) => {
                    if w.aborted() || self.stopped.get() {
                        return Ok(());
                    }
                    if e.code() == "EAUTH" {
                        self.set_fatal(e);
                        return Ok(());
                    }
                    if self.backoff(w, &e, max_retries).await {
                        continue;
                    }
                    w.gave_up.set(true);
                    return Err(e);
                }
            };
            let attempt: Result<bool> = async {
                if !self.accept_response(w, &mut res, first, from).await? {
                    return Ok(false);
                }
                self.pump(w, &mut res).await?;
                if first && self.item.borrow().size.is_none() && !w.aborted() && !self.stopped.get() {
                    self.stream_ended.set(true);
                    let d = self.downloaded();
                    self.item.borrow_mut().size = Some(d);
                    if let Some(s) = w.seg() {
                        s.borrow_mut().end = d;
                    }
                    return Ok(true);
                }
                w.retries.set(0);
                Ok(false)
            }
            .await;
            match attempt {
                Ok(true) => return Ok(()),
                Ok(false) => continue,
                Err(e) => {
                    res.destroy();
                    if w.aborted() || self.stopped.get() || self.fatal_set() {
                        return Ok(());
                    }
                    if self.item.borrow().resumable != Some(true) {
                        // Cannot continue mid-stream on a non-resumable server: restart from scratch.
                        if self.backoff(w, &e, max_retries).await {
                            self.item.borrow_mut().segments = None;
                            *w.seg.borrow_mut() = None;
                            set_len(&self.fh()?, 0).await?;
                            continue;
                        }
                        w.gave_up.set(true);
                        return Err(e);
                    }
                    if self.backoff(w, &e, max_retries).await {
                        continue;
                    }
                    w.gave_up.set(true);
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    async fn backoff(&self, w: &W, err: &Error, max_retries: f64) -> bool {
        *self.last_error.borrow_mut() = Some(err.clone());
        if DISK_ERRORS.contains(&err.code()) {
            // A full or read-only disk will not recover by retrying.
            self.set_fatal(Error::with_code(format!("Could not write the file: {}", err.message), err.code()));
            return false;
        }
        w.retries.set(w.retries.get() + 1);
        if max_retries != 0.0 && w.retries.get() as f64 > max_retries {
            return false;
        }
        self.metrics.borrow_mut().retries += 1;
        self.emit(EngineEvent::Status(format!("Retrying ({})...", err.message)));
        // Exponential backoff with jitter, never sooner than the server's Retry-After.
        let base = 30000f64.min(1000.0 * 2f64.powi(w.retries.get().min(5) as i32));
        let jitter = base * (0.75 + rand::thread_rng().gen::<f64>() * 0.5);
        sleep_ms((err.retry_after as f64).max(jitter) as u64).await;
        !self.stopped.get() && !w.aborted()
    }

    /// Validates status/headers; establishes metadata on the first response. Returns false to retry.
    async fn accept_response(&self, w: &W, res: &mut Response, first: bool, from: u64) -> Result<bool> {
        let st = res.status;
        if st >= 400 {
            res.destroy();
            let mut err = Error::new(format!("HTTP {} {}", st, res.status_text).trim().to_string());
            err.status = Some(st);
            err.retry_after = retry_after_ms(res.header("retry-after"));
            let n = self.workers.borrow().len();
            if [429, 503].contains(&st) && n > 1 && !first {
                // Server limits parallel connections: drop this one and lower the cap.
                self.item.borrow_mut().max_connections = (n as f64 - 1.0).max(1.0);
                w.abort.cancel();
                return Ok(false);
            }
            if [400, 401, 403, 404, 410, 416].contains(&st) && (first || self.resuming.get()) {
                self.set_fatal(err);
                w.abort.cancel();
                return Ok(false);
            }
            return Err(err);
        }
        let range = if st == 206 { parse_content_range(res.header("content-range")) } else { None };
        let total = range.as_ref().and_then(|r| r.total);
        let etag = res.header("etag").filter(|x| !x.is_empty()).map(|x| x.to_string());
        let last_mod = res.header("last-modified").filter(|x| !x.is_empty()).map(|x| x.to_string());
        // A 206 must cover exactly the bytes asked for; otherwise ranges cannot be trusted.
        let bad_range = st == 206
            && match &range {
                None => true,
                Some(r) => r.start != from || r.total.is_some_and(|t| r.end >= t),
            };

        if first {
            {
                let mut m = self.metrics.borrow_mut();
                if m.ttfb_ms.is_none() {
                    m.ttfb_ms = Some((perf_now() - m.t0).round() as u64);
                }
            }
            if bad_range {
                res.destroy();
                return Err(Error::new("The server sent an invalid partial response"));
            }
            let meta = {
                let mut it = self.item.borrow_mut();
                it.resumable = Some(st == 206);
                it.size = if st == 206 {
                    total.filter(|t| *t > 0)
                } else {
                    res.header("content-length").filter(|c| !c.is_empty()).and_then(|c| c.trim().parse::<u64>().ok())
                };
                it.etag = etag;
                it.last_modified = last_mod;
                it.content_type = Some(res.header("content-type").unwrap_or("").to_string());
                if res.via_forward_proxy {
                    it.final_url = Some(res.url.clone());
                }
                Meta {
                    size: it.size,
                    resumable: st == 206,
                    content_type: it.content_type.clone().unwrap_or_default(),
                    file_name: file_name_from_disposition(res.header("content-disposition")),
                }
            };
            let resumable = meta.resumable;
            let size = meta.size;
            self.emit(EngineEvent::Meta(meta));
            let s = seg(0, size.unwrap_or(INF), 0);
            *w.seg.borrow_mut() = Some(s.clone());
            self.item.borrow_mut().segments = Some(vec![s]);
            self.emit(EngineEvent::Status("Receiving data...".into()));
            if resumable && size.unwrap_or(0) > 0 {
                let me = self.rc();
                tokio::task::spawn_local(async move {
                    sleep_ms(150).await;
                    me.fill_connections();
                });
            }
            return Ok(true);
        }

        if st == 200 || bad_range {
            // Server ignored Range for a continuation request, or answered with the wrong bytes.
            res.destroy();
            let seg_start = w.seg().map(|s| s.borrow().start).unwrap_or(0);
            if from == 0 && seg_start == 0 {
                return self.restart_non_resumable(w).await;
            }
            self.item.borrow_mut().max_connections = 1.0;
            if self.workers.borrow().len() > 1 {
                w.abort.cancel();
                return Ok(false);
            }
            return self.restart_non_resumable(w).await;
        }

        // Every continuation is checked, not just the first one after a resume: a file replaced on
        // the server mid-download must not be stitched together from two versions.
        let resuming = self.resuming.replace(false);
        let ignore_mod = js::truthy(&self.setting(&["downloads", "ignoreModTimeChanges"]));
        let changed = {
            let it = self.item.borrow();
            let size_changed = matches!((total, it.size), (Some(t), Some(s)) if t > 0 && s > 0 && t != s);
            let etag_changed = matches!((&it.etag, &etag), (Some(a), Some(b)) if a != b);
            let mod_changed = matches!((&it.last_modified, &last_mod), (Some(a), Some(b)) if a != b);
            size_changed || (!ignore_mod && (etag_changed || mod_changed))
        };
        if changed || resuming {
            if changed {
                self.emit(EngineEvent::Status("File changed on server, restarting...".into()));
                res.destroy();
                for x in self.workers.borrow().iter() {
                    if !Rc::ptr_eq(x, w) {
                        x.abort.cancel();
                    }
                }
                let s = {
                    let mut it = self.item.borrow_mut();
                    it.size = total.filter(|t| *t > 0);
                    it.etag = etag;
                    it.last_modified = last_mod;
                    let s = seg(0, it.size.unwrap_or(INF), 0);
                    it.segments = Some(vec![s.clone()]);
                    s
                };
                *w.seg.borrow_mut() = Some(s);
                set_len(&self.fh()?, 0).await?;
                return Ok(false);
            }
            self.emit(EngineEvent::Status("Receiving data...".into()));
        }
        Ok(true)
    }

    async fn restart_non_resumable(&self, w: &W) -> Result<bool> {
        self.item.borrow_mut().resumable = Some(false);
        for x in self.workers.borrow().iter() {
            if !Rc::ptr_eq(x, w) {
                x.abort.cancel();
            }
        }
        self.item.borrow_mut().segments = None;
        *w.seg.borrow_mut() = None;
        set_len(&self.fh()?, 0).await?;
        Ok(false)
    }

    async fn pump(&self, w: &W, res: &mut Response) -> Result<()> {
        match self.pump_chunks(w, res).await {
            Ok(()) => Ok(()),
            Err(_) if w.aborted() || self.stopped.get() => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Writes one received chunk at the segment's position.
    async fn write(&self, w: &W, part: Bytes) -> Result<()> {
        let s = w.seg().ok_or_else(|| Error::new("No segment"))?;
        let pos = s.borrow().pos;
        let len = part.len() as u64;
        let t = perf_now();
        write_at(&self.fh()?, part, pos).await?;
        {
            let mut m = self.metrics.borrow_mut();
            m.disk_ms += perf_now() - t;
            m.bytes += len;
        }
        s.borrow_mut().pos += len;
        self.meter.borrow_mut().add(len);
        self.ctx.on_bytes(len);
        Ok(())
    }

    /// Receives the response into the segment. Each connection keeps one write in flight while it
    /// reads the next piece, as Node's sockets kept filling while a write was pending; a piece's
    /// bytes count as downloaded (seg.pos) only once its write has landed.
    async fn pump_chunks(&self, w: &W, res: &mut Response) -> Result<()> {
        let mut pending: Option<PendingWrite> = None;
        let r = self.pump_pieces(w, res, &mut pending).await;
        let landed = match pending.take() {
            Some(p) => self.finish_write(p).await,
            None => Ok(()),
        };
        let check_end = match (r, landed) {
            (Ok(c), Ok(())) => c,
            (Ok(_), Err(e)) => return Err(e),
            // A failed disk write explains the failure better than what the network did next.
            (Err(_), Err(d)) if DISK_ERRORS.contains(&d.code()) => return Err(d),
            (Err(e), _) => return Err(e),
        };
        if check_end {
            if let Some(s) = w.seg() {
                let b = s.borrow();
                if b.end != INF && b.pos < b.end && !w.aborted() && !self.stopped.get() {
                    return Err(Error::new("Connection closed prematurely"));
                }
            }
        }
        Ok(())
    }

    /// Returns true when the stream ended (so a short segment is an error), false when this
    /// connection stopped early because its segment is done.
    async fn pump_pieces(&self, w: &W, res: &mut Response, pending: &mut Option<PendingWrite>) -> Result<bool> {
        let in_flight = |pending: &Option<PendingWrite>| pending.as_ref().map(|p| p.len).unwrap_or(0);
        while let Some(chunk) = res.chunk(Some(&w.abort)).await? {
            if w.aborted() || self.stopped.get() {
                break;
            }
            w.receiving.set(true);
            let mut chunk = chunk;
            while !chunk.is_empty() {
                let s = w.seg().ok_or_else(|| Error::new("No segment"))?;
                let room = {
                    let b = s.borrow();
                    b.end.saturating_sub(b.pos + in_flight(pending))
                };
                if room == 0 {
                    if !self.absorb_next(w) {
                        res.destroy();
                        return Ok(false);
                    }
                    continue;
                }
                let take = (chunk.len() as u64).min(room).min(MAX_PIECE as u64) as usize;
                let part = chunk.split_to(take);
                self.wait_limiters(part.len()).await;
                if let Some(p) = pending.take() {
                    self.finish_write(p).await?;
                }
                *pending = Some(self.start_write(w, part)?);
            }
            let s = w.seg().ok_or_else(|| Error::new("No segment"))?;
            let full = {
                let b = s.borrow();
                b.pos + in_flight(pending) >= b.end
            };
            if full && !self.absorb_next(w) {
                res.destroy();
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn start_write(&self, w: &W, part: Bytes) -> Result<PendingWrite> {
        let seg = w.seg().ok_or_else(|| Error::new("No segment"))?;
        let pos = seg.borrow().pos;
        let len = part.len() as u64;
        Ok(PendingWrite { task: super::spawn_write(&self.fh()?, part, pos), seg, len, t: perf_now() })
    }

    async fn finish_write(&self, p: PendingWrite) -> Result<()> {
        p.task.await.map_err(|e| Error::new(e.to_string()))??;
        {
            let mut m = self.metrics.borrow_mut();
            m.disk_ms += perf_now() - p.t;
            m.bytes += p.len;
        }
        p.seg.borrow_mut().pos += p.len;
        self.meter.borrow_mut().add(p.len);
        self.ctx.on_bytes(p.len);
        Ok(())
    }

    /// Connection reuse: continue the open stream into the adjacent segment if nobody has started it.
    fn absorb_next(&self, w: &W) -> bool {
        let Some(s) = w.seg() else { return false };
        let mut it = self.item.borrow_mut();
        let Some(segs) = it.segments.as_mut() else { return false };
        let end = s.borrow().end;
        let Some(idx) = segs.iter().position(|x| !Rc::ptr_eq(x, &s) && x.borrow().start == end) else { return false };
        let next = segs[idx].clone();
        {
            let n = next.borrow();
            if n.pos != n.start {
                return false;
            }
        }
        let owner = self.workers.borrow().iter().find(|x| !Rc::ptr_eq(x, w) && x.seg().is_some_and(|xs| Rc::ptr_eq(&xs, &next))).cloned();
        if let Some(o) = owner {
            if o.receiving.get() {
                return false;
            }
            o.abort.cancel();
        }
        s.borrow_mut().end = next.borrow().end;
        segs.remove(idx);
        true
    }

    fn emit_progress(&self) {
        self.emit(EngineEvent::Progress(self.stats()));
    }
}

/// `settings.connection.connectionRetries ?? 20`
fn retries_setting(v: &Value) -> f64 {
    if v.is_null() {
        20.0
    } else {
        js::num(v)
    }
}

/// `url.searchParams.set(name, value)`.
pub fn set_search_param(u: &mut url::Url, name: &str, value: &str) {
    let mut pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    match pairs.iter().position(|(k, _)| k == name) {
        Some(i) => {
            pairs[i].1 = value.to_string();
            let mut seen = false;
            pairs.retain(|(k, _)| {
                if k != name {
                    return true;
                }
                let keep = !seen;
                seen = true;
                keep
            });
        }
        None => pairs.push((name.to_string(), value.to_string())),
    }
    u.query_pairs_mut().clear().extend_pairs(pairs);
}

impl Engine for HttpDownload {
    fn start(self: Rc<Self>) {
        self.stopped.set(false);
        *self.fatal.borrow_mut() = None;
        *self.metrics.borrow_mut() = Metrics { t0: perf_now(), ..Default::default() };
        let a = self.clone();
        let b = self.clone();
        let mut timers = self.timers.borrow_mut();
        timers.push(interval(500, move || a.emit_progress()));
        timers.push(interval(3000, move || b.emit(EngineEvent::Persist)));
        drop(timers);
        tokio::task::spawn_local(self.run());
    }

    fn stop(&self) {
        self.stopped.set(true);
        for w in self.workers.borrow().iter() {
            w.abort.cancel();
        }
    }

    fn stats(&self) -> Value {
        let it = self.item.borrow();
        let done = it.segments_downloaded();
        let rate = self.meter.borrow_mut().rate();
        let eta = match it.size {
            Some(s) if s > 0 && rate > 0.0 => json!((s as f64 - done as f64) / rate),
            _ => Value::Null,
        };
        let connections: Vec<Value> = self
            .workers
            .borrow()
            .iter()
            .map(|w| {
                let s = w.seg();
                let (start, end, pos) = match &s {
                    Some(s) => {
                        let b = s.borrow();
                        (b.start, if b.end == INF { Value::Null } else { json!(b.end) }, b.pos)
                    }
                    None => (0, Value::Null, 0),
                };
                json!({ "id": w.id, "start": start, "end": end, "pos": pos, "receiving": w.receiving.get() })
            })
            .collect();
        json!({
            "downloaded": done,
            "size": it.size,
            "rate": rate,
            "eta": eta,
            "resumable": it.resumable,
            "connections": connections,
            "segments": it.segment_triples(),
        })
    }

    fn set_speed_limit(&self, kb: f64) {
        self.item.borrow_mut().speed_limit_kb = kb;
        self.limiter.borrow_mut().set_rate(if kb > 0.0 { kb * 1024.0 } else { 0.0 });
    }

    fn set_max_connections(&self, n: f64) {
        self.item.borrow_mut().max_connections = n;
        self.fill_connections();
    }

    fn item(&self) -> ItemRef {
        self.item.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_and_retry_after() {
        let r = parse_content_range(Some("bytes 10-19/100")).unwrap();
        assert_eq!((r.start, r.end, r.total), (10, 19, Some(100)));
        assert!(parse_content_range(Some("bytes 0-1/*")).unwrap().total.is_none());
        assert!(parse_content_range(Some("nonsense")).is_none());
        assert_eq!(retry_after_ms(Some("2")), 2000);
        assert_eq!(retry_after_ms(Some("9999")), 300000);
        assert_eq!(retry_after_ms(None), 0);
    }

    #[test]
    fn search_param_set_replaces() {
        let mut u = url::Url::parse("http://h/v?itag=1&range=0-1&x=2").unwrap();
        set_search_param(&mut u, "range", "5-9");
        assert_eq!(u.as_str(), "http://h/v?itag=1&range=5-9&x=2");
        let mut v = url::Url::parse("http://h/v?itag=1").unwrap();
        set_search_param(&mut v, "range", "0-9");
        assert_eq!(v.as_str(), "http://h/v?itag=1&range=0-9");
    }
}

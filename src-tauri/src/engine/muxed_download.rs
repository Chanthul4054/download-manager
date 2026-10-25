//! A download made of separate video and audio streams (YouTube/DASH adaptive formats), port of
//! engine/muxed-download.js. Each part is an ordinary multi-connection HttpDownload with its own
//! persisted segments; when both finish they are merged with ffmpeg into item.tempPath. Without
//! ffmpeg the audio is kept as a separate file next to the video (item.extraFiles).

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::ffmpeg::{find_ffmpeg, mux};
use super::http_download::HttpDownload;
use super::{interval, Ctx, Engine, EngineEvent, Meta, Sink};
use crate::error::{Error, Result};
use crate::item::{ExtraFile, ItemRef, INF};
use crate::js;
use crate::util::{extname, hostname, move_file, rm_force};

enum PartResult {
    Done,
    Stopped,
    Failed(Error),
}

pub struct MuxedDownload {
    me: RefCell<std::rc::Weak<MuxedDownload>>,
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    engines: RefCell<Vec<Rc<HttpDownload>>>,
    abort: CancellationToken,
    timers: RefCell<Vec<JoinHandle<()>>>,
}

impl MuxedDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<MuxedDownload> {
        let me = Rc::new(MuxedDownload {
            me: RefCell::new(std::rc::Weak::new()),
            item,
            ctx,
            sink,
            engines: RefCell::new(Vec::new()),
            abort: CancellationToken::new(),
            timers: RefCell::new(Vec::new()),
        });
        *me.me.borrow_mut() = Rc::downgrade(&me);
        me
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    fn part_item(&self, p: &ItemRef, i: usize) {
        let it = self.item.borrow();
        let mut p = p.borrow_mut();
        if p.temp_path.is_empty() {
            p.temp_path = format!("{}.part{}.{}", it.temp_path, i, p.ext.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| "bin".into()));
        }
        p.referer = it.referer.clone();
        // Only forward cookies to the page's own host (never e.g. youtube.com cookies to googlevideo.com).
        p.cookies = if hostname(&p.url) == hostname(&it.url) { it.cookies.clone() } else { String::new() };
        p.user_agent = it.user_agent.clone();
        p.max_connections = it.max_connections;
        p.speed_limit_kb = it.speed_limit_kb;
        if p.range_mode.is_none() && hostname(&p.url).to_lowercase().ends_with("googlevideo.com") {
            p.range_mode = Some("query".into());
        }
    }

    fn total_size(&self) -> Option<u64> {
        let it = self.item.borrow();
        let sizes: Vec<Option<u64>> = it.parts.iter().flatten().map(|p| p.borrow().size).collect();
        if sizes.iter().all(|s| s.is_some_and(|x| x > 0)) {
            Some(sizes.iter().map(|s| s.unwrap()).sum())
        } else {
            None
        }
    }

    /// Starts one part's engine; the receiver resolves when it completes, stops or fails.
    fn run_part(&self, p: ItemRef) -> oneshot::Receiver<PartResult> {
        let (tx, rx) = oneshot::channel();
        let tx = RefCell::new(Some(tx));
        let me = self.me.borrow().clone();
        let part = p.clone();
        let eng_cell: Rc<RefCell<std::rc::Weak<HttpDownload>>> = Rc::new(RefCell::new(std::rc::Weak::new()));
        let ec = eng_cell.clone();
        let sink: Sink = Rc::new(move |e| {
            let Some(m) = me.upgrade() else { return };
            let send = |r: PartResult| {
                if let Some(t) = tx.borrow_mut().take() {
                    let _ = t.send(r);
                }
            };
            match e {
                EngineEvent::Persist => m.emit(EngineEvent::Persist),
                EngineEvent::Complete => {
                    part.borrow_mut().done = true;
                    send(PartResult::Done);
                }
                EngineEvent::Stopped => send(PartResult::Stopped),
                EngineEvent::Failed(err) => {
                    // One stream failing makes the pair useless: stop the other one too.
                    let mine = ec.borrow().upgrade();
                    for x in m.engines.borrow().iter() {
                        if !mine.as_ref().is_some_and(|y| Rc::ptr_eq(x, y)) {
                            x.stop();
                        }
                    }
                    send(PartResult::Failed(err));
                }
                _ => {}
            }
        });
        let eng = HttpDownload::new(p, self.ctx.clone(), sink);
        *eng_cell.borrow_mut() = Rc::downgrade(&eng);
        self.engines.borrow_mut().push(eng.clone());
        eng.start();
        rx
    }

    async fn run(self: Rc<Self>, waits: Vec<oneshot::Receiver<PartResult>>, parts: Vec<ItemRef>) {
        let r: Result<Option<Error>> = async {
            let mut results = Vec::new();
            for w in waits {
                results.push(w.await.unwrap_or(PartResult::Stopped));
            }
            if self.abort.is_cancelled() {
                return Ok(None);
            }
            if let Some(PartResult::Failed(e)) = results.into_iter().find(|r| matches!(r, PartResult::Failed(_))) {
                return Ok(Some(e));
            }
            self.assemble(&parts).await?;
            let temp = self.item.borrow().temp_path.clone();
            let size = tokio::fs::metadata(&temp).await?.len();
            self.item.borrow_mut().size = Some(size);
            Ok(None)
        }
        .await;
        match r {
            Ok(None) if self.abort.is_cancelled() => self.done("stopped", None),
            Ok(None) => self.done("complete", None),
            Ok(Some(e)) => self.done("failed", Some(e)),
            Err(e) => self.done(if self.abort.is_cancelled() { "stopped" } else { "failed" }, Some(e)),
        }
    }

    async fn assemble(&self, parts: &[ItemRef]) -> Result<()> {
        let temp = self.item.borrow().temp_path.clone();
        if parts.len() == 1 {
            let src = parts[0].borrow().temp_path.clone();
            return move_file(&src, &temp).await;
        }
        let video = parts.iter().find(|p| p.borrow().role.as_deref() == Some("video")).unwrap_or(&parts[0]).clone();
        let audio = parts.iter().find(|p| !Rc::ptr_eq(p, &video)).cloned().ok_or_else(|| Error::new("No audio stream"))?;
        let configured = js::str_of(&self.ctx.store.s(&["videoPanel", "ffmpegPath"]));
        let (vt, at, aext) = {
            let v = video.borrow();
            let a = audio.borrow();
            (v.temp_path.clone(), a.temp_path.clone(), a.ext.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| "m4a".into()))
        };
        let Some(ffmpeg) = find_ffmpeg(&configured) else {
            // No merger available: deliver the video and keep the audio beside it.
            move_file(&vt, &temp).await?;
            let mut it = self.item.borrow_mut();
            let base = strip_ext(&it.file_name);
            it.extra_files = Some(vec![ExtraFile { temp: at, name: format!("{} (audio).{}", base, aext) }]);
            it.note = Some("FFmpeg was not found, so video and audio were saved as separate files.".into());
            return Ok(());
        };
        self.emit(EngineEvent::Status("Merging video and audio...".into()));
        let ext = {
            let e = extname(&self.item.borrow().file_name);
            if e.is_empty() { ".mkv".to_string() } else { e }
        };
        let out = format!("{}.mux{}", temp, ext);
        mux(&ffmpeg, &vt, &at, &out, &self.abort).await?;
        move_file(&out, &temp).await?;
        for p in parts {
            let t = p.borrow().temp_path.clone();
            rm_force(&t, false).await;
        }
        Ok(())
    }

    fn done(&self, kind: &str, err: Option<Error>) {
        for t in self.timers.borrow_mut().drain(..) {
            t.abort();
        }
        self.emit(EngineEvent::Progress(self.stats()));
        self.emit(EngineEvent::Persist);
        match kind {
            "failed" => self.emit(EngineEvent::Failed(err.unwrap_or_else(|| Error::new("Download failed")))),
            "complete" => self.emit(EngineEvent::Complete),
            _ => self.emit(EngineEvent::Stopped),
        }
    }
}

/// `name.replace(/\.[^.]+$/, '')`
fn strip_ext(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// Aggregates part progress into one segment map (parts laid end to end) for the UI.
pub fn muxed_stats(item: &ItemRef, engines: &[Rc<HttpDownload>]) -> Value {
    let parts = item.borrow().parts.clone().unwrap_or_default();
    let mut offset: u64 = 0;
    let mut downloaded = 0.0;
    let mut rate = 0.0;
    let mut segments = Vec::new();
    let mut connections: Vec<Value> = Vec::new();
    let off = |v: &Value, o: u64| if v.is_null() { Value::Null } else { json!(js::num(v) + o as f64) };
    for p in &parts {
        let eng = engines.iter().find(|e| Rc::ptr_eq(&e.item(), p));
        let st = match eng {
            Some(e) => e.stats(),
            None => {
                let pb = p.borrow();
                let sum: u64 = pb.segments.iter().flatten().map(|s| {
                    let s = s.borrow();
                    s.pos.saturating_sub(s.start)
                }).sum();
                let d = if sum > 0 { sum } else if pb.done { pb.size.unwrap_or(0) } else { 0 };
                json!({ "downloaded": d, "rate": 0, "connections": [], "segments": pb.segment_triples() })
            }
        };
        downloaded += js::num(js::get(&st, "downloaded"));
        rate += js::num(js::get(&st, "rate"));
        let segs = st["segments"].as_array().cloned().unwrap_or_default();
        for s in &segs {
            segments.push(json!([js::num(&s[0]) + offset as f64, off(&s[1], offset), js::num(&s[2]) + offset as f64]));
        }
        let (done, size, role) = {
            let pb = p.borrow();
            (pb.done, pb.size, pb.role.clone())
        };
        if done && segs.is_empty() {
            if let Some(sz) = size.filter(|s| *s > 0) {
                segments.push(json!([offset, offset + sz, offset + sz]));
            }
        }
        for c in st["connections"].as_array().cloned().unwrap_or_default() {
            let mut c = c;
            let id = connections.len() + 1;
            let start = js::num(&c["start"]) + offset as f64;
            let end = off(&c["end"], offset);
            let pos = js::num(&c["pos"]) + offset as f64;
            c["id"] = json!(id);
            c["start"] = json!(start);
            c["end"] = end;
            c["pos"] = json!(pos);
            c["part"] = json!(role);
            connections.push(c);
        }
        offset += size.unwrap_or(0);
    }
    let size = if parts.iter().all(|p| p.borrow().size.is_some_and(|s| s > 0)) { Some(offset) } else { None };
    let _ = INF;
    json!({
        "downloaded": downloaded,
        "size": size,
        "rate": rate,
        "eta": match size { Some(s) if s > 0 && rate > 0.0 => json!((s as f64 - downloaded) / rate), _ => Value::Null },
        "resumable": true,
        "connections": connections,
        "segments": segments,
    })
}

impl Engine for MuxedDownload {
    fn start(self: Rc<Self>) {
        self.item.borrow_mut().resumable = Some(true);
        let a = self.clone();
        self.timers.borrow_mut().push(interval(500, move || a.emit(EngineEvent::Progress(a.stats()))));
        let parts = self.item.borrow().parts.clone().unwrap_or_default();
        for (i, p) in parts.iter().enumerate() {
            self.part_item(p, i);
        }
        let size = self.total_size();
        self.emit(EngineEvent::Meta(Meta { size, resumable: true, content_type: String::new(), file_name: None }));
        self.emit(EngineEvent::Status("Receiving data...".into()));
        let pending: Vec<ItemRef> = parts.iter().filter(|p| !p.borrow().done).cloned().collect();
        let waits: Vec<_> = pending.into_iter().map(|p| self.run_part(p)).collect();
        tokio::task::spawn_local(self.run(waits, parts));
    }

    fn stop(&self) {
        self.abort.cancel();
        for e in self.engines.borrow().iter() {
            e.stop();
        }
    }

    fn stats(&self) -> Value {
        muxed_stats(&self.item, &self.engines.borrow())
    }

    fn set_speed_limit(&self, kb: f64) {
        self.item.borrow_mut().speed_limit_kb = kb;
        for e in self.engines.borrow().iter() {
            e.set_speed_limit(kb);
        }
    }

    fn set_max_connections(&self, n: f64) {
        self.item.borrow_mut().max_connections = n;
        for e in self.engines.borrow().iter() {
            e.set_max_connections(n);
        }
    }

    fn item(&self) -> ItemRef {
        self.item.clone()
    }
}

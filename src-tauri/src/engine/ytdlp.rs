//! Video pages through yt-dlp (port of engine/ytdlp.js).

use std::cell::{Cell, RefCell};
use std::process::Stdio;
use std::rc::Rc;

use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::io::AsyncReadExt;
use tokio::task::JoinHandle;

use super::ffmpeg::{command, find_ffmpeg, std_command};
use super::net::{NetContext, ReqOpts};
use super::{interval, Ctx, Engine, EngineEvent, Sink};
use crate::error::{Error, Result};
use crate::item::ItemRef;
use crate::js;
use crate::util::{extname, join, move_file};

/// Sites handed to yt-dlp instead of being downloaded as plain files.
static PAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^https?://(?:(?:www|m|music)\.)?(?:youtube\.com/(?:watch\?|shorts/|live/|embed/)|youtu\.be/)").unwrap()
});

pub fn is_video_page(url: &str) -> bool {
    PAGE_RE.is_match(url)
}

pub fn exe() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn release() -> Option<&'static str> {
    if cfg!(windows) {
        Some("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        Some("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos")
    } else if cfg!(target_os = "linux") {
        Some("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux")
    } else {
        None
    }
}

/// Configured path, then the copy OpenDM installed in bin_dir, then PATH.
pub fn find_ytdlp(configured: &str, bin_dir: &std::path::Path) -> Option<String> {
    if !configured.is_empty() && std::path::Path::new(configured).exists() {
        return Some(configured.to_string());
    }
    let own = bin_dir.join(exe());
    if own.exists() {
        return Some(own.to_string_lossy().into_owned());
    }
    let ok = std_command(exe()).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    ok.then(|| exe().to_string())
}

/// Downloads the latest official yt-dlp release into bin_dir.
pub async fn install_ytdlp(net: &NetContext, bin_dir: &std::path::Path) -> Result<String> {
    let url = release().ok_or_else(|| Error::new("No yt-dlp build for this platform"))?;
    let body = net.fetch_buffer(url, &ReqOpts { max_bytes: Some(80 * 1024 * 1024), timeout_sec: Some(60.0), ..Default::default() }).await?.body;
    if body.len() < 1024 * 1024 {
        return Err(Error::new("Downloaded yt-dlp looks incomplete"));
    }
    tokio::fs::create_dir_all(bin_dir).await?;
    let dest = bin_dir.join(exe());
    let tmp = std::path::PathBuf::from(format!("{}.new", dest.display()));
    tokio::fs::write(&tmp, &body).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).await?;
    }
    tokio::fs::rename(&tmp, &dest).await?;
    Ok(dest.to_string_lossy().into_owned())
}

/// yt-dlp needs a JavaScript runtime to solve YouTube's player challenges (otherwise formats are
/// missing or throttled). The Electron build lent it its own Node; this build points yt-dlp at a
/// Node.js on PATH when there is one, and otherwise lets yt-dlp use its default (Deno).
fn js_runtime_args() -> Vec<String> {
    match which::which(if cfg!(windows) { "node.exe" } else { "node" }) {
        Ok(p) => vec!["--js-runtimes".into(), format!("node:{}", p.display())],
        Err(_) => vec![],
    }
}

async fn run(bin: &str, args: &[String]) -> Result<String> {
    let mut all = js_runtime_args();
    all.extend(args.iter().cloned());
    let out = command(bin).args(&all).stdin(Stdio::null()).output().await?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let msg = last_error(&String::from_utf8_lossy(&out.stderr));
    let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into());
    Err(Error::new(if msg.is_empty() { format!("yt-dlp exited with {}", code) } else { msg }))
}

static NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
static ERROR_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ERROR:\s*").unwrap());

fn last_error(text: &str) -> String {
    let lines: Vec<&str> = NEWLINE.split(text).filter(|l| !l.is_empty()).collect();
    let pick = lines.iter().rev().find(|l| l.starts_with("ERROR:")).or(lines.first()).copied().unwrap_or("");
    let s = ERROR_PREFIX.replace(pick, "");
    crate::util::js_slice(&s, 0, 400)
}

fn proxy_arg(settings: &Value) -> Vec<String> {
    let p = js::get(settings, "proxy");
    if js::s(js::get(p, "mode")) != "manual" {
        return vec![];
    }
    let socks = js::get(p, "socks");
    let https = js::get(p, "https");
    let s = if js::truthy(js::get(socks, "enabled")) && js::truthy(js::get(socks, "host")) {
        format!(
            "socks{}://{}:{}",
            if js::num(js::get(socks, "version")) == 4.0 { 4 } else { 5 },
            js::str_of(js::get(socks, "host")),
            js::str_of(js::get(socks, "port"))
        )
    } else if js::truthy(js::get(https, "enabled")) && js::truthy(js::get(https, "host")) {
        format!("http://{}:{}", js::str_of(js::get(https, "host")), js::str_of(js::get(https, "port")))
    } else {
        String::new()
    };
    if s.is_empty() {
        vec![]
    } else {
        vec!["--proxy".into(), s]
    }
}

/// Title, duration and the video heights available, for the quality picker.
pub async fn video_info(bin: &str, url: &str, settings: &Value) -> Result<Value> {
    let mut args: Vec<String> = vec!["-J".into(), "--no-playlist".into(), "--no-warnings".into()];
    args.extend(proxy_arg(settings));
    args.push(url.into());
    let out = run(bin, &args).await?;
    let j: Value = serde_json::from_str(&out)?;
    let formats = j["formats"].as_array().cloned().unwrap_or_default();
    let vcodec = |f: &Value| js::str_of(&f["vcodec"]);
    let height = |f: &Value| js::num(&f["height"]);
    let mut heights: Vec<f64> = Vec::new();
    for f in &formats {
        let vc = vcodec(f);
        let h = height(f);
        if js::truthy(&f["vcodec"]) && vc != "none" && h > 0.0 && !heights.contains(&h) {
            heights.push(h);
        }
    }
    heights.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let n = |f: Option<&Value>| -> f64 {
        f.map(|f| {
            let a = js::num(&f["filesize"]);
            if a > 0.0 {
                a
            } else {
                let b = js::num(&f["filesize_approx"]);
                if b > 0.0 { b } else { 0.0 }
            }
        })
        .unwrap_or(0.0)
    };
    let size = |h: f64| -> Value {
        let mut vids: Vec<&Value> = formats.iter().filter(|f| vcodec(f) != "none" && height(f) > 0.0 && height(f) <= h).collect();
        vids.sort_by(|a, b| {
            (height(b) - height(a))
                .partial_cmp(&0.0)
                .unwrap()
                .then((js::num(&b["tbr"]).max(0.0) - js::num(&a["tbr"]).max(0.0)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal))
        });
        let mut auds: Vec<&Value> = formats.iter().filter(|f| vcodec(f) == "none" && js::str_of(&f["acodec"]) != "none").collect();
        auds.sort_by(|x, y| (js::num(&y["abr"]).max(0.0) - js::num(&x["abr"]).max(0.0)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        let total = n(vids.first().copied()) + n(auds.first().copied());
        if total > 0.0 { json!(total) } else { Value::Null }
    };
    let mut sizes = serde_json::Map::new();
    for h in &heights {
        sizes.insert(js::fmt_num(*h), size(*h));
    }
    Ok(json!({
        "title": js::str_of(&j["title"]),
        "duration": if js::truthy(&j["duration"]) { j["duration"].clone() } else { Value::Null },
        "heights": heights,
        "sizes": sizes,
        "extractor": js::str_of(&j["extractor_key"]),
    }))
}

pub fn format_selector(q: &str) -> String {
    if q == "audio" {
        return "ba[ext=m4a]/ba/b".into();
    }
    let h = js::num(&Value::String(q.to_string()));
    if h > 0.0 {
        let h = js::fmt_num(h);
        return format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b");
    }
    "bv*+ba/b".into()
}

/// Downloads a video page through yt-dlp. Pausing kills the process and keeps its .part files;
/// resuming reruns the same command, which continues them. The finished file is moved to
/// item.tempPath.
pub struct YtDlpDownload {
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    rate: Cell<f64>,
    eta: Cell<Option<f64>>,
    /// Bytes of streams already finished in this run.
    done: Cell<f64>,
    cur: Cell<(f64, f64)>,
    stopped: Cell<bool>,
    finished: Cell<bool>,
    pid: Cell<Option<u32>>,
    timers: RefCell<Vec<JoinHandle<()>>>,
}

impl YtDlpDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<YtDlpDownload> {
        Rc::new(YtDlpDownload {
            item,
            ctx,
            sink,
            rate: Cell::new(0.0),
            eta: Cell::new(None),
            done: Cell::new(0.0),
            cur: Cell::new((0.0, 0.0)),
            stopped: Cell::new(false),
            finished: Cell::new(false),
            pid: Cell::new(None),
            timers: RefCell::new(Vec::new()),
        })
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    fn work_dir(&self) -> String {
        format!("{}.ytdlp", self.item.borrow().temp_path)
    }

    fn args(&self, ffmpeg: Option<&str>) -> Vec<String> {
        let s = self.ctx.store.settings();
        let it = self.item.borrow();
        let q = it.ytdlp.as_ref().map(|y| js::str_of(js::get(y, "quality"))).filter(|q| !q.is_empty()).unwrap_or_else(|| "best".into());
        let mc = if it.max_connections != 0.0 { it.max_connections } else { js::num_or(&s["connection"]["maxConnections"], 4.0) };
        let mut a: Vec<String> = vec![
            "--newline", "--no-playlist", "--no-mtime", "--continue", "--no-warnings", "--no-colors",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        a.push("-o".into());
        a.push(join(&self.work_dir_of(&it.temp_path), "media.%(ext)s"));
        a.push("-f".into());
        a.push(format_selector(&q));
        // Highest resolution first; at equal resolution prefer MP4/M4A so the result is an .mp4.
        a.push("-S".into());
        a.push("res,fps,ext:mp4:m4a".into());
        // --print implies --quiet; --progress keeps the progress lines coming.
        a.push("--progress".into());
        a.push("-N".into());
        a.push(js::fmt_num(16f64.min(1f64.max(mc))));
        a.push("--progress-template".into());
        a.push("download:ODMP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s".into());
        a.push("--print".into());
        a.push("after_move:ODMF %(filepath)s".into());
        a.extend(proxy_arg(&s));
        if q != "audio" {
            a.push("--merge-output-format".into());
            a.push("mp4/mkv".into());
        }
        if let Some(f) = ffmpeg {
            a.push("--ffmpeg-location".into());
            a.push(f.into());
        }
        let kb = if it.speed_limit_kb != 0.0 {
            it.speed_limit_kb
        } else if js::truthy(&s["speedLimiter"]["enabled"]) {
            js::num(&s["speedLimiter"]["kbps"])
        } else {
            0.0
        };
        if kb > 0.0 {
            a.push("--limit-rate".into());
            a.push(format!("{}K", js::fmt_num(kb)));
        }
        a.push(it.url.clone());
        a
    }

    fn work_dir_of(&self, temp: &str) -> String {
        format!("{}.ytdlp", temp)
    }

    fn on_progress(&self, f: &[&str]) {
        let n = |v: Option<&&str>| -> f64 {
            match v {
                None => 0.0,
                Some(&"NA") => 0.0,
                Some(s) => {
                    let x = js::num(&Value::String(s.to_string()));
                    if x.is_nan() { 0.0 } else { x }
                }
            }
        };
        let g = n(f.first());
        let t = {
            let a = n(f.get(1));
            if a != 0.0 { a } else { n(f.get(2)) }
        };
        let (cg, ct) = self.cur.get();
        // yt-dlp fetches video then audio; a drop in bytes means the next stream started.
        if g < cg * 0.5 && ct != 0.0 {
            self.done.set(self.done.get() + ct);
        }
        self.cur.set((g, t));
        self.rate.set(n(f.get(3)));
        let e = n(f.get(4));
        self.eta.set(if e != 0.0 { Some(e) } else { None });
        self.ctx.on_bytes(0);
    }

    fn finish(&self, kind: &str, err: Option<Error>) {
        if self.finished.replace(true) {
            return;
        }
        for t in self.timers.borrow_mut().drain(..) {
            t.abort();
        }
        self.rate.set(0.0);
        self.emit(EngineEvent::Progress(self.stats()));
        self.emit(EngineEvent::Persist);
        match kind {
            "failed" => self.emit(EngineEvent::Failed(err.unwrap_or_else(|| Error::new("Download failed")))),
            "complete" => self.emit(EngineEvent::Complete),
            _ => self.emit(EngineEvent::Stopped),
        }
    }

    async fn run(self: Rc<Self>, bin: String, ffmpeg: Option<String>) {
        if let Err(e) = tokio::fs::create_dir_all(self.work_dir()).await {
            return self.finish("failed", Some(e.into()));
        }
        self.item.borrow_mut().resumable = Some(true);
        self.emit(EngineEvent::Status("Reading video information...".into()));
        let mut all = js_runtime_args();
        all.extend(self.args(ffmpeg.as_deref()));
        let child = command(&bin).args(&all).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return self.finish("failed", Some(e.into())),
        };
        self.pid.set(child.id());
        let final_path: RefCell<Option<String>> = RefCell::new(None);
        let err_text: RefCell<String> = RefCell::new(String::new());
        let on_line = |line: &str| {
            if let Some(r) = line.strip_prefix("ODMP ") {
                let parts: Vec<&str> = r.split_whitespace().collect();
                self.on_progress(&parts);
            } else if let Some(r) = line.strip_prefix("ODMF ") {
                *final_path.borrow_mut() = Some(r.trim().to_string());
            } else if line.starts_with("[Merger]") {
                self.emit(EngineEvent::Status("Merging video and audio...".into()));
            } else if line.starts_with("[download] Destination") {
                self.emit(EngineEvent::Status("Receiving data...".into()));
            }
        };
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        // Progress can arrive on either stream depending on yt-dlp's quiet mode.
        let read_out = async {
            let mut buf = String::new();
            let mut b = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut b).await {
                if n == 0 {
                    break;
                }
                buf.push_str(&String::from_utf8_lossy(&b[..n]));
                for line in drain_lines(&mut buf) {
                    on_line(&line);
                }
            }
        };
        let read_err = async {
            let mut buf = String::new();
            let mut b = [0u8; 8192];
            while let Ok(n) = stderr.read(&mut b).await {
                if n == 0 {
                    break;
                }
                buf.push_str(&String::from_utf8_lossy(&b[..n]));
                for line in drain_lines(&mut buf) {
                    on_line(&line);
                    if !line.starts_with("ODMP ") {
                        let mut e = err_text.borrow_mut();
                        e.push_str(&line);
                        e.push('\n');
                        if e.len() > 6000 {
                            *e = super::ffmpeg::tail(&e, 6000);
                        }
                    }
                }
            }
        };
        let (_, _, status) = tokio::join!(read_out, read_err, child.wait());
        self.pid.set(None);
        if self.stopped.get() {
            return self.finish("stopped", None);
        }
        let code = match &status {
            Ok(s) => s.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into()),
            Err(_) => "null".into(),
        };
        let fin = final_path.borrow().clone();
        let ok = status.as_ref().is_ok_and(|s| s.success());
        let Some(fin) = fin.filter(|_| ok) else {
            let msg = last_error(&err_text.borrow());
            return self.finish("failed", Some(Error::new(if msg.is_empty() { format!("yt-dlp exited with {}", code) } else { msg })));
        };
        let r: Result<()> = async {
            let ext = extname(&fin);
            {
                let mut it = self.item.borrow_mut();
                if !ext.is_empty() && extname(&it.file_name).to_lowercase() != ext.to_lowercase() {
                    let base = match it.file_name.rfind('.') {
                        Some(i) => it.file_name[..i].to_string(),
                        None => it.file_name.clone(),
                    };
                    it.file_name = base + &ext;
                }
            }
            let temp = self.item.borrow().temp_path.clone();
            move_file(&fin, &temp).await?;
            let _ = tokio::fs::remove_dir_all(self.work_dir()).await;
            let size = tokio::fs::metadata(&temp).await?.len();
            self.item.borrow_mut().size = Some(size);
            self.done.set(size as f64);
            self.cur.set((0.0, 0.0));
            Ok(())
        }
        .await;
        match r {
            Ok(()) => self.finish("complete", None),
            Err(e) => self.finish("failed", Some(e)),
        }
    }
}

/// Removes and returns the complete lines (split on \r or \n) at the start of `buf`.
fn drain_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(i) = buf.find(['\r', '\n']) {
        let line = buf[..i].trim().to_string();
        buf.drain(..=i);
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

impl Engine for YtDlpDownload {
    fn start(self: Rc<Self>) {
        let a = self.clone();
        self.timers.borrow_mut().push(interval(500, move || a.emit(EngineEvent::Progress(a.stats()))));
        let s = self.ctx.store.settings();
        let bin = find_ytdlp(&js::str_of(&s["videoPanel"]["ytdlpPath"]), &self.ctx.bin_dir);
        let Some(bin) = bin else {
            return self.finish("failed", Some(Error::new("yt-dlp is not installed. Install it in Options → Video panel.")));
        };
        let ffmpeg = find_ffmpeg(&js::str_of(&s["videoPanel"]["ffmpegPath"]));
        tokio::task::spawn_local(self.run(bin, ffmpeg));
    }

    fn stop(&self) {
        self.stopped.set(true);
        let Some(pid) = self.pid.get() else { return };
        // yt-dlp may be running ffmpeg as a child: end the whole tree.
        if cfg!(windows) {
            let _ = std_command("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        } else {
            let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).spawn();
        }
    }

    fn stats(&self) -> Value {
        let (g, t) = self.cur.get();
        let downloaded = self.done.get() + g;
        let size = if t != 0.0 { Some(self.done.get() + t) } else { self.item.borrow().size.filter(|s| *s > 0).map(|s| s as f64) };
        json!({
            "downloaded": downloaded,
            "size": size,
            "estimatedSize": size,
            "rate": self.rate.get(),
            "eta": self.eta.get(),
            "resumable": true,
            "connections": [],
            "segments": match size { Some(s) if s != 0.0 => json!([[0, s, downloaded]]), _ => json!([]) },
        })
    }

    fn set_speed_limit(&self, kb: f64) {
        // Applies on next start.
        self.item.borrow_mut().speed_limit_kb = kb;
    }

    fn set_max_connections(&self, n: f64) {
        self.item.borrow_mut().max_connections = n;
    }

    fn item(&self) -> ItemRef {
        self.item.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_page_detection_and_quality_selectors() {
        for u in ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://m.youtube.com/shorts/abc", "https://music.youtube.com/watch?v=abc"] {
            assert!(is_video_page(u), "{u}");
        }
        for u in ["https://www.youtube.com/", "https://example.com/watch?v=abc", "https://notyoutube.com/watch?v=1"] {
            assert!(!is_video_page(u), "{u}");
        }
        assert_eq!(format_selector("720"), "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b");
        assert_eq!(format_selector("audio"), "ba[ext=m4a]/ba/b");
        assert_eq!(format_selector("best"), "bv*+ba/b");
    }

    #[test]
    fn lines_split_on_cr_and_lf() {
        let mut b = String::from("a\r\nb\rc");
        assert_eq!(drain_lines(&mut b), vec!["a", "b"]);
        assert_eq!(b, "c");
    }
}

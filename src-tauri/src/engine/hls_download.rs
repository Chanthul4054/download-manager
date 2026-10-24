//! HLS (m3u8) download (port of engine/hls-download.js): fetches media segments in parallel,
//! decrypts AES-128 and concatenates them (plus any init map) into one file. Completed segment
//! indexes persist.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::limiter::{take_all, LimiterRef, RateLimiter, SpeedMeter};
use super::net::{set_header, ReqOpts};
use super::{interval, open, sleep_ms, Ctx, Engine, EngineEvent, Meta, Sink};
use crate::error::{Error, Result};
use crate::item::ItemRef;
use crate::js;

#[derive(Debug, Clone)]
pub struct Key {
    pub method: String,
    pub uri: Option<String>,
    pub iv: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub uri: String,
    pub duration: f64,
    pub seq: u64,
    pub key: Option<Key>,
}

#[derive(Debug, Clone)]
pub struct MapRef {
    pub uri: String,
    pub range: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Variant {
    pub uri: String,
    pub bandwidth: f64,
    pub resolution: String,
    pub codecs: String,
}

#[derive(Debug, Clone, Default)]
pub struct Playlist {
    pub variants: Option<Vec<Variant>>,
    pub segments: Vec<Segment>,
    pub map: Option<MapRef>,
    pub end_list: bool,
    pub duration: f64,
}

impl Variant {
    pub fn to_value(&self) -> Value {
        json!({ "uri": self.uri, "bandwidth": self.bandwidth, "resolution": self.resolution, "codecs": self.codecs })
    }
}

static ATTRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Z0-9-]+)=("[^"]*"|[^,]*)"#).unwrap());
static LINE_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());

fn parse_attrs(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for m in ATTRS.captures_iter(s) {
        let v = m[2].strip_prefix('"').unwrap_or(&m[2]);
        let v = v.strip_suffix('"').unwrap_or(v);
        out.insert(m[1].to_string(), v.to_string());
    }
    out
}

fn resolve(uri: &str, base: &str) -> Result<String> {
    let b = url::Url::parse(base)?;
    Ok(b.join(uri)?.to_string())
}

/// Parses an HLS playlist: variants for a master playlist, or segments/map/endList for media.
pub fn parse_playlist(text: &str, base_url: &str) -> Result<Playlist> {
    let lines: Vec<&str> = LINE_SPLIT.split(text).map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if !lines.first().is_some_and(|l| l.starts_with("#EXTM3U")) {
        return Err(Error::new("Not an HLS playlist"));
    }
    let mut variants = Vec::new();
    let mut pl = Playlist::default();
    let mut key: Option<Key> = None;
    let mut seq: u64 = 0;
    let mut pending_inf: Option<f64> = None;
    let mut pending_variant: Option<HashMap<String, String>> = None;
    for line in lines {
        if let Some(r) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant = Some(parse_attrs(r));
        } else if let Some(r) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            let n = js::parse_int(r);
            seq = if n.is_finite() && n > 0.0 { n as u64 } else { 0 };
        } else if let Some(r) = line.strip_prefix("#EXT-X-KEY:") {
            let a = parse_attrs(r);
            let method = a.get("METHOD").cloned().unwrap_or_default();
            key = if method == "NONE" {
                None
            } else {
                let uri = match a.get("URI").filter(|u| !u.is_empty()) {
                    Some(u) => Some(resolve(u, base_url)?),
                    None => None,
                };
                Some(Key { method, uri, iv: a.get("IV").filter(|v| !v.is_empty()).cloned() })
            };
        } else if let Some(r) = line.strip_prefix("#EXT-X-MAP:") {
            let a = parse_attrs(r);
            let uri = a.get("URI").cloned().unwrap_or_else(|| "undefined".into());
            pl.map = Some(MapRef { uri: resolve(&uri, base_url)?, range: a.get("BYTERANGE").filter(|v| !v.is_empty()).cloned() });
        } else if let Some(r) = line.strip_prefix("#EXTINF:") {
            let d = js::parse_float(r);
            pending_inf = Some(if d.is_nan() { 0.0 } else { d });
        } else if line.starts_with("#EXT-X-ENDLIST") {
            pl.end_list = true;
        } else if !line.starts_with('#') {
            let uri = resolve(line, base_url)?;
            if let Some(v) = pending_variant.take() {
                let bw = js::num(&Value::String(v.get("BANDWIDTH").cloned().unwrap_or_default()));
                variants.push(Variant {
                    uri,
                    bandwidth: if bw.is_nan() { 0.0 } else { bw },
                    resolution: v.get("RESOLUTION").cloned().unwrap_or_default(),
                    codecs: v.get("CODECS").cloned().unwrap_or_default(),
                });
            } else {
                let d = pending_inf.take().unwrap_or(0.0);
                pl.segments.push(Segment { uri, duration: d, seq, key: key.clone() });
                pl.duration += d;
                seq += 1;
            }
        }
    }
    if !variants.is_empty() {
        variants.sort_by(|a, b| b.bandwidth.partial_cmp(&a.bandwidth).unwrap_or(std::cmp::Ordering::Equal));
        return Ok(Playlist { variants: Some(variants), ..Default::default() });
    }
    Ok(pl)
}

pub struct HlsDownload {
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    meter: RefCell<SpeedMeter>,
    limiter: LimiterRef,
    abort: CancellationToken,
    keys: RefCell<HashMap<String, Vec<u8>>>,
    /// In-flight segment index → bytes received so far (insertion-ordered like a JS Map).
    active: RefCell<Vec<(usize, u64)>>,
    playlist: RefCell<Option<Playlist>>,
    timers: RefCell<Vec<JoinHandle<()>>>,
    finished: Cell<bool>,
}

fn hls_get(item: &ItemRef, key: &str) -> Value {
    item.borrow().hls.as_ref().map(|h| js::get(h, key).clone()).unwrap_or(Value::Null)
}

fn hls_set(item: &ItemRef, key: &str, v: Value) {
    let mut it = item.borrow_mut();
    let h = it.hls.get_or_insert_with(|| json!({}));
    *js::get_mut(h, key) = v;
}

impl HlsDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<HlsDownload> {
        let kb = item.borrow().speed_limit_kb;
        Rc::new(HlsDownload {
            item,
            ctx,
            sink,
            meter: RefCell::new(SpeedMeter::default()),
            limiter: RateLimiter::shared(if kb > 0.0 { kb * 1024.0 } else { 0.0 }),
            abort: CancellationToken::new(),
            keys: RefCell::new(HashMap::new()),
            active: RefCell::new(Vec::new()),
            playlist: RefCell::new(None),
            timers: RefCell::new(Vec::new()),
            finished: Cell::new(false),
        })
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    fn headers(&self) -> Vec<(String, String)> {
        let it = self.item.borrow();
        let mut h = Vec::new();
        if !it.referer.is_empty() {
            set_header(&mut h, "Referer", &it.referer);
        }
        if !it.cookies.is_empty() {
            set_header(&mut h, "Cookie", &it.cookies);
        }
        if !it.user_agent.is_empty() {
            set_header(&mut h, "User-Agent", &it.user_agent);
        }
        h
    }

    async fn fetch(&self, url: &str, extra: &[(String, String)]) -> Result<super::net::Fetched> {
        let mut headers = self.headers();
        for (k, v) in extra {
            set_header(&mut headers, k, v);
        }
        let opts = ReqOpts { headers, signal: Some(self.abort.clone()), max_bytes: Some(512 * 1024 * 1024), ..Default::default() };
        self.ctx.net.fetch_buffer(url, &opts).await
    }

    async fn resolve_playlist(&self) -> Result<Playlist> {
        let media = hls_get(&self.item, "mediaUrl");
        let mut url = if js::truthy(&media) { js::str_of(&media) } else { self.item.borrow().url.clone() };
        let f = self.fetch(&url, &[]).await?;
        let mut pl = parse_playlist(&String::from_utf8_lossy(&f.body), &f.url)?;
        if let Some(variants) = &pl.variants {
            let want = js::str_of(&hls_get(&self.item, "variant"));
            let v = variants.iter().find(|x| x.uri == want).unwrap_or(&variants[0]);
            url = v.uri.clone();
            let f = self.fetch(&url, &[]).await?;
            pl = parse_playlist(&String::from_utf8_lossy(&f.body), &f.url)?;
        }
        hls_set(&self.item, "mediaUrl", Value::String(url));
        Ok(pl)
    }

    fn seg_dir(&self) -> String {
        format!("{}.segs", self.item.borrow().temp_path)
    }

    async fn run(self: Rc<Self>) {
        let r: Result<()> = async {
            self.emit(EngineEvent::Status("Reading playlist...".into()));
            let pl = self.resolve_playlist().await?;
            if pl.segments.is_empty() {
                return Err(Error::new("Playlist has no segments"));
            }
            let total = pl.segments.len();
            let duration = pl.duration;
            *self.playlist.borrow_mut() = Some(pl);
            hls_set(&self.item, "total", json!(total));
            if !js::truthy(&hls_get(&self.item, "done")) {
                hls_set(&self.item, "done", json!([]));
            }
            if !js::truthy(&hls_get(&self.item, "bytes")) {
                hls_set(&self.item, "bytes", json!(0));
            }
            self.item.borrow_mut().resumable = Some(true);
            let _ = duration;
            self.emit(EngineEvent::Meta(Meta { size: None, resumable: true, content_type: "video/mp2t".into(), file_name: None }));
            tokio::fs::create_dir_all(self.seg_dir()).await?;
            let mut done: Vec<u64> = hls_get(&self.item, "done").as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
            let queue: RefCell<std::collections::VecDeque<usize>> = RefCell::new((0..total).filter(|i| !done.contains(&(*i as u64))).collect());
            self.emit(EngineEvent::Status("Receiving data...".into()));
            let (mc, url) = {
                let it = self.item.borrow();
                (it.max_connections, it.url.clone())
            };
            let n = 1f64.max(16f64.min(if mc != 0.0 && !mc.is_nan() { mc } else { (self.ctx.max_conn_for)(&url) })) as usize;
            let done_cell = RefCell::new(std::mem::take(&mut done));
            let worker = || async {
                loop {
                    if self.abort.is_cancelled() {
                        return Ok(());
                    }
                    let Some(i) = queue.borrow_mut().pop_front() else { return Ok(()) };
                    self.fetch_segment(i).await?;
                    let list = {
                        let mut d = done_cell.borrow_mut();
                        if !d.contains(&(i as u64)) {
                            d.push(i as u64);
                        }
                        json!(*d)
                    };
                    hls_set(&self.item, "done", list);
                }
            };
            let workers: Vec<_> = (0..n).map(|_| worker()).collect();
            first_error(workers).await?;
            if self.abort.is_cancelled() {
                return Err(Error::new("Stopped"));
            }
            self.emit(EngineEvent::Status("Assembling file...".into()));
            self.assemble().await?;
            let temp = self.item.borrow().temp_path.clone();
            let size = tokio::fs::metadata(&temp).await?.len();
            self.item.borrow_mut().size = Some(size);
            Ok(())
        }
        .await;
        match r {
            Ok(()) => self.done("complete", None),
            Err(e) => self.done(if self.abort.is_cancelled() { "stopped" } else { "failed" }, Some(e)),
        }
    }

    async fn key_for(&self, seg: &Segment) -> Result<Option<(Vec<u8>, [u8; 16])>> {
        let Some(k) = &seg.key else { return Ok(None) };
        if k.method != "AES-128" {
            return Err(Error::new(format!("Unsupported HLS encryption: {}", k.method)));
        }
        let uri = k.uri.clone().unwrap_or_default();
        if !self.keys.borrow().contains_key(&uri) {
            let body = self.fetch(&uri, &[]).await?.body;
            self.keys.borrow_mut().insert(uri.clone(), body);
        }
        let iv = match &k.iv {
            Some(iv) => {
                let h = iv.trim_start_matches("0x").trim_start_matches("0X");
                let h = format!("{:0>32}", h);
                let mut b = [0u8; 16];
                for (i, x) in b.iter_mut().enumerate() {
                    *x = u8::from_str_radix(h.get(i * 2..i * 2 + 2).unwrap_or("00"), 16).unwrap_or(0);
                }
                b
            }
            None => {
                let mut b = [0u8; 16];
                b[12..].copy_from_slice(&(seg.seq as u32).to_be_bytes());
                b
            }
        };
        Ok(Some((self.keys.borrow()[&uri].clone(), iv)))
    }

    fn set_active(&self, i: usize, v: Option<u64>) {
        let mut a = self.active.borrow_mut();
        match (a.iter().position(|x| x.0 == i), v) {
            (Some(p), Some(v)) => a[p].1 = v,
            (None, Some(v)) => a.push((i, v)),
            (Some(p), None) => {
                a.remove(p);
            }
            (None, None) => {}
        }
    }

    async fn fetch_segment(&self, i: usize) -> Result<()> {
        let seg = self.playlist.borrow().as_ref().unwrap().segments[i].clone();
        let mut attempt = 1u32;
        loop {
            let r: Result<()> = async {
                self.set_active(i, Some(0));
                let opts = ReqOpts { headers: self.headers(), signal: Some(self.abort.clone()), ..Default::default() };
                let mut res = self.ctx.net.request(&seg.uri, &opts).await?;
                if res.status >= 400 {
                    res.destroy();
                    return Err(Error::new(format!("HTTP {}", res.status)));
                }
                let mut data = Vec::new();
                while let Some(c) = res.chunk(Some(&self.abort)).await? {
                    let mut all: Vec<LimiterRef> = vec![self.limiter.clone()];
                    all.extend((self.ctx.limiters)());
                    let wait = take_all(&all, c.len());
                    if wait > 0 {
                        sleep_ms(wait).await;
                    }
                    data.extend_from_slice(&c);
                    self.meter.borrow_mut().add(c.len() as u64);
                    self.ctx.on_bytes(c.len() as u64);
                    let cur = self.active.borrow().iter().find(|x| x.0 == i).map(|x| x.1).unwrap_or(0);
                    self.set_active(i, Some(cur + c.len() as u64));
                }
                if let Some((key, iv)) = self.key_for(&seg).await? {
                    let dec = cbc::Decryptor::<aes::Aes128>::new_from_slices(&key, &iv)
                        .map_err(|_| Error::new("Invalid key length"))?
                        .decrypt_padded_vec_mut::<Pkcs7>(&data)
                        .map_err(|_| Error::with_code("bad decrypt", "ERR_OSSL_BAD_DECRYPT"))?;
                    data = dec;
                }
                let path = std::path::Path::new(&self.seg_dir()).join(format!("{}.seg", i));
                tokio::fs::write(path, &data).await?;
                let bytes = js::num(&hls_get(&self.item, "bytes"));
                hls_set(&self.item, "bytes", json!(if bytes.is_nan() { 0.0 } else { bytes } + data.len() as f64));
                self.set_active(i, None);
                Ok(())
            }
            .await;
            match r {
                Ok(()) => return Ok(()),
                Err(e) => {
                    self.set_active(i, None);
                    if self.abort.is_cancelled() {
                        return Err(e);
                    }
                    let max = js::num_or(&self.ctx.store.s(&["connection", "connectionRetries"]), 20.0);
                    if attempt as f64 >= max {
                        return Err(e);
                    }
                    sleep_ms(15000u64.min(500 * 2u64.pow(attempt.min(20)))).await;
                    attempt += 1;
                }
            }
        }
    }

    async fn assemble(&self) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let temp = self.item.borrow().temp_path.clone();
        let out = open(&temp, "w").await?;
        let mut out = tokio::fs::File::from_std(std::sync::Arc::try_unwrap(out).map_err(|_| Error::new("file busy"))?);
        let pl = self.playlist.borrow().clone().unwrap();
        if let Some(map) = &pl.map {
            let extra: Vec<(String, String)> = match &map.range {
                Some(r) => {
                    let mut it = r.split('@');
                    let len = js::num(&Value::String(it.next().unwrap_or("").into()));
                    let off = js::num(&Value::String(it.next().unwrap_or("0").into()));
                    vec![("Range".into(), format!("bytes={}-{}", js::fmt_num(off), js::fmt_num(off + len - 1.0)))]
                }
                None => vec![],
            };
            out.write_all(&self.fetch(&map.uri, &extra).await?.body).await?;
        }
        for i in 0..pl.segments.len() {
            let data = tokio::fs::read(std::path::Path::new(&self.seg_dir()).join(format!("{}.seg", i))).await?;
            out.write_all(&data).await?;
        }
        out.flush().await?;
        drop(out);
        let _ = tokio::fs::remove_dir_all(self.seg_dir()).await;
        Ok(())
    }

    fn done(&self, kind: &str, err: Option<Error>) {
        if self.finished.replace(true) {
            return;
        }
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

/// Runs the workers together; returns the first error, or Ok when all finished.
pub async fn first_error<F: std::future::Future<Output = Result<()>>>(futs: Vec<F>) -> Result<()> {
    let mut set: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    std::future::poll_fn(|cx| {
        let mut i = 0;
        while i < set.len() {
            match set[i].as_mut().poll(cx) {
                std::task::Poll::Ready(Err(e)) => return std::task::Poll::Ready(Err(e)),
                std::task::Poll::Ready(Ok(())) => {
                    set.remove(i);
                }
                std::task::Poll::Pending => i += 1,
            }
        }
        if set.is_empty() {
            std::task::Poll::Ready(Ok(()))
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}

impl Engine for HlsDownload {
    fn start(self: Rc<Self>) {
        let a = self.clone();
        let b = self.clone();
        self.timers.borrow_mut().push(interval(500, move || a.emit(EngineEvent::Progress(a.stats()))));
        self.timers.borrow_mut().push(interval(3000, move || b.emit(EngineEvent::Persist)));
        tokio::task::spawn_local(self.run());
    }

    fn stop(&self) {
        self.abort.cancel();
    }

    fn stats(&self) -> Value {
        let total = js::num(&hls_get(&self.item, "total"));
        let total = if total.is_nan() { 0.0 } else { total };
        let done = hls_get(&self.item, "done");
        let done_count = done.as_array().map(|a| a.len()).unwrap_or(0) as f64;
        let rate = self.meter.borrow_mut().rate();
        let active = self.active.borrow();
        let hb = js::num(&hls_get(&self.item, "bytes"));
        let bytes = if hb.is_nan() { 0.0 } else { hb } + active.iter().map(|x| x.1 as f64).sum::<f64>();
        let est = if done_count > 0.0 { Some((bytes / 1f64.max(done_count + active.len() as f64 * 0.5)) * total) } else { None };
        let size = self.item.borrow().size.filter(|s| *s > 0);
        json!({
            "downloaded": bytes,
            "size": size,
            "estimatedSize": est,
            "rate": rate,
            "eta": match est { Some(e) if e != 0.0 && rate > 0.0 => json!((e - bytes).max(0.0) / rate), _ => Value::Null },
            "resumable": true,
            "fraction": if total > 0.0 { done_count / total } else { 0.0 },
            "connections": active.iter().map(|(i, b)| json!({ "id": i + 1, "start": i, "end": i + 1, "pos": i, "receiving": *b > 0, "bytes": b })).collect::<Vec<_>>(),
            "segments": if total > 0.0 { json!([[0, total, done_count]]) } else { json!([]) },
            "hlsSegments": { "total": total, "done": if done.is_array() { done.clone() } else { json!([]) } },
        })
    }

    fn set_speed_limit(&self, kb: f64) {
        self.item.borrow_mut().speed_limit_kb = kb;
        self.limiter.borrow_mut().set_rate(if kb > 0.0 { kb * 1024.0 } else { 0.0 });
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
    fn media_playlist_resolves_relative_segments() {
        let pl = parse_playlist("#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST", "http://h/p/list.m3u8").unwrap();
        assert_eq!(pl.segments[0].uri, "http://h/p/a.ts");
        assert!(pl.end_list);
    }

    #[test]
    fn master_playlist_sorts_variants_by_bandwidth() {
        let pl = parse_playlist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720\nhi.m3u8\n", "http://h/master.m3u8").unwrap();
        let v = pl.variants.unwrap();
        assert_eq!(v[0].uri, "http://h/hi.m3u8");
        assert_eq!(v[0].resolution, "1280x720");
        assert!(parse_playlist("nope", "http://h/").is_err());
    }
}

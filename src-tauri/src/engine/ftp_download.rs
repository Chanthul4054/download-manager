//! FTP download (port of engine/ftp-download.js). Splits the file into static segments, one
//! control+data connection each, resuming every segment with REST.
//! Persisted state: size, resumable, segments.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use serde_json::{json, Value};
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::FileType;
use suppaftp::{FtpError, Mode};
use tokio::io::AsyncReadExt;
use tokio::task::JoinHandle;

use super::limiter::{take_all, LimiterRef, RateLimiter, SpeedMeter};
use super::{interval, open, sleep_ms, write_at, Ctx, Engine, EngineEvent, Fh, Meta, Sink};
use crate::error::{Error, Result};
use crate::item::{seg, ItemRef, SegRef, INF};
use crate::js;
use crate::util::{decode_uri_component, dirname};

struct Creds {
    host: String,
    port: u16,
    user: String,
    password: String,
    remote_path: String,
}

pub struct FtpDownload {
    me: RefCell<std::rc::Weak<FtpDownload>>,
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    meter: RefCell<SpeedMeter>,
    limiter: LimiterRef,
    stopped: Cell<bool>,
    /// Cancelled by stop(): closes every connection, like `client.close()` on each client.
    close_all: RefCell<tokio_util::sync::CancellationToken>,
    timers: RefCell<Vec<JoinHandle<()>>>,
}

fn ftp_err(e: FtpError, host: &str, port: u16) -> Error {
    match e {
        FtpError::ConnectionError(io) => {
            let code = crate::error::io_code(&io);
            match code {
                "ECONNREFUSED" => Error::with_code(format!("connect ECONNREFUSED {}:{}", host, port), code),
                "ETIMEDOUT" => Error::with_code("Timeout (control socket)", code),
                _ => Error::with_code(format!("{}: {}", code, io), code),
            }
        }
        FtpError::UnexpectedResponse(r) => {
            let body = r.as_string().unwrap_or_default();
            let code = r.status.code().to_string();
            if body.starts_with(&code) {
                Error::new(body)
            } else {
                Error::new(format!("{} {}", code, body))
            }
        }
        other => Error::new(other.to_string()),
    }
}

impl FtpDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<FtpDownload> {
        let kb = item.borrow().speed_limit_kb;
        let me = Rc::new(FtpDownload {
            me: RefCell::new(std::rc::Weak::new()),
            item,
            ctx,
            sink,
            meter: RefCell::new(SpeedMeter::default()),
            limiter: RateLimiter::shared(if kb > 0.0 { kb * 1024.0 } else { 0.0 }),
            stopped: Cell::new(false),
            close_all: RefCell::new(tokio_util::sync::CancellationToken::new()),
            timers: RefCell::new(Vec::new()),
        });
        *me.me.borrow_mut() = Rc::downgrade(&me);
        me
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis((js::num(&self.ctx.store.s(&["connection", "timeoutSec"])) * 1000.0).max(1.0) as u64)
    }

    fn creds(&self) -> Result<Creds> {
        let (url, auth) = {
            let it = self.item.borrow();
            (it.url.clone(), it.auth.clone())
        };
        let u = url::Url::parse(&url)?;
        let login = auth.or_else(|| self.ctx.net.login_for(&url));
        Ok(Creds {
            host: u.host_str().unwrap_or("").to_string(),
            port: u.port().unwrap_or(21),
            user: login.as_ref().map(|l| l.user.clone()).filter(|u| !u.is_empty()).unwrap_or_else(|| "anonymous".into()),
            password: login.map(|l| l.pass).unwrap_or_else(|| "guest@example.com".into()),
            remote_path: decode_uri_component(u.path()).ok_or_else(|| Error::new("URI malformed"))?,
        })
    }

    async fn connect(&self) -> Result<AsyncFtpStream> {
        let c = self.creds()?;
        let t = self.timeout();
        let close = self.close_all.borrow().clone();
        let fut = async {
            let mut s = tokio::time::timeout(t, AsyncFtpStream::connect((c.host.as_str(), c.port)))
                .await
                .map_err(|_| Error::with_code("Timeout (control socket)", "ETIMEDOUT"))?
                .map_err(|e| ftp_err(e, &c.host, c.port))?;
            s.set_passive_nat_workaround(true);
            s.set_mode(Mode::ExtendedPassive);
            tokio::time::timeout(t, s.login(c.user.as_str(), c.password.as_str()))
                .await
                .map_err(|_| Error::with_code("Timeout (control socket)", "ETIMEDOUT"))?
                .map_err(|e| ftp_err(e, &c.host, c.port))?;
            s.transfer_type(FileType::Binary).await.map_err(|e| ftp_err(e, &c.host, c.port))?;
            Ok(s)
        };
        tokio::select! {
            r = fut => r,
            _ = close.cancelled() => Err(Error::new("Client is closed")),
        }
    }

    fn downloaded(&self) -> u64 {
        self.item.borrow().segments.iter().flatten().map(|s| {
            let s = s.borrow();
            s.pos.saturating_sub(s.start)
        }).sum()
    }

    async fn run(self: Rc<Self>) {
        let r: Result<()> = async {
            self.emit(EngineEvent::Status("Connecting...".into()));
            let mut probe = self.connect().await?;
            let Creds { remote_path, .. } = self.creds()?;
            let size = probe.size(&remote_path).await.ok().map(|s| s as u64);
            let mtime = probe.mdtm(&remote_path).await.ok().map(|d| d.and_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
            let ignore = js::truthy(&self.ctx.store.s(&["downloads", "ignoreModTimeChanges"]));
            let (fresh, url, mc) = {
                let it = self.item.borrow();
                let changed_mod = matches!((&it.last_modified, &mtime), (Some(a), Some(b)) if a != b) && !ignore;
                (it.segments.is_none() || it.size != size || changed_mod, it.url.clone(), it.max_connections)
            };
            if fresh {
                let max = if mc != 0.0 && !mc.is_nan() { mc } else { (self.ctx.max_conn_for)(&url) };
                let n = match size {
                    Some(s) => 1f64.max(max.min((s as f64 / (1024.0 * 1024.0)).ceil())) as u64,
                    None => 1,
                };
                let step = size.map(|s| (s as f64 / n as f64).ceil() as u64);
                let segs: Vec<SegRef> = (0..n)
                    .map(|i| {
                        let start = step.map(|st| i * st).unwrap_or(0);
                        let end = match (size, step) {
                            (Some(s), Some(st)) => s.min((i + 1) * st),
                            _ => INF,
                        };
                        seg(start, end, start)
                    })
                    .collect();
                let mut it = self.item.borrow_mut();
                it.size = size;
                it.last_modified = mtime;
                it.resumable = Some(true);
                it.segments = Some(segs);
            }
            self.emit(EngineEvent::Meta(Meta { size, resumable: true, content_type: String::new(), file_name: None }));
            let temp = self.item.borrow().temp_path.clone();
            tokio::fs::create_dir_all(dirname(&temp)).await?;
            let fh = match open(&temp, if fresh { "w+" } else { "r+" }).await {
                Ok(f) => f,
                Err(_) => open(&temp, "w+").await?,
            };
            self.emit(EngineEvent::Status("Receiving data...".into()));
            let segs = self.item.borrow().segments.clone().unwrap_or_default();
            let mut reuse = Some(probe);
            let runs: Vec<_> = segs
                .into_iter()
                .map(|s| {
                    let c = reuse.take();
                    self.run_segment(s, fh.clone(), c, remote_path.clone())
                })
                .collect();
            // The first failure fails the download; the other connections are closed with it.
            let results = futures_join_all(runs).await;
            for r in results {
                r?;
            }
            if self.stopped.get() {
                return Err(Error::new("Stopped"));
            }
            if self.item.borrow().size.is_none() {
                let d = self.downloaded();
                let mut it = self.item.borrow_mut();
                it.size = Some(d);
                if let Some(first) = it.segments.as_ref().and_then(|s| s.first()) {
                    first.borrow_mut().end = d;
                }
            }
            drop(fh);
            Ok(())
        }
        .await;
        self.close_all.borrow().cancel();
        match r {
            Ok(()) => self.done("complete", None),
            Err(e) => self.done(if self.stopped.get() { "stopped" } else { "failed" }, Some(e)),
        }
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

    /// One transfer from `seg.pos` until the segment's end or the end of the file.
    async fn transfer(&self, client: &mut AsyncFtpStream, s: &SegRef, fh: &Fh, remote_path: &str) -> Result<()> {
        let (host, port) = {
            let c = self.creds()?;
            (c.host, c.port)
        };
        let pos = s.borrow().pos;
        if pos > 0 {
            client.resume_transfer(pos as usize).await.map_err(|e| ftp_err(e, &host, port))?;
        }
        let mut stream = match client.retr_as_stream(remote_path).await {
            Ok(st) => st,
            Err(FtpError::UnexpectedResponse(r)) if r.status.code() == 500 || r.status.code() == 502 => {
                // EPSV refused: fall back to PASV, as basic-ftp does.
                client.set_mode(Mode::Passive);
                if pos > 0 {
                    client.resume_transfer(pos as usize).await.map_err(|e| ftp_err(e, &host, port))?;
                }
                client.retr_as_stream(remote_path).await.map_err(|e| ftp_err(e, &host, port))?
            }
            Err(e) => return Err(ftp_err(e, &host, port)),
        };
        let t = self.timeout();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = tokio::time::timeout(t, stream.read(&mut buf))
                .await
                .map_err(|_| Error::with_code("Timeout (data socket)", "ETIMEDOUT"))??;
            if n == 0 {
                break;
            }
            let room = {
                let b = s.borrow();
                b.end.saturating_sub(b.pos)
            };
            let part = bytes::Bytes::copy_from_slice(&buf[..(n as u64).min(room) as usize]);
            let mut all = vec![self.limiter.clone()];
            all.extend((self.ctx.limiters)());
            let wait = take_all(&all, part.len());
            if wait > 0 {
                sleep_ms(wait).await;
            }
            let at = s.borrow().pos;
            let len = part.len() as u64;
            write_at(fh, part, at).await?;
            s.borrow_mut().pos += len;
            self.meter.borrow_mut().add(len);
            self.ctx.on_bytes(len);
            let full = {
                let b = s.borrow();
                b.pos >= b.end
            };
            if full {
                // Stop the transfer at our boundary.
                return Err(Error::new("Client is closed"));
            }
        }
        stream.finish().await.map_err(|e| ftp_err(e, &host, port))?;
        Ok(())
    }

    async fn run_segment(&self, s: SegRef, fh: Fh, client: Option<AsyncFtpStream>, remote_path: String) -> Result<()> {
        let max_retries = js::num_or(&self.ctx.store.s(&["connection", "connectionRetries"]), 20.0);
        let mut tries = 0u32;
        let mut client = client;
        loop {
            let more = {
                let b = s.borrow();
                b.pos < b.end
            };
            if !more || self.stopped.get() {
                break;
            }
            let close = self.close_all.borrow().clone();
            let attempt = async {
                let mut c = match client.take() {
                    Some(c) => c,
                    None => self.connect().await?,
                };
                let r = self.transfer(&mut c, &s, &fh, &remote_path).await;
                if r.is_ok() {
                    let mut b = s.borrow_mut();
                    if b.end == INF {
                        b.end = b.pos;
                    }
                }
                let _ = tokio::time::timeout(Duration::from_millis(500), c.quit()).await;
                r
            };
            let r = tokio::select! {
                r = attempt => r,
                _ = close.cancelled() => Err(Error::new("Client is closed")),
            };
            if let Err(e) = r {
                let done = {
                    let b = s.borrow();
                    b.pos >= b.end
                };
                if done || self.stopped.get() {
                    break;
                }
                tries += 1;
                if tries as f64 > max_retries {
                    return Err(e);
                }
                self.emit(EngineEvent::Status(format!("Retrying ({})...", e.message)));
                sleep_ms(30000u64.min(1000 * 2u64.pow(tries.min(5)))).await;
            }
        }
        Ok(())
    }
}

/// Runs the futures together; returns when the first one fails or all succeed.
async fn futures_join_all<F: std::future::Future<Output = Result<()>>>(futs: Vec<F>) -> Vec<Result<()>> {
    let mut set: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut out = Vec::new();
    std::future::poll_fn(|cx| {
        let mut i = 0;
        while i < set.len() {
            match set[i].as_mut().poll(cx) {
                std::task::Poll::Ready(r) => {
                    let failed = r.is_err();
                    out.push(r);
                    set.remove(i);
                    if failed {
                        return std::task::Poll::Ready(());
                    }
                }
                std::task::Poll::Pending => i += 1,
            }
        }
        if set.is_empty() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    out
}

impl Engine for FtpDownload {
    fn start(self: Rc<Self>) {
        self.stopped.set(false);
        *self.close_all.borrow_mut() = tokio_util::sync::CancellationToken::new();
        let a = self.clone();
        let b = self.clone();
        self.timers.borrow_mut().push(interval(500, move || a.emit(EngineEvent::Progress(a.stats()))));
        self.timers.borrow_mut().push(interval(3000, move || b.emit(EngineEvent::Persist)));
        tokio::task::spawn_local(self.run());
    }

    fn stop(&self) {
        self.stopped.set(true);
        self.close_all.borrow().cancel();
    }

    fn stats(&self) -> Value {
        let it = self.item.borrow();
        let done: u64 = it.segments.iter().flatten().map(|s| {
            let s = s.borrow();
            s.pos.saturating_sub(s.start)
        }).sum();
        let rate = self.meter.borrow_mut().rate();
        let connections: Vec<Value> = it
            .segments
            .iter()
            .flatten()
            .filter(|s| {
                let b = s.borrow();
                b.pos < b.end
            })
            .enumerate()
            .map(|(i, s)| {
                let b = s.borrow();
                json!({ "id": i + 1, "start": b.start, "end": if b.end == INF { Value::Null } else { json!(b.end) }, "pos": b.pos, "receiving": !self.stopped.get() })
            })
            .collect();
        json!({
            "downloaded": done,
            "size": it.size,
            "rate": rate,
            "eta": match it.size { Some(s) if s > 0 && rate > 0.0 => json!((s as f64 - done as f64) / rate), _ => Value::Null },
            "resumable": true,
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
    }

    fn item(&self) -> ItemRef {
        self.item.clone()
    }
}

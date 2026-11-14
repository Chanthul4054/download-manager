//! Download engines. Each engine runs on the app's single-threaded executor, like the JS engines
//! ran on Node's event loop, and reports to the manager through `EngineEvent`s.

pub mod ffmpeg;
pub mod ftp_download;
pub mod hls_download;
pub mod http_download;
pub mod limiter;
pub mod muxed_download;
pub mod net;
pub mod proxy_resolver;
pub mod torrent;
pub mod ytdlp;

use std::fs::File;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::item::{ItemRef, SegRef};
use crate::store::Store;
use limiter::LimiterRef;
use net::NetContext;

pub struct Meta {
    pub size: Option<u64>,
    pub resumable: bool,
    pub content_type: String,
    pub file_name: Option<String>,
}

pub enum EngineEvent {
    Status(String),
    Meta(Meta),
    Progress(Value),
    Persist,
    Metrics(Value),
    Complete,
    Stopped,
    Failed(Error),
}

pub type Sink = Rc<dyn Fn(EngineEvent)>;

#[derive(Clone)]
pub struct Ctx {
    pub net: Rc<NetContext>,
    pub store: Rc<Store>,
    pub limiters: Rc<dyn Fn() -> Vec<LimiterRef>>,
    pub max_conn_for: Rc<dyn Fn(&str) -> f64>,
    pub on_bytes: Option<Rc<dyn Fn(u64)>>,
    pub bin_dir: PathBuf,
}

impl Ctx {
    pub fn on_bytes(&self, n: u64) {
        if let Some(f) = &self.on_bytes {
            f(n);
        }
    }
}

pub trait Engine {
    /// Begins the download. Runs the synchronous part of the JS `start()` before returning.
    fn start(self: Rc<Self>);
    fn stop(&self);
    fn stats(&self) -> Value;
    fn set_speed_limit(&self, kb: f64);
    fn set_max_connections(&self, n: f64);
    fn item(&self) -> ItemRef;
}

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// A repeating timer (`setInterval`); dropping or aborting the handle clears it.
pub fn interval(ms: u64, f: impl Fn() + 'static) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_local(async move {
        let mut t = tokio::time::interval(Duration::from_millis(ms));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        t.tick().await;
        loop {
            t.tick().await;
            f();
        }
    })
}

// ---- durable checkpoints -----------------------------------------------------------------------

/// Seconds between checkpoints when `connection.checkpointSec` is not set (see bench/README.md).
pub const DEFAULT_CHECKPOINT_SEC: f64 = 2.0;

/// How often a running download flushes its file and saves the flushed position.
pub fn checkpoint_ms(store: &Store) -> u64 {
    let s = crate::js::num(&store.s(&["connection", "checkpointSec"]));
    let s = if s.is_finite() && s > 0.0 { s } else { DEFAULT_CHECKPOINT_SEC };
    // At least 1 s: every checkpoint flushes the whole file.
    (s.clamp(1.0, 60.0) * 1000.0) as u64
}

/// Waits until everything written to the file is on the disk (FlushFileBuffers / fdatasync).
pub async fn sync_file(fh: &Fh) -> std::io::Result<()> {
    let f = fh.clone();
    tokio::task::spawn_blocking(move || f.sync_data()).await.map_err(std::io::Error::other)?
}

/// One checkpoint: note how far each segment's writes have landed, run `sync`, and only then
/// record those positions as durable. Bytes that land during the sync wait for the next one, and
/// a failed sync records nothing.
pub async fn checkpoint(segs: &[SegRef], sync: impl std::future::Future<Output = std::io::Result<()>>) -> std::io::Result<()> {
    let landed: Vec<u64> = segs.iter().map(|s| s.borrow().pos).collect();
    sync.await?;
    for (s, p) in segs.iter().zip(landed) {
        let mut b = s.borrow_mut();
        b.synced = b.synced.max(p.min(b.pos));
    }
    Ok(())
}

/// Resuming from the saved list: keep only progress that was durable and that the file still
/// holds; anything after it is downloaded again.
pub fn reconcile(segs: &[SegRef], file_len: u64) {
    for s in segs {
        let mut b = s.borrow_mut();
        let p = b.synced.min(b.pos).min(file_len).max(b.start);
        b.rewind(p);
    }
}

/// Checkpoints every `ms` until aborted. `state` gives the open file and its segments (None while
/// there is no file); `done` gets each outcome and how long the sync took, or None without a file.
pub fn checkpoints(ms: u64, state: impl Fn() -> Option<(Fh, Vec<SegRef>)> + 'static, done: impl Fn(Option<(std::io::Result<()>, f64)>) + 'static) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_local(async move {
        let mut t = tokio::time::interval(Duration::from_millis(ms));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        t.tick().await;
        loop {
            t.tick().await;
            match state() {
                Some((fh, segs)) => {
                    let t0 = limiter::perf_now();
                    let r = checkpoint(&segs, sync_file(&fh)).await;
                    done(Some((r, limiter::perf_now() - t0)));
                }
                None => done(None),
            }
        }
    })
}

// ---- positional file access (Node's fh.write(buf, 0, len, position)) -------------------------------

pub type Fh = Arc<File>;

fn write_at_sync(f: &File, mut buf: &[u8], mut pos: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(f, buf, pos)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(f, buf, pos)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "write returned 0"));
        }
        buf = &buf[n..];
        pos += n as u64;
    }
    Ok(())
}

/// Starts a positional write on the blocking pool without waiting for it.
pub fn spawn_write(f: &Fh, buf: bytes::Bytes, pos: u64) -> tokio::task::JoinHandle<std::io::Result<()>> {
    let f = f.clone();
    tokio::task::spawn_blocking(move || write_at_sync(&f, &buf, pos))
}

pub async fn write_at(f: &Fh, buf: bytes::Bytes, pos: u64) -> Result<()> {
    let f = f.clone();
    tokio::task::spawn_blocking(move || write_at_sync(&f, &buf, pos)).await.map_err(|e| Error::new(e.to_string()))?.map_err(Error::from)
}

/// Reads exactly `len` bytes at `pos`.
pub async fn read_at(f: &Fh, pos: u64, len: usize) -> Result<Vec<u8>> {
    let f = f.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; len];
        let mut done = 0;
        while done < len {
            #[cfg(windows)]
            let n = std::os::windows::fs::FileExt::seek_read(&*f, &mut buf[done..], pos + done as u64)?;
            #[cfg(unix)]
            let n = std::os::unix::fs::FileExt::read_at(&*f, &mut buf[done..], pos + done as u64)?;
            if n == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "read past the end of the file"));
            }
            done += n;
        }
        Ok(buf)
    })
    .await
    .map_err(|e| Error::new(e.to_string()))?
    .map_err(Error::from)
}

pub async fn set_len(f: &Fh, len: u64) -> Result<()> {
    let f = f.clone();
    tokio::task::spawn_blocking(move || f.set_len(len)).await.map_err(|e| Error::new(e.to_string()))?.map_err(Error::from)
}

pub async fn file_len(f: &Fh) -> Result<u64> {
    let f = f.clone();
    tokio::task::spawn_blocking(move || f.metadata().map(|m| m.len())).await.map_err(|e| Error::new(e.to_string()))?.map_err(Error::from)
}

/// Opens a file like Node's flags: "w+" (create/truncate, read-write), "r+" (existing, read-write),
/// "w" (create/truncate, write).
pub async fn open(path: &str, flags: &str) -> Result<Fh> {
    let path = path.to_string();
    let flags = flags.to_string();
    tokio::task::spawn_blocking(move || {
        let mut o = std::fs::OpenOptions::new();
        match flags.as_str() {
            "r+" => o.read(true).write(true),
            "w" => o.write(true).create(true).truncate(true),
            _ => o.read(true).write(true).create(true).truncate(true),
        };
        // An unfinished file next to its destination is hidden. Windows also refuses to truncate
        // an existing hidden file unless the open asks for the attribute.
        #[cfg(windows)]
        if path.ends_with(crate::util::PART_EXT) {
            use std::os::windows::fs::OpenOptionsExt;
            o.attributes(0x2);
        }
        o.open(&path).map(Arc::new)
    })
    .await
    .map_err(|e| Error::new(e.to_string()))?
    .map_err(Error::from)
}

/// Splits network data into pieces no bigger than Node's stream chunks, so segment bookkeeping
/// advances in the same small steps as before.
pub const MAX_PIECE: usize = 64 * 1024;

/// Piece size when no speed limit applies. Every piece waits for a write on the blocking pool
/// (~0.4 ms here), so 64 KB pieces held one connection to ~165 MB/s on loopback; 1 MB measured
/// 230 MB/s on one connection and 579 MB/s on eight (bench/README.md). Limited downloads keep
/// MAX_PIECE so the limiter still meters in small steps.
pub const MAX_FAST_PIECE: usize = 1024 * 1024;

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use crate::item::seg;
    use std::cell::Cell;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn a_failed_sync_records_nothing_as_durable() {
        let s = seg(0, 100, 0);
        s.borrow_mut().pos = 60;
        let r = block(checkpoint(std::slice::from_ref(&s), async { Err(std::io::Error::other("injected sync failure")) }));
        assert!(r.is_err());
        assert_eq!(s.borrow().synced, 0);
        // The saved list carries the durable offset, not the written one.
        assert_eq!(serde_json::to_value(&*s.borrow()).unwrap()["pos"], 0);
    }

    #[test]
    fn only_bytes_landed_before_the_sync_become_durable() {
        let s = seg(10, 100, 10);
        s.borrow_mut().pos = 40;
        let during = s.clone();
        let synced = Cell::new(false);
        let r = block(checkpoint(std::slice::from_ref(&s), async {
            // A write lands while the flush runs: it is not covered by this flush.
            during.borrow_mut().pos = 70;
            synced.set(true);
            Ok(())
        }));
        assert!(r.is_ok() && synced.get());
        let b = s.borrow();
        assert_eq!((b.pos, b.synced), (70, 40));
        assert_eq!(serde_json::to_value(&*b).unwrap()["pos"], 40);
    }

    #[test]
    fn a_saved_list_loads_with_written_and_durable_equal() {
        let v = serde_json::json!({ "start": 5, "end": 20, "pos": 9 });
        let s: crate::item::Seg = serde_json::from_value(v).unwrap();
        assert_eq!((s.start, s.end, s.pos, s.synced), (5, 20, 9, 9));
    }

    #[test]
    fn resuming_never_trusts_more_than_the_file_holds() {
        let a = seg(0, 100, 80); // durable 80, but the file is only 50 long
        let b = seg(100, 200, 150); // starts past the end of the file
        let c = seg(200, 300, 200);
        c.borrow_mut().pos = 250; // written but not durable
        reconcile(&[a.clone(), b.clone(), c.clone()], 50);
        assert_eq!((a.borrow().pos, a.borrow().synced), (50, 50));
        assert_eq!((b.borrow().pos, b.borrow().synced), (100, 100));
        assert_eq!((c.borrow().pos, c.borrow().synced), (200, 200));
        // A longer file changes nothing: data past the durable offset is fetched again.
        let d = seg(0, 100, 30);
        reconcile(std::slice::from_ref(&d), 1000);
        assert_eq!((d.borrow().pos, d.borrow().synced), (30, 30));
    }

    #[test]
    fn a_real_file_sync_succeeds_and_advances() {
        let dir = std::env::temp_dir().join(format!("odm-ckpt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.bin");
        block(async {
            let fh = open(path.to_str().unwrap(), "w+").await.unwrap();
            write_at(&fh, bytes::Bytes::from(vec![1u8; 4096]), 0).await.unwrap();
            let s = seg(0, 8192, 0);
            s.borrow_mut().pos = 4096;
            checkpoint(std::slice::from_ref(&s), sync_file(&fh)).await.unwrap();
            assert_eq!(s.borrow().synced, 4096);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}

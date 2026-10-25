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
use crate::item::ItemRef;
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
        o.open(&path).map(Arc::new)
    })
    .await
    .map_err(|e| Error::new(e.to_string()))?
    .map_err(Error::from)
}

/// Splits network data into pieces no bigger than Node's stream chunks, so segment bookkeeping
/// advances in the same small steps as before.
pub const MAX_PIECE: usize = 64 * 1024;

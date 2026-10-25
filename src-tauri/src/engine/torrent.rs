//! BitTorrent downloads: magnet links and .torrent addresses. Free Download Manager's downloadsbt
//! module wraps libtorrent; here librqbit does the protocol work, with the session options FDM
//! exposes (DHT, local peer discovery, uTP, port forwarding, listening port, extra trackers) and
//! seeding up to a share ratio once the download is complete.
//!
//! librqbit needs a multi-threaded runtime, so it runs on its own; the app's single-threaded side
//! only polls the torrent's stats.

use std::cell::{Cell, RefCell};
use std::net::Ipv6Addr;
use std::num::NonZeroU32;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use librqbit::limits::LimitsConfig;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerMode, ListenerOptions, ManagedTorrent, Session, SessionOptions, TorrentStatsState};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use super::{Ctx, Engine, EngineEvent, Meta, Sink};
use crate::error::{Error, Result};
use crate::item::ItemRef;
use crate::js;
use crate::store::Store;

static RT: LazyLock<tokio::runtime::Runtime> =
    LazyLock::new(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("torrent").enable_all().build().expect("torrent runtime"));
// shortcut: the session is made with the settings of the first torrent started; changes to
// Options → BitTorrent apply after a restart. Rebuild the session on change if that matters.
static SESSION: OnceCell<Arc<Session>> = OnceCell::const_new();

/// Magnet links, and .torrent files on the web or on this computer (file:///…).
pub fn is_torrent(url: &str) -> bool {
    url.starts_with("magnet:?")
        || url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "file") && u.path().to_lowercase().ends_with(".torrent"))
}

/// What librqbit is given for an address: a local .torrent file is read here.
fn source(url: &str) -> Result<AddTorrent<'static>> {
    match url::Url::parse(url) {
        Ok(u) if u.scheme() == "file" => {
            let path = u.to_file_path().map_err(|_| Error::new("Invalid file address"))?;
            Ok(AddTorrent::from_bytes(std::fs::read(&path).map_err(|e| Error::new(format!("Could not read {}: {}", path.display(), e)))?))
        }
        _ => Ok(AddTorrent::from_url(url.to_string())),
    }
}

/// The torrent's name and files (index, path, size), read without starting it. A magnet link
/// has to fetch this from peers first.
pub async fn list_files(store: &Store, url: &str) -> Result<Value> {
    let sess = session(store).await?;
    let src = source(url)?;
    on_rt(async move {
        let add = sess.add_torrent(src, Some(AddTorrentOptions { list_only: true, ..Default::default() }));
        let r = tokio::time::timeout(Duration::from_secs(90), add).await.map_err(|_| anyhow::anyhow!("No peers sent the torrent's file list"))??;
        let describe = |info: &librqbit::ValidatedTorrentMetaV1Info<librqbit::ByteBufOwned>| {
            let files: Vec<Value> = info
                .iter_file_details()
                .enumerate()
                .filter(|(_, f)| !f.attrs().padding)
                .map(|(i, f)| json!({ "index": i, "path": f.filename.to_vec().join("/"), "size": f.len }))
                .collect();
            json!({ "name": info.name().map(|n| n.into_owned()), "files": files })
        };
        match r {
            AddTorrentResponse::ListOnly(l) => Ok(describe(&l.info)),
            AddTorrentResponse::AlreadyManaged(_, h) => h.with_metadata(|m| describe(&m.info)),
            AddTorrentResponse::Added(..) => anyhow::bail!("the torrent was started instead of listed"),
        }
    })
    .await?
    .map_err(err)
}

/// The name a magnet link gives its torrent (dn=), until the torrent's own info arrives.
pub fn magnet_name(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok().filter(|u| u.scheme() == "magnet")?;
    u.query_pairs().find(|(k, _)| k == "dn").map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty())
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::new(e.to_string())
}

/// Runs a future on the torrent runtime and waits for it here.
async fn on_rt<T: Send + 'static>(f: impl std::future::Future<Output = T> + Send + 'static) -> Result<T> {
    RT.spawn(f).await.map_err(err)
}

async fn session(store: &Store) -> Result<Arc<Session>> {
    let s = store.s(&["torrent"]);
    let on = |k: &str| js::truthy(js::get(&s, k));
    let (dht, lsd, utp, upnp) = (on("enableDht"), on("enableLsd"), on("enableUtp"), on("enablePortForwarding"));
    let port = js::num_or(js::get(&s, "listenPort"), 0.0).clamp(0.0, 65535.0) as u16;
    let trackers: std::collections::HashSet<url::Url> = js::str_of(js::get(&s, "trackers")).lines().filter_map(|l| url::Url::parse(l.trim()).ok()).collect();
    let dir = store.dir.join("torrents");
    SESSION
        .get_or_try_init(|| async move {
            on_rt(async move {
                let opts = SessionOptions {
                    dht: dht.then(|| DhtSessionConfig { persistence: None, ..Default::default() }),
                    listen: Some(ListenerOptions {
                        mode: if utp { ListenerMode::TcpAndUtp } else { ListenerMode::TcpOnly },
                        listen_addr: (Ipv6Addr::UNSPECIFIED, port).into(),
                        enable_upnp_port_forwarding: upnp,
                        ..Default::default()
                    }),
                    disable_local_service_discovery: !lsd,
                    trackers,
                    ..Default::default()
                };
                Session::new_with_opts(dir, opts).await
            })
            .await?
            .map_err(err)
        })
        .await
        .cloned()
}

/// Drops a torrent (by the info hash its download recorded) from the session, so it stops
/// seeding and lets go of its files, and deletes the files if asked.
pub async fn forget(info_hash: &str, delete_files: bool) {
    let (Some(sess), Ok(id)) = (SESSION.get().cloned(), librqbit::api::TorrentIdOrHash::parse(info_hash)) else { return };
    let _ = on_rt(async move { sess.delete(id, delete_files).await }).await;
}

pub struct TorrentDownload {
    item: ItemRef,
    ctx: Ctx,
    sink: Sink,
    stopped: Cell<bool>,
    stats: RefCell<Value>,
}

impl TorrentDownload {
    pub fn new(item: ItemRef, ctx: Ctx, sink: Sink) -> Rc<TorrentDownload> {
        Rc::new(TorrentDownload { item, ctx, sink, stopped: Cell::new(false), stats: RefCell::new(json!({})) })
    }

    fn emit(&self, e: EngineEvent) {
        (self.sink)(e);
    }

    async fn run(self: Rc<Self>) {
        match self.clone().download().await {
            Ok(()) if self.stopped.get() => self.emit(EngineEvent::Stopped),
            Ok(()) => self.emit(EngineEvent::Complete),
            Err(_) if self.stopped.get() => self.emit(EngineEvent::Stopped),
            Err(e) => self.emit(EngineEvent::Failed(e)),
        }
    }

    async fn download(self: Rc<Self>) -> Result<()> {
        self.emit(EngineEvent::Status("Getting torrent info...".into()));
        let sess = session(&self.ctx.store).await?;
        let (url, out, kb, only) = {
            let it = self.item.borrow();
            let only: Option<Vec<usize>> = it.extra.get("onlyFiles").and_then(|v| serde_json::from_value(v.clone()).ok());
            (it.url.clone(), it.save_dir.clone(), it.speed_limit_kb, only)
        };
        let src = source(&url)?;
        let s2 = sess.clone();
        let h = on_rt(async move {
            let opts = AddTorrentOptions {
                output_folder: Some(out),
                // Lets a stopped or restarted torrent continue from the pieces already on disk.
                overwrite: true,
                // shortcut: the per-download limit is applied when the torrent starts, not while it runs.
                ratelimits: LimitsConfig { download_bps: NonZeroU32::new((kb * 1024.0) as u32), upload_bps: None },
                only_files: only,
                ..Default::default()
            };
            let h = s2.add_torrent(src, Some(opts)).await?.into_handle().ok_or_else(|| anyhow::anyhow!("torrent was not added"))?;
            if h.is_paused() {
                s2.unpause(&h).await?;
            }
            anyhow::Ok(h)
        })
        .await?
        .map_err(err)?;
        self.item.borrow_mut().extra.insert("infoHash".into(), json!(h.info_hash().as_string()));
        let mut named = false;
        let mut last = 0u64;
        let mut ticks = 0u32;
        loop {
            if self.stopped.get() {
                let (s2, h2) = (sess.clone(), h.clone());
                let _ = on_rt(async move { s2.pause(&h2).await }).await;
                return Ok(());
            }
            let st = h.stats();
            if let Some(e) = st.error {
                return Err(Error::new(e));
            }
            if !named {
                if let Some(name) = h.name() {
                    named = true;
                    self.emit(EngineEvent::Meta(Meta { size: Some(st.total_bytes), resumable: true, content_type: String::new(), file_name: Some(name) }));
                    self.emit(EngineEvent::Status("Downloading...".into()));
                }
            }
            self.ctx.on_bytes(st.progress_bytes.saturating_sub(last));
            last = st.progress_bytes;
            let live = st.live.as_ref();
            let rate = live.map(|l| l.download_speed.as_bytes()).unwrap_or(0);
            let v = json!({
                "downloaded": st.progress_bytes,
                "size": if st.total_bytes > 0 { json!(st.total_bytes) } else { Value::Null },
                "rate": rate,
                "eta": live.and_then(|l| l.time_remaining.as_ref()).map(|_| (st.total_bytes.saturating_sub(st.progress_bytes)) as f64 / rate.max(1) as f64),
                "resumable": true,
                "uploaded": st.uploaded_bytes,
                "uploadRate": live.map(|l| l.upload_speed.as_bytes()).unwrap_or(0),
                "peers": live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0),
                "peersSeen": live.map(|l| l.snapshot.peer_stats.seen).unwrap_or(0),
                "connections": [],
            });
            *self.stats.borrow_mut() = v.clone();
            self.emit(EngineEvent::Progress(v));
            if st.finished && matches!(st.state, TorrentStatsState::Live | TorrentStatsState::Paused) {
                self.seed(sess, h);
                return Ok(());
            }
            ticks += 1;
            if ticks.is_multiple_of(6) {
                self.emit(EngineEvent::Persist);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Keeps sharing a finished torrent until it has uploaded `seedRatio` times its size.
    fn seed(&self, sess: Arc<Session>, h: Arc<ManagedTorrent>) {
        let ratio = js::num_or(&self.ctx.store.s(&["torrent", "seedRatio"]), 1.0).max(0.0);
        // shortcut: seeding lasts while the app runs; it does not resume after a restart.
        RT.spawn(async move {
            loop {
                let st = h.stats();
                if h.is_paused() || st.error.is_some() || st.uploaded_bytes as f64 >= st.total_bytes as f64 * ratio {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
            let _ = sess.pause(&h).await;
        });
    }
}

impl Engine for TorrentDownload {
    fn start(self: Rc<Self>) {
        self.stopped.set(false);
        tokio::task::spawn_local(self.run());
    }

    fn stop(&self) {
        self.stopped.set(true);
    }

    fn stats(&self) -> Value {
        self.stats.borrow().clone()
    }

    fn set_speed_limit(&self, kb: f64) {
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
    fn recognises_torrent_addresses() {
        assert!(is_torrent("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x"));
        assert!(is_torrent("https://example.com/files/Ubuntu.ISO.torrent?x=1"));
        assert!(!is_torrent("https://example.com/torrent.html"));
        assert!(!is_torrent("magnet-link.txt"));
        assert!(is_torrent("file:///C:/Users/me/Downloads/My%20File.torrent"));
        assert!(!is_torrent("file:///C:/Users/me/notes.txt") && !is_torrent("ftp://h/x.torrent"));
        assert_eq!(magnet_name("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Big+Buck+Bunny").as_deref(), Some("Big Buck Bunny"));
        assert_eq!(magnet_name("https://x/?dn=a"), None);
    }
}

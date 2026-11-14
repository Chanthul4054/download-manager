//! JSON-file persistence with debounced atomic writes (port of src/main/store.js). The files and
//! their layout are the same as the Electron version's, in the same folder.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::task::JoinHandle;

use crate::defaults::{default_categories, default_queues, default_settings};
use crate::item::{Item, ItemRef};
use crate::linkgrabber::LgState;
use crate::util::{read_json, write_json_atomic};

pub type ProjectRef = Rc<RefCell<Value>>;

pub fn deep_merge(base: &Value, over: &Value) -> Value {
    match base {
        Value::Object(b) => {
            let mut out = b.clone();
            if let Value::Object(o) = over {
                for (k, v) in o {
                    let merged = match b.get(k) {
                        Some(bv @ Value::Object(_)) => deep_merge(bv, v),
                        _ => v.clone(),
                    };
                    out.insert(k.clone(), merged);
                }
            }
            Value::Object(out)
        }
        _ => over.clone(),
    }
}

pub const NAMES: [&str; 6] = ["settings", "categories", "queues", "downloads", "grabber", "linkgrabber"];

/// Suffixes of the previous generations of a data file, newest first.
const BACKUPS: [&str; 3] = ["bak", "1.bak", "2.bak"];

fn suffixed(file: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}.{}", file.display(), suffix))
}

/// Reads a data file, falling back to its backups. A copy that exists but cannot be read is
/// renamed to `<name>.corrupt-<unix ms>`: kept for diagnosis, and never rotated or overwritten.
/// Returns the data and whether it came from a backup.
fn load(file: &Path) -> (Option<Value>, bool) {
    let ms = chrono::Utc::now().timestamp_millis();
    let copies = std::iter::once(file.to_path_buf()).chain(BACKUPS.iter().map(|b| suffixed(file, b)));
    for (i, f) in copies.enumerate() {
        if !f.is_file() {
            continue;
        }
        match read_json(&f) {
            Some(v) => return (Some(v), i > 0),
            None => {
                let _ = std::fs::rename(&f, suffixed(&f, &format!("corrupt-{}", ms)));
            }
        }
    }
    (None, false)
}

/// Makes `file` the newest backup and shifts the older ones. Only called for a file this process
/// loaded or wrote, so a backup is always a file that parsed.
fn rotate(file: &Path) {
    let bak = |i: usize| suffixed(file, BACKUPS[i]);
    let Ok(now) = std::fs::read(file) else { return };
    // Unchanged since the last backup (quit and relaunch): keep the older generations.
    if std::fs::read(bak(0)).is_ok_and(|b| b == now) {
        return;
    }
    let _ = std::fs::remove_file(bak(2));
    let _ = std::fs::rename(bak(1), bak(2));
    let _ = std::fs::rename(bak(0), bak(1));
    // A copy keeps the owner-only mode of the file (settings hold logins).
    let _ = std::fs::copy(file, bak(0));
}

pub struct Store {
    pub dir: PathBuf,
    timers: RefCell<HashMap<&'static str, JoinHandle<()>>>,
    /// Names (see `NAMES`) whose file was missing or broken at startup and came from a backup.
    pub restored: RefCell<Vec<&'static str>>,
    /// When each file's backups were last rotated.
    rotated: RefCell<HashMap<String, Instant>>,
    pub settings: RefCell<Value>,
    pub categories: RefCell<Value>,
    pub queues: RefCell<Value>,
    pub downloads: RefCell<Vec<ItemRef>>,
    pub grabber: RefCell<Vec<ProjectRef>>,
    pub linkgrabber: RefCell<LgState>,
}

impl Store {
    pub fn new(dir: &Path) -> Rc<Store> {
        let file = |n: &str| dir.join(format!("{}.json", n));
        // A data file that cannot be read is kept aside and its newest readable backup is used;
        // without one the app starts with defaults for it.
        let restored = RefCell::new(Vec::new());
        let read_json = |f: &Path| {
            let (v, from_backup) = load(f);
            if from_backup {
                if let Some(n) = NAMES.iter().find(|n| file(n) == f) {
                    restored.borrow_mut().push(*n);
                    let mut m = serde_json::Map::new();
                    m.insert("file".into(), Value::String((*n).into()));
                    crate::diag::diag("restored-from-backup", m);
                }
            }
            v
        };
        let settings = deep_merge(&default_settings(), &read_json(&file("settings")).unwrap_or(Value::Object(Default::default())));
        let categories = read_json(&file("categories")).filter(|v| !v.is_null()).unwrap_or_else(default_categories);
        let queues = read_json(&file("queues")).filter(|v| !v.is_null()).unwrap_or_else(default_queues);
        let downloads = match read_json(&file("downloads")) {
            Some(Value::Array(a)) => a
                .into_iter()
                .filter_map(|v| serde_json::from_value::<Item>(v).ok())
                .map(|it| Rc::new(RefCell::new(it)))
                .collect(),
            _ => Vec::new(),
        };
        let grabber = match read_json(&file("grabber")) {
            Some(Value::Array(a)) => a.into_iter().map(|p| Rc::new(RefCell::new(p))).collect(),
            _ => Vec::new(),
        };
        let linkgrabber = read_json(&file("linkgrabber"))
            .and_then(|v| serde_json::from_value::<LgState>(v).ok())
            .unwrap_or_default();
        // What loaded is a good generation to keep.
        let now = Instant::now();
        let mut rotated = HashMap::new();
        for n in NAMES {
            rotate(&file(n));
            rotated.insert(n.to_string(), now);
        }
        Rc::new(Store {
            dir: dir.to_path_buf(),
            timers: RefCell::new(HashMap::new()),
            restored,
            rotated: RefCell::new(rotated),
            settings: RefCell::new(settings),
            categories: RefCell::new(categories),
            queues: RefCell::new(queues),
            downloads: RefCell::new(downloads),
            grabber: RefCell::new(grabber),
            linkgrabber: RefCell::new(linkgrabber),
        })
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{}.json", name))
    }

    /// A clone of the settings document (cheap enough, and never holds the borrow).
    pub fn settings(&self) -> Value {
        self.settings.borrow().clone()
    }

    /// Reads one settings value by path, e.g. `s(&["connection", "timeoutSec"])`.
    pub fn s(&self, path: &[&str]) -> Value {
        let st = self.settings.borrow();
        let mut v = &*st;
        for k in path {
            v = v.get(*k).unwrap_or(&Value::Null);
        }
        v.clone()
    }

    pub fn save(self: &Rc<Self>, name: &'static str) {
        self.save_after(name, 400);
    }

    pub fn save_after(self: &Rc<Self>, name: &'static str, delay_ms: u64) {
        // Keep a pending save rather than restarting it: requests arriving more often than the
        // delay (several running downloads) would otherwise postpone the write forever. The data
        // is read when the timer fires, so it is still the latest.
        if self.timers.borrow().contains_key(name) {
            return;
        }
        let me = self.clone();
        let h = tokio::task::spawn_local(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            me.timers.borrow_mut().remove(name);
            let _ = me.write(name).await;
        });
        self.timers.borrow_mut().insert(name, h);
    }

    fn data(&self, name: &str) -> Value {
        match name {
            "settings" => self.settings.borrow().clone(),
            "categories" => self.categories.borrow().clone(),
            "queues" => self.queues.borrow().clone(),
            "downloads" => self.serialize_downloads(),
            "grabber" => Value::Array(self.grabber.borrow().iter().map(|p| p.borrow().clone()).collect()),
            "linkgrabber" => serde_json::to_value(&*self.linkgrabber.borrow()).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }

    async fn write(&self, name: &str) -> crate::error::Result<()> {
        // Not on every save: downloads are saved every few seconds, and three backups seconds
        // apart would be worth one.
        let min = crate::js::num(&self.s(&["storage", "backupIntervalMin"]));
        let secs = if min.is_finite() && min > 0.0 { min } else { 10.0 } * 60.0;
        let due = self.rotated.borrow().get(name).is_none_or(|t| t.elapsed().as_secs_f64() >= secs);
        if due {
            self.backup(name).await;
        }
        let data = self.data(name);
        write_json_atomic(&self.file(name), &data).await
    }

    /// Rotates the backups of one file now.
    async fn backup(&self, name: &str) {
        self.rotated.borrow_mut().insert(name.to_string(), Instant::now());
        let file = self.file(name);
        let _ = tokio::task::spawn_blocking(move || rotate(&file)).await;
    }

    pub async fn flush(&self, name: &'static str) -> crate::error::Result<()> {
        if let Some(t) = self.timers.borrow_mut().remove(name) {
            t.abort();
        }
        self.write(name).await
    }

    pub async fn flush_all(&self) {
        for n in NAMES {
            // Clean shutdown: what was just saved becomes the newest backup.
            if self.flush(n).await.is_ok() {
                self.backup(n).await;
            }
        }
    }

    pub fn serialize_downloads(&self) -> Value {
        Value::Array(
            self.downloads
                .borrow()
                .iter()
                .map(|d| {
                    let mut v = d.borrow().to_value();
                    if let Some(o) = v.as_object_mut() {
                        o.remove("runtime");
                    }
                    v
                })
                .collect(),
        )
    }

    pub fn reset_settings(self: &Rc<Self>) {
        *self.settings.borrow_mut() = default_settings();
        self.save("settings");
    }
}

#[cfg(test)]
mod load_tests {
    use super::*;

    #[test]
    fn bom_files_load_and_unreadable_files_are_kept() {
        let dir = std::env::temp_dir().join(format!("opendm-store-load-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // UTF-8 with a byte-order mark, as Notepad or Windows PowerShell 5 write it.
        std::fs::write(dir.join("settings.json"), "\u{feff}{\"connection\":{\"maxConnections\":5}}").unwrap();
        std::fs::write(dir.join("downloads.json"), "[{\"id\":\"a\",\"url\":\"http://h/a\"").unwrap(); // cut short
        let s = Store::new(&dir);
        assert_eq!(s.settings.borrow()["connection"]["maxConnections"], 5);
        assert!(s.downloads.borrow().is_empty());
        let kept = named(&dir, "downloads.json.corrupt-");
        assert_eq!(kept.len(), 1, "the unreadable list was not kept aside");
        assert_eq!(std::fs::read_to_string(dir.join(&kept[0])).unwrap(), "[{\"id\":\"a\",\"url\":\"http://h/a\"");
        assert!(s.restored.borrow().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Rotating backups (R15).

    const LIST: &str = "[{\"id\":\"a\",\"url\":\"http://h/a\"}]";
    const BROKEN: &str = "[{\"id\":\"a\",\"url\":";

    fn fresh(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("opendm-store-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Names in `dir` that start with `prefix`.
    fn named(dir: &Path, prefix: &str) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(prefix)).collect()
    }

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn a_corrupt_list_is_loaded_from_its_backup_and_kept_aside() {
        let dir = fresh("bak");
        std::fs::write(dir.join("downloads.json"), BROKEN).unwrap();
        std::fs::write(dir.join("downloads.json.bak"), LIST).unwrap();
        let s = Store::new(&dir);
        assert_eq!(s.downloads.borrow().len(), 1, "the backup was not loaded");
        assert_eq!(*s.restored.borrow(), vec!["downloads"], "no notice for the restored list");
        let kept = named(&dir, "downloads.json.corrupt-");
        assert_eq!(kept.len(), 1, "the corrupt list was not kept");
        assert_eq!(std::fs::read_to_string(dir.join(&kept[0])).unwrap(), BROKEN);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_list_falls_back_to_the_first_backup_that_parses() {
        let dir = fresh("bak1");
        std::fs::write(dir.join("downloads.json.bak"), BROKEN).unwrap();
        std::fs::write(dir.join("downloads.json.1.bak"), LIST).unwrap();
        let s = Store::new(&dir);
        assert_eq!(s.downloads.borrow().len(), 1, "the older backup was not loaded");
        assert_eq!(*s.restored.borrow(), vec!["downloads"]);
        assert_eq!(named(&dir, "downloads.json.bak.corrupt-").len(), 1, "the corrupt backup was not kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn when_every_copy_is_corrupt_the_list_starts_empty_and_all_files_are_kept() {
        let dir = fresh("allbad");
        for n in ["downloads.json", "downloads.json.bak", "downloads.json.1.bak", "downloads.json.2.bak"] {
            std::fs::write(dir.join(n), BROKEN).unwrap();
        }
        let s = Store::new(&dir);
        assert!(s.downloads.borrow().is_empty());
        assert!(s.restored.borrow().is_empty(), "nothing was restored");
        for n in ["downloads.json.corrupt-", "downloads.json.bak.corrupt-", "downloads.json.1.bak.corrupt-", "downloads.json.2.bak.corrupt-"] {
            let kept = named(&dir, n);
            assert_eq!(kept.len(), 1, "{n}* was not kept");
            assert_eq!(std::fs::read_to_string(dir.join(&kept[0])).unwrap(), BROKEN);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backups_rotate_at_startup_and_shutdown_but_not_on_every_save() {
        let dir = fresh("rotate");
        std::fs::write(dir.join("downloads.json"), LIST).unwrap();
        let s = Store::new(&dir);
        // Startup: the list that just loaded becomes the newest backup.
        assert_eq!(std::fs::read_to_string(dir.join("downloads.json.bak")).unwrap(), LIST, "no backup after a successful load");
        block(async {
            for i in 0..100 {
                s.downloads.borrow()[0].borrow_mut().description = format!("save {i}");
                s.flush("downloads").await.unwrap();
            }
        });
        assert_eq!(std::fs::read_to_string(dir.join("downloads.json.bak")).unwrap(), LIST, "a save inside the interval rotated the backups");
        assert!(!dir.join("downloads.json.1.bak").exists(), "a save inside the interval rotated the backups");
        // Clean shutdown.
        block(s.flush_all());
        assert_eq!(std::fs::read_to_string(dir.join("downloads.json.1.bak")).unwrap(), LIST, "shutdown did not rotate");
        let latest = std::fs::read_to_string(dir.join("downloads.json")).unwrap();
        assert!(latest.contains("save 99"));
        assert_eq!(std::fs::read_to_string(dir.join("downloads.json.bak")).unwrap(), latest);
        // The next start finds the newest backup already equal to the list: nothing to rotate.
        let _again = Store::new(&dir);
        assert!(!dir.join("downloads.json.2.bak").exists(), "an unchanged list pushed out an older backup");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_after_the_backup_interval_rotates_once() {
        let dir = fresh("interval");
        std::fs::write(dir.join("downloads.json"), LIST).unwrap();
        let s = Store::new(&dir);
        // 0.0005 min = 30 ms.
        s.settings.borrow_mut()["storage"]["backupIntervalMin"] = serde_json::json!(0.0005);
        block(async {
            s.downloads.borrow()[0].borrow_mut().description = "first".into();
            s.flush("downloads").await.unwrap();
            tokio::time::sleep(Duration::from_millis(60)).await;
            s.downloads.borrow()[0].borrow_mut().description = "second".into();
            s.flush("downloads").await.unwrap();
        });
        assert!(std::fs::read_to_string(dir.join("downloads.json.bak")).unwrap().contains("first"), "the list on disk did not become the backup");
        assert_eq!(std::fs::read_to_string(dir.join("downloads.json.1.bak")).unwrap(), LIST);
        assert!(!dir.join("downloads.json.2.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn backups_are_owner_only_like_the_file_they_copy() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh("perm");
        let s = Store::new(&dir);
        block(async {
            s.flush("settings").await.unwrap();
            s.flush_all().await;
        });
        let mode = |n: &str| std::fs::metadata(dir.join(n)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("settings.json"), 0o600);
        assert_eq!(mode("settings.json.bak"), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Per-item event log (R9).

    #[test]
    fn the_event_log_keeps_the_last_50_entries_and_survives_a_restart() {
        let dir = fresh("log");
        std::fs::write(dir.join("downloads.json"), LIST).unwrap();
        let s = Store::new(&dir);
        {
            let d = s.downloads.borrow();
            let mut it = d[0].borrow_mut();
            for i in 0..60 {
                it.log("test", format!("entry {i}"));
            }
            it.log("test", "é".repeat(400));
        }
        block(s.flush("downloads")).unwrap();
        let again = Store::new(&dir);
        let d = again.downloads.borrow();
        let log = &d[0].borrow().log;
        assert_eq!(log.len(), 50, "the log is not capped at 50 entries");
        assert_eq!(log[0].text, "entry 11", "the oldest entries were not the ones dropped");
        assert_eq!(log[49].text.chars().count(), 300, "a long text was not cut to 300 characters");
        assert_eq!(log[48].kind, "test");
        assert!(log[48].ts_ms > 1.6e12, "no timestamp");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
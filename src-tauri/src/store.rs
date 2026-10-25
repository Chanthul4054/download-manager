//! JSON-file persistence with debounced atomic writes (port of src/main/store.js). The files and
//! their layout are the same as the Electron version's, in the same folder.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

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

pub struct Store {
    pub dir: PathBuf,
    timers: RefCell<HashMap<&'static str, JoinHandle<()>>>,
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
        Rc::new(Store {
            dir: dir.to_path_buf(),
            timers: RefCell::new(HashMap::new()),
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
        if let Some(t) = self.timers.borrow_mut().remove(name) {
            t.abort();
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
        let data = self.data(name);
        write_json_atomic(&self.file(name), &data).await
    }

    pub async fn flush(&self, name: &'static str) -> crate::error::Result<()> {
        if let Some(t) = self.timers.borrow_mut().remove(name) {
            t.abort();
        }
        self.write(name).await
    }

    pub async fn flush_all(&self) {
        for n in NAMES {
            let _ = self.flush(n).await;
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

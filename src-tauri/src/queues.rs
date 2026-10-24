//! Download/synchronization queues with a scheduler (port of src/main/queues.js).
//!  - download queue: downloads N files at a time; completed files leave the queue; a failed file
//!    moves to the end; a lone failing file is retried every 30s (or up to `retries` times).
//!  - sync queue: re-checks every file; changed files are re-downloaded; files stay in the queue.
//! Emits: changed(queues) · started(id) · stopped(id) · finished(queue) — finished only when the
//! queue ran out of work (not when stopped manually).

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};

use chrono::{Datelike, NaiveDateTime, Timelike};
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::defaults::{default_on_complete, default_schedule};
use crate::emitter::Emitter;
use crate::engine::interval;
use crate::js::{self, now_ms};
use crate::manager::{DownloadManager, MgrEvent};
use crate::store::Store;
use crate::util::id as new_id;

const RETRY_ALONE_MS: f64 = 30000.0;

pub fn hhmm(d: &NaiveDateTime) -> String {
    format!("{:02}:{:02}", d.hour(), d.minute())
}

pub fn ymd(d: &NaiveDateTime) -> String {
    format!("{}-{:02}-{:02}", d.year(), d.month(), d.day())
}

#[derive(Clone)]
pub enum QEvent {
    Changed(Vec<Value>),
    Started(String),
    Stopped(String),
    Finished(Value),
}

#[derive(Default)]
struct Run {
    started: RefCell<Vec<String>>,
    attempts: RefCell<HashMap<String, u32>>,
    retry_at: RefCell<HashMap<String, f64>>,
    synced: RefCell<HashSet<String>>,
    manual_stop: Cell<bool>,
    checking: RefCell<HashSet<String>>,
}

impl Run {
    fn started_has(&self, id: &str) -> bool {
        self.started.borrow().iter().any(|x| x == id)
    }
    fn started_add(&self, id: &str) {
        if !self.started_has(id) {
            self.started.borrow_mut().push(id.to_string());
        }
    }
    fn started_delete(&self, id: &str) {
        self.started.borrow_mut().retain(|x| x != id);
    }
}

pub struct QueueManager {
    me: RefCell<Weak<QueueManager>>,
    store: Rc<Store>,
    manager: Rc<DownloadManager>,
    running: RefCell<Vec<(String, Rc<Run>)>>,
    last_fired: RefCell<HashSet<String>>,
    timers: RefCell<Vec<JoinHandle<()>>>,
    listener: Cell<u64>,
    pub events: Emitter<QEvent>,
}

fn items_of(q: &Value) -> Vec<String> {
    js::get(q, "items").as_array().map(|a| a.iter().map(js::str_of).collect()).unwrap_or_default()
}

fn set_items(q: &mut Value, items: Vec<String>) {
    *js::get_mut(q, "items") = json!(items);
}

impl QueueManager {
    pub fn new(store: Rc<Store>, manager: Rc<DownloadManager>) -> Rc<QueueManager> {
        let q = Rc::new(QueueManager {
            me: RefCell::new(Weak::new()),
            store,
            manager: manager.clone(),
            running: RefCell::new(Vec::new()),
            last_fired: RefCell::new(HashSet::new()),
            timers: RefCell::new(Vec::new()),
            listener: Cell::new(0),
            events: Emitter::default(),
        });
        *q.me.borrow_mut() = Rc::downgrade(&q);
        let w = Rc::downgrade(&q);
        let lid = manager.events.on(move |e| {
            let Some(q) = w.upgrade() else { return };
            match e {
                MgrEvent::Enqueue(item, qid) => q.add_items(qid, &[item.clone()], false),
                MgrEvent::Complete(it) => q.on_item_done(js::s(js::get(it, "id")), true),
                MgrEvent::Failed(it, _) => q.on_item_done(js::s(js::get(it, "id")), false),
                MgrEvent::Stopped(id) => q.on_item_stopped(id),
                MgrEvent::Removed(ids) => q.purge(ids),
                _ => {}
            }
        });
        q.listener.set(lid);
        let (w1, w2, w3) = (Rc::downgrade(&q), Rc::downgrade(&q), Rc::downgrade(&q));
        q.timers.borrow_mut().push(interval(1000, move || {
            if let Some(q) = w1.upgrade() {
                q.tick();
            }
        }));
        q.timers.borrow_mut().push(interval(15000, move || {
            if let Some(q) = w2.upgrade() {
                q.check_schedules(chrono::Local::now().naive_local());
            }
        }));
        q.timers.borrow_mut().push(tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            if let Some(q) = w3.upgrade() {
                q.check_schedules(chrono::Local::now().naive_local());
            }
        }));
        q
    }

    fn rc(&self) -> Rc<QueueManager> {
        self.me.borrow().upgrade().expect("queues alive")
    }

    pub fn ids(&self) -> Vec<String> {
        self.store.queues.borrow().as_array().map(|a| a.iter().map(|q| js::str_of(js::get(q, "id"))).collect()).unwrap_or_default()
    }

    /// A copy of one queue.
    pub fn get(&self, id: &str) -> Option<Value> {
        self.store.queues.borrow().as_array()?.iter().find(|q| js::s(js::get(q, "id")) == id).cloned()
    }

    fn with_queue<R>(&self, id: &str, f: impl FnOnce(&mut Value) -> R) -> Option<R> {
        let mut qs = self.store.queues.borrow_mut();
        let q = qs.as_array_mut()?.iter_mut().find(|q| js::s(js::get(q, "id")) == id)?;
        Some(f(q))
    }

    fn is_running(&self, id: &str) -> bool {
        self.running.borrow().iter().any(|(x, _)| x == id)
    }

    fn run_of(&self, id: &str) -> Option<Rc<Run>> {
        self.running.borrow().iter().find(|(x, _)| x == id).map(|(_, r)| r.clone())
    }

    pub fn save(&self) {
        self.store.save("queues");
        let l = self.list();
        self.events.emit(QEvent::Changed(l));
    }

    pub fn list(&self) -> Vec<Value> {
        let qs = self.store.queues.borrow().as_array().cloned().unwrap_or_default();
        qs.into_iter()
            .map(|mut q| {
                let id = js::str_of(js::get(&q, "id"));
                *js::get_mut(&mut q, "running") = json!(self.is_running(&id));
                q
            })
            .collect()
    }

    pub fn create(&self, name: &str, kind: &str) -> Value {
        let kind = if kind.is_empty() { "download" } else { kind };
        let mut q = json!({
            "id": new_id(), "name": if name.is_empty() { "New queue" } else { name }, "type": kind, "builtin": false,
            "maxConcurrent": 1, "retries": 0, "items": [], "schedule": default_schedule(), "onComplete": default_on_complete(),
        });
        if kind == "sync" {
            q["schedule"]["periodic"] = json!(true);
        }
        if let Some(a) = self.store.queues.borrow_mut().as_array_mut() {
            a.push(q.clone());
        }
        self.save();
        q
    }

    pub fn update(&self, id: &str, patch: &Value) -> Value {
        let r = self.with_queue(id, |q| {
            for k in ["name", "maxConcurrent", "retries", "schedule", "onComplete", "items"] {
                if let Some(v) = patch.get(k) {
                    *js::get_mut(q, k) = v.clone();
                }
            }
            if let Some(t) = patch.get("type") {
                if !js::truthy(js::get(q, "builtin")) {
                    *js::get_mut(q, "type") = t.clone();
                }
            }
            q.clone()
        });
        match r {
            Some(q) => {
                self.save();
                q
            }
            None => Value::Null,
        }
    }

    pub fn remove(&self, id: &str) -> bool {
        match self.get(id) {
            Some(q) if !js::truthy(js::get(&q, "builtin")) => {}
            _ => return false,
        }
        self.stop(id, true);
        if let Some(a) = self.store.queues.borrow_mut().as_array_mut() {
            a.retain(|q| js::s(js::get(q, "id")) != id);
        }
        self.save();
        true
    }

    pub fn add_items(&self, qid: &str, ids: &[String], top: bool) {
        let Some(q) = self.get(qid) else { return };
        let kind = js::str_of(js::get(&q, "type"));
        let current = items_of(&q);
        let fresh: Vec<String> = ids
            .iter()
            .filter(|id| {
                !current.contains(id)
                    && (kind == "sync" || self.manager.get(id).map(|it| it.borrow().status != "complete").unwrap_or(true))
            })
            .cloned()
            .collect();
        {
            let mut qs = self.store.queues.borrow_mut();
            let Some(all) = qs.as_array_mut() else { return };
            // An item belongs to only one download queue at a time.
            if kind == "download" {
                for other in all.iter_mut() {
                    if js::s(js::get(other, "id")) != qid && js::s(js::get(other, "type")) == "download" {
                        let kept: Vec<String> = items_of(other).into_iter().filter(|x| !fresh.contains(x)).collect();
                        set_items(other, kept);
                    }
                }
            }
            if let Some(q) = all.iter_mut().find(|q| js::s(js::get(q, "id")) == qid) {
                let items = items_of(q);
                let next = if top { [fresh.clone(), items].concat() } else { [items, fresh.clone()].concat() };
                set_items(q, next);
            }
        }
        self.save();
    }

    pub fn remove_items(&self, qid: &str, ids: &[String]) {
        let ok = self.with_queue(qid, |q| {
            let kept: Vec<String> = items_of(q).into_iter().filter(|x| !ids.contains(x)).collect();
            set_items(q, kept);
        });
        if ok.is_some() {
            self.save();
        }
    }

    pub fn move_items(&self, qid: &str, ids: &[String], dir: &str) {
        let ok = self.with_queue(qid, |q| {
            let mut items = items_of(q);
            let sel: HashSet<&String> = ids.iter().collect();
            if dir == "top" || dir == "bottom" {
                let picked: Vec<String> = items.iter().filter(|x| sel.contains(x)).cloned().collect();
                let rest: Vec<String> = items.iter().filter(|x| !sel.contains(x)).cloned().collect();
                items = if dir == "top" { [picked, rest].concat() } else { [rest, picked].concat() };
            } else {
                let up = dir == "up";
                let n = items.len() as isize;
                let order: Vec<isize> = if up { (0..n).collect() } else { (0..n).rev().collect() };
                for i in order {
                    if !sel.contains(&items[i as usize]) {
                        continue;
                    }
                    let j = if up { i - 1 } else { i + 1 };
                    if j < 0 || j >= n || sel.contains(&items[j as usize]) {
                        continue;
                    }
                    items.swap(i as usize, j as usize);
                }
            }
            set_items(q, items);
        });
        if ok.is_some() {
            self.save();
        }
    }

    pub fn purge(&self, ids: &[String]) {
        {
            let mut qs = self.store.queues.borrow_mut();
            if let Some(all) = qs.as_array_mut() {
                for q in all.iter_mut() {
                    let kept: Vec<String> = items_of(q).into_iter().filter(|x| !ids.contains(x)).collect();
                    set_items(q, kept);
                }
            }
        }
        self.save();
    }

    // ---- running -------------------------------------------------------------------------------

    pub fn start(&self, id: &str) {
        if self.get(id).is_none() || self.is_running(id) {
            return;
        }
        self.running.borrow_mut().push((id.to_string(), Rc::new(Run::default())));
        self.events.emit(QEvent::Started(id.to_string()));
        self.save();
        self.tick();
    }

    pub fn stop(&self, id: &str, manual: bool) {
        let Some(r) = self.run_of(id) else { return };
        r.manual_stop.set(manual);
        self.running.borrow_mut().retain(|(x, _)| x != id);
        let started = r.started.borrow().clone();
        for item in started {
            self.manager.stop(&item, None);
        }
        self.events.emit(QEvent::Stopped(id.to_string()));
        self.save();
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.running.borrow().iter().map(|(x, _)| x.clone()).collect();
        for id in ids {
            self.stop(&id, true);
        }
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.running.borrow().iter().map(|(x, _)| x.clone()).collect()
    }

    fn on_item_stopped(&self, item_id: &str) {
        let runs: Vec<Rc<Run>> = self.running.borrow().iter().map(|(_, r)| r.clone()).collect();
        for r in runs {
            r.started_delete(item_id);
        }
    }

    fn on_item_done(&self, item_id: &str, ok: bool) {
        let runs: Vec<(String, Rc<Run>)> = self.running.borrow().clone();
        for (qid, r) in runs {
            if !r.started_has(item_id) {
                continue;
            }
            r.started_delete(item_id);
            let kind = self.get(&qid).map(|q| js::str_of(js::get(&q, "type"))).unwrap_or_default();
            if ok {
                if kind == "download" {
                    self.with_queue(&qid, |q| {
                        let kept: Vec<String> = items_of(q).into_iter().filter(|x| x != item_id).collect();
                        set_items(q, kept);
                    });
                } else {
                    r.synced.borrow_mut().insert(item_id.to_string());
                }
            } else {
                *r.attempts.borrow_mut().entry(item_id.to_string()).or_insert(0) += 1;
                r.retry_at.borrow_mut().insert(item_id.to_string(), now_ms() + RETRY_ALONE_MS);
                self.with_queue(&qid, |q| {
                    let mut items: Vec<String> = items_of(q).into_iter().filter(|x| x != item_id).collect();
                    items.push(item_id.to_string());
                    set_items(q, items);
                });
            }
            self.save();
        }
        // Remove completed files from any download queue they belong to.
        if ok {
            for qid in self.ids() {
                let hit = self
                    .with_queue(&qid, |q| {
                        if js::s(js::get(q, "type")) == "download" && items_of(q).iter().any(|x| x == item_id) {
                            let kept: Vec<String> = items_of(q).into_iter().filter(|x| x != item_id).collect();
                            set_items(q, kept);
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false);
                if hit {
                    self.save();
                }
            }
        }
    }

    fn exhausted(q: &Value, r: &Run, item_id: &str) -> bool {
        let retries = js::num(js::get(q, "retries"));
        retries > 0.0 && (*r.attempts.borrow().get(item_id).unwrap_or(&0) as f64) >= retries
    }

    pub fn tick(&self) {
        let runs: Vec<(String, Rc<Run>)> = self.running.borrow().clone();
        for (qid, r) in runs {
            let Some(q) = self.get(&qid) else {
                self.running.borrow_mut().retain(|(x, _)| *x != qid);
                continue;
            };
            let now = now_ms();
            let sync = js::s(js::get(&q, "type")) == "sync";
            let pending: Vec<String> = items_of(&q)
                .into_iter()
                .filter(|id| {
                    let Some(it) = self.manager.get(id) else { return false };
                    if sync {
                        return !r.synced.borrow().contains(id);
                    }
                    it.borrow().status != "complete" && !Self::exhausted(&q, &r, id)
                })
                .collect();
            let busy = r.started.borrow().len() + r.checking.borrow().len();
            if pending.is_empty() && busy == 0 {
                self.finish(&q, &r);
                continue;
            }
            let mc = js::num(js::get(&q, "maxConcurrent"));
            // Math.max(1, NaN) is NaN, and `NaN <= 0` never stops the loop.
            let mut slots = if mc.is_nan() { f64::INFINITY } else { mc.max(1.0) - busy as f64 };
            for id in pending {
                if slots <= 0.0 {
                    break;
                }
                if r.started_has(&id) || r.checking.borrow().contains(&id) {
                    continue;
                }
                if self.manager.is_active(&id) {
                    continue; // already running outside the queue
                }
                // A failed file was moved to the end of the queue; it is retried after 30s.
                if *r.retry_at.borrow().get(&id).unwrap_or(&0.0) > now {
                    continue;
                }
                slots -= 1.0;
                if sync {
                    let me = self.rc();
                    let (q2, r2, id2) = (q.clone(), r.clone(), id.clone());
                    r.checking.borrow_mut().insert(id.clone());
                    tokio::task::spawn_local(async move { me.sync_item(&q2, &r2, &id2).await });
                } else {
                    r.started_add(&id);
                    if !self.manager.start(&id) {
                        r.started_delete(&id);
                    }
                }
            }
        }
    }

    async fn sync_item(&self, q: &Value, r: &Rc<Run>, id: &str) {
        let qid = js::str_of(js::get(q, "id"));
        let res: crate::error::Result<()> = async {
            let it = self.manager.get(id).ok_or_else(|| crate::error::Error::new("Cannot read properties of undefined (reading 'status')"))?;
            let complete = it.borrow().status == "complete";
            let changed = !complete || self.manager.remote_changed(id).await?;
            if !self.is_running(&qid) {
                return Ok(());
            }
            if changed {
                r.started_add(id);
                if complete {
                    self.manager.redownload(id, true).await;
                } else {
                    self.manager.start(id);
                }
            } else {
                r.synced.borrow_mut().insert(id.to_string());
            }
            Ok(())
        }
        .await;
        if res.is_err() {
            *r.attempts.borrow_mut().entry(id.to_string()).or_insert(0) += 1;
            r.retry_at.borrow_mut().insert(id.to_string(), now_ms() + RETRY_ALONE_MS);
            if Self::exhausted(q, r, id) {
                r.synced.borrow_mut().insert(id.to_string());
            }
        }
        r.checking.borrow_mut().remove(id);
    }

    fn finish(&self, q: &Value, r: &Rc<Run>) {
        let id = js::str_of(js::get(q, "id"));
        self.running.borrow_mut().retain(|(x, _)| *x != id);
        self.events.emit(QEvent::Stopped(id));
        self.save();
        if !r.manual_stop.get() {
            self.events.emit(QEvent::Finished(q.clone()));
        }
    }

    // ---- scheduler -----------------------------------------------------------------------------

    fn day_matches(s: &Value, d: &NaiveDateTime) -> bool {
        if js::s(js::get(s, "mode")) == "once" {
            return js::s(js::get(s, "onceDate")) == ymd(d);
        }
        let day = d.weekday().num_days_from_sunday() as f64;
        js::get(s, "days").as_array().is_some_and(|a| a.iter().any(|x| js::num(x) == day))
    }

    fn fire(&self, key: String) -> bool {
        self.last_fired.borrow_mut().insert(key)
    }

    pub fn check_schedules(&self, now: NaiveDateTime) {
        let t = hhmm(&now);
        let day = ymd(&now);
        let queues = self.store.queues.borrow().as_array().cloned().unwrap_or_default();
        for q in queues {
            let id = js::str_of(js::get(&q, "id"));
            let s = js::get(&q, "schedule").clone();
            let today_ok = Self::day_matches(&s, &now);
            let start_time = js::str_of(js::get(&s, "startTime"));
            let stop_time = js::str_of(js::get(&s, "stopTime"));
            let start_enabled = js::truthy(js::get(&s, "startEnabled"));
            let stop_enabled = js::truthy(js::get(&s, "stopEnabled"));
            if start_enabled && today_ok && t == start_time && self.fire(format!("{}|start|{}|{}", id, day, t)) {
                self.start(&id);
            }
            if stop_enabled && t == stop_time && self.fire(format!("{}|stop|{}|{}", id, day, t)) {
                self.stop(&id, true);
            }
            // Periodic synchronization: rerun every N minutes after the start time, until stop time or midnight.
            if js::truthy(js::get(&s, "periodic"))
                && js::s(js::get(&q, "type")) == "sync"
                && start_enabled
                && today_ok
                && t >= start_time
                && (!stop_enabled || t < stop_time)
            {
                let start_min = js::num(&json!(crate::util::js_slice(&start_time, 0, 2))) * 60.0 + js::num(&json!(crate::util::js_slice(&start_time, 3, 99)));
                let now_min = (now.hour() * 60 + now.minute()) as f64;
                let every = js::num_or(js::get(&s, "everyMinutes"), 60.0).max(1.0);
                if (now_min - start_min) % every == 0.0 && !self.is_running(&id) && self.fire(format!("{}|periodic|{}|{}", id, day, t)) {
                    self.start(&id);
                }
            }
        }
        if self.last_fired.borrow().len() > 500 {
            self.last_fired.borrow_mut().clear();
        }
    }

    pub fn dispose(&self) {
        for t in self.timers.borrow_mut().drain(..) {
            t.abort();
        }
        self.manager.events.off(self.listener.get());
    }
}

'use strict';
const { EventEmitter } = require('events');
const u = require('./util');
const { defaultSchedule, defaultOnComplete } = require('./defaults');

const RETRY_ALONE_MS = 30000;

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Download/synchronization queues with a scheduler.
 *  - download queue: downloads N files at a time; completed files leave the queue; a failed file
 *    moves to the end; a lone failing file is retried every 30s (or up to `retries` times).
 *  - sync queue: re-checks every file; changed files are re-downloaded; files stay in the queue.
 * Emits: changed(queues) · started(id) · stopped(id) · finished(queue) — finished only when the
 * queue ran out of work (not when stopped manually).
 */
class QueueManager extends EventEmitter {
  constructor(store, manager) {
    super();
    this.store = store;
    this.manager = manager;
    this.running = new Map(); // id -> { started:Set, attempts:Map, retryAt:Map, synced:Set, manualStop }
    this.lastFired = new Map();
    manager.on('enqueue', (itemId, qid) => this.addItems(qid, [itemId]));
    manager.on('complete', (item) => this.onItemDone(item.id, true));
    manager.on('failed', (item) => this.onItemDone(item.id, false));
    manager.on('stopped', (id) => this.onItemStopped(id));
    manager.on('removed', (ids) => this.purge(ids));
    this.timer = setInterval(() => this.tick(), 1000);
    this.schedTimer = setInterval(() => this.checkSchedules(), 15000);
    setTimeout(() => this.checkSchedules(), 2000);
  }

  get queues() {
    return this.store.queues;
  }

  get(id) {
    return this.queues.find((q) => q.id === id);
  }

  save() {
    this.store.save('queues');
    this.emit('changed', this.list());
  }

  list() {
    return this.queues.map((q) => ({ ...q, running: this.running.has(q.id) }));
  }

  create(name, type = 'download') {
    const q = { id: u.id(), name: name || 'New queue', type, builtin: false, maxConcurrent: 1, retries: 0, items: [], schedule: defaultSchedule(), onComplete: defaultOnComplete() };
    if (type === 'sync') q.schedule.periodic = true;
    this.queues.push(q);
    this.save();
    return q;
  }

  update(id, patch) {
    const q = this.get(id);
    if (!q) return null;
    for (const k of ['name', 'maxConcurrent', 'retries', 'schedule', 'onComplete', 'items']) if (k in patch) q[k] = patch[k];
    if ('type' in patch && !q.builtin) q.type = patch.type;
    this.save();
    return q;
  }

  remove(id) {
    const q = this.get(id);
    if (!q || q.builtin) return false;
    this.stop(id, true);
    this.store.queues = this.queues.filter((x) => x.id !== id);
    this.save();
    return true;
  }

  queuesOf(itemId) {
    return this.queues.filter((q) => q.items.includes(itemId)).map((q) => q.id);
  }

  addItems(qid, ids, { top = false } = {}) {
    const q = this.get(qid);
    if (!q) return;
    const fresh = ids.filter((id) => !q.items.includes(id) && (q.type === 'sync' || this.manager.get(id)?.status !== 'complete'));
    // An item belongs to only one download queue at a time.
    if (q.type === 'download') for (const other of this.queues) if (other !== q && other.type === 'download') other.items = other.items.filter((x) => !fresh.includes(x));
    q.items = top ? [...fresh, ...q.items] : [...q.items, ...fresh];
    this.save();
  }

  removeItems(qid, ids) {
    const q = this.get(qid);
    if (!q) return;
    q.items = q.items.filter((x) => !ids.includes(x));
    this.save();
  }

  move(qid, ids, dir) {
    const q = this.get(qid);
    if (!q) return;
    const items = q.items.slice();
    const sel = new Set(ids);
    if (dir === 'top' || dir === 'bottom') {
      const picked = items.filter((x) => sel.has(x));
      const rest = items.filter((x) => !sel.has(x));
      q.items = dir === 'top' ? [...picked, ...rest] : [...rest, ...picked];
    } else {
      const step = dir === 'up' ? -1 : 1;
      const order = step < 0 ? items.map((_, i) => i) : items.map((_, i) => items.length - 1 - i);
      for (const i of order) {
        if (!sel.has(items[i])) continue;
        const j = i + step;
        if (j < 0 || j >= items.length || sel.has(items[j])) continue;
        [items[i], items[j]] = [items[j], items[i]];
      }
      q.items = items;
    }
    this.save();
  }

  purge(ids) {
    for (const q of this.queues) q.items = q.items.filter((x) => !ids.includes(x));
    this.save();
  }

  // ---- running -------------------------------------------------------------------------------

  start(id) {
    const q = this.get(id);
    if (!q || this.running.has(id)) return;
    this.running.set(id, { started: new Set(), attempts: new Map(), retryAt: new Map(), synced: new Set(), manualStop: false, checking: new Set() });
    this.emit('started', id);
    this.save();
    this.tick();
  }

  stop(id, manual = true) {
    const r = this.running.get(id);
    if (!r) return;
    r.manualStop = manual;
    this.running.delete(id);
    for (const itemId of r.started) this.manager.stop(itemId);
    this.emit('stopped', id);
    this.save();
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id, true);
  }

  onItemStopped(itemId) {
    for (const r of this.running.values()) r.started.delete(itemId);
  }

  onItemDone(itemId, ok) {
    for (const [qid, r] of this.running) {
      if (!r.started.has(itemId)) continue;
      r.started.delete(itemId);
      const q = this.get(qid);
      if (ok) {
        if (q.type === 'download') q.items = q.items.filter((x) => x !== itemId);
        else r.synced.add(itemId);
      } else {
        r.attempts.set(itemId, (r.attempts.get(itemId) || 0) + 1);
        r.retryAt.set(itemId, Date.now() + RETRY_ALONE_MS);
        q.items = [...q.items.filter((x) => x !== itemId), itemId];
      }
      this.save();
    }
    // Remove completed files from any download queue they belong to.
    if (ok) for (const q of this.queues) if (q.type === 'download' && q.items.includes(itemId)) {
      q.items = q.items.filter((x) => x !== itemId);
      this.save();
    }
  }

  exhausted(q, r, itemId) {
    return q.retries > 0 && (r.attempts.get(itemId) || 0) >= q.retries;
  }

  tick() {
    for (const [qid, r] of [...this.running]) {
      const q = this.get(qid);
      if (!q) {
        this.running.delete(qid);
        continue;
      }
      const now = Date.now();
      const pending = q.items.filter((id) => {
        const it = this.manager.get(id);
        if (!it) return false;
        if (q.type === 'sync') return !r.synced.has(id);
        return it.status !== 'complete' && !this.exhausted(q, r, id);
      });
      const busy = [...r.started].length + r.checking.size;
      if (!pending.length && !busy) {
        this.finish(q, r);
        continue;
      }
      let slots = Math.max(1, q.maxConcurrent) - busy;
      for (const id of pending) {
        if (slots <= 0) break;
        if (r.started.has(id) || r.checking.has(id)) continue;
        if (this.manager.isActive(id)) continue; // already running outside the queue
        // A failed file was moved to the end of the queue; it is retried after 30s.
        if ((r.retryAt.get(id) || 0) > now) continue;
        slots--;
        if (q.type === 'sync') this.syncItem(q, r, id);
        else {
          r.started.add(id);
          if (!this.manager.start(id)) r.started.delete(id);
        }
      }
    }
  }

  async syncItem(q, r, id) {
    r.checking.add(id);
    try {
      const it = this.manager.get(id);
      const changed = it.status !== 'complete' || (await this.manager.remoteChanged(id));
      if (!this.running.has(q.id)) return;
      if (changed) {
        r.started.add(id);
        if (it.status === 'complete') await this.manager.redownload(id, true);
        else this.manager.start(id);
      } else r.synced.add(id);
    } catch {
      r.attempts.set(id, (r.attempts.get(id) || 0) + 1);
      r.retryAt.set(id, Date.now() + RETRY_ALONE_MS);
      if (this.exhausted(q, r, id)) r.synced.add(id);
    } finally {
      r.checking.delete(id);
    }
  }

  finish(q, r) {
    this.running.delete(q.id);
    this.emit('stopped', q.id);
    this.save();
    if (!r.manualStop) this.emit('finished', q);
  }

  // ---- scheduler -----------------------------------------------------------------------------

  dayMatches(s, d) {
    if (s.mode === 'once') return s.onceDate === ymd(d);
    return (s.days || []).includes(d.getDay());
  }

  fire(key) {
    if (this.lastFired.get(key)) return false;
    this.lastFired.set(key, true);
    return true;
  }

  checkSchedules(now = new Date()) {
    const t = hhmm(now);
    const day = ymd(now);
    for (const q of this.queues) {
      const s = q.schedule || {};
      const todayOk = this.dayMatches(s, now);
      if (s.startEnabled && todayOk && t === s.startTime && this.fire(`${q.id}|start|${day}|${t}`)) this.start(q.id);
      if (s.stopEnabled && t === s.stopTime && this.fire(`${q.id}|stop|${day}|${t}`)) this.stop(q.id, true);
      // Periodic synchronization: rerun every N minutes after the start time, until stop time or midnight.
      if (s.periodic && q.type === 'sync' && s.startEnabled && todayOk && t >= s.startTime && (!s.stopEnabled || t < s.stopTime)) {
        const startMin = Number(s.startTime.slice(0, 2)) * 60 + Number(s.startTime.slice(3));
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const every = Math.max(1, Number(s.everyMinutes) || 60);
        if ((nowMin - startMin) % every === 0 && !this.running.has(q.id) && this.fire(`${q.id}|periodic|${day}|${t}`)) this.start(q.id);
      }
    }
    if (this.lastFired.size > 500) this.lastFired.clear();
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.schedTimer);
  }
}

module.exports = { QueueManager, hhmm, ymd };

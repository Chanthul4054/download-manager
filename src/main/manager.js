'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { HttpDownload } = require('./engine/http-download');
const { FtpDownload } = require('./engine/ftp-download');
const { HlsDownload } = require('./engine/hls-download');
const { MuxedDownload, muxedStats } = require('./engine/muxed-download');
const { YtDlpDownload, isVideoPage } = require('./engine/ytdlp');
const { RateLimiter } = require('./engine/limiter');
const u = require('./util');
const { diag, redactUrl } = require('./diag');

const ACTIVE = new Set(['downloading', 'connecting', 'waiting']);

/**
 * Owns the download list and running engines. Emits:
 *  changed(item) · removed(ids) · progress(id, stats) · complete(item) · failed(item, err) · quota(state)
 */
class DownloadManager extends EventEmitter {
  constructor(store, net) {
    super();
    this.store = store;
    this.net = net;
    this.engines = new Map();
    this.waiting = []; // ids started while every slot was busy, in order
    this.globalLimiter = new RateLimiter(0);
    this.quotaLog = []; // [minuteStamp, bytes]
    this.quotaPaused = new Set();
    for (const d of store.downloads) {
      if (ACTIVE.has(d.status)) d.status = 'paused';
      if (d.segments) for (const s of d.segments) if (s.end == null) s.end = Infinity;
    }
    this.applySpeedLimiter();
    this.quotaTimer = setInterval(() => this.checkQuota(), 10000);
  }

  get settings() {
    return this.store.settings;
  }

  get items() {
    return this.store.downloads;
  }

  get(id) {
    return this.items.find((d) => d.id === id);
  }

  persist() {
    this.store.save('downloads', 1000);
  }

  touch(item) {
    this.persist();
    this.emit('changed', this.publicItem(item));
  }

  publicItem(d) {
    const { segments, auth, cookies, parts, ...rest } = d;
    return {
      ...rest, hasAuth: !!auth, segmentCount: segments ? segments.length : 0, active: this.engines.has(d.id),
      parts: parts ? parts.map((x) => ({ role: x.role, label: x.label, size: x.size, ext: x.ext, done: !!x.done })) : undefined,
    };
  }

  list() {
    return this.items.map((d) => this.publicItem(d));
  }

  // ---- speed / quota -------------------------------------------------------------------------

  applySpeedLimiter() {
    const s = this.settings.speedLimiter;
    this.globalLimiter.setRate(s.enabled ? s.kbps * 1024 : 0);
  }

  onBytes(n) {
    const minute = Math.floor(Date.now() / 60000);
    const last = this.quotaLog[this.quotaLog.length - 1];
    if (last && last[0] === minute) last[1] += n;
    else this.quotaLog.push([minute, n]);
  }

  quotaUsage() {
    const q = this.settings.connection.quota;
    const since = Math.floor(Date.now() / 60000) - q.hours * 60;
    this.quotaLog = this.quotaLog.filter((e) => e[0] > since);
    return this.quotaLog.reduce((a, e) => a + e[1], 0);
  }

  checkQuota() {
    const q = this.settings.connection.quota;
    if (!q.enabled) {
      if (this.quotaPaused.size) this.resumeQuotaPaused();
      return;
    }
    const used = this.quotaUsage();
    if (used >= q.mb * 1024 * 1024) {
      for (const id of [...this.engines.keys()]) {
        this.quotaPaused.add(id);
        this.stop(id, 'Waiting: download limit reached');
      }
      if (this.quotaPaused.size) this.emit('quota', { exceeded: true, used });
    } else if (this.quotaPaused.size) this.resumeQuotaPaused();
  }

  resumeQuotaPaused() {
    const ids = [...this.quotaPaused];
    this.quotaPaused.clear();
    for (const id of ids) this.start(id);
    this.emit('quota', { exceeded: false });
  }

  maxConnFor(url) {
    const c = this.settings.connection;
    try {
      const host = new URL(url).hostname;
      const ex = (c.serverExceptions || []).find((e) => u.wildcardMatch(e.server, host) || u.wildcardMatch(e.server, '*.' + host));
      if (ex) return Math.max(1, Number(ex.maxConnections) || 1);
    } catch { /* invalid URL */ }
    return Math.max(1, Number(c.maxConnections) || 8);
  }

  // ---- categories / naming -------------------------------------------------------------------

  categoryForName(name) {
    const ext = u.extOf(name);
    if (!ext) return 'general';
    const cat = this.store.categories.find((c) => c.id !== 'general' && u.splitList(c.exts).some((p) => u.wildcardMatch(p, ext)));
    return cat ? cat.id : 'general';
  }

  folderForCategory(catId) {
    if (this.settings.saveTo.rememberLastPath && this.settings.lastSaveDirs[catId]) return this.settings.lastSaveDirs[catId];
    const cat = this.store.categories.find((c) => c.id === catId) || this.store.categories[0];
    return cat.folder;
  }

  guessName(url, given, mime) {
    let name = given || u.fileNameFromUrl(url) || 'download';
    if (/\.m3u8?$/i.test(name)) name = name.replace(/\.m3u8?$/i, '.ts');
    if (!u.extOf(name) && mime) name += u.extForMime(mime);
    return u.sanitizeFileName(name);
  }

  // Helps the "Download File Info" dialog: suggested name/category/folder for a URL.
  async describe(url, opts = {}) {
    const kind = opts.parts?.length ? 'muxed' : this.kindFor(url, opts.kind === 'muxed' ? null : opts.kind);
    let info = { size: opts.size || null, type: opts.mime || '', resumable: null, fileName: null };
    if (kind === 'http' && opts.probe !== false && !isGoogleVideo(url)) {
      try {
        const headers = {};
        if (opts.referer) headers.Referer = opts.referer;
        if (opts.cookies) headers.Cookie = opts.cookies;
        const p = await this.net.probe(url, { headers, auth: opts.auth, timeoutSec: 15 });
        info = { size: p.size, type: p.type, resumable: p.resumable, fileName: u.fileNameFromDisposition(p.headers['content-disposition']), status: p.status, finalUrl: p.url };
      } catch (e) {
        info.error = e.message;
        info.authRequired = e.code === 'EAUTH';
        info.realm = e.realm;
      }
    }
    const fileName = this.guessName(info.finalUrl || url, opts.fileName || info.fileName, info.type);
    const category = opts.category || this.categoryForName(fileName);
    return { ...info, kind, fileName, category, saveDir: opts.saveDir || this.folderForCategory(category) };
  }

  kindFor(url, explicit) {
    if (explicit) return explicit;
    if (isGoogleVideo(url)) return 'http';
    if (isVideoPage(url)) return 'ytdlp';
    if (/^ftp:/i.test(url)) return 'ftp';
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    return 'http';
  }

  findDuplicate(url) {
    return this.items.find((d) => d.url === url);
  }

  /**
   * Adds a download. opts: url, fileName, saveDir, category, description, referer, parentPage,
   * cookies, userAgent, auth, start (bool), queueId, kind, mime, duplicateAction override.
   * Returns { item, duplicate } — duplicate is set when the existing item was reused.
   */
  async add(opts) {
    const url = String(opts.url || '').trim();
    try {
      const p = new URL(url);
      if (!['http:', 'https:', 'ftp:'].includes(p.protocol)) throw new Error();
    } catch {
      throw new Error('Invalid address: ' + url);
    }
    const dup = this.findDuplicate(url);
    const action = opts.duplicateAction || this.settings.downloads.duplicateAction;
    if (dup && action === 'resume') {
      if (opts.start && dup.status !== 'complete') this.start(dup.id);
      return { item: this.publicItem(dup), duplicate: true };
    }
    if (dup && action === 'overwrite') this.remove([dup.id], false);

    const parts = Array.isArray(opts.parts) && opts.parts.length ? opts.parts.map((x) => ({
      role: x.role === 'audio' ? 'audio' : 'video', url: String(x.url), size: Number(x.size) || null, ext: String(x.ext || '').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin',
      label: x.label ? String(x.label).slice(0, 80) : '', contentType: x.mime || '',
    })) : null;
    let fileName = this.guessName(url, opts.fileName, opts.mime);
    if (!parts && this.kindFor(url, opts.kind) === 'ytdlp' && !opts.fileName) fileName = 'video.mp4';
    if (parts) fileName = u.sanitizeFileName(fileName.replace(/\.(mp4|webm|mkv|m4a|weba|bin)$/i, '') + '.' + containerFor(parts));
    const category = opts.category || this.categoryForName(fileName);
    const saveDir = opts.saveDir || this.folderForCategory(category);
    const gv = !parts && isGoogleVideo(url);
    const item = {
      id: u.id(),
      url,
      kind: parts ? 'muxed' : this.kindFor(url, opts.kind),
      parts,
      ytdlp: !parts && this.kindFor(url, opts.kind) === 'ytdlp' ? { quality: String(opts.ytdlp?.quality || 'best') } : undefined,
      rangeMode: gv ? 'query' : undefined,
      fileName,
      nameLocked: !!opts.fileName,
      saveDir,
      category,
      description: opts.description || '',
      referer: opts.referer || '',
      parentPage: opts.parentPage || opts.referer || '',
      cookies: opts.cookies || '',
      userAgent: opts.userAgent || '',
      auth: opts.auth && opts.auth.user ? opts.auth : null,
      status: 'paused',
      size: parts ? (parts.every((x) => x.size) ? parts.reduce((a, x) => a + x.size, 0) : null) : gv ? Number(new URL(url).searchParams.get('clen')) || opts.size || null : opts.size || null,
      downloaded: 0,
      resumable: null,
      added: Date.now(),
      lastTry: null,
      maxConnections: 0,
      speedLimitKB: 0,
      onComplete: { showDialog: null, exitApp: false, power: 'none' },
      hls: opts.hls || null,
      queues: [],
      overwrite: action === 'overwrite',
    };
    item.tempPath = path.join(this.settings.saveTo.tempDir, `${item.id}_${fileName}`);
    if (opts.rememberPath && this.settings.saveTo.rememberLastPath) {
      this.settings.lastSaveDirs[category] = saveDir;
      this.store.save('settings');
    }
    this.items.push(item);
    if (opts.queueId) this.emit('enqueue', item.id, opts.queueId);
    this.touch(item);
    if (opts.start) this.start(item.id);
    return { item: this.publicItem(item), duplicate: !!dup };
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  isActive(id) {
    return this.engines.has(id) || this.waiting.includes(id);
  }

  // downloads.maxSimultaneous caps running downloads across the app; 0 means no limit.
  hasFreeSlot() {
    const max = Number(this.settings.downloads.maxSimultaneous) || 0;
    return max <= 0 || this.engines.size < max;
  }

  // Starts waiting downloads while slots are free.
  admit() {
    while (this.waiting.length && this.hasFreeSlot()) this.start(this.waiting.shift());
  }

  activeCount() {
    return this.engines.size;
  }

  start(id) {
    const item = this.get(id);
    if (!item || this.engines.has(id)) return false;
    if (item.status === 'complete') return false;
    this.quotaPaused.delete(id);
    if (!this.hasFreeSlot()) {
      if (!this.waiting.includes(id)) this.waiting.push(id);
      item.status = 'waiting';
      item.statusText = 'Waiting for a free slot';
      item.error = null;
      this.touch(item);
      return true;
    }
    this.waiting = this.waiting.filter((x) => x !== id);
    const ctx = {
      net: this.net,
      getSettings: () => this.settings,
      limiters: () => [this.globalLimiter],
      maxConnFor: (url) => this.maxConnFor(url),
      onBytes: (n) => this.onBytes(n),
      binDir: path.join(this.store.dir, 'bin'),
    };
    const Engine = { ftp: FtpDownload, hls: HlsDownload, muxed: MuxedDownload, ytdlp: YtDlpDownload }[item.kind] || HttpDownload;
    const eng = new Engine(item, ctx);
    this.engines.set(id, eng);
    item.status = 'downloading';
    item.statusText = 'Connecting...';
    item.error = null;
    item.lastTry = Date.now();
    item.rate = 0;
    this.touch(item);
    this.emit('started', item.id);

    eng.on('status', (t) => {
      item.statusText = t;
      this.emit('changed', this.publicItem(item));
    });
    eng.on('meta', (m) => {
      if (m.fileName && !item.nameLocked) {
        item.fileName = this.guessName(item.url, m.fileName, m.contentType);
      } else if (!u.extOf(item.fileName) && m.contentType) {
        item.fileName = this.guessName(item.url, item.fileName, m.contentType);
      }
      this.touch(item);
    });
    eng.on('progress', (st) => {
      item.downloaded = st.downloaded;
      item.rate = st.rate;
      item.eta = st.eta;
      if (st.size != null) item.size = st.size;
      if (st.estimatedSize) item.estimatedSize = st.estimatedSize;
      this.emit('progress', id, st, this.publicItem(item));
    });
    eng.on('persist', () => this.persist());
    eng.on('metrics', (m) => {
      // Kept on the item (last run only) and written to the diagnostic log when enabled.
      item.lastRun = m;
      diag('download', { id, url: redactUrl(item.url), kind: item.kind, ...m });
    });
    eng.on('complete', () => this.finalize(item));
    eng.on('stopped', () => {
      this.engines.delete(id);
      item.status = 'paused';
      item.rate = 0;
      item.statusText = item.pendingStatus || '';
      item.pendingStatus = null;
      this.touch(item);
      this.emit('stopped', item.id);
      this.admit();
    });
    eng.on('failed', (err) => {
      this.engines.delete(id);
      item.status = 'error';
      item.rate = 0;
      item.error = err?.message || String(err);
      item.statusText = item.error;
      this.touch(item);
      this.emit('failed', this.publicItem(item), err);
      this.admit();
    });
    eng.start();
    return true;
  }

  async finalize(item) {
    item.statusText = 'Moving file...';
    this.emit('changed', this.publicItem(item));
    try {
      let dest = path.join(item.saveDir, item.fileName);
      const exists = await fs.promises.access(dest).then(() => true, () => false);
      if (exists && !item.overwrite && this.settings.downloads.existingFileAction !== 'overwrite') dest = await u.uniquePath(dest);
      if (exists && (item.overwrite || this.settings.downloads.existingFileAction === 'overwrite')) await fs.promises.rm(dest, { force: true });
      await u.moveFile(item.tempPath, dest);
      for (const x of item.extraFiles || []) await u.moveFile(x.temp, await u.uniquePath(path.join(item.saveDir, u.sanitizeFileName(x.name))));
      item.extraFiles = null;
      item.fileName = path.basename(dest);
      item.savedPath = dest;
      item.status = 'complete';
      item.completedAt = Date.now();
      item.statusText = 'Complete';
      item.segments = item.size ? [{ start: 0, end: item.size, pos: item.size }] : null;
      item.downloaded = item.size || item.downloaded;
      item.rate = 0;
      item.overwrite = false;
      this.engines.delete(item.id);
      this.touch(item);
      this.emit('complete', this.publicItem(item));
    } catch (e) {
      this.engines.delete(item.id);
      item.status = 'error';
      item.error = 'Could not save file: ' + e.message;
      item.statusText = item.error;
      this.touch(item);
      this.emit('failed', this.publicItem(item), e);
    }
    this.admit();
  }

  stop(id, statusText) {
    const eng = this.engines.get(id);
    const item = this.get(id);
    if (!eng && this.waiting.includes(id)) {
      this.waiting = this.waiting.filter((x) => x !== id);
      item.status = 'paused';
      item.statusText = statusText || '';
      this.touch(item);
      this.emit('stopped', id);
      return true;
    }
    if (eng) {
      if (statusText) item.pendingStatus = statusText;
      eng.stop();
    }
    return !!eng;
  }

  stopAll() {
    for (const id of [...this.waiting]) this.stop(id);
    for (const id of [...this.engines.keys()]) this.stop(id);
  }

  waitStopped(id) {
    if (!this.engines.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const h = (sid) => {
        if (sid !== id && sid?.id !== id) return;
        this.off('stopped', h);
        this.off('failed', h);
        this.off('complete', h);
        resolve();
      };
      this.on('stopped', h);
      this.on('failed', h);
      this.on('complete', h);
    });
  }

  async remove(ids, deleteFiles = false) {
    for (const id of ids) {
      const item = this.get(id);
      if (!item) continue;
      if (this.isActive(id)) {
        this.stop(id);
        await this.waitStopped(id);
      }
      await fs.promises.rm(item.tempPath, { force: true }).catch(() => {});
      await fs.promises.rm(item.tempPath + '.segs', { recursive: true, force: true }).catch(() => {});
      for (const x of item.parts || []) if (x.tempPath) await fs.promises.rm(x.tempPath, { force: true }).catch(() => {});
      await fs.promises.rm(item.tempPath + '.ytdlp', { recursive: true, force: true }).catch(() => {});
      if (deleteFiles && item.savedPath) await fs.promises.rm(item.savedPath, { force: true }).catch(() => {});
      this.store.downloads = this.items.filter((d) => d.id !== id);
    }
    this.persist();
    this.emit('removed', ids);
  }

  removeCompleted() {
    const ids = this.items.filter((d) => d.status === 'complete').map((d) => d.id);
    return this.remove(ids, false).then(() => ids);
  }

  async redownload(id, startNow = true) {
    const item = this.get(id);
    if (!item) return;
    if (this.engines.has(id)) {
      this.stop(id);
      await this.waitStopped(id);
    }
    await fs.promises.rm(item.tempPath, { force: true }).catch(() => {});
    await fs.promises.rm(item.tempPath + '.segs', { recursive: true, force: true }).catch(() => {});
    Object.assign(item, { status: 'paused', segments: null, downloaded: 0, size: null, resumable: null, error: null, statusText: '', savedPath: null, completedAt: null });
    if (item.hls) item.hls = { variant: item.hls.variant };
    await fs.promises.rm(item.tempPath + '.ytdlp', { recursive: true, force: true }).catch(() => {});
    for (const x of item.parts || []) {
      if (x.tempPath) await fs.promises.rm(x.tempPath, { force: true }).catch(() => {});
      Object.assign(x, { segments: null, done: false, downloaded: 0, resumable: null });
    }
    if (item.parts) item.size = item.parts.every((x) => x.size) ? item.parts.reduce((a, x) => a + x.size, 0) : null;
    item.overwrite = true;
    this.touch(item);
    if (startNow) this.start(id);
  }

  // Properties dialog edits, including "refresh download address" (new URL keeps progress).
  async update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    const allowed = ['url', 'fileName', 'saveDir', 'description', 'category', 'referer', 'cookies', 'userAgent', 'maxConnections', 'speedLimitKB', 'onComplete', 'auth'];
    const wasActive = this.engines.has(id);
    if (wasActive && (('url' in patch && patch.url !== item.url) || 'auth' in patch)) {
      this.stop(id);
      await this.waitStopped(id);
    }
    for (const k of allowed) if (k in patch) item[k] = patch[k];
    if ('fileName' in patch) {
      item.fileName = u.sanitizeFileName(patch.fileName);
      item.nameLocked = true;
      if (item.status === 'complete' && item.savedPath) {
        const dest = path.join(item.saveDir, item.fileName);
        if (dest !== item.savedPath) {
          await u.moveFile(item.savedPath, dest);
          item.savedPath = dest;
        }
      }
    }
    if ('saveDir' in patch && item.status === 'complete' && item.savedPath) {
      const dest = path.join(patch.saveDir, item.fileName);
      if (dest !== item.savedPath) {
        await u.moveFile(item.savedPath, dest);
        item.savedPath = dest;
      }
    }
    const eng = this.engines.get(id);
    if (eng && 'speedLimitKB' in patch) eng.setSpeedLimit(patch.speedLimitKB);
    if (eng && 'maxConnections' in patch) eng.setMaxConnections(patch.maxConnections);
    if ('url' in patch) item.kind = this.kindFor(item.url, item.kind === 'hls' ? 'hls' : null);
    this.touch(item);
    if (wasActive && !this.engines.has(id)) this.start(id);
    return this.publicItem(item);
  }

  stats(id) {
    const eng = this.engines.get(id);
    if (eng) return eng.stats();
    const it = this.get(id);
    if (!it) return null;
    if (it.parts) return muxedStats(it);
    return {
      downloaded: it.downloaded || 0, size: it.size, rate: 0, eta: null, resumable: it.resumable, connections: [],
      segments: (it.segments || []).map((s) => [s.start, s.end === Infinity ? null : s.end, s.pos]),
      hlsSegments: it.hls ? { total: it.hls.total || 0, done: it.hls.done || [] } : undefined,
    };
  }

  // Checks whether a completed file changed on the server (synchronization queues).
  async remoteChanged(id) {
    const it = this.get(id);
    if (!it) return false;
    if (it.kind !== 'http') return true;
    const p = await this.net.probe(it.url, { headers: it.referer ? { Referer: it.referer } : {} });
    const lm = p.headers['last-modified'] || null;
    const et = p.headers.etag || null;
    return (p.size != null && it.size != null && p.size !== it.size) || (et && it.etag && et !== it.etag) || (lm && it.lastModified && lm !== it.lastModified) || (!et && !lm && p.size == null);
  }

  // Export/import of the download list.
  exportList() {
    return this.items.map((d) => ({ url: d.url, fileName: d.fileName, saveDir: d.saveDir, category: d.category, description: d.description, referer: d.referer, status: d.status, size: d.size }));
  }

  dispose() {
    clearInterval(this.quotaTimer);
    this.stopAll();
  }
}

function isGoogleVideo(url) {
  try {
    const x = new URL(url);
    return /(^|\.)googlevideo\.com$/i.test(x.hostname) && x.pathname.startsWith('/videoplayback') && Number(x.searchParams.get('clen')) > 0;
  } catch {
    return false;
  }
}

// Container that can hold every part without re-encoding.
function containerFor(parts) {
  const exts = parts.map((x) => x.ext.toLowerCase());
  if (parts.length === 1) return exts[0] === 'webm' && parts[0].role === 'audio' ? 'weba' : exts[0];
  if (exts.every((e) => ['mp4', 'm4a', 'm4v'].includes(e))) return 'mp4';
  if (exts.every((e) => ['webm', 'weba'].includes(e))) return 'webm';
  return 'mkv';
}

module.exports = { DownloadManager, isGoogleVideo, containerFor };

'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SpeedMeter, RateLimiter } = require('./limiter');
const { fileNameFromDisposition } = require('../util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Multi-connection HTTP(S) download with dynamic segmentation.
 *
 * The first connection requests an open-ended range from 0. Each additional connection
 * splits the largest remaining segment in half and starts at its midpoint. A connection
 * that reaches the end of its segment takes over the next segment if that segment's
 * connection has not received any data yet (reusing the already-open stream); otherwise
 * it splits the largest remaining segment again. Segment positions are persisted so a
 * download survives pause, crash or power loss.
 *
 * Persisted state lives on `item`: size, resumable, segments[{start,end,pos}], etag, lastModified.
 */
class HttpDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx; // { net, getSettings, limiters: () => RateLimiter[], maxConnFor(url) }
    this.workers = new Set();
    this.meter = new SpeedMeter();
    this.limiter = new RateLimiter(item.speedLimitKB > 0 ? item.speedLimitKB * 1024 : 0);
    this.stopped = false;
    this.fh = null;
    this.fatal = null;
    this.wid = 0;
  }

  get settings() {
    return this.ctx.getSettings();
  }

  setSpeedLimit(kb) {
    this.item.speedLimitKB = kb;
    this.limiter.setRate(kb > 0 ? kb * 1024 : 0);
  }

  maxConnections() {
    return Math.max(1, this.item.maxConnections || this.ctx.maxConnFor(this.item.url));
  }

  setMaxConnections(n) {
    this.item.maxConnections = n;
    this.fillConnections();
  }

  headers() {
    const h = {};
    const it = this.item;
    if (it.referer) h.Referer = it.referer;
    if (it.cookies) h.Cookie = it.cookies;
    if (it.userAgent) h['User-Agent'] = it.userAgent;
    if (it.extraHeaders) Object.assign(h, it.extraHeaders);
    return h;
  }

  downloaded() {
    if (!this.item.segments) return this.item.downloaded || 0;
    return this.item.segments.reduce((a, s) => a + (s.pos - s.start), 0);
  }

  async openFile(truncate) {
    await fs.promises.mkdir(path.dirname(this.item.tempPath), { recursive: true });
    if (truncate) {
      this.fh = await fs.promises.open(this.item.tempPath, 'w+');
      return;
    }
    try {
      this.fh = await fs.promises.open(this.item.tempPath, 'r+');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // Temp file vanished: any recorded progress is invalid.
      if (this.item.segments) for (const s of this.item.segments) s.pos = s.start;
      this.fh = await fs.promises.open(this.item.tempPath, 'w+');
    }
  }

  async start() {
    this.stopped = false;
    this.fatal = null;
    this.startedAt = Date.now();
    this.progressTimer = setInterval(() => this.emitProgress(), 500);
    this.persistTimer = setInterval(() => this.emit('persist'), 3000);
    const it = this.item;
    try {
      if (it.rangeMode === 'query') {
        // Size is known up front (e.g. googlevideo `clen`); every request is a bounded `&range=a-b` chunk.
        if (!(it.size > 0)) throw new Error('Stream size is unknown');
        it.resumable = true;
        const has = Array.isArray(it.segments) && this.downloaded() > 0;
        await this.openFile(!has);
        if (!has) it.segments = [{ start: 0, end: it.size, pos: 0 }];
        this.emit('meta', { size: it.size, resumable: true, contentType: it.contentType || '', fileName: null });
        this.emit('status', 'Receiving data...');
        this.fillConnections();
        await this.whenIdle();
        if (this.stopped) return this.finish('stopped');
        if (this.fatal) return this.finish('error', this.fatal);
        if (!this.isComplete()) return this.finish('error', this.lastError || new Error('Download interrupted'));
        return this.finish('complete');
      }
      const canResume = it.resumable && it.size > 0 && Array.isArray(it.segments) && this.downloaded() > 0;
      await this.openFile(!canResume);
      if (!canResume) {
        it.segments = null;
        it.downloaded = 0;
      }
      this.emit('status', 'Connecting...');
      if (canResume) {
        this.resuming = true;
        this.fillConnections();
      } else {
        this.spawn(null);
      }
      await this.whenIdle();
      if (this.stopped) return this.finish('stopped');
      if (this.fatal) return this.finish('error', this.fatal);
      if (!this.isComplete()) return this.finish('error', this.lastError || new Error('Download interrupted'));
      return this.finish('complete');
    } catch (e) {
      return this.finish(this.stopped ? 'stopped' : 'error', e);
    }
  }

  async finish(kind, err) {
    clearInterval(this.progressTimer);
    clearInterval(this.persistTimer);
    try {
      await this.fh?.close();
    } catch { /* ignore */ }
    this.fh = null;
    this.emitProgress();
    this.emit('persist');
    if (kind === 'complete') {
      if (this.item.size == null) this.item.size = this.downloaded();
      this.emit('complete');
    } else if (kind === 'error') this.emit('failed', err);
    else this.emit('stopped');
  }

  stop() {
    this.stopped = true;
    for (const w of this.workers) w.abort.abort();
  }

  whenIdle() {
    if (!this.workers.size) return Promise.resolve();
    return new Promise((r) => this.once('idle', r));
  }

  isComplete() {
    const it = this.item;
    if (!it.segments) return false;
    if (it.size == null) return this.streamEnded === true;
    return it.segments.every((s) => s.pos >= s.end);
  }

  // Picks work for a new/finished connection: an orphan segment, or half of the largest one.
  nextSegment() {
    const segs = this.item.segments;
    if (!segs || !this.item.resumable || this.item.size == null) return null;
    const owned = new Set([...this.workers].map((w) => w.seg));
    const orphan = segs.find((s) => s.pos < s.end && !owned.has(s));
    if (orphan) return orphan;
    const minSplit = Math.max(64 * 1024, (this.settings.connection.minSegmentKB || 256) * 1024);
    let best = null;
    for (const s of segs) {
      if (!owned.has(s)) continue;
      const rem = s.end - s.pos;
      if (rem >= 2 * minSplit && (!best || rem > best.end - best.pos)) best = s;
    }
    if (!best) return null;
    const mid = best.pos + Math.floor((best.end - best.pos) / 2);
    const seg = { start: mid, end: best.end, pos: mid };
    best.end = mid;
    segs.splice(segs.indexOf(best) + 1, 0, seg);
    return seg;
  }

  fillConnections() {
    if (this.stopped || this.fatal) return;
    let guard = 64;
    while (this.workers.size < this.maxConnections() && guard--) {
      const seg = this.nextSegment();
      if (!seg) break;
      this.spawn(seg);
    }
  }

  spawn(seg) {
    const w = { seg, abort: new AbortController(), receiving: false, retries: 0, id: ++this.wid };
    this.workers.add(w);
    this.runWorker(w)
      .catch((e) => {
        this.lastError = e;
      })
      .finally(() => {
        this.workers.delete(w);
        if (!this.stopped && !this.fatal && !this.isComplete()) {
          // Hand leftover work to new connections; give up only if nothing is running.
          if (this.workers.size === 0 && w.gaveUp) return this.emit('idle');
          this.fillConnections();
        }
        if (!this.workers.size) this.emit('idle');
      });
  }

  // Bounded chunk requests addressed with a `range=a-b` query parameter instead of a Range header.
  async runQueryWorker(w) {
    const maxRetries = this.settings.connection.connectionRetries ?? 20;
    const CHUNK = 8 * 1024 * 1024;
    while (!this.stopped && !this.fatal && !w.abort.signal.aborted) {
      if (!w.seg || w.seg.pos >= w.seg.end) {
        const next = this.nextSegment();
        if (!next) return;
        w.seg = next;
        w.receiving = false;
      }
      const seg = w.seg;
      const chunkEnd = Math.min(seg.end, seg.pos + CHUNK);
      const u = new URL(this.item.url);
      u.searchParams.set('range', `${seg.pos}-${chunkEnd - 1}`);
      let res;
      try {
        ({ res } = await this.ctx.net.request(u.href, { headers: this.headers(), auth: this.item.auth, signal: w.abort.signal }));
        if (res.statusCode >= 400) {
          res.resume();
          const err = Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode });
          if ([401, 403, 404, 410].includes(res.statusCode)) {
            err.message = `HTTP ${res.statusCode}: the stream link was refused or has expired — send the video to OpenDM again from its page`;
            this.fatal = err;
            return;
          }
          throw err;
        }
        const onAbort = () => res.destroy();
        w.abort.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for await (let chunk of res) {
            if (w.abort.signal.aborted || this.stopped) break;
            w.receiving = true;
            const room = Math.min(chunkEnd, seg.end) - seg.pos; // seg.end may shrink when another connection splits it
            if (room <= 0) break;
            if (chunk.length > room) chunk = chunk.subarray(0, room);
            let wait = 0;
            for (const l of [this.limiter, ...this.ctx.limiters()]) wait = Math.max(wait, l.take(chunk.length));
            if (wait) await sleep(wait);
            await this.fh.write(chunk, 0, chunk.length, seg.pos);
            seg.pos += chunk.length;
            this.meter.add(chunk.length);
            this.ctx.onBytes?.(chunk.length);
          }
        } finally {
          w.abort.signal.removeEventListener('abort', onAbort);
          res.destroy();
        }
        if (w.abort.signal.aborted || this.stopped) return;
        if (seg.pos < Math.min(chunkEnd, seg.end)) throw new Error('Connection closed prematurely');
        w.retries = 0;
      } catch (e) {
        res?.destroy();
        if (w.abort.signal.aborted || this.stopped || this.fatal) return;
        if (await this.backoff(w, e, maxRetries)) continue;
        w.gaveUp = true;
        throw e;
      }
    }
  }

  async runWorker(w) {
    if (this.item.rangeMode === 'query') return this.runQueryWorker(w);
    const maxRetries = this.settings.connection.connectionRetries ?? 20;
    while (!this.stopped && !this.fatal && !w.abort.signal.aborted) {
      const first = w.seg == null;
      const from = first ? 0 : w.seg.pos;
      if (!first && w.seg.pos >= w.seg.end) {
        const next = this.nextSegment();
        if (!next) return;
        w.seg = next;
        w.receiving = false;
        continue;
      }
      let res;
      try {
        ({ res } = await this.ctx.net.request(this.item.url, {
          headers: { ...this.headers(), Range: `bytes=${from}-` },
          auth: this.item.auth,
          signal: w.abort.signal,
        }));
      } catch (e) {
        if (w.abort.signal.aborted || this.stopped) return;
        if (e.code === 'EAUTH') {
          this.fatal = e;
          return;
        }
        if (await this.backoff(w, e, maxRetries)) continue;
        w.gaveUp = true;
        throw e;
      }

      try {
        if (!(await this.acceptResponse(w, res, first, from))) continue;
        await this.pump(w, res);
        if (first && this.item.size == null && !w.abort.signal.aborted && !this.stopped) {
          this.streamEnded = true;
          this.item.size = this.downloaded();
          w.seg.end = this.item.size;
          return;
        }
        w.retries = 0;
      } catch (e) {
        res.destroy();
        if (w.abort.signal.aborted || this.stopped || this.fatal) return;
        if (!this.item.resumable) {
          // Cannot continue mid-stream on a non-resumable server: restart from scratch.
          if (await this.backoff(w, e, maxRetries)) {
            this.item.segments = null;
            w.seg = null;
            await this.fh.truncate(0);
            continue;
          }
          w.gaveUp = true;
          throw e;
        }
        if (await this.backoff(w, e, maxRetries)) continue;
        w.gaveUp = true;
        throw e;
      }
    }
  }

  async backoff(w, err, maxRetries) {
    this.lastError = err;
    w.retries++;
    if (maxRetries && w.retries > maxRetries) return false;
    this.emit('status', `Retrying (${err.message})...`);
    await sleep(Math.min(30000, 1000 * 2 ** Math.min(w.retries, 5)));
    return !this.stopped && !w.abort.signal.aborted;
  }

  // Validates status/headers; establishes metadata on the first response. Returns false to retry.
  async acceptResponse(w, res, first, from) {
    const it = this.item;
    const st = res.statusCode;
    if (st >= 400) {
      res.resume();
      const err = Object.assign(new Error(`HTTP ${st} ${res.statusMessage || ''}`.trim()), { status: st });
      if ([429, 503].includes(st) && this.workers.size > 1 && !first) {
        // Server limits parallel connections: drop this one and lower the cap.
        it.maxConnections = Math.max(1, this.workers.size - 1);
        w.abort.abort();
        return false;
      }
      if ([400, 401, 403, 404, 410, 416].includes(st) && (first || this.resuming)) {
        this.fatal = err;
        w.abort.abort();
        return false;
      }
      throw err;
    }
    const h = res.headers;
    const total = st === 206 && h['content-range'] ? Number(String(h['content-range']).split('/')[1]) : null;
    const etag = h.etag || null;
    const lastMod = h['last-modified'] || null;

    if (first) {
      it.resumable = st === 206;
      it.size = st === 206 ? total || null : h['content-length'] ? Number(h['content-length']) : null;
      if (!it.resumable && st === 206) it.size = null;
      it.etag = etag;
      it.lastModified = lastMod;
      it.contentType = h['content-type'] || '';
      it.finalUrl = res.req?.path?.startsWith('http') ? res.req.path : it.finalUrl;
      const dispName = fileNameFromDisposition(h['content-disposition']);
      this.emit('meta', { size: it.size, resumable: it.resumable, contentType: it.contentType, fileName: dispName });
      w.seg = { start: 0, end: it.size ?? Infinity, pos: 0 };
      it.segments = [w.seg];
      this.emit('status', 'Receiving data...');
      if (it.resumable && it.size) setTimeout(() => this.fillConnections(), 150);
      return true;
    }

    if (st === 200) {
      // Server ignored Range for a continuation request.
      res.destroy();
      if (from === 0 && w.seg.start === 0) return this.restartNonResumable(w);
      it.maxConnections = 1;
      if (this.workers.size > 1) {
        w.abort.abort();
        return false;
      }
      return this.restartNonResumable(w);
    }

    if (this.resuming) {
      this.resuming = false;
      const changed = (total && it.size && total !== it.size) ||
        (!this.settings.downloads.ignoreModTimeChanges && ((it.etag && etag && it.etag !== etag) || (it.lastModified && lastMod && it.lastModified !== lastMod)));
      if (changed) {
        this.emit('status', 'File changed on server, restarting...');
        res.destroy();
        for (const x of this.workers) if (x !== w) x.abort.abort();
        it.size = total || null;
        it.etag = etag;
        it.lastModified = lastMod;
        it.segments = [{ start: 0, end: it.size ?? Infinity, pos: 0 }];
        w.seg = it.segments[0];
        await this.fh.truncate(0);
        return false;
      }
      this.emit('status', 'Receiving data...');
    }
    return true;
  }

  async restartNonResumable(w) {
    const it = this.item;
    it.resumable = false;
    for (const x of this.workers) if (x !== w) x.abort.abort();
    it.segments = null;
    w.seg = null;
    await this.fh.truncate(0);
    return false;
  }

  async pump(w, res) {
    const fh = this.fh;
    const limiters = () => [this.limiter, ...this.ctx.limiters()];
    const onAbort = () => res.destroy();
    w.abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.pumpChunks(w, res, fh, limiters);
    } catch (e) {
      if (w.abort.signal.aborted || this.stopped) return;
      throw e;
    } finally {
      w.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  async pumpChunks(w, res, fh, limiters) {
    for await (let chunk of res) {
      if (w.abort.signal.aborted || this.stopped) break;
      w.receiving = true;
      let seg = w.seg;
      while (chunk.length) {
        const room = seg.end - seg.pos;
        if (room <= 0) {
          const next = this.absorbNext(w);
          if (!next) {
            res.destroy();
            return;
          }
          seg = w.seg;
          continue;
        }
        const part = room < chunk.length ? chunk.subarray(0, room) : chunk;
        chunk = room < chunk.length ? chunk.subarray(room) : Buffer.alloc(0);
        let wait = 0;
        for (const l of limiters()) wait = Math.max(wait, l.take(part.length));
        if (wait) await sleep(wait);
        await fh.write(part, 0, part.length, seg.pos);
        seg.pos += part.length;
        this.meter.add(part.length);
        if (this.ctx.onBytes) this.ctx.onBytes(part.length);
      }
      if (seg.pos >= seg.end && !this.absorbNext(w)) {
        res.destroy();
        return;
      }
    }
    if (w.seg && w.seg.end !== Infinity && w.seg.pos < w.seg.end && !w.abort.signal.aborted && !this.stopped) {
      throw new Error('Connection closed prematurely');
    }
  }

  // Connection reuse: continue the open stream into the adjacent segment if nobody has started it.
  absorbNext(w) {
    const segs = this.item.segments;
    const seg = w.seg;
    const next = segs.find((s) => s !== seg && s.start === seg.end);
    if (!next || next.pos !== next.start) return false;
    const owner = [...this.workers].find((x) => x !== w && x.seg === next);
    if (owner) {
      if (owner.receiving) return false;
      owner.abort.abort();
    }
    seg.end = next.end;
    segs.splice(segs.indexOf(next), 1);
    return true;
  }

  stats() {
    const it = this.item;
    const done = this.downloaded();
    const rate = this.meter.rate();
    return {
      downloaded: done,
      size: it.size,
      rate,
      eta: it.size && rate > 0 ? (it.size - done) / rate : null,
      resumable: it.resumable,
      connections: [...this.workers].map((w) => ({
        id: w.id,
        start: w.seg?.start ?? 0,
        end: w.seg?.end ?? null,
        pos: w.seg?.pos ?? 0,
        receiving: w.receiving,
      })),
      segments: (it.segments || []).map((s) => [s.start, s.end === Infinity ? null : s.end, s.pos]),
    };
  }

  emitProgress() {
    this.emit('progress', this.stats());
  }
}

module.exports = { HttpDownload };

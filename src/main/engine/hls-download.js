'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SpeedMeter, RateLimiter } = require('./limiter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseAttrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

// Parses an HLS playlist. Returns {variants} for a master playlist or {segments, map, endList} for media.
function parsePlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const variants = [];
  const segments = [];
  let key = null, map = null, seq = 0, endList = false, duration = 0, pendingInf = null, pendingVariant = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) pendingVariant = parseAttrs(line.slice(18));
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? new URL(a.URI, baseUrl).href : null, iv: a.IV || null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { uri: new URL(a.URI, baseUrl).href, range: a.BYTERANGE || null };
    } else if (line.startsWith('#EXTINF:')) pendingInf = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (!line.startsWith('#')) {
      const uri = new URL(line, baseUrl).href;
      if (pendingVariant) {
        variants.push({
          uri,
          bandwidth: Number(pendingVariant.BANDWIDTH) || 0,
          resolution: pendingVariant.RESOLUTION || '',
          codecs: pendingVariant.CODECS || '',
        });
        pendingVariant = null;
      } else {
        segments.push({ uri, duration: pendingInf || 0, seq, key });
        duration += pendingInf || 0;
        seq++;
        pendingInf = null;
      }
    }
  }
  if (variants.length) return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth) };
  return { segments, map, endList, duration };
}

/**
 * Downloads an HLS (m3u8) stream: fetches media segments in parallel, decrypts AES-128,
 * and concatenates them (plus any init map) into one file. Completed segment indexes persist.
 */
class HlsDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.meter = new SpeedMeter();
    this.limiter = new RateLimiter(item.speedLimitKB > 0 ? item.speedLimitKB * 1024 : 0);
    this.abort = new AbortController();
    this.keys = new Map();
    this.active = new Map();
  }

  setSpeedLimit(kb) {
    this.item.speedLimitKB = kb;
    this.limiter.setRate(kb > 0 ? kb * 1024 : 0);
  }

  setMaxConnections(n) {
    this.item.maxConnections = n;
  }

  headers() {
    const h = {};
    if (this.item.referer) h.Referer = this.item.referer;
    if (this.item.cookies) h.Cookie = this.item.cookies;
    if (this.item.userAgent) h['User-Agent'] = this.item.userAgent;
    return h;
  }

  async fetch(url, extra = {}) {
    return this.ctx.net.fetchBuffer(url, { headers: { ...this.headers(), ...extra }, signal: this.abort.signal, maxBytes: 512 * 1024 * 1024 });
  }

  async resolvePlaylist() {
    let url = this.item.hls?.mediaUrl || this.item.url;
    let { body, url: finalUrl } = await this.fetch(url);
    let pl = parsePlaylist(body.toString('utf8'), finalUrl);
    if (pl.variants) {
      const want = this.item.hls?.variant;
      const v = pl.variants.find((x) => x.uri === want) || pl.variants[0];
      url = v.uri;
      ({ body, url: finalUrl } = await this.fetch(url));
      pl = parsePlaylist(body.toString('utf8'), finalUrl);
    }
    this.item.hls = { ...(this.item.hls || {}), mediaUrl: url };
    return pl;
  }

  segDir() {
    return this.item.tempPath + '.segs';
  }

  async start() {
    const it = this.item;
    this.progressTimer = setInterval(() => this.emit('progress', this.stats()), 500);
    this.persistTimer = setInterval(() => this.emit('persist'), 3000);
    try {
      this.emit('status', 'Reading playlist...');
      const pl = await this.resolvePlaylist();
      if (!pl.segments.length) throw new Error('Playlist has no segments');
      this.playlist = pl;
      it.hls.total = pl.segments.length;
      it.hls.done = it.hls.done || [];
      it.hls.bytes = it.hls.bytes || 0;
      it.resumable = true;
      this.emit('meta', { size: null, resumable: true, contentType: 'video/mp2t', fileName: null, duration: pl.duration });
      await fs.promises.mkdir(this.segDir(), { recursive: true });
      const done = new Set(it.hls.done);
      const queue = pl.segments.map((s, i) => i).filter((i) => !done.has(i));
      this.emit('status', 'Receiving data...');
      const n = Math.max(1, Math.min(16, it.maxConnections || this.ctx.maxConnFor(it.url)));
      await Promise.all(Array.from({ length: n }, async () => {
        while (queue.length && !this.abort.signal.aborted) {
          const i = queue.shift();
          await this.fetchSegment(i);
          done.add(i);
          it.hls.done = [...done];
        }
      }));
      if (this.abort.signal.aborted) throw Object.assign(new Error('Stopped'), { stopped: true });
      this.emit('status', 'Assembling file...');
      await this.assemble();
      it.size = (await fs.promises.stat(it.tempPath)).size;
      this.done('complete');
    } catch (e) {
      this.done(this.abort.signal.aborted ? 'stopped' : 'failed', e);
    }
  }

  async keyFor(seg) {
    if (!seg.key) return null;
    if (seg.key.method !== 'AES-128') throw new Error(`Unsupported HLS encryption: ${seg.key.method}`);
    if (!this.keys.has(seg.key.uri)) this.keys.set(seg.key.uri, (await this.fetch(seg.key.uri)).body);
    const iv = seg.key.iv ? Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex') : (() => {
      const b = Buffer.alloc(16);
      b.writeUInt32BE(seg.seq >>> 0, 12);
      return b;
    })();
    return { key: this.keys.get(seg.key.uri), iv };
  }

  async fetchSegment(i) {
    const seg = this.playlist.segments[i];
    for (let attempt = 1; ; attempt++) {
      try {
        this.active.set(i, 0);
        const { res } = await this.ctx.net.request(seg.uri, { headers: this.headers(), signal: this.abort.signal });
        if (res.statusCode >= 400) {
          res.resume();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        const chunks = [];
        for await (const c of res) {
          let wait = 0;
          for (const l of [this.limiter, ...this.ctx.limiters()]) wait = Math.max(wait, l.take(c.length));
          if (wait) await sleep(wait);
          chunks.push(c);
          this.meter.add(c.length);
          this.ctx.onBytes?.(c.length);
          this.active.set(i, (this.active.get(i) || 0) + c.length);
        }
        let data = Buffer.concat(chunks);
        const k = await this.keyFor(seg);
        if (k) {
          const d = crypto.createDecipheriv('aes-128-cbc', k.key, k.iv);
          data = Buffer.concat([d.update(data), d.final()]);
        }
        await fs.promises.writeFile(path.join(this.segDir(), `${i}.seg`), data);
        this.item.hls.bytes += data.length;
        this.active.delete(i);
        return;
      } catch (e) {
        this.active.delete(i);
        if (this.abort.signal.aborted) throw e;
        if (attempt >= (this.ctx.getSettings().connection.connectionRetries || 20)) throw e;
        await sleep(Math.min(15000, 500 * 2 ** attempt));
      }
    }
  }

  async assemble() {
    const out = await fs.promises.open(this.item.tempPath, 'w');
    try {
      if (this.playlist.map) {
        const extra = this.playlist.map.range ? (() => {
          const [len, off = '0'] = this.playlist.map.range.split('@');
          return { Range: `bytes=${off}-${Number(off) + Number(len) - 1}` };
        })() : {};
        await out.write((await this.fetch(this.playlist.map.uri, extra)).body);
      }
      for (let i = 0; i < this.playlist.segments.length; i++) {
        await out.write(await fs.promises.readFile(path.join(this.segDir(), `${i}.seg`)));
      }
    } finally {
      await out.close();
    }
    await fs.promises.rm(this.segDir(), { recursive: true, force: true });
  }

  done(kind, err) {
    clearInterval(this.progressTimer);
    clearInterval(this.persistTimer);
    this.emit('progress', this.stats());
    this.emit('persist');
    if (kind === 'failed') this.emit('failed', err);
    else this.emit(kind);
  }

  stop() {
    this.abort.abort();
  }

  stats() {
    const h = this.item.hls || {};
    const total = h.total || 0;
    const doneCount = (h.done || []).length;
    const rate = this.meter.rate();
    const bytes = (h.bytes || 0) + [...this.active.values()].reduce((a, b) => a + b, 0);
    const est = doneCount ? (bytes / Math.max(1, doneCount + this.active.size * 0.5)) * total : null;
    return {
      downloaded: bytes,
      size: this.item.size || null,
      estimatedSize: est,
      rate,
      eta: est && rate > 0 ? Math.max(0, est - bytes) / rate : null,
      resumable: true,
      fraction: total ? doneCount / total : 0,
      connections: [...this.active.entries()].map(([i, b]) => ({ id: i + 1, start: i, end: i + 1, pos: i, receiving: b > 0, bytes: b })),
      segments: total ? [[0, total, doneCount]] : [],
      hlsSegments: { total, done: h.done || [] },
    };
  }
}

module.exports = { HlsDownload, parsePlaylist };

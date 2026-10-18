'use strict';
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const { EventEmitter } = require('events');
const ftp = require('basic-ftp');
const { SpeedMeter, RateLimiter } = require('./limiter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * FTP download. Splits the file into static segments, one control+data connection each,
 * resuming every segment with REST. Persisted state: size, resumable, segments.
 */
class FtpDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.meter = new SpeedMeter();
    this.limiter = new RateLimiter(item.speedLimitKB > 0 ? item.speedLimitKB * 1024 : 0);
    this.clients = new Set();
    this.stopped = false;
  }

  setSpeedLimit(kb) {
    this.item.speedLimitKB = kb;
    this.limiter.setRate(kb > 0 ? kb * 1024 : 0);
  }

  setMaxConnections(n) {
    this.item.maxConnections = n;
  }

  creds() {
    const u = new URL(this.item.url);
    const login = this.item.auth || this.ctx.net.loginFor(this.item.url);
    return {
      host: u.hostname,
      port: Number(u.port) || 21,
      user: login?.user || 'anonymous',
      password: login?.pass ?? 'guest@example.com',
      remotePath: decodeURIComponent(u.pathname),
    };
  }

  async connect() {
    const c = this.creds();
    const client = new ftp.Client(this.ctx.getSettings().connection.timeoutSec * 1000);
    client.ftp.verbose = false;
    await client.access({ host: c.host, port: c.port, user: c.user, password: c.password, secure: false });
    this.clients.add(client);
    return client;
  }

  downloaded() {
    return (this.item.segments || []).reduce((a, s) => a + (s.pos - s.start), 0);
  }

  async start() {
    this.stopped = false;
    const it = this.item;
    this.progressTimer = setInterval(() => this.emit('progress', this.stats()), 500);
    this.persistTimer = setInterval(() => this.emit('persist'), 3000);
    let fh;
    try {
      this.emit('status', 'Connecting...');
      const probe = await this.connect();
      const { remotePath } = this.creds();
      let size = null;
      try {
        size = await probe.size(remotePath);
      } catch { /* SIZE unsupported */ }
      let mtime = null;
      try {
        mtime = (await probe.lastMod(remotePath)).toISOString();
      } catch { /* MDTM unsupported */ }
      const fresh = !it.segments || it.size !== size || (it.lastModified && mtime && it.lastModified !== mtime && !this.ctx.getSettings().downloads.ignoreModTimeChanges);
      if (fresh) {
        it.size = size;
        it.lastModified = mtime;
        it.resumable = true;
        const n = size ? Math.max(1, Math.min(this.item.maxConnections || this.ctx.maxConnFor(it.url), Math.ceil(size / (1024 * 1024)))) : 1;
        const step = size ? Math.ceil(size / n) : Infinity;
        it.segments = [];
        for (let i = 0; i < n; i++) it.segments.push({ start: i * step, end: size ? Math.min(size, (i + 1) * step) : Infinity, pos: i * step });
      }
      this.emit('meta', { size, resumable: true, contentType: '', fileName: null });
      await fs.promises.mkdir(path.dirname(it.tempPath), { recursive: true });
      fh = await fs.promises.open(it.tempPath, fresh ? 'w+' : 'r+').catch(() => fs.promises.open(it.tempPath, 'w+'));
      this.emit('status', 'Receiving data...');
      let reuse = probe;
      await Promise.all(it.segments.map((seg) => {
        const c = reuse;
        reuse = null;
        return this.runSegment(seg, fh, c, remotePath);
      }));
      if (this.stopped) throw Object.assign(new Error('Stopped'), { stopped: true });
      if (it.size == null) {
        it.size = this.downloaded();
        it.segments[0].end = it.size;
      }
      await fh.close();
      fh = null;
      this.done('complete');
    } catch (e) {
      try {
        await fh?.close();
      } catch { /* ignore */ }
      this.done(this.stopped ? 'stopped' : 'failed', e);
    } finally {
      for (const c of this.clients) c.close();
      this.clients.clear();
    }
  }

  done(kind, err) {
    clearInterval(this.progressTimer);
    clearInterval(this.persistTimer);
    this.emit('progress', this.stats());
    this.emit('persist');
    if (kind === 'failed') this.emit('failed', err);
    else this.emit(kind);
  }

  async runSegment(seg, fh, client, remotePath) {
    const maxRetries = this.ctx.getSettings().connection.connectionRetries || 20;
    let tries = 0;
    while (seg.pos < seg.end && !this.stopped) {
      try {
        client = client || (await this.connect());
        const self = this;
        const sink = new Writable({
          write(chunk, _enc, cb) {
            const room = seg.end - seg.pos;
            const part = room < chunk.length ? chunk.subarray(0, room) : chunk;
            let wait = 0;
            for (const l of [self.limiter, ...self.ctx.limiters()]) wait = Math.max(wait, l.take(part.length));
            const doWrite = () => fh.write(part, 0, part.length, seg.pos).then(() => {
              seg.pos += part.length;
              self.meter.add(part.length);
              self.ctx.onBytes?.(part.length);
              if (seg.pos >= seg.end) {
                cb();
                client.close(); // stop the transfer at our boundary
              } else cb();
            }, cb);
            if (wait) setTimeout(doWrite, wait);
            else doWrite();
          },
        });
        await client.downloadTo(sink, remotePath, seg.pos);
        if (seg.end === Infinity) seg.end = seg.pos;
      } catch (e) {
        if (seg.pos >= seg.end || this.stopped) break;
        if (++tries > maxRetries) throw e;
        this.emit('status', `Retrying (${e.message})...`);
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(tries, 5)));
      } finally {
        if (client) {
          client.close();
          this.clients.delete(client);
        }
        client = null;
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const c of this.clients) c.close();
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
      resumable: true,
      connections: (it.segments || []).filter((s) => s.pos < s.end).map((s, i) => ({ id: i + 1, start: s.start, end: s.end === Infinity ? null : s.end, pos: s.pos, receiving: !this.stopped })),
      segments: (it.segments || []).map((s) => [s.start, s.end === Infinity ? null : s.end, s.pos]),
    };
  }
}

module.exports = { FtpDownload };

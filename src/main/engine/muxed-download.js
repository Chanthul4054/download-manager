'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { HttpDownload } = require('./http-download');
const { findFfmpeg, mux } = require('./ffmpeg');
const { moveFile } = require('../util');

/**
 * A download made of separate video and audio streams (YouTube/DASH adaptive formats).
 * Each part is an ordinary multi-connection HttpDownload with its own persisted segments;
 * when both finish they are merged with ffmpeg into item.tempPath. Without ffmpeg the
 * audio is kept as a separate file next to the video (item.extraFiles).
 */
class MuxedDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.engines = [];
    this.abort = new AbortController();
  }

  partItem(p, i) {
    const it = this.item;
    p.tempPath = p.tempPath || `${it.tempPath}.part${i}.${p.ext || 'bin'}`;
    p.referer = it.referer;
    // Only forward cookies to the page's own host (never e.g. youtube.com cookies to googlevideo.com).
    p.cookies = safeHost(p.url) === safeHost(it.url) ? it.cookies : '';
    p.userAgent = it.userAgent;
    p.maxConnections = it.maxConnections;
    p.speedLimitKB = it.speedLimitKB;
    if (p.rangeMode == null && /googlevideo\.com$/i.test(safeHost(p.url))) p.rangeMode = 'query';
    return p;
  }

  setSpeedLimit(kb) {
    this.item.speedLimitKB = kb;
    for (const e of this.engines) e.setSpeedLimit(kb);
  }

  setMaxConnections(n) {
    this.item.maxConnections = n;
    for (const e of this.engines) e.setMaxConnections(n);
  }

  async start() {
    const it = this.item;
    it.resumable = true;
    this.progressTimer = setInterval(() => this.emit('progress', this.stats()), 500);
    try {
      const parts = it.parts.map((p, i) => this.partItem(p, i));
      this.emit('meta', { size: this.totalSize(), resumable: true, contentType: '', fileName: null });
      this.emit('status', 'Receiving data...');
      const pending = parts.filter((p) => !p.done);
      const results = await Promise.all(pending.map((p) => this.runPart(p)));
      if (this.abort.signal.aborted) return this.done('stopped');
      const failed = results.find((r) => r instanceof Error);
      if (failed) return this.done('failed', failed);
      await this.assemble(parts);
      it.size = (await fs.promises.stat(it.tempPath)).size;
      this.done('complete');
    } catch (e) {
      this.done(this.abort.signal.aborted ? 'stopped' : 'failed', e);
    }
  }

  runPart(p) {
    return new Promise((resolve) => {
      const eng = new HttpDownload(p, { ...this.ctx });
      this.engines.push(eng);
      eng.on('persist', () => this.emit('persist'));
      eng.on('complete', () => {
        p.done = true;
        resolve(true);
      });
      eng.on('stopped', () => resolve(false));
      eng.on('failed', (err) => {
        // One stream failing makes the pair useless: stop the other one too.
        for (const e of this.engines) if (e !== eng) e.stop();
        resolve(err || new Error('Download failed'));
      });
      eng.start();
    });
  }

  async assemble(parts) {
    const it = this.item;
    if (parts.length === 1) return moveFile(parts[0].tempPath, it.tempPath);
    const video = parts.find((p) => p.role === 'video') || parts[0];
    const audio = parts.find((p) => p !== video);
    const ffmpeg = findFfmpeg(this.ctx.getSettings().videoPanel?.ffmpegPath);
    if (!ffmpeg) {
      // No merger available: deliver the video and keep the audio beside it.
      await moveFile(video.tempPath, it.tempPath);
      const base = it.fileName.replace(/\.[^.]+$/, '');
      it.extraFiles = [{ temp: audio.tempPath, name: `${base} (audio).${audio.ext || 'm4a'}` }];
      it.note = 'FFmpeg was not found, so video and audio were saved as separate files.';
      return;
    }
    this.emit('status', 'Merging video and audio...');
    const out = `${it.tempPath}.mux${path.extname(it.fileName) || '.mkv'}`;
    await mux(ffmpeg, video.tempPath, audio.tempPath, out, this.abort.signal);
    await moveFile(out, it.tempPath);
    await Promise.all(parts.map((p) => fs.promises.rm(p.tempPath, { force: true })));
  }

  totalSize() {
    const sizes = this.item.parts.map((p) => p.size);
    return sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : null;
  }

  done(kind, err) {
    clearInterval(this.progressTimer);
    this.emit('progress', this.stats());
    this.emit('persist');
    if (kind === 'failed') this.emit('failed', err);
    else this.emit(kind);
  }

  stop() {
    this.abort.abort();
    for (const e of this.engines) e.stop();
  }

  stats() {
    return muxedStats(this.item, this.engines);
  }
}

// Aggregates part progress into one segment map (parts laid end to end) for the UI.
function muxedStats(item, engines = []) {
  let offset = 0;
  let downloaded = 0;
  let rate = 0;
  const segments = [];
  const connections = [];
  for (const p of item.parts || []) {
    const eng = engines.find((e) => e.item === p);
    const st = eng ? eng.stats() : { downloaded: (p.segments || []).reduce((a, s) => a + (s.pos - s.start), 0) || (p.done ? p.size : 0), rate: 0, connections: [], segments: (p.segments || []).map((s) => [s.start, s.end, s.pos]) };
    downloaded += st.downloaded;
    rate += st.rate;
    for (const [a, b, c] of st.segments) segments.push([a + offset, b == null ? null : b + offset, c + offset]);
    if (p.done && !st.segments.length && p.size) segments.push([offset, offset + p.size, offset + p.size]);
    for (const c of st.connections) connections.push({ ...c, id: connections.length + 1, start: c.start + offset, end: c.end == null ? null : c.end + offset, pos: c.pos + offset, part: p.role });
    offset += p.size || 0;
  }
  const size = (item.parts || []).every((p) => p.size > 0) ? offset : null;
  return { downloaded, size, rate, eta: size && rate > 0 ? (size - downloaded) / rate : null, resumable: true, connections, segments };
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

module.exports = { MuxedDownload, muxedStats };

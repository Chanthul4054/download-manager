'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { findFfmpeg } = require('./ffmpeg');
const { moveFile } = require('../util');

// Sites handed to yt-dlp instead of being downloaded as plain files.
const PAGE_RE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)/i;

function isVideoPage(url) {
  return PAGE_RE.test(String(url || ''));
}

const EXE = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const RELEASE = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
};

/** Configured path, then the copy OpenDM installed in binDir, then PATH. */
function findYtDlp(configured, binDir) {
  if (configured && fs.existsSync(configured)) return configured;
  const own = path.join(binDir, EXE);
  if (fs.existsSync(own)) return own;
  const r = spawnSync(EXE, ['--version'], { windowsHide: true });
  return r.status === 0 ? EXE : null;
}

/** Downloads the latest official yt-dlp release into binDir. */
async function installYtDlp(net, binDir) {
  const url = RELEASE[process.platform];
  if (!url) throw new Error('No yt-dlp build for this platform');
  const { body } = await net.fetchBuffer(url, { maxBytes: 80 * 1024 * 1024, timeoutSec: 60 });
  if (body.length < 1024 * 1024) throw new Error('Downloaded yt-dlp looks incomplete');
  await fs.promises.mkdir(binDir, { recursive: true });
  const dest = path.join(binDir, EXE);
  await fs.promises.writeFile(dest + '.new', body, { mode: 0o755 });
  await fs.promises.rename(dest + '.new', dest);
  return dest;
}

// yt-dlp needs a JavaScript runtime to solve YouTube's player challenges (otherwise formats are
// missing or throttled). Inside Electron our own executable runs as Node with ELECTRON_RUN_AS_NODE.
function jsRuntime() {
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { args: ['--js-runtimes', `node:${process.execPath}`], env };
}

function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const rt = jsRuntime();
    const p = spawn(bin, [...rt.args, ...args], { windowsHide: true, env: rt.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(lastError(err) || `yt-dlp exited with ${code}`))));
  });
}

function lastError(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  return (lines.reverse().find((l) => /^ERROR:/.test(l)) || lines[0] || '').replace(/^ERROR:\s*/, '').slice(0, 400);
}

function proxyArg(settings) {
  const p = settings.proxy;
  if (p.mode !== 'manual') return [];
  const s = p.socks.enabled && p.socks.host ? `socks${p.socks.version === 4 ? 4 : 5}://${p.socks.host}:${p.socks.port}` : p.https.enabled && p.https.host ? `http://${p.https.host}:${p.https.port}` : '';
  return s ? ['--proxy', s] : [];
}

/** Title, duration and the video heights available, for the quality picker. */
async function videoInfo(bin, url, settings) {
  const out = await run(bin, ['-J', '--no-playlist', '--no-warnings', ...proxyArg(settings), url]);
  const j = JSON.parse(out);
  const heights = [...new Set((j.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))].sort((a, b) => b - a);
  const size = (h) => {
    const v = (j.formats || []).filter((f) => f.vcodec !== 'none' && f.height && f.height <= h).sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0))[0];
    const a = (j.formats || []).filter((f) => f.vcodec === 'none' && f.acodec !== 'none').sort((x, y) => (y.abr || 0) - (x.abr || 0))[0];
    const n = (f) => f?.filesize || f?.filesize_approx || 0;
    return n(v) + n(a) || null;
  };
  return { title: j.title || '', duration: j.duration || null, heights, sizes: Object.fromEntries(heights.map((h) => [h, size(h)])), extractor: j.extractor_key || '' };
}

function formatSelector(q) {
  if (q === 'audio') return 'ba[ext=m4a]/ba/b';
  const h = Number(q);
  if (h > 0) return `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
  return 'bv*+ba/b';
}

/**
 * Downloads a video page through yt-dlp. Pausing kills the process and keeps its .part files;
 * resuming reruns the same command, which continues them. The finished file is moved to item.tempPath.
 */
class YtDlpDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.rate = 0;
    this.eta = null;
    this.done = 0; // bytes of streams already finished in this run
    this.cur = { got: 0, total: 0 };
  }

  setSpeedLimit(kb) {
    this.item.speedLimitKB = kb; // applies on next start
  }

  setMaxConnections(n) {
    this.item.maxConnections = n;
  }

  workDir() {
    return this.item.tempPath + '.ytdlp';
  }

  args(ffmpeg) {
    const it = this.item;
    const s = this.ctx.getSettings();
    const q = it.ytdlp?.quality || 'best';
    const a = [
      '--newline', '--no-playlist', '--no-mtime', '--continue', '--no-warnings', '--no-colors',
      '-o', path.join(this.workDir(), 'media.%(ext)s'),
      '-f', formatSelector(q),
      // Highest resolution first; at equal resolution prefer MP4/M4A so the result is an .mp4.
      '-S', 'res,fps,ext:mp4:m4a',
      // --print implies --quiet; --progress keeps the progress lines coming.
      '--progress',
      '-N', String(Math.min(16, Math.max(1, it.maxConnections || s.connection.maxConnections || 4))),
      '--progress-template', 'download:ODMP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
      '--print', 'after_move:ODMF %(filepath)s',
      ...proxyArg(s),
    ];
    if (q !== 'audio') a.push('--merge-output-format', 'mp4/mkv');
    if (ffmpeg) a.push('--ffmpeg-location', ffmpeg);
    const kb = it.speedLimitKB || (s.speedLimiter.enabled ? s.speedLimiter.kbps : 0);
    if (kb > 0) a.push('--limit-rate', `${kb}K`);
    a.push(it.url);
    return a;
  }

  async start() {
    const it = this.item;
    const s = this.ctx.getSettings();
    this.progressTimer = setInterval(() => this.emit('progress', this.stats()), 500);
    const bin = findYtDlp(s.videoPanel.ytdlpPath, this.ctx.binDir);
    if (!bin) return this.finish('failed', new Error('yt-dlp is not installed. Install it in Options → Video panel.'));
    const ffmpeg = findFfmpeg(s.videoPanel.ffmpegPath);
    await fs.promises.mkdir(this.workDir(), { recursive: true });
    it.resumable = true;
    this.emit('status', 'Reading video information...');
    let final = null;
    let errText = '';
    const rt = jsRuntime();
    const p = (this.proc = spawn(bin, [...rt.args, ...this.args(ffmpeg)], { windowsHide: true, env: rt.env }));
    const lines = (onLine) => {
      let buf = '';
      return (d) => {
        buf += d;
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      };
    };
    const onLine = (line) => {
      if (line.startsWith('ODMP ')) this.onProgress(line.split(/\s+/).slice(1));
      else if (line.startsWith('ODMF ')) final = line.slice(5).trim();
      else if (line.startsWith('[Merger]')) this.emit('status', 'Merging video and audio...');
      else if (line.startsWith('[download] Destination')) this.emit('status', 'Receiving data...');
    };
    // Progress can arrive on either stream depending on yt-dlp's quiet mode.
    p.stdout.on('data', lines(onLine));
    p.stderr.on('data', lines((line) => {
      onLine(line);
      if (!line.startsWith('ODMP ')) errText = (errText + line + '\n').slice(-6000);
    }));
    p.on('error', (e) => this.finish('failed', e));
    p.on('close', async (code) => {
      this.proc = null;
      if (this.stopped) return this.finish('stopped');
      if (code !== 0 || !final) return this.finish('failed', new Error(lastError(errText) || `yt-dlp exited with ${code}`));
      try {
        const ext = path.extname(final);
        if (ext && path.extname(it.fileName).toLowerCase() !== ext.toLowerCase()) it.fileName = it.fileName.replace(/\.[^.]*$/, '') + ext;
        await moveFile(final, it.tempPath);
        await fs.promises.rm(this.workDir(), { recursive: true, force: true });
        it.size = (await fs.promises.stat(it.tempPath)).size;
        this.done = it.size;
        this.cur = { got: 0, total: 0 };
        this.finish('complete');
      } catch (e) {
        this.finish('failed', e);
      }
    });
  }

  onProgress([got, total, est, speed, eta]) {
    const n = (v) => (v === 'NA' || v == null ? 0 : Number(v) || 0);
    const g = n(got), t = n(total) || n(est);
    // yt-dlp fetches video then audio; a drop in bytes means the next stream started.
    if (g < this.cur.got * 0.5 && this.cur.total) this.done += this.cur.total;
    this.cur = { got: g, total: t };
    this.rate = n(speed);
    this.eta = n(eta) || null;
    this.ctx.onBytes?.(0);
  }

  finish(kind, err) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.progressTimer);
    this.rate = 0;
    this.emit('progress', this.stats());
    this.emit('persist');
    if (kind === 'failed') this.emit('failed', err);
    else this.emit(kind);
  }

  stop() {
    this.stopped = true;
    const p = this.proc;
    if (!p) return;
    // yt-dlp may be running ffmpeg as a child: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGTERM');
  }

  stats() {
    const downloaded = this.done + this.cur.got;
    const size = this.cur.total ? this.done + this.cur.total : this.item.size || null;
    return { downloaded, size, estimatedSize: size, rate: this.rate, eta: this.eta, resumable: true, connections: [], segments: size ? [[0, size, downloaded]] : [] };
  }
}

module.exports = { YtDlpDownload, findYtDlp, installYtDlp, videoInfo, isVideoPage, formatSelector };

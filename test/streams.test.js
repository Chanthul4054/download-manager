'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { NetContext } = require('../src/main/engine/net');
const { DownloadManager, isGoogleVideo, containerFor } = require('../src/main/manager');
const { Store } = require('../src/main/store');
const { findFfmpeg } = require('../src/main/engine/ffmpeg');

const ffmpeg = findFfmpeg();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-streams-'));
const media = {};

// Mimics googlevideo: byte ranges only via the `range` query parameter, never a Range header.
function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = media[u.searchParams.get('itag')];
    if (!body || req.headers.range || !u.searchParams.get('range')) {
      res.writeHead(403);
      return res.end();
    }
    const [a, b] = u.searchParams.get('range').split('-').map(Number);
    const chunk = body.subarray(a, b + 1);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length });
    res.end(chunk);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function setup() {
  const store = new Store(path.join(dir, 'data-' + Math.random()));
  store.settings.saveTo.tempDir = path.join(dir, 'tmp');
  store.settings.proxy.mode = 'none';
  store.settings.connection.maxConnections = 4;
  store.settings.connection.minSegmentKB = 64;
  store.categories.forEach((c) => (c.folder = path.join(dir, 'out')));
  return new DownloadManager(store, new NetContext({ getSettings: () => store.settings }));
}

const once = (em, ev) => new Promise((r) => em.once(ev, (...a) => r(a)));
let srv;

test.before(async () => {
  if (ffmpeg) {
    const v = path.join(dir, 'v.mp4'), a = path.join(dir, 'a.m4a');
    spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', v]);
    spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', a]);
    media['137'] = fs.readFileSync(v);
    media['140'] = fs.readFileSync(a);
  }
  media['999'] = Buffer.from(Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => i % 251));
  srv = await serve();
});
test.after(() => srv.server.close());

test('query-range mode downloads in bounded &range= chunks', async () => {
  const mgr = setup();
  const url = `${srv.base}/videoplayback?itag=999&clen=${media['999'].length}`;
  const { item } = await mgr.add({ url, fileName: 'q.bin', size: media['999'].length });
  Object.assign(mgr.get(item.id), { rangeMode: 'query', size: media['999'].length });
  const done = once(mgr, 'complete');
  const failed = once(mgr, 'failed');
  mgr.start(item.id);
  const [it] = await Promise.race([done, failed.then(([x]) => { throw new Error(x.error); })]);
  assert.ok(fs.readFileSync(it.savedPath).equals(media['999']));
  mgr.dispose();
});

test('video + audio streams are downloaded and merged', { skip: !ffmpeg && 'ffmpeg not available' }, async () => {
  const mgr = setup();
  const part = (itag, role, ext) => ({ role, ext, url: `${srv.base}/videoplayback?itag=${itag}&clen=${media[itag].length}`, size: media[itag].length });
  const { item } = await mgr.add({ url: 'https://www.youtube.com/watch?v=test', fileName: 'Test video.mp4', kind: 'muxed', parts: [part('137', 'video', 'mp4'), part('140', 'audio', 'm4a')] });
  assert.strictEqual(item.fileName, 'Test video.mp4');
  for (const p of mgr.get(item.id).parts) p.rangeMode = 'query';
  const done = once(mgr, 'complete');
  const failed = once(mgr, 'failed');
  mgr.start(item.id);
  const [it] = await Promise.race([done, failed.then(([x]) => { throw new Error(x.error); })]);
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', it.savedPath], { encoding: 'utf8' }).stderr;
  assert.match(probe, /Video: h264/);
  assert.match(probe, /Audio: aac/);
  mgr.dispose();
});

test('video page detection and yt-dlp quality selectors', () => {
  const { isVideoPage, formatSelector } = require('../src/main/engine/ytdlp');
  for (const u of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://m.youtube.com/shorts/abc', 'https://music.youtube.com/watch?v=abc']) assert.ok(isVideoPage(u), u);
  for (const u of ['https://www.youtube.com/', 'https://example.com/watch?v=abc', 'https://notyoutube.com/watch?v=1']) assert.ok(!isVideoPage(u), u);
  assert.strictEqual(formatSelector('720'), 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b');
  assert.strictEqual(formatSelector('audio'), 'ba[ext=m4a]/ba/b');
  assert.strictEqual(formatSelector('best'), 'bv*+ba/b');
});

test('helpers', () => {
  assert.ok(isGoogleVideo('https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&clen=100'));
  assert.ok(!isGoogleVideo('https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137'));
  assert.ok(!isGoogleVideo('https://evilgooglevideo.com/videoplayback?clen=5'));
  assert.strictEqual(containerFor([{ ext: 'mp4', role: 'video' }, { ext: 'm4a', role: 'audio' }]), 'mp4');
  assert.strictEqual(containerFor([{ ext: 'webm', role: 'video' }, { ext: 'webm', role: 'audio' }]), 'webm');
  assert.strictEqual(containerFor([{ ext: 'webm', role: 'video' }, { ext: 'm4a', role: 'audio' }]), 'mkv');
  assert.strictEqual(containerFor([{ ext: 'm4a', role: 'audio' }]), 'm4a');
});

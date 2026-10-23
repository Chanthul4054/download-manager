'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { NetContext } = require('../src/main/engine/net');
const { DownloadManager } = require('../src/main/manager');
const { Store } = require('../src/main/store');

const MB = 1024 * 1024;
let srv;

test.before(async () => {
  const child = fork(path.join(__dirname, '..', 'bench', 'bench-server.js'), [], { env: { ...process.env, BENCH_MAX_BYTES: String(16 * MB) }, stdio: 'inherit' });
  const { port } = await new Promise((r) => child.once('message', r));
  srv = { child, base: `http://127.0.0.1:${port}` };
});
test.after(() => srv.child.kill());

function setup(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-rob-'));
  const store = new Store(path.join(dir, 'data'));
  store.settings.saveTo.tempDir = path.join(dir, 'tmp');
  store.settings.proxy.mode = 'none';
  store.settings.connection.minSegmentKB = 128;
  Object.assign(store.settings.downloads, patch.downloads || {});
  Object.assign(store.settings.connection, patch.connection || {});
  store.categories.forEach((c) => (c.folder = path.join(dir, 'out')));
  const mgr = new DownloadManager(store, new NetContext({ getSettings: () => store.settings }));
  t.after(() => mgr.dispose());
  return { mgr, store };
}

function finished(mgr, id) {
  return new Promise((resolve) => {
    const done = (it) => it.id === id && (cleanup(), resolve({ ok: true, item: it }));
    const fail = (it) => it.id === id && (cleanup(), resolve({ ok: false, item: it }));
    const cleanup = () => (mgr.off('complete', done), mgr.off('failed', fail));
    mgr.on('complete', done);
    mgr.on('failed', fail);
  });
}

async function hashMatches(item, bytes) {
  const want = await (await fetch(`${srv.base}/hash/${bytes}`)).text();
  return crypto.createHash('sha256').update(fs.readFileSync(item.savedPath)).digest('hex') === want;
}

test('a 206 with the wrong byte range falls back to one connection instead of corrupting the file', async (t) => {
  const { mgr } = setup(t, { connection: { maxConnections: 4 } });
  const size = 8 * MB;
  const { item } = await mgr.add({ url: `${srv.base}/file/${size}?badrange&rate=${4 * MB}` });
  const end = finished(mgr, item.id);
  mgr.start(item.id);
  const r = await end;
  assert.ok(r.ok, r.item.error);
  assert.ok(await hashMatches(r.item, size), 'file content differs from the server copy');
});

test('a dropped connection is resumed and the file is intact', async (t) => {
  const { mgr } = setup(t, { connection: { maxConnections: 1 } });
  const size = 4 * MB;
  const { item } = await mgr.add({ url: `${srv.base}/file/${size}?truncate` });
  const end = finished(mgr, item.id);
  mgr.start(item.id);
  const r = await end;
  assert.ok(r.ok, r.item.error);
  assert.ok(await hashMatches(r.item, size));
});

test('HTTP 429 waits for Retry-After and then succeeds', async (t) => {
  const { mgr } = setup(t, { connection: { maxConnections: 1 } });
  const size = MB;
  const { item } = await mgr.add({ url: `${srv.base}/flaky/1/429/file/${size}` });
  const end = finished(mgr, item.id);
  const t0 = Date.now();
  mgr.start(item.id);
  const r = await end;
  assert.ok(r.ok, r.item.error);
  assert.ok(Date.now() - t0 >= 900, 'retried before Retry-After elapsed');
  assert.ok(await hashMatches(r.item, size));
});

test('a permanent 404 fails without retrying forever', async (t) => {
  const { mgr } = setup(t);
  const { item } = await mgr.add({ url: `${srv.base}/status/404` });
  const end = finished(mgr, item.id);
  mgr.start(item.id);
  const r = await end;
  assert.strictEqual(r.ok, false);
  assert.match(r.item.error, /404/);
});

test('downloads.maxSimultaneous limits running downloads; the rest wait and then finish', async (t) => {
  const { mgr } = setup(t, { downloads: { maxSimultaneous: 2 }, connection: { maxConnections: 2 } });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await mgr.add({ url: `${srv.base}/file/${MB + i}?rate=${8 * MB}` })).item.id);
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, mgr.activeCount())), 5);
  const ends = ids.map((id) => finished(mgr, id));
  for (const id of ids) mgr.start(id);
  assert.strictEqual(mgr.get(ids[4]).status, 'waiting');
  assert.ok(mgr.isActive(ids[4]));
  const rs = await Promise.all(ends);
  clearInterval(watch);
  assert.ok(rs.every((r) => r.ok), rs.map((r) => r.item.error).join());
  assert.ok(peak <= 2, `peak ${peak} running downloads`);
  for (const [i, r] of rs.entries()) assert.ok(await hashMatches(r.item, MB + i));
});

test('stopping a waiting download keeps it from starting later', async (t) => {
  const { mgr } = setup(t, { downloads: { maxSimultaneous: 1 } });
  const a = (await mgr.add({ url: `${srv.base}/file/${2 * MB}?rate=${8 * MB}` })).item.id;
  const b = (await mgr.add({ url: `${srv.base}/file/${MB}` })).item.id;
  const endA = finished(mgr, a);
  mgr.start(a);
  mgr.start(b);
  assert.strictEqual(mgr.get(b).status, 'waiting');
  mgr.stop(b);
  assert.strictEqual(mgr.get(b).status, 'paused');
  await endA;
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(mgr.get(b).status, 'paused');
  assert.strictEqual(mgr.isActive(b), false);
});

test('split archive parts keep their names in one folder', async (t) => {
  const { mgr } = setup(t, { downloads: { maxSimultaneous: 3 } });
  const dir = path.join(os.tmpdir(), `odm-parts-${process.pid}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['show.part1.rar', 'show.part2.rar', 'show.part3.rar'];
  const ids = [];
  for (const [i, n] of names.entries()) ids.push((await mgr.add({ url: `${srv.base}/file/${MB + i}`, fileName: n, saveDir: dir })).item.id);
  const ends = ids.map((id) => finished(mgr, id));
  ids.forEach((id) => mgr.start(id));
  const rs = await Promise.all(ends);
  assert.ok(rs.every((r) => r.ok));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), names);
});

test('diagnostic addresses drop query strings and credentials', () => {
  const { redactUrl } = require('../src/main/diag');
  assert.strictEqual(redactUrl('https://user:secret@cdn.example.com/f/a.zip?token=abc&sig=1'), 'https://cdn.example.com/f/a.zip');
  assert.strictEqual(redactUrl('not a url'), '(invalid url)');
});

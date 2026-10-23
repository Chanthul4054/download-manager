'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NetContext } = require('../src/main/engine/net');
const { DownloadManager } = require('../src/main/manager');
const { Store } = require('../src/main/store');
const { LinkGrabber, packageNameFor } = require('../src/main/linkgrabber');

function serve() {
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/gone.zip') {
      res.writeHead(404);
      return res.end();
    }
    if (p === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<a href="/files/a.pdf">A</a> <a href="/files/b.pdf">B</a> <a href="/other.html">next</a>');
    }
    if (p === '/dl') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Real Name.part2.rar"', 'Content-Length': 10 });
      return res.end('0123456789');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 1000 });
    res.end(Buffer.alloc(1000));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-lg-'));
  const store = new Store(path.join(dir, 'data'));
  store.settings.saveTo.tempDir = path.join(dir, 'tmp');
  store.settings.proxy.mode = 'none';
  store.categories.forEach((c) => (c.folder = path.join(dir, 'out')));
  const net = new NetContext({ getSettings: () => store.settings });
  const mgr = new DownloadManager(store, net);
  const lg = new LinkGrabber(store, net, mgr);
  t.after(() => {
    lg.dispose();
    mgr.dispose();
  });
  return { dir, store, mgr, lg };
}

const idle = (lg) => new Promise((resolve) => {
  const check = () => (lg.snapshot().busy ? null : (lg.off('changed', check), resolve()));
  lg.on('changed', check);
  check();
});

let srv;
test.before(async () => {
  srv = await serve();
});
test.after(() => srv.server.close());

test('package names drop archive part numbers and extensions', () => {
  assert.strictEqual(packageNameFor('Movie.2020.part01.rar'), 'Movie.2020');
  assert.strictEqual(packageNameFor('Movie.2020.part2.rar'), 'Movie.2020');
  assert.strictEqual(packageNameFor('backup.7z.003'), 'backup');
  assert.strictEqual(packageNameFor('data.z01'), 'data');
  assert.strictEqual(packageNameFor('data.zip'), 'data');
  assert.strictEqual(packageNameFor('set.vol03+04.par2'), 'set');
  assert.strictEqual(packageNameFor('source.tar.gz'), 'source');
  assert.strictEqual(packageNameFor('song.mp3'), 'song');
});

test('links are checked, grouped into packages and skipped when added twice', async (t) => {
  const { lg } = setup(t);
  const n = lg.add({ text: `${srv.base}/x.part1.rar\n${srv.base}/x.part2.rar ${srv.base}/single.mp4 ${srv.base}/gone.zip ${srv.base}/single.mp4` });
  assert.strictEqual(n, 4);
  await idle(lg);
  const byName = Object.fromEntries(lg.packages.map((p) => [p.name, p]));
  assert.deepStrictEqual(byName.x.links.map((l) => l.name).sort(), ['x.part1.rar', 'x.part2.rar']);
  assert.ok(byName.x.links.every((l) => l.status === 'online' && l.size === 1000));
  assert.strictEqual(byName['Various files'].links[0].name, 'single.mp4');
  assert.strictEqual(byName.Offline.links[0].status, 'offline');
  assert.strictEqual(lg.add({ text: `${srv.base}/single.mp4` }), 0);
});

test('a server-provided name moves a link into the matching package', async (t) => {
  const { lg } = setup(t);
  lg.add({ text: `${srv.base}/Real%20Name.part1.rar` });
  await idle(lg);
  lg.add({ text: `${srv.base}/dl` });
  await idle(lg);
  const pkg = lg.packages.find((p) => p.name === 'Real Name');
  assert.ok(pkg, 'expected a "Real Name" package, got ' + lg.packages.map((p) => p.name));
  assert.strictEqual(pkg.links.length, 2);
});

test('deep analysis replaces a web page with the files it links to', async (t) => {
  const { lg } = setup(t);
  lg.add({ text: `${srv.base}/page.html`, deep: true });
  await idle(lg);
  const urls = lg.links().map((l) => l.url).sort();
  assert.deepStrictEqual(urls, [`${srv.base}/files/a.pdf`, `${srv.base}/files/b.pdf`]);
  assert.ok(lg.links().every((l) => l.referer === `${srv.base}/page.html`));
});

test('confirming moves online links to the download list into a package folder', async (t) => {
  const { lg, mgr, dir } = setup(t);
  lg.add({ text: `${srv.base}/y.part1.rar ${srv.base}/y.part2.rar ${srv.base}/gone.zip` });
  await idle(lg);
  const ids = await lg.confirm([]);
  assert.strictEqual(ids.length, 2);
  const items = ids.map((id) => mgr.get(id));
  assert.ok(items.every((it) => it.saveDir === path.join(dir, 'out', 'y')), items.map((it) => it.saveDir).join());
  // The offline link stays behind.
  assert.deepStrictEqual(lg.links().map((l) => l.status), ['offline']);
  // Links already in the download list are skipped by default.
  lg.add({ text: `${srv.base}/y.part1.rar` });
  await idle(lg);
  assert.strictEqual(lg.links().find((l) => l.url.endsWith('y.part1.rar')).inList, true);
  assert.deepStrictEqual(await lg.confirm([]), []);
});

test('merge and rename keep links in a user package', async (t) => {
  const { lg } = setup(t);
  lg.add({ text: `${srv.base}/one.bin ${srv.base}/two.bin` });
  await idle(lg);
  const id = lg.merge(lg.links().map((l) => l.id), 'Mine');
  assert.strictEqual(lg.packages.length, 1);
  assert.strictEqual(lg.packages[0].id, id);
  lg.recheck([id]);
  await idle(lg);
  assert.strictEqual(lg.packages.length, 1);
  assert.strictEqual(lg.packages[0].name, 'Mine');
});

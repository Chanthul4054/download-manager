'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { NetContext } = require('../src/main/engine/net');
const { DownloadManager } = require('../src/main/manager');
const { QueueManager } = require('../src/main/queues');
const { Store } = require('../src/main/store');
const { parsePlaylist } = require('../src/main/engine/hls-download');
const u = require('../src/main/util');

const DATA = crypto.randomBytes(6 * 1024 * 1024 + 123);
const KEY = crypto.randomBytes(16);

function serve() {
  const hits = { ranges: [] };
  const server = http.createServer((req, res) => {
    const slow = (body) => {
      // ~4 MB/s per connection so extra connections get a chance to split.
      let i = 0;
      const pump = () => {
        if (res.destroyed) return;
        while (i < body.length) {
          const chunk = body.subarray(i, i + 64 * 1024);
          i += chunk.length;
          if (!res.write(chunk)) return res.once('drain', () => setTimeout(pump, 10));
          return setTimeout(pump, 15);
        }
        res.end();
      };
      pump();
    };
    if (req.url === '/redir') {
      res.writeHead(302, { Location: '/named' });
      return res.end();
    }
    if (req.url.startsWith('/file') || req.url === '/named') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const extra = req.url === '/named' ? { 'Content-Disposition': Buffer.from('attachment; filename="réport final.bin"', 'utf8').toString('latin1') } : {};
      if (range) {
        hits.ranges.push(Number(range[1]));
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : DATA.length - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: '"v1"', ...extra });
        return slow(DATA.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Length': DATA.length, ...extra });
      return slow(DATA);
    }
    if (req.url === '/norange') {
      res.writeHead(200, { 'Content-Length': DATA.length });
      return slow(DATA);
    }
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720\nhi.m3u8\n');
    }
    if (req.url === '/hi.m3u8') {
      let s = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n';
      for (let i = 0; i < 5; i++) s += `#EXTINF:2.0,\nseg${i}.ts\n`;
      res.writeHead(200);
      return res.end(s + '#EXT-X-ENDLIST\n');
    }
    if (req.url === '/key.bin') return res.end(KEY);
    const m = /^\/seg(\d)\.ts$/.exec(req.url);
    if (m) {
      const i = Number(m[1]);
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(i, 12);
      const c = crypto.createCipheriv('aes-128-cbc', KEY, iv);
      return res.end(Buffer.concat([c.update(DATA.subarray(i * 1000, i * 1000 + 1000)), c.final()]));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}`, hits })));
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-test-'));
  const store = new Store(path.join(dir, 'data'));
  store.settings.saveTo.tempDir = path.join(dir, 'tmp');
  store.settings.proxy.mode = 'none';
  store.settings.connection.maxConnections = 6;
  store.settings.connection.minSegmentKB = 128;
  store.categories.forEach((c) => (c.folder = path.join(dir, 'out')));
  const net = new NetContext({ getSettings: () => store.settings });
  const mgr = new DownloadManager(store, net);
  return { dir, store, net, mgr };
}

function once(em, ev, pred = () => true) {
  return new Promise((resolve) => {
    const h = (...a) => {
      if (!pred(...a)) return;
      em.off(ev, h);
      resolve(a);
    };
    em.on(ev, h);
  });
}

let srv;
test.before(async () => {
  srv = await serve();
});
test.after(() => srv.server.close());

test('multi-connection download is byte-identical and uses several connections', async () => {
  const { mgr } = setup();
  srv.hits.ranges = [];
  const done = once(mgr, 'complete');
  const failed = once(mgr, 'failed');
  await mgr.add({ url: srv.base + '/file.bin', start: true });
  const [item] = await Promise.race([done, failed.then(([it]) => { throw new Error(it.error); })]);
  assert.ok(srv.hits.ranges.length > 1, 'expected more than one ranged connection, got ' + srv.hits.ranges.length);
  assert.ok(crypto.createHash('sha1').update(fs.readFileSync(item.savedPath)).digest('hex') === crypto.createHash('sha1').update(DATA).digest('hex'));
  mgr.dispose();
});

test('pause and resume continues from saved segments', async () => {
  const { mgr, store } = setup();
  store.settings.speedLimiter = { enabled: true, kbps: 3000 };
  mgr.applySpeedLimiter();
  const { item } = await mgr.add({ url: srv.base + '/file.bin' });
  mgr.start(item.id);
  await new Promise((r) => setTimeout(r, 600));
  mgr.stop(item.id);
  await once(mgr, 'stopped');
  const partial = mgr.get(item.id).downloaded;
  assert.ok(partial > 0 && partial < DATA.length, 'partial ' + partial);
  srv.hits.ranges = [];
  store.settings.speedLimiter.enabled = false;
  mgr.applySpeedLimiter();
  const done = once(mgr, 'complete');
  mgr.start(item.id);
  const [fin] = await done;
  assert.ok(!srv.hits.ranges.includes(0) || srv.hits.ranges.filter((x) => x === 0).length === 0, 'resume should not restart at 0');
  assert.ok(fs.readFileSync(fin.savedPath).equals(DATA));
  mgr.dispose();
});

test('server without range support downloads on one connection', async () => {
  const { mgr } = setup();
  const done = once(mgr, 'complete');
  await mgr.add({ url: srv.base + '/norange', fileName: 'x.bin', start: true });
  const [item] = await done;
  assert.strictEqual(mgr.get(item.id).resumable, false);
  assert.ok(fs.readFileSync(item.savedPath).equals(DATA));
  mgr.dispose();
});

test('redirect + Content-Disposition names the file', async () => {
  const { mgr } = setup();
  const done = once(mgr, 'complete');
  await mgr.add({ url: srv.base + '/redir', start: true });
  const [item] = await done;
  assert.strictEqual(item.fileName, 'réport final.bin');
  mgr.dispose();
});

test('existing file gets a numbered name', async () => {
  const { mgr } = setup();
  let done = once(mgr, 'complete');
  await mgr.add({ url: srv.base + '/file1.bin', fileName: 'same.bin', start: true });
  const [a] = await done;
  done = once(mgr, 'complete');
  await mgr.add({ url: srv.base + '/file2.bin', fileName: 'same.bin', start: true });
  const [b] = await done;
  assert.notStrictEqual(a.savedPath, b.savedPath);
  assert.match(path.basename(b.savedPath), /same \(2\)\.bin/);
  mgr.dispose();
});

test('HLS master playlist picks best variant and decrypts AES-128', async () => {
  const { mgr } = setup();
  const done = once(mgr, 'complete');
  const failed = once(mgr, 'failed');
  await mgr.add({ url: srv.base + '/master.m3u8', start: true });
  const [item] = await Promise.race([done, failed.then(([it]) => { throw new Error(it.error); })]);
  assert.match(item.fileName, /\.ts$/);
  assert.ok(fs.readFileSync(item.savedPath).equals(DATA.subarray(0, 5000)));
  mgr.dispose();
});

test('download queue runs items and empties itself', async () => {
  const { store, mgr } = setup();
  const qm = new QueueManager(store, mgr);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await mgr.add({ url: `${srv.base}/file${i}q.bin` })).item.id);
  qm.addItems('main', ids);
  qm.get('main').maxConcurrent = 2;
  const fin = once(qm, 'finished');
  qm.start('main');
  const [q] = await fin;
  assert.strictEqual(q.items.length, 0);
  assert.ok(ids.every((id) => mgr.get(id).status === 'complete'));
  qm.dispose();
  mgr.dispose();
});

test('scheduler starts a queue at its start time', () => {
  const { store, mgr } = setup();
  const qm = new QueueManager(store, mgr);
  const q = qm.get('main');
  q.schedule = { ...q.schedule, startEnabled: true, startTime: '03:15', mode: 'daily', days: [0, 1, 2, 3, 4, 5, 6] };
  let started = 0;
  qm.on('started', () => started++);
  qm.checkSchedules(new Date(2026, 0, 5, 3, 14));
  assert.strictEqual(started, 0);
  qm.checkSchedules(new Date(2026, 0, 5, 3, 15));
  qm.checkSchedules(new Date(2026, 0, 5, 3, 15));
  assert.strictEqual(started, 1);
  qm.stop('main');
  qm.dispose();
  mgr.dispose();
});

test('utilities', () => {
  assert.deepStrictEqual(u.expandBatch('http://x/img*.jpg', 1, 3, 2), ['http://x/img01.jpg', 'http://x/img02.jpg', 'http://x/img03.jpg']);
  assert.deepStrictEqual(u.expandBatch('http://x/*.zip', 'a', 'c'), ['http://x/a.zip', 'http://x/b.zip', 'http://x/c.zip']);
  assert.strictEqual(u.fileNameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve.pdf"), 'naïve.pdf');
  assert.strictEqual(u.sanitizeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.ok(u.hostMatches('*.tonec.com', 'www.tonec.com'));
  assert.deepStrictEqual(u.extractUrls('see http://a.com/x.zip, and ftp://b/y)'), ['http://a.com/x.zip', 'ftp://b/y']);
  const pl = parsePlaylist('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', 'http://h/p/list.m3u8');
  assert.strictEqual(pl.segments[0].uri, 'http://h/p/a.ts');
});

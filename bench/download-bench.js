'use strict';
// Download benchmark: runs the real DownloadManager against a local test server.
//
//   node bench/download-bench.js [--src <dir>] [--runs 3] [--only name,name] [--json out.json]
//
// --src points at another copy of the app's src/ folder (e.g. a baseline checkout) so two
// versions can be compared on the same machine. Results are for the loopback network only and
// say nothing about how fast a particular internet host will be.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const SRC = path.resolve(args.src || path.join(__dirname, '..', 'src'));
const RUNS = Number(args.runs || 3);
const MB = 1024 * 1024;

const { Store } = require(path.join(SRC, 'main', 'store'));
const { NetContext } = require(path.join(SRC, 'main', 'engine', 'net'));
const { DownloadManager } = require(path.join(SRC, 'main', 'manager'));

// name, files: [{path, bytes}], connections per file.
const SCENARIOS = [
  { name: 'small-1MB-x20', files: Array.from({ length: 20 }, (_, i) => ({ path: `/file/${MB + i}`, bytes: MB + i })), conns: 8 },
  { name: 'large-256MB-1conn', files: [{ path: `/file/${256 * MB}`, bytes: 256 * MB }], conns: 1 },
  { name: 'large-256MB-8conn', files: [{ path: `/file/${256 * MB}`, bytes: 256 * MB }], conns: 8 },
  { name: 'multi-8x64MB-8conn', files: Array.from({ length: 8 }, (_, i) => ({ path: `/file/${64 * MB + i}`, bytes: 64 * MB + i })), conns: 8 },
  { name: 'norange-128MB', files: [{ path: `/file/${128 * MB}?norange`, bytes: 128 * MB }], conns: 8 },
  { name: 'redirect3-64MB', files: [{ path: `/redirect/3/file/${64 * MB}`, bytes: 64 * MB }], conns: 8 },
  // 4 MB/s per connection: a server that caps each connection, where extra connections help.
  { name: 'capped-32MB-1conn', files: [{ path: `/file/${32 * MB}?rate=${4 * MB}`, bytes: 32 * MB }], conns: 1 },
  { name: 'capped-32MB-4conn', files: [{ path: `/file/${32 * MB}?rate=${4 * MB}`, bytes: 32 * MB }], conns: 4 },
  { name: 'capped-32MB-8conn', files: [{ path: `/file/${32 * MB}?rate=${4 * MB}`, bytes: 32 * MB }], conns: 8 },
  { name: 'capped-32MB-16conn', files: [{ path: `/file/${32 * MB}?rate=${4 * MB}`, bytes: 32 * MB }], conns: 16 },
];

function startServer() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'bench-server.js'), [], { stdio: 'inherit' });
    child.once('message', (m) => resolve({ child, base: `http://127.0.0.1:${m.port}` }));
    child.once('error', reject);
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function runOnce(base, sc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-bench-'));
  const store = new Store(path.join(dir, 'data'));
  store.settings.saveTo.tempDir = path.join(dir, 'tmp');
  store.settings.proxy.mode = 'none';
  store.settings.connection.maxConnections = sc.conns;
  store.settings.downloads.maxSimultaneous = Math.max(8, store.settings.downloads.maxSimultaneous || 0);
  store.categories.forEach((c) => (c.folder = path.join(dir, 'out')));
  const net = new NetContext({ getSettings: () => store.settings });
  const mgr = new DownloadManager(store, net);

  const lag = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = 0;
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);
  lag.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const ids = [];
  const finished = new Map();
  const done = new Promise((resolve) => {
    const check = () => finished.size === sc.files.length && resolve();
    mgr.on('complete', (it) => (finished.set(it.id, { ok: true, at: performance.now(), item: it }), check()));
    mgr.on('failed', (it) => (finished.set(it.id, { ok: false, at: performance.now(), item: it }), check()));
  });
  for (const f of sc.files) ids.push((await mgr.add({ url: base + f.path, fileName: `f${ids.length}.bin`, duplicateAction: 'number' })).item.id);
  for (const id of ids) mgr.start(id);
  await done;
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  lag.disable();
  clearInterval(sampler);
  mgr.dispose();

  let okFiles = 0;
  const errors = [];
  for (const [id, r] of finished) {
    const f = sc.files[ids.indexOf(id)];
    if (!r.ok) {
      errors.push(r.item.error);
      continue;
    }
    const want = await (await fetch(`${base}/hash/${f.bytes}`)).text();
    if ((await sha256File(r.item.savedPath)) === want) okFiles++;
    else errors.push('hash mismatch ' + r.item.fileName);
  }
  const bytes = sc.files.reduce((a, f) => a + f.bytes, 0);
  await store.flushAll().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    wallMs: wall,
    mbps: bytes / MB / (wall / 1000),
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuPerGB: ((cpu.user + cpu.system) / 1000) / (bytes / (1024 * MB)),
    peakRssMB: peakRss / MB,
    loopP99ms: lag.percentile(99) / 1e6,
    loopMaxMs: lag.max / 1e6,
    ok: okFiles,
    files: sc.files.length,
    errors,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

(async () => {
  const { child, base } = await startServer();
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const results = {};
  console.log(`src: ${SRC}\nnode ${process.version} · ${os.cpus()[0].model} · runs ${RUNS}\n`);
  console.log('scenario'.padEnd(22), 'MB/s(med)'.padStart(10), 'MB/s(min..max)'.padStart(17), 'wall s'.padStart(8), 'CPU ms/GB'.padStart(10), 'RSS MB'.padStart(8), 'loop p99'.padStart(9), ' integrity');
  for (const sc of SCENARIOS) {
    if (only && !only.has(sc.name)) continue;
    // One warm-up run so the server's hash cache and disk are not part of the first sample.
    if (!results.__warm) {
      await runOnce(base, sc);
      results.__warm = true;
    }
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runOnce(base, sc));
    const r = {
      mbps: median(runs.map((x) => x.mbps)),
      mbpsMin: Math.min(...runs.map((x) => x.mbps)),
      mbpsMax: Math.max(...runs.map((x) => x.mbps)),
      wallS: median(runs.map((x) => x.wallMs)) / 1000,
      cpuPerGB: median(runs.map((x) => x.cpuPerGB)),
      peakRssMB: Math.max(...runs.map((x) => x.peakRssMB)),
      loopP99ms: median(runs.map((x) => x.loopP99ms)),
      ok: runs.reduce((a, x) => a + x.ok, 0),
      files: runs.reduce((a, x) => a + x.files, 0),
      errors: runs.flatMap((x) => x.errors),
    };
    results[sc.name] = r;
    console.log(sc.name.padEnd(22), r.mbps.toFixed(1).padStart(10), `${r.mbpsMin.toFixed(0)}..${r.mbpsMax.toFixed(0)}`.padStart(17), r.wallS.toFixed(2).padStart(8),
      r.cpuPerGB.toFixed(0).padStart(10), r.peakRssMB.toFixed(0).padStart(8), r.loopP99ms.toFixed(1).padStart(9), ` ${r.ok}/${r.files}${r.errors.length ? ' ' + [...new Set(r.errors)].join('; ') : ''}`);
  }
  delete results.__warm;
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ src: SRC, node: process.version, runs: RUNS, results }, null, 2));
  child.disconnect();
  child.kill();
  process.exit(0);
})();

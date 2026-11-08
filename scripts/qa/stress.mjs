// Stress and endurance run of the packaged build. node stress.mjs <opendm.exe> <bench_server.exe> <workdir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { launch, ipc, sleep, memoryMB, cpuSec } from './cdp.mjs';

const [exe, benchExe, work] = process.argv.slice(2);
const results = {};
const log = (k, v) => { results[k] = v; console.log(k, JSON.stringify(v)); };
const MB = 1024 * 1024;
const live = new Set();
process.on('exit', () => { for (const p of live) try { execSync(`taskkill /F /T /PID ${p}`, { stdio: 'ignore' }); } catch {} });

fs.rmSync(work, { recursive: true, force: true });
const data = path.join(work, 'data');
const out = path.join(work, 'out');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(out);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  general: { monitorClipboard: false, minimizeToTray: true, integrationPort: 52792 },
  downloads: { showStartDialog: false, showCompleteDialog: false, progressDialog: 'none', duplicateAction: 'number', maxSimultaneous: 100 },
  connection: { maxConnections: 4, connectionRetries: 1 },
  proxy: { mode: 'none' }, sounds: { complete: false, failed: false, queueDone: false }, saveTo: { tempDir: path.join(data, 'tmp') },
}));
// A realistic history alongside the active work.
fs.writeFileSync(path.join(data, 'downloads.json'), JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({
  id: `h${i}`, url: `http://example.invalid/f/${i}.zip`, fileName: `old-${i}.zip`, status: 'complete', size: 1e6 + i, downloaded: 1e6 + i,
  added: Date.now() - (2000 - i) * 3600e3, completedAt: Date.now() - (2000 - i) * 3600e3, savedPath: `C:\\nowhere\\old-${i}.zip`,
}))));

const srv = spawn(benchExe, [], { env: { ...process.env, BENCH_MAX_BYTES: String(40 * MB) }, stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));
const items = async (c) => (await ipc(c, 'state')).items;
const metrics = async (c) => Object.fromEntries((await c.send('Performance.getMetrics')).result.metrics.filter((m) => ['Nodes', 'JSEventListeners', 'JSHeapUsedSize', 'Documents'].includes(m.name)).map((m) => [m.name, m.name === 'JSHeapUsedSize' ? +(m.value / MB).toFixed(1) : m.value]));
const gc = (c) => c.send('HeapProfiler.collectGarbage');
const frames = (c, ms) => c.evaluate(`(async () => { const t0 = performance.now(); let n = 0, long = 0, worst = 0, prev = t0;
  while (performance.now() - t0 < ${ms}) { await new Promise(r => requestAnimationFrame(r)); const t = performance.now(); const d = t - prev; if (d > 50) long++; worst = Math.max(worst, d); n++; prev = t; }
  return { fps: Math.round(n / (${ms} / 1000)), longFrames: long, worstFrameMs: Math.round(worst) }; })()`);

try {
  const app = await launch(exe, data);
  live.add(app.child.pid);
  const { c } = app;
  await c.send('Performance.enable');
  await sleep(1500);
  await gc(c);
  log('start', { rendered_ms: Math.round(app.tRender), memory: memoryMB(app.child.pid), dom: await metrics(c), idleFrames: await frames(c, 3000) });

  if (!process.env.SKIP_LOAD) {
  // ---- 60 concurrent downloads, 32 MB each, 4 connections at 128 KB/s each (~60 s) ----
  const N = 60, SIZE = 32 * MB;
  const ids = (await ipc(c, 'dl:addMany', Array.from({ length: N }, (_, i) => ({ url: `${base}/file/${SIZE - i}?rate=${128 * 1024}`, saveDir: out })), { start: true })).map(String);
  const samples = [];
  let cpu0 = cpuSec(app.child.pid), t0 = Date.now();
  for (;;) {
    await sleep(8000);
    const cpu1 = cpuSec(app.child.pid), t1 = Date.now();
    const all = await items(c);
    const mine = all.filter((x) => ids.includes(x.id));
    const st = mine.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
    samples.push({ t: Math.round((t1 - t0) / 1000), cpuPctTree: +(((cpu1.tree - cpu0.tree) / ((t1 - t0) / 1000)) * 100).toFixed(1), cpuPctApp: +(((cpu1.app - cpu0.app) / ((t1 - t0) / 1000)) * 100).toFixed(1), mem: memoryMB(app.child.pid).treePrivate, appWs: memoryMB(app.child.pid).appWorkingSet, frames: await frames(c, 2000), status: st });
    cpu0 = cpu1; t0 = t1;
    if (mine.every((x) => ['complete', 'error'].includes(x.status))) break;
    if (samples.length > 25) break;
  }
  const final = (await items(c)).filter((x) => ids.includes(x.id));
  let shaOk = 0;
  const want = {};
  for (const x of final) {
    if (x.status !== 'complete') continue;
    const n = x.downloaded;
    want[n] ??= (await (await fetch(`${base}/hash/${n}`)).text()).trim();
    if (crypto.createHash('sha256').update(fs.readFileSync(x.savedPath)).digest('hex') === want[n]) shaOk++;
  }
  log('concurrent_60', { samples, complete: final.filter((x) => x.status === 'complete').length, shaOk, errors: final.filter((x) => x.status === 'error').map((x) => x.error) });

  // ---- 100 failing downloads ----
  await gc(c);
  const m0 = await metrics(c);
  const fids = (await ipc(c, 'dl:addMany', Array.from({ length: 100 }, (_, i) => ({ url: `${base}/status/${[404, 403, 500][i % 3]}?n=${i}`, saveDir: out })), { start: true })).map(String);
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const f = (await items(c)).filter((x) => fids.includes(x.id));
    if (f.every((x) => x.status === 'error')) break;
  }
  const f = (await items(c)).filter((x) => fids.includes(x.id));
  log('failures_100', { failed: f.filter((x) => x.status === 'error').length, stuck: f.filter((x) => x.status !== 'error').map((x) => x.status), sampleErrors: [...new Set(f.map((x) => x.error))].slice(0, 4) });

  }
  // ---- 200 page navigations ----
  await gc(c);
  const n0 = await metrics(c);
  const nav = await c.evaluate(`(async () => {
    const links = [...document.querySelectorAll('nav button, nav a')].filter(b => b.offsetParent && /^(Downloads|Video|BitTorrent|History|LinkGrabber|Site Grabber|Queues|Settings)/.test(b.textContent.trim()));
    if (!links.length) return { error: 'no nav links', html: document.body.innerText.slice(0, 400), active: document.activeElement?.outerHTML.slice(0, 200), dialogs: document.querySelectorAll('[role=dialog]').length };
    const times = [];
    for (let i = 0; i < 200; i++) { const b = links[i % links.length]; const t0 = performance.now(); b.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); times.push(performance.now() - t0); }
    links[0].click();
    times.sort((a, b) => a - b);
    return { pages: links.length, p50: Math.round(times[100]), p95: Math.round(times[190]), max: Math.round(times[199]) };
  })()`);
  await sleep(500);
  await gc(c);
  log('navigation_200', { ...nav, before: n0, after: await metrics(c) });

  // ---- 100 dialog open/close (New download) ----
  await gc(c);
  const d0 = await metrics(c);
  const dlg = await c.evaluate(`(async () => {
    let opened = 0;
    for (let i = 0; i < 100; i++) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      if (document.querySelector('[role=dialog]')) opened++;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    }
    return { opened, leftOpen: document.querySelectorAll('[role=dialog]').length };
  })()`);
  await gc(c);
  log('dialogs_100', { ...dlg, before: d0, after: await metrics(c) });
  log('end_of_session', { memory: memoryMB(app.child.pid), dom: await metrics(c) });

  // ---- 10 start/quit cycles with the list intact ----
  const count0 = (await items(c)).length;
  ipc(c, 'app:quit').catch(() => {});
  await new Promise((r) => (app.child.exitCode !== null ? r() : app.child.once('exit', r)));
  live.delete(app.child.pid);
  const cycles = [];
  for (let i = 0; i < 10; i++) {
    const a = await launch(exe, data);
    live.add(a.child.pid);
    const n = (await items(a.c)).length;
    const q0 = performance.now();
    ipc(a.c, 'app:quit').catch(() => {});
    await new Promise((r) => (a.child.exitCode !== null ? r() : a.child.once('exit', r)));
    live.delete(a.child.pid);
    cycles.push({ rendered_ms: Math.round(a.tRender), items: n, quit_ms: Math.round(performance.now() - q0), exit: a.child.exitCode });
  }
  const leftovers = fs.readdirSync(data).filter((f) => f.endsWith('.tmp'));
  log('restart_cycles_10', { itemsBefore: count0, cycles, tmpFilesLeft: leftovers.length, zombies: execSync('tasklist').toString().split('\n').filter((l) => /^opendm\.exe/i.test(l)).length });
} catch (e) {
  log('fatal', String(e.stack || e));
} finally {
  srv.kill();
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
}

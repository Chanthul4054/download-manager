// End-to-end QA of the packaged OpenDM build against the local bench server.
// node qa.mjs <opendm.exe> <bench_server.exe> <workdir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { launch, ipc, sleep, memoryMB, cpuSec } from './cdp.mjs';

const [exe, benchExe, work] = process.argv.slice(2);
const results = {};
const live = new Set();
process.on('exit', () => { for (const p of live) try { execSync(`taskkill /F /T /PID ${p}`, { stdio: 'ignore' }); } catch {} });
const log = (k, v) => {
  results[k] = v;
  console.log(k, JSON.stringify(v));
};
const MB = 1024 * 1024;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const out = path.join(work, 'out');
fs.mkdirSync(out);

function seed(dir, downloads) {
  fs.mkdirSync(dir, { recursive: true });
  const settings = {
    general: { monitorClipboard: false, minimizeToTray: true },
    downloads: { showStartDialog: false, showCompleteDialog: false, progressDialog: 'none', duplicateAction: 'number' },
    proxy: { mode: 'none' },
    sounds: { complete: false, failed: false, queueDone: false },
    saveTo: { tempDir: path.join(dir, 'tmp') },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  if (downloads) fs.writeFileSync(path.join(dir, 'downloads.json'), JSON.stringify(downloads));
}

// ---- bench server ----
const srv = spawn(benchExe, [], { env: { ...process.env, BENCH_MAX_BYTES: String(260 * MB) }, stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));
const expectHash = async (n) => (await (await fetch(`${base}/hash/${n}`)).text()).trim();
const fileHash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function waitFor(c, fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}
const items = async (c) => (await ipc(c, 'state')).items;
const item = async (c, id) => (await items(c)).find((x) => x.id === id);

async function quit(app) {
  const t0 = performance.now();
  ipc(app.c, 'app:quit').catch(() => {});
  await new Promise((r) => (app.child.exitCode !== null ? r() : app.child.once('exit', r)));
  return Math.round(performance.now() - t0);
}

try {
  // ---- 1. startup: cold (empty data dir) then warm ----
  const d1 = path.join(work, 'data1');
  seed(d1);
  const starts = [];
  for (let i = 0; i < 4; i++) {
    const app = await launch(exe, d1);
    live.add(app.child.pid);
    starts.push({ run: i === 0 ? 'cold' : 'warm', target_ms: Math.round(app.tTarget), rendered_ms: Math.round(app.tRender) });
    if (i < 3) starts[i].quit_ms = await quit(app);
    else {
      // ---- 2. idle cost ----
      await sleep(3000);
      const c0 = cpuSec(app.child.pid);
      await sleep(10000);
      const c1 = cpuSec(app.child.pid);
      log('idle_cpu_pct_of_one_core_over_10s', { tree: +(((c1.tree - c0.tree) / 10) * 100).toFixed(2), app: +(((c1.app - c0.app) / 10) * 100).toFixed(2) });
      log('idle_memory_mb', memoryMB(app.child.pid));
      const { c } = app;
      const errors = [];
      app.c.onEvent((m) => {
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      });

      // ---- 3. ten concurrent downloads through the app's IPC, SHA-256 checked ----
      const sizes = [1, 3, 7, 16, 33, 64, 100, 5, 12, 200].map((m) => m * MB + 17);
      const t0 = performance.now();
      const ids = [];
      for (const s of sizes) ids.push((await ipc(c, 'dl:add', { url: `${base}/file/${s}`, saveDir: out, start: true, showProgress: false })).item.id);
      const done = await waitFor(c, async () => { const it = await items(c); const f = it.filter((x) => ids.includes(x.id)); return f.every((x) => ['complete', 'error'].includes(x.status)) && f; }, 180000, 'concurrent downloads');
      const secs = (performance.now() - t0) / 1000;
      let ok = 0;
      const bad = [];
      for (const [i, s] of sizes.entries()) {
        const it = done.find((x) => x.id === ids[i]);
        if (it.status === 'complete' && fileHash(it.savedPath) === (await expectHash(s)) && it.downloaded === s) ok++;
        else bad.push({ size: s, status: it.status, error: it.error, downloaded: it.downloaded });
      }
      log('concurrent_10', { ok, bad, totalMB: +(sizes.reduce((a, b) => a + b) / MB).toFixed(1), seconds: +secs.toFixed(2) });
      // The UI shows every row as complete (DOM, not just backend).
      const uiComplete = await c.evaluate(`[...document.querySelectorAll('[role=row]')].filter(r => /complete/i.test(r.textContent)).length`);
      log('ui_rows_showing_complete', uiComplete);

      // ---- 4. pause / resume, many times, on a capped download ----
      const big = 64 * MB + 3;
      const pid = (await ipc(c, 'dl:add', { url: `${base}/file/${big}?rate=${256 * 1024}`, saveDir: out, start: true, showProgress: false })).item.id;
      const heap0 = (await c.send('Runtime.getHeapUsage')).result.usedSize;
      let cycles = 0;
      let monotonic = true;
      let last = 0;
      const tp = performance.now();
      while (cycles < 25) {
        await sleep(250);
        await ipc(c, 'dl:stop', [pid]);
        const it = await waitFor(c, async () => { const x = await item(c, pid); return x && ['paused', 'complete'].includes(x.status) && x; }, 10000, 'pause');
        if (it.status === 'complete') break;
        if (it.downloaded < last) monotonic = false;
        last = it.downloaded;
        await ipc(c, 'dl:start', [pid], false);
        cycles++;
      }
      const fin = await waitFor(c, async () => { const x = await item(c, pid); return x && ['complete', 'error'].includes(x.status) && x; }, 120000, 'resume finish');
      log('pause_resume', { cycles, status: fin.status, monotonicProgress: monotonic, sha_ok: fin.status === 'complete' && fileHash(fin.savedPath) === (await expectHash(big)), seconds: +((performance.now() - tp) / 1000).toFixed(1) });
      await c.send('HeapProfiler.collectGarbage').catch(() => {});
      const heap1 = (await c.send('Runtime.getHeapUsage')).result.usedSize;
      log('js_heap_mb_before_after_pause_resume', [+(heap0 / MB).toFixed(1), +(heap1 / MB).toFixed(1)]);

      // ---- 5. error states reach the UI ----
      const e404 = (await ipc(c, 'dl:add', { url: `${base}/status/404`, saveDir: out, start: true, showProgress: false })).item.id;
      const failed = await waitFor(c, async () => { const x = await item(c, e404); return x && x.status === 'error' && x; }, 30000, '404');
      log('error_404', { status: failed.status, error: failed.error });

      // ---- 6. theme switch ----
      const themes = [];
      for (const t of ['dark', 'light']) {
        await ipc(c, 'settings:save', { appearance: { theme: t } });
        await sleep(300);
        themes.push(await c.evaluate(`[document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]`));
      }
      log('themes', themes);
      log('ui_errors_during_session', errors);
      log('memory_after_session_mb', memoryMB(app.child.pid));

      // ---- 7. crash mid-download, restart, resume ----
      const cid = (await ipc(c, 'dl:add', { url: `${base}/file/${big}?rate=${256 * 1024}`, saveDir: out, start: true, showProgress: false })).item.id;
      await sleep(7000);
      const before = await item(c, cid);
      execSync(`taskkill /F /T /PID ${app.child.pid}`);
      await sleep(1000);
      const app2 = await launch(exe, d1);
      live.add(app2.child.pid);
      const after = await waitFor(app2.c, () => item(app2.c, cid), 10000, 'restored item');
      await ipc(app2.c, 'dl:start', [cid], false);
      const fin2 = await waitFor(app2.c, async () => { const x = await item(app2.c, cid); return x && ['complete', 'error'].includes(x.status) && x; }, 120000, 'post-crash finish');
      log('crash_recovery', {
        downloadedBeforeKill: before.downloaded,
        restoredStatus: after.status,
        restoredDownloaded: after.downloaded,
        final: fin2.status,
        sha_ok: fin2.status === 'complete' && fileHash(fin2.savedPath) === (await expectHash(big)),
      });
      starts.push({ run: 'after-crash', rendered_ms: Math.round(app2.tRender) });
      starts[3].quit_ms = await quit(app2);
    }
  }
  log('startup', starts);

  // ---- 8. large history: 5000 finished items ----
  const d2 = path.join(work, 'data2');
  const hist = Array.from({ length: 5000 }, (_, i) => ({
    id: `h${i}`, url: `http://example.invalid/files/archive-${i}.zip`, fileName: `archive-${i}.zip`, status: 'complete',
    size: 1000 + i, downloaded: 1000 + i, added: 1.7e12 + i * 1000, completedAt: 1.7e12 + i * 1000, savedPath: `C:\\nowhere\\archive-${i}.zip`, category: 'compressed',
  }));
  seed(d2, hist);
  const big1 = await launch(exe, d2);
  live.add(big1.child.pid);
  const hc = big1.c;
  await waitFor(hc, () => hc.evaluate(`document.querySelectorAll('[role=row]').length > 5`), 20000, 'rows');
  const rows = await hc.evaluate(`document.querySelectorAll('[role=row]').length`);
  // Search: type into the field and time until the list shows the one match.
  const searchMs = await hc.evaluate(`(async () => {
    const input = document.querySelector('input[type=search], input[placeholder*=Search]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const t0 = performance.now();
    setter.call(input, 'archive-4321.zip'); input.dispatchEvent(new Event('input', { bubbles: true }));
    for (;;) { await new Promise(r => requestAnimationFrame(r)); const n = [...document.querySelectorAll('[role=row]')].filter(r => r.textContent.includes('archive-')).length; if (n === 1) break; if (performance.now() - t0 > 5000) return -1; }
    const t = performance.now() - t0;
    setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));
    return Math.round(t);
  })()`);
  // Scroll the virtual list to the bottom and count frames over 50 ms.
  const scroll = await hc.evaluate(`(async () => {
    const el = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 1000 && getComputedStyle(e).overflowY !== 'visible');
    if (!el) return null;
    let long = 0, frames = 0, prev = performance.now();
    for (let y = 0; y < el.scrollHeight; y += 2000) { el.scrollTop = y; await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); if (n - prev > 50) long++; frames++; prev = n; }
    return { frames, longFrames: long, domRows: document.querySelectorAll('[role=row]').length };
  })()`);
  // Navigation: every sidebar entry, time to next paint.
  const nav = await hc.evaluate(`(async () => {
    const links = [...document.querySelectorAll('nav button, nav a')].filter(b => b.offsetParent && b.textContent.trim());
    const out = [];
    for (const b of links) { const t0 = performance.now(); b.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); out.push([b.textContent.trim().slice(0, 18), Math.round(performance.now() - t0)]); }
    return out;
  })()`);
  // History page: open it, time to two frames, then scroll to the end so every row mounts.
  const hist5000 = await hc.evaluate(`(async () => {
    const b = [...document.querySelectorAll('nav button, nav a')].find(b => b.textContent.trim().startsWith('History'));
    const t0 = performance.now(); b.click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const open = Math.round(performance.now() - t0);
    const rows0 = document.querySelectorAll('[data-row]').length;
    const sc = [...document.querySelectorAll('.overflow-y-auto')].find(e => e.querySelector('[data-row]'));
    const t1 = performance.now(); let long = 0, prev = t1;
    for (let i = 0; i < 400 && document.querySelectorAll('[data-row]').length < 5000; i++) { sc.scrollTop = sc.scrollHeight; await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); if (n - prev > 50) long++; prev = n; }
    const header = document.querySelector('h2')?.textContent;
    return { openMs: open, rowsMountedOnOpen: rows0, scrollToEndMs: Math.round(performance.now() - t1), longFramesWhileScrolling: long, rowsMountedAtEnd: document.querySelectorAll('[data-row]').length, firstDayHeader: header };
  })()`);
  log('history_page_5000', { ...hist5000, memory: memoryMB(big1.child.pid) });
  log('large_history_5000', { rendered_ms: Math.round(big1.tRender), domRows: rows, searchMs, scroll, nav, memory: memoryMB(big1.child.pid) });
  await quit(big1);
} catch (e) {
  log('fatal', String(e.stack || e));
} finally {
  srv.kill();
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
}

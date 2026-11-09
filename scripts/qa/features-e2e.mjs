// End-to-end checks of the release build's everyday features against the local bench server:
// the Download File Info window, Batch download, export/import through the real Windows file
// dialogs, redownload, remove with and without files, and every page in light and dark.
//   node features-e2e.mjs <opendm.exe> <bench_server.exe> <workdir>
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect, ipc, launch, sleep, targets } from './cdp.mjs';

const [exe, benchExe, work] = process.argv.slice(2);
const here = (f) => path.resolve(new URL(`./${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const results = [];
let snapshot = null; // the download list at the last failure, for the log
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  if (!ok && snapshot) detail.items = snapshot;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
rmSync(work, { recursive: true, force: true });
const out = path.join(work, 'out');
const shots = path.join(work, 'screenshots');
for (const d of [out, shots]) mkdirSync(d, { recursive: true });

const srv = spawn(benchExe, [], { stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => /PORT (\d+)/.test(d) && res(`http://127.0.0.1:${/PORT (\d+)/.exec(d)[1]}`)));
const sha = async (n) => (await (await fetch(`${base}/hash/${n}`)).text()).trim();
const fileSha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const data = path.join(work, 'data');
mkdirSync(data, { recursive: true });
writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  firstRun: false,
  general: { monitorClipboard: false },
  downloads: { showStartDialog: true, showCompleteDialog: false, progressDialog: 'none', duplicateAction: 'number' },
  sounds: { complete: false, failed: false, queueDone: false },
  saveTo: { tempDir: path.join(work, 'tmp') },
}));
writeFileSync(path.join(data, 'categories.json'), JSON.stringify([{ id: 'general', name: 'General', folder: out, extensions: '' }]));
const app = await launch(exe, data);
const { c } = app;
const errors = [];
c.onEvent((m) => m.method === 'Runtime.exceptionThrown' && errors.push(m.params.exceptionDetails?.exception?.description));
const items = async () => (await ipc(c, 'state')).items;
async function until(f, ms = 30000) {
  const t = Date.now();
  for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await sleep(200); }
}
const ps = (script, ...args) => {
  try { return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', here(script), ...args]).toString().trim(); }
  catch (e) { return `${e.stdout}`.trim() || String(e.message); }
};
// A child window's page, by its view name.
async function view(name) {
  const t = await until(async () => (await targets(9333)).find((x) => x.type === 'page' && x.url.includes(`view=${name}`)), 20000);
  if (!t) throw new Error(`${name} window never opened`);
  const w = await connect(t.webSocketDebuggerUrl);
  await until(() => w.evaluate(`document.readyState === 'complete' && !!document.querySelector('button')`).catch(() => false));
  return w;
}
const clickText = (w, re) => w.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => ${re}.test(b.textContent.trim()) && !b.disabled); if (b) b.click(); return !!b; })()`);
const type = (w, sel, value) => w.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; e.focus(); set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const startNow = (w) => w.evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Start now'); if (l) l.click(); return !!l; })()`);
const fire = (channel, ...args) => c.evaluate(`(window.__TAURI_INTERNALS__.invoke('ipc', ${JSON.stringify({ channel, args })}).catch(() => {}), 1)`);
const diag = async () => { snapshot = (await items()).map((i) => [i.url.split('/').pop(), i.status, i.error, i.downloaded, i.queueId]); };
const complete = (re) => until(async () => (await items()).filter((i) => re.test(i.url) && i.status === 'complete'));

try {
  // ---- 1. Download File Info window (the add dialog) -------------------------------------------
  const N1 = 3 * 1048576 + 7;
  await fire('win:open', 'newdl', {}, { key: 'newdl:qa', payload: { url: `${base}/file/${N1}/added.bin` }, width: 640, height: 480, title: 'Download File Info', alwaysOnTop: true });
  const nd = await view('newdl');
  const ready = await until(() => nd.evaluate(`document.body.innerText.includes('added.bin') && [...document.querySelectorAll('button')].some((b) => /Start download/.test(b.textContent) && !b.disabled)`).catch(() => false));
  const shown = await nd.evaluate(`document.body.innerText`).catch(() => '');
  check('add window shows the file name and size', ready && /added\.bin/.test(shown) && /3(\.\d+)?\s*MB/.test(shown), { size: /[\d.]+\s*MB/.exec(shown)?.[0] });
  await clickText(nd, /Start download/);
  const tStart = Date.now();
  let [added] = (await complete(/added\.bin/)) || [];
  await diag();
  let stall = null;
  if (!added) {
    // Seen twice in early runs: the item sat at "downloading", 0 bytes. Record what it was doing and how long it lasts.
    const it = (await items()).find((i) => /added\.bin/.test(i.url));
    stall = { item: it && { status: it.status, statusText: it.statusText, downloaded: it.downloaded, size: it.size }, stats: it && (await ipc(c, 'dl:stats', it.id).catch((e) => String(e))) };
    [added] = (await until(async () => (await items()).filter((i) => /added\.bin/.test(i.url) && i.status === 'complete'), 120000)) || [];
    stall.recoveredAfterMs = added ? Date.now() - tStart : null;
  }
  check('Start download saves an intact file', added && !stall && fileSha(added.savedPath) === (await sha(N1)), { savedPath: added?.savedPath, stall });

  // ---- 2. Batch download dialog -> review window ----------------------------------------------
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
  const opened = await until(() => c.evaluate(`!!document.querySelector('[role=dialog] input')`));
  await type(c, '[role=dialog] input', `${base}/file/65536/part*.bin`);
  const review = await until(() => c.evaluate(`[...document.querySelectorAll('[role=dialog] button')].map((b) => b.textContent.trim()).find((t) => /Review \\d+ addresses/.test(t))`));
  check('Batch dialog expands the pattern (1..10)', opened && review === 'Review 10 addresses', { button: review });
  await clickText(c, /Review \d+ addresses/);
  const lw = await view('links');
  const addBtn = await until(() => lw.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => /^Add 10 downloads$/.test(t) )`));
  await startNow(lw);
  await clickText(lw, /^Add \d+ downloads?$/);
  const batch = await until(async () => { const b = (await items()).filter((i) => /part\d+\.bin/.test(i.url)); return b.length === 10 && b.every((i) => i.status === 'complete') && b; });
  check('review window adds all 10 and they finish', addBtn && batch, { button: addBtn, complete: batch?.length, statuses: batch ? undefined : (await items()).filter((i) => /part\d+\.bin/.test(i.url)).map((i) => [i.status, i.error, i.downloaded]) });

  // ---- 3. Export (OpenDM file and text) through the Save dialog --------------------------------
  const before = await items();
  const expJson = path.join(work, 'export.json');
  const expTxt = path.join(work, 'export.txt');
  await fire('app:menu', 'export:json');
  const s1 = ps('filedialog.ps1', '-Path', expJson, '-ProcessId', String(app.child.pid));
  await until(() => existsSync(expJson), 10000);
  const exported = existsSync(expJson) ? JSON.parse(readFileSync(expJson, 'utf8')) : {};
  check('export to an OpenDM file lists every download', s1 === 'done' && exported.app === 'OpenDM' && exported.downloads?.length === before.length, { dialog: s1, count: exported.downloads?.length, expected: before.length });
  await fire('app:menu', 'export:txt');
  const s2 = ps('filedialog.ps1', '-Path', expTxt, '-ProcessId', String(app.child.pid));
  await until(() => existsSync(expTxt), 10000);
  const lines = existsSync(expTxt) ? readFileSync(expTxt, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  check('export to a text file lists every address', s2 === 'done' && lines.length === before.length && lines.every((l) => l.startsWith(base)), { dialog: s2, lines: lines.length });

  // ---- 4. Remove without files, then import the OpenDM file back -------------------------------
  const keep = before.find((i) => /part1\.bin/.test(i.url));
  await ipc(c, 'dl:remove', [keep.id], false);
  check('remove (keep files) leaves the file on disk', !(await items()).some((i) => i.id === keep.id) && existsSync(keep.savedPath));
  await ipc(c, 'dl:remove', (await items()).map((i) => i.id), false);
  await fire('app:menu', 'import:json');
  const s3 = ps('filedialog.ps1', '-Path', expJson, '-ProcessId', String(app.child.pid));
  const msg = ps('dialog.ps1', '-Title', 'OpenDM', '-Button', 'OK', '-ProcessId', String(app.child.pid), '-TimeoutSec', '10');
  const back = await until(async () => { const l = await items(); return l.length === before.length && l; }, 10000);
  check('import of the OpenDM file restores every download', s3 === 'done' && back, { dialog: s3, message: msg, count: back?.length, expected: before.length });

  // ---- 5. Import a text file -> LinkGrabber (the default for address lists) --------------------
  const txt = path.join(work, 'links.txt');
  writeFileSync(txt, `see ${base}/file/1000/t1.bin and
${base}/file/2000/t2.bin
not a link
`);
  await fire('app:menu', 'import:txt');
  const s4 = ps('filedialog.ps1', '-Path', txt, '-ProcessId', String(app.child.pid));
  const lg = await until(async () => { const st = await ipc(c, 'lg:state'); const urls = st.packages.flatMap((p) => p.links.map((l) => l.url)); return !st.busy && urls.length && urls; }, 20000);
  const lgWin = await c.evaluate(`[...document.querySelectorAll('nav button, nav a')].some((b) => /LinkGrabber/i.test(b.textContent) && (b.getAttribute('aria-current') || b.dataset.active != null || /active|selected/.test(b.className)))`);
  const ids = await ipc(c, 'lg:confirm', [], {});
  for (const id of ids) await ipc(c, 'dl:start', [id]);
  const t12 = await until(async () => { const l = (await items()).filter((i) => /t[12]\.bin/.test(i.url) && i.status === 'complete'); return l.length === 2 && l; });
  await diag();
  check('import of a text file sends exactly its 2 addresses to LinkGrabber and they download', s4 === 'done' && lg?.length === 2 && t12, { dialog: s4, linkGrabber: lg, pageShown: lgWin, added: ids.length });

  // ---- 6. Redownload ---------------------------------------------------------------------------
  const r0 = (await items()).find((i) => /added\.bin/.test(i.url) && i.status === 'complete') || (await items()).find((i) => /added\.bin/.test(i.url));
  if (r0.status !== 'complete') { await ipc(c, 'dl:start', [r0.id]); await until(async () => (await items()).find((i) => i.id === r0.id && i.status === 'complete')); }
  const rPath = (await items()).find((i) => i.id === r0.id).savedPath;
  writeFileSync(rPath, 'damaged');
  await ipc(c, 'dl:redownload', r0.id);
  const r1 = await until(async () => { const x = (await items()).find((i) => i.id === r0.id); return x?.status === 'complete' && x.savedPath && x; });
  check('redownload fetches the file again intact', r1 && fileSha(r1.savedPath) === (await sha(N1)), { savedPath: r1?.savedPath });

  // ---- 7. Remove with files --------------------------------------------------------------------
  const del = (await items()).find((i) => /t2\.bin/.test(i.url) && i.status === 'complete');
  await ipc(c, 'dl:remove', [del.id], true);
  check('remove with files deletes the file and the entry', !existsSync(del.savedPath) && !(await items()).some((i) => i.id === del.id), { savedPath: del.savedPath });
  // A paused, partial download: removing it with files leaves no temp file behind.
  await ipc(c, 'settings:save', { speedLimiter: { enabled: true, kbps: 256 } });
  const part = (await ipc(c, 'dl:add', { url: `${base}/file/20971520/partial.bin`, saveDir: out, start: true, showProgress: false })).item;
  await until(async () => (await items()).find((i) => i.id === part.id && i.downloaded > 0));
  await ipc(c, 'dl:stop', [part.id]);
  await until(async () => (await items()).find((i) => i.id === part.id && i.status === 'paused'));
  const tmpDir = path.join(work, 'tmp');
  const tmpBefore = existsSync(tmpDir) ? execFileSync('cmd', ['/c', 'dir', '/b', '/s', tmpDir]).toString().trim().split(/\r?\n/).filter(Boolean) : [];
  await ipc(c, 'dl:remove', [part.id], true);
  await sleep(500);
  const tmpAfter = existsSync(tmpDir) ? (() => { try { return execFileSync('cmd', ['/c', 'dir', '/a-d', '/b', '/s', tmpDir], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/).filter(Boolean); } catch { return []; } })() : [];
  check('removing a partial download deletes its temp data', tmpBefore.length > 0 && tmpAfter.length === 0, { before: tmpBefore.length, after: tmpAfter });
  await ipc(c, 'settings:save', { speedLimiter: { enabled: false } });

  // ---- 8. Every page in light and dark ---------------------------------------------------------
  const pages = await c.evaluate(`[...document.querySelectorAll('nav button, nav a')].filter((b) => b.offsetParent && b.textContent.trim()).map((b) => b.textContent.trim())`);
  const taken = [];
  for (const theme of ['light', 'dark']) {
    await ipc(c, 'settings:save', { appearance: { theme } });
    await sleep(300);
    for (const [i, label] of pages.entries()) {
      // By label without its count badge ("Downloads13"): the sidebar's entries and counts change as pages open.
      const key = label.replace(/\d+$/, '');
      const hit = await c.evaluate(`(() => { const b = [...document.querySelectorAll('nav button, nav a')].find((b) => b.offsetParent && b.textContent.trim().replace(/\\d+$/, '') === ${JSON.stringify(key)}); if (b) b.click(); return !!b; })()`);
      if (!hit) continue;
      await sleep(300);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(shots, `${theme}-${String(i).padStart(2, '0')}-${label.replace(/[^\w]+/g, '_').slice(0, 24)}.png`);
      writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
      taken.push(f);
    }
  }
  const themeNow = await c.evaluate(`document.documentElement.dataset.theme`);
  check('every page captured in light and dark', taken.length === pages.length * 2 && themeNow === 'dark', { pages: pages.length, screenshots: taken.length });
  check('no uncaught errors in the main window', errors.length === 0, { errors });
} catch (e) {
  check('run', false, { error: String(e?.stack || e) });
} finally {
  await ipc(c, 'app:quit').catch(() => {});
  for (let i = 0; i < 100 && app.child.exitCode === null; i++) await sleep(100);
  if (app.child.exitCode === null) app.child.kill();
  srv.kill();
  writeFileSync(path.join(work, 'features-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

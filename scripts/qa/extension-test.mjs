// Browser extension end-to-end test with a real Chrome (throwaway profiles) and the release app:
// pairing Deny and Allow (the app's native prompt is pressed through UI Automation, as a user
// would), download capture, the context-menu handler, an ordinary web page being refused by the
// app, and the browser keeping its own download when OpenDM is not running.
//   node extension-test.mjs <opendm.exe> <bench_server.exe> <workdir> [chrome.exe]
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ipc, launch, sleep } from './cdp.mjs';

const [exe, benchExe, work, chromeExe = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
const EXT = path.resolve(new URL('../../extension', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIALOG = path.resolve(new URL('./dialog.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROMPT = 'Connect a browser to OpenDM?';
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ---- local file server -------------------------------------------------------------------------
const srv = spawn(benchExe, [], { stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => /PORT (\d+)/.test(d) && res(`http://127.0.0.1:${/PORT (\d+)/.exec(d)[1]}`)));
const sha = async (n) => (await (await fetch(`${base}/hash/${n}`)).text()).trim();

// ---- the app -----------------------------------------------------------------------------------
const data = path.join(work, 'data');
mkdirSync(data, { recursive: true });
writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  general: { monitorClipboard: false },
  downloads: { showStartDialog: false, showCompleteDialog: false, progressDialog: 'none' },
  saveTo: { tempDir: path.join(work, 'tmp') },
}));
writeFileSync(path.join(data, 'categories.json'), JSON.stringify([{ id: 'general', name: 'General', folder: path.join(work, 'out'), extensions: '' }]));
let app = await launch(exe, data);
const items = async () => (await ipc(app.c, 'state')).items;

// ---- Chrome over a debugging pipe (branded Chrome no longer takes --load-extension) -----------
async function chrome(name) {
  const prof = path.join(work, `chrome-${name}`);
  const dl = path.join(work, `browser-downloads-${name}`);
  mkdirSync(path.join(prof, 'Default'), { recursive: true });
  mkdirSync(dl, { recursive: true });
  writeFileSync(path.join(prof, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dl, prompt_for_download: false, directory_upgrade: true } }));
  const p = spawn(chromeExe, [`--user-data-dir=${prof}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let n = 0, buf = '';
  const pending = new Map(), events = [];
  p.stdio[4].on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const id = ++n;
    pending.set(id, res);
    p.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const r = await send('Extensions.loadUnpacked', { path: EXT });
  if (!r.result?.id) throw new Error('extension did not load: ' + JSON.stringify(r.error));
  const extId = r.result.id;
  // The extension's service worker, for reading its storage and calling its handlers.
  let sw;
  for (let i = 0; i < 100 && !sw; i++) {
    sw = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!sw) await sleep(100);
  }
  const swSession = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).result.sessionId;
  const evalSW = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSession)).result?.result?.value;
  const page = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'page');
  const pageSession = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result.sessionId;
  const evalPage = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, pageSession)).result?.result?.value;
  const go = (url) => send('Page.navigate', { url }, pageSession);
  const storage = () => evalSW(`chrome.storage.local.get(null)`);
  const close = async () => { await send('Browser.close').catch(() => {}); for (let i = 0; i < 50 && p.exitCode === null; i++) await sleep(100); if (p.exitCode === null) p.kill(); };
  return { extId, evalSW, evalPage, go, storage, close, dl, events };
}
const browserFiles = (dir) => readdirSync(dir).filter((f) => !/\.(crdownload|tmp)$/.test(f));
const pressPrompt = (button) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DIALOG, '-Title', PROMPT, '-Button', button, '-ProcessId', String(app.child.pid), '-TimeoutSec', '20']).toString().trim();
  } catch (e) {
    return `${e.stdout}`.trim() || String(e.message);
  }
};
async function until(f, ms = 20000) {
  const t = Date.now();
  for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await sleep(250); }
}

try {
  const version = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${chromeExe}').VersionInfo.ProductVersion`]).toString().trim();
  check('environment', true, { chrome: version, extension: JSON.parse(readFileSync(path.join(EXT, 'manifest.json'))).version });

  // ---- 1. Deny ---------------------------------------------------------------------------------
  const a = await chrome('deny');
  check('extension loads in Chrome', !!a.extId, { id: a.extId });
  check('pairing prompt shown and Deny pressed', pressPrompt('Deny') === 'clicked');
  const sa = await until(async () => { const s = await a.storage(); return s.refused ? s : null; });
  check('denied browser gets no token', sa?.refused === true && !sa?.token, { refused: sa?.refused, hasToken: !!sa?.token });
  await a.go(`${base}/file/1048576/denied.zip`);
  const keptA = await until(() => browserFiles(a.dl).includes('denied.zip') && 'yes');
  check('denied browser keeps its own download', keptA === 'yes' && (await items()).length === 0, { browserFiles: browserFiles(a.dl), appItems: (await items()).length });
  await a.close();

  // ---- 2. Allow, capture, context menu, web-page origin ----------------------------------------
  // The deny cooldown (60 s) must pass before another browser may ask.
  await sleep(61000);
  const b = await chrome('allow');
  await sleep(5000);
  const early = await b.storage();
  check('no token before the user answers', !early.token, { hasToken: !!early.token });
  check('pairing prompt shown and Allow pressed', pressPrompt('Allow') === 'clicked');
  const sb = await until(async () => { const s = await b.storage(); return s.token ? s : null; });
  check('allowed browser receives a token', !!sb?.token, { tokenLength: sb?.token?.length });
  await until(() => b.evalSW(`(async () => { await refreshConfig(true); return active(); })()`));
  const N = 2097152;
  await b.go(`${base}/file/${N}/captured.zip`);
  const cap = await until(async () => (await items()).find((i) => i.url.includes('/captured.zip') && i.status === 'complete'), 30000);
  const capSha = cap && createHash('sha256').update(readFileSync(cap.savedPath)).digest('hex');
  check('download is captured by OpenDM and intact', cap && capSha === (await sha(N)), { status: cap?.status, browserFiles: browserFiles(b.dl) });
  check('captured download is not also saved by the browser', !browserFiles(b.dl).includes('captured.zip'));

  // Context menus: Chrome's native menu cannot be opened or clicked over CDP and onClicked cannot
  // be fired from script, so "Download with OpenDM" stays a manual check (not reported as a pass).

  // An ordinary web page cannot use the app's API, even with the browser paired.
  const fromPage = await b.evalPage(`fetch('http://127.0.0.1:52790/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDM': '1' }, body: JSON.stringify({ url: '${base}/file/1048576/page.zip' }) }).then((r) => 'status ' + r.status, (e) => 'blocked: ' + e.message)`);
  const noToken = await fetch('http://127.0.0.1:52790/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDM': '1', Origin: `chrome-extension://${b.extId}` }, body: JSON.stringify({ url: `${base}/file/1048576/notoken.zip` }) }).then((r) => r.status, (e) => String(e));
  await sleep(1000);
  const leaked = (await items()).filter((i) => /page\.zip|notoken\.zip/.test(i.url));
  check('a web page and a token-less request are refused', leaked.length === 0 && noToken === 401, { fromPage, noToken, added: leaked.length });

  // ---- 3. App not running: the browser keeps the download --------------------------------------
  await ipc(app.c, 'app:quit').catch(() => {});
  for (let i = 0; i < 100 && app.child.exitCode === null; i++) await sleep(100);
  await b.evalSW(`(async () => { state.checkedAt = 0; await refreshConfig(true); return state.alive; })()`);
  await b.go(`${base}/file/1048576/fallback.zip`);
  const keptB = await until(() => browserFiles(b.dl).includes('fallback.zip') && 'yes');
  check('with OpenDM closed the browser downloads normally', keptB === 'yes', { browserFiles: browserFiles(b.dl) });
  const errors = b.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description);
  check('no uncaught errors in the extension', errors.length === 0, { errors });
  await b.close();
} catch (e) {
  check('run', false, { error: String(e?.stack || e) });
} finally {
  if (app.child.exitCode === null) app.child.kill();
  srv.kill();
  writeFileSync(path.join(work, 'extension-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

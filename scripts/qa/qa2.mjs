// Live checks of clipboard monitoring, the browser-integration server and close-to-tray.
// node qa2.mjs <opendm.exe> <bench_server.exe> <workdir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { launch, ipc, sleep, targets } from './cdp.mjs';

const [exe, benchExe, work] = process.argv.slice(2);
const results = {};
const log = (k, v) => { results[k] = v; console.log(k, JSON.stringify(v)); };
const PORT = 52791;

fs.rmSync(work, { recursive: true, force: true });
const data = path.join(work, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  general: { monitorClipboard: true, minimizeToTray: true, integrationPort: PORT, browserIntegration: true },
  downloads: { showCompleteDialog: false }, proxy: { mode: 'none' }, sounds: { complete: false, failed: false, queueDone: false },
}));

const srv = spawn(benchExe, [], { env: { ...process.env, BENCH_MAX_BYTES: String(4 << 20) }, stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));
const ps = (cmd) => execSync(`powershell -NoProfile -Command "${cmd}"`).toString();
let savedClip = '';
try { savedClip = ps('Get-Clipboard -Raw'); } catch {}

let app;
try {
  app = await launch(exe, data);
  const { c } = app;
  await sleep(2500); // first clipboard poll records the current text without acting on it

  // ---- clipboard: a file URL opens "Download File Info"; plain text does not ----
  const windowsNow = async () => (await targets(9333)).filter((t) => t.type === 'page').map((t) => new URL(t.url).searchParams.get('view'));
  const before = await windowsNow();
  ps(`Set-Clipboard -Value 'just some words'`);
  await sleep(2500);
  const afterText = await windowsNow();
  ps(`Set-Clipboard -Value '${base}/file/12345/report.zip'`);
  let afterUrl = [];
  for (let i = 0; i < 20 && afterUrl.length <= before.length; i++) { await sleep(250); afterUrl = await windowsNow(); }
  log('clipboard', { before, afterText, afterUrl });

  // ---- integration server: only paired extensions with the header get in ----
  const call = async (p, headers = {}, method = 'GET', body) => {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body }); return r.status; } catch (e) { return String(e.cause?.code || e); }
  };
  log('integration', {
    ping_no_header: await call('/api/ping'),
    ping_web_origin: await call('/api/ping', { 'X-OpenDM': '1', Origin: 'https://evil.example' }),
    ping_extension: await call('/api/ping', { 'X-OpenDM': '1', Origin: 'chrome-extension://abcdefghijklmnop' }),
    config_unpaired: await call('/api/config', { 'X-OpenDM': '1', Origin: 'chrome-extension://abcdefghijklmnop' }),
    download_unpaired: await call('/api/download', { 'X-OpenDM': '1', Origin: 'chrome-extension://abcdefghijklmnop', 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ url: `${base}/file/100` })),
  });

  // ---- close to tray: closing the main window keeps the app running; a second launch shows it ----
  await ipc(c, 'win:close').catch(() => {});
  await sleep(1500);
  const alive = app.child.exitCode === null;
  const visibleAfterClose = await c.evaluate('document.visibilityState').catch((e) => 'n/a: ' + e.message);
  const second = spawn(exe, [], { env: { ...process.env, OPENDM_DATA_DIR: data } });
  const secondExit = await new Promise((r) => { second.once('exit', (code) => r(code)); setTimeout(() => r('still running'), 8000); });
  await sleep(800);
  const visibleAfterRelaunch = await c.evaluate('document.visibilityState').catch((e) => 'n/a: ' + e.message);
  log('tray', { aliveAfterClose: alive, visibleAfterClose, secondInstanceExit: secondExit, visibleAfterRelaunch });
} catch (e) {
  log('fatal', String(e.stack || e));
} finally {
  try { if (app) execSync(`taskkill /F /T /PID ${app.child.pid}`, { stdio: 'ignore' }); } catch {}
  srv.kill();
  try { fs.writeFileSync(path.join(work, 'clip.txt'), savedClip); ps(`Set-Clipboard -Value (Get-Content -Raw '${path.join(work, 'clip.txt')}')`); } catch {}
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
}

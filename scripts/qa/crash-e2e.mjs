// Hard-kill the release build mid-download (taskkill /F) several times and check what it left on
// disk: every saved segment offset is inside the temp file and the bytes before it are the server's
// bytes. Then resume to the end and compare the whole file.
//   node crash-e2e.mjs <opendm.exe> <bench_server.exe> <workdir>
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ipc, launch, sleep } from './cdp.mjs';

const [exe, benchExe, work] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
rmSync(work, { recursive: true, force: true });
const data = path.join(work, 'data');
const out = path.join(work, 'out');
for (const d of [data, out]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  firstRun: false,
  general: { monitorClipboard: false },
  connection: { maxConnections: 4 },
  downloads: { showStartDialog: false, showCompleteDialog: false, progressDialog: 'none' },
  saveTo: { tempDir: path.join(work, 'tmp') },
}));

const srv = spawn(benchExe, [], { env: { ...process.env, BENCH_MAX_BYTES: String(300 * 1048576) }, stdio: ['ignore', 'pipe', 'ignore'] });
const base = await new Promise((res) => srv.stdout.on('data', (d) => /PORT (\d+)/.test(d) && res(`http://127.0.0.1:${/PORT (\d+)/.exec(d)[1]}`)));
const N = 128 * 1048576;
const url = `${base}/file/${N}/crash.bin?rate=${1048576}`;
const serverBytes = async (a, b) => Buffer.from(await (await fetch(`${base}/file/${N}/crash.bin`, { headers: { Range: `bytes=${a}-${b - 1}` } })).arrayBuffer());
const readAt = (file, a, n) => { const fd = openSync(file, 'r'); const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, a); closeSync(fd); return b.subarray(0, got); };

let app;
try {
  app = await launch(exe, data);
  const id = (await ipc(app.c, 'dl:add', { url, saveDir: out, start: true, showProgress: false })).item.id;
  for (let round = 1; round <= 3; round++) {
    // Somewhere between two and three checkpoints (2 s apart) into this run.
    await sleep(4000 + Math.floor(Math.random() * 2500));
    const live = (await ipc(app.c, 'state')).items.find((i) => i.id === id);
    execSync(`taskkill /F /T /PID ${app.child.pid}`, { stdio: 'ignore' });
    for (let i = 0; i < 50 && app.child.exitCode === null; i++) await sleep(100);
    const saved = JSON.parse(readFileSync(path.join(data, 'downloads.json'), 'utf8')).find((d) => d.id === id);
    const temp = saved.tempPath;
    const len = existsSync(temp) ? statSync(temp).size : 0;
    let bad = [];
    let durable = 0;
    for (const s of saved.segments || []) {
      if (s.pos > len) bad.push({ seg: s, len, why: 'offset past end of temp file' });
      const n = s.pos - s.start;
      durable += n;
      if (n > 0 && s.pos <= len && !readAt(temp, s.start, n).equals(await serverBytes(s.start, s.pos))) bad.push({ seg: s, why: 'bytes differ from the server' });
    }
    check(`kill ${round}: saved offsets are inside the temp file and match the server`, (saved.segments || []).length > 0 && bad.length === 0, { segments: saved.segments?.length, tempLen: len, durableMB: +(durable / 1048576).toFixed(2), liveMB: +((live?.downloaded || 0) / 1048576).toFixed(2), bad });
    app = await launch(exe, data);
    const back = (await ipc(app.c, 'state')).items.find((i) => i.id === id);
    check(`kill ${round}: restart shows the saved progress, paused`, back && back.status === 'paused' && back.downloaded === durable, { status: back?.status, downloaded: back?.downloaded, durable });
    await ipc(app.c, 'dl:start', [id], false);
  }
  await ipc(app.c, 'settings:save', { speedLimiter: { enabled: false } });
  const t0 = Date.now();
  let fin;
  while (Date.now() - t0 < 180000) { fin = (await ipc(app.c, 'state')).items.find((i) => i.id === id); if (/complete|error/.test(fin.status)) break; await sleep(500); }
  const want = (await (await fetch(`${base}/hash/${N}`)).text()).trim();
  const got = fin.status === 'complete' ? createHash('sha256').update(readFileSync(fin.savedPath)).digest('hex') : null;
  check('after three hard kills the finished file is byte-identical', got === want, { status: fin.status, error: fin.error });
} catch (e) {
  check('run', false, { error: String(e?.stack || e) });
} finally {
  if (app) { await ipc(app.c, 'app:quit').catch(() => {}); for (let i = 0; i < 50 && app.child.exitCode === null; i++) await sleep(100); if (app.child.exitCode === null) app.child.kill(); }
  srv.kill();
  writeFileSync(path.join(work, 'crash-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// yt-dlp end to end with the release build: install yt-dlp through the app (into a throwaway data
// folder), read a local page with an HTML5 <video>, download it through yt-dlp, compare bytes.
//   node ytdlp-e2e.mjs <opendm.exe> <workdir>
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ipc, launch, sleep } from './cdp.mjs';

const [exe, work] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
rmSync(work, { recursive: true, force: true });
const out = path.join(work, 'out');
const data = path.join(work, 'data');
for (const d of [out, data]) mkdirSync(d, { recursive: true });

const clip = randomBytes(2 * 1024 * 1024 + 333);
const srv = createServer((req, res) => {
  if (req.url === '/watch') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><html><head><title>QA local clip</title></head><body><video controls src="/media/clip.mp4"></video></body></html>');
  }
  if (req.url.startsWith('/media/clip.mp4')) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const a = m ? +m[1] : 0, b = m && m[2] ? +m[2] : clip.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${clip.length}` } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : clip.subarray(a, b + 1));
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const page = `http://127.0.0.1:${srv.address().port}/watch`;

writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  firstRun: false,
  general: { monitorClipboard: false },
  downloads: { showStartDialog: false, showCompleteDialog: false, progressDialog: 'none' },
  saveTo: { tempDir: path.join(work, 'tmp') },
}));
writeFileSync(path.join(data, 'categories.json'), JSON.stringify([{ id: 'general', name: 'General', folder: out, extensions: '' }]));
const app = await launch(exe, data);
const { c } = app;
const items = async () => (await ipc(c, 'state')).items;
async function until(f, ms) {
  const t = Date.now();
  for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await sleep(500); }
}

try {
  const missing = await ipc(c, 'util:ytdlp');
  check('a fresh data folder has no yt-dlp', !missing, { found: missing });
  const t0 = Date.now();
  const installed = await ipc(c, 'util:ytdlpInstall').catch((e) => ({ error: String(e) }));
  const bin = await ipc(c, 'util:ytdlp');
  check('yt-dlp installs from the app into its own bin folder', bin && bin.startsWith(data) && existsSync(bin), { bin, result: installed, seconds: Math.round((Date.now() - t0) / 1000) });

  const info = await ipc(c, 'util:ytdlpInfo', page).catch((e) => ({ error: String(e) }));
  check('yt-dlp reads the local video page', !info.error && !info.missing && /QA local clip/.test(info.title || ''), { title: info.title, error: info.error, heights: info.heights });

  const r = await ipc(c, 'dl:add', { url: page, fileName: 'QA local clip.mp4', saveDir: out, kind: 'ytdlp', ytdlp: { quality: 'best' }, start: true, showProgress: false });
  const id = r.item.id;
  const fin = await until(async () => { const x = (await items()).find((i) => i.id === id); return x && /complete|error/.test(x.status) && x; }, 120000);
  const got = fin?.savedPath && existsSync(fin.savedPath) ? readFileSync(fin.savedPath) : null;
  check('the video downloads through yt-dlp and is byte-identical', fin?.status === 'complete' && got && createHash('sha256').update(got).digest('hex') === createHash('sha256').update(clip).digest('hex'), { status: fin?.status, error: fin?.error, kind: fin?.kind, savedPath: fin?.savedPath, bytes: got?.length });
} catch (e) {
  check('run', false, { error: String(e?.stack || e) });
} finally {
  await ipc(c, 'app:quit').catch(() => {});
  for (let i = 0; i < 100 && app.child.exitCode === null; i++) await sleep(100);
  if (app.child.exitCode === null) app.child.kill();
  srv.close();
  writeFileSync(path.join(work, 'ytdlp-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

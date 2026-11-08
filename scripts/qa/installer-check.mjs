// Checks an installed OpenDM over CDP, using its default data folder (no OPENDM_DATA_DIR): what
// it loaded, and optionally that a paused download resumes to the server's bytes. Run by
// installer-test.ps1 inside a dedicated Windows test account, never on a real profile.
//   node installer-check.mjs <opendm.exe> <out.json> [--resume <id> --sha <hex>]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, ipc, sleep, targets } from './cdp.mjs';

const [exe, out, ...rest] = process.argv.slice(2);
const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
const PORT = 9334;
const result = { exe, ok: false, steps: [] };
const step = (name, ok, detail = {}) => {
  result.steps.push({ name, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};

const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
delete env.OPENDM_DATA_DIR;
const t0 = performance.now();
const child = spawn(exe, [], { env, stdio: 'ignore' });
let exited = null;
child.on('exit', (code) => (exited = code));

try {
  let page;
  while (!page) {
    if (exited !== null) throw new Error(`app exited at start (code ${exited}); is another OpenDM running?`);
    if (performance.now() - t0 > 60000) throw new Error('main window never appeared');
    page = (await targets(PORT)).find((t) => t.type === 'page' && !/view=(?!main)/.test(t.url));
    if (!page) await sleep(100);
  }
  const c = await connect(page.webSocketDebuggerUrl);
  for (;;) {
    if (await c.evaluate(`!!document.querySelector('nav, [role=navigation]') && document.readyState === 'complete'`).catch(() => false)) break;
    if (performance.now() - t0 > 60000) throw new Error('UI never rendered');
    await sleep(100);
  }
  step('launch and render', true, { ms: Math.round(performance.now() - t0) });

  const st = await ipc(c, 'state');
  result.state = {
    version: st.version,
    items: st.items.map((i) => ({ id: i.id, status: i.status, fileName: i.fileName, size: i.size, downloaded: i.downloaded })),
    categories: st.categories.map((x) => x.name),
    queues: st.queues.map((q) => q.name),
    connection: st.settings.connection,
    dataDir: st.settings.dataDir ?? null,
  };
  step('state loaded', true, { version: st.version, items: st.items.length });

  const id = opt('--resume');
  if (id) {
    const before = st.items.find((i) => i.id === id);
    step('paused download present', !!before && before.status === 'paused', { status: before?.status, downloaded: before?.downloaded });
    await ipc(c, 'dl:start', id, false);
    let it;
    const t1 = performance.now();
    for (;;) {
      it = (await ipc(c, 'state')).items.find((i) => i.id === id);
      if (['complete', 'error'].includes(it?.status) || performance.now() - t1 > 120000) break;
      await sleep(500);
    }
    const ok = it?.status === 'complete';
    let sha = null;
    if (ok) sha = createHash('sha256').update(readFileSync(it.savedPath)).digest('hex');
    step('resumed download completes intact', ok && sha === opt('--sha'), { status: it?.status, error: it?.error, sha, want: opt('--sha') });
  }

  await ipc(c, 'app:quit').catch(() => {});
  for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
  step('quits cleanly', exited !== null, { code: exited });
  result.ok = result.steps.every((s) => s.ok);
} catch (e) {
  step('run', false, { error: String(e?.message || e) });
  if (exited === null) child.kill();
}
writeFileSync(out, JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

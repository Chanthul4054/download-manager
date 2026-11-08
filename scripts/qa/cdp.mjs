// Minimal raw-CDP helpers for driving the OpenDM webview (Playwright's connectOverCDP crashes on
// the webview's SharedWorker target).
import { spawn, execSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function targets(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`);
    return await r.json();
  } catch {
    return [];
  }
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let n = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, onEvent: (f) => listeners.push(f), close: () => ws.close() };
}

/** Starts the app and resolves once the main window has rendered its UI. */
export async function launch(exe, dataDir, port = 9333) {
  const t0 = performance.now();
  const child = spawn(exe, [], {
    env: { ...process.env, OPENDM_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: 'ignore',
  });
  let page;
  while (!page) {
    if (performance.now() - t0 > 60000) throw new Error('main window never appeared');
    page = (await targets(port)).find((t) => t.type === 'page' && /index\.html|tauri\.localhost|localhost:1420/.test(t.url) && !/view=(?!main)/.test(t.url));
    if (!page) await sleep(25);
  }
  const tTarget = performance.now() - t0;
  const c = await connect(page.webSocketDebuggerUrl);
  // "Rendered" = the app shell is in the DOM (sidebar navigation present).
  for (;;) {
    const ok = await c.evaluate(`!!document.querySelector('nav, [role=navigation]') && document.readyState === 'complete'`).catch(() => false);
    if (ok) break;
    if (performance.now() - t0 > 60000) throw new Error('UI never rendered');
    await sleep(25);
  }
  const tRender = performance.now() - t0;
  await c.send('Runtime.enable');
  return { child, c, tTarget, tRender, t0 };
}

export const ipc = (c, channel, ...args) => c.evaluate(`window.__TAURI_INTERNALS__.invoke('ipc', ${JSON.stringify({ channel, args })})`);

const TREE = new URL('./tree.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function tree(pid) {
  const [app, ws, priv, procs, cpu, appCpu] = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${TREE}" -Root ${pid}`).toString().trim().split(' ').map(Number);
  return { app, ws, priv, procs, cpu, appCpu };
}
/** Working set / private MB of the app and its WebView2 processes. */
export function memoryMB(pid) {
  const t = tree(pid);
  return { appWorkingSet: t.app, treeWorkingSet: t.ws, treePrivate: t.priv, processes: t.procs };
}
/** CPU seconds used so far by the app process tree, and by the app process alone. */
export function cpuSec(pid) {
  const t = tree(pid);
  return { tree: t.cpu, app: t.appCpu };
}

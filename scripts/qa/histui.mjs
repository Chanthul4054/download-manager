import { launch, sleep } from './cdp.mjs';
import { execSync } from 'node:child_process';
const [exe, data] = process.argv.slice(2);
const app = await launch(exe, data);
const { c } = app;
const ev = (e) => c.evaluate(e);
await ev(`(async () => { [...document.querySelectorAll('nav button, nav a')].find(b => b.textContent.trim().startsWith('History')).click(); await new Promise(r => setTimeout(r, 600)); })()`);
const out = {};
out.tooltipRootsIdle = await ev(`document.querySelectorAll('[data-row] [data-action] svg').length`);
// Real mouse hover over the 3rd row.
const box = await ev(`(() => { const r = document.querySelectorAll('[data-row]')[2].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] });
await sleep(300);
out.hoverRowButtons = await ev(`[...document.querySelectorAll('[data-row]')[2].querySelectorAll('[data-action] button')].map(b => b.getAttribute('aria-label') + ':' + !!b.querySelector('svg') + ':' + getComputedStyle(b.parentElement).opacity)`);
// Open the More menu with a real click, move away, menu must stay open.
const more = await ev(`(() => { const r = document.querySelectorAll('[data-row]')[2].querySelector('[aria-label=More]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: more[0], y: more[1], button: 'left', clickCount: 1 });
await sleep(400);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
await sleep(400);
out.menuOpenAfterLeaving = await ev(`!!document.querySelector('[role=menu]')`);
out.menuItems = await ev(`[...document.querySelectorAll('[role=menuitem]')].map(e => e.textContent.trim()).slice(0, 4)`);
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);
out.menuClosed = await ev(`!document.querySelector('[role=menu]')`);
// Keyboard: focus the 6th row's first stand-in as Tab would; focus must land on the real button.
await ev(`document.querySelectorAll('[data-row]')[5].querySelector('[data-action] button').focus()`);
await sleep(300);
out.focusAfterTab = await ev(`(() => { const a = document.activeElement; return [a.getAttribute('aria-label'), !!a.querySelector('svg'), !!a.closest('[data-row]') && [...document.querySelectorAll('[data-row]')].indexOf(a.closest('[data-row]'))]; })()`);
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await sleep(300);
out.focusAfterRealTab = await ev(`(() => { const a = document.activeElement; return [a.getAttribute('aria-label'), !!a.querySelector('svg')]; })()`);
out.dayHeader = await ev(`document.querySelector('h2')?.textContent`);
console.log(JSON.stringify(out, null, 1));
execSync(`taskkill /F /T /PID ${app.child.pid}`);

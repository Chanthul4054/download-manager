'use strict';
// OpenDM browser integration: hands downloads, links and detected media to the desktop app
// listening on 127.0.0.1. If the app is unreachable, the browser keeps its own download.

const DEFAULT_PORT = 52790;
const state = { enabled: true, port: DEFAULT_PORT, cfg: null, alive: false, checkedAt: 0, lastClick: null };
const tabMedia = new Map(); // tabId -> [{url, type, size, ext, kind}]
const passThrough = new Set(); // urls we re-issued to the browser after a failed hand-off

async function loadLocal() {
  const s = await chrome.storage.local.get({ enabled: true, port: DEFAULT_PORT });
  state.enabled = s.enabled;
  state.port = Number(s.port) || DEFAULT_PORT;
}

async function call(path, body) {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'X-OpenDM': '1', 'Content-Type': 'application/json' } : { 'X-OpenDM': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('OpenDM replied ' + res.status);
  return res.json();
}

async function refreshConfig(force = false) {
  if (!force && Date.now() - state.checkedAt < 10000) return state.cfg;
  state.checkedAt = Date.now();
  try {
    state.cfg = await call('/api/config');
    state.alive = true;
  } catch {
    state.alive = false;
  }
  updateBadge();
  buildMenus();
  return state.cfg;
}

function active() {
  return state.enabled && state.alive && state.cfg?.enabled;
}

function updateBadge() {
  const on = active();
  chrome.action.setIcon({ path: on ? { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } : { 16: 'icons/icon16-off.png', 32: 'icons/icon32-off.png' } });
  chrome.action.setTitle({
    title: !state.enabled ? 'OpenDM [DISABLED] (click to enable)' : !state.alive ? 'OpenDM is not running (start the app)' : !state.cfg?.enabled ? 'OpenDM: browser integration is off in the app options' : 'OpenDM (click to disable integration)',
  });
}

// ---- matching helpers --------------------------------------------------------------------------

function wild(pattern, value) {
  const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(value);
}

function list(v) {
  return Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/).filter(Boolean);
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}

function excluded(url) {
  const cfg = state.cfg;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (list(cfg.excludedSites).some((p) => wild(p, host) || wild('*.' + p, host))) return true;
  if (list(cfg.excludedAddresses).some((p) => wild(p, url) || wild(p, url.replace(/^\w+:\/\//, '')))) return true;
  return false;
}

function modifiers() {
  const c = state.lastClick;
  if (!c || Date.now() - c.ts > 4000) return { force: false, prevent: false };
  const held = (k) => (k === 'Alt' ? c.alt : k === 'Shift' ? c.shift : k === 'Ctrl' ? c.ctrl : k === 'Insert' ? c.insert : false);
  return { force: held(state.cfg.forceKey), prevent: held(state.cfg.preventKey) };
}

async function cookiesFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function send(payload) {
  payload.cookies = payload.cookies ?? (await cookiesFor(payload.url));
  payload.userAgent = navigator.userAgent;
  return call('/api/download', payload);
}

// ---- download takeover -------------------------------------------------------------------------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    const url = item.finalUrl || item.url;
    if (passThrough.has(url) || passThrough.has(item.url)) {
      passThrough.delete(url);
      passThrough.delete(item.url);
      return suggest();
    }
    await refreshConfig();
    if (!active() || !/^(https?|ftp):/i.test(url) || item.byExtensionId === chrome.runtime.id) return suggest();
    const mods = modifiers();
    if (mods.prevent) return suggest();
    const name = item.filename.split(/[\\/]/).pop();
    const ext = extOf(name) || extOf(url);
    const typeOk = list(state.cfg.captureTypes).some((p) => wild(p, ext));
    if (!mods.force && (excluded(url) || !typeOk)) return suggest();
    state.lastClick = null;
    try {
      await chrome.downloads.cancel(item.id);
      await chrome.downloads.erase({ id: item.id });
    } catch { /* already gone */ }
    try {
      await send({ url, referrer: item.referrer || '', fileName: name, mime: item.mime, size: item.totalBytes > 0 ? item.totalBytes : undefined, source: 'browser' });
    } catch {
      // App vanished between the health check and now: give the download back to the browser.
      passThrough.add(url);
      chrome.downloads.download({ url });
    }
  })();
  return true;
});

// ---- context menus -----------------------------------------------------------------------------

function buildMenus() {
  const want = state.cfg?.contextMenu || { downloadLink: true, downloadAll: true, downloadSelected: true };
  const key = JSON.stringify([want, active()]);
  if (buildMenus.last === key) return;
  buildMenus.last = key;
  chrome.contextMenus.removeAll(() => {
    if (!state.enabled) return;
    if (want.downloadLink) {
      chrome.contextMenus.create({ id: 'odm-link', title: 'Download with OpenDM', contexts: ['link'] });
      chrome.contextMenus.create({ id: 'odm-media', title: 'Download with OpenDM', contexts: ['image', 'video', 'audio'] });
    }
    if (want.downloadSelected) chrome.contextMenus.create({ id: 'odm-selected', title: 'Download selected links with OpenDM', contexts: ['selection'] });
    if (want.downloadAll) chrome.contextMenus.create({ id: 'odm-all', title: 'Download all links with OpenDM', contexts: ['page', 'frame'] });
  });
}

function collectLinks(selectedOnly) {
  const out = [];
  const seen = new Set();
  const add = (url, text) => {
    if (!url || seen.has(url) || !/^(https?|ftp):/i.test(url)) return;
    seen.add(url);
    out.push({ url, text: (text || '').trim().slice(0, 200) });
  };
  let root = document;
  if (selectedOnly) {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return out;
    const frag = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) frag.append(sel.getRangeAt(i).cloneContents());
    root = frag;
    (sel.toString().match(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi) || []).forEach((u) => add(u, ''));
  }
  root.querySelectorAll('a[href]').forEach((a) => add(a.href, a.textContent || a.title));
  if (!selectedOnly) {
    document.querySelectorAll('img[src], video[src], audio[src], source[src], embed[src], object[data]').forEach((el) => add(el.src || el.data, el.alt || el.title || ''));
  }
  return out;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await refreshConfig(true);
  if (!state.alive) return notifyTab(tab, 'OpenDM is not running. Start the OpenDM app and try again.');
  try {
    if (info.menuItemId === 'odm-link' || info.menuItemId === 'odm-media') {
      const url = info.menuItemId === 'odm-link' ? info.linkUrl : info.srcUrl;
      if (!/^(https?|ftp):/i.test(url || '')) return notifyTab(tab, 'This item has no downloadable address.');
      await send({ url, referrer: info.pageUrl || tab?.url || '', pageUrl: tab?.url || '', title: info.selectionText || '', force: true });
    } else {
      const selected = info.menuItemId === 'odm-selected';
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: !selected }, func: collectLinks, args: [selected] });
      const links = [];
      const seen = new Set();
      for (const r of results) for (const l of r.result || []) if (!seen.has(l.url)) {
        seen.add(l.url);
        links.push(l);
      }
      if (!links.length) return notifyTab(tab, 'Could not find any links on this page.');
      await call('/api/links', { links, pageUrl: tab.url, selected, cookies: await cookiesFor(tab.url), userAgent: navigator.userAgent, force: true });
    }
  } catch (e) {
    notifyTab(tab, 'Could not contact OpenDM: ' + e.message);
  }
});

function notifyTab(tab, message) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'odm-notice', message }).catch(() => {});
}

// ---- web player media detection ----------------------------------------------------------------

const MEDIA_CT = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

function header(details, name) {
  return details.responseHeaders?.find((x) => x.name.toLowerCase() === name)?.value || '';
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400 || !state.cfg?.videoPanel?.enabled || !active()) return;
  const vp = state.cfg.videoPanel;
  const ct = header(d, 'content-type').split(';')[0].trim().toLowerCase();
  const ext = extOf(new URL(d.url).pathname);
  const isList = /mpegurl/.test(ct) || ext === 'm3u8';
  const isDash = /dash\+xml/.test(ct) || ext === 'mpd';
  if (!MEDIA_CT.test(ct) && !list(vp.types).includes(ext)) return;
  if (ct === 'video/mp2t' || ext === 'ts' || ext === 'm4s') return; // HLS/DASH stream fragments
  let size = 0;
  const cr = header(d, 'content-range');
  if (cr) size = Number(cr.split('/')[1]) || 0;
  else size = Number(header(d, 'content-length')) || 0;
  if (!isList && !isDash && size && size < (vp.minSizeKB || 0) * 1024) return;
  let pageHost = '';
  try {
    pageHost = new URL(d.initiator || d.url).hostname;
  } catch { /* ignore */ }
  if (list(vp.excludedSites).some((p) => wild(p, pageHost) || wild('*.' + p, pageHost)) || excluded(d.url)) return;
  const items = tabMedia.get(d.tabId) || [];
  const key = d.url.replace(/([?&])(range|bytestart|byteend|rn|rbuf)=[^&]*/gi, '$1');
  if (items.some((x) => x.key === key)) return;
  items.unshift({ key, url: d.url, type: ct, size, ext: isList ? 'm3u8' : isDash ? 'mpd' : ext, kind: isList ? 'hls' : isDash ? 'dash' : 'file' });
  tabMedia.set(d.tabId, items.slice(0, 25));
  chrome.action.setBadgeText({ tabId: d.tabId, text: String(Math.min(items.length, 99)) });
  chrome.action.setBadgeBackgroundColor({ tabId: d.tabId, color: '#15806c' });
  chrome.tabs.sendMessage(d.tabId, { type: 'odm-media', items: tabMedia.get(d.tabId), mode: vp.mode }).catch(() => {});
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) {
    tabMedia.delete(d.tabId);
    chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((id) => tabMedia.delete(id));

// ---- messages from content scripts / options ---------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'odm-click') {
    state.lastClick = { ...msg, ts: Date.now() };
    return;
  }
  if (msg.type === 'odm-get-config') {
    refreshConfig().then(() => reply({ active: active(), forceKey: state.cfg?.forceKey, mode: state.cfg?.videoPanel?.mode, media: tabMedia.get(sender.tab?.id) || [] }));
    return true;
  }
  if (msg.type === 'odm-download-link') {
    send({ url: msg.url, referrer: sender.tab?.url || '', pageUrl: sender.tab?.url || '', force: true }).catch(() => {});
    return;
  }
  if (msg.type === 'odm-download-media') {
    const it = msg.item;
    const title = (sender.tab?.title || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120);
    const fileName = it.kind === 'hls' ? `${title}.ts` : /^(videoplayback|index|playlist|master|chunk|media)?$/i.test((new URL(it.url).pathname.split('/').pop() || '').replace(/\.[^.]*$/, '')) ? `${title}.${it.ext || 'mp4'}` : undefined;
    send({ url: it.url, referrer: sender.tab?.url || '', pageUrl: sender.tab?.url || '', title: sender.tab?.title || '', fileName, kind: it.kind === 'hls' ? 'hls' : undefined, mime: it.type, size: it.size || undefined, force: true })
      .then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'odm-test') {
    loadLocal().then(() => refreshConfig(true)).then(() => reply({ alive: state.alive, cfg: state.cfg }));
    return true;
  }
});

chrome.action.onClicked.addListener(async () => {
  state.enabled = !state.enabled;
  await chrome.storage.local.set({ enabled: state.enabled });
  buildMenus.last = null;
  await refreshConfig(true);
});

chrome.storage.onChanged.addListener(() => loadLocal().then(() => refreshConfig(true)));
chrome.alarms.create('odm-refresh', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => refreshConfig(true));
chrome.runtime.onStartup.addListener(() => loadLocal().then(() => refreshConfig(true)));
chrome.runtime.onInstalled.addListener(() => loadLocal().then(() => refreshConfig(true)));
loadLocal().then(() => refreshConfig(true));

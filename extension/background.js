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
      const web = ['http://*/*', 'https://*/*', 'ftp://*/*'];
      chrome.contextMenus.create({ id: 'odm-link', title: 'Download with OpenDM', contexts: ['link'], targetUrlPatterns: web });
      // blob: sources (most web players) have no downloadable address, so the item is hidden for them.
      chrome.contextMenus.create({ id: 'odm-media', title: 'Download with OpenDM', contexts: ['image', 'video', 'audio'], targetUrlPatterns: web });
      chrome.contextMenus.create({
        id: 'odm-videopage', title: 'Download this video with OpenDM', contexts: ['page', 'video', 'frame'],
        documentUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*', '*://*.youtube.com/live/*'],
      });
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
    if (info.menuItemId === 'odm-videopage') {
      const title = (tab.title || 'video').replace(/ - YouTube$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'video';
      await send({ url: tab.url, referrer: tab.url, pageUrl: tab.url, title, fileName: `${title}.mp4`, kind: 'ytdlp', ytdlp: { quality: 'best' }, cookies: '', force: true });
    } else if (info.menuItemId === 'odm-link' || info.menuItemId === 'odm-media') {
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
  if (/(^|\.)googlevideo\.com$/i.test(new URL(d.url).hostname)) return; // handled by the YouTube capture below
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
    ytTabs.delete(d.tabId);
    chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
  }
});
// YouTube navigates between videos without reloading the page.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId === 0 && ytTabs.has(d.tabId)) {
    ytTabs.delete(d.tabId);
    tabMedia.delete(d.tabId);
    chrome.action.setBadgeText({ tabId: d.tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  tabMedia.delete(id);
  ytTabs.delete(id);
});

// ---- YouTube: reuse the stream addresses the page's own player requests ------------------------
// The player fetches separate video and audio streams from googlevideo.com. Each request URL is
// already authorised for this browser, and carries the format (itag), MIME type and byte length
// (clen). We keep one URL per format, drop the per-request range parameters, and offer every
// format pair the player has loaded. Quality labels come from the player's own response data.

const ytTabs = new Map(); // tabId -> { sid, formats: Map<itag, fmt>, sabr, meta, timer, qualities, title }
const STRIP = ['range', 'rn', 'rbuf', 'ump', 'alr', 'srfvp'];

chrome.webRequest.onBeforeRequest.addListener((d) => {
  // Record even before the config has loaded: Chrome wakes this service worker for the request
  // itself, so the settings are checked later, in publishYouTube.
  if (d.tabId < 0 || !state.enabled) return;
  let u;
  try {
    u = new URL(d.url);
  } catch {
    return;
  }
  const sid = u.searchParams.get('id') || '';
  const itag = u.searchParams.get('itag');
  let t = ytTabs.get(d.tabId);
  if (!t || (sid && itag && t.sid !== sid)) {
    t = { sid, formats: new Map(), sabr: false, meta: null, timer: null };
    ytTabs.set(d.tabId, t);
  }
  const clen = Number(u.searchParams.get('clen'));
  const mime = u.searchParams.get('mime') || '';
  if (!itag || !clen || !mime) {
    // Server-driven streaming (sabr) and live streams carry no replayable byte range.
    if (u.searchParams.has('sabr') || d.method === 'POST') {
      t.sabr = true;
      publishYouTube(d.tabId);
    }
    return;
  }
  if (t.formats.has(itag)) return;
  for (const k of STRIP) u.searchParams.delete(k);
  t.formats.set(itag, { itag, url: u.href, mime, clen, dur: Number(u.searchParams.get('dur')) || 0 });
  publishYouTube(d.tabId);
}, { urls: ['*://*.googlevideo.com/videoplayback*'], types: ['xmlhttprequest', 'media', 'other'] });

function publishYouTube(tabId) {
  const t = ytTabs.get(tabId);
  if (!t || t.timer) return;
  t.timer = setTimeout(async () => {
    t.timer = null;
    await refreshConfig();
    if (!active() || !state.cfg?.videoPanel?.enabled) return;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => {
          // Read-only metadata from the player; stream addresses are not taken from here.
          const p = document.querySelector('#movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          if (!p) return null;
          return {
            title: p.videoDetails?.title || document.title,
            fmts: (p.streamingData?.adaptiveFormats || []).map((f) => ({ itag: String(f.itag), q: f.qualityLabel || '', h: f.height || 0, fps: f.fps || 0, abr: f.averageBitrate || f.bitrate || 0 })),
          };
        },
      });
      t.meta = r?.result || t.meta;
    } catch { /* page not scriptable */ }
    const items = youTubeItems(t);
    tabMedia.set(tabId, items);
    chrome.action.setBadgeText({ tabId, text: items.length && items[0].kind !== 'notice' ? String(Math.min(99, items.length)) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#15806c' });
    chrome.tabs.sendMessage(tabId, { type: 'odm-media', items, mode: state.cfg?.videoPanel?.mode }).catch(() => {});
  }, 400);
}

function extFor(mime) {
  if (/^audio\/mp4/.test(mime)) return 'm4a';
  if (/webm/.test(mime)) return 'webm';
  if (/mp4/.test(mime)) return 'mp4';
  return 'bin';
}

function youTubeItems(t) {
  const meta = new Map((t.meta?.fmts || []).map((f) => [f.itag, f]));
  const all = [...t.formats.values()].map((f) => ({ h: 0, fps: 0, abr: 0, q: '', ...f, ...(meta.get(f.itag) || {}), ext: extFor(f.mime) }));
  const videos = all.filter((f) => f.mime.startsWith('video/')).sort((a, b) => (b.h - a.h) || (b.clen - a.clen));
  const audios = all.filter((f) => f.mime.startsWith('audio/')).sort((a, b) => (b.abr - a.abr) || (b.clen - a.clen));
  const part = (f, role) => ({ role, url: f.url, size: f.clen, ext: f.ext, mime: f.mime, label: f.q || `itag ${f.itag}` });
  const qualities = [];
  for (const v of videos) {
    const family = v.ext === 'webm' ? 'webm' : 'm4a';
    const a = audios.find((x) => x.ext === family) || audios[0];
    const container = !a ? `${v.ext.toUpperCase()} (no audio)` : v.ext === 'webm' && a.ext === 'webm' ? 'WebM' : v.ext === 'mp4' && a.ext === 'm4a' ? 'MP4' : 'MKV';
    qualities.push({ label: `${v.q || 'itag ' + v.itag} ${container}`, size: v.clen + (a?.clen || 0), parts: a ? [part(v, 'video'), part(a, 'audio')] : [part(v, 'video')] });
  }
  for (const a of audios) qualities.push({ label: `Audio only · ${a.ext.toUpperCase()}${a.abr ? ' ' + Math.round(a.abr / 1000) + ' kbps' : ''}`, size: a.clen, parts: [part(a, 'audio')] });
  t.qualities = qualities;
  t.title = (t.meta?.title || 'video').replace(/ - YouTube$/, '');
  if (!qualities.length && t.sabr) {
    // Server-driven streaming: the player's requests can't be replayed, so the app hands the
    // page to yt-dlp. Offer the heights the player reports.
    const heights = [...new Set((t.meta?.fmts || []).map((f) => f.h).filter(Boolean))].sort((a, b) => b - a);
    return [
      { kind: 'ytdlp', label: 'Best quality', quality: 'best' },
      ...heights.map((h) => ({ kind: 'ytdlp', label: `${h}p`, quality: String(h) })),
      { kind: 'ytdlp', label: 'Audio only (M4A)', quality: 'audio' },
    ];
  }
  return qualities.map((q, i) => ({ kind: 'youtube', label: q.label, size: q.size, ext: q.parts.length > 1 ? '' : q.parts[0].ext, index: i }));
}


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
  if (msg.type === 'odm-download-media' && msg.item.kind === 'ytdlp') {
    const t = ytTabs.get(sender.tab?.id);
    const title = (t?.title || sender.tab?.title || 'video').replace(/ - YouTube$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'video';
    send({ url: sender.tab.url, referrer: sender.tab.url, pageUrl: sender.tab.url, title, fileName: `${title}.${msg.item.quality === 'audio' ? 'm4a' : 'mp4'}`, kind: 'ytdlp', ytdlp: { quality: msg.item.quality }, cookies: '', force: true })
      .then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'odm-download-media' && msg.item.kind === 'youtube') {
    const t = ytTabs.get(sender.tab?.id);
    const q = t?.qualities?.[msg.item.index];
    if (!q) {
      reply({ ok: false, error: 'This video is no longer available - reload the page.' });
      return;
    }
    const qualities = [q, ...t.qualities.filter((x) => x !== q)];
    const title = t.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'video';
    // cookies: '' - the page's youtube.com cookies must never be sent to googlevideo.com.
    send({ url: sender.tab.url, referrer: sender.tab.url, pageUrl: sender.tab.url, title: t.title, fileName: `${title}.${q.parts.length > 1 ? 'mp4' : q.parts[0].ext}`, kind: 'muxed', parts: q.parts, qualities, size: q.size, cookies: '', force: true })
      .then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
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

import { api, h, icon, bytes, rate, duration, fileBadge, params, check, select, field, applyAppearance, toast, extOf, resizableColumns, isRunning } from './common.js';

async function boot() {
  const st = await api.invoke('state');
  applyAppearance(st.settings);
  api.on('settings', applyAppearance);
  return st;
}

async function payload() {
  const t = params.get('token');
  return t ? api.invoke('pending', t) : null;
}

const close = () => api.invoke('win:close');

// ---- progress ----------------------------------------------------------------------------------

export async function mountProgress(root) {
  const st = await boot();
  const id = params.get('id');
  let item = st.items.find((x) => x.id === id);
  if (!item) return close();
  let details = true;
  let tab = 'status';
  const full = await api.invoke('dl:item', id);

  const kv = {};
  const kvRow = (k, label) => [h('div', {}, label), (kv[k] = h('div', {}))];
  const statusGrid = h('div', { class: 'kv' }, kvRow('url', 'Address'), kvRow('status', 'Status'), kvRow('size', 'File size'), kvRow('done', 'Downloaded'), kvRow('rate', 'Transfer rate'), kvRow('eta', 'Time left'), kvRow('resume', 'Resume capability'));
  const bar = h('i');
  const canvas = h('canvas', { class: 'segmap', height: 18 });
  const connBody = h('tbody');
  const conns = h('div', { class: 'table-wrap', style: { maxHeight: '140px', border: '1px solid var(--border)', borderRadius: '5px' } },
    resizableColumns(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: { width: '44px' } }, 'N.'), h('th', { style: { width: '120px' } }, 'Downloaded'), h('th', { style: { width: '260px' } }, 'Info'))), connBody)));
  const detailsBox = h('div', { class: 'col' }, h('div', { class: 'hint' }, 'Start positions and download progress by connections'), canvas,
    h('div', { class: 'legend' }, h('span', {}, h('i', { style: { background: 'var(--seg-done)' } }), 'downloaded'), h('span', {}, h('i', { style: { background: 'var(--seg-start)' } }), 'connection start'), h('span', {}, h('i', { style: { background: 'var(--seg-todo)', border: '1px solid var(--border)' } }), 'remaining')), conns);

  const lim = { on: (full.speedLimitKB || 0) > 0, kb: full.speedLimitKB || 500 };
  const limiterPane = () => h('div', { class: 'col' },
    check('Use speed limiter for this download', lim.on, (v) => { lim.on = v; api.invoke('dl:update', id, { speedLimitKB: v ? lim.kb : 0 }); }),
    field('Maximum speed', h('div', { class: 'row' }, h('input', { type: 'number', min: 1, value: lim.kb, onchange: (e) => { lim.kb = Number(e.target.value); if (lim.on) api.invoke('dl:update', id, { speedLimitKB: lim.kb }); } }), 'KB/s')),
    field('Connections', h('div', { class: 'row' }, select([[0, 'Default'], [1, '1'], [2, '2'], [4, '4'], [6, '6'], [8, '8'], [12, '12'], [16, '16'], [24, '24'], [32, '32']], full.maxConnections || 0, (v) => api.invoke('dl:update', id, { maxConnections: Number(v) })))));
  const oc = { showDialog: full.onComplete?.showDialog ?? st.settings.downloads.showCompleteDialog, exitApp: !!full.onComplete?.exitApp, power: full.onComplete?.power || 'none', forceTerminate: !!full.onComplete?.forceTerminate };
  const saveOc = () => api.invoke('dl:update', id, { onComplete: { ...oc } });
  const completionPane = () => h('div', { class: 'col' },
    check('Show the download complete dialog', oc.showDialog, (v) => { oc.showDialog = v; saveOc(); }),
    check('Exit OpenDM when done', oc.exitApp, (v) => { oc.exitApp = v; saveOc(); }),
    field('Then', select([['none', 'Do nothing'], ['shutdown', 'Shut down the computer'], ['restart', 'Restart the computer'], ['sleep', 'Sleep'], ['hibernate', 'Hibernate']], oc.power, (v) => { oc.power = v; saveOc(); })),
    check('Force programs to close (may lose unsaved work)', oc.forceTerminate, (v) => { oc.forceTerminate = v; saveOc(); }));

  const tabBar = h('div', { class: 'tabs' });
  const body = h('div', { class: 'pg' });
  const pauseBtn = h('button', { class: 'btn', onclick: () => (isRunning(item) ? api.invoke('dl:stop', [id]) : api.invoke('dl:start', [id], false)) });
  const detailsBtn = h('button', { class: 'btn', onclick: () => { details = !details; paint(); } });
  const foot = h('div', { class: 'modal-foot' }, h('div', { class: 'left' }, detailsBtn), pauseBtn, h('button', { class: 'btn', onclick: () => { if (isRunning(item)) api.invoke('dl:stop', [id]); close(); } }, 'Cancel'));
  const paint = () => {
    tabBar.replaceChildren(...[['status', 'Download status'], ['limiter', 'Speed limiter'], ['complete', 'Options on completion']].map(([k, l]) => h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; paint(); } }, l)));
    if (tab === 'status') body.replaceChildren(statusGrid, h('div', { class: 'bigbar' }, bar), details ? detailsBox : null);
    else body.replaceChildren(tab === 'limiter' ? limiterPane() : completionPane());
    detailsBtn.textContent = details ? '« Hide details' : 'Show details »';
    pauseBtn.replaceChildren(icon(isRunning(item) ? 'pause' : 'play'), isRunning(item) ? 'Pause' : 'Resume');
  };
  root.append(tabBar, h('div', { style: { flex: 1, overflow: 'auto' } }, body), foot);
  paint();

  const drawSegments = (s) => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = w * dpr;
    canvas.height = 18 * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--seg-todo');
    g.fillRect(0, 0, w, 18);
    if (s.hlsSegments?.total) {
      const n = s.hlsSegments.total;
      g.fillStyle = css.getPropertyValue('--seg-done');
      for (const i of s.hlsSegments.done) g.fillRect((i / n) * w, 0, Math.max(1, w / n), 18);
      return;
    }
    const total = s.size;
    if (!total) {
      g.fillStyle = css.getPropertyValue('--seg-done');
      g.fillRect(0, 0, w * 0.04 + ((Date.now() / 20) % (w * 0.96)), 18);
      return;
    }
    for (const [a, , p] of s.segments || []) {
      g.fillStyle = css.getPropertyValue('--seg-done');
      g.fillRect((a / total) * w, 0, Math.max(0.5, ((p - a) / total) * w), 18);
    }
    g.fillStyle = css.getPropertyValue('--seg-start');
    for (const c of s.connections || []) g.fillRect(Math.floor((c.start / total) * w), 0, 2, 18);
  };

  const update = async () => {
    const s = await api.invoke('dl:stats', id);
    if (!s) return close();
    const size = s.size || s.estimatedSize;
    const pct = s.fraction != null && s.hlsSegments ? s.fraction * 100 : size ? (100 * s.downloaded) / size : 0;
    kv.url.textContent = item.url;
    kv.url.title = item.url;
    kv.status.textContent = isRunning(item) ? item.statusText || 'Receiving data...' : item.status === 'error' ? 'Error: ' + (item.error || '') : item.status === 'complete' ? 'Complete' : 'Paused';
    kv.status.className = item.status === 'error' ? 'status-err' : '';
    kv.size.textContent = s.size ? bytes(s.size) : s.estimatedSize ? '≈ ' + bytes(s.estimatedSize) : '(unknown)';
    kv.done.textContent = `${bytes(s.downloaded, '0 Bytes')}${size ? ` (${pct.toFixed(2)} %)` : ''}`;
    kv.rate.textContent = item.status === 'downloading' ? rate(s.rate) || '—' : '';
    kv.eta.textContent = item.status === 'downloading' ? duration(s.eta) || '(unknown)' : '';
    kv.resume.textContent = s.resumable == null ? '(unknown)' : s.resumable ? 'Yes' : 'No';
    kv.resume.className = s.resumable === false ? 'status-err' : '';
    bar.style.transform = `scaleX(${Math.min(100, pct) / 100})`;
    api.invoke('win:setTitle', `${size ? Math.floor(pct) + '% ' : ''}${item.fileName}`);
    if (details && tab === 'status') {
      drawSegments(s);
      connBody.replaceChildren(...(s.connections || []).map((c, i) => h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', { class: 'num' }, s.hlsSegments ? bytes(c.bytes || 0) : bytes(c.pos - c.start, '0 Bytes')),
        h('td', {}, s.hlsSegments ? `Segment ${c.id}` : c.receiving ? 'Receiving data...' : 'Connecting...'))));
      if (!s.connections?.length) connBody.replaceChildren(h('tr', {}, h('td', { colspan: 3, class: 'muted' }, item.status === 'downloading' ? 'Connecting…' : 'No active connections')));
    }
  };
  api.on('dl:changed', (it) => {
    if (it.id !== id) return;
    const was = item.status;
    item = { ...item, ...it };
    if (was !== item.status) paint();
  });
  api.on('dl:removed', (ids) => ids.includes(id) && close());
  update();
  setInterval(update, 500);
}

// ---- download complete -------------------------------------------------------------------------

export async function mountComplete(root) {
  await boot();
  const id = params.get('id');
  const it = await api.invoke('dl:item', id);
  if (!it) return close();
  let dont = false;
  const dragIcon = h('div', { draggable: 'true', title: 'Drag the file to another program or folder', style: { cursor: 'grab', transform: 'scale(2.2)', margin: '14px 22px' }, ondragstart: (e) => { e.preventDefault(); api.startDrag(id); } }, fileBadge(it.fileName));
  const finish = async (fn) => {
    if (dont) await api.invoke('settings:save', { downloads: { showCompleteDialog: false } });
    await fn?.();
    close();
  };
  root.append(
    h('div', { class: 'pg', style: { flexDirection: 'row', gap: '6px', alignItems: 'center' } }, dragIcon,
      h('div', { class: 'kv grow' },
        h('div', {}, 'File'), h('div', { title: it.fileName, style: { fontWeight: 600 } }, it.fileName),
        h('div', {}, 'Size'), h('div', {}, bytes(it.size)),
        h('div', {}, 'Saved to'), h('div', { title: it.savedPath, class: 'mono' }, it.savedPath),
        h('div', {}, 'Address'), h('div', { title: it.url }, it.url))),
    h('div', { style: { padding: '0 14px' } }, check("Don't show this dialog again", false, (v) => (dont = v))),
    h('div', { class: 'modal-foot', style: { marginTop: 'auto' } },
      h('button', { class: 'btn primary', onclick: () => finish(() => api.invoke('dl:open', id)) }, 'Open'),
      h('button', { class: 'btn', onclick: () => finish(() => api.invoke('dl:openFolder', id)) }, icon('folderOpen'), 'Open folder'),
      h('button', { class: 'btn', onclick: () => finish() }, 'Close')));
  root.style.minHeight = '100%';
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

// ---- Download File Info ------------------------------------------------------------------------

export async function mountNewDownload(root) {
  const st = await boot();
  const p = (await payload()) || {};
  const s = st.settings;
  const d = { url: p.url || '', fileName: '', saveDir: '', category: '', description: p.description || '', remember: false, user: p.auth?.user || '', pass: p.auth?.pass || '', variant: null, queueId: 'main', parts: p.parts || null };
  const partsSize = () => (d.parts && d.parts.every((x) => x.size) ? d.parts.reduce((a, x) => a + x.size, 0) : null);
  let info = null;
  let userEditedName = !!p.fileName;
  let userEditedDir = !!p.saveDir;

  const urlInp = h('input', { type: 'url', class: 'grow', value: d.url, oninput: (e) => { d.url = e.target.value.trim(); reprobe(); } });
  const catSel = h('select', { onchange: (e) => { d.category = e.target.value; if (!userEditedDir) { d.saveDir = folderFor(d.category); dirInp.value = d.saveDir; } rememberLbl.lastChild.textContent = ` Remember this folder for "${catName()}"`; } }, st.categories.map((c) => h('option', { value: c.id }, c.name)));
  const nameInp = h('input', { type: 'text', class: 'grow', oninput: (e) => { d.fileName = e.target.value; userEditedName = true; } });
  const dirInp = h('input', { type: 'text', class: 'grow', oninput: (e) => { d.saveDir = e.target.value; userEditedDir = true; } });
  const descInp = h('input', { type: 'text', class: 'grow', value: d.description, oninput: (e) => (d.description = e.target.value) });
  const sizeEl = h('span', { class: 'muted' }, 'Checking…');
  const rememberLbl = check('Remember this folder', false, (v) => (d.remember = v));
  const authBox = h('div', { class: 'row hidden' }, h('input', { type: 'text', placeholder: 'User', value: d.user, oninput: (e) => (d.user = e.target.value) }), h('input', { type: 'password', placeholder: 'Password', value: d.pass, oninput: (e) => (d.pass = e.target.value) }), h('button', { class: 'btn small', onclick: () => reprobe(true) }, 'Retry'));
  const qualityRow = h('div', { class: 'hidden' });
  const dupRow = h('div', { class: 'hidden' });
  let dupAction = null;
  const catName = () => st.categories.find((c) => c.id === d.category)?.name || 'General';
  const folderFor = (cat) => (s.saveTo.rememberLastPath && s.lastSaveDirs[cat]) || st.categories.find((c) => c.id === cat)?.folder || st.categories[0].folder;

  let seq = 0;
  const reprobe = async (force) => {
    const my = ++seq;
    if (!/^(https?|ftp):\/\//i.test(d.url)) {
      sizeEl.textContent = 'Enter a valid address';
      return;
    }
    if (!force) await new Promise((r) => setTimeout(r, 250));
    if (my !== seq) return;
    sizeEl.textContent = 'Checking…';
    const auth = d.user ? { user: d.user, pass: d.pass } : undefined;
    info = await api.invoke('dl:describe', d.url, { referer: p.referer, cookies: p.cookies, fileName: userEditedName ? d.fileName || p.fileName : p.fileName, mime: p.mime, auth, category: d.category || undefined, kind: d.parts ? 'muxed' : p.kind, parts: d.parts || undefined, size: partsSize() || p.size, probe: p.kind !== 'hls' && !d.parts });
    if (my !== seq) return;
    if (!userEditedName) {
      d.fileName = info.fileName;
      nameInp.value = d.fileName;
    }
    if (!d.category || !userEditedDir) {
      d.category = info.category;
      catSel.value = d.category;
      rememberLbl.lastChild.textContent = ` Remember this folder for "${catName()}"`;
    }
    if (!userEditedDir) {
      d.saveDir = p.saveDir || info.saveDir;
      dirInp.value = d.saveDir;
    }
    const size = info.size ?? p.size;
    sizeEl.textContent = info.error ? (info.authRequired ? 'The server asks for a login' : 'Could not check: ' + info.error) : `${size ? bytes(size) : 'Size unknown'}${info.resumable === false ? ' · cannot be resumed' : ''}`;
    sizeEl.className = info.error ? 'status-err' : 'muted';
    authBox.classList.toggle('hidden', !info.authRequired && !d.user);
    if (info.kind === 'hls') loadVariants();
    if (info.kind === 'ytdlp') loadYtdlp();
    if (p.qualities?.length && qualityRow.classList.contains('hidden')) {
      qualityRow.classList.remove('hidden');
      const pick = (i) => {
        d.parts = p.qualities[i].parts;
        const sz = partsSize();
        sizeEl.textContent = `${p.qualities[i].label}${sz ? ' · ' + bytes(sz) : ''}${d.parts.length > 1 ? ' · video and audio are merged after download' : ''}`;
      };
      qualityRow.replaceChildren(field('Quality', select(p.qualities.map((q, i) => [i, `${q.label}${q.size ? ' — ' + bytes(q.size) : ''}`]), 0, (v) => pick(Number(v))), 'Only qualities the player has loaded are listed. Switch quality in the player to add more.'));
      pick(0);
    }
    checkDuplicate();
  };

  const loadVariants = async () => {
    try {
      const vs = await api.invoke('util:hlsVariants', d.url, p.referer);
      if (!vs.length) return;
      d.variant = vs[0].uri;
      qualityRow.classList.remove('hidden');
      qualityRow.replaceChildren(field('Quality', select(vs.map((v) => [v.uri, `${v.resolution || 'audio/other'} · ${Math.round(v.bandwidth / 1000)} kbps`]), d.variant, (v) => (d.variant = v))));
      sizeEl.textContent = 'Stream (HLS) · size known after download';
    } catch { /* not a master playlist */ }
  };


  let ytLoaded = false;
  const loadYtdlp = async () => {
    if (ytLoaded) return;
    ytLoaded = true;
    qualityRow.classList.remove('hidden');
    qualityRow.replaceChildren(h('div', { class: 'hint', style: { paddingLeft: '138px' } }, 'Reading video information…'));
    const info = await api.invoke('util:ytdlpInfo', d.url).catch((e) => ({ error: e.message }));
    if (info.missing) {
      const btn = h('button', {
        class: 'btn primary', onclick: async () => {
          btn.disabled = true;
          btn.textContent = 'Downloading yt-dlp…';
          try {
            await api.invoke('util:ytdlpInstall');
            ytLoaded = false;
            loadYtdlp();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Retry';
            toast('Could not download yt-dlp: ' + e.message);
          }
        },
      }, 'Download yt-dlp');
      qualityRow.replaceChildren(h('div', { class: 'col', style: { background: 'var(--accent-soft)', padding: '10px 12px', borderRadius: '6px', gap: '6px' } },
        h('div', {}, 'Video pages like YouTube are downloaded with yt-dlp, a free open-source tool. It is not installed yet.'),
        h('div', { class: 'row' }, btn, h('span', { class: 'hint' }, 'About 18 MB, from github.com/yt-dlp/yt-dlp (official releases).'))));
      sizeEl.textContent = 'Video page';
      return;
    }
    if (info.error) {
      qualityRow.replaceChildren(h('div', { class: 'status-err', style: { paddingLeft: '138px' } }, info.error));
      sizeEl.textContent = 'Could not read this video';
      sizeEl.className = 'status-err';
      return;
    }
    if (!userEditedName && info.title) {
      d.fileName = info.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) + '.mp4';
      nameInp.value = d.fileName;
    }
    const opts = [['best', 'Best available'], ...info.heights.map((x) => [String(x), `${x}p${info.sizes[x] ? ' — about ' + bytes(info.sizes[x]) : ''}`]), ['audio', 'Audio only (M4A)']];
    const want = p.ytdlp?.quality && opts.some((o) => o[0] === String(p.ytdlp.quality)) ? String(p.ytdlp.quality) : 'best';
    d.ytdlpQuality = want;
    const setQ = (v) => {
      d.ytdlpQuality = v;
      if (!userEditedName && d.fileName) {
        d.fileName = d.fileName.replace(/\.(mp4|m4a)$/i, '') + (v === 'audio' ? '.m4a' : '.mp4');
        nameInp.value = d.fileName;
      }
    };
    setQ(want);
    qualityRow.replaceChildren(field('Quality', select(opts, want, setQ)));
    const dur = info.duration ? ` · ${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')}` : '';
    sizeEl.textContent = `${info.extractor || 'Video'}${dur} · video and audio are merged after download`;
    sizeEl.className = 'muted';
  };

  const checkDuplicate = () => {
    const dup = st.items.find((x) => x.url === d.url);
    dupAction = null;
    dupRow.classList.toggle('hidden', !dup || s.downloads.duplicateAction !== 'ask');
    if (dup && s.downloads.duplicateAction === 'ask') {
      dupAction = 'number';
      dupRow.replaceChildren(h('div', { class: 'col', style: { background: 'var(--accent-soft)', padding: '8px 10px', borderRadius: '6px' } },
        h('div', {}, `This address is already in the list (${dup.status === 'complete' ? 'downloaded' : 'not finished'}).`),
        select([['number', 'Add it again with a numbered name'], ['overwrite', 'Replace the existing download'], ['resume', dup.status === 'complete' ? 'Keep the existing file' : 'Resume the existing download']], 'number', (v) => (dupAction = v))));
    }
  };

  const queueSel = select(st.queues.filter((q) => q.type === 'download').map((q) => [q.id, q.name]), 'main', (v) => (d.queueId = v));
  const go = async (start) => {
    if (!/^(https?|ftp):\/\//i.test(d.url)) return toast('Enter a valid address');
    try {
      await api.invoke('dl:add', {
        url: d.url, fileName: d.fileName || undefined, saveDir: d.saveDir, category: d.category, description: d.description,
        referer: p.referer, parentPage: p.parentPage, cookies: p.cookies, userAgent: p.userAgent, mime: p.mime, size: info?.size ?? p.size, kind: p.kind,
        auth: d.user ? { user: d.user, pass: d.pass } : undefined, rememberPath: d.remember, duplicateAction: dupAction || undefined,
        hls: d.variant ? { variant: d.variant } : p.hls, start, queueId: start ? null : d.queueId,
        parts: d.parts || undefined, kind: d.parts ? 'muxed' : p.kind,
        ytdlp: d.ytdlpQuality ? { quality: d.ytdlpQuality } : undefined,
      });
      close();
    } catch (e) {
      toast(e.message);
    }
  };

  root.append(h('div', { class: 'modal-body' },
    h('div', { class: 'row' }, h('div', { style: { transform: 'scale(1.7)', margin: '6px 14px 6px 8px' } }, fileBadge(p.fileName || d.url.split('?')[0])), h('div', { class: 'col grow', style: { gap: '2px' } }, h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, p.fileName || (d.url.split('?')[0].split('/').pop() || d.url)), sizeEl)),
    field('Address', urlInp),
    authBox,
    qualityRow,
    field('Category', h('div', { class: 'row' }, catSel, h('button', { class: 'btn small', title: 'Open category folder', onclick: () => api.invoke('util:openPath', d.saveDir) }, icon('folderOpen')))),
    field('Save as', h('div', { class: 'col', style: { gap: '6px' } }, nameInp, h('div', { class: 'row' }, dirInp, h('button', { class: 'btn', onclick: async () => { const f = await api.invoke('dialog:folder', d.saveDir); if (f) { d.saveDir = f; dirInp.value = f; userEditedDir = true; } } }, 'Browse…')))),
    h('div', { style: { paddingLeft: '138px' } }, rememberLbl),
    field('Description', descInp),
    dupRow),
  h('div', { class: 'modal-foot' },
    h('div', { class: 'left' }, s.downloads.showQueuePanelOnLater ? h('span', { class: 'row' }, h('span', { class: 'hint' }, 'Later into'), queueSel) : null),
    h('button', { class: 'btn', onclick: () => go(false) }, 'Download later'),
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => go(true) }, icon('down'), 'Start download')));
  root.style.minHeight = '100%';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') go(true);
  });
  if (p.fileName) nameInp.value = d.fileName = p.fileName;
  reprobe(true);
}

// ---- link list ("Download all links", batch, import) -------------------------------------------

const PAGE_EXT = new Set(['', 'htm', 'html', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cgi']);

export async function mountLinks(root) {
  const st = await boot();
  const p = (await payload()) || { links: [] };
  api.invoke('win:setTitle', p.title || 'Download all links');
  const rows = p.links.map((l) => {
    let name = '';
    try {
      name = decodeURIComponent(new URL(l.url).pathname.split('/').pop() || '') || new URL(l.url).hostname;
    } catch { name = l.url; }
    return { url: l.url, name, text: l.text || '', ext: extOf(name), size: null, type: '', checked: !PAGE_EXT.has(extOf(name)), probed: false };
  });
  let hideHtml = true;
  let filter = '';
  let saveDir = '';
  let queueId = 'main';
  let start = false;
  const tbody = h('tbody');
  const countEl = h('span', { class: 'muted' });
  const visible = () => rows.filter((r) => (!hideHtml || !PAGE_EXT.has(r.ext) || (r.type && !/html/.test(r.type))) && (!filter || filter.split(/[\s,;]+/).filter(Boolean).some((f) => new RegExp('^' + f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(r.name))));
  const paint = () => {
    const v = visible();
    tbody.replaceChildren(...v.map((r) => h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: r.checked, onchange: (e) => { r.checked = e.target.checked; counts(); } })),
      h('td', {}, h('div', { class: 'namecell' }, fileBadge(r.name), h('span', { class: 'ellipsis', title: r.name }, r.name))),
      h('td', { class: 'num' }, r.size != null ? bytes(r.size) : r.probed ? '' : '…'),
      h('td', { title: r.type }, r.type.split(';')[0]),
      h('td', { title: r.text }, r.text),
      h('td', { title: r.url, class: 'mono' }, r.url))));
    counts();
  };
  const counts = () => {
    const v = visible();
    const sel = v.filter((r) => r.checked);
    countEl.textContent = `${sel.length} of ${v.length} selected · ${bytes(sel.reduce((a, r) => a + (r.size || 0), 0), '0 Bytes')}`;
  };
  const setAll = (on) => {
    for (const r of visible()) r.checked = on;
    paint();
  };
  const table = h('div', { class: 'table-wrap', style: { border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--surface)' } },
    resizableColumns(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: { width: '32px' } }, ''), h('th', { style: { width: '240px' } }, 'File name'), h('th', { style: { width: '90px' } }, 'Size'), h('th', { style: { width: '120px' } }, 'Type'), h('th', { style: { width: '160px' } }, 'Description'), h('th', { style: { width: '380px' } }, 'Address'))), tbody)));
  root.append(h('div', { class: 'modal-body', style: { overflow: 'hidden' } },
    h('div', { class: 'row' },
      h('div', { class: 'hint grow' }, 'Check the files you want to download and click OK. Sizes and types are checked in the background.'),
      check('Hide web pages', hideHtml, (v) => { hideHtml = v; paint(); }),
      h('input', { type: 'text', placeholder: 'Filter, e.g. *.zip *.pdf', style: { width: '180px' }, oninput: (e) => { filter = e.target.value.trim(); paint(); } })),
    table,
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => setAll(true) }, 'Check all'), h('button', { class: 'btn small', onclick: () => setAll(false) }, 'Uncheck all'), countEl),
    h('div', { class: 'row' }, h('span', { style: { width: '90px', color: 'var(--text-2)' } }, 'Save to'), h('input', { type: 'text', class: 'grow', placeholder: 'Category folder for each file type', oninput: (e) => (saveDir = e.target.value) }), h('button', { class: 'btn', onclick: async (e) => { const f = await api.invoke('dialog:folder'); if (f) { saveDir = f; e.target.previousSibling.value = f; } } }, 'Browse…')),
    h('div', { class: 'row' }, h('span', { style: { width: '90px', color: 'var(--text-2)' } }, 'Add to'), select([['', 'No queue'], ...st.queues.filter((q) => q.type === 'download').map((q) => [q.id, q.name])], 'main', (v) => (queueId = v)), check('Start downloading now', false, (v) => (start = v)))),
  h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', {
    class: 'btn primary',
    onclick: async () => {
      const sel = visible().filter((r) => r.checked);
      if (!sel.length) return toast('Nothing is checked');
      await api.invoke('dl:addMany', sel.map((r) => ({ url: r.url, description: r.text, referer: p.referer, cookies: p.cookies, userAgent: p.userAgent, auth: p.auth || undefined, saveDir: saveDir || undefined, size: r.size || undefined })), { queueId: queueId || null, start });
      close();
    },
  }, 'OK')));
  root.style.minHeight = '100%';
  paint();
  if (!p.noProbe) {
    const todo = rows.slice();
    const worker = async () => {
      while (todo.length) {
        const batch = todo.splice(0, 6);
        const res = await api.invoke('util:probe', batch.map((r) => r.url), { referer: p.referer });
        for (const r of batch) {
          const x = res[r.url] || {};
          r.size = x.size ?? null;
          r.type = x.type || '';
          r.probed = true;
          if (/text\/html/.test(r.type) && PAGE_EXT.has(r.ext)) r.checked = false;
        }
        paint();
      }
    };
    Promise.all([worker(), worker()]);
  }
}

// ---- drop target -------------------------------------------------------------------------------

export async function mountDrop(root) {
  await boot();
  document.body.style.background = 'transparent';
  const zone = h('div', { class: 'drop', title: 'Drop links here to download them with OpenDM. Double-click to open OpenDM.' }, icon('drop'));
  root.append(zone);
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    const urls = [...new Set(text.match(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi) || [])];
    if (urls.length === 1) api.invoke('win:open', 'newdl', {}, { key: 'newdl:' + Date.now(), payload: { url: urls[0], source: 'drop' }, width: 620, height: 430, title: 'Download File Info', alwaysOnTop: true });
    else if (urls.length > 1) api.invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), title: 'Download dropped links' } });
  });
  zone.addEventListener('dblclick', () => api.invoke('win:showMain'));
  zone.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.invoke('win:showMain');
  });
}

// ---- shutdown countdown ------------------------------------------------------------------------

export async function mountCountdown(root) {
  await boot();
  const kind = params.get('kind');
  const force = params.get('force') === '1';
  const verb = { shutdown: 'shut down', restart: 'restart', sleep: 'go to sleep', hibernate: 'hibernate' }[kind] || kind;
  let n = 30;
  const num = h('b', {}, String(n));
  const timer = setInterval(() => {
    n--;
    num.textContent = String(n);
    if (n <= 0) {
      clearInterval(timer);
      api.invoke('power:run', kind, force).then(close);
    }
  }, 1000);
  root.append(h('div', { class: 'modal-body' }, h('div', { class: 'row' }, icon('power'), h('b', {}, `The computer will ${verb} in `, num, ' seconds.')), h('div', { class: 'muted' }, params.get('reason') || '')),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => { clearInterval(timer); api.invoke('power:run', kind, force).then(close); } }, 'Do it now'), h('button', { class: 'btn primary', onclick: () => { clearInterval(timer); api.invoke('power:cancel'); close(); } }, 'Cancel')));
  root.style.minHeight = '100%';
}

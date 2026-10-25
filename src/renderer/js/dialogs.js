import { api, h, icon, bytes, date, modal, confirmDialog, promptDialog, field, check, select, folderInput, toast, statusText } from './common.js';

let S;
export function init(state) {
  S = state;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- Add URL / batch ---------------------------------------------------------------------------

export async function addUrlDialog(prefill) {
  let url = prefill || '';
  if (!url) {
    const clip = await api.invoke('clip:urls');
    if (clip.length === 1) url = clip[0];
  }
  const inp = h('input', { type: 'url', value: url, placeholder: 'https://example.com/file.zip', class: 'grow' });
  const user = h('input', { type: 'text', disabled: true, autocomplete: 'off' });
  const pass = h('input', { type: 'password', disabled: true, autocomplete: 'off' });
  const auth = check('Use authorization', false, (v) => {
    user.disabled = !v;
    pass.disabled = !v;
  });
  const err = h('div', { class: 'status-err hidden', role: 'alert' });
  // A local .torrent file goes in as a file:/// address (drive letter kept, the rest encoded).
  const openTorrent = h('button', { class: 'btn', onclick: async () => {
    const f = await api.invoke('dialog:file', '', 'torrent');
    if (f) inp.value = 'file:///' + f.replace(/\\/g, '/').split('/').map((x, i) => (i === 0 && /^[a-z]:$/i.test(x) ? x : encodeURIComponent(x))).join('/');
  } }, 'Open .torrent file…');
  modal({
    title: 'Enter new address to download',
    body: h('div', { class: 'col' }, field('Address', h('div', { class: 'row' }, inp, openTorrent)), auth, field('Login', user), field('Password', pass), err),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true,
        onClick: () => {
          const v = inp.value.trim();
          if (!/^((https?|ftp):\/\/\S+|magnet:\?\S+|file:\/\/\/\S+\.torrent)$/i.test(v)) {
            err.textContent = 'Enter a full address that starts with http://, https://, ftp:// or magnet:, or open a .torrent file';
            err.classList.remove('hidden');
            inp.focus();
            return false;
          }
          const payload = { url: v, source: 'manual' };
          if (!user.disabled && user.value) payload.auth = { user: user.value, pass: pass.value };
          api.invoke('win:open', 'newdl', {}, { key: 'newdl:' + Date.now(), payload, width: 620, height: 430, title: 'Download File Info', alwaysOnTop: true });
        },
      },
    ],
  });
}

export function batchDialog() {
  const pattern = h('input', { type: 'url', placeholder: 'https://example.com/photos/img*.jpg', class: 'grow' });
  const kind = h('select', {}, h('option', { value: 'num' }, 'Numbers'), h('option', { value: 'let' }, 'Letters'));
  const from = h('input', { type: 'text', value: '1', style: { width: '70px' } });
  const to = h('input', { type: 'text', value: '10', style: { width: '70px' } });
  const width = h('input', { type: 'number', value: '0', min: '0', max: '10', style: { width: '60px' } });
  const user = h('input', { type: 'text' });
  const pass = h('input', { type: 'password' });
  const preview = h('div', { class: 'listbox mono', style: { height: '150px', userSelect: 'text' } });
  let urls = [];
  const update = async () => {
    preview.replaceChildren();
    urls = [];
    if (!pattern.value.includes('*')) {
      preview.append(h('div', { class: 'li muted' }, 'Put a * where the number or letter changes.'));
      return;
    }
    try {
      urls = await api.invoke('util:batch', pattern.value.trim(), from.value, to.value, Number(width.value) || 0);
      preview.append(...urls.slice(0, 200).map((u) => h('div', { class: 'li' }, u)));
      if (urls.length > 200) preview.append(h('div', { class: 'li muted' }, `… and ${urls.length - 200} more`));
    } catch (e) {
      preview.append(h('div', { class: 'li status-err' }, e.message));
    }
  };
  kind.onchange = () => {
    from.value = kind.value === 'num' ? '1' : 'a';
    to.value = kind.value === 'num' ? '10' : 'z';
    width.disabled = kind.value !== 'num';
    update();
  };
  for (const el of [pattern, from, to, width]) el.addEventListener('input', update);
  update();
  modal({
    title: 'Add batch download',
    body: h('div', { class: 'col' },
      field('Address', pattern, 'Example: https://site.com/pics/pic*.jpg — the * is replaced by each value.'),
      h('div', { class: 'row' }, h('span', { style: { width: '130px', color: 'var(--text-2)' } }, 'Replace * with'), kind, 'from', from, 'to', to, 'wildcard size', width),
      h('div', { class: 'row' }, h('span', { style: { width: '130px', color: 'var(--text-2)' } }, 'Login (optional)'), user, pass),
      h('div', { class: 'hint' }, 'Preview'), preview),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true,
        onClick: () => {
          if (!urls.length) return false;
          const auth = user.value ? { user: user.value, pass: pass.value } : null;
          api.invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), auth, title: 'Batch download', noProbe: urls.length > 300 } });
        },
      },
    ],
  });
}

// ---- Properties --------------------------------------------------------------------------------

export async function propertiesDialog(id) {
  const it = await api.invoke('dl:item', id);
  if (!it) return;
  const d = { fileName: it.fileName, saveDir: it.saveDir, url: it.url, referer: it.referer, description: it.description, category: it.category, maxConnections: it.maxConnections || 0, speedLimitKB: it.speedLimitKB || 0, user: it.auth?.user || '', pass: it.auth?.pass || '' };
  const inp = (k, type = 'text') => h('input', { type, value: d[k], class: 'grow', oninput: (e) => (d[k] = type === 'number' ? Number(e.target.value) : e.target.value) });
  const body = h('div', { class: 'col' },
    h('div', { class: 'row' }, h('div', { style: { transform: 'scale(1.5)', margin: '0 8px 0 4px' } }, (await import('./common.js')).fileBadge(it.fileName)), h('div', { class: 'col', style: { gap: '2px' } }, h('b', {}, it.fileName), h('span', { class: 'muted' }, `${statusText(it)} · ${bytes(it.size) || 'size unknown'} · ${it.resumable === false ? 'no resume support' : it.resumable ? 'resumable' : ''}`))),
    field('File name', inp('fileName')),
    field('Save to', folderInput(d.saveDir, (v) => (d.saveDir = v))),
    field('Category', select(S.categories.map((c) => [c.id, c.name]), d.category, (v) => (d.category = v))),
    field('Address', inp('url'), it.status !== 'complete' ? 'Change it to refresh an expired link; progress is kept if the file is the same.' : null),
    field('Referer', inp('referer')),
    field('Description', inp('description')),
    field('Login', h('div', { class: 'row' }, inp('user'), h('input', { type: 'password', value: d.pass, class: 'grow', placeholder: 'Password', oninput: (e) => (d.pass = e.target.value) }))),
    field('Connections', h('div', { class: 'row' }, inp('maxConnections', 'number'), h('span', { class: 'hint' }, '0 = use the default from Options'))),
    field('Speed limit', h('div', { class: 'row' }, inp('speedLimitKB', 'number'), h('span', { class: 'hint' }, 'KB/s, 0 = unlimited'))),
    h('div', { class: 'kv hint' }, h('div', {}, 'Added'), h('div', {}, date(it.added)), h('div', {}, 'Last try'), h('div', {}, date(it.lastTry)), it.savedPath ? [h('div', {}, 'Saved as'), h('div', { class: 'mono', title: it.savedPath }, it.savedPath)] : null));
  modal({
    title: 'File properties',
    body,
    leftButtons: [
      { label: 'Open', onClick: () => (api.invoke('dl:open', id), false) },
      { label: 'Open folder', onClick: () => (api.invoke('dl:openFolder', id), false) },
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true,
        onClick: async () => {
          const patch = {};
          for (const k of ['fileName', 'saveDir', 'url', 'referer', 'description', 'category', 'maxConnections', 'speedLimitKB']) if (d[k] !== (it[k] ?? (typeof d[k] === 'number' ? 0 : ''))) patch[k] = d[k];
          if (d.user !== (it.auth?.user || '') || d.pass !== (it.auth?.pass || '')) patch.auth = d.user ? { user: d.user, pass: d.pass } : null;
          if (Object.keys(patch).length) {
            try {
              await api.invoke('dl:update', id, patch);
            } catch (e) {
              toast(e.message);
              return false;
            }
          }
        },
      },
    ],
  });
}

// ---- Options -----------------------------------------------------------------------------------

export function optionsDialog(initial = 'general') {
  const s = clone(S.settings);
  let cats = clone(S.categories);
  let catsDirty = false;

  const g = s.general, ft = s.fileTypes, c = s.connection, dl = s.downloads, px = s.proxy, st = s.saveTo, vp = s.videoPanel, snd = s.sounds, ap = s.appearance, bt = s.torrent;
  const num = (obj, k, attrs = {}) => h('input', { type: 'number', value: obj[k], ...attrs, oninput: (e) => (obj[k] = Number(e.target.value)) });
  const txt = (obj, k, attrs = {}) => h('input', { type: 'text', value: obj[k] ?? '', class: 'grow', ...attrs, oninput: (e) => (obj[k] = e.target.value) });
  const area = (obj, k, rows = 3) => h('textarea', { rows, class: 'grow', oninput: (e) => (obj[k] = e.target.value) }, obj[k] || '');

  const panes = {
    general: ['General', 'gear', () => h('div', { class: 'col' },
      h('fieldset', {}, h('legend', {}, 'System integration'),
        h('div', { class: 'col' },
          check('Launch OpenDM when I sign in', g.launchOnStartup, (v) => (g.launchOnStartup = v)),
          check('Keep running in the notification area when the window is closed', g.minimizeToTray, (v) => (g.minimizeToTray = v)),
          check('Automatically start downloading URLs copied to the clipboard', g.monitorClipboard, (v) => (g.monitorClipboard = v)))),
      h('fieldset', {}, h('legend', {}, 'Browser integration'),
        h('div', { class: 'col' },
          check('Take over downloads from browsers (requires the OpenDM extension)', g.browserIntegration, (v) => (g.browserIntegration = v)),
          field('Local port', num(g, 'integrationPort', { min: 1024, max: 65535 }), 'The extension talks to the app on 127.0.0.1 at this port.'),
          field('Force download key', select([['Insert', 'Insert'], ['Shift', 'Shift'], ['Ctrl', 'Ctrl'], ['', 'None']], g.forceKey, (v) => (g.forceKey = v)), 'Hold while clicking a link to always download it with OpenDM.'),
          field('Bypass key', select([['Alt', 'Alt'], ['Shift', 'Shift'], ['Ctrl', 'Ctrl'], ['', 'None']], g.preventKey, (v) => (g.preventKey = v)), 'Hold while clicking a link to let the browser download it.'),
          h('div', { class: 'hint' }, 'Browser context menu items:'),
          h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px 16px' } },
            check('Download with OpenDM', g.contextMenu.downloadLink, (v) => (g.contextMenu.downloadLink = v)),
            check('Download all links', g.contextMenu.downloadAll, (v) => (g.contextMenu.downloadAll = v)),
            check('Download selected links', g.contextMenu.downloadSelected, (v) => (g.contextMenu.downloadSelected = v))),
          h('div', {}, h('button', { class: 'btn small', onclick: () => helpDialog('extension') }, 'How to install the browser extension…')))))],
    filetypes: ['File types', 'file', () => h('div', { class: 'col' },
      h('label', {}, 'Automatically start downloading the following file types:'), area(ft, 'capture', 5),
      h('label', {}, "Don't start downloading automatically from these sites (separate names by spaces, * allowed):"), area(ft, 'excludedSites', 3),
      h('label', {}, "Don't start downloading automatically from these addresses (one per line, * allowed):"),
      h('textarea', { rows: 4, class: 'grow mono', oninput: (e) => (ft.excludedAddresses = e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) }, ft.excludedAddresses.join('\n')))],
    connection: ['Connection', 'link', () => {
      const exBox = h('div', { class: 'listbox', style: { height: '110px' } });
      const renderEx = () => exBox.replaceChildren(...(c.serverExceptions.length ? c.serverExceptions.map((x, i) => h('div', { class: 'li' }, h('span', { class: 'grow mono' }, x.server), h('span', {}, `${x.maxConnections} conn.`), h('button', { class: 'btn small', onclick: () => { c.serverExceptions.splice(i, 1); renderEx(); } }, 'Delete'))) : [h('div', { class: 'li muted' }, 'No exceptions')]));
      renderEx();
      const srv = h('input', { type: 'text', placeholder: '*.example.com' });
      const n = h('input', { type: 'number', value: 1, min: 1, max: 32 });
      return h('div', { class: 'col' },
        h('fieldset', {}, h('legend', {}, 'Connections'), h('div', { class: 'col' },
          field('Default max. connections', select([1, 2, 4, 6, 8, 12, 16, 24, 32].map((v) => [v, String(v)]), c.maxConnections, (v) => (c.maxConnections = Number(v))), 'More connections can be faster but some servers limit them.'),
          field('Timeout', h('div', { class: 'row' }, num(c, 'timeoutSec', { min: 5, max: 600 }), 'seconds')),
          field('Retries per connection', h('div', { class: 'row' }, num(c, 'connectionRetries', { min: 0, max: 1000 }), h('span', { class: 'hint' }, '0 = keep retrying'))),
          field('Min. segment size', h('div', { class: 'row' }, num(c, 'minSegmentKB', { min: 64, max: 65536 }), 'KB')))),
        h('fieldset', {}, h('legend', {}, 'Max. connections for specific servers'), h('div', { class: 'col' }, exBox,
          h('div', { class: 'row' }, srv, n, h('button', { class: 'btn small', onclick: () => { if (srv.value.trim()) { c.serverExceptions.push({ server: srv.value.trim(), maxConnections: Number(n.value) || 1 }); srv.value = ''; renderEx(); } } }, 'Add')))),
        h('fieldset', {}, h('legend', {}, 'Download limits'), h('div', { class: 'col' },
          check('Limit how much is downloaded in a period', c.quota.enabled, (v) => (c.quota.enabled = v)),
          h('div', { class: 'row' }, 'Download no more than', num(c.quota, 'mb', { min: 1 }), 'MB every', num(c.quota, 'hours', { min: 1, max: 720 }), 'hours'),
          check('Show a notification when downloads are paused by the limit', c.quota.warn, (v) => (c.quota.warn = v)))));
    }],
    saveto: ['Save to', 'folder', () => {
      const list = h('div', { class: 'col' });
      const renderCats = () => list.replaceChildren(...cats.map((cat) => field(cat.name, folderInput(cat.folder, (v) => { cat.folder = v; catsDirty = true; }))));
      renderCats();
      return h('div', { class: 'col' },
        h('fieldset', {}, h('legend', {}, 'Default folder for each category'), list),
        check('Remember the last folder chosen for each category', st.rememberLastPath, (v) => (st.rememberLastPath = v)),
        field('Temporary folder', folderInput(st.tempDir, (v) => (st.tempDir = v)), 'Unfinished downloads are kept here and moved when complete.'));
    }],
    downloads: ['Downloads', 'down', () => h('div', { class: 'col' },
      h('fieldset', {}, h('legend', {}, 'Dialogs'), h('div', { class: 'col' },
        check('Show the "Download File Info" dialog before starting', dl.showStartDialog, (v) => (dl.showStartDialog = v)),
        check("Don't start downloading — only add files to the list", dl.addOnlyNoStart, (v) => (dl.addOnlyNoStart = v)),
        check('Show the "Download complete" dialog', dl.showCompleteDialog, (v) => (dl.showCompleteDialog = v)),
        field('Progress window', select([['show', 'Show'], ['minimized', 'Show minimized'], ['none', "Don't show"]], dl.progressDialog, (v) => (dl.progressDialog = v))),
        check('Show queue choice when clicking "Download later"', dl.showQueuePanelOnLater, (v) => (dl.showQueuePanelOnLater = v)))),
      h('fieldset', {}, h('legend', {}, 'Behavior'), h('div', { class: 'col' },
        field('If the same address is added again', select([['ask', 'Ask me'], ['number', 'Add it with a numbered file name'], ['overwrite', 'Replace the existing download'], ['resume', 'Use the existing download']], dl.duplicateAction, (v) => (dl.duplicateAction = v))),
        field('If the file already exists', select([['rename', 'Save with a numbered name'], ['overwrite', 'Overwrite it']], dl.existingFileAction, (v) => (dl.existingFileAction = v))),
        field('Downloads at the same time', h('div', { class: 'row' }, num(dl, 'maxSimultaneous', { min: 0, max: 64 }), h('span', { class: 'hint' }, 'Others wait for a free slot. 0 = no limit.'))),
        check('Ignore file modification changes on the server when resuming', dl.ignoreModTimeChanges, (v) => (dl.ignoreModTimeChanges = v)),
        field('User-Agent for manual downloads', txt(dl, 'userAgent', { placeholder: 'Default (current Chrome)' })))))],
    proxy: ['Proxy / Socks', 'globe', () => {
      const manual = h('div', { class: 'col' });
      const proto = (k, label) => {
        const p = px[k];
        return h('div', { class: 'row' }, h('label', { class: 'check', style: { width: '110px' } }, h('input', { type: 'checkbox', checked: p.enabled, onchange: (e) => (p.enabled = e.target.checked) }), label),
          txt(p, 'host', { placeholder: 'Address' }), num(p, 'port', { min: 1, max: 65535, style: { width: '76px' } }), h('input', { type: 'text', value: p.user, placeholder: 'User', style: { width: '100px' }, oninput: (e) => (p.user = e.target.value) }), h('input', { type: 'password', value: p.pass, placeholder: 'Password', style: { width: '100px' }, oninput: (e) => (p.pass = e.target.value) }));
      };
      manual.append(proto('http', 'HTTP'), proto('https', 'HTTPS'), proto('ftp', 'FTP'), proto('socks', 'SOCKS'),
        h('div', { class: 'row' }, h('span', { style: { width: '110px' } }), 'SOCKS version', select([[5, 'SOCKS 5'], [4, 'SOCKS 4']], px.socks.version, (v) => (px.socks.version = Number(v)))));
      const setMode = (m) => {
        px.mode = m;
        manual.style.opacity = m === 'manual' ? '1' : '.45';
        manual.style.pointerEvents = m === 'manual' ? '' : 'none';
      };
      setMode(px.mode);
      const radio = (v, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pxmode', checked: px.mode === v, onchange: () => setMode(v) }), label);
      return h('div', { class: 'col' },
        radio('none', 'No proxy'), radio('system', 'Use system proxy settings'),
        h('div', { class: 'row' }, radio('pac', 'Use automatic configuration script'), txt(px, 'pacUrl', { placeholder: 'http://wpad/wpad.dat' })),
        radio('manual', 'Manual proxy configuration'), manual,
        field('No proxy for', txt(px, 'bypass'), 'Separate with spaces. <local> = names without dots.'),
        check('Use FTP in passive mode', px.ftpPassive, (v) => (px.ftpPassive = v)));
    }],
    logins: ['Site logins', 'key', () => {
      const box = h('div', { class: 'listbox', style: { height: '180px' } });
      const renderL = () => box.replaceChildren(...(s.siteLogins.length ? s.siteLogins.map((l, i) => h('div', { class: 'li' }, h('span', { class: 'grow mono' }, l.server), h('span', {}, l.user), h('button', { class: 'btn small', onclick: () => { s.siteLogins.splice(i, 1); renderL(); } }, 'Delete'))) : [h('div', { class: 'li muted' }, 'No saved logins')]));
      renderL();
      const sv = h('input', { type: 'text', placeholder: 'ftp.example.com/private', class: 'grow' });
      const us = h('input', { type: 'text', placeholder: 'User' });
      const pw = h('input', { type: 'password', placeholder: 'Password' });
      return h('div', { class: 'col' }, h('div', { class: 'hint' }, 'Logins used automatically for matching servers. Add a path only when different folders need different logins. * is allowed.'), box,
        h('div', { class: 'row' }, sv, us, pw, h('button', { class: 'btn small', onclick: () => { if (sv.value.trim() && us.value) { s.siteLogins.push({ server: sv.value.trim(), user: us.value, pass: pw.value }); sv.value = us.value = pw.value = ''; renderL(); } } }, 'Add')));
    }],
    video: ['Video panel', 'video', () => h('div', { class: 'col' },
      h('div', { class: 'hint' }, 'The browser extension can show a "Download this video" panel when a web player loads media.'),
      check('Show the download panel on web players', vp.enabled, (v) => (vp.enabled = v)),
      field('Panel style', select([['full', 'Full'], ['mini', 'Mini (icon only)']], vp.mode, (v) => (vp.mode = v))),
      field('Media types', txt(vp, 'types')),
      field('Minimum size', h('div', { class: 'row' }, num(vp, 'minSizeKB', { min: 0 }), 'KB')),
      field("Don't show on these sites", txt(vp, 'excludedSites', { placeholder: 'example.com *.example.org' })),
      check("Don't take over media requests from web players automatically", vp.dontCaptureFromPlayers, (v) => (vp.dontCaptureFromPlayers = v)),
      (() => {
        const status = h('div', { class: 'hint' }, 'Checking…');
        api.invoke('util:ffmpeg').then((p) => (status.textContent = p ? `Using: ${p}` : 'Not found — YouTube video and audio will be saved as separate files.'));
        return field('FFmpeg', h('div', { class: 'col', style: { gap: '4px' } },
          h('div', { class: 'row' }, txt(vp, 'ffmpegPath', { placeholder: 'Built-in / found on PATH' }), h('button', { class: 'btn', onclick: async (e) => { const f = await api.invoke('dialog:file'); if (f) { vp.ffmpegPath = f; e.target.previousSibling.value = f; } } }, 'Browse…')),
          status), 'Used to merge separate video and audio streams (YouTube and other DASH sites).');
      })(),
      (() => {
        const status = h('span', { class: 'hint' }, 'Checking…');
        const refresh = () => api.invoke('util:ytdlp').then((p) => (status.textContent = p ? `Using: ${p}` : 'Not installed'));
        refresh();
        const btn = h('button', { class: 'btn', onclick: async () => { btn.disabled = true; status.textContent = 'Downloading the latest yt-dlp…'; try { await api.invoke('util:ytdlpInstall'); } catch (e) { toast(e.message); } btn.disabled = false; refresh(); } }, 'Download / update yt-dlp');
        return field('yt-dlp', h('div', { class: 'col', style: { gap: '4px' } },
          h('div', { class: 'row' }, txt(vp, 'ytdlpPath', { placeholder: 'Installed by OpenDM / found on PATH' }), btn),
          status), 'Downloads video pages such as YouTube. Keep it updated when a site stops working.');
      })())],
    torrent: ['BitTorrent', 'down', () => h('div', { class: 'col' },
      h('div', { class: 'hint' }, 'Used for magnet links and .torrent addresses. Changes apply the next time OpenDM starts.'),
      h('fieldset', {}, h('legend', {}, 'Network'), h('div', { class: 'col' },
        check('Find peers with DHT', bt.enableDht, (v) => (bt.enableDht = v)),
        check('Find peers on the local network (LSD)', bt.enableLsd, (v) => (bt.enableLsd = v)),
        check('Find peers through other peers (PEX)', bt.enablePex, (v) => (bt.enablePex = v)),
        check('Use uTP as well as TCP', bt.enableUtp, (v) => (bt.enableUtp = v)),
        check('Forward the listening port on the router (UPnP)', bt.enablePortForwarding, (v) => (bt.enablePortForwarding = v)),
        field('Encryption', select([['prefer', 'Prefer encrypted connections'], ['require', 'Require encryption'], ['disable', 'Never encrypt']], bt.encryption, (v) => (bt.encryption = v)), 'Encryption hides BitTorrent traffic from ISP throttling. Requiring it finds fewer peers.'),
        field('Listening port', h('div', { class: 'row' }, num(bt, 'listenPort', { min: 0, max: 65535 }), h('span', { class: 'hint' }, '0 = pick a free port'))))),
      h('fieldset', {}, h('legend', {}, 'Seeding'),
        field('Keep sharing until uploaded', h('div', { class: 'row' }, num(bt, 'seedRatio', { min: 0, step: 0.1 }), h('span', { class: 'hint' }, '× the size. 0 = stop when the download is complete.')))),
      h('label', {}, 'Extra trackers added to every torrent (one per line):'), area(bt, 'trackers', 4),
      field('Also load trackers from', txt(bt, 'trackersUrl', { placeholder: 'https://… a list with one tracker per line' }), 'Read when OpenDM starts. Not used for private torrents.'))],
    sounds: ['Sounds', 'info', () => h('div', { class: 'col' },
      check('Play a sound when a download completes', snd.complete, (v) => (snd.complete = v)),
      check('Play a sound when a download fails', snd.failed, (v) => (snd.failed = v)),
      check('Play a sound when a queue finishes', snd.queueDone, (v) => (snd.queueDone = v)),
      field('Volume', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: snd.volume, oninput: (e) => (snd.volume = Number(e.target.value)) })))],
    appearance: ['Appearance', 'layers', () => h('div', { class: 'col' },
      field('Theme', select([['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], ap.theme, (v) => (ap.theme = v))),
      field('Font size', h('div', { class: 'row' }, num(ap, 'fontSize', { min: 10, max: 20 }), 'px')),
      field('Toolbar', select([['large', 'Large buttons'], ['small', 'Small buttons'], ['icons', 'Icons only']], ap.toolbar, (v) => (ap.toolbar = v))),
      check('Show categories and queues panel', ap.showCategories, (v) => (ap.showCategories = v)))],
  };
  const nav = h('div', { class: 'vtabs', role: 'tablist' });
  const pane = h('div', { class: 'pane' });
  const show = (id) => {
    for (const b of nav.children) b.classList.toggle('active', b.dataset.id === id);
    pane.replaceChildren(panes[id][2]());
  };
  for (const [id, [label, ic]] of Object.entries(panes)) nav.append(h('button', { class: 'tab', 'data-id': id, onclick: () => show(id) }, icon(ic), label));
  show(panes[initial] ? initial : 'general');
  modal({
    title: 'Options', wide: true, body: h('div', { class: 'split' }, nav, pane),
    leftButtons: [{ label: 'Reset all…', onClick: async () => { if (await confirmDialog('Reset every option to its default value?', { okLabel: 'Reset', danger: true })) await api.invoke('settings:reset'); } }],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true,
        onClick: async () => {
          await api.invoke('settings:save', s);
          for (const [sec, key] of [['fileTypes', 'excludedAddresses'], ['connection', 'serverExceptions'], ['appearance', 'columns']]) await api.invoke('settings:replaceList', sec, key, s[sec][key]);

          if (catsDirty) await api.invoke('cats:save', cats);
        },
      },
    ],
  });
}

export function limiterDialog() {
  const s = clone(S.settings.speedLimiter);
  modal({
    title: 'Speed limiter',
    body: h('div', { class: 'col' },
      check('Limit the total download speed', s.enabled, (v) => (s.enabled = v)),
      field('Maximum speed', h('div', { class: 'row' }, h('input', { type: 'number', min: 1, value: s.kbps, oninput: (e) => (s.kbps = Number(e.target.value)) }), 'KB/s'))),
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => api.invoke('settings:save', { speedLimiter: s }) }],
  });
}

// ---- categories --------------------------------------------------------------------------------

export function categoryDialog(cat) {
  const c = cat ? clone(cat) : { id: null, name: '', exts: '', folder: '' };
  modal({
    title: cat ? 'Edit category' : 'Add category',
    body: h('div', { class: 'col' },
      field('Name', h('input', { type: 'text', value: c.name, oninput: (e) => (c.name = e.target.value) })),
      field('File types', h('input', { type: 'text', value: c.exts, placeholder: 'mp4 mkv webm', disabled: c.id === 'general', oninput: (e) => (c.exts = e.target.value) }), 'Extensions separated by spaces; * is allowed.'),
      field('Save to', folderInput(c.folder, (v) => (c.folder = v)))),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'OK', primary: true,
        onClick: async () => {
          if (!c.name.trim()) return false;
          const list = clone(S.categories);
          if (cat) list[list.findIndex((x) => x.id === cat.id)] = c;
          else list.push({ ...c, builtin: false, folder: c.folder || S.categories[0].folder });
          await api.invoke('cats:save', list);
        },
      },
    ],
  });
}

export async function deleteCategory(cat) {
  if (!(await confirmDialog(`Delete category "${cat.name}"?`, { okLabel: 'Delete', danger: true, detail: 'Downloads in it stay in the list.' }))) return;
  api.invoke('cats:save', S.categories.filter((x) => x.id !== cat.id));
}

// ---- columns -----------------------------------------------------------------------------------

export function columnsDialog(COLUMNS) {
  let cols = [...S.settings.appearance.columns];
  const all = [...cols, ...Object.keys(COLUMNS).filter((k) => !cols.includes(k))];
  let order = all;
  let sel = null;
  const box = h('div', { class: 'listbox', style: { height: '280px' } });
  const paint = () => box.replaceChildren(...order.map((k) => h('div', { class: 'li' + (sel === k ? ' sel' : ''), onclick: () => { sel = k; paint(); } },
    h('input', { type: 'checkbox', checked: cols.includes(k), disabled: k === 'name', onchange: (e) => { cols = e.target.checked ? [...cols, k] : cols.filter((x) => x !== k); } }), COLUMNS[k].label)));
  const mv = (d) => {
    if (!sel) return;
    const i = order.indexOf(sel), j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    paint();
  };
  paint();
  modal({
    title: 'Customize columns',
    body: h('div', { class: 'row', style: { alignItems: 'stretch' } }, h('div', { class: 'grow' }, box), h('div', { class: 'col' }, h('button', { class: 'btn', onclick: () => mv(-1) }, icon('up'), 'Move up'), h('button', { class: 'btn', onclick: () => mv(1) }, icon('downArrow'), 'Move down'))),
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => api.invoke('settings:replaceList', 'appearance', 'columns', order.filter((k) => cols.includes(k))) }],
  });
}

// ---- find --------------------------------------------------------------------------------------

export function findDialog(q, apply) {
  const o = { ...S.findOpts };
  const inp = h('input', { type: 'text', value: q, class: 'grow' });
  modal({
    title: 'Find file',
    body: h('div', { class: 'col' }, field('Find', inp),
      h('fieldset', {}, h('legend', {}, 'Look in'), h('div', { class: 'col' },
        check('File name', o.name, (v) => (o.name = v)), check('Description', o.description, (v) => (o.description = v)), check('Address, referer and parent page', o.address, (v) => (o.address = v)))),
      check('Match case', o.matchCase, (v) => (o.matchCase = v)), check('Match whole string only', o.whole, (v) => (o.whole = v))),
    buttons: [{ label: 'Cancel' }, { label: 'Find', primary: true, onClick: () => apply(inp.value, o) }],
  });
}

// ---- scheduler ---------------------------------------------------------------------------------

export async function newQueue() {
  const name = await promptDialog('Create new queue', 'Queue name:', 'Queue ' + (S.queues.length + 1));
  if (!name) return;
  const q = await api.invoke('q:create', name, 'download');
  schedulerDialog(q.id);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function schedulerDialog(queueId) {
  let current = queueId || S.queues[0]?.id;
  let draft = null;
  let tab = 'schedule';
  let selItems = new Set();
  const qlist = h('div', { class: 'listbox', style: { flex: 1 } });
  const right = h('div', { class: 'col', style: { flex: 1, minWidth: 0, minHeight: 0 } });
  const startBtn = h('button', { class: 'btn', onclick: () => api.invoke('q:start', current) }, icon('play'), 'Start now');
  const stopBtn = h('button', { class: 'btn', onclick: () => api.invoke('q:stop', current) }, icon('stop'), 'Stop');

  const load = () => {
    const q = S.queues.find((x) => x.id === current) || S.queues[0];
    current = q.id;
    draft = clone(q);
  };
  const apply = () => api.invoke('q:update', current, { name: draft.name, maxConcurrent: draft.maxConcurrent, retries: draft.retries, schedule: draft.schedule, onComplete: draft.onComplete, type: draft.type });

  const paintList = () => qlist.replaceChildren(...S.queues.map((q) => h('div', {
    class: 'li' + (q.id === current ? ' sel' : ''),
    onclick: async () => {
      await apply();
      current = q.id;
      load();
      selItems.clear();
      paint();
    },
    ondragover: (e) => e.dataTransfer.types.includes('application/x-opendm-qitems') && e.preventDefault(),
    ondrop: (e) => {
      const ids = JSON.parse(e.dataTransfer.getData('application/x-opendm-qitems'));
      api.invoke('q:addItems', q.id, ids).then(() => api.invoke('q:removeItems', current, ids));
    },
  }, icon(q.type === 'sync' ? 'sync' : 'list'), h('span', { class: 'grow ellipsis' }, q.name), q.running ? h('span', { class: 'status-run' }, 'running') : null)));

  const schedulePane = () => {
    const s = draft.schedule;
    const oc = draft.onComplete;
    const dayBoxes = h('div', { class: 'row', style: { flexWrap: 'wrap' } }, DAYS.map((d, i) => check(d, s.days.includes(i), (v) => (s.days = v ? [...new Set([...s.days, i])] : s.days.filter((x) => x !== i)))));
    const onceDate = h('input', { type: 'date', value: s.onceDate || new Date().toISOString().slice(0, 10), oninput: (e) => (s.onceDate = e.target.value) });
    const modeSel = select([['daily', 'Daily on'], ['once', 'Once on']], s.mode, (v) => { s.mode = v; dayBoxes.classList.toggle('hidden', v !== 'daily'); onceDate.classList.toggle('hidden', v !== 'once'); if (v === 'once' && !s.onceDate) s.onceDate = onceDate.value; });
    dayBoxes.classList.toggle('hidden', s.mode !== 'daily');
    onceDate.classList.toggle('hidden', s.mode !== 'once');
    return h('div', { class: 'col' },
      field('Queue name', h('input', { type: 'text', value: draft.name, oninput: (e) => (draft.name = e.target.value) })),
      !draft.builtin ? field('Queue type', select([['download', 'One-time downloading'], ['sync', 'Periodic synchronization']], draft.type, (v) => { draft.type = v; s.periodic = v === 'sync'; paint(); })) : h('div', { class: 'hint' }, draft.type === 'sync' ? 'Periodic synchronization: files are re-checked and re-downloaded when they change on the server.' : 'One-time downloading: files leave the queue when finished.'),
      h('fieldset', {}, h('legend', {}, 'Start'), h('div', { class: 'col' },
        h('div', { class: 'row' }, check('Start download at', s.startEnabled, (v) => (s.startEnabled = v)), h('input', { type: 'time', value: s.startTime, oninput: (e) => (s.startTime = e.target.value) })),
        h('div', { class: 'row' }, modeSel, dayBoxes, onceDate),
        draft.type === 'sync' ? h('div', { class: 'row' }, check('Repeat every', s.periodic, (v) => (s.periodic = v)), h('input', { type: 'number', min: 1, value: s.everyMinutes, oninput: (e) => (s.everyMinutes = Number(e.target.value)) }), 'minutes') : null)),
      h('fieldset', {}, h('legend', {}, 'Stop'), h('div', { class: 'row' }, check('Stop download at', s.stopEnabled, (v) => (s.stopEnabled = v)), h('input', { type: 'time', value: s.stopTime, oninput: (e) => (s.stopTime = e.target.value) }))),
      h('fieldset', {}, h('legend', {}, 'Retries and parallel downloads'), h('div', { class: 'col' },
        h('div', { class: 'row' }, 'Download', h('input', { type: 'number', min: 1, max: 32, value: draft.maxConcurrent, oninput: (e) => (draft.maxConcurrent = Number(e.target.value)) }), 'files at the same time'),
        h('div', { class: 'row' }, check('Number of retries for each file if downloading failed', draft.retries > 0, (v) => (draft.retries = v ? Math.max(1, draft.retries || 10) : 0)), h('input', { type: 'number', min: 1, value: draft.retries || 10, oninput: (e) => (draft.retries = Number(e.target.value)) })))),
      h('fieldset', {}, h('legend', {}, 'When the queue finishes'), h('div', { class: 'col' },
        h('div', { class: 'row' }, check('Open this file', !!oc.runFile, (v) => !v && (oc.runFile = '')), h('input', { type: 'text', class: 'grow', value: oc.runFile, oninput: (e) => (oc.runFile = e.target.value) }), h('button', { class: 'btn small', onclick: async (e) => { const f = await api.invoke('dialog:file'); if (f) { oc.runFile = f; e.target.previousSibling.value = f; } } }, 'Browse…')),
        check('Exit OpenDM', oc.exitApp, (v) => (oc.exitApp = v)),
        h('div', { class: 'row' }, 'Then', select([['none', 'do nothing'], ['shutdown', 'shut down'], ['restart', 'restart'], ['sleep', 'sleep'], ['hibernate', 'hibernate']], oc.power, (v) => (oc.power = v)), 'the computer'),
        check('Force programs to close (may lose unsaved work)', oc.forceTerminate, (v) => (oc.forceTerminate = v)),
        h('div', { class: 'hint' }, 'These actions do not run when you stop the queue yourself.'))));
  };

  const filesPane = () => {
    const q = S.queues.find((x) => x.id === current);
    const box = h('div', { class: 'listbox', style: { flex: 1, minHeight: '200px' } });
    const paintBox = () => box.replaceChildren(...(q.items.length ? q.items.map((id) => {
      const it = S.items.get(id);
      if (!it) return null;
      const li = h('div', {
        class: 'li' + (selItems.has(id) ? ' sel' : ''), draggable: 'true',
        onclick: (e) => { if (!e.ctrlKey) selItems.clear(); selItems.has(id) ? selItems.delete(id) : selItems.add(id); paintBox(); },
        ondragstart: (e) => { if (!selItems.has(id)) { selItems = new Set([id]); } e.dataTransfer.setData('application/x-opendm-qitems', JSON.stringify([...selItems])); },
      }, h('span', { class: 'grow ellipsis' }, it.fileName), h('span', { class: 'muted' }, bytes(it.size)), h('span', { style: { width: '120px', textAlign: 'right' } }, statusText(it)));
      return li;
    }) : [h('div', { class: 'li muted' }, 'No files. Right-click downloads in the main list and choose "Add to queue", or drag them onto a queue.')]));
    paintBox();
    const mv = (dir) => selItems.size && api.invoke('q:move', current, [...selItems], dir);
    return h('div', { class: 'col', style: { flex: 1, minHeight: 0 } }, box, h('div', { class: 'row' },
      h('button', { class: 'btn small', title: 'Move to top', onclick: () => mv('top') }, icon('top')),
      h('button', { class: 'btn small', title: 'Move up', onclick: () => mv('up') }, icon('up')),
      h('button', { class: 'btn small', title: 'Move down', onclick: () => mv('down') }, icon('downArrow')),
      h('button', { class: 'btn small', title: 'Move to bottom', onclick: () => mv('bottom') }, icon('bottom')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small danger', onclick: () => selItems.size && api.invoke('q:removeItems', current, [...selItems]).then(() => selItems.clear()) }, 'Delete from queue')));
  };

  const paint = () => {
    paintList();
    const q = S.queues.find((x) => x.id === current);
    startBtn.disabled = !!q?.running;
    stopBtn.disabled = !q?.running;
    const tabBar = h('div', { class: 'tabs', style: { padding: 0 } },
      h('button', { class: 'tab' + (tab === 'schedule' ? ' active' : ''), onclick: () => { tab = 'schedule'; paint(); } }, 'Schedule'),
      h('button', { class: 'tab' + (tab === 'files' ? ' active' : ''), onclick: () => { tab = 'files'; paint(); } }, `Files in the queue (${q?.items.length || 0})`));
    right.replaceChildren(tabBar, h('div', { class: 'col', style: { overflow: 'auto', flex: 1, minHeight: 0, paddingTop: '4px' } }, tab === 'schedule' ? schedulePane() : filesPane()));
  };
  load();
  paint();
  const off = api.on('q:changed', () => {
    if (tab === 'files') paint();
    else paintList();
  });
  const body = h('div', { class: 'modal-body', style: { flexDirection: 'row', gap: '12px' } },
    h('div', { class: 'col', style: { width: '210px', flex: 'none' } }, h('div', { class: 'hint' }, 'Queues'), qlist,
      h('div', { class: 'row' }, h('button', { class: 'btn small grow', onclick: async () => { await apply(); const n = await promptDialog('New queue', 'Queue name:', 'Queue ' + (S.queues.length + 1)); if (n) { const q = await api.invoke('q:create', n, 'download'); current = q.id; load(); paint(); } } }, icon('plus'), 'New'),
        h('button', { class: 'btn small grow danger', onclick: async () => { const q = S.queues.find((x) => x.id === current); if (q.builtin) return toast('Built-in queues cannot be deleted'); if (await confirmDialog(`Delete queue "${q.name}"?`, { okLabel: 'Delete', danger: true })) { await api.invoke('q:remove', q.id); current = S.queues[0].id; load(); paint(); } } }, 'Delete'))),
    right);
  modal({
    title: 'Scheduler', wide: true, body,
    leftButtons: [{ label: 'Start now', onClick: async () => { await apply(); api.invoke('q:start', current); return false; } }, { label: 'Stop', onClick: () => (api.invoke('q:stop', current), false) }],
    buttons: [{ label: 'Apply', onClick: async () => { await apply(); toast('Saved'); return false; } }, { label: 'Close', primary: true, onClick: () => apply() }],
    onClose: off,
  });
}

// ---- help / about ------------------------------------------------------------------------------

const HELP = {
  start: ['Getting started', () => [
    h('h2', {}, 'Ways to start a download'),
    h('ul', {},
      h('li', {}, 'Click a download link in Chrome or Edge with the OpenDM extension installed — matching file types are taken over automatically.'),
      h('li', {}, 'Right-click a link and choose "Download with OpenDM", or "Download all links" on a page.'),
      h('li', {}, 'Copy an address to the clipboard (when clipboard monitoring is on).'),
      h('li', {}, 'Use Add URL, or drag a link onto the main window or the floating drop target.'),
      h('li', {}, 'Use Add batch download for numbered addresses such as pic01.jpg … pic99.jpg.'),
      h('li', {}, 'From the command line (below).')),
    h('h2', {}, 'Keys'),
    h('p', {}, 'Hold the bypass key (Alt by default) while clicking a link to let the browser download it. Hold the force key (Insert by default) to always download with OpenDM.'),
    h('h2', {}, 'Command line'),
    h('p', {}, h('code', {}, 'OpenDM /d URL [/p folder] [/f name] [/a] [/n] [/q]'), ' or ', h('code', {}, 'OpenDM /s')),
    h('ul', {}, h('li', {}, '/d URL — download a file'), h('li', {}, '/p — folder to save to; /f — file name'), h('li', {}, '/a — add to the main queue without starting'), h('li', {}, '/n — silent: no dialogs'), h('li', {}, '/q — exit after the download finishes'), h('li', {}, '/s — start the main queue')),
    h('h2', {}, 'How downloads are accelerated'),
    h('p', {}, 'Files are split dynamically: each new connection takes the second half of the largest remaining piece. A connection that finishes its piece continues into the next one if that piece has not started yet, so no time is lost reconnecting. Progress is saved every few seconds, so downloads resume correctly after a pause, crash or power cut.')]],
  extension: ['Browser extension', () => [
    h('h2', {}, 'Install the OpenDM browser extension'),
    h('p', {}, 'The extension lets OpenDM take over downloads, adds right-click menu items, and shows a "Download this video" panel on web players.'),
    h('ol', {},
      h('li', {}, 'Open chrome://extensions (or edge://extensions).'),
      h('li', {}, 'Turn on Developer mode.'),
      h('li', {}, 'Click "Load unpacked" and choose the OpenDM extension folder:', (() => {
        const p = h('code', { style: { display: 'block', margin: '6px 0', userSelect: 'text' } }, '…');
        api.invoke('util:extensionDir').then((d) => (p.textContent = d));
        return h('div', {}, p, h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => api.invoke('util:extensionDir').then((d) => api.invoke('util:openPath', d)) }, icon('folderOpen'), 'Open folder'),
          h('button', { class: 'btn small', onclick: () => api.invoke('util:extensionDir').then((d) => api.invoke('clip:write', d)).then(() => toast('Path copied')) }, icon('copy'), 'Copy path')));
      })()),
      h('li', {}, 'Pin the OpenDM icon. Clicking it turns integration on or off for the browser.')),
    h('p', {}, 'The extension talks to the app on 127.0.0.1, port ', h('b', {}, String(S?.settings.general.integrationPort || 52790)), '. If you change the port, change it in the extension options too.')]],
  queues: ['Scheduler and queues', () => [
    h('h2', {}, 'Queues'),
    h('p', {}, 'The Main Download queue downloads its files one or several at a time and removes each file when it finishes. If a file fails it moves to the end of the queue; a file that is alone is retried every 30 seconds, or up to the retry limit you set.'),
    h('p', {}, 'Synchronization queues re-check every file on the server and download it again only when it changed. Files stay in the queue.'),
    h('h2', {}, 'Scheduling'),
    h('p', {}, 'Each queue can start and stop at set times on chosen days or a single date. When it finishes it can open a file, exit OpenDM, or shut down, restart, sleep or hibernate the computer (with a 30-second chance to cancel). These actions do not run when you stop the queue yourself.'),
    h('h2', {}, 'Download limits'),
    h('p', {}, 'Options → Connection → Download limits caps how much is downloaded per period (for example 200 MB per hour). Downloads pause at the limit and resume on their own.')]],
  linkgrabber: ['LinkGrabber', () => [
    h('h2', {}, 'LinkGrabber'),
    h('p', {}, 'The LinkGrabber (Tasks → LinkGrabber, Ctrl+L) is a waiting area for links. Links you add are checked online in the background — name, size and whether the file still exists — and sorted into packages before anything is downloaded.'),
    h('ul', {},
      h('li', {}, 'Add links by pasting text with "Add links", from "Download all links" in the browser, from a clipboard batch or a text-file import. Turn on "Collect every address copied to the clipboard" to gather links while you browse.'),
      h('li', {}, 'Parts of a split archive (name.part1.rar, name.z01, name.7z.001 …) are grouped into one package. Single files go into "Various files", dead links into "Offline".'),
      h('li', {}, 'With deep analysis, a web page address is replaced by the files it links to.'),
      h('li', {}, 'Use the filters on the left to hide hosts, file types or offline links. "Start all downloads" adds what is visible and checked.'),
      h('li', {}, 'Right-click to rename packages, choose a save folder, move links into a new package, split a package by host, or check links again.')),
    h('p', {}, 'Packages with several files are saved into a subfolder named after the package. Auto-confirm can add links to the download list on its own a few seconds after the last check.')]],
  grabber: ['Site grabber', () => [
    h('h2', {}, 'Site grabber'),
    h('p', {}, 'The grabber explores a web site and collects files that match your filters — for example every image or every PDF.'),
    h('ol', {},
      h('li', {}, 'Start page, project name and optional login.'),
      h('li', {}, 'Where to save files, and whether to keep the site folder structure.'),
      h('li', {}, 'Which pages to explore: link levels on this site and on other sites, parent folders, sub-domains, include/exclude filters.'),
      h('li', {}, 'Which files to collect: types, path filters, size limits, duplicates.')),
    h('p', {}, 'Explore first and check the files you want, or let the grabber download everything it finds. Projects can be saved and scheduled for a one-time run or periodic synchronization.')]],
};

export function helpDialog(topic = 'start') {
  const nav = h('div', { class: 'vtabs' });
  const pane = h('div', { class: 'pane help' });
  const show = (id) => {
    for (const b of nav.children) b.classList.toggle('active', b.dataset.id === id);
    pane.replaceChildren(...HELP[id][1]());
  };
  for (const [id, [label]] of Object.entries(HELP)) nav.append(h('button', { class: 'tab', 'data-id': id, onclick: () => show(id) }, label));
  show(HELP[topic] ? topic : 'start');
  modal({ title: 'Help', wide: true, body: h('div', { class: 'split' }, nav, pane), buttons: [{ label: 'Close', primary: true }] });
}

const TIPS = [
  'OpenDM takes over a download from the browser when its type is in Options → File types.',
  'If a server keeps failing, add the file to a queue and start the queue: it retries every 30 seconds.',
  'Hold Insert while clicking a link to force OpenDM to download it; hold Alt to let the browser download it.',
  'Right-click a column header to choose which columns to show; drag headers to reorder them.',
  'Turn off "Show the Download File Info dialog" in Options → Downloads for silent downloading.',
  'Drag a finished download out of the list to drop the file into a folder or another program (hold Shift to drag it onto a queue instead).',
  'Save logins for protected servers in Options → Site logins so you are not asked every time.',
  'Expired link? Right-click the download and choose "Refresh download address" to keep the progress.',
];

export function tipDialog() {
  let i = Math.floor(Math.random() * TIPS.length);
  const text = h('p', { style: { minHeight: '48px' } }, TIPS[i]);
  modal({ title: 'Did you know…', body: h('div', { class: 'col' }, text), buttons: [{ label: 'Next tip', onClick: () => { i = (i + 1) % TIPS.length; text.textContent = TIPS[i]; return false; } }, { label: 'Close', primary: true }] });
}

export function aboutDialog() {
  modal({
    title: 'About OpenDM',
    body: h('div', { class: 'col', style: { alignItems: 'center', textAlign: 'center', padding: '8px' } },
      h('img', { src: '../../assets/icon128.png', width: 72, height: 72, alt: '' }),
      h('div', { style: { fontSize: '17px', fontWeight: 650 } }, 'OpenDM ' + S.version),
      h('div', { class: 'muted' }, 'Multi-connection download manager with browser integration, queues, scheduler, site grabber and stream capture.'),
      h('div', { class: 'hint' }, 'Data folder, logs and settings: Help → Open data folder.')),
    buttons: [{ label: 'Close', primary: true }],
  });
}

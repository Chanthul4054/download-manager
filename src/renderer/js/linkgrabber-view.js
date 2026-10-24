import { api, h, icon, bytes, check, select, field, folderInput, applyAppearance, toast, modal, fileBadge, confirmDialog, promptDialog, contextMenu, resizableColumns, extOf } from './common.js';

const COLUMNS = [
  ['name', 'Name', 340],
  ['size', 'Size', 90],
  ['host', 'Host', 150],
  ['status', 'Status', 170],
  ['saveDir', 'Save to', 200],
  ['url', 'Address', 320],
];

const TYPES = [
  ['archive', 'Archives', /^(zip|rar|7z|gz|tgz|tar|bz2|xz|zst|iso|cab|r\d{2}|z\d{2}|\d{3}|par2?)$/],
  ['video', 'Video', /^(mp4|mkv|webm|avi|mov|wmv|flv|m4v|mpe?g|3gp|ts|ogv)$/],
  ['audio', 'Audio', /^(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/],
  ['image', 'Images', /^(jpe?g|png|gif|webp|bmp|tiff?|svg|avif)$/],
  ['document', 'Documents', /^(pdf|docx?|xlsx?|pptx?|txt|rtf|odt|ods|epub|mobi|csv)$/],
  ['program', 'Programs', /^(exe|msi|msu|apk|dmg|deb|rpm|appimage|pkg)$/],
  ['other', 'Other', /./],
];

const STATUS = [
  ['online', 'Online'],
  ['unknown', 'Not checked'],
  ['offline', 'Offline'],
  ['checking', 'Checking'],
];

const typeOf = (l) => {
  if (/html/.test(l.type)) return 'other';
  const ext = extOf(l.name);
  return (TYPES.find(([, , re]) => re.test(ext)) || TYPES[TYPES.length - 1])[0];
};

export async function mountLinkGrabber(root) {
  const st = await api.invoke('state');
  let settings = st.settings;
  applyAppearance(settings);
  let data = await api.invoke('lg:state');
  const sel = new Set();
  let anchor = null;
  let search = '';
  const hidden = { host: new Set(), type: new Set(), status: new Set() };
  const widths = { ...Object.fromEntries(COLUMNS.map(([k, , w]) => [k, w])), ...(settings.linkGrabber.columnWidths || {}) };
  let queueId = settings.linkGrabber.queueId ?? 'main';
  let startNow = settings.linkGrabber.autoStart;

  const visibleLink = (l) => !hidden.host.has(l.host) && !hidden.type.has(typeOf(l)) && !hidden.status.has(l.status)
    && (!search || `${l.name} ${l.url}`.toLowerCase().includes(search));
  const visiblePackages = () => data.packages.map((p) => ({ p, links: p.links.filter(visibleLink) })).filter((x) => x.links.length);
  const allLinks = () => data.packages.flatMap((p) => p.links);

  // ---- layout ----------------------------------------------------------------------------------

  const tb = (ic, label, title, onclick) => h('button', { class: 'tb-btn', title, onclick }, icon(ic), h('span', { class: 'lbl' }, label));
  const searchInput = h('input', { type: 'search', placeholder: 'Search names and addresses', style: { width: '220px' }, oninput: (e) => { search = e.target.value.trim().toLowerCase(); paint(); } });
  const toolbar = h('div', { class: 'toolbar small', role: 'toolbar' },
    tb('plus', 'Add links', 'Paste or type addresses to collect', () => addLinksDialog()),
    tb('refresh', 'Check again', 'Check the selected links online again', () => api.invoke('lg:recheck', selection())),
    h('div', { class: 'tb-sep' }),
    tb('trash', 'Remove', 'Remove the selected links', () => removeSelected()),
    tb('x', 'Remove offline', 'Remove all offline links', () => api.invoke('lg:removeOffline')),
    tb('sweep', 'Clear list', 'Remove everything from the LinkGrabber', async () => (await confirmDialog('Remove all links from the LinkGrabber?', { okLabel: 'Clear', danger: true })) && api.invoke('lg:clear')),
    h('div', { class: 'tb-sep' }),
    tb('gear', 'Settings', 'LinkGrabber settings', () => settingsDialog()),
    h('span', { class: 'grow' }),
    searchInput);

  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Quick filters' });
  const headRow = h('tr', {}, COLUMNS.map(([k, label]) => h('th', { 'data-col': k, style: { width: widths[k] + 'px' } }, label)));
  const tbody = h('tbody');
  const table = resizableColumns(h('table', { class: 'grid', role: 'treegrid', 'aria-label': 'Collected links' }, h('thead', {}, headRow), tbody), (th, w) => {
    widths[th.dataset.col] = w;
    api.invoke('settings:save', { linkGrabber: { columnWidths: { [th.dataset.col]: w } } });
  });
  const emptyEl = h('div', { class: 'empty' });
  const wrap = h('div', { class: 'table-wrap', tabindex: '0' }, table, emptyEl);
  const summary = h('span', { class: 'muted ellipsis grow' });
  const autoNote = h('span', { class: 'hint' });
  const queueSel = select([['', 'No queue'], ...st.queues.filter((q) => q.type === 'download').map((q) => [q.id, q.name])], queueId, (v) => (queueId = v));
  const confirmSelBtn = h('button', { class: 'btn', onclick: () => confirmLinks(selection()) }, 'Add selected');
  const confirmAllBtn = h('button', { class: 'btn primary', onclick: () => confirmLinks(null) }, icon('down'), 'Start all downloads');
  const foot = h('div', { class: 'modal-foot', style: { gap: '10px' } },
    summary, autoNote,
    h('span', { class: 'muted' }, 'Add to'), queueSel,
    check('Start now', startNow, (v) => (startNow = v)),
    confirmSelBtn, confirmAllBtn);
  root.append(toolbar, h('div', { class: 'workspace' }, sidebar, h('div', { class: 'listpane' }, wrap)), foot);
  root.style.minHeight = '100%';

  // ---- painting --------------------------------------------------------------------------------

  function paint() {
    const scroll = wrap.scrollTop;
    const vis = visiblePackages();
    const rows = [];
    for (const { p, links } of vis) {
      rows.push(packageRow(p, links));
      if (p.expanded) for (const l of links) rows.push(linkRow(p, l));
    }
    tbody.replaceChildren(...rows);
    wrap.scrollTop = scroll;
    const total = allLinks();
    emptyEl.classList.toggle('hidden', rows.length > 0);
    emptyEl.replaceChildren(h('div', {}, h('div', { class: 'big' }, total.length ? 'No links match the filters' : 'No links collected'),
      h('div', {}, total.length ? 'Change the quick filters on the left or the search text.' : 'Click "Add links", copy addresses, or use "Download all links" in the browser.')));
    const shown = vis.flatMap((x) => x.links).filter((l) => l.enabled);
    const online = total.filter((l) => l.status === 'online').length;
    summary.textContent = `${data.packages.length} packages · ${total.length} links (${online} online${data.busy ? `, checking ${data.pending}` : ''}) · ${bytes(shown.reduce((a, l) => a + (l.size || 0), 0), '0 Bytes')} to download`;
    autoNote.textContent = settings.linkGrabber.autoConfirm ? `Auto-confirm on (${settings.linkGrabber.autoConfirmDelaySec}s)` : '';
    confirmSelBtn.disabled = !sel.size;
    confirmAllBtn.disabled = !shown.length;
    paintSidebar();
  }

  function packageRow(p, links) {
    const enabled = links.filter((l) => l.enabled).length;
    const cb = h('input', { type: 'checkbox', checked: enabled === links.length, title: 'Download these links', onclick: (e) => e.stopPropagation(), onchange: (e) => api.invoke('lg:enable', links.map((l) => l.id), e.target.checked) });
    cb.indeterminate = enabled > 0 && enabled < links.length;
    const counts = {};
    for (const l of links) counts[l.status] = (counts[l.status] || 0) + 1;
    const statusText = STATUS.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label.toLowerCase()}`).join(' · ');
    const hosts = [...new Set(links.map((l) => l.host))];
    const size = links.reduce((a, l) => a + (l.size || 0), 0);
    return h('tr', { class: 'pkg' + (sel.has(p.id) ? ' sel' : ''), 'data-id': p.id, 'aria-expanded': String(!!p.expanded), ...rowEvents(p.id, p) },
      h('td', {}, h('div', { class: 'namecell' },
        h('span', { class: 'twist', onclick: (e) => { e.stopPropagation(); toggle(p); } }, icon(p.expanded ? 'chevDown' : 'chevRight')),
        cb, icon(p.kind === 'offline' ? 'x' : p.kind === 'various' ? 'layers' : 'folder'),
        h('b', { class: 'ellipsis', title: p.name }, p.name), h('span', { class: 'muted' }, `(${links.length})`))),
      h('td', { class: 'num' }, bytes(size)),
      h('td', { title: hosts.join(', ') }, hosts.length > 1 ? `${hosts.length} hosts` : hosts[0] || ''),
      h('td', { class: counts.offline === links.length ? 'status-err' : '' }, statusText),
      h('td', { title: p.saveDir }, p.saveDir || h('span', { class: 'muted' }, settings.linkGrabber.packageFolders && p.links.length > 1 && (p.kind === 'normal' || p.kind === 'custom') ? `Category folder › ${p.name}` : 'Category folder')),
      h('td'));
  }

  function linkRow(p, l) {
    const statusCls = l.status === 'online' ? 'status-done' : l.status === 'offline' ? 'status-err' : l.status === 'checking' ? 'status-run' : '';
    const statusLabel = (STATUS.find(([k]) => k === l.status) || [, l.status])[1] + (l.error ? ` — ${l.error}` : '') + (l.inList ? ' (already in list)' : '');
    return h('tr', { class: (sel.has(l.id) ? 'sel' : '') + (l.enabled ? '' : ' disabled'), 'data-id': l.id, ...rowEvents(l.id, null, l) },
      h('td', {}, h('div', { class: 'namecell', style: { paddingLeft: '30px' } },
        h('input', { type: 'checkbox', checked: l.enabled, onclick: (e) => e.stopPropagation(), onchange: (e) => api.invoke('lg:enable', [l.id], e.target.checked) }),
        fileBadge(l.name), h('span', { class: 'ellipsis', title: l.name }, l.name))),
      h('td', { class: 'num' }, l.size != null ? bytes(l.size) : ''),
      h('td', { title: l.host }, l.host),
      h('td', { class: statusCls, title: statusLabel }, statusLabel),
      h('td'),
      h('td', { class: 'mono', title: l.url }, l.url));
  }

  function rowEvents(id, pkg, link) {
    return {
      onclick: (e) => clickRow(id, e),
      ondblclick: () => (pkg ? renamePackage(pkg) : renameLink(link)),
      oncontextmenu: (e) => {
        e.preventDefault();
        if (!sel.has(id)) {
          sel.clear();
          sel.add(id);
          anchor = id;
          paint();
        }
        rowMenu(e.clientX, e.clientY);
      },
    };
  }

  function paintSidebar() {
    const links = allLinks();
    const group = (title, kind, entries) => {
      if (!entries.length) return [];
      return [h('div', { class: 'sidebar-head' }, title), ...entries.map(([key, label, n]) => h('label', { class: 'tree-node', title: `Show or hide ${label}` },
        h('input', { type: 'checkbox', checked: !hidden[kind].has(key), onchange: (e) => { e.target.checked ? hidden[kind].delete(key) : hidden[kind].add(key); paint(); } }),
        h('span', { class: 'ellipsis' }, label), h('span', { class: 'count' }, n)))];
    };
    const tally = (fn) => {
      const m = new Map();
      for (const l of links) m.set(fn(l), (m.get(fn(l)) || 0) + 1);
      return m;
    };
    const hosts = tally((l) => l.host);
    const types = tally(typeOf);
    const statuses = tally((l) => l.status);
    sidebar.replaceChildren(
      ...group('Hosts', 'host', [...hosts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k || '(none)', n])),
      ...group('File types', 'type', TYPES.filter(([k]) => types.has(k)).map(([k, label]) => [k, label, types.get(k)])),
      ...group('Status', 'status', STATUS.filter(([k]) => statuses.has(k)).map(([k, label]) => [k, label, statuses.get(k)])));
  }

  // ---- selection -------------------------------------------------------------------------------

  const rowIds = () => [...tbody.querySelectorAll('tr[data-id]')].map((r) => r.dataset.id);

  function clickRow(id, e) {
    if (e.shiftKey && anchor) {
      const ids = rowIds();
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      if (!e.ctrlKey) sel.clear();
      for (const x of ids.slice(a, b + 1)) sel.add(x);
    } else if (e.ctrlKey || e.metaKey) {
      sel.has(id) ? sel.delete(id) : sel.add(id);
      anchor = id;
    } else {
      sel.clear();
      sel.add(id);
      anchor = id;
    }
    paint();
  }

  // Selected packages count as all their visible links.
  function selection() {
    return [...sel].flatMap((id) => {
      const p = data.packages.find((x) => x.id === id);
      return p ? p.links.filter(visibleLink).map((l) => l.id) : [id];
    });
  }

  function toggle(p) {
    p.expanded = !p.expanded;
    api.invoke('lg:updatePackage', p.id, { expanded: p.expanded });
    paint();
  }

  wrap.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Delete') removeSelected();
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      rowIds().forEach((id) => sel.add(id));
      paint();
    } else if (e.key === 'Enter' && sel.size) confirmLinks(selection());
  });
  wrap.addEventListener('mousedown', (e) => {
    if (!e.target.closest('tr') && e.button === 0) {
      sel.clear();
      paint();
    }
  });

  // ---- actions ---------------------------------------------------------------------------------

  async function confirmLinks(ids) {
    const chosen = ids ? ids : visiblePackages().flatMap((x) => x.links.map((l) => l.id));
    if (!chosen.length) return toast('Nothing to add');
    const added = await api.invoke('lg:confirm', chosen, { queueId: queueId || undefined, start: startNow });
    sel.clear();
    toast(added.length ? `Added ${added.length} download${added.length > 1 ? 's' : ''}${startNow ? ' and started them' : ''}` : 'Nothing was added — the links are offline, unchecked or already in the list');
  }

  async function removeSelected() {
    const ids = selection();
    if (!ids.length) return;
    await api.invoke('lg:remove', ids);
    sel.clear();
  }

  async function renamePackage(p) {
    const name = await promptDialog('Rename package', 'Package name:', p.name);
    if (name && name.trim()) api.invoke('lg:updatePackage', p.id, { name });
  }

  async function renameLink(l) {
    const name = await promptDialog('Rename file', 'File name:', l.name);
    if (name && name.trim()) api.invoke('lg:renameLink', l.id, name);
  }

  function rowMenu(x, y) {
    const ids = selection();
    const pkgs = [...sel].map((id) => data.packages.find((p) => p.id === id)).filter(Boolean);
    const links = allLinks().filter((l) => ids.includes(l.id));
    contextMenu(x, y, [
      { label: 'Start downloads', onClick: () => api.invoke('lg:confirm', ids, { queueId: queueId || undefined, start: true }) },
      { label: 'Add to download list', onClick: () => api.invoke('lg:confirm', ids, { queueId: queueId || undefined, start: false }) },
      { label: 'Add including offline and duplicates', onClick: () => api.invoke('lg:confirm', ids, { queueId: queueId || undefined, start: startNow, includeOffline: true, includeDupes: true, includeDisabled: true }) },
      '-',
      { label: 'Enable', onClick: () => api.invoke('lg:enable', ids, true) },
      { label: 'Disable', onClick: () => api.invoke('lg:enable', ids, false) },
      { label: 'Check again', onClick: () => api.invoke('lg:recheck', ids) },
      '-',
      { label: 'Rename…', disabled: sel.size !== 1, onClick: () => (pkgs[0] ? renamePackage(pkgs[0]) : renameLink(links[0])) },
      { label: 'Set save folder…', disabled: !pkgs.length, onClick: async () => { const d = await api.invoke('dialog:folder', pkgs[0].saveDir || undefined); if (d) for (const p of pkgs) api.invoke('lg:updatePackage', p.id, { saveDir: d }); } },
      { label: 'Use default save folder', disabled: !pkgs.some((p) => p.saveDir), onClick: () => pkgs.forEach((p) => api.invoke('lg:updatePackage', p.id, { saveDir: '' })) },
      { label: 'Move to new package…', disabled: !ids.length, onClick: async () => { const name = await promptDialog('New package', 'Package name:', pkgs[0]?.name || ''); if (name != null) { await api.invoke('lg:merge', ids, name); sel.clear(); } } },
      { label: 'Split packages by host', disabled: !ids.length, onClick: () => api.invoke('lg:splitByHost', ids) },
      '-',
      { label: 'Open in browser', disabled: links.length !== 1, onClick: () => api.invoke('util:openExternal', links[0].url) },
      { label: 'Copy addresses', disabled: !links.length, onClick: () => api.invoke('clip:write', links.map((l) => l.url).join('\n')) },
      '-',
      { label: 'Remove', kbd: 'Del', disabled: !ids.length, onClick: () => removeSelected() },
    ]);
  }

  async function addLinksDialog() {
    const clip = settings.linkGrabber.useForLinkLists || settings.linkGrabber.clipboard ? await api.invoke('clip:urls') : [];
    const area = h('textarea', { rows: 10, class: 'mono', placeholder: 'Paste addresses or any text containing them, one or many' }, clip.join('\n'));
    const opts = { packageName: '', saveDir: '', deep: settings.linkGrabber.deepAnalyse };
    modal({
      title: 'Add links', wide: true,
      body: h('div', { class: 'col' },
        area,
        field('Package name', h('input', { type: 'text', placeholder: 'Automatic (from file names)', oninput: (e) => (opts.packageName = e.target.value) })),
        field('Save to', folderInput('', (v) => (opts.saveDir = v)), 'Leave empty to use the category folders.'),
        check('Look for files inside web pages (deep analysis)', opts.deep, (v) => (opts.deep = v))),
      buttons: [{ label: 'Cancel' }, {
        label: 'Continue', primary: true, onClick: async () => {
          const n = await api.invoke('lg:add', { text: area.value, packageName: opts.packageName || undefined, saveDir: opts.saveDir || undefined, deep: opts.deep });
          if (!n) {
            toast('No new addresses found');
            return false;
          }
        },
      }],
    });
  }

  function settingsDialog() {
    const s = { ...settings.linkGrabber };
    const num = (k, attrs) => h('input', { type: 'number', value: s[k], ...attrs, oninput: (e) => (s[k] = Number(e.target.value)) });
    modal({
      title: 'LinkGrabber settings',
      body: h('div', { class: 'col' },
        h('fieldset', {}, h('legend', {}, 'Collecting'), h('div', { class: 'col' },
          check('Send link lists here ("Download all links", clipboard batches, text imports)', s.useForLinkLists, (v) => (s.useForLinkLists = v)),
          check('Collect every address copied to the clipboard', s.clipboard, (v) => (s.clipboard = v)),
          check('Look for files inside web pages by default (deep analysis)', s.deepAnalyse, (v) => (s.deepAnalyse = v)),
          field('Check links', h('div', { class: 'row' }, num('checkThreads', { min: 1, max: 16 }), 'at the same time')),
          field('2Captcha API key', h('input', { type: 'password', value: s.captchaApiKey || '', autocomplete: 'off', oninput: (e) => (s.captchaApiKey = e.target.value.trim()) }),
            'Solves reCAPTCHA, hCaptcha and Turnstile on pages searched by deep analysis. Leave empty to skip such pages.'))),
        h('fieldset', {}, h('legend', {}, 'Packages'), h('div', { class: 'col' },
          check('Put single files into a "Various files" package', s.variousPackage, (v) => (s.variousPackage = v)),
          check('Save packages with several files into a subfolder named after the package', s.packageFolders, (v) => (s.packageFolders = v)),
          check('Expand new packages', s.expandPackages, (v) => (s.expandPackages = v)))),
        h('fieldset', {}, h('legend', {}, 'Adding to the download list'), h('div', { class: 'col' },
          field('Offline links', select([['exclude', 'Leave them in the LinkGrabber'], ['include', 'Add them anyway']], s.offlineAction, (v) => (s.offlineAction = v))),
          field('Already in the list', select([['skip', 'Skip them'], ['add', 'Add them again']], s.dupeAction, (v) => (s.dupeAction = v))),
          check('Start downloads by default', s.autoStart, (v) => (s.autoStart = v)),
          check('Add links automatically once they are checked', s.autoConfirm, (v) => (s.autoConfirm = v)),
          field('Wait before adding', h('div', { class: 'row' }, num('autoConfirmDelaySec', { min: 1, max: 3600 }), 'seconds after the last check'))))),
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => api.invoke('settings:save', { linkGrabber: s }) }],
    });
  }

  // ---- updates ---------------------------------------------------------------------------------

  api.on('lg:changed', (d) => {
    data = d;
    const ids = new Set([...data.packages.map((p) => p.id), ...allLinks().map((l) => l.id)]);
    for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
    paint();
  });
  api.on('settings', (s) => {
    settings = s;
    applyAppearance(s);
    paint();
  });

  paint();
  wrap.focus();
}

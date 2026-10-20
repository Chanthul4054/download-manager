import { api, h, icon, bytes, rate, duration, date, fileBadge, statusText, contextMenu, applyAppearance, playSound, toast, confirmDialog, promptDialog, resizableColumns } from './common.js';
import * as D from './dialogs.js';

const COLUMNS = {
  name: { label: 'File Name', width: 300 },
  queue: { label: 'Q', width: 34 },
  size: { label: 'Size', width: 90, num: true },
  status: { label: 'Status', width: 150 },
  timeLeft: { label: 'Time left', width: 90, num: true },
  rate: { label: 'Transfer rate', width: 105, num: true },
  lastTry: { label: 'Last Try Date', width: 150 },
  description: { label: 'Description', width: 180 },
  saveDir: { label: 'Save To', width: 200 },
  referer: { label: 'Referer', width: 200 },
  parentPage: { label: 'Parent web page', width: 200 },
  url: { label: 'Address', width: 260 },
  added: { label: 'Date Added', width: 150 },
  connections: { label: 'Conn.', width: 50, num: true },
};
export const ALL_COLUMNS = COLUMNS;

const S = {
  items: new Map(),
  queues: [],
  categories: [],
  settings: null,
  sel: new Set(),
  focus: null,
  anchor: null,
  node: { type: 'all' },
  find: '',
  findOpts: { name: true, description: true, address: true, matchCase: false, whole: false },
  expanded: { all: true, queues: true, grabber: false },
  grabbers: [],
  stats: new Map(),
};
export const state = S;

let tableBody, headRow, emptyEl, sidebarEl, statusEl, toolbarEl, findbarEl, findInput;
const rowEls = new Map();

export async function mountMain(root) {
  const st = await api.invoke('state');
  S.settings = st.settings;
  S.categories = st.categories;
  S.queues = st.queues;
  S.version = st.version;
  S.grabberPresets = st.grabberPresets;
  for (const it of st.items) S.items.set(it.id, it);
  S.grabbers = await api.invoke('grabber:list');
  applyAppearance(S.settings);
  D.init(S);

  toolbarEl = h('div', { class: 'toolbar', role: 'toolbar' });
  sidebarEl = h('nav', { class: 'sidebar', 'aria-label': 'Categories and queues' });
  findInput = h('input', { type: 'text', placeholder: 'File name, description or address', oninput: (e) => { S.find = e.target.value; render(); } });
  findbarEl = h('div', { class: 'findbar hidden' }, icon('search'), findInput,
    h('button', { class: 'btn small', onclick: () => findNext() }, 'Find next'),
    h('button', { class: 'btn small', onclick: () => D.findDialog(findInput.value, (q, o) => { S.find = q; S.findOpts = o; findInput.value = q; render(); findNext(); }) }, 'Settings…'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small', title: 'Close search bar', onclick: () => toggleFind(false) }, icon('x')));
  headRow = h('tr');
  tableBody = h('tbody');
  const table = h('table', { class: 'grid', role: 'grid', 'aria-label': 'Downloads' }, h('thead', {}, headRow), tableBody);
  resizableColumns(table, (th, w) => api.invoke('settings:save', { appearance: { columnWidths: { [th.dataset.col]: w } } }));
  emptyEl = h('div', { class: 'empty hidden' });
  const wrap = h('div', { class: 'table-wrap', tabindex: '0' }, table, emptyEl);
  statusEl = h('div', { class: 'statusbar' });
  root.append(toolbarEl, h('div', { class: 'workspace' }, sidebarEl, h('div', { class: 'listpane' }, findbarEl, wrap)), statusEl);

  wrap.addEventListener('keydown', onKey);
  wrap.addEventListener('contextmenu', (e) => {
    if (e.target.closest('tr[data-id]') || e.target.closest('thead')) return;
    e.preventDefault();
    S.sel.clear();
    paintSelection();
    rowMenu(e.clientX, e.clientY);
  });
  wrap.addEventListener('mousedown', (e) => {
    if (!e.target.closest('tr') && e.button === 0) {
      S.sel.clear();
      paintSelection();
    }
  });
  setupDrop(document.body);

  api.on('dl:changed', (it) => {
    const prev = S.items.get(it.id);
    S.items.set(it.id, { ...prev, ...it });
    if (!prev) render();
    else updateRow(it.id, prev.status !== it.status || prev.fileName !== it.fileName);
    updateToolbar();
  });
  api.on('dl:removed', (ids) => {
    ids.forEach((id) => {
      S.items.delete(id);
      S.sel.delete(id);
    });
    render();
  });
  api.on('dl:progress', (batch) => {
    for (const { id, item, stats } of batch) {
      S.items.set(id, { ...S.items.get(id), ...item });
      S.stats.set(id, stats);
      updateRow(id);
    }
    renderStatus();
  });
  api.on('q:changed', (qs) => {
    S.queues = qs;
    renderSidebar();
    if (S.node.type === 'queue') render();
    else S.items.forEach((_, id) => updateRow(id));
  });
  api.on('settings', (s) => {
    const colsChanged = JSON.stringify(s.appearance.columns) !== JSON.stringify(S.settings.appearance.columns) || JSON.stringify(s.appearance.sort) !== JSON.stringify(S.settings.appearance.sort);
    S.settings = s;
    D.init(S);
    applyAppearance(s);
    renderToolbar();
    sidebarEl.classList.toggle('hidden', !s.appearance.showCategories);
    if (colsChanged) render();
    renderStatus();
  });
  api.on('categories', (c) => {
    S.categories = c;
    renderSidebar();
    render();
  });
  api.on('grabber:list', async () => {
    S.grabbers = await api.invoke('grabber:list');
    renderSidebar();
  });
  api.on('grabber:done', async () => {
    S.grabbers = await api.invoke('grabber:list');
    renderSidebar();
  });
  api.on('sound', (kind) => playSound(kind, S.settings));
  api.on('menu', (cmd, arg) => runCommand(cmd, arg));

  sidebarEl.classList.toggle('hidden', !S.settings.appearance.showCategories);
  renderToolbar();
  renderSidebar();
  render();
  setInterval(renderStatus, 1000);
  if (S.settings.firstRun !== false) {
    api.invoke('settings:save', { firstRun: false });
    setTimeout(() => D.helpDialog('extension'), 400);
  }
}

// ---- commands ----------------------------------------------------------------------------------

function selected() {
  return [...S.sel].map((id) => S.items.get(id)).filter(Boolean);
}

export async function runCommand(cmd, arg) {
  const sel = selected();
  const ids = sel.map((x) => x.id);
  switch (cmd) {
    case 'addUrl': return D.addUrlDialog();
    case 'batch': return D.batchDialog();
    case 'resume': return ids.length && api.invoke('dl:start', ids.filter((id) => S.items.get(id).status !== 'complete'));
    case 'stop': return ids.length && api.invoke('dl:stop', ids);
    case 'stopAll': return api.invoke('dl:stopAll');
    case 'delete': return deleteSelected(false);
    case 'deleteFiles': return deleteSelected(true);
    case 'deleteCompleted': {
      const r = await confirmDialog('Remove all completed downloads from the list?', { okLabel: 'Remove', detail: 'Downloaded files stay on disk.' });
      if (r) api.invoke('dl:removeCompleted');
      return;
    }
    case 'redownload': {
      if (!sel[0]) return;
      const r = await confirmDialog(`Download "${sel[0].fileName}" again from the beginning?`, { okLabel: 'Redownload' });
      if (r) api.invoke('dl:redownload', sel[0].id);
      return;
    }
    case 'open': return sel[0] && (sel[0].status === 'complete' ? api.invoke('dl:open', sel[0].id) : D.propertiesDialog(sel[0].id));
    case 'openFolder': return sel[0] && api.invoke('dl:openFolder', sel[0].id);
    case 'properties': return sel[0] && D.propertiesDialog(sel[0].id);
    case 'progress': return sel[0] && api.invoke('dl:progressWindow', sel[0].id);
    case 'options': return D.optionsDialog(arg);
    case 'scheduler': return D.schedulerDialog(arg);
    case 'limiter': return D.limiterDialog();
    case 'columns': return D.columnsDialog(COLUMNS);
    case 'find': return toggleFind(true);
    case 'findNext': return findNext();
    case 'help': return D.helpDialog(arg);
    case 'about': return D.aboutDialog();
    case 'tip': return D.tipDialog();
    case 'grabber': return api.invoke('win:open', 'grabber', {});
    case 'copyUrl': return sel.length && api.invoke('clip:write', sel.map((x) => x.url).join('\n'));
    case 'refresh': {
      if (!sel[0]) return;
      const url = await promptDialog('Refresh download address', 'New address for this file (progress is kept if the file is the same):', sel[0].url);
      if (url) api.invoke('dl:refreshAddress', sel[0].id, url.trim());
      return;
    }
    case 'moveRename': return sel[0] && D.propertiesDialog(sel[0].id);
    default:
  }
}

async function deleteSelected(withFiles) {
  const sel = selected();
  if (!sel.length) return;
  const unfinished = sel.filter((x) => x.status !== 'complete').length;
  const msg = sel.length === 1 ? `Remove "${sel[0].fileName}" from the list?` : `Remove ${sel.length} downloads from the list?`;
  const r = await confirmDialog(msg, {
    okLabel: 'Remove', danger: withFiles,
    detail: unfinished ? 'Unfinished downloads lose their partial data.' : '',
    check: sel.some((x) => x.status === 'complete') ? 'Also delete the downloaded files from disk' : null,
  });
  if (r) api.invoke('dl:remove', sel.map((x) => x.id), withFiles || r.checked);
}

function toggleFind(show) {
  findbarEl.classList.toggle('hidden', !show);
  if (show) {
    findInput.focus();
    findInput.select();
  } else {
    S.find = '';
    findInput.value = '';
    render();
  }
}

function findNext() {
  const rows = [...tableBody.querySelectorAll('tr[data-id]')];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.id === S.focus);
  const next = rows[(i + 1) % rows.length];
  selectOnly(next.dataset.id);
  next.scrollIntoView({ block: 'nearest' });
}

// ---- toolbar -----------------------------------------------------------------------------------

const TB = [
  ['addUrl', 'plus', 'Add URL', 'Add a new download address'],
  ['resume', 'play', 'Resume', 'Start or resume the selected downloads'],
  ['stop', 'pause', 'Stop', 'Stop the selected downloads'],
  ['stopAll', 'stopAll', 'Stop All', 'Stop all downloads and queues'],
  '|',
  ['delete', 'trash', 'Delete', 'Remove the selected downloads from the list'],
  ['deleteCompleted', 'sweep', 'Delete Co…', 'Remove all completed downloads from the list'],
  '|',
  ['options', 'gear', 'Options', 'Browser integration, file types, connection, proxy and more'],
  ['scheduler', 'clock', 'Scheduler', 'Queues and scheduled downloads'],
  ['startQueue', 'queuePlay', 'Start Qu…', 'Start the main queue, or pick a queue from the arrow'],
  ['stopQueue', 'queueStop', 'Stop Qu…', 'Stop the main queue, or pick a queue from the arrow'],
  '|',
  ['grabber', 'globe', 'Grabber', 'Download files from a whole web site'],
  ['batch', 'layers', 'Batch', 'Add a batch of addresses using a wildcard'],
];

function renderToolbar() {
  toolbarEl.className = 'toolbar ' + (S.settings.appearance.toolbar || 'large');
  toolbarEl.replaceChildren(...TB.map((b) => {
    if (b === '|') return h('div', { class: 'tb-sep' });
    const [cmd, ic, label, tip] = b;
    const btn = h('button', { class: 'tb-btn', 'data-cmd': cmd, title: tip, onclick: () => (cmd === 'startQueue' ? api.invoke('q:start', 'main') : cmd === 'stopQueue' ? api.invoke('q:stop', 'main') : runCommand(cmd)) }, icon(ic), h('span', { class: 'lbl' }, label));
    if (cmd === 'startQueue' || cmd === 'stopQueue') {
      const drop = h('button', {
        class: 'tb-btn tb-drop', title: 'Choose a queue', 'aria-label': 'Choose a queue',
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(r.left, r.bottom + 2, S.queues.map((q) => ({ label: q.name, checked: q.running, onClick: () => api.invoke(cmd === 'startQueue' ? 'q:start' : 'q:stop', q.id) })));
        },
      }, icon('chevDown'));
      return h('div', { class: 'tb-split' }, btn, drop);
    }
    return btn;
  }));
  updateToolbar();
}

function updateToolbar() {
  const sel = selected();
  const set = (cmd, on) => {
    const b = toolbarEl.querySelector(`[data-cmd="${cmd}"]`);
    if (b) b.disabled = !on;
  };
  set('resume', sel.some((x) => x.status !== 'complete' && x.status !== 'downloading'));
  set('stop', sel.some((x) => x.status === 'downloading'));
  set('delete', sel.length > 0);
  set('stopAll', [...S.items.values()].some((x) => x.status === 'downloading') || S.queues.some((q) => q.running));
  set('deleteCompleted', [...S.items.values()].some((x) => x.status === 'complete'));
}

// ---- sidebar -----------------------------------------------------------------------------------

function count(pred) {
  let n = 0;
  for (const it of S.items.values()) if (pred(it)) n++;
  return n;
}

function node(label, ic, nodeDef, opts = {}) {
  const active = JSON.stringify(S.node) === JSON.stringify(nodeDef);
  const el = h('div', {
    class: 'tree-node' + (active ? ' active' : ''), tabindex: '0', role: 'treeitem', style: { paddingLeft: 10 + (opts.depth || 0) * 16 + 'px' },
    onclick: () => {
      if (opts.onClick) return opts.onClick();
      S.node = nodeDef;
      renderSidebar();
      render();
    },
    onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click(),
    oncontextmenu: (e) => {
      e.preventDefault();
      opts.menu && contextMenu(e.clientX, e.clientY, opts.menu());
    },
  },
  opts.twist != null ? h('span', { class: 'twist', onclick: (e) => { e.stopPropagation(); opts.twist(); } }, icon(opts.open ? 'chevDown' : 'chevRight')) : h('span', { class: 'twist' }),
  icon(ic), h('span', { class: 'ellipsis' }, label), opts.running ? h('span', { class: 'dot', title: 'Running' }) : null, opts.count != null ? h('span', { class: 'count' }, opts.count) : null);
  if (opts.dropQueue) {
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-opendm-ids')) {
        e.preventDefault();
        el.classList.add('active');
      }
    });
    el.addEventListener('dragleave', () => el.classList.toggle('active', active));
    el.addEventListener('drop', (e) => {
      const ids = JSON.parse(e.dataTransfer.getData('application/x-opendm-ids') || '[]');
      if (ids.length) {
        api.invoke('q:addItems', opts.dropQueue, ids);
        toast(`Added ${ids.length} to "${label}"`);
      }
    });
  }
  return el;
}

function renderSidebar() {
  const kids = [];
  const t = (k) => () => {
    S.expanded[k] = !S.expanded[k];
    renderSidebar();
  };
  kids.push(h('div', { class: 'sidebar-head' }, 'Categories', h('button', { title: 'Add category', onclick: () => D.categoryDialog() }, icon('plus'))));
  kids.push(node('All Downloads', 'down', { type: 'all' }, { twist: t('all'), open: S.expanded.all, count: S.items.size }));
  if (S.expanded.all) {
    for (const c of S.categories) {
      kids.push(node(c.name, 'folder', { type: 'cat', id: c.id }, {
        depth: 1, count: count((x) => x.category === c.id),
        menu: () => [
          { label: 'Open folder', onClick: () => api.invoke('util:openPath', c.folder) },
          { label: 'Properties…', onClick: () => D.categoryDialog(c) },
          { label: 'Add category…', onClick: () => D.categoryDialog() },
          c.id !== 'general' ? { label: 'Delete category', onClick: () => D.deleteCategory(c) } : null,
        ],
      }));
    }
  }
  kids.push(node('Unfinished', 'pause', { type: 'unfinished' }, { count: count((x) => x.status !== 'complete') }));
  kids.push(node('Finished', 'check', { type: 'finished' }, { count: count((x) => x.status === 'complete') }));

  kids.push(h('div', { class: 'sidebar-head', style: { marginTop: '10px' } }, 'Queues', h('button', { title: 'Create new queue', onclick: () => D.newQueue() }, icon('plus'))));
  for (const q of S.queues) {
    kids.push(node(q.name, q.type === 'sync' ? 'sync' : 'list', { type: 'queue', id: q.id }, {
      count: q.items.length, running: q.running, dropQueue: q.id,
      menu: () => [
        { label: 'Start', disabled: q.running, onClick: () => api.invoke('q:start', q.id) },
        { label: 'Stop', disabled: !q.running, onClick: () => api.invoke('q:stop', q.id) },
        '-',
        { label: 'Edit queue / schedule…', onClick: () => D.schedulerDialog(q.id) },
        { label: 'Create new queue…', onClick: () => D.newQueue() },
        !q.builtin ? { label: 'Delete queue', onClick: async () => (await confirmDialog(`Delete queue "${q.name}"?`, { okLabel: 'Delete', danger: true })) && api.invoke('q:remove', q.id) } : null,
      ],
    }));
  }

  kids.push(h('div', { class: 'sidebar-head', style: { marginTop: '10px' } }, 'Site grabber', h('button', { title: 'New grabber project', onclick: () => api.invoke('win:open', 'grabber', {}) }, icon('plus'))));
  for (const g of S.grabbers) {
    kids.push(node(g.name, 'globe', { type: 'grabber', id: g.id }, {
      running: g.running, count: g.stats?.matched ?? null,
      onClick: () => api.invoke('grabber:open', g.id),
      menu: () => [
        { label: 'Open project', onClick: () => api.invoke('grabber:open', g.id) },
        { label: 'Delete project', onClick: async () => (await confirmDialog(`Delete grabber project "${g.name}"?`, { okLabel: 'Delete', danger: true })) && api.invoke('grabber:delete', g.id) },
      ],
    }));
  }
  if (!S.grabbers.length) kids.push(h('div', { class: 'tree-node muted', onclick: () => api.invoke('win:open', 'grabber', {}) }, h('span', { class: 'twist' }), 'New project…'));
  sidebarEl.replaceChildren(...kids);
}

// ---- table -------------------------------------------------------------------------------------

function visibleItems() {
  let list = [...S.items.values()];
  const n = S.node;
  if (n.type === 'cat') list = list.filter((x) => x.category === n.id);
  else if (n.type === 'unfinished') list = list.filter((x) => x.status !== 'complete');
  else if (n.type === 'finished') list = list.filter((x) => x.status === 'complete');
  else if (n.type === 'queue') {
    const q = S.queues.find((x) => x.id === n.id);
    const order = new Map((q?.items || []).map((id, i) => [id, i]));
    list = list.filter((x) => order.has(x.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    return applyFind(list);
  }
  const { key, dir } = S.settings.appearance.sort;
  const val = (x) => {
    switch (key) {
      case 'name': return (x.fileName || '').toLowerCase();
      case 'size': return x.size ?? -1;
      case 'status': return statusRank(x);
      case 'timeLeft': return x.status === 'downloading' ? x.eta ?? 1e12 : 1e13;
      case 'rate': return x.status === 'downloading' ? x.rate || 0 : -1;
      case 'lastTry': return x.lastTry || 0;
      case 'description': return (x.description || '').toLowerCase();
      case 'saveDir': return (x.saveDir || '').toLowerCase();
      case 'referer': return (x.referer || '').toLowerCase();
      case 'parentPage': return (x.parentPage || '').toLowerCase();
      case 'url': return x.url;
      default: return x.added || 0;
    }
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * (dir === 'desc' ? -1 : 1);
  });
  return applyFind(list);
}

function statusRank(x) {
  return { downloading: 0, error: 1, paused: 2, complete: 3 }[x.status] ?? 4;
}

function applyFind(list) {
  const q = S.find.trim();
  if (!q) return list;
  const o = S.findOpts;
  const norm = (s) => (o.matchCase ? String(s || '') : String(s || '').toLowerCase());
  const needle = norm(q);
  const hit = (s) => (o.whole ? norm(s) === needle : norm(s).includes(needle));
  return list.filter((x) => (o.name && hit(x.fileName)) || (o.description && hit(x.description)) || (o.address && (hit(x.url) || hit(x.referer) || hit(x.parentPage))));
}

function queueMark(it) {
  const qs = S.queues.filter((q) => q.items.includes(it.id));
  if (!qs.length) return '';
  return qs.map((q) => (q.type === 'sync' ? '⟳' : q.builtin ? '≡' : '≣')).join('');
}

function cell(col, it) {
  const st = S.stats.get(it.id);
  switch (col) {
    case 'name': return h('div', { class: 'namecell' }, fileBadge(it.fileName), h('span', { class: 'ellipsis', title: it.fileName }, it.fileName));
    case 'queue': return queueMark(it);
    case 'size': return bytes(it.size) || (it.estimatedSize ? '~' + bytes(it.estimatedSize) : '');
    case 'status': {
      const size = it.size || it.estimatedSize;
      const pct = size ? Math.min(100, (100 * (it.downloaded || 0)) / size) : 0;
      const cls = it.status === 'complete' ? 'status-done' : it.status === 'error' ? 'status-err' : it.status === 'downloading' ? 'status-run' : '';
      return h('span', { class: cls, title: it.statusText || it.error || '' }, it.status !== 'complete' && pct > 0 ? h('span', { class: 'mini-bar' }, h('i', { style: { width: pct + '%' } })) : null, statusText(it));
    }
    case 'timeLeft': return it.status === 'downloading' ? duration(it.eta) : '';
    case 'rate': return it.status === 'downloading' ? rate(it.rate) : '';
    case 'lastTry': return date(it.lastTry);
    case 'added': return date(it.added);
    case 'description': return it.description || '';
    case 'saveDir': return it.saveDir || '';
    case 'referer': return it.referer || '';
    case 'parentPage': return it.parentPage || '';
    case 'url': return it.url;
    case 'connections': return it.status === 'downloading' && st ? String(st.connections?.length || '') : '';
    default: return '';
  }
}

function renderHead() {
  const a = S.settings.appearance;
  headRow.replaceChildren(...a.columns.filter((c) => COLUMNS[c]).map((c) => {
    const w = a.columnWidths[c] || COLUMNS[c].width;
    const sorted = a.sort.key === c || (c === 'name' && a.sort.key === 'name');
    const th = h('th', {
      'data-col': c, style: { width: w + 'px' }, class: sorted ? 'sorted' : '', 'data-dir': a.sort.dir === 'desc' ? '▾' : '▴', draggable: 'true', title: COLUMNS[c].label,
      onclick: (e) => {
        const key = c === 'added' ? 'added' : c;
        if (['queue', 'connections'].includes(c)) return;
        const dir = a.sort.key === key && a.sort.dir === 'asc' ? 'desc' : 'asc';
        api.invoke('settings:save', { appearance: { sort: { key, dir } } });
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          ...Object.entries(COLUMNS).map(([k, v]) => ({
            label: v.label, checked: a.columns.includes(k), disabled: k === 'name',
            onClick: () => api.invoke('settings:replaceList', 'appearance', 'columns', a.columns.includes(k) ? a.columns.filter((x) => x !== k) : [...a.columns, k]),
          })),
          '-', { label: 'Customize columns…', onClick: () => D.columnsDialog(COLUMNS) },
        ]);
      },
    }, COLUMNS[c].label, h('span', { class: 'resizer' }));
    th.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-opendm-col', c));
    th.addEventListener('dragover', (e) => e.dataTransfer.types.includes('application/x-opendm-col') && e.preventDefault());
    th.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('application/x-opendm-col');
      if (!from || from === c) return;
      const cols = a.columns.filter((x) => x !== from);
      cols.splice(cols.indexOf(c), 0, from);
      api.invoke('settings:replaceList', 'appearance', 'columns', cols);
    });
    return th;
  }));
}

let renderQueued = false;
export function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  renderHead();
  const cols = S.settings.appearance.columns.filter((c) => COLUMNS[c]);
  const list = visibleItems();
  rowEls.clear();
  tableBody.replaceChildren(...list.map((it) => {
    const tr = h('tr', { 'data-id': it.id, draggable: 'true', 'aria-selected': S.sel.has(it.id) ? 'true' : 'false' });
    for (const c of cols) {
      const v = cell(c, it);
      tr.append(h('td', { class: COLUMNS[c].num ? 'num' : '', 'data-col': c, title: typeof v === 'string' ? v : null }, v));
    }
    tr.addEventListener('mousedown', (e) => onRowMouse(e, it.id));
    tr.addEventListener('dblclick', () => {
      const x = S.items.get(it.id);
      if (x.status === 'complete') api.invoke('dl:open', it.id);
      else if (x.status === 'downloading') api.invoke('dl:progressWindow', it.id);
      else D.propertiesDialog(it.id);
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!S.sel.has(it.id)) selectOnly(it.id);
      rowMenu(e.clientX, e.clientY);
    });
    tr.addEventListener('dragstart', (e) => {
      if (!S.sel.has(it.id)) selectOnly(it.id);
      e.dataTransfer.setData('application/x-opendm-ids', JSON.stringify([...S.sel]));
      const x = S.items.get(it.id);
      if (x.status === 'complete' && !e.shiftKey) {
        e.preventDefault();
        api.startDrag(it.id);
      }
    });
    rowEls.set(it.id, tr);
    return tr;
  }));
  paintSelection();
  const n = S.node;
  emptyEl.classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    emptyEl.replaceChildren(h('div', {},
      h('div', { class: 'big' }, S.find ? 'No downloads match your search' : n.type === 'queue' ? 'This queue is empty' : 'No downloads yet'),
      h('div', {}, S.find ? 'Try a different name or address.' : n.type === 'queue' ? 'Drag downloads onto the queue in the sidebar to add them.' : 'Click Add URL, drop a link here, or click a download link in your browser.')));
  }
  renderSidebar();
  updateToolbar();
  renderStatus();
}

function updateRow(id, full = false) {
  const tr = rowEls.get(id);
  const it = S.items.get(id);
  if (!it) return;
  if (!tr) {
    if (full) render();
    return;
  }
  if (full) return render();
  for (const td of tr.children) {
    const c = td.dataset.col;
    if (c === 'name' || c === 'description' || c === 'saveDir' || c === 'url' || c === 'referer' || c === 'parentPage' || c === 'added') continue;
    const v = cell(c, it);
    if (typeof v === 'string') {
      if (td.textContent !== v) {
        td.textContent = v;
        td.title = v;
      }
    } else td.replaceChildren(v);
  }
}

function paintSelection() {
  for (const [id, tr] of rowEls) {
    tr.classList.toggle('sel', S.sel.has(id));
    tr.classList.toggle('focus', S.focus === id);
    tr.setAttribute('aria-selected', S.sel.has(id) ? 'true' : 'false');
  }
  updateToolbar();
}

function selectOnly(id) {
  S.sel = new Set([id]);
  S.focus = id;
  S.anchor = id;
  paintSelection();
}

function onRowMouse(e, id) {
  if (e.button === 2 && S.sel.has(id)) return;
  if (e.shiftKey && S.anchor) {
    const ids = [...rowEls.keys()];
    const [a, b] = [ids.indexOf(S.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    S.sel = new Set(ids.slice(a, b + 1));
    S.focus = id;
  } else if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(id)) S.sel.delete(id);
    else S.sel.add(id);
    S.focus = id;
    S.anchor = id;
  } else if (!S.sel.has(id) || e.button === 0) {
    if (e.button === 0 && S.sel.has(id) && S.sel.size > 1) {
      // allow dragging a multi-selection; collapse on mouseup without drag
      const up = () => {
        selectOnly(id);
        removeEventListener('mouseup', up);
      };
      addEventListener('mouseup', up, { once: true });
      addEventListener('dragstart', () => removeEventListener('mouseup', up), { once: true });
      return;
    }
    selectOnly(id);
    return;
  }
  paintSelection();
}

function onKey(e) {
  const ids = [...rowEls.keys()];
  if (e.key === 'Delete') {
    e.preventDefault();
    runCommand(e.shiftKey ? 'deleteFiles' : 'delete');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runCommand(e.altKey ? 'properties' : 'open');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    S.sel = new Set(ids);
    paintSelection();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!ids.length) return;
    let i = ids.indexOf(S.focus);
    i = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
    if (e.shiftKey) {
      S.sel.add(ids[i]);
      S.focus = ids[i];
      paintSelection();
    } else selectOnly(ids[i]);
    rowEls.get(ids[i]).scrollIntoView({ block: 'nearest' });
  } else if (e.key === ' ' && S.focus) {
    e.preventDefault();
    const it = S.items.get(S.focus);
    runCommand(it.status === 'downloading' ? 'stop' : 'resume');
  }
}

function rowMenu(x, y) {
  const sel = selected();
  const one = sel.length === 1 ? sel[0] : null;
  const anyRunning = sel.some((s) => s.status === 'downloading');
  const anyResumable = sel.some((s) => s.status !== 'complete' && s.status !== 'downloading');
  const done = one && one.status === 'complete';
  const queueSub = (verb) => S.queues.map((q) => ({
    label: q.name,
    onClick: () => (verb === 'add' ? api.invoke('q:addItems', q.id, sel.map((s) => s.id)) : api.invoke('q:removeItems', q.id, sel.map((s) => s.id))),
  }));
  contextMenu(x, y, sel.length ? [
    { label: 'Open', disabled: !done, onClick: () => runCommand('open'), kbd: 'Enter' },
    { label: 'Open folder', disabled: !one, onClick: () => runCommand('openFolder') },
    { label: 'Show progress', disabled: !one || one.status !== 'downloading', onClick: () => runCommand('progress') },
    '-',
    { label: 'Resume download', disabled: !anyResumable, onClick: () => runCommand('resume') },
    { label: 'Stop download', disabled: !anyRunning, onClick: () => runCommand('stop') },
    { label: 'Redownload', disabled: !one, onClick: () => runCommand('redownload') },
    { label: 'Refresh download address…', disabled: !one || one.status === 'complete', onClick: () => runCommand('refresh') },
    '-',
    { label: 'Add to queue', sub: queueSub('add') },
    { label: 'Delete from queue', sub: queueSub('remove') },
    '-',
    { label: 'Copy address', onClick: () => runCommand('copyUrl') },
    { label: 'Remove', onClick: () => runCommand('delete'), kbd: 'Del' },
    { label: 'Remove and delete file', disabled: !sel.some((s) => s.status === 'complete'), onClick: () => runCommand('deleteFiles'), kbd: 'Shift+Del' },
    '-',
    { label: 'Properties…', disabled: !one, onClick: () => runCommand('properties'), kbd: 'Alt+Enter' },
  ] : [
    { label: 'Add new download…', onClick: () => runCommand('addUrl') },
    { label: 'Add batch download…', onClick: () => runCommand('batch') },
    { label: 'Paste addresses from clipboard', onClick: () => api.invoke('batch:clipboard') },
    '-',
    { label: 'Select all', onClick: () => { S.sel = new Set(rowEls.keys()); paintSelection(); } },
  ]);
}

function renderStatus() {
  if (!statusEl) return;
  let active = 0, speed = 0;
  for (const it of S.items.values()) if (it.status === 'downloading') {
    active++;
    speed += it.rate || 0;
  }
  const lim = S.settings.speedLimiter;
  const runningQ = S.queues.filter((q) => q.running).map((q) => q.name);
  statusEl.replaceChildren(...[
    h('span', {}, `${S.items.size} downloads`),
    h('span', {}, active ? `${active} active` : 'Idle'),
    speed ? h('span', { class: 'pill' }, rate(speed)) : null,
    lim.enabled ? h('span', { title: 'Speed limiter is on' }, `Limit ${lim.kbps} KB/s`) : null,
    runningQ.length ? h('span', {}, 'Running: ' + runningQ.join(', ')) : null,
    h('span', { class: 'grow' }),
    S.settings.general.browserIntegration ? h('span', { class: 'muted' }, 'Browser integration on') : h('span', { class: 'status-err' }, 'Browser integration off'),
  ].filter(Boolean));
}

// ---- drag & drop of links ---------------------------------------------------------------------

function setupDrop(el) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('text/plain')) {
      if (!e.dataTransfer.types.includes('application/x-opendm-ids') && !e.dataTransfer.types.includes('application/x-opendm-col')) e.preventDefault();
    }
  });
  el.addEventListener('drop', (e) => {
    if (e.dataTransfer.types.includes('application/x-opendm-ids') || e.dataTransfer.types.includes('application/x-opendm-col')) return;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = [...new Set((text.match(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi) || []))];
    if (!urls.length) return;
    e.preventDefault();
    if (urls.length === 1) D.addUrlDialog(urls[0]);
    else api.invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), title: 'Download dropped links' } });
  });
}

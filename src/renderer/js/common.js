// Shared renderer helpers: DOM builder, formatting, icons, modals, menus, theme, sounds.
export const api = window.api;
export const params = new URLSearchParams(location.search);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  stopAll: '<rect x="3.5" y="7.5" width="10" height="10" rx="1.2"/><path d="M8 4.5h10.5a1 1 0 0 1 1 1V16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  sweep: '<path d="M4 7h16M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="m9.5 13 2 2 3.5-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  queuePlay: '<path d="M4 6h10M4 11h10M4 16h6"/><path d="M15 13.5v7l5.5-3.5z"/>',
  queueStop: '<path d="M4 6h10M4 11h10M4 16h6"/><rect x="14.5" y="14" width="6" height="6" rx="1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5S9.5 6.1 12 3.5z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3.5 17.5V7.5a2 2 0 0 1 2-2h4l2 2.2h6a2 2 0 0 1 2 2V11"/><path d="M3.5 17.5 6 11.5h15l-2.6 6a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1z"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  down: '<path d="M12 4v12M6.5 10.5 12 16l5.5-5.5M5 20h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevDown: '<path d="m7 10 5 5 5-5"/>',
  chevRight: '<path d="m10 7 5 5-5 5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  layers: '<path d="m12 3.5 8.5 4.5L12 12.5 3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  sync: '<path d="M20 8a8.5 8.5 0 0 0-15-2.5M4 4v4h4M4 16a8.5 8.5 0 0 0 15 2.5M20 20v-4h-4"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 4-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  downArrow: '<path d="m6 10 6 6 6-6"/>',
  top: '<path d="M6 5h12M8 13l4-4 4 4M12 9v10"/>',
  bottom: '<path d="M6 19h12M8 11l4 4 4-4M12 15V5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L20 9.5M20 4.5v5h-5"/>',
  drop: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="m16 10.5 4.5-2.5v8l-4.5-2.5z"/>',
  power: '<path d="M12 3.5v8M7 6.5a7.5 7.5 0 1 0 10 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---- formatting --------------------------------------------------------------------------------

export function bytes(n, empty = '') {
  if (n == null || !isFinite(n) || n < 0) return empty;
  const u = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(n)} Bytes` : `${n.toFixed(n >= 100 ? 1 : 2)} ${u[i]}`;
}

export function rate(n) {
  return n > 0 ? bytes(n) + '/sec' : '';
}

export function duration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d} d ${hh} h`;
  if (hh) return `${hh} h ${m} min`;
  if (m) return `${m} min ${s} sec`;
  return `${s} sec`;
}

export function date(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

const EXT_COLORS = {
  zip: '#a06a12', rar: '#a06a12', '7z': '#a06a12', gz: '#a06a12', tar: '#a06a12', xz: '#a06a12',
  exe: '#3b5bdb', msi: '#3b5bdb', dmg: '#3b5bdb', apk: '#2b8a3e', deb: '#3b5bdb', iso: '#5f3dc4',
  mp4: '#c2255c', mkv: '#c2255c', webm: '#c2255c', avi: '#c2255c', mov: '#c2255c', ts: '#c2255c', flv: '#c2255c',
  mp3: '#0b7285', m4a: '#0b7285', flac: '#0b7285', wav: '#0b7285', ogg: '#0b7285', aac: '#0b7285',
  pdf: '#c92a2a', doc: '#1864ab', docx: '#1864ab', xls: '#2b8a3e', xlsx: '#2b8a3e', ppt: '#d9480f', pptx: '#d9480f', txt: '#495057',
  jpg: '#862e9c', jpeg: '#862e9c', png: '#862e9c', gif: '#862e9c', webp: '#862e9c',
};

export function fileBadge(name) {
  const ext = extOf(name);
  return h('span', { class: 'ficon', style: { background: EXT_COLORS[ext] || '#6b7280' } }, (ext || '?').slice(0, 4).toUpperCase());
}

/** Running or waiting for a free slot: something "Stop" applies to. */
export function isRunning(it) {
  return it.status === 'downloading' || it.status === 'waiting';
}

export function statusText(it) {
  if (it.status === 'complete') return 'Complete';
  if (it.status === 'waiting') return 'Waiting for a free slot';
  if (it.status === 'error') return 'Error' + (it.error ? ': ' + it.error : '');
  if (it.status === 'downloading') {
    const size = it.size || it.estimatedSize;
    if (size) return `${((100 * (it.downloaded || 0)) / size).toFixed(2)}%`;
    return it.statusText || 'Downloading';
  }
  if (it.statusText && /limit/i.test(it.statusText)) return it.statusText;
  const size = it.size || it.estimatedSize;
  return it.downloaded > 0 && size ? `${((100 * it.downloaded) / size).toFixed(1)}% — paused` : it.downloaded > 0 ? 'Paused' : 'Queued';
}

// ---- theme / sounds ----------------------------------------------------------------------------

export function applyAppearance(settings) {
  const a = settings.appearance;
  if (a.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', a.theme);
  document.documentElement.style.setProperty('--fs', a.fontSize + 'px');
  document.documentElement.style.setProperty('--row', Math.round(a.fontSize * 2) + 'px');
}

let actx;
export function playSound(kind, settings) {
  const s = settings.sounds;
  if (!s || !s[kind]) return;
  actx = actx || new AudioContext();
  const notes = { complete: [660, 880, 1320], failed: [440, 330], queueDone: [523, 659, 784, 1046] }[kind] || [660];
  notes.forEach((f, i) => {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = actx.currentTime + i * 0.12;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.volume ?? 0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.3);
  });
}

// ---- toast / modal / context menu --------------------------------------------------------------

export function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/**
 * Opens a modal. body: Node; buttons: [{label, primary, onClick(close) -> false keeps open}].
 * Returns { close, el }.
 */
export function modal({ title, body, buttons = [], wide = false, leftButtons = [], onClose }) {
  const close = () => {
    bd.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const mkBtn = (b) => h('button', {
    class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
    onclick: async () => {
      const r = await b.onClick?.(close);
      if (r !== false) close();
    },
  }, b.label);
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, title, h('button', { class: 'x', title: 'Close', onclick: close }, icon('x'))),
    body,
    buttons.length || leftButtons.length ? h('div', { class: 'modal-foot' }, h('div', { class: 'left' }, leftButtons.map(mkBtn)), buttons.map(mkBtn)) : null);
  if (!body.classList.contains('split') && !body.classList.contains('modal-body') && !body.classList.contains('col-fill')) body.classList.add('modal-body');
  const bd = h('div', { class: 'backdrop', onmousedown: (e) => e.target === bd && close() }, box);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.closest('.listbox')) {
      const p = box.querySelector('.modal-foot .btn.primary');
      if (p && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        p.click();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(bd);
  setTimeout(() => box.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea')?.focus(), 0);
  return { close, el: box };
}

export function confirmDialog(message, { okLabel = 'OK', danger = false, detail = '', check } = {}) {
  return new Promise((resolve) => {
    let cb;
    const body = h('div', { class: 'col' }, h('div', {}, message), detail ? h('div', { class: 'hint' }, detail) : null, check ? h('label', { class: 'check' }, (cb = h('input', { type: 'checkbox' })), check) : null);
    let result = null;
    modal({
      title: 'OpenDM', body,
      buttons: [{ label: 'Cancel', onClick: () => (result = null) }, { label: okLabel, primary: !danger, danger, onClick: () => (result = { ok: true, checked: cb?.checked }) }],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value });
    let result = null;
    modal({ title, body: h('div', { class: 'col' }, h('label', {}, label), input), buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => (result = input.value) }], onClose: () => resolve(result) });
  });
}

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('blur', closeMenu);

/**
 * Lets the user drag a header cell's right edge to resize its column. Adds a grip to every
 * current header cell; headers rendered later should include their own `span.resizer`.
 * onResize(th, width) runs once a drag ends. Returns the table.
 */
export function resizableColumns(table, onResize) {
  for (const th of table.querySelectorAll('thead th')) if (!th.querySelector('.resizer')) th.append(h('span', { class: 'resizer' }));
  table.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('th > .resizer');
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = grip.parentElement, startX = e.clientX, startW = th.offsetWidth, draggable = th.draggable;
    // Header cells may be draggable for reordering; that would hijack the gesture.
    th.draggable = false;
    grip.setPointerCapture(e.pointerId);
    table.classList.add('resizing');
    const move = (ev) => (th.style.width = Math.max(30, startW + ev.clientX - startX) + 'px');
    grip.addEventListener('pointermove', move);
    grip.addEventListener('lostpointercapture', () => {
      grip.removeEventListener('pointermove', move);
      th.draggable = draggable;
      table.classList.remove('resizing');
      if (th.offsetWidth !== startW) onResize?.(th, th.offsetWidth);
    }, { once: true });
  });
  // Swallow the click that ends a drag so it doesn't sort the column.
  table.addEventListener('click', (e) => e.target.closest('th > .resizer') && e.stopPropagation(), true);
  return table;
}

/** items: [{label, onClick, disabled, checked, kbd, sub:[...]} | '-'] */
export function contextMenu(x, y, items) {
  closeMenu();
  const build = (list) => h('div', { class: 'ctx', role: 'menu' }, list.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'sep' });
    const mi = h('div', { class: 'mi' + (it.disabled ? ' disabled' : '') + (it.sub ? ' sub' : ''), role: 'menuitem' },
      h('span', { class: 'chk' }, it.checked ? '✓' : ''), it.label, it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null);
    if (it.sub) {
      let subEl = null;
      mi.addEventListener('mouseenter', () => {
        mi.parentElement.querySelectorAll(':scope > .ctx').forEach((n) => n.remove());
        subEl = build(it.sub);
        const r = mi.getBoundingClientRect();
        mi.parentElement.append(subEl);
        const pr = mi.parentElement.getBoundingClientRect();
        subEl.style.left = (r.right - pr.left - 4) + 'px';
        subEl.style.top = (r.top - pr.top - 4) + 'px';
        subEl.style.position = 'absolute';
      });
    } else {
      mi.addEventListener('mouseenter', () => mi.parentElement.querySelectorAll(':scope > .ctx').forEach((n) => n.remove()));
      mi.addEventListener('click', () => {
        if (it.disabled) return;
        closeMenu();
        it.onClick?.();
      });
    }
    return mi;
  }));
  const m = build(items);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = Math.max(4, innerWidth - r.width - 4) + 'px';
  if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 4) + 'px';
  openMenu = m;
  return m;
}

export function tabs(defs, initial) {
  // defs: [{id, label, render: () => Node}] → {el, show(id)}
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'pane' });
  const show = (id) => {
    for (const b of bar.children) b.classList.toggle('active', b.dataset.id === id);
    body.replaceChildren(defs.find((d) => d.id === id).render());
  };
  for (const d of defs) bar.append(h('button', { class: 'tab', 'data-id': d.id, role: 'tab', onclick: () => show(d.id) }, d.label));
  show(initial || defs[0].id);
  return { bar, body, show };
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), hint ? h('div', { class: 'col', style: { gap: '3px' } }, control, h('div', { class: 'hint' }, hint)) : control);
}

export function check(label, value, onChange) {
  const cb = h('input', { type: 'checkbox', checked: value, onchange: (e) => onChange?.(e.target.checked) });
  return h('label', { class: 'check' }, cb, label);
}

export function select(options, value, onChange) {
  return h('select', { onchange: (e) => onChange?.(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

export function folderInput(value, onChange) {
  const inp = h('input', { type: 'text', value, class: 'grow', oninput: (e) => onChange(e.target.value) });
  return h('div', { class: 'row' }, inp, h('button', {
    class: 'btn', title: 'Browse', onclick: async () => {
      const d = await api.invoke('dialog:folder', inp.value);
      if (d) {
        inp.value = d;
        onChange(d);
      }
    },
  }, icon('folder'), 'Browse…'));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

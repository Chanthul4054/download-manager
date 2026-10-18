import { api, h, icon, bytes, params, check, select, field, folderInput, applyAppearance, toast, modal, fileBadge, confirmDialog } from './common.js';

const STEPS = ['Start page', 'Save files', 'Pages to explore', 'Files to download', 'Explore & download'];
const PRESETS = [['images', 'Images'], ['audio', 'Audio'], ['video', 'Video'], ['documents', 'Documents'], ['archives', 'Archives'], ['programs', 'Programs'], ['all', 'All files']];

export async function mountGrabber(root) {
  const st = await api.invoke('state');
  applyAppearance(st.settings);
  api.on('settings', applyAppearance);
  const presets = st.grabberPresets;
  let p = params.get('project') ? await api.invoke('grabber:get', params.get('project')) : null;
  let step = p && p.results.files.length ? 4 : 0;
  let running = false;
  let pageFilter = null;
  let fileSel = new Set();

  const stepsEl = h('div', { class: 'wizard-steps' });
  const body = h('div', { class: 'pane', style: { padding: '16px 20px' } });
  const backBtn = h('button', { class: 'btn', onclick: () => go(step - 1) }, '‹ Back');
  const nextBtn = h('button', { class: 'btn primary', onclick: () => go(step + 1) }, 'Next ›');
  const projSel = h('select', { style: { minWidth: '200px' } });
  const head = h('div', { class: 'toolbar small', style: { alignItems: 'center', gap: '8px' } },
    h('span', { class: 'muted' }, 'Project'), projSel,
    h('button', { class: 'tb-btn', onclick: () => newProject() }, icon('plus'), h('span', { class: 'lbl' }, 'New')),
    h('button', { class: 'tb-btn', onclick: () => save().then(() => toast('Project saved')) }, icon('check'), h('span', { class: 'lbl' }, 'Save')),
    h('button', { class: 'tb-btn', onclick: () => saveAsTemplate() }, icon('copy'), h('span', { class: 'lbl' }, 'Save as copy')),
    h('button', { class: 'tb-btn', onclick: () => scheduleDialog() }, icon('clock'), h('span', { class: 'lbl' }, 'Schedule')),
    h('button', { class: 'tb-btn', onclick: () => deleteProject() }, icon('trash'), h('span', { class: 'lbl' }, 'Delete')),
    h('span', { class: 'grow' }),
    h('button', { class: 'tb-btn', title: 'Open the main window (Help → Grabber help)', onclick: () => api.invoke('win:showMain') }, icon('info'), h('span', { class: 'lbl' }, 'Main window')));
  root.append(head, stepsEl, h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, body), h('div', { class: 'modal-foot' }, backBtn, nextBtn));

  async function refreshProjects() {
    const list = await api.invoke('grabber:list');
    projSel.replaceChildren(...list.map((x) => h('option', { value: x.id, selected: p && x.id === p.id }, x.name)));
    if (!list.length) projSel.append(h('option', { value: '' }, '(new project)'));
  }
  projSel.onchange = async () => {
    await save();
    p = await api.invoke('grabber:get', projSel.value);
    step = p.results.files.length ? 4 : 0;
    paint();
  };

  async function newProject() {
    if (p) await save();
    p = await api.invoke('grabber:new', { name: 'Project ' + new Date().toLocaleDateString() });
    step = 0;
    await refreshProjects();
    paint();
  }

  async function save() {
    if (!p) return;
    p = await api.invoke('grabber:save', p);
    await refreshProjects();
  }

  async function saveAsTemplate() {
    if (!p) return;
    await save();
    const { id, results, stats, ...rest } = p;
    p = await api.invoke('grabber:new', { ...rest, name: rest.name + ' (copy)' });
    step = 0;
    await refreshProjects();
    paint();
  }

  async function deleteProject() {
    if (!p || !(await confirmDialog(`Delete project "${p.name}"?`, { okLabel: 'Delete', danger: true }))) return;
    await api.invoke('grabber:delete', p.id);
    p = null;
    await newProject();
  }

  async function go(n) {
    if (n < 0 || n >= STEPS.length) return;
    if (step === 0 && n > 0 && !/^https?:\/\//i.test(p.startUrl)) return toast('Enter a start page that begins with http:// or https://');
    await save();
    step = n;
    paint();
  }

  function paint() {
    stepsEl.replaceChildren(...STEPS.map((s, i) => h('div', { class: 'st' + (i === step ? ' active' : i < step ? ' done' : ''), onclick: () => (i <= 4 && p.startUrl ? go(i) : null) }, h('b', {}, String(i + 1)), s)));
    backBtn.disabled = step === 0;
    nextBtn.classList.toggle('hidden', step === 4);
    body.replaceChildren(...[step0, step1, step2, step3, step4][step]());
    api.invoke('win:setTitle', `Site Grabber — ${p.name}`);
  }

  const txt = (k, attrs = {}) => h('input', { type: 'text', value: p[k] ?? '', class: 'grow', ...attrs, oninput: (e) => (p[k] = e.target.value) });
  const num = (k, attrs = {}) => h('input', { type: 'number', value: p[k], ...attrs, oninput: (e) => (p[k] = Number(e.target.value)) });

  function step0() {
    const auth = p.auth || { user: '', pass: '' };
    return [
      h('div', { class: 'hint' }, 'Enter the web page where the grabber starts. It reads this page, follows links within the limits you set, and collects files that match your filters.'),
      field('Project name', txt('name')),
      field('Start page', txt('startUrl', { type: 'url', placeholder: 'https://example.com/gallery/index.html' })),
      h('fieldset', {}, h('legend', {}, 'Login (if the site needs one)'), h('div', { class: 'row' },
        h('input', { type: 'text', placeholder: 'User', value: auth.user, oninput: (e) => { p.auth = { ...(p.auth || {}), user: e.target.value, pass: p.auth?.pass || '' }; if (!e.target.value) p.auth = null; } }),
        h('input', { type: 'password', placeholder: 'Password', value: auth.pass, oninput: (e) => { if (p.auth) p.auth.pass = e.target.value; } }))),
    ];
  }

  function step1() {
    return [
      field('Save files to', folderInput(p.saveDir, (v) => (p.saveDir = v))),
      field('Category', select(st.categories.map((c) => [c.id, c.name]), p.category, (v) => (p.category = v))),
      check('Keep the site folder structure (save into host/folder/… subfolders)', p.useSubfolders, (v) => (p.useSubfolders = v)),
      check('Overwrite existing files', p.overwrite, (v) => (p.overwrite = v)),
      h('div', { class: 'row' }, 'Explore', num('concurrentExplore', { min: 1, max: 16 }), 'pages and download', num('concurrentDownload', { min: 1, max: 16 }), 'files at the same time'),
    ];
  }

  function step2() {
    return [
      h('div', { class: 'hint' }, 'Set which web pages are explored to look for files. Level 0 explores only the start page; level 1 also explores pages it links to, and so on.'),
      h('div', { class: 'row' }, h('span', { style: { width: '230px' } }, 'Levels to explore on this site'), num('levelsThis', { min: 0, max: 20 })),
      h('div', { class: 'row' }, h('span', { style: { width: '230px' } }, 'Levels to explore on other sites'), num('levelsOther', { min: 0, max: 5 }), h('span', { class: 'hint' }, 'Keep this low — other sites can add thousands of pages.')),
      check("Don't explore parent folders of the start page", p.dontExploreParent, (v) => (p.dontExploreParent = v)),
      check('Explore all sites within the main domain (sub-domains)', p.exploreMainDomain, (v) => (p.exploreMainDomain = v)),
      field('Only explore pages matching', txt('pageInclude', { placeholder: 'example.com/gallery/*' }), 'Patterns separated by spaces or commas; * matches anything.'),
      field("Don't explore pages matching", txt('pageExclude', { placeholder: '*/login* */cart*' })),
    ];
  }

  function step3() {
    const current = new Set(p.fileTypes.split(',').map((s) => s.trim()).filter(Boolean));
    const area = h('textarea', { rows: 3, class: 'mono', oninput: (e) => (p.fileTypes = e.target.value) }, p.fileTypes);
    const presetBoxes = PRESETS.map(([k, label]) => check(label, presets[k].split(',').every((x) => current.has(x)), (on) => {
      const set = new Set(p.fileTypes.split(',').map((s) => s.trim()).filter(Boolean));
      for (const x of presets[k].split(',')) on ? set.add(x) : set.delete(x);
      p.fileTypes = [...set].join(',');
      area.value = p.fileTypes;
    }));
    return [
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px 16px' } }, presetBoxes),
      field('File types', area, 'Comma-separated patterns, e.g. *.jpg,image*.png'),
      field('Exclude file types', txt('fileExcludeTypes', { placeholder: '*thumb*.jpg' })),
      check('Only collect files located on this site', p.thisSiteOnly, (v) => (p.thisSiteOnly = v)),
      check('Hide duplicate files found in different locations (same name and size)', p.hideDuplicates, (v) => (p.hideDuplicates = v)),
      h('div', { class: 'row' }, 'Size from', num('minSizeKB', { min: 0 }), 'KB to', num('maxSizeKB', { min: 0 }), 'KB', h('span', { class: 'hint' }, '0 = no limit')),
      field('Only from paths', txt('pathInclude', { placeholder: 'cdn.example.com/*' })),
      field('Not from paths', txt('pathExclude', { placeholder: '*/ads/*' })),
      check('Start downloading all matched files right away', p.startDownloadAll, (v) => (p.startDownloadAll = v)),
    ];
  }

  function step4() {
    const s = p.stats || {};
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v ?? 0)), h('div', { class: 'k' }, k));
    const files = p.results.files.filter((f) => !pageFilter || f.page === pageFilter);
    const pagesBox = h('div', { class: 'listbox', style: { width: '280px', flex: 'none' } },
      h('div', { class: 'li' + (!pageFilter ? ' sel' : ''), onclick: () => { pageFilter = null; paint(); } }, icon('layers'), h('b', {}, `All files (${p.results.files.length})`)),
      p.results.pages.map((pg) => h('div', { class: 'li' + (pageFilter === pg.url ? ' sel' : ''), title: `${pg.url}\n${pg.status}`, style: { paddingLeft: 8 + Math.min(pg.level, 8) * 12 + 'px' }, onclick: () => { pageFilter = pg.url; paint(); } },
        icon(pg.status === 'explored' ? 'file' : pg.status === 'exploring' ? 'refresh' : pg.status?.startsWith('error') ? 'x' : 'clock'),
        h('span', { class: 'ellipsis' }, pg.title || pg.url.replace(/^https?:\/\//, '')))));
    const tbody = h('tbody', {}, files.map((f) => h('tr', {
      class: fileSel.has(f.url) ? 'sel' : '',
      onclick: (e) => { if (e.target.tagName === 'INPUT') return; if (!e.ctrlKey) fileSel.clear(); fileSel.add(f.url); paint(); },
      oncontextmenu: (e) => {
        e.preventDefault();
        import('./common.js').then(({ contextMenu }) => contextMenu(e.clientX, e.clientY, [
          { label: 'Open', disabled: !f.savedPath, onClick: () => api.invoke('util:openPath', f.savedPath) },
          { label: 'Copy address', onClick: () => api.invoke('clip:write', f.url) },
          { label: 'Copy referer (page)', onClick: () => api.invoke('clip:write', f.page) },
          { label: 'Download this file', onClick: () => api.invoke('grabber:run', p.id, 'download') },
        ]));
      },
    },
    h('td', {}, h('input', { type: 'checkbox', checked: f.checked, onchange: async (e) => { f.checked = e.target.checked; await api.invoke('grabber:setChecked', p.id, [f.url], f.checked); } })),
    h('td', {}, h('div', { class: 'namecell' }, fileBadge(f.url.split('?')[0]), h('span', { class: 'ellipsis' }, decodeURIComponent(f.url.split('?')[0].split('/').pop() || f.url)))),
    h('td', { class: 'num' }, bytes(f.size)),
    h('td', { class: f.status === 'downloaded' ? 'status-done' : f.status === 'failed' ? 'status-err' : f.status === 'downloading' ? 'status-run' : '' }, f.status),
    h('td', { title: f.description }, f.description || ''),
    h('td', { class: 'mono', title: f.url }, f.url))));
    const bar = h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', disabled: running, onclick: async () => { await save(); running = true; api.invoke('grabber:run', p.id, 'explore'); paint(); } }, icon('search'), 'Start exploring'),
      h('button', { class: 'btn', disabled: !running, onclick: () => api.invoke('grabber:stop', p.id) }, icon('stop'), 'Stop'),
      h('span', { class: 'tb-sep', style: { height: '22px' } }),
      h('button', { class: 'btn', onclick: async () => { p = await api.invoke('grabber:setChecked', p.id, pageFilter ? files.map((f) => f.url) : [], true); paint(); } }, 'Check all'),
      h('button', { class: 'btn', onclick: async () => { p = await api.invoke('grabber:setChecked', p.id, pageFilter ? files.map((f) => f.url) : [], false); paint(); } }, 'Uncheck all'),
      h('span', { class: 'tb-sep', style: { height: '22px' } }),
      h('button', { class: 'btn', disabled: running, onclick: async () => { await save(); running = true; api.invoke('grabber:run', p.id, 'download'); paint(); } }, icon('down'), 'Download checked'),
      h('button', {
        class: 'btn', onclick: async () => {
          const n = await api.invoke('grabber:addToList', p.id, 'main');
          toast(`Added ${n} files to the main list and download queue`);
        },
      }, icon('list'), 'Add checked to main list'));
    return [
      bar,
      h('div', { class: 'statgrid' }, stat('Pages found', s.pagesFound), stat('Pages explored', s.explored), stat('Files found', s.filesFound), stat('Matched', s.matched), stat('Downloaded', s.downloaded), stat('Errors', s.errors)),
      h('div', { class: 'row', style: { flex: 1, minHeight: '220px', alignItems: 'stretch' } }, pagesBox,
        h('div', { class: 'table-wrap', style: { border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--surface)' } },
          h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: { width: '32px' } }, ''), h('th', { style: { width: '220px' } }, 'File'), h('th', { style: { width: '90px' } }, 'Size'), h('th', { style: { width: '100px' } }, 'Status'), h('th', { style: { width: '160px' } }, 'Description'), h('th', { style: { width: '360px' } }, 'Address'))), tbody),
          files.length ? null : h('div', { class: 'empty' }, h('div', {}, h('div', { class: 'big' }, running ? 'Exploring…' : 'No files yet'), h('div', {}, running ? 'Matching files appear here as they are found.' : 'Click "Start exploring" to search the site.'))))),
    ];
  }

  function scheduleDialog() {
    if (!p) return;
    const s = { ...p.schedule, days: [...(p.schedule?.days || [])] };
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    modal({
      title: 'Schedule the project',
      body: h('div', { class: 'col' },
        check('Run this project on a schedule', s.enabled, (v) => (s.enabled = v)),
        field('Action', select([['explore', 'Explore the site only'], ['explore-download', 'Explore and download all matched files'], ['download', 'Download checked files']], s.action, (v) => (s.action = v))),
        field('Start at', h('input', { type: 'time', value: s.startTime, oninput: (e) => (s.startTime = e.target.value) })),
        field('On', h('div', { class: 'row', style: { flexWrap: 'wrap' } }, DAYS.map((d, i) => check(d, s.days.includes(i), (v) => (s.days = v ? [...new Set([...s.days, i])] : s.days.filter((x) => x !== i)))))),
        field('Synchronize every', h('div', { class: 'row' }, h('input', { type: 'number', min: 0, value: s.periodicMinutes, oninput: (e) => (s.periodicMinutes = Number(e.target.value)) }), 'minutes', h('span', { class: 'hint' }, '0 = run once; periodic runs replace changed files'))),
        h('div', { class: 'row' }, check('Stop at', s.stopEnabled, (v) => (s.stopEnabled = v)), h('input', { type: 'time', value: s.stopTime, oninput: (e) => (s.stopTime = e.target.value) }))),
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: async () => { p.schedule = s; await save(); } }],
    });
  }

  api.on('grabber:update', (id, proj) => {
    if (!p || id !== p.id) return;
    p = proj;
    if (step === 4) throttledPaint();
  });
  api.on('grabber:done', async (id) => {
    if (!p || id !== p.id) return;
    running = false;
    p = await api.invoke('grabber:get', p.id);
    if (step === 4) paint();
    toast('Grabber finished');
  });
  api.on('grabber:error', (id, msg) => {
    if (p && id === p.id) {
      running = false;
      toast(msg);
      paint();
    }
  });
  let pt = null;
  const throttledPaint = () => {
    if (pt) return;
    pt = setTimeout(() => {
      pt = null;
      const scroll = body.querySelector('.table-wrap')?.scrollTop;
      paint();
      const tw = body.querySelector('.table-wrap');
      if (tw && scroll) tw.scrollTop = scroll;
    }, 400);
  };

  if (!p) await newProject();
  else {
    const list = await api.invoke('grabber:list');
    running = !!list.find((x) => x.id === p.id)?.running;
    await refreshProjects();
    paint();
  }
}

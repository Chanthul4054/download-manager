import * as React from 'react';
import { ChevronDown, ChevronRight, CircleX, Download, Eraser, Folder, Layers, Link2, MoreHorizontal, Plus, RefreshCw, SearchX, Settings2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { invoke, on } from '@/services/ipc';
import { saveSettings, useApp } from '@/stores/app';
import { copyText } from '@/app/commands';
import { confirm, prompt } from '@/components/dialogs/confirm';
import { PageHeader, Divider, ToolButton } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NumberInput, Textarea } from '@/components/ui/input';
import { Checkbox, CheckField, Select } from '@/components/ui/controls';
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu';
import { Dialog } from '@/components/ui/overlay';
import { EmptyState, Field, FileIcon, Section, Row } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { bytes } from '@/utils/format';
import { FILE_TYPE_LABELS, typeOfName, type FileType } from '@/utils/files';
import { cn } from '@/utils/cn';
import type { LgLink, LgPackage, LgState, LinkStatus, Settings } from '@/types/models';

const STATUS: [LinkStatus, string][] = [
  ['online', 'Online'],
  ['unknown', 'Not checked'],
  ['offline', 'Offline'],
  ['checking', 'Checking'],
];
const STATUS_TONE: Record<LinkStatus, string> = { online: 'text-ok', offline: 'text-danger', checking: 'text-info', unknown: 'text-fg-3' };
const COLS = [
  ['name', 'Name', 340],
  ['size', 'Size', 90],
  ['host', 'Host', 150],
  ['status', 'Status', 170],
  ['saveDir', 'Save to', 200],
  ['url', 'Address', 320],
] as const;
type Col = (typeof COLS)[number][0];

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const typeOf = (l: LgLink): FileType => (/html/.test(l.type || '') ? 'other' : typeOfName(l.name));
type Hidden = { host: Set<string>; type: Set<string>; status: Set<string> };

/** The waiting area: links are checked online and grouped into packages before they become downloads. */
export function LinkGrabberPage() {
  const lgs = useApp((s) => s.settings.linkGrabber);
  const queues = useApp((s) => s.queues);
  const [data, setData] = React.useState<LgState>({ packages: [], busy: false, pending: 0 });
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [hidden, setHidden] = React.useState<Hidden>({ host: new Set(), type: new Set(), status: new Set() });
  const [queueId, setQueueId] = React.useState(lgs.queueId ?? 'main');
  const [startNow, setStartNow] = React.useState(lgs.autoStart);
  const [dialog, setDialog] = React.useState<'add' | 'settings' | null>(null);
  const [widths, setWidths] = React.useState<Record<string, number>>(() => ({ ...Object.fromEntries(COLS.map(([k, , w]) => [k, w])), ...lgs.columnWidths }));

  React.useEffect(() => {
    void invoke('lg:state').then(setData);
    return on('lg:changed', (d) => {
      setData(d);
      const ids = new Set([...d.packages.map((p) => p.id), ...d.packages.flatMap((p) => p.links.map((l) => l.id))]);
      setSel((s) => new Set([...s].filter((id) => ids.has(id))));
    });
  }, []);

  const q = search.trim().toLowerCase();
  const visibleLink = React.useCallback((l: LgLink) => !hidden.host.has(l.host) && !hidden.type.has(typeOf(l)) && !hidden.status.has(l.status) && (!q || `${l.name} ${l.url}`.toLowerCase().includes(q)), [hidden, q]);
  const visible = React.useMemo(() => data.packages.map((p) => ({ p, links: p.links.filter(visibleLink) })).filter((x) => x.links.length), [data, visibleLink]);
  const all = React.useMemo(() => data.packages.flatMap((p) => p.links), [data]);
  // shortcut: renders every visible row; fine for hundreds of links, window it if lists reach many thousands.
  const rows = React.useMemo(() => visible.flatMap(({ p, links }) => [{ id: p.id, p, links }, ...(p.expanded ? links.map((l) => ({ id: l.id, p, l })) : [])]) as ({ id: string; p: LgPackage; links: LgLink[]; l?: undefined } | { id: string; p: LgPackage; l: LgLink; links?: undefined })[], [visible]);

  // Selected packages count as all their visible links.
  const selection = () => [...sel].flatMap((id) => {
    const p = data.packages.find((x) => x.id === id);
    return p ? p.links.filter(visibleLink).map((l) => l.id) : [id];
  });

  const click = (id: string, e: React.MouseEvent) => {
    const ids = rows.map((r) => r.id);
    if (e.shiftKey && anchor) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      setSel(new Set([...(e.ctrlKey ? sel : []), ...ids.slice(a, b + 1)]));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel);
      n.has(id) ? n.delete(id) : n.add(id);
      setSel(n);
    } else setSel(new Set([id]));
    setAnchor(id);
  };

  const opts = (extra: object = {}) => ({ queueId: queueId || undefined, start: startNow, ...extra });
  const confirmLinks = async (ids: string[] | null, extra: object = {}) => {
    const chosen = ids ?? visible.flatMap((x) => x.links.map((l) => l.id));
    if (!chosen.length) return toast('Nothing to add');
    const o = opts(extra) as ReturnType<typeof opts> & { start: boolean };
    const added = await invoke('lg:confirm', chosen, o);
    setSel(new Set());
    toast(added.length ? `Added ${added.length} download${added.length > 1 ? 's' : ''}${o.start ? ' and started them' : ''}` : 'Nothing was added — the links are offline, unchecked or already in the list');
  };
  const removeSelected = async () => {
    const ids = selection();
    if (!ids.length) return;
    await invoke('lg:remove', ids);
    setSel(new Set());
  };
  const renamePackage = async (p: LgPackage) => {
    const name = await prompt('Rename package', 'Package name', p.name, 'Rename');
    if (name?.trim()) void invoke('lg:updatePackage', p.id, { name: name.trim() });
  };
  const renameLink = async (l: LgLink) => {
    const name = await prompt('Rename file', 'File name', l.name, 'Rename');
    if (name?.trim()) void invoke('lg:renameLink', l.id, name.trim());
  };
  const toggle = (p: LgPackage) => void invoke('lg:updatePackage', p.id, { expanded: !p.expanded });

  const menu = (): MenuEntry[] => {
    const ids = selection();
    const pkgs = [...sel].map((id) => data.packages.find((p) => p.id === id)).filter((p): p is LgPackage => !!p);
    const links = all.filter((l) => ids.includes(l.id));
    if (!sel.size) return [{ label: 'Add links…', icon: Plus, onSelect: () => setDialog('add') }];
    return [
      { label: 'Start downloads', icon: Download, onSelect: () => confirmLinks(ids, { start: true }) },
      { label: 'Add to download list', onSelect: () => confirmLinks(ids, { start: false }) },
      { label: 'Add including offline and duplicates', onSelect: () => confirmLinks(ids, { includeOffline: true, includeDupes: true, includeDisabled: true }) },
      '-',
      { label: 'Enable', onSelect: () => invoke('lg:enable', ids, true) },
      { label: 'Disable', onSelect: () => invoke('lg:enable', ids, false) },
      { label: 'Check again', icon: RefreshCw, onSelect: () => invoke('lg:recheck', ids) },
      '-',
      { label: 'Rename…', disabled: sel.size !== 1, onSelect: () => (pkgs[0] ? renamePackage(pkgs[0]) : links[0] && renameLink(links[0])) },
      {
        label: 'Set save folder…',
        icon: Folder,
        disabled: !pkgs.length,
        onSelect: async () => {
          const d = await invoke('dialog:folder', pkgs[0].saveDir || undefined);
          if (d) for (const p of pkgs) void invoke('lg:updatePackage', p.id, { saveDir: d });
        },
      },
      { label: 'Use the default save folder', disabled: !pkgs.some((p) => p.saveDir), onSelect: () => pkgs.forEach((p) => invoke('lg:updatePackage', p.id, { saveDir: '' })) },
      {
        label: 'Move to a new package…',
        icon: Layers,
        disabled: !ids.length,
        onSelect: async () => {
          const name = await prompt('New package', 'Package name', pkgs[0]?.name || '', 'Move');
          if (name != null) {
            await invoke('lg:merge', ids, name);
            setSel(new Set());
          }
        },
      },
      { label: 'Split packages by host', disabled: !ids.length, onSelect: () => invoke('lg:splitByHost', ids) },
      '-',
      { label: 'Open in browser', disabled: links.length !== 1, onSelect: () => invoke('util:openExternal', links[0].url) },
      { label: 'Copy addresses', disabled: !links.length, onSelect: () => copyText(links.map((l) => l.url).join('\n'), 'Addresses copied') },
      '-',
      { label: 'Remove', icon: Trash2, kbd: 'Del', danger: true, disabled: !ids.length, onSelect: removeSelected },
    ];
  };

  const shown = visible.flatMap((x) => x.links).filter((l) => l.enabled);
  const online = all.filter((l) => l.status === 'online').length;
  const tpl = COLS.map(([k]) => `${widths[k]}px`).join(' ');
  const resize = (k: Col, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[k];
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(50, w0 + ev.clientX - x0);
      setWidths((s) => ({ ...s, [k]: w }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      void saveSettings({ linkGrabber: { columnWidths: { [k]: Math.round(w) } } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      <PageHeader title="LinkGrabber" icon={Link2} subtitle={all.length ? `${plural(data.packages.length, 'package')} · ${plural(all.length, 'link')}` : undefined}>
        <ToolButton icon={Plus} label="Add links" tip="Paste or type addresses to collect" onClick={() => setDialog('add')} primary />
        <ToolButton icon={RefreshCw} label="Check again" tip="Check the selected links online again" disabled={!sel.size} onClick={() => invoke('lg:recheck', selection())} />
        <Divider />
        <ToolButton icon={Trash2} label="Remove" tip="Remove the selected links" disabled={!sel.size} onClick={removeSelected} />
        <ToolButton icon={Settings2} label="Settings" tip="LinkGrabber settings" onClick={() => setDialog('settings')} />
        <DropdownMenu
          align="end"
          items={[
            { label: 'Remove offline links', icon: CircleX, disabled: !all.some((l) => l.status === 'offline'), onSelect: () => invoke('lg:removeOffline') },
            { label: 'Clear list…', icon: Eraser, danger: true, disabled: !all.length, onSelect: async () => (await confirm('Remove all links from the LinkGrabber?', { okLabel: 'Clear', danger: true })) && invoke('lg:clear') },
          ]}
          trigger={
            <Button variant="ghost" size="icon" aria-label="More actions" className="text-fg-2">
              <MoreHorizontal />
            </Button>
          }
        />
        <div className="relative ml-2 w-56">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} placeholder="Search names and addresses" aria-label="Search names and addresses" className="h-7 pr-7" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {all.length > 0 && <Filters links={all} hidden={hidden} setHidden={setHidden} />}
        <ContextMenu items={menu}>
          <div
            className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
            tabIndex={0}
            onMouseDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest('[data-row]') && setSel(new Set())}
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).tagName === 'INPUT') return;
              if (e.key === 'Delete') void removeSelected();
              else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setSel(new Set(rows.map((r) => r.id)));
              } else if (e.key === 'Enter' && sel.size) void confirmLinks(selection());
            }}
          >
            {!rows.length ? (
              all.length ? (
                <EmptyState icon={SearchX} title="No links match the filters" className="h-full">
                  Change the filters on the left or the search text.
                </EmptyState>
              ) : (
                <EmptyState icon={Link2} title="No links collected" className="h-full" action={<Button variant="primary" onClick={() => setDialog('add')}><Plus />Add links</Button>}>
                  Paste addresses, copy them to the clipboard, or use “Download all links” in the browser. Links are checked online and grouped into packages before anything is downloaded.
                </EmptyState>
              )
            ) : (
              <div role="treegrid" aria-label="Collected links" className="min-w-max text-sm">
                <div className="sticky top-0 z-[1] grid h-8 border-b border-line bg-bg text-xs font-medium text-fg-3" style={{ gridTemplateColumns: tpl }} role="row">
                  {COLS.map(([k, label]) => (
                    <div key={k} role="columnheader" className={cn('relative flex items-center px-3', k === 'size' && 'justify-end')}>
                      {label}
                      <span onPointerDown={(e) => resize(k, e)} className="absolute top-1.5 right-0 bottom-1.5 w-1.5 cursor-col-resize border-r border-line hover:border-accent" />
                    </div>
                  ))}
                </div>
                {rows.map((r) =>
                  r.l ? (
                    <LinkRow key={r.id} l={r.l} tpl={tpl} selected={sel.has(r.id)} onClick={(e) => click(r.id, e)} onDoubleClick={() => renameLink(r.l!)} onContext={() => !sel.has(r.id) && (setSel(new Set([r.id])), setAnchor(r.id))} />
                  ) : (
                    <PackageRow
                      key={r.id}
                      p={r.p}
                      links={r.links!}
                      tpl={tpl}
                      selected={sel.has(r.id)}
                      folderHint={lgs.packageFolders && r.p.links.length > 1 && (r.p.kind === 'normal' || r.p.kind === 'custom') ? `Category folder › ${r.p.name}` : 'Category folder'}
                      onToggle={() => toggle(r.p)}
                      onClick={(e) => click(r.id, e)}
                      onDoubleClick={() => renamePackage(r.p)}
                      onContext={() => !sel.has(r.id) && (setSel(new Set([r.id])), setAnchor(r.id))}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </ContextMenu>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-raised px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm text-fg-2">
          {all.length ? (
            <>
              {plural(all.length, 'link')} ({online} online{data.busy ? `, checking ${data.pending}` : ''}) · <span className="tnum">{bytes(shown.reduce((a, l) => a + (l.size || 0), 0))}</span> to download
            </>
          ) : (
            'Nothing collected yet'
          )}
        </span>
        {lgs.autoConfirm && <span className="text-xs text-fg-3">Auto-confirm on ({lgs.autoConfirmDelaySec}s)</span>}
        <span className="text-sm text-fg-2">Add to</span>
        <Select value={queueId} onChange={setQueueId} options={[['', 'No queue'], ...queues.filter((x) => x.type === 'download').map((x) => [x.id, x.name] as const)]} className="w-40" aria-label="Queue" />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={startNow} onChange={setStartNow} />
          Start now
        </label>
        <Button disabled={!sel.size} onClick={() => confirmLinks(selection())}>
          Add selected
        </Button>
        <Button variant="primary" disabled={!shown.length} onClick={() => confirmLinks(null)}>
          <Download />
          Start all
        </Button>
      </footer>

      {dialog === 'add' && <AddLinksDialog onOpenChange={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onOpenChange={() => setDialog(null)} />}
    </>
  );
}

const rowCls = (selected: boolean) => cn('grid h-8 cursor-default items-center border-b border-line/60', selected ? 'bg-selected' : 'hover:bg-subtle');
const Cell = ({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) => (
  <div role="gridcell" title={title} className={cn('min-w-0 truncate px-3', className)}>
    {children}
  </div>
);

type RowEvents = { tpl: string; selected: boolean; onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; onContext: () => void };

function PackageRow({ p, links, tpl, selected, folderHint, onToggle, onClick, onDoubleClick, onContext }: RowEvents & { p: LgPackage; links: LgLink[]; folderHint: string; onToggle: () => void }) {
  const enabled = links.filter((l) => l.enabled).length;
  const counts: Partial<Record<LinkStatus, number>> = {};
  for (const l of links) counts[l.status] = (counts[l.status] || 0) + 1;
  const hosts = [...new Set(links.map((l) => l.host))];
  const Icon = p.kind === 'offline' ? CircleX : p.kind === 'various' ? Layers : Folder;
  const Chev = p.expanded ? ChevronDown : ChevronRight;
  return (
    <div data-row role="row" aria-expanded={!!p.expanded} aria-selected={selected} className={cn(rowCls(selected), 'font-medium')} style={{ gridTemplateColumns: tpl }} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContext}>
      <Cell className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="grid size-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-muted hover:text-fg"
          aria-label={p.expanded ? 'Collapse' : 'Expand'}
        >
          <Chev className="size-3.5" />
        </button>
        <Checkbox checked={enabled === links.length ? true : enabled ? 'indeterminate' : false} onChange={(v) => invoke('lg:enable', links.map((l) => l.id), v)} aria-label="Download these links" />
        <Icon className={cn('size-4 shrink-0', p.kind === 'offline' ? 'text-danger' : 'text-fg-3')} strokeWidth={1.9} />
        <span className="truncate" title={p.name}>
          {p.name}
        </span>
        <span className="tnum font-normal text-fg-3">{links.length}</span>
      </Cell>
      <Cell className="tnum text-right font-normal text-fg-2">{bytes(links.reduce((a, l) => a + (l.size || 0), 0))}</Cell>
      <Cell className="font-normal text-fg-2" title={hosts.join(', ')}>
        {hosts.length > 1 ? `${hosts.length} hosts` : hosts[0] || ''}
      </Cell>
      <Cell className="font-normal">
        {STATUS.filter(([k]) => counts[k]).map(([k, label], i) => (
          <span key={k} className={STATUS_TONE[k]}>
            {i > 0 && <span className="text-fg-3"> · </span>}
            {counts[k]} {label.toLowerCase()}
          </span>
        ))}
      </Cell>
      <Cell className="font-normal text-fg-2" title={p.saveDir}>
        {p.saveDir || <span className="text-fg-3">{folderHint}</span>}
      </Cell>
      <Cell />
    </div>
  );
}

function LinkRow({ l, tpl, selected, onClick, onDoubleClick, onContext }: RowEvents & { l: LgLink }) {
  const label = (STATUS.find(([k]) => k === l.status)?.[1] ?? l.status) + (l.error ? ` — ${l.error}` : '') + (l.inList ? ' (already in list)' : '');
  return (
    <div data-row role="row" aria-selected={selected} className={cn(rowCls(selected), !l.enabled && 'text-fg-3')} style={{ gridTemplateColumns: tpl }} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContext}>
      <Cell className="flex items-center gap-2 pl-10">
        <Checkbox checked={l.enabled} onChange={(v) => invoke('lg:enable', [l.id], v)} aria-label="Download this link" />
        <FileIcon type={typeOf(l)} size="sm" />
        <span className={cn('truncate', !l.enabled && 'line-through')} title={l.name}>
          {l.name}
        </span>
      </Cell>
      <Cell className="tnum text-right text-fg-2">{l.size != null ? bytes(l.size) : ''}</Cell>
      <Cell className="text-fg-2" title={l.host}>
        {l.host}
      </Cell>
      <Cell className={STATUS_TONE[l.status]} title={label}>
        {l.status === 'checking' && <RefreshCw className="mr-1.5 inline size-3 animate-spin" />}
        {label}
      </Cell>
      <Cell />
      <Cell className="font-mono text-xs text-fg-3" title={l.url}>
        {l.url}
      </Cell>
    </div>
  );
}

function Filters({ links, hidden, setHidden }: { links: LgLink[]; hidden: Hidden; setHidden: React.Dispatch<React.SetStateAction<Hidden>> }) {
  const tally = (fn: (l: LgLink) => string) => {
    const m = new Map<string, number>();
    for (const l of links) m.set(fn(l), (m.get(fn(l)) || 0) + 1);
    return m;
  };
  const hosts = tally((l) => l.host);
  const types = tally(typeOf);
  const statuses = tally((l) => l.status);
  const flip = (kind: keyof Hidden, key: string) =>
    setHidden((h) => {
      const s = new Set(h[kind]);
      s.has(key) ? s.delete(key) : s.add(key);
      return { ...h, [kind]: s };
    });
  const group = (title: string, kind: keyof Hidden, entries: [string, string, number][]) =>
    entries.length > 0 && (
      <div className="flex flex-col gap-px">
        <div className="px-2 pb-1 text-xs font-medium text-fg-3">{title}</div>
        {entries.map(([key, label, n]) => (
          <label key={key} className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg-2 hover:bg-subtle hover:text-fg">
            <Checkbox checked={!hidden[kind].has(key)} onChange={() => flip(kind, key)} />
            <span className="min-w-0 flex-1 truncate" title={label}>
              {label}
            </span>
            <span className="tnum text-xs text-fg-3">{n}</span>
          </label>
        ))}
      </div>
    );
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line px-2 py-3" aria-label="Filters">
      {group('Hosts', 'host', [...hosts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k || '(none)', n]))}
      {group('File types', 'type', (Object.keys(FILE_TYPE_LABELS) as FileType[]).filter((k) => types.has(k)).map((k) => [k, FILE_TYPE_LABELS[k], types.get(k)!]))}
      {group('Status', 'status', STATUS.filter(([k]) => statuses.has(k)).map(([k, label]) => [k, label, statuses.get(k)!]))}
    </nav>
  );
}

function AddLinksDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const lgs = useApp((s) => s.settings.linkGrabber);
  const [text, setText] = React.useState('');
  const [packageName, setPackageName] = React.useState('');
  const [saveDir, setSaveDir] = React.useState('');
  const [deep, setDeep] = React.useState(lgs.deepAnalyse);
  React.useEffect(() => {
    if (lgs.useForLinkLists || lgs.clipboard) void invoke('clip:urls').then((u) => setText((t) => t || u.join('\n')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    const n = await invoke('lg:add', { text, packageName: packageName || undefined, saveDir: saveDir || undefined, deep });
    if (!n) return toast('No new addresses found');
    toast(`Collecting ${n} link${n > 1 ? 's' : ''}`);
    onOpenChange(false);
  };
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Add links"
      description="Paste addresses or any text that contains them."
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Textarea autoFocus rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://example.com/file.zip" className="font-mono text-xs" spellCheck={false} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Package name">
            <Input value={packageName} onChange={(e) => setPackageName(e.target.value)} placeholder="Automatic (from file names)" />
          </Field>
          <Field label="Save to" hint="Empty uses the category folders.">
            <FolderInput value={saveDir} onChange={setSaveDir} />
          </Field>
        </div>
        <CheckField label="Look for files inside web pages (deep analysis)" checked={deep} onChange={setDeep} />
      </div>
    </Dialog>
  );
}

function SettingsDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [s, setS] = React.useState<Settings['linkGrabber']>(() => ({ ...useApp.getState().settings.linkGrabber }));
  const up = (patch: Partial<Settings['linkGrabber']>) => setS((x) => ({ ...x, ...patch }));
  const save = async () => {
    await saveSettings({ linkGrabber: s });
    onOpenChange(false);
  };
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="LinkGrabber settings"
      size="lg"
      bodyClassName="max-h-[70vh] overflow-y-auto"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Section title="Collecting">
        <Row>
          <CheckField label="Send link lists here (“Download all links”, clipboard batches, text imports)" checked={s.useForLinkLists} onChange={(v) => up({ useForLinkLists: v })} />
        </Row>
        <Row>
          <CheckField label="Collect every address copied to the clipboard" checked={s.clipboard} onChange={(v) => up({ clipboard: v })} />
        </Row>
        <Row>
          <CheckField label="Look for files inside web pages by default (deep analysis)" checked={s.deepAnalyse} onChange={(v) => up({ deepAnalyse: v })} />
        </Row>
        <Row label="Links checked at the same time">
          <NumberInput value={s.checkThreads} min={1} max={16} onValue={(v) => up({ checkThreads: v })} />
        </Row>
        <Row label="2Captcha API key" hint="Solves reCAPTCHA, hCaptcha and Turnstile on pages searched by deep analysis. Empty skips such pages." stack>
          <Input type="password" value={s.captchaApiKey || ''} onChange={(e) => up({ captchaApiKey: e.target.value.trim() })} autoComplete="off" />
        </Row>
      </Section>
      <Section title="Packages">
        <Row>
          <CheckField label="Put single files into a “Various files” package" checked={s.variousPackage} onChange={(v) => up({ variousPackage: v })} />
        </Row>
        <Row>
          <CheckField label="Save packages with several files into a subfolder named after the package" checked={s.packageFolders} onChange={(v) => up({ packageFolders: v })} />
        </Row>
        <Row>
          <CheckField label="Expand new packages" checked={s.expandPackages} onChange={(v) => up({ expandPackages: v })} />
        </Row>
      </Section>
      <Section title="Adding to the download list" className="mb-0">
        <Row label="Offline links">
          <Select value={s.offlineAction} onChange={(v) => up({ offlineAction: v })} options={[['exclude', 'Leave them here'], ['include', 'Add them anyway']]} className="w-44" />
        </Row>
        <Row label="Already in the list">
          <Select value={s.dupeAction} onChange={(v) => up({ dupeAction: v })} options={[['skip', 'Skip them'], ['add', 'Add them again']]} className="w-44" />
        </Row>
        <Row>
          <CheckField label="Start downloads by default" checked={s.autoStart} onChange={(v) => up({ autoStart: v })} />
        </Row>
        <Row>
          <CheckField label="Add links automatically once they are checked" checked={s.autoConfirm} onChange={(v) => up({ autoConfirm: v })} />
        </Row>
        <Row label="Wait before adding" className={cn(!s.autoConfirm && 'opacity-50')}>
          <NumberInput value={s.autoConfirmDelaySec} min={1} max={3600} disabled={!s.autoConfirm} onValue={(v) => up({ autoConfirmDelaySec: v })} />
          <span className="text-sm text-fg-2">seconds</span>
        </Row>
      </Section>
    </Dialog>
  );
}

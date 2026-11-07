import * as React from 'react';
import { Check, CircleX, Clock, Copy, Download, File, FileStack, Globe, ListPlus, Loader2, Plus, Save, Search, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { invoke, on } from '@/services/ipc';
import { refreshGrabbers, useApp } from '@/stores/app';
import { useUi } from '@/stores/ui';
import { copyText } from '@/app/commands';
import { confirm } from '@/components/dialogs/confirm';
import { PageHeader, Divider, ToolButton } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NumberInput, Textarea } from '@/components/ui/input';
import { Checkbox, CheckField, Select } from '@/components/ui/controls';
import { ContextMenu } from '@/components/ui/menu';
import { Dialog } from '@/components/ui/overlay';
import { EmptyState, Field, FileIcon, Section, Row } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { bytes, hostOf } from '@/utils/format';
import { typeOfName } from '@/utils/files';
import { cn } from '@/utils/cn';
import type { GrabberFile, GrabberProject, GrabberPresets } from '@/types/models';

const STEPS = ['Start page', 'Saving', 'Pages', 'Files', 'Explore & download'];
const PRESETS: [keyof GrabberPresets, string][] = [['images', 'Images'], ['audio', 'Audio'], ['video', 'Video'], ['documents', 'Documents'], ['archives', 'Archives'], ['programs', 'Programs'], ['all', 'All files']];
const fileName = (u: string) => {
  const base = u.split('?')[0];
  try {
    return decodeURIComponent(base.split('/').pop() || u);
  } catch {
    return base.split('/').pop() || u;
  }
};

/** Explores a web site and collects files that match the project's filters. */
export function SiteGrabberPage() {
  const grabbers = useApp((s) => s.grabbers);
  const grabberId = useUi((s) => s.grabberId);
  const [p, setP] = React.useState<GrabberProject | null>(null);
  const [step, setStep] = React.useState(0);
  const [scheduling, setScheduling] = React.useState(false);
  const pRef = React.useRef(p);
  pRef.current = p;
  const running = !!(p && grabbers.find((g) => g.id === p.id)?.running);

  const load = React.useCallback(async (id: string) => {
    const proj = await invoke('grabber:get', id);
    if (!proj) return;
    setP(proj);
    setStep(proj.results.files.length ? 4 : 0);
  }, []);

  // The backend or the sidebar asks for a project through useUi.grabberId; otherwise open the first one.
  React.useEffect(() => {
    if (grabberId && grabberId !== pRef.current?.id) void load(grabberId);
    else if (!grabberId && !pRef.current && grabbers.length) useUi.setState({ grabberId: grabbers[0].id });
  }, [grabberId, grabbers, load]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: GrabberProject | null = null;
    const offs = [
      // Results stream in quickly while exploring; repaint at most every 400 ms.
      on('grabber:update', (id, proj) => {
        if (id !== pRef.current?.id) return;
        latest = proj;
        timer ??= setTimeout(() => {
          timer = null;
          if (latest) setP(latest);
        }, 400);
      }),
      on('grabber:done', async (id) => {
        if (id !== pRef.current?.id) return;
        const proj = await invoke('grabber:get', id);
        if (proj) setP(proj);
        toast('Grabber finished');
      }),
      on('grabber:error', (id, msg) => {
        if (id === pRef.current?.id) toast.error(msg);
        void refreshGrabbers();
      }),
    ];
    return () => {
      offs.forEach((f) => f());
      if (timer) clearTimeout(timer);
    };
  }, []);

  const save = async (proj = pRef.current) => {
    if (!proj) return null;
    const saved = await invoke('grabber:save', proj);
    setP(saved);
    void refreshGrabbers();
    return saved;
  };
  const open = async (id: string) => {
    if (id === p?.id) return;
    await save();
    useUi.setState({ grabberId: id });
  };
  const create = async (patch: Partial<GrabberProject> = {}) => {
    await save();
    const proj = await invoke('grabber:new', { name: 'Project ' + new Date().toLocaleDateString(), ...patch });
    setP(proj);
    setStep(0);
    useUi.setState({ grabberId: proj.id });
    void refreshGrabbers();
  };
  const copy = async () => {
    const saved = await save();
    if (!saved) return;
    const { id: _id, results: _r, stats: _s, ...rest } = saved;
    await create({ ...rest, name: rest.name + ' (copy)' });
  };
  const remove = async () => {
    if (!p || !(await confirm(`Delete project “${p.name}”?`, { okLabel: 'Delete', danger: true, message: 'Downloaded files stay on disk.' }))) return;
    await invoke('grabber:delete', p.id);
    setP(null);
    useUi.setState({ grabberId: null });
    await refreshGrabbers();
  };
  const go = async (n: number) => {
    if (!p || n < 0 || n >= STEPS.length) return;
    if (step === 0 && n > 0 && !/^https?:\/\//i.test(p.startUrl)) return toast.error('Enter a start page that begins with http:// or https://');
    await save();
    setStep(n);
  };
  const run = async (action: 'explore' | 'download') => {
    const saved = await save();
    if (!saved) return;
    await invoke('grabber:run', saved.id, action);
    void refreshGrabbers();
  };
  const up = (patch: Partial<GrabberProject>) => setP((x) => (x ? { ...x, ...patch } : x));

  return (
    <>
      <PageHeader title="Site Grabber" icon={Globe} subtitle={p ? p.name : undefined}>
        <ToolButton icon={Plus} label="New project" onClick={() => create()} primary />
        {p && (
          <>
            <Divider />
            <ToolButton icon={Save} label="Save" tip="Save the project" onClick={() => save().then(() => toast('Project saved'))} />
            <ToolButton icon={Copy} label="Save as copy" tip="Start a new project with these settings" onClick={copy} />
            <ToolButton icon={Clock} label="Schedule" tip={p.schedule?.enabled ? 'Scheduled — change the schedule' : 'Run this project on a schedule'} onClick={() => setScheduling(true)} />
            <ToolButton icon={Trash2} label="Delete" onClick={remove} />
          </>
        )}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        {grabbers.length > 0 && (
          <nav className="flex w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-2" aria-label="Projects">
            <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-3">Projects</div>
            {grabbers.map((g) => (
              <button key={g.id} onClick={() => open(g.id)} aria-current={g.id === p?.id ? 'page' : undefined} className={cn('flex flex-col items-start rounded-md px-2 py-1.5 text-left outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/40', g.id === p?.id && 'bg-muted')}>
                <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{g.name}</span>
                  {g.running && <Loader2 className="size-3 shrink-0 animate-spin text-accent" aria-label="Running" />}
                </span>
                <span className="w-full truncate text-xs text-fg-3">
                  {hostOf(g.startUrl) || 'No start page'}
                  {g.stats?.filesFound ? ` · ${g.stats.matched} files` : ''}
                </span>
              </button>
            ))}
          </nav>
        )}
        {!p ? (
          <EmptyState icon={Globe} title="Grab files from a web site" className="flex-1" action={<Button variant="primary" onClick={() => create()}><Plus />New project</Button>}>
            The grabber reads a start page, follows its links within the limits you set, and collects files that match your filters — every image in a gallery, every PDF in a folder.
          </EmptyState>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <ol className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-4 py-2" aria-label="Steps">
              {STEPS.map((s, i) => (
                <li key={s} className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                  {i > 0 && <span className="h-px w-4 bg-line" />}
                  <button
                    onClick={() => go(i)}
                    disabled={i > 0 && !p.startUrl}
                    aria-current={i === step ? 'step' : undefined}
                    className={cn('flex h-7 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50', i === step ? 'font-medium text-fg' : 'text-fg-2')}
                  >
                    <span className={cn('grid size-5 place-items-center rounded-full text-2xs font-semibold', i === step ? 'bg-accent text-white' : i < step ? 'bg-accent-soft text-accent' : 'bg-muted text-fg-3')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
                    {s}
                  </button>
                </li>
              ))}
            </ol>
            {step < 4 ? (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-[44rem] px-8 py-7">{[<StepStart key={0} p={p} up={up} />, <StepSave key={1} p={p} up={up} />, <StepPages key={2} p={p} up={up} />, <StepFiles key={3} p={p} up={up} />][step]}</div>
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-raised px-6 py-2.5">
                  <Button disabled={step === 0} onClick={() => go(step - 1)}>
                    Back
                  </Button>
                  <Button variant="primary" onClick={() => go(step + 1)}>
                    {step === 3 ? 'Review and explore' : 'Next'}
                  </Button>
                </div>
              </>
            ) : (
              <Results p={p} setP={setP} running={running} run={run} />
            )}
          </div>
        )}
      </div>
      {scheduling && p && (
        <ScheduleDialog
          p={p}
          onSave={(schedule) => {
            const next = { ...p, schedule };
            setP(next);
            void save(next).then(() => toast(schedule.enabled ? 'Schedule saved' : 'Schedule turned off'));
          }}
          onOpenChange={() => setScheduling(false)}
        />
      )}
    </>
  );
}

type StepProps = { p: GrabberProject; up: (patch: Partial<GrabberProject>) => void };

function StepStart({ p, up }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-2">Enter the web page where the grabber starts. It reads this page, follows links within the limits you set, and collects files that match your filters.</p>
      <Field label="Project name">
        <Input value={p.name} onChange={(e) => up({ name: e.target.value })} />
      </Field>
      <Field label="Start page">
        <Input autoFocus type="url" value={p.startUrl} onChange={(e) => up({ startUrl: e.target.value.trim() })} placeholder="https://example.com/gallery/index.html" className="font-mono text-xs" />
      </Field>
      <Field label="Login" hint="Only if the site asks for a user name and password.">
        <div className="grid grid-cols-2 gap-2">
          <Input value={p.auth?.user || ''} onChange={(e) => up({ auth: e.target.value ? { user: e.target.value, pass: p.auth?.pass || '' } : null })} placeholder="User" autoComplete="off" />
          <Input type="password" value={p.auth?.pass || ''} disabled={!p.auth} onChange={(e) => p.auth && up({ auth: { ...p.auth, pass: e.target.value } })} placeholder="Password" autoComplete="off" />
        </div>
      </Field>
    </div>
  );
}

function StepSave({ p, up }: StepProps) {
  const cats = useApp((s) => s.categories);
  return (
    <div className="flex flex-col gap-5">
      <Field label="Save files to">
        <FolderInput value={p.saveDir} onChange={(v) => up({ saveDir: v })} />
      </Field>
      <Field label="Category">
        <Select value={p.category} onChange={(v) => up({ category: v })} options={cats.map((c) => [c.id, c.name] as const)} className="w-56" />
      </Field>
      <div className="flex flex-col gap-3">
        <CheckField label="Keep the site folder structure" hint="Saves into host/folder/… subfolders." checked={p.useSubfolders} onChange={(v) => up({ useSubfolders: v })} />
        <CheckField label="Overwrite existing files" checked={p.overwrite} onChange={(v) => up({ overwrite: v })} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        Explore
        <NumberInput value={p.concurrentExplore} min={1} max={16} onValue={(v) => up({ concurrentExplore: v })} className="w-16" aria-label="Pages at the same time" />
        pages and download
        <NumberInput value={p.concurrentDownload} min={1} max={16} onValue={(v) => up({ concurrentDownload: v })} className="w-16" aria-label="Files at the same time" />
        files at the same time
      </div>
    </div>
  );
}

function StepPages({ p, up }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-2">Choose which pages are explored to look for files. Level 0 explores only the start page; level 1 also explores the pages it links to, and so on.</p>
      <Section className="mb-0">
        <Row label="Levels to explore on this site">
          <NumberInput value={p.levelsThis} min={0} max={20} onValue={(v) => up({ levelsThis: v })} />
        </Row>
        <Row label="Levels to explore on other sites" hint="Keep this low — other sites can add thousands of pages.">
          <NumberInput value={p.levelsOther} min={0} max={5} onValue={(v) => up({ levelsOther: v })} />
        </Row>
        <Row>
          <CheckField label="Don't explore parent folders of the start page" checked={p.dontExploreParent} onChange={(v) => up({ dontExploreParent: v })} />
        </Row>
        <Row>
          <CheckField label="Explore all sites within the main domain (sub-domains)" checked={p.exploreMainDomain} onChange={(v) => up({ exploreMainDomain: v })} />
        </Row>
      </Section>
      <Field label="Only explore pages matching" hint="Patterns separated by spaces or commas; * matches anything.">
        <Input value={p.pageInclude} onChange={(e) => up({ pageInclude: e.target.value })} placeholder="example.com/gallery/*" className="font-mono text-xs" />
      </Field>
      <Field label="Don't explore pages matching">
        <Input value={p.pageExclude} onChange={(e) => up({ pageExclude: e.target.value })} placeholder="*/login* */cart*" className="font-mono text-xs" />
      </Field>
    </div>
  );
}

function StepFiles({ p, up }: StepProps) {
  const presets = useApp((s) => s.grabberPresets);
  const current = new Set(p.fileTypes.split(',').map((s) => s.trim()).filter(Boolean));
  const setPreset = (k: keyof GrabberPresets, onOff: boolean) => {
    const set = new Set(current);
    for (const x of (presets[k] || '').split(',')) onOff ? set.add(x) : set.delete(x);
    up({ fileTypes: [...set].join(',') });
  };
  return (
    <div className="flex flex-col gap-5">
      <Field label="File types">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map(([k, label]) => {
            const onOff = !!presets[k] && presets[k].split(',').every((x) => current.has(x));
            return (
              <button key={k} onClick={() => setPreset(k, !onOff)} aria-pressed={onOff} className={cn('h-7 rounded-full border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40', onOff ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg')}>
                {label}
              </button>
            );
          })}
        </div>
        <Textarea rows={3} value={p.fileTypes} onChange={(e) => up({ fileTypes: e.target.value })} className="font-mono text-xs" />
        <span className="text-xs text-fg-3">Comma-separated patterns, such as *.jpg,image*.png</span>
      </Field>
      <Field label="Exclude file types">
        <Input value={p.fileExcludeTypes} onChange={(e) => up({ fileExcludeTypes: e.target.value })} placeholder="*thumb*.jpg" className="font-mono text-xs" />
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        Size from
        <NumberInput value={p.minSizeKB} min={0} onValue={(v) => up({ minSizeKB: v })} className="w-24" aria-label="Minimum size in KB" />
        KB to
        <NumberInput value={p.maxSizeKB} min={0} onValue={(v) => up({ maxSizeKB: v })} className="w-24" aria-label="Maximum size in KB" />
        KB <span className="text-xs text-fg-3">0 = no limit</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Only from paths">
          <Input value={p.pathInclude} onChange={(e) => up({ pathInclude: e.target.value })} placeholder="cdn.example.com/*" className="font-mono text-xs" />
        </Field>
        <Field label="Not from paths">
          <Input value={p.pathExclude} onChange={(e) => up({ pathExclude: e.target.value })} placeholder="*/ads/*" className="font-mono text-xs" />
        </Field>
      </div>
      <div className="flex flex-col gap-3">
        <CheckField label="Only collect files located on this site" checked={p.thisSiteOnly} onChange={(v) => up({ thisSiteOnly: v })} />
        <CheckField label="Hide duplicate files found in different places (same name and size)" checked={p.hideDuplicates} onChange={(v) => up({ hideDuplicates: v })} />
        <CheckField label="Start downloading every matched file right away" checked={p.startDownloadAll} onChange={(v) => up({ startDownloadAll: v })} />
      </div>
    </div>
  );
}

const ROW_H = 32;
const FILE_STATUS_TONE: Record<string, string> = { downloaded: 'text-ok', failed: 'text-danger', downloading: 'text-info' };

function Results({ p, setP, running, run }: { p: GrabberProject; setP: (p: GrabberProject) => void; running: boolean; run: (a: 'explore' | 'download') => void }) {
  const [pageFilter, setPageFilter] = React.useState<string | null>(null);
  const [sel, setSel] = React.useState<string | null>(null);
  const [scroll, setScroll] = React.useState(0);
  const [height, setHeight] = React.useState(400);
  const listRef = React.useRef<HTMLDivElement>(null);
  const menuFile = React.useRef<GrabberFile | null>(null);
  const s = p.stats || ({} as GrabberProject['stats']);
  const files = React.useMemo(() => p.results.files.filter((f) => !pageFilter || f.page === pageFilter), [p.results.files, pageFilter]);
  const checked = files.filter((f) => f.checked).length;

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setChecked = async (urls: string[], on: boolean) => setP(await invoke('grabber:setChecked', p.id, urls, on));
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 10);
  const slice = files.slice(first, first + Math.ceil(height / ROW_H) + 20);
  const stat = (label: string, v: number | undefined, tone?: string) => (
    <div className="flex flex-col">
      <span className={cn('tnum text-lg font-semibold', tone)}>{v ?? 0}</span>
      <span className="text-xs text-fg-3">{label}</span>
    </div>
  );
  const tpl = '2rem minmax(12rem,1.4fr) 6rem 7rem minmax(8rem,1fr) minmax(12rem,2fr)';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        {running ? (
          <Button onClick={() => invoke('grabber:stop', p.id)}>
            <Square />
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => run('explore')}>
            <Search />
            {p.results.pages.length ? 'Explore again' : 'Start exploring'}
          </Button>
        )}
        <Button disabled={running || !p.results.files.some((f) => f.checked)} onClick={() => run('download')}>
          <Download />
          Download checked
        </Button>
        <Button
          disabled={!p.results.files.some((f) => f.checked)}
          onClick={async () => {
            const n = await invoke('grabber:addToList', p.id, 'main');
            toast(`Added ${n} file${n === 1 ? '' : 's'} to the download list and the main queue`);
          }}
        >
          <ListPlus />
          Add checked to the list
        </Button>
        <div className="flex-1" />
        <div className="flex gap-6">
          {stat('Pages found', s.pagesFound)}
          {stat('Explored', s.explored)}
          {stat('Files found', s.filesFound)}
          {stat('Matched', s.matched, 'text-accent')}
          {stat('Downloaded', s.downloaded, s.downloaded ? 'text-ok' : undefined)}
          {stat('Errors', s.errors, s.errors ? 'text-danger' : undefined)}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-64 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-2" aria-label="Pages">
          <button onClick={() => setPageFilter(null)} className={cn('flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-subtle', !pageFilter && 'bg-muted font-medium')}>
            <FileStack className="size-3.5 text-fg-3" />
            <span className="flex-1 text-left">All files</span>
            <span className="tnum text-xs text-fg-3">{p.results.files.length}</span>
          </button>
          {p.results.pages.map((pg) => {
            const Icon = pg.status === 'exploring' ? Loader2 : pg.status?.startsWith('error') ? CircleX : pg.status === 'explored' ? File : Clock;
            return (
              <button key={pg.url} onClick={() => setPageFilter(pg.url)} title={`${pg.url}\n${pg.status || ''}`} style={{ paddingLeft: 8 + Math.min(pg.level, 8) * 12 }} className={cn('flex h-7 shrink-0 items-center gap-2 rounded-md pr-2 text-sm text-fg-2 hover:bg-subtle hover:text-fg', pageFilter === pg.url && 'bg-muted text-fg')}>
                <Icon className={cn('size-3.5 shrink-0', pg.status === 'exploring' ? 'animate-spin text-info' : pg.status?.startsWith('error') ? 'text-danger' : 'text-fg-3')} />
                <span className="truncate">{pg.title || pg.url.replace(/^https?:\/\//, '')}</span>
              </button>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-sm text-fg-2">
            <span className="tnum flex-1">
              {checked} of {files.length} checked
            </span>
            <Button size="sm" variant="ghost" disabled={!files.length} onClick={() => setChecked(pageFilter ? files.map((f) => f.url) : [], true)}>
              Check all
            </Button>
            <Button size="sm" variant="ghost" disabled={!checked} onClick={() => setChecked(pageFilter ? files.map((f) => f.url) : [], false)}>
              Uncheck all
            </Button>
          </div>
          <ContextMenu
            disabled={!files.length}
            items={() => {
              const f = menuFile.current;
              if (!f) return [];
              return [
                { label: 'Open', disabled: !f.savedPath, onSelect: () => invoke('util:openPath', f.savedPath!) },
                { label: f.checked ? 'Uncheck' : 'Check', onSelect: () => setChecked([f.url], !f.checked) },
                '-',
                { label: 'Copy address', icon: Copy, onSelect: () => copyText(f.url, 'Address copied') },
                { label: 'Copy page address (referer)', onSelect: () => copyText(f.page, 'Address copied') },
                '-',
                { label: 'Download checked files', icon: Download, disabled: running, onSelect: () => run('download') },
              ];
            }}
          >
            <div ref={listRef} className="min-h-0 flex-1 overflow-auto outline-none" onScroll={(e) => setScroll(e.currentTarget.scrollTop)} tabIndex={0}>
              {!files.length ? (
                <EmptyState icon={running ? Loader2 : Search} title={running ? 'Exploring…' : 'No files yet'} className={cn('h-full', running && '[&_svg]:animate-spin')}>
                  {running ? 'Matching files appear here as they are found.' : 'Start exploring to search the site for files that match your filters.'}
                </EmptyState>
              ) : (
                <div className="min-w-max text-sm" role="grid" aria-label="Files" aria-rowcount={files.length}>
                  <div className="sticky top-0 z-[1] grid h-8 items-center border-b border-line bg-bg text-xs font-medium text-fg-3" style={{ gridTemplateColumns: tpl }} role="row">
                    <span />
                    <span className="px-2">File</span>
                    <span className="px-2 text-right">Size</span>
                    <span className="px-2">Status</span>
                    <span className="px-2">Description</span>
                    <span className="px-2">Address</span>
                  </div>
                  <div style={{ height: files.length * ROW_H, position: 'relative' }}>
                    {slice.map((f, i) => (
                      <div
                        key={f.url}
                        role="row"
                        aria-selected={sel === f.url}
                        onClick={() => setSel(f.url)}
                        onContextMenu={() => {
                          menuFile.current = f;
                          setSel(f.url);
                        }}
                        onDoubleClick={() => f.savedPath && invoke('util:openPath', f.savedPath)}
                        className={cn('absolute inset-x-0 grid items-center border-b border-line/60', sel === f.url ? 'bg-selected' : 'hover:bg-subtle')}
                        style={{ top: (first + i) * ROW_H, height: ROW_H, gridTemplateColumns: tpl }}
                      >
                        <span className="grid place-items-center">
                          <Checkbox checked={f.checked} onChange={(v) => setChecked([f.url], v)} aria-label="Download this file" />
                        </span>
                        <span className="flex min-w-0 items-center gap-2 px-2">
                          <FileIcon type={typeOfName(fileName(f.url))} size="sm" />
                          <span className="truncate" title={fileName(f.url)}>
                            {fileName(f.url)}
                          </span>
                        </span>
                        <span className="tnum truncate px-2 text-right text-fg-2">{f.size != null ? bytes(f.size) : ''}</span>
                        <span className={cn('truncate px-2 capitalize', FILE_STATUS_TONE[f.status || ''] || 'text-fg-3')}>{f.status}</span>
                        <span className="truncate px-2 text-fg-2" title={f.description}>
                          {f.description}
                        </span>
                        <span className="truncate px-2 font-mono text-xs text-fg-3" title={f.url}>
                          {f.url}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ContextMenu>
        </div>
      </div>
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ScheduleDialog({ p, onSave, onOpenChange }: { p: GrabberProject; onSave: (s: GrabberProject['schedule']) => void; onOpenChange: (o: boolean) => void }) {
  const [s, setS] = React.useState(() => ({ ...p.schedule, days: [...(p.schedule?.days || [])] }));
  const up = (patch: Partial<typeof s>) => setS((x) => ({ ...x, ...patch }));
  const submit = () => {
    onSave(s);
    onOpenChange(false);
  };
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Schedule the project"
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <CheckField label="Run this project on a schedule" checked={s.enabled} onChange={(v) => up({ enabled: v })} />
        <div className={cn('flex flex-col gap-4', !s.enabled && 'pointer-events-none opacity-50')}>
          <Field label="Action">
            <Select value={s.action} onChange={(v) => up({ action: v })} options={[['explore', 'Explore the site only'], ['explore-download', 'Explore and download all matched files'], ['download', 'Download checked files']]} />
          </Field>
          <Field label="Start at">
            <Input type="time" value={s.startTime} onChange={(e) => up({ startTime: e.target.value })} className="w-32" />
          </Field>
          <Field label="On">
            <div className="flex gap-1">
              {DAYS.map((d, i) => {
                const onOff = s.days.includes(i);
                return (
                  <button key={d} onClick={() => up({ days: onOff ? s.days.filter((x) => x !== i) : [...s.days, i] })} aria-pressed={onOff} className={cn('h-7 w-11 rounded-md border text-sm', onOff ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg-2 hover:border-line-strong')}>
                    {d}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Synchronize every" hint="0 runs once; periodic runs replace changed files.">
            <div className="flex items-center gap-2 text-sm text-fg-2">
              <NumberInput value={s.periodicMinutes} min={0} onValue={(v) => up({ periodicMinutes: v })} />
              minutes
            </div>
          </Field>
          <div className="flex items-center gap-3">
            <CheckField label="Stop at" checked={s.stopEnabled} onChange={(v) => up({ stopEnabled: v })} />
            <Input type="time" value={s.stopTime} disabled={!s.stopEnabled} onChange={(e) => up({ stopTime: e.target.value })} className="w-32" />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

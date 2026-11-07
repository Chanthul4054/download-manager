import * as React from 'react';
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ListOrdered, Play, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { navigate, useUi } from '@/stores/ui';
import { newQueue } from '@/app/commands';
import { confirm } from '@/components/dialogs/confirm';
import { PageHeader, ToolButton, Divider } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NumberInput } from '@/components/ui/input';
import { Checkbox, CheckField, Select } from '@/components/ui/controls';
import { Badge, EmptyState, FileIcon, Progress, Row, Section } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { Tabs, Tooltip } from '@/components/ui/overlay';
import { bytes } from '@/utils/format';
import { typeOfItem } from '@/utils/files';
import { phaseOf, PHASE_LABEL, PHASE_TONE, progressOf } from '@/utils/status';
import { cn } from '@/utils/cn';
import type { PowerAction, Queue } from '@/types/models';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const POWER: [PowerAction, string][] = [['none', 'Do nothing'], ['shutdown', 'Shut down'], ['restart', 'Restart'], ['sleep', 'Sleep'], ['hibernate', 'Hibernate']];

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const patchOf = (q: Queue) => ({ name: q.name, maxConcurrent: q.maxConcurrent, retries: q.retries, schedule: q.schedule, onComplete: q.onComplete, type: q.type });

export function QueuesPage() {
  const queues = useApp((s) => s.queues);
  const wanted = useUi((s) => s.queueId);
  const q = queues.find((x) => x.id === wanted) || queues[0];
  const [tab, setTab] = React.useState<'files' | 'schedule'>('files');
  const [draft, setDraft] = React.useState<Queue | null>(null);

  // The draft follows the selected queue; edits stay local until saved.
  React.useEffect(() => setDraft(q ? clone(q) : null), [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!(draft && q && JSON.stringify(patchOf(draft)) !== JSON.stringify(patchOf(q)));

  const save = async () => {
    if (!draft || !q) return;
    await invoke('q:update', q.id, patchOf(draft));
    toast('Queue saved');
  };
  const select = async (id: string) => {
    if (dirty && (await confirm('Save changes to this queue?', { okLabel: 'Save' }))) await save();
    navigate('queues', { queueId: id });
  };

  if (!q || !draft) return <EmptyState icon={ListOrdered} title="No queues" />;

  return (
    <>
      <PageHeader title="Queues" icon={ListOrdered}>
        <ToolButton icon={Plus} label="New queue" onClick={newQueue} />
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-2">
          {queues.map((x) => (
            <QueueCard key={x.id} q={x} active={x.id === q.id} onClick={() => select(x.id)} />
          ))}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
            <div className="flex min-w-0 items-center gap-2">
              {q.type === 'sync' ? <RefreshCw className="size-4 text-fg-3" /> : <ListOrdered className="size-4 text-fg-3" />}
              <span className="truncate font-semibold">{q.name}</span>
              {q.running ? <Badge tone="accent">Running</Badge> : <Badge>Stopped</Badge>}
              {q.schedule.startEnabled && <Badge tone="info">Starts {q.schedule.startTime}</Badge>}
            </div>
            <div className="flex-1" />
            <Tabs value={tab} onChange={setTab} tabs={[{ value: 'files', label: 'Files', count: q.items.length }, { value: 'schedule', label: 'Schedule and options' }]} />
            <Divider />
            {q.running ? (
              <Button onClick={() => invoke('q:stop', q.id)}>
                <Square />
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={async () => {
                  if (dirty) await save();
                  void invoke('q:start', q.id);
                }}
              >
                <Play />
                Start now
              </Button>
            )}
          </div>
          {tab === 'files' ? <QueueFiles q={q} /> : <QueueSchedule draft={draft} setDraft={setDraft} />}
          {tab === 'schedule' && (
            <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
              {!q.builtin && (
                <Button
                  variant="danger-ghost"
                  onClick={async () => {
                    if (!(await confirm(`Delete queue “${q.name}”?`, { okLabel: 'Delete', danger: true, message: 'Downloads in it stay in the list.' }))) return;
                    await invoke('q:remove', q.id);
                    navigate('queues', { queueId: null });
                  }}
                >
                  <Trash2 />
                  Delete queue
                </Button>
              )}
              <div className="flex-1" />
              {dirty && <span className="text-xs text-fg-3">Unsaved changes</span>}
              <Button disabled={!dirty} onClick={() => setDraft(clone(q))}>
                Discard
              </Button>
              <Button variant="primary" disabled={!dirty} onClick={save}>
                Save changes
              </Button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function QueueCard({ q, active, onClick }: { q: Queue; active: boolean; onClick: () => void }) {
  const items = useApp((s) => s.items);
  const done = q.items.filter((id) => items[id]?.status === 'complete').length;
  const total = q.items.length;
  const [over, setOver] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-opendm-qitems') || e.dataTransfer.types.includes('application/x-opendm-ids')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const moved = e.dataTransfer.getData('application/x-opendm-qitems');
        if (moved) {
          const { from, ids } = JSON.parse(moved) as { from: string; ids: string[] };
          if (from !== q.id) void invoke('q:addItems', q.id, ids).then(() => invoke('q:removeItems', from, ids));
          return;
        }
        const ids = JSON.parse(e.dataTransfer.getData('application/x-opendm-ids') || '[]') as string[];
        if (ids.length) void invoke('q:addItems', q.id, ids);
      }}
      className={cn('flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/40', active && 'bg-muted hover:bg-muted', over && 'ring-2 ring-accent/50')}
    >
      <span className="flex items-center gap-2">
        {q.type === 'sync' ? <RefreshCw className="size-3.5 text-fg-3" /> : <ListOrdered className="size-3.5 text-fg-3" />}
        <span className="flex-1 truncate text-sm font-medium">{q.name}</span>
        {q.running && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
      </span>
      <span className="flex items-center gap-2 text-xs text-fg-3">
        <span className="tnum">{q.type === 'sync' ? `${total} files` : total ? `${total} waiting` : 'Empty'}</span>
        {q.type === 'sync' && total > 0 && <span className="tnum">· {done} synced</span>}
      </span>
    </button>
  );
}

function QueueFiles({ q }: { q: Queue }) {
  const items = useApp((s) => s.items);
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const list = q.items.map((id) => items[id]).filter(Boolean);
  React.useEffect(() => setSel(new Set()), [q.id]);
  const mv = (dir: 'top' | 'up' | 'down' | 'bottom') => sel.size && invoke('q:move', q.id, [...sel], dir);
  const btn = (icon: React.ReactNode, label: string, dir: 'top' | 'up' | 'down' | 'bottom') => (
    <Tooltip content={label}>
      <span className="inline-flex">
        <Button size="icon" variant="ghost" disabled={!sel.size} onClick={() => mv(dir)} aria-label={label}>
          {icon}
        </Button>
      </span>
    </Tooltip>
  );
  if (!list.length)
    return (
      <EmptyState icon={ListOrdered} title="This queue is empty">
        Right-click downloads and choose “Add to queue”, or drag them onto the queue in the sidebar.
      </EmptyState>
    );
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
        <Checkbox checked={sel.size === 0 ? false : sel.size === list.length ? true : 'indeterminate'} onChange={(v) => setSel(v ? new Set(list.map((x) => x.id)) : new Set())} aria-label="Select all" className="mx-1.5" />
        <span className="mr-2 text-xs text-fg-3">{sel.size ? `${sel.size} selected` : 'Order of download'}</span>
        {btn(<ArrowUpToLine />, 'Move to top', 'top')}
        {btn(<ArrowUp />, 'Move up', 'up')}
        {btn(<ArrowDown />, 'Move down', 'down')}
        {btn(<ArrowDownToLine />, 'Move to bottom', 'bottom')}
        <div className="flex-1" />
        <Button variant="danger-ghost" size="sm" disabled={!sel.size} onClick={() => invoke('q:removeItems', q.id, [...sel]).then(() => setSel(new Set()))}>
          <X />
          Remove from queue
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto py-1">
        {list.map((it, i) => {
          const ph = phaseOf(it);
          const pct = progressOf(it);
          return (
            <li
              key={it.id}
              draggable
              onDragStart={(e) => {
                const ids = sel.has(it.id) ? [...sel] : [it.id];
                e.dataTransfer.setData('application/x-opendm-qitems', JSON.stringify({ from: q.id, ids }));
              }}
              onClick={(e) => {
                const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
                if (n.has(it.id) && (e.ctrlKey || e.metaKey)) n.delete(it.id);
                else n.add(it.id);
                setSel(n);
              }}
              className={cn('mx-2 flex h-11 items-center gap-3 rounded-md px-2 text-sm', sel.has(it.id) ? 'bg-selected' : 'hover:bg-subtle')}
            >
              <span className="tnum w-5 text-right text-xs text-fg-3">{i + 1}</span>
              <FileIcon type={typeOfItem(it)} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{it.fileName}</span>
                <span className="block truncate text-xs text-fg-3">{bytes(it.size) || 'Size unknown'}</span>
              </span>
              <span className="flex w-40 shrink-0 flex-col gap-1">
                <span className={cn('flex justify-between text-xs', PHASE_TONE[ph].text)}>
                  {PHASE_LABEL[ph]}
                  {pct != null && ph !== 'completed' && <span className="tnum text-fg-3">{pct.toFixed(0)}%</span>}
                </span>
                <Progress value={pct ?? 0} barClass={PHASE_TONE[ph].bar} className="h-[3px]" />
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function QueueSchedule({ draft, setDraft }: { draft: Queue; setDraft: (q: Queue) => void }) {
  const s = draft.schedule;
  const oc = draft.onComplete;
  const up = (patch: Partial<Queue>) => setDraft({ ...draft, ...patch });
  const upS = (patch: Partial<Queue['schedule']>) => up({ schedule: { ...s, ...patch } });
  const upO = (patch: Partial<Queue['onComplete']>) => up({ onComplete: { ...oc, ...patch } });
  const [runFile, setRunFile] = React.useState(!!oc.runFile);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-[44rem]">
        <Section title="Queue">
          <Row label="Name">
            <Input value={draft.name} onChange={(e) => up({ name: e.target.value })} className="w-64" />
          </Row>
          <Row label="Type" hint={draft.type === 'sync' ? 'Files stay in the queue and are downloaded again when they change on the server.' : 'Files leave the queue when they finish.'}>
            {draft.builtin ? (
              <span className="text-sm text-fg-2">{draft.type === 'sync' ? 'Periodic synchronization' : 'One-time downloading'}</span>
            ) : (
              <Select value={draft.type} onChange={(v) => up({ type: v, schedule: { ...s, periodic: v === 'sync' } })} options={[['download', 'One-time downloading'], ['sync', 'Periodic synchronization']]} className="w-56" />
            )}
          </Row>
          <Row label="Download at the same time">
            <NumberInput value={draft.maxConcurrent} min={1} max={32} onValue={(v) => up({ maxConcurrent: v })} />
            <span className="text-sm text-fg-2">files</span>
          </Row>
          <Row label="Retry failed files" hint="A file that fails moves to the end of the queue and is tried again.">
            <Checkbox checked={draft.retries > 0} onChange={(v) => up({ retries: v ? Math.max(1, draft.retries || 10) : 0 })} aria-label="Retry failed files" />
            <NumberInput value={draft.retries || 10} min={1} disabled={!draft.retries} onValue={(v) => up({ retries: v })} />
            <span className="text-sm text-fg-2">times</span>
          </Row>
        </Section>

        <Section title="Schedule" description="The queue starts and stops on its own at these times.">
          <Row label={<CheckField label="Start at" checked={s.startEnabled} onChange={(v) => upS({ startEnabled: v })} />}>
            <Input type="time" value={s.startTime} onChange={(e) => upS({ startTime: e.target.value })} className="w-28" disabled={!s.startEnabled} />
          </Row>
          <Row label="Repeat" stack>
            <div className={cn('flex flex-wrap items-center gap-3', !s.startEnabled && 'pointer-events-none opacity-50')}>
              <Select value={s.mode} onChange={(v) => upS({ mode: v, onceDate: v === 'once' && !s.onceDate ? new Date().toISOString().slice(0, 10) : s.onceDate })} options={[['daily', 'Every week on'], ['once', 'Once on']]} className="w-36" />
              {s.mode === 'daily' ? (
                <div className="flex gap-1">
                  {DAYS.map((d, i) => {
                    const on = s.days.includes(i);
                    return (
                      <button key={d} onClick={() => upS({ days: on ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })} aria-pressed={on} className={cn('h-7 w-10 rounded-md border text-xs font-medium', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg-3 hover:bg-subtle')}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Input type="date" value={s.onceDate} onChange={(e) => upS({ onceDate: e.target.value })} className="w-40" />
              )}
            </div>
          </Row>
          {draft.type === 'sync' && (
            <Row label={<CheckField label="Repeat every" checked={s.periodic} onChange={(v) => upS({ periodic: v })} />}>
              <NumberInput value={s.everyMinutes} min={1} onValue={(v) => upS({ everyMinutes: v })} disabled={!s.periodic} />
              <span className="text-sm text-fg-2">minutes</span>
            </Row>
          )}
          <Row label={<CheckField label="Stop at" checked={s.stopEnabled} onChange={(v) => upS({ stopEnabled: v })} />}>
            <Input type="time" value={s.stopTime} onChange={(e) => upS({ stopTime: e.target.value })} className="w-28" disabled={!s.stopEnabled} />
          </Row>
        </Section>

        <Section title="When the queue finishes" description="These do not run when you stop the queue yourself.">
          <Row label={<CheckField label="Open a file" checked={runFile} onChange={(v) => (setRunFile(v), !v && upO({ runFile: '' }))} />} stack={runFile}>
            {runFile && <FolderInput file value={oc.runFile} onChange={(v) => upO({ runFile: v })} className="w-full" />}
          </Row>
          <Row label={<CheckField label="Exit OpenDM" checked={oc.exitApp} onChange={(v) => upO({ exitApp: v })} />} />
          <Row label="Then the computer should">
            <Select value={oc.power} onChange={(v) => upO({ power: v })} options={POWER} className="w-36" />
          </Row>
          <Row label={<CheckField label="Force programs to close" hint="Unsaved work in other programs may be lost." checked={oc.forceTerminate} onChange={(v) => upO({ forceTerminate: v })} disabled={oc.power === 'none'} />} />
        </Section>
      </div>
    </div>
  );
}

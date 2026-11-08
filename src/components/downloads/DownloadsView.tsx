// A download list page: header with actions, status tabs with counts, search and the table.
// Downloads, Video and BitTorrent are this view with a different base filter and columns.
import * as React from 'react';
import { ChevronDown, ListOrdered, MoreHorizontal, Pause, Play, Square, Trash2, type LucideIcon } from 'lucide-react';
import { invoke, runMenu } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { openDialog, useUi, type StatusView } from '@/stores/ui';
import { remove, removeCompleted, resume, startQueue, stop, stopAll } from '@/app/commands';
import { PageHeader, SearchField, SubBar, ToolButton, Divider } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/overlay';
import { DropdownMenu } from '@/components/ui/menu';
import { Button } from '@/components/ui/button';
import { DownloadList } from './DownloadList';
import { matchesSearch, matchesView, sortItems } from './query';
import type { ListColumn } from './columns';
import { canResume, isRunning } from '@/utils/status';
import type { DownloadItem } from '@/types/models';

const VIEWS: { value: StatusView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'queued', label: 'Queued' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

interface Props {
  title: string;
  icon: LucideIcon;
  filter?: (it: DownloadItem) => boolean;
  /** Fixed columns; otherwise the user's saved columns. */
  columns?: ListColumn[];
  /** Extra header buttons, left of the standard actions. */
  actions?: React.ReactNode;
  /** Shown above the list (e.g. tool status). */
  banner?: React.ReactNode;
  empty: (filtered: boolean) => React.ReactNode;
}

export function DownloadsView({ title, icon, filter, columns, actions, banner, empty }: Props) {
  const rev = useApp((s) => s.rev);
  const sort = useApp((s) => s.settings.appearance.sort);
  const userCols = useApp((s) => s.settings.appearance.columns);
  const { view, search, findOpts } = useUi();

  const base = React.useMemo(() => {
    const all = Object.values(useApp.getState().items);
    return filter ? all.filter(filter) : all;
    // `rev` stands for "the list changed".
  }, [rev, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusView, number> = { all: base.length, active: 0, queued: 0, paused: 0, completed: 0, failed: 0 };
    for (const it of base) for (const v of VIEWS) if (v.value !== 'all' && matchesView(it, v.value)) c[v.value]++;
    return c;
  }, [base]);

  const items = React.useMemo(() => sortItems(base.filter((x) => matchesView(x, view) && matchesSearch(x, search, findOpts)), sort), [base, view, search, findOpts, sort]);
  const filtered = view !== 'all' || !!search.trim();

  return (
    <>
      <PageHeader title={title} icon={icon}>
        {actions}
        <SelectionActions />
        <Divider />
        <QueueButton />
        <MoreMenu />
      </PageHeader>
      <SubBar>
        <Tabs value={view} onChange={(v) => useUi.setState({ view: v, sel: new Set() })} tabs={VIEWS.filter((v) => v.value === 'all' || counts[v.value] > 0 || v.value === view).map((v) => ({ ...v, count: counts[v.value] }))} />
        <div className="flex-1" />
        <SearchField placeholder="Search downloads" withOptions />
      </SubBar>
      {banner}
      <DownloadList items={items} columns={columns || (userCols as ListColumn[])} configurable={!columns} empty={empty(filtered && base.length > 0)} />
    </>
  );
}

function SelectionActions() {
  const sel = useUi((s) => s.sel);
  const items = useApp((s) => s.items);
  const chosen = React.useMemo(() => [...sel].map((id) => items[id]).filter(Boolean), [sel, items]);
  return (
    <>
      <ToolButton icon={Play} label="Resume" tip="Start or resume the selected downloads" disabled={!chosen.some(canResume)} onClick={() => resume(chosen)} />
      <ToolButton icon={Pause} label="Pause" tip="Stop the selected downloads" disabled={!chosen.some(isRunning)} onClick={() => stop(chosen)} />
      <ToolButton icon={Trash2} label="Remove" tip="Remove the selected downloads from the list" kbd="Del" disabled={!chosen.length} onClick={() => remove(chosen)} />
    </>
  );
}

function QueueButton() {
  const queues = useApp((s) => s.queues);
  const main = queues.find((q) => q.id === 'main');
  const style = useApp((s) => s.settings.appearance.toolbar);
  return (
    <div className="flex items-center">
      {main?.running ? (
        <ToolButton icon={Square} label="Stop queue" tip="Stop the main queue" onClick={() => invoke('q:stop', 'main')} className="rounded-r-none" />
      ) : (
        <ToolButton icon={ListOrdered} label="Start queue" tip="Start the main download queue" onClick={() => startQueue('main')} className="rounded-r-none" />
      )}
      <DropdownMenu
        align="end"
        items={() => [
          { heading: 'Start a queue' },
          ...queues.map((q) => ({ label: q.name, checked: !!q.running, onSelect: () => (q.running ? invoke('q:stop', q.id) : invoke('q:start', q.id)) })),
          '-',
          { label: 'Manage queues…', onSelect: () => useUi.setState({ page: 'queues' }) },
        ]}
        trigger={
          <Button variant="ghost" size={style === 'small' ? 'icon-sm' : 'icon'} className="w-5 rounded-l-none text-fg-3" aria-label="Choose a queue">
            <ChevronDown className="size-3.5" />
          </Button>
        }
      />
    </div>
  );
}

function MoreMenu() {
  const anyRunning = useApp((s) => Object.values(s.items).some(isRunning) || s.queues.some((q) => q.running));
  return (
    <DropdownMenu
      align="end"
      items={() => [
        { label: 'Stop all downloads and queues', icon: Square, disabled: !anyRunning, onSelect: stopAll },
        { label: 'Pause all downloads', icon: Pause, disabled: !anyRunning, onSelect: () => runMenu('pause-all') },
        '-',
        { label: 'Remove all completed…', icon: Trash2, onSelect: removeCompleted },
        '-',
        { label: 'Batch download…', kbd: 'Ctrl+B', onSelect: () => openDialog({ type: 'batch' }) },
        { label: 'Paste addresses from clipboard', onSelect: () => invoke('batch:clipboard') },
        '-',
        { label: 'Customize columns…', onSelect: () => openDialog({ type: 'columns' }) },
      ]}
      trigger={
        <Button variant="ghost" size="icon" aria-label="More actions" className="text-fg-2">
          <MoreHorizontal />
        </Button>
      }
    />
  );
}

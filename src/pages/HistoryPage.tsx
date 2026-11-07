import * as React from 'react';
import { ExternalLink, FolderOpen, History, MoreHorizontal, SearchX, Trash2 } from 'lucide-react';
import { invoke, startDrag } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { clickSelect, selectOnly, useUi } from '@/stores/ui';
import { removeCompleted } from '@/app/commands';
import { PageHeader, SearchField, SubBar, ToolButton } from '@/components/layout/PageHeader';
import { itemMenu } from '@/components/downloads/menus';
import { matchesSearch } from '@/components/downloads/query';
import { ContextMenu, DropdownMenu } from '@/components/ui/menu';
import { EmptyState, FileIcon } from '@/components/ui/display';
import { Tooltip, Tabs } from '@/components/ui/overlay';
import { bytes, dayLabel, time } from '@/utils/format';
import { FILE_TYPE_LABELS, typeOfItem, type FileType } from '@/utils/files';
import { cn } from '@/utils/cn';
import type { DownloadItem } from '@/types/models';

const when = (x: DownloadItem) => x.completedAt || x.lastTry || x.added || 0;

/** Finished downloads by day. */
export function HistoryPage() {
  const rev = useApp((s) => s.rev);
  const search = useUi((s) => s.search);
  const findOpts = useUi((s) => s.findOpts);
  const sel = useUi((s) => s.sel);
  const [type, setType] = React.useState<FileType | 'all'>('all');

  const done = React.useMemo(() => Object.values(useApp.getState().items).filter((x) => x.status === 'complete').sort((a, b) => when(b) - when(a)), [rev]);
  const types = React.useMemo(() => [...new Set(done.map(typeOfItem))], [done]);
  const list = React.useMemo(() => done.filter((x) => (type === 'all' || typeOfItem(x) === type) && matchesSearch(x, search, findOpts)), [done, type, search, findOpts]);
  const groups = React.useMemo(() => {
    const m = new Map<string, DownloadItem[]>();
    for (const x of list) {
      const k = dayLabel(when(x));
      m.set(k, [...(m.get(k) || []), x]);
    }
    return [...m];
  }, [list]);
  React.useEffect(() => useUi.setState({ order: list.map((x) => x.id) }), [list]);
  const totalSize = list.reduce((a, x) => a + (x.size || 0), 0);
  const chosen = () => [...useUi.getState().sel].map((id) => useApp.getState().items[id]).filter(Boolean);

  return (
    <>
      <PageHeader title="History" icon={History} subtitle={done.length ? `${done.length} files · ${bytes(totalSize)}` : undefined}>
        <ToolButton icon={Trash2} label="Clear history" tip="Remove all completed downloads from the list; files stay on disk" disabled={!done.length} onClick={removeCompleted} />
      </PageHeader>
      <SubBar>
        <Tabs value={type} onChange={setType} tabs={[{ value: 'all' as const, label: 'All', count: done.length }, ...types.map((t) => ({ value: t, label: FILE_TYPE_LABELS[t] }))]} />
        <div className="flex-1" />
        <SearchField placeholder="Search history" withOptions />
      </SubBar>
      <ContextMenu items={() => itemMenu(chosen())}>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 outline-none" tabIndex={0}>
          {!list.length ? (
            done.length ? (
              <EmptyState icon={SearchX} title="Nothing matches" className="h-full" />
            ) : (
              <EmptyState icon={History} title="No finished downloads" className="h-full">
                Completed downloads appear here, grouped by day.
              </EmptyState>
            )
          ) : (
            groups.map(([day, rows]) => (
              <section key={day}>
                <h2 className="sticky top-0 z-[1] -mx-4 bg-bg/95 px-4 pt-4 pb-1.5 text-xs font-medium text-fg-3 backdrop-blur-sm">
                  {day} <span className="tnum font-normal">· {rows.length}</span>
                </h2>
                <div className="flex flex-col">
                  {rows.map((it) => (
                    <HistoryRow key={it.id} it={it} selected={sel.has(it.id)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </ContextMenu>
    </>
  );
}

function HistoryRow({ it, selected }: { it: DownloadItem; selected: boolean }) {
  const btn = 'grid size-6 place-items-center rounded-md text-fg-3 hover:bg-muted hover:text-fg data-[state=open]:bg-muted';
  return (
    <div
      data-row={it.id}
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        void startDrag(it.id);
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-action]')) return;
        if (e.button === 2) return !useUi.getState().sel.has(it.id) && selectOnly(it.id);
        clickSelect(it.id, e);
      }}
      onDoubleClick={() => invoke('dl:open', it.id)}
      className={cn('group flex h-[2.77rem] items-center gap-3 rounded-md px-2 text-sm', selected ? 'bg-selected' : 'hover:bg-subtle')}
    >
      <FileIcon type={typeOfItem(it)} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={it.fileName}>
          {it.fileName}
        </div>
        <div className="truncate text-xs text-fg-3" title={it.savedPath || it.saveDir}>
          {it.savedPath || it.saveDir}
        </div>
      </div>
      <span className="tnum w-20 shrink-0 text-right text-xs text-fg-2">{bytes(it.size)}</span>
      <span className="tnum w-16 shrink-0 text-right text-xs text-fg-3">{time(when(it))}</span>
      <div data-action className="flex w-[4.6rem] shrink-0 justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip content="Open">
          <button className={btn} onClick={() => invoke('dl:open', it.id)} aria-label="Open">
            <ExternalLink className="size-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Open folder">
          <button className={btn} onClick={() => invoke('dl:openFolder', it.id)} aria-label="Open folder">
            <FolderOpen className="size-3.5" />
          </button>
        </Tooltip>
        <DropdownMenu
          align="end"
          items={() => itemMenu([it])}
          trigger={
            <button className={btn} aria-label="More">
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
      </div>
    </div>
  );
}

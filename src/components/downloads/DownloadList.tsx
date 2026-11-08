// The download table. Rows are windowed (only the visible ones render) and each row subscribes to its
// own item, so a progress tick re-renders the rows that changed and nothing else.
import * as React from 'react';
import { ArrowDown, ArrowUp, FolderOpen, MoreHorizontal, Pause, Play } from 'lucide-react';
import { invoke, startDrag } from '@/services/ipc';
import { replaceList, saveSettings, useApp } from '@/stores/app';
import { clearSelection, clickSelect, openDialog, selectOnly, useUi } from '@/stores/ui';
import { openItem, remove, resume, selectedItems, stop } from '@/app/commands';
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/overlay';
import { COLUMNS, USER_COLUMNS, type ListColumn } from './columns';
import { emptyMenu, itemMenu } from './menus';
import { cn } from '@/utils/cn';
import { canResume, isRunning } from '@/utils/status';
import type { DownloadItem } from '@/types/models';

interface Props {
  items: DownloadItem[];
  columns: ListColumn[];
  /** Saved widths; resizing saves into settings.appearance.columnWidths when `configurable`. */
  configurable?: boolean;
  empty: React.ReactNode;
}

const OVERSCAN = 8;

export function DownloadList({ items, columns, configurable, empty }: Props) {
  const fontSize = useApp((s) => s.settings.appearance.fontSize) || 13;
  const savedWidths = useApp((s) => s.settings.appearance.columnWidths);
  const sort = useApp((s) => s.settings.appearance.sort);
  const rowH = Math.round((fontSize * 36) / 13);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState({ top: 0, height: 600 });
  const [live, setLive] = React.useState<Partial<Record<ListColumn, number>>>({});
  const widths = React.useMemo(() => {
    const w = {} as Record<ListColumn, number>;
    for (const c of columns) w[c] = live[c] ?? (configurable ? savedWidths[c as keyof typeof savedWidths] : undefined) ?? COLUMNS[c].width;
    return w;
  }, [columns, live, savedWidths, configurable]);
  // Columns keep their widths; a narrow window scrolls the table sideways.
  const total = columns.reduce((a, c) => a + widths[c], 0) + 72;

  // Keyboard order and shift-click ranges follow what is on screen.
  React.useEffect(() => {
    useUi.setState({ order: items.map((x) => x.id) });
  }, [items]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Find next (F3) moves to the next row after the focused one.
  React.useEffect(() => {
    const next = () => {
      const { order, focus } = useUi.getState();
      if (!order.length) return;
      const id = order[(order.indexOf(focus || '') + 1) % order.length];
      selectOnly(id);
      scrollTo(order.indexOf(id));
    };
    document.addEventListener('odm:findNext', next);
    return () => document.removeEventListener('odm:findNext', next);
  });

  const scrollTo = (i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const head = rowH;
    const y = i * rowH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowH + head > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH + head - el.clientHeight;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, button[role=menuitem]')) return;
    const { order, focus, sel } = useUi.getState();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete') {
      e.preventDefault();
      void remove(selectedItems(), e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const one = selectedItems()[0];
      if (one) e.altKey ? openDialog({ type: 'properties', id: one.id }) : one.status === 'complete' ? invoke('dl:open', one.id) : openDialog({ type: 'properties', id: one.id });
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      useUi.setState({ sel: new Set(order) });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!order.length) return;
      let i = order.indexOf(focus || '');
      i = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : e.key === 'ArrowDown' ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
      if (e.shiftKey) useUi.setState({ sel: new Set([...sel, order[i]]), focus: order[i] });
      else selectOnly(order[i]);
      scrollTo(i);
    } else if (e.key === ' ' && focus) {
      e.preventDefault();
      const it = useApp.getState().items[focus];
      if (it) isRunning(it) ? stop([it]) : resume([it]);
    } else if (e.key === 'Escape') clearSelection();
  };

  const first = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  const cols = columns;

  return (
    <ContextMenu
      items={(): MenuEntry[] => {
        const sel = selectedItems();
        return sel.length ? itemMenu(sel) : emptyMenu();
      }}
    >
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label="Downloads"
        aria-rowcount={items.length}
        aria-multiselectable
        onKeyDown={onKey}
        onScroll={(e) => {
          // Read now: React clears currentTarget before a deferred updater runs (it crashed on sideways scrolls).
          const top = e.currentTarget.scrollTop;
          setView((v) => (v.top === top ? v : { ...v, top }));
        }}
        onContextMenuCapture={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
          if (!row) clearSelection();
          else if (!useUi.getState().sel.has(row.dataset.row!)) selectOnly(row.dataset.row!);
        }}
        onMouseDown={(e) => {
          if (e.button === 0 && !(e.target as HTMLElement).closest('[data-row], [data-head]')) clearSelection();
        }}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
      >
        <Header cols={cols} widths={widths} total={total} sort={sort} configurable={configurable} onLive={setLive} />
        {items.length === 0 ? (
          <div className="sticky left-0 flex h-[calc(100%-2.8rem)] w-full max-w-[100vw]">{empty}</div>
        ) : (
          <div style={{ height: items.length * rowH, minWidth: total }} className="relative">
            {items.slice(first, last).map((it, i) => (
              <Row key={it.id} id={it.id} cols={cols} widths={widths} top={(first + i) * rowH} height={rowH} total={total} />
            ))}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}

// ---- header ------------------------------------------------------------------------------------

function Header({ cols, widths, total, sort, configurable, onLive }: { cols: ListColumn[]; widths: Record<ListColumn, number>; total: number; sort: { key: string; dir: 'asc' | 'desc' }; configurable?: boolean; onLive: React.Dispatch<React.SetStateAction<Partial<Record<ListColumn, number>>>> }) {
  const userCols = useApp((s) => s.settings.appearance.columns);
  const [dragOver, setDragOver] = React.useState<string | null>(null);

  const startResize = (e: React.PointerEvent, c: ListColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    const x0 = e.clientX, w0 = widths[c];
    grip.setPointerCapture(e.pointerId);
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(40, w0 + ev.clientX - x0);
      onLive((l) => ({ ...l, [c]: w }));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener(
      'lostpointercapture',
      () => {
        grip.removeEventListener('pointermove', move);
        if (configurable && w !== w0) void saveSettings({ appearance: { columnWidths: { [c]: Math.round(w) } } }).then(() => onLive((l) => ({ ...l, [c]: undefined })));
      },
      { once: true },
    );
  };

  const headMenu = (): MenuEntry[] =>
    configurable
      ? [
          { heading: 'Columns' },
          ...USER_COLUMNS.map((k) => ({
            label: COLUMNS[k].long || COLUMNS[k].label,
            checked: userCols.includes(k),
            disabled: k === 'name',
            onSelect: () => void replaceList('appearance', 'columns', userCols.includes(k) ? userCols.filter((x) => x !== k) : [...userCols, k]),
          })),
          '-',
          { label: 'Customize columns…', onSelect: () => openDialog({ type: 'columns' }) },
        ]
      : [];

  return (
    <ContextMenu items={headMenu} disabled={!configurable}>
      <div data-head role="row" className="sticky top-0 z-10 flex h-[2.462rem] items-stretch border-b border-line bg-bg/95 text-xs font-medium text-fg-3 backdrop-blur-sm" style={{ minWidth: total }}>
        <div className="w-4 shrink-0" />
        {cols.map((c) => {
          const def = COLUMNS[c];
          const sorted = def.sortable && sort.key === c;
          return (
            <div
              key={c}
              role="columnheader"
              aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              draggable={configurable}
              onDragStart={(e) => e.dataTransfer.setData('application/x-opendm-col', c)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-opendm-col')) {
                  e.preventDefault();
                  setDragOver(c);
                }
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                setDragOver(null);
                const from = e.dataTransfer.getData('application/x-opendm-col') as ListColumn;
                if (!from || from === c) return;
                const list = userCols.filter((x) => x !== from);
                list.splice(list.indexOf(c as never), 0, from as never);
                void replaceList('appearance', 'columns', list);
              }}
              onClick={() => def.sortable && saveSettings({ appearance: { sort: { key: c, dir: sort.key === c && sort.dir === 'asc' ? 'desc' : 'asc' } } })}
              className={cn('group relative flex shrink-0 items-center gap-1 px-2.5 select-none', def.num && 'justify-end', def.sortable && 'hover:text-fg-2', sorted && 'text-fg', dragOver === c && 'bg-accent-soft', c === 'name' && 'grow')}
              style={{ width: widths[c], flexBasis: widths[c] }}
              title={def.long || def.label}
            >
              <span className="truncate">{def.label}</span>
              {sorted && (sort.dir === 'asc' ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
              <span onPointerDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} className="absolute top-2 right-0 bottom-2 w-2 cursor-col-resize after:absolute after:top-0 after:right-0 after:bottom-0 after:w-px after:bg-line group-hover:after:bg-line-strong" aria-hidden />
            </div>
          );
        })}
        <div className="w-14 shrink-0" />
      </div>
    </ContextMenu>
  );
}

// ---- row ---------------------------------------------------------------------------------------

const Row = React.memo(function Row({ id, cols, widths, top, height, total }: { id: string; cols: ListColumn[]; widths: Record<ListColumn, number>; top: number; height: number; total: number }) {
  const it = useApp((s) => s.items[id]);
  const st = useApp((s) => s.stats[id]);
  const queues = useApp((s) => s.queues);
  const selected = useUi((s) => s.sel.has(id));
  const focused = useUi((s) => s.focus === id);
  if (!it) return null;
  const running = isRunning(it);

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-action]')) return;
    if (e.button === 2) {
      if (!useUi.getState().sel.has(id)) selectOnly(id);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return clickSelect(id, e);
    const { sel } = useUi.getState();
    if (sel.has(id) && sel.size > 1) {
      // Keep a multi-selection for dragging; collapse it on a plain click.
      const up = () => selectOnly(id);
      window.addEventListener('mouseup', up, { once: true });
      window.addEventListener('dragstart', () => window.removeEventListener('mouseup', up), { once: true });
      return;
    }
    selectOnly(id);
  };

  return (
    <div
      data-row={id}
      role="row"
      aria-selected={selected}
      draggable
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => !(e.target as HTMLElement).closest('[data-action]') && openItem(it)}
      onDragStart={(e) => {
        if (!useUi.getState().sel.has(id)) selectOnly(id);
        // A finished file drags out as the file itself; Shift drags the row onto a queue instead.
        if (it.status === 'complete' && !e.shiftKey) {
          e.preventDefault();
          void startDrag(id);
          return;
        }
        e.dataTransfer.setData('application/x-opendm-ids', JSON.stringify([...useUi.getState().sel]));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={cn(
        'group absolute left-0 flex items-center border-b border-line/60 text-sm',
        selected ? 'bg-selected' : 'hover:bg-subtle',
        focused && 'shadow-[inset_2px_0_0_var(--accent)]',
      )}
      style={{ top, height, minWidth: total, width: '100%' }}
    >
      <div className="w-4 shrink-0" />
      {cols.map((c) => {
        const def = COLUMNS[c];
        return (
          <div key={c} role="gridcell" className={cn('flex min-w-0 shrink-0 items-center px-2.5', def.num && 'justify-end', c === 'name' && 'grow')} style={{ width: widths[c], flexBasis: widths[c] }}>
            {def.cell(it, st, { queues })}
          </div>
        );
      })}
      <div data-action className={cn('sticky right-0 flex w-14 shrink-0 items-center justify-end gap-0.5 self-stretch pr-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100', selected ? 'bg-selected opacity-100' : 'group-hover:bg-subtle')}>
        <RowActions it={it} running={running} />
      </div>
    </div>
  );
});

function RowActions({ it, running }: { it: DownloadItem; running: boolean }) {
  const btn = 'grid size-6 place-items-center rounded-md text-fg-3 pressable hover:bg-muted hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted';
  return (
    <>
      {it.status === 'complete' ? (
        <Tooltip content="Open folder">
          <button className={btn} onClick={() => invoke('dl:openFolder', it.id)} aria-label="Open folder">
            <FolderOpen className="size-3.5" />
          </button>
        </Tooltip>
      ) : running ? (
        <Tooltip content="Pause">
          <button className={btn} onClick={() => stop([it])} aria-label="Pause">
            <Pause className="size-3.5" />
          </button>
        </Tooltip>
      ) : canResume(it) ? (
        <Tooltip content="Resume">
          <button className={btn} onClick={() => resume([it])} aria-label="Resume">
            <Play className="size-3.5" />
          </button>
        </Tooltip>
      ) : null}
      <DropdownMenu
        align="end"
        onOpenChange={(o) => o && !useUi.getState().sel.has(it.id) && selectOnly(it.id)}
        items={() => itemMenu(useUi.getState().sel.has(it.id) ? selectedItems() : [it])}
        trigger={
          <button className={btn} aria-label="More actions">
            <MoreHorizontal className="size-3.5" />
          </button>
        }
      />
    </>
  );
}

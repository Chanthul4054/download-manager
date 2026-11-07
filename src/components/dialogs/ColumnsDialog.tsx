import * as React from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { replaceList, useApp } from '@/stores/app';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { COLUMNS, USER_COLUMNS } from '@/components/downloads/columns';
import { cn } from '@/utils/cn';
import type { ColumnKey } from '@/types/models';

/** Show, hide and order the download list's columns. */
export function ColumnsDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const saved = useApp((s) => s.settings.appearance.columns);
  const [shown, setShown] = React.useState<ColumnKey[]>(saved);
  const [order, setOrder] = React.useState<ColumnKey[]>([...saved, ...USER_COLUMNS.filter((k) => !saved.includes(k))]);
  const [sel, setSel] = React.useState<ColumnKey | null>(null);
  const [drag, setDrag] = React.useState<ColumnKey | null>(null);

  const move = (k: ColumnKey, to: number) => {
    const o = order.filter((x) => x !== k);
    o.splice(Math.max(0, Math.min(o.length, to)), 0, k);
    setOrder(o);
  };
  const save = () => {
    void replaceList('appearance', 'columns', order.filter((k) => shown.includes(k)));
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Columns"
      description="Choose the columns of the download list and drag to reorder them."
      size="sm"
      onSubmit={save}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex gap-2">
        <ul className="flex-1 rounded-lg border border-line p-1" role="listbox" aria-label="Columns">
          {order.map((k, i) => (
            <li
              key={k}
              role="option"
              aria-selected={sel === k}
              draggable
              onDragStart={() => setDrag(k)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drag && move(drag, i)}
              onClick={() => setSel(k)}
              className={cn('flex h-7 items-center gap-2 rounded-md px-1.5 text-sm', sel === k ? 'bg-selected' : 'hover:bg-subtle')}
            >
              <GripVertical className="size-3.5 cursor-grab text-fg-3" />
              <Checkbox checked={shown.includes(k)} disabled={k === 'name'} onChange={(v) => setShown(v ? [...shown, k] : shown.filter((x) => x !== k))} aria-label={COLUMNS[k].long || COLUMNS[k].label} />
              <span>{COLUMNS[k].long || COLUMNS[k].label}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1">
          <Button size="icon" disabled={!sel} onClick={() => sel && move(sel, order.indexOf(sel) - 1)} aria-label="Move up">
            <ArrowUp />
          </Button>
          <Button size="icon" disabled={!sel} onClick={() => sel && move(sel, order.indexOf(sel) + 1)} aria-label="Move down">
            <ArrowDown />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

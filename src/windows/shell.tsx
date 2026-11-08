// Layout shared by the small popup windows: a scrolling body over a footer, Esc closes.
import * as React from 'react';
import { closeWindow, invoke, params } from '@/services/ipc';
import { cn } from '@/utils/cn';

export function WindowShell({ children, footer, footerStart, className }: { children: React.ReactNode; footer?: React.ReactNode; footerStart?: React.ReactNode; className?: string }) {
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role=dialog],[role=menu],[role=listbox]') && closeWindow();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)}>{children}</div>
      {(footer || footerStart) && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-raised px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">{footerStart}</div>
          {footer}
        </div>
      )}
    </div>
  );
}

/** The data the opener left for this window (`?token=`), fetched once. */
export function usePayload<T>(): T | null | undefined {
  const [p, setP] = React.useState<T | null | undefined>(undefined);
  React.useEffect(() => {
    const t = params.get('token');
    if (!t) return setP(null);
    void invoke('pending', t).then((x) => setP((x as T) ?? null));
  }, []);
  return p;
}

/** A label/value grid (Address, Status, Size…). */
export function KV({ rows }: { rows: [React.ReactNode, React.ReactNode, string?][] }) {
  return (
    <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v, cls], i) => (
        <React.Fragment key={i}>
          <dt className="text-fg-3">{k}</dt>
          <dd className={cn('min-w-0 truncate', cls)} title={typeof v === 'string' ? v : undefined}>
            {v}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

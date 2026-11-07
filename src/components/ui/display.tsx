// Small display pieces: badge, progress bar, file icon, empty state, section and field layouts.
import * as React from 'react';
import { Archive, AudioLines, Box, File, FileText, Film, Image, Magnet, type LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { FileType } from '@/utils/files';

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet'; children: React.ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-muted text-fg-2',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
    violet: 'bg-violet-soft text-violet',
  };
  return <span className={cn('inline-flex h-[18px] items-center gap-1 rounded-[5px] px-1.5 text-2xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

/** Thin progress bar. `value` null = indeterminate. */
export function Progress({ value, barClass = 'bg-accent', className, striped }: { value: number | null; barClass?: string; className?: string; striped?: boolean }) {
  return (
    <div className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      {value == null ? (
        <div className={cn('absolute inset-y-0 w-2/5 rounded-full opacity-70 animate-indeterminate', barClass)} />
      ) : (
        <div className={cn('h-full origin-left rounded-full transition-transform duration-500 ease-linear will-change-transform', barClass, striped && 'opacity-60')} style={{ transform: `scaleX(${value / 100})` }} />
      )}
    </div>
  );
}

const ICONS: Record<FileType, [LucideIcon, string]> = {
  archive: [Archive, 'text-[#b7791f] bg-[#b7791f]/12'],
  video: [Film, 'text-[#d6336c] bg-[#d6336c]/12'],
  audio: [AudioLines, 'text-[#0c8599] bg-[#0c8599]/12'],
  image: [Image, 'text-[#8c46c7] bg-[#8c46c7]/12'],
  document: [FileText, 'text-[#2f6fe0] bg-[#2f6fe0]/12'],
  program: [Box, 'text-[#4f5bd5] bg-[#4f5bd5]/12'],
  torrent: [Magnet, 'text-[#0d8a72] bg-[#0d8a72]/12'],
  other: [File, 'text-fg-3 bg-muted'],
};

export function FileIcon({ type, className, size = 'md' }: { type: FileType; className?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [Icon, tone] = ICONS[type];
  const box = { sm: 'size-5 rounded-[5px] [&>svg]:size-3', md: 'size-6 rounded-md [&>svg]:size-3.5', lg: 'size-9 rounded-lg [&>svg]:size-[18px]', xl: 'size-12 rounded-xl [&>svg]:size-6' }[size];
  return (
    <span className={cn('grid shrink-0 place-items-center', box, tone, className)} aria-hidden>
      <Icon strokeWidth={1.9} />
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children, action, className }: { icon: LucideIcon; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-subtle text-fg-3">
        <Icon className="size-5" strokeWidth={1.75} />
      </div>
      <div className="text-base font-semibold text-fg">{title}</div>
      {children && <div className="mt-1 max-w-80 text-sm text-fg-2">{children}</div>}
      {action && <div className="mt-4 flex gap-2">{action}</div>}
    </div>
  );
}

/** A titled group of settings rows. */
export function Section({ title, description, children, className, actions }: { title?: string; description?: React.ReactNode; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={cn('mb-7', className)}>
      {(title || actions) && (
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="divide-y divide-line rounded-lg border border-line bg-surface">{children}</div>
    </section>
  );
}

/** One settings row: label and hint on the left, control on the right (or below when `stack`). */
export function Row({ label, hint, children, stack, className }: { label?: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; stack?: boolean; className?: string }) {
  return (
    <div className={cn('flex gap-4 px-3.5 py-2.5', stack ? 'flex-col gap-2' : 'items-center justify-between', className)}>
      {(label || hint) && (
        <div className="min-w-0">
          {label && <div className="text-sm text-fg">{label}</div>}
          {hint && <div className="mt-0.5 text-xs text-fg-3">{hint}</div>}
        </div>
      )}
      {children != null && <div className={cn('flex shrink-0 items-center gap-2', stack && 'w-full min-w-0')}>{children}</div>}
    </div>
  );
}

/** Vertical label + control, for dialogs. */
export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="text-xs font-medium text-fg-2">{label}</div>
      {children}
      {hint && <div className="text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

export function Callout({ tone = 'accent', children, className }: { tone?: 'accent' | 'warn' | 'danger' | 'info'; children: React.ReactNode; className?: string }) {
  const t = { accent: 'bg-accent-soft border-accent/20', warn: 'bg-warn-soft border-warn/25', danger: 'bg-danger-soft border-danger/25 text-danger', info: 'bg-info-soft border-info/20' }[tone];
  return <div className={cn('rounded-lg border px-3 py-2.5 text-sm', t, className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent', className)} aria-hidden />;
}

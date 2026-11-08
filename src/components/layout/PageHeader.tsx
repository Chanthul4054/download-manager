import * as React from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApp } from '@/stores/app';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlay';
import { DropdownMenu } from '@/components/ui/menu';
import { cn } from '@/utils/cn';

export function PageHeader({ title, icon: Icon, subtitle, children, className }: { title: React.ReactNode; icon?: LucideIcon; subtitle?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <header className={cn('flex h-12 shrink-0 items-center gap-3 border-b border-line px-4', className)}>
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {Icon && <Icon className="size-4 shrink-0 text-fg-3" strokeWidth={1.9} />}
        <h1 className="truncate text-[1.05rem] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <span className="truncate text-sm text-fg-3">{subtitle}</span>}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">{children}</div>
    </header>
  );
}

export function SubBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex h-10 shrink-0 items-center gap-2 border-b border-line px-4', className)}>{children}</div>;
}

/** A toolbar button that follows Settings → Appearance → Toolbar (labels or icons only). */
export function ToolButton({ icon: Icon, label, tip, kbd, onClick, disabled, primary, className }: { icon: LucideIcon; label: string; tip?: string; kbd?: string; onClick?: () => void; disabled?: boolean; primary?: boolean; className?: string }) {
  const style = useApp((s) => s.settings.appearance.toolbar);
  const iconsOnly = style === 'icons';
  const b = (
    <Button variant={primary ? 'primary' : 'ghost'} size={iconsOnly ? 'icon' : style === 'small' ? 'sm' : 'md'} onClick={onClick} disabled={disabled} aria-label={label} className={cn(!primary && 'text-fg-2', className)}>
      <Icon />
      {!iconsOnly && <span>{label}</span>}
    </Button>
  );
  return (
    <Tooltip content={iconsOnly ? label : tip} kbd={kbd}>
      {/* Disabled buttons swallow pointer events, so the tooltip hangs off a wrapper. */}
      {disabled ? <span className="inline-flex">{b}</span> : b}
    </Tooltip>
  );
}

export function Divider() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-line" />;
}

/** The list search field, with "Find" options (fields, match case, whole). Ctrl+F focuses it. */
export function SearchField({ placeholder = 'Search', withOptions }: { placeholder?: string; withOptions?: boolean }) {
  const search = useUi((s) => s.search);
  const o = useUi((s) => s.findOpts);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const f = () => {
      ref.current?.focus();
      ref.current?.select();
    };
    document.addEventListener('odm:find', f);
    return () => document.removeEventListener('odm:find', f);
  }, []);
  const setOpt = (k: keyof typeof o) => useUi.setState((s) => ({ findOpts: { ...s.findOpts, [k]: !s.findOpts[k] } }));
  return (
    <div className="relative flex h-7 w-60 items-center rounded-md border border-line bg-subtle/60 transition-colors focus-within:border-accent focus-within:bg-surface focus-within:ring-3 focus-within:ring-ring/40">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-fg-3" />
      <input
        ref={ref}
        value={search}
        onChange={(e) => useUi.setState({ search: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            useUi.setState({ search: '' });
            ref.current?.blur();
          }
          if (e.key === 'Enter') document.dispatchEvent(new CustomEvent('odm:findNext'));
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent pr-1 pl-7 text-sm outline-none placeholder:text-fg-3"
      />
      {search && (
        <button onClick={() => useUi.setState({ search: '' })} className="grid size-5 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
      {withOptions && (
        <DropdownMenu
          align="end"
          items={[
            { heading: 'Look in' },
            { label: 'File name', checked: o.name, onSelect: () => setOpt('name') },
            { label: 'Description', checked: o.description, onSelect: () => setOpt('description') },
            { label: 'Address, referer and page', checked: o.address, onSelect: () => setOpt('address') },
            '-',
            { label: 'Match case', checked: o.matchCase, onSelect: () => setOpt('matchCase') },
            { label: 'Match whole text only', checked: o.whole, onSelect: () => setOpt('whole') },
          ]}
          trigger={
            <button className="mr-0.5 grid size-6 place-items-center rounded text-fg-3 outline-none hover:text-fg data-[state=open]:text-fg" aria-label="Search options">
              <SlidersHorizontal className="size-3.5" />
            </button>
          }
        />
      )}
    </div>
  );
}

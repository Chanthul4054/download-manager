// Dialog, tooltip, popover and tabs.
import * as React from 'react';
import { Dialog as DialogP, Tooltip as TooltipP, Popover as PopoverP, Tabs as TabsP } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Kbd } from './controls';

// ---- dialog ------------------------------------------------------------------------------------

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Left side of the footer. */
  footerStart?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  bodyClassName?: string;
  /** Pressing Enter outside a textarea or button runs this. */
  onSubmit?: () => void;
}

/** True while a host keeps an already-closed dialog mounted so its exit animation can play. */
export const DialogClosing = React.createContext(false);

/** Keeps the last non-null `value` for `ms` after it becomes null; `closing` is true meanwhile. */
export function useExitHold<T>(value: T | null, ms = 130): [T | null, boolean] {
  const [held, setHeld] = React.useState(value);
  React.useEffect(() => {
    if (value) return setHeld(value);
    const t = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [value ?? held, !value && !!held];
}

const sizes = { sm: 'w-[min(26rem,calc(100vw-2rem))]', md: 'w-[min(34rem,calc(100vw-2rem))]', lg: 'w-[min(46rem,calc(100vw-2rem))]', xl: 'w-[min(60rem,calc(100vw-2rem))]' };

export function Dialog({ open, onOpenChange, title, description, children, footer, footerStart, size = 'md', className, bodyClassName, onSubmit }: DialogProps) {
  return (
    <DialogP.Root open={open && !React.useContext(DialogClosing)} onOpenChange={onOpenChange}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] animate-fade dark:bg-black/50" />
        <DialogP.Content
          aria-describedby={description ? undefined : undefined}
          onKeyDown={(e) => {
            const t = e.target as HTMLElement;
            if (e.key === 'Enter' && onSubmit && t.tagName !== 'TEXTAREA' && t.tagName !== 'BUTTON' && !t.closest('[role=listbox],[role=menu]')) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className={cn('fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-raised shadow-dialog outline-none animate-dialog', sizes[size], className)}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
            <div className="min-w-0">
              <DialogP.Title className="text-lg font-semibold tracking-[-0.01em] text-fg">{title}</DialogP.Title>
              {description ? <DialogP.Description className="mt-0.5 text-sm text-fg-2">{description}</DialogP.Description> : <DialogP.Description className="sr-only">{typeof title === 'string' ? title : ''}</DialogP.Description>}
            </div>
            <DialogP.Close className="-mr-1.5 grid size-6 place-items-center rounded-md text-fg-3 pressable hover:bg-subtle hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </DialogP.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-4', bodyClassName)}>{children}</div>
          {(footer || footerStart) && (
            <div className="flex items-center gap-2 border-t border-line px-5 py-3">
              <div className="flex flex-1 items-center gap-2">{footerStart}</div>
              {footer}
            </div>
          )}
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

// ---- tooltip -----------------------------------------------------------------------------------

export const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipP.Provider delayDuration={500} skipDelayDuration={200}>
    {children}
  </TooltipP.Provider>
);

export function Tooltip({ content, kbd, children, side = 'bottom' }: { content: React.ReactNode; kbd?: string; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return children;
  return (
    <TooltipP.Root>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content side={side} sideOffset={6} className="z-50 flex max-w-72 items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop data-[state=delayed-open]:animate-fade dark:bg-muted dark:text-fg">
          {content}
          {kbd && <Kbd className="border-transparent bg-white/15 text-inherit">{kbd}</Kbd>}
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}

// ---- popover -----------------------------------------------------------------------------------

export function Popover({ trigger, children, align = 'start', className, open, onOpenChange }: { trigger: React.ReactNode; children: React.ReactNode; align?: 'start' | 'end' | 'center'; className?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <PopoverP.Root open={open} onOpenChange={onOpenChange}>
      <PopoverP.Trigger asChild>{trigger}</PopoverP.Trigger>
      <PopoverP.Portal>
        <PopoverP.Content align={align} sideOffset={6} className={cn('z-50 w-72 rounded-lg bg-raised p-3 shadow-pop outline-none animate-pop', className)}>
          {children}
        </PopoverP.Content>
      </PopoverP.Portal>
    </PopoverP.Root>
  );
}

// ---- tabs (underline style) --------------------------------------------------------------------

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: React.ReactNode; count?: number }[]; className?: string }) {
  return (
    <TabsP.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <TabsP.List className={cn('flex items-center gap-0.5', className)}>
        {tabs.map((t) => (
          <TabsP.Trigger
            key={t.value}
            value={t.value}
            className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-2 outline-none pressable hover:bg-subtle hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=active]:bg-muted data-[state=active]:text-fg"
          >
            {t.label}
            {t.count != null && <span className="tnum text-xs text-fg-3">{t.count}</span>}
          </TabsP.Trigger>
        ))}
      </TabsP.List>
    </TabsP.Root>
  );
}

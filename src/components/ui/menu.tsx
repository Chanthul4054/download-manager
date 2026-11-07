// Dropdown and context menus from one data description, so a row's context menu and its "…" button
// show the same actions.
import * as React from 'react';
import { ContextMenu as CM, DropdownMenu as DM } from 'radix-ui';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export type MenuEntry =
  | {
      label: React.ReactNode;
      icon?: LucideIcon;
      onSelect?: () => void;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      kbd?: string;
      sub?: MenuEntry[];
    }
  | '-'
  | { heading: string }
  | null
  | false
  | undefined;

const content = 'z-50 min-w-48 overflow-hidden rounded-lg bg-raised p-1 text-sm text-fg shadow-pop animate-pop';
const itemCls =
  'relative flex h-7 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-[highlighted]:bg-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-3';

type Prims = typeof CM | typeof DM;

function Entries({ P, items }: { P: Prims; items: MenuEntry[] }) {
  const list = items.filter(Boolean) as Exclude<MenuEntry, null | false | undefined>[];
  // Drop separators at the ends and doubled ones (left by hidden items).
  const clean = list.filter((e, i) => e !== '-' || (i > 0 && i < list.length - 1 && list[i - 1] !== '-'));
  const anyChecks = clean.some((e) => typeof e === 'object' && 'label' in e && e.checked !== undefined);
  return (
    <>
      {clean.map((e, i) => {
        if (e === '-') return <P.Separator key={i} className="-mx-1 my-1 h-px bg-line" />;
        if ('heading' in e) return <P.Label key={i} className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-3 uppercase">{e.heading}</P.Label>;
        const Icon = e.icon;
        const inner = (
          <>
            {anyChecks && <span className="grid w-3.5 place-items-center">{e.checked && <Check className="size-3.5 text-accent" />}</span>}
            {Icon && <Icon />}
            <span className="flex-1 truncate">{e.label}</span>
            {e.kbd && <span className="ml-4 text-xs text-fg-3">{e.kbd}</span>}
          </>
        );
        if (e.sub) {
          return (
            <P.Sub key={i}>
              <P.SubTrigger disabled={e.disabled} className={cn(itemCls, 'data-[state=open]:bg-subtle')}>
                {inner}
                <ChevronRight className="ml-auto" />
              </P.SubTrigger>
              <P.Portal>
                <P.SubContent className={content} sideOffset={4} alignOffset={-4}>
                  <Entries P={P} items={e.sub} />
                </P.SubContent>
              </P.Portal>
            </P.Sub>
          );
        }
        return (
          <P.Item key={i} disabled={e.disabled} onSelect={e.onSelect} className={cn(itemCls, e.danger && 'text-danger [&>svg]:text-danger data-[highlighted]:bg-danger-soft')}>
            {inner}
          </P.Item>
        );
      })}
    </>
  );
}

export function DropdownMenu({ trigger, items, align = 'start', side = 'bottom', onOpenChange }: { trigger: React.ReactNode; items: MenuEntry[] | (() => MenuEntry[]); align?: 'start' | 'end' | 'center'; side?: 'bottom' | 'top' | 'right'; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <DM.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} side={side} sideOffset={4} className={content} onCloseAutoFocus={(e) => e.preventDefault()}>
          {open && <Entries P={DM} items={typeof items === 'function' ? items() : items} />}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** Wraps children so a right-click opens the menu. `items` is computed when it opens. */
export function ContextMenu({ children, items, onOpenChange, disabled }: { children: React.ReactNode; items: () => MenuEntry[]; onOpenChange?: (open: boolean) => void; disabled?: boolean }) {
  const [entries, setEntries] = React.useState<MenuEntry[]>([]);
  return (
    <CM.Root
      onOpenChange={(o) => {
        if (o) setEntries(items());
        onOpenChange?.(o);
      }}
    >
      <CM.Trigger asChild disabled={disabled}>
        {children}
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className={content}>
          <Entries P={CM} items={entries} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

import * as React from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Download, Film, Globe, History, Link2, ListOrdered, Magnet, PanelLeft, Plus, RefreshCw, Settings, Folder, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/services/ipc';
import { saveSettings, useApp } from '@/stores/app';
import { navigate, openDialog, useUi, type Page } from '@/stores/ui';
import { appMenu } from '@/app/appMenu';
import { newQueue } from '@/app/commands';
import { confirm } from '@/components/dialogs/confirm';
import { ContextMenu, DropdownMenu } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';
import { isTorrent, isVideo } from '@/utils/files';
import { isRunning } from '@/utils/status';
import logo from '@/assets/icon.png';
import type { Category } from '@/types/models';

function useCounts() {
  const rev = useApp((s) => s.rev);
  return React.useMemo(() => {
    const items = Object.values(useApp.getState().items);
    return {
      all: items.length,
      active: items.filter(isRunning).length,
      video: items.filter(isVideo).length,
      torrents: items.filter(isTorrent).length,
      history: items.filter((x) => x.status === 'complete').length,
      byCat: items.reduce<Record<string, number>>((m, x) => ((m[x.category || 'general'] = (m[x.category || 'general'] || 0) + 1), m), {}),
    };
  }, [rev]);
}

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('odm.sidebarGroups') || '{}');
  } catch {
    return {};
  }
}

export function Sidebar() {
  const showFull = useApp((s) => s.settings.appearance.showCategories);
  const queues = useApp((s) => s.queues);
  const categories = useApp((s) => s.categories);
  const lgCount = useApp((s) => s.lgCount);
  const grabbers = useApp((s) => s.grabbers);
  const { page, category, queueId } = useUi();
  const counts = useCounts();
  const [groups, setGroups] = React.useState(readCollapsed);
  const toggleGroup = (k: string) =>
    setGroups((g) => {
      const n = { ...g, [k]: !g[k] };
      try {
        localStorage.setItem('odm.sidebarGroups', JSON.stringify(n));
      } catch {
        /* storage unavailable */
      }
      return n;
    });
  const collapsed = !showFull;
  const grabbing = grabbers.some((g) => g.running);

  const item = (p: Page, label: string, icon: LucideIcon, count?: number | null, extra?: { active?: boolean; dot?: boolean; kbd?: string }) => (
    <NavItem key={p} icon={icon} label={label} count={count} collapsed={collapsed} dot={extra?.dot} kbd={extra?.kbd} active={extra?.active ?? (page === p && (p !== 'downloads' || !category))} onClick={() => navigate(p, p === 'downloads' ? { category: null } : {})} />
  );

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? '3.7rem' : '15.4rem' }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar"
      aria-label="Navigation"
    >
      <div className={cn('flex h-12 shrink-0 items-center gap-1 px-2.5', collapsed && 'justify-center px-0')}>
        <DropdownMenu
          items={appMenu}
          trigger={
            <button className={cn('flex min-w-0 items-center gap-2 rounded-md p-1 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=open]:bg-muted', !collapsed && 'pr-1.5')} aria-label="OpenDM menu">
              <img src={logo} alt="" className="size-[22px] rounded-[6px]" draggable={false} />
              {!collapsed && (
                <>
                  <span className="truncate text-[0.96rem] font-semibold tracking-[-0.01em]">OpenDM</span>
                  <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
                </>
              )}
            </button>
          }
        />
        {!collapsed && (
          <Tooltip content="Collapse sidebar">
            <Button variant="ghost" size="icon-sm" className="ml-auto text-fg-3" onClick={() => saveSettings({ appearance: { showCategories: false } })} aria-label="Collapse sidebar">
              <PanelLeft />
            </Button>
          </Tooltip>
        )}
      </div>

      <div className={cn('px-2.5 pb-2', collapsed && 'px-2')}>
        <Tooltip content={collapsed ? 'New download' : null} kbd="Ctrl+N" side="right">
          <Button variant="secondary" className={cn('w-full justify-start gap-2', collapsed && 'justify-center px-0')} onClick={() => openDialog({ type: 'addUrl' })} aria-label="New download">
            <Plus className="text-accent" />
            {!collapsed && <span>New download</span>}
            {!collapsed && <span className="ml-auto text-2xs font-normal text-fg-3">Ctrl N</span>}
          </Button>
        </Tooltip>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-x-hidden overflow-y-auto px-2 pb-2">
        {item('downloads', 'Downloads', Download, counts.all, { dot: counts.active > 0 })}
        {item('video', 'Video', Film, counts.video || null)}
        {item('torrents', 'BitTorrent', Magnet, counts.torrents || null)}
        {item('history', 'History', History, null)}

        <Gap collapsed={collapsed} />
        {item('linkgrabber', 'LinkGrabber', Link2, lgCount || null)}
        {item('grabber', 'Site Grabber', Globe, grabbers.length || null, { dot: grabbing })}

        <Group title="Queues" collapsed={collapsed} closed={!!groups.queues} onToggle={() => toggleGroup('queues')} onAdd={() => newQueue()} addLabel="New queue">
          {collapsed
            ? item('queues', 'Queues', ListOrdered, null, { dot: queues.some((q) => q.running) })
            : queues.map((q) => (
                <QueueNode key={q.id} id={q.id} name={q.name} sync={q.type === 'sync'} count={q.items.length} running={!!q.running} active={page === 'queues' && (queueId ?? queues[0]?.id) === q.id} />
              ))}
        </Group>

        {!collapsed && (
          <Group title="Categories" collapsed={false} closed={!!groups.cats} onToggle={() => toggleGroup('cats')} onAdd={() => openDialog({ type: 'category' })} addLabel="New category">
            {categories.map((c) => (
              <CategoryNode key={c.id} c={c} count={counts.byCat[c.id] || 0} active={page === 'downloads' && category === c.id} />
            ))}
          </Group>
        )}
      </nav>

      <div className="flex flex-col gap-px border-t border-line px-2 py-2">
        {item('settings', 'Settings', Settings, null, { kbd: 'Ctrl+,' })}
        {collapsed && (
          <NavItem icon={PanelLeft} label="Expand sidebar" collapsed onClick={() => saveSettings({ appearance: { showCategories: true } })} />
        )}
      </div>
    </motion.aside>
  );
}

function Gap({ collapsed }: { collapsed: boolean }) {
  return <div className={cn('my-1.5 h-px shrink-0 bg-line', !collapsed && 'mx-2 bg-transparent my-1')} />;
}

function NavItem({ icon: Icon, label, count, active, collapsed, dot, onClick, kbd, depth = 0, className, ...rest }: { icon: LucideIcon; label: string; count?: number | null; active?: boolean; collapsed?: boolean; dot?: boolean; onClick?: () => void; kbd?: string; depth?: number; className?: string } & React.HTMLAttributes<HTMLButtonElement>) {
  const btn = (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 outline-none hover:bg-muted hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/40',
        active && 'bg-muted font-medium text-fg',
        collapsed && 'justify-center px-0',
        depth && !collapsed && 'pl-2',
        className,
      )}
      {...rest}
    >
      <span className="relative">
        <Icon className={cn('size-4 shrink-0 text-fg-3 group-hover:text-fg-2', active && 'text-accent group-hover:text-accent')} strokeWidth={1.9} />
        {dot && collapsed && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent ring-2 ring-sidebar" />}
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && dot && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Running" />}
      {!collapsed && count != null && <span className="tnum shrink-0 text-xs text-fg-3">{count}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} kbd={kbd} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

function Group({ title, collapsed, closed, onToggle, onAdd, addLabel, children }: { title: string; collapsed: boolean; closed: boolean; onToggle: () => void; onAdd: () => void; addLabel: string; children: React.ReactNode }) {
  if (collapsed) return <>{children}</>;
  return (
    <div className="mt-3 flex flex-col gap-px">
      <div className="group flex h-6 items-center px-2">
        <button onClick={onToggle} className="flex flex-1 items-center gap-1 text-xs font-medium text-fg-3 outline-none hover:text-fg-2" aria-expanded={!closed}>
          {title}
          <ChevronDown className={cn('size-3 opacity-0 transition-transform group-hover:opacity-100', closed && '-rotate-90 opacity-100')} />
        </button>
        <Tooltip content={addLabel}>
          <button onClick={onAdd} className="grid size-5 place-items-center rounded-md text-fg-3 opacity-0 outline-none group-hover:opacity-100 hover:bg-muted hover:text-fg focus-visible:opacity-100" aria-label={addLabel}>
            <Plus className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      {!closed && children}
    </div>
  );
}

function QueueNode({ id, name, sync, count, running, active }: { id: string; name: string; sync: boolean; count: number; running: boolean; active: boolean }) {
  const [over, setOver] = React.useState(false);
  const q = () => useApp.getState().queues.find((x) => x.id === id);
  return (
    <ContextMenu
      items={() => [
        { label: 'Start', disabled: running, onSelect: () => invoke('q:start', id) },
        { label: 'Stop', disabled: !running, onSelect: () => invoke('q:stop', id) },
        '-',
        { label: 'Edit queue and schedule', onSelect: () => navigate('queues', { queueId: id }) },
        { label: 'New queue…', onSelect: () => newQueue() },
        !q()?.builtin && {
          label: 'Delete queue',
          danger: true,
          onSelect: async () => (await confirm(`Delete queue “${name}”?`, { okLabel: 'Delete', danger: true, message: 'Downloads in it stay in the list.' })) && invoke('q:remove', id),
        },
      ]}
    >
      <NavItem
        icon={sync ? RefreshCw : ListOrdered}
        label={name}
        count={count}
        dot={running}
        active={active || over}
        className={cn(over && 'ring-2 ring-accent/50')}
        onClick={() => navigate('queues', { queueId: id })}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-opendm-ids')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const ids = JSON.parse(e.dataTransfer.getData('application/x-opendm-ids') || '[]') as string[];
          if (ids.length) {
            e.preventDefault();
            e.stopPropagation();
            void invoke('q:addItems', id, ids);
            toast(`Added ${ids.length} to “${name}”`);
          }
        }}
      />
    </ContextMenu>
  );
}

function CategoryNode({ c, count, active }: { c: Category; count: number; active: boolean }) {
  return (
    <ContextMenu
      items={() => [
        { label: 'Open folder', onSelect: () => invoke('util:openPath', c.folder) },
        { label: 'Edit category…', onSelect: () => openDialog({ type: 'category', category: c }) },
        { label: 'New category…', onSelect: () => openDialog({ type: 'category' }) },
        c.id !== 'general' && {
          label: 'Delete category',
          danger: true,
          onSelect: async () => {
            if (!(await confirm(`Delete category “${c.name}”?`, { okLabel: 'Delete', danger: true, message: 'Downloads in it stay in the list.' }))) return;
            void invoke('cats:save', useApp.getState().categories.filter((x) => x.id !== c.id));
            if (useUi.getState().category === c.id) navigate('downloads', { category: null });
          },
        },
      ]}
    >
      <NavItem icon={Folder} label={c.name} count={count || null} active={active} onClick={() => navigate('downloads', { category: c.id })} />
    </ContextMenu>
  );
}

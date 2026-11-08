import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Folder, FileType2, Gauge, Info, KeyRound, Magnet, Network, Palette, Puzzle, Settings, Shield, Video, Volume2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/services/ipc';
import { replaceList, useApp } from '@/stores/app';
import { useUi, type SettingsSection } from '@/stores/ui';
import { confirm } from '@/components/dialogs/confirm';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';
import * as S from '@/components/settings/sections';
import type { Category, Settings as SettingsT } from '@/types/models';

const NAV: { group: string; items: [SettingsSection, string, LucideIcon][] }[] = [
  { group: 'App', items: [['general', 'General', Settings], ['appearance', 'Appearance', Palette], ['sounds', 'Notifications', Volume2]] },
  { group: 'Downloads', items: [['downloads', 'Downloads', Download], ['saveto', 'Folders', Folder], ['filetypes', 'File types', FileType2]] },
  { group: 'Network', items: [['connection', 'Connections', Network], ['limits', 'Speed and limits', Gauge], ['proxy', 'Proxy', Shield], ['logins', 'Site logins', KeyRound]] },
  { group: 'Integrations', items: [['browser', 'Browser', Puzzle], ['video', 'Video', Video], ['torrent', 'BitTorrent', Magnet]] },
  { group: '', items: [['about', 'About', Info]] },
];
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map(([k, l]) => [k, l]))) as Record<SettingsSection, string>;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Problems that would break something if saved (a bad port, a zero quota…). */
function validate(s: SettingsT): string[] {
  const e: string[] = [];
  const p = s.general.integrationPort;
  if (!Number.isInteger(p) || p < 1024 || p > 65535) e.push('The browser integration port must be between 1024 and 65535.');
  if (!(s.connection.timeoutSec >= 5)) e.push('The connection timeout must be at least 5 seconds.');
  if (!(s.connection.minSegmentKB >= 64)) e.push('The minimum segment size must be at least 64 KB.');
  if (s.connection.quota.enabled && !(s.connection.quota.mb >= 1 && s.connection.quota.hours >= 1)) e.push('The download limit needs at least 1 MB per 1 hour.');
  if (s.speedLimiter.enabled && !(s.speedLimiter.kbps >= 1)) e.push('The speed limit must be at least 1 KB/s.');
  if (!(s.downloads.maxSimultaneous >= 0)) e.push('Downloads at the same time cannot be negative.');
  const tp = s.torrent.listenPort;
  if (!Number.isInteger(tp) || tp < 0 || tp > 65535) e.push('The BitTorrent port must be between 0 and 65535.');
  return e;
}

export function SettingsPage() {
  const section = useUi((s) => s.settingsSection);
  const settings = useApp((s) => s.settings);
  const categories = useApp((s) => s.categories);
  const [draft, setDraft] = React.useState(() => clone(settings));
  const [cats, setCats] = React.useState<Category[]>(() => clone(categories));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const catsDirty = JSON.stringify(cats) !== JSON.stringify(categories);
  const errors = validate(draft);

  // Changes made elsewhere (tray, status bar, Appearance) flow in while there is nothing unsaved.
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    if (!dirtyRef.current) setDraft(clone(settings));
    else setDraft((d) => ({ ...d, appearance: clone(settings.appearance), firstRun: settings.firstRun }));
  }, [settings]);
  React.useEffect(() => setCats(clone(categories)), [categories]);

  const save = async () => {
    if (errors.length) return toast.error(errors[0]);
    try {
      if (dirty) {
        await invoke('settings:save', draft);
        for (const [sec, key] of [['fileTypes', 'excludedAddresses'], ['connection', 'serverExceptions']] as const) await replaceList(sec, key, (draft[sec] as unknown as Record<string, unknown[]>)[key]);
      }
      if (catsDirty) await invoke('cats:save', cats);
      toast('Settings saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const discard = () => {
    setDraft(clone(settings));
    setCats(clone(categories));
  };

  const ctx: S.SectionProps = { s: draft, set: setDraft, cats, setCats };
  const Body = {
    general: S.General, appearance: S.Appearance, sounds: S.Sounds, downloads: S.Downloads, saveto: S.Folders, filetypes: S.FileTypes,
    connection: S.Connections, limits: S.Limits, proxy: S.Proxy, logins: S.Logins, browser: S.Browser, video: S.VideoSection, torrent: S.Torrent, about: S.About,
  }[section];

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line px-2 py-4" aria-label="Settings">
        {NAV.map((g, i) => (
          <div key={i} className="flex flex-col gap-px">
            {g.group && <div className="px-2 pb-1 text-xs font-medium text-fg-3">{g.group}</div>}
            {g.items.map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => useUi.setState({ settingsSection: k })}
                aria-current={section === k ? 'page' : undefined}
                className={cn('flex h-7 items-center gap-2 rounded-md px-2 text-sm text-fg-2 outline-none hover:bg-subtle hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/40', section === k && 'bg-muted font-medium text-fg')}
              >
                <Icon className={cn('size-4 text-fg-3', section === k && 'text-accent')} strokeWidth={1.9} />
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[46rem] px-8 pt-8 pb-10">
            <h1 className="mb-6 text-xl font-semibold tracking-[-0.015em]">{TITLES[section]}</h1>
            <Body {...ctx} />
          </div>
        </div>
        <AnimatePresence>
          {(dirty || catsDirty) && (
            <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }} transition={{ duration: 0.14 }} className="flex shrink-0 items-center gap-2 border-t border-line bg-raised px-6 py-2.5">
              <span className={cn('flex-1 truncate text-sm', errors.length ? 'text-danger' : 'text-fg-2')}>{errors[0] || 'You have unsaved changes'}</span>
              <Button onClick={discard}>Discard</Button>
              <Button variant="primary" onClick={save} disabled={errors.length > 0}>
                Save changes
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export async function resetAllSettings() {
  if (await confirm('Reset every setting to its default?', { okLabel: 'Reset', danger: true, message: 'Downloads, queues and categories are kept.' })) {
    await invoke('settings:reset');
    toast('Settings reset');
  }
}

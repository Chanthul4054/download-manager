// Every settings section. Each edits the draft (`s` / `set`) except Appearance, which applies at once.
import * as React from 'react';
import { BookOpen, Copy, FolderOpen, Lightbulb, Plus, RotateCcw, Trash2, Moon, Sun, Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { invoke, runMenu } from '@/services/ipc';
import { saveSettings, useApp } from '@/stores/app';
import { openDialog } from '@/stores/ui';
import { copyText } from '@/app/commands';
import { Button } from '@/components/ui/button';
import { Input, NumberInput, Textarea } from '@/components/ui/input';
import { Checkbox, RadioGroup, Select, Slider, Switch } from '@/components/ui/controls';
import { Badge, Callout, Row, Section, Spinner } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { resetAllSettings } from '@/pages/SettingsPage';
import { cn } from '@/utils/cn';
import logo from '@/assets/icon.png';
import type { Category, ProxyEntry, Settings } from '@/types/models';

export interface SectionProps {
  s: Settings;
  set: React.Dispatch<React.SetStateAction<Settings>>;
  cats: Category[];
  setCats: (c: Category[]) => void;
}

/** Immutable update of one settings group. */
function useGroup<K extends keyof Settings>(set: SectionProps['set'], k: K) {
  return (patch: Partial<Settings[K]>) => set((s) => ({ ...s, [k]: { ...(s[k] as object), ...patch } }));
}

const Toggle = ({ label, hint, checked, onChange, disabled }: { label: React.ReactNode; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <Row label={label} hint={hint} className={cn(disabled && 'opacity-50')}>
    <Switch checked={checked} onChange={onChange} disabled={disabled} aria-label={typeof label === 'string' ? label : undefined} />
  </Row>
);

const Unit = ({ children }: { children: React.ReactNode }) => <span className="text-sm text-fg-2">{children}</span>;

// ---- App ---------------------------------------------------------------------------------------

export function General({ s, set }: SectionProps) {
  const g = useGroup(set, 'general');
  return (
    <>
      <Section title="System">
        <Toggle label="Launch OpenDM when I sign in" checked={s.general.launchOnStartup} onChange={(v) => g({ launchOnStartup: v })} />
        <Toggle label="Keep running in the notification area" hint="Closing the window leaves OpenDM running so downloads and queues continue." checked={s.general.minimizeToTray} onChange={(v) => g({ minimizeToTray: v })} />
        <Toggle label="Start downloading addresses copied to the clipboard" checked={s.general.monitorClipboard} onChange={(v) => g({ monitorClipboard: v })} />
      </Section>
      <Section title="Help">
        <Row label="Getting started, shortcuts and the command line">
          <Button onClick={() => openDialog({ type: 'help', topic: 'start' })}>
            <BookOpen />
            Open help
          </Button>
        </Row>
        <Row label="Tip of the day">
          <Button onClick={() => openDialog({ type: 'tip' })}>
            <Lightbulb />
            Show a tip
          </Button>
        </Row>
      </Section>
    </>
  );
}

export function Appearance() {
  const a = useApp((st) => st.settings.appearance);
  const ap = (patch: Partial<Settings['appearance']>) => saveSettings({ appearance: patch });
  const themes = [['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const;
  return (
    <>
      <Section title="Theme" description="Applied right away.">
        <div className="grid grid-cols-3 gap-3 p-3">
          {themes.map(([v, label, Icon]) => (
            <button key={v} onClick={() => ap({ theme: v })} aria-pressed={a.theme === v} className={cn('flex flex-col overflow-hidden rounded-lg border text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40', a.theme === v ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong')}>
              <ThemePreview kind={v} />
              <span className="flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium">
                <Icon className="size-3.5 text-fg-3" />
                {label}
              </span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Layout">
        <Row label="Text size" hint="Scales the whole window. Ctrl+= and Ctrl+- also work.">
          <Button size="icon" onClick={() => ap({ fontSize: Math.max(10, a.fontSize - 1) })} aria-label="Smaller">
            −
          </Button>
          <span className="tnum w-12 text-center text-sm">{a.fontSize}px</span>
          <Button size="icon" onClick={() => ap({ fontSize: Math.min(20, a.fontSize + 1) })} aria-label="Larger">
            +
          </Button>
          <Button variant="ghost" size="sm" disabled={a.fontSize === 13} onClick={() => ap({ fontSize: 13 })}>
            Reset
          </Button>
        </Row>
        <Row label="Toolbar buttons">
          <Select value={a.toolbar} onChange={(v) => ap({ toolbar: v })} options={[['large', 'Icons and labels'], ['small', 'Compact'], ['icons', 'Icons only']]} className="w-44" />
        </Row>
        <Row label="Show the full sidebar" hint="Off shows a narrow rail of icons.">
          <Switch checked={a.showCategories} onChange={(v) => ap({ showCategories: v })} aria-label="Show the full sidebar" />
        </Row>
        <Row label="Download list columns">
          <Button onClick={() => openDialog({ type: 'columns' })}>Customize…</Button>
        </Row>
      </Section>
    </>
  );
}

function ThemePreview({ kind }: { kind: 'system' | 'light' | 'dark' }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-1', dark ? 'bg-[#121316]' : 'bg-white')}>
      <div className={cn('w-1/3 space-y-1 p-1.5', dark ? 'bg-[#0d0e10]' : 'bg-[#f6f6f7]')}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn('h-1 rounded-full', i === 0 ? 'bg-[#2bbf9f]' : dark ? 'bg-white/15' : 'bg-black/10')} />
        ))}
      </div>
      <div className="flex-1 space-y-1.5 p-1.5">
        {[0.8, 0.55, 0.7].map((w, i) => (
          <div key={i} className="space-y-0.5">
            <div className={cn('h-1 rounded-full', dark ? 'bg-white/20' : 'bg-black/15')} style={{ width: `${w * 100}%` }} />
            <div className={cn('h-0.5 rounded-full', dark ? 'bg-white/10' : 'bg-black/5')}>
              <div className="h-full rounded-full bg-[#2bbf9f]" style={{ width: `${(1 - i * 0.3) * 60}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return <div className="flex h-16 border-b border-line">{kind === 'system' ? (<>{pane(false)}{pane(true)}</>) : pane(kind === 'dark')}</div>;
}

export function Sounds({ s, set }: SectionProps) {
  const snd = useGroup(set, 'sounds');
  return (
    <Section title="Sounds">
      <Toggle label="When a download completes" checked={s.sounds.complete} onChange={(v) => snd({ complete: v })} />
      <Toggle label="When a download fails" checked={s.sounds.failed} onChange={(v) => snd({ failed: v })} />
      <Toggle label="When a queue finishes" checked={s.sounds.queueDone} onChange={(v) => snd({ queueDone: v })} />
      <Row label="Volume">
        <Slider value={s.sounds.volume} min={0} max={1} step={0.05} onChange={(v) => snd({ volume: v })} />
        <span className="tnum w-9 text-right text-sm text-fg-2">{Math.round(s.sounds.volume * 100)}%</span>
      </Row>
    </Section>
  );
}

// ---- Downloads ---------------------------------------------------------------------------------

export function Downloads({ s, set }: SectionProps) {
  const d = useGroup(set, 'downloads');
  return (
    <>
      <Section title="Dialogs">
        <Toggle label="Show “Download File Info” before starting" hint="Off downloads silently with the default name and folder." checked={s.downloads.showStartDialog} onChange={(v) => d({ showStartDialog: v })} />
        <Toggle label="Only add new downloads to the list" hint="They wait until you start them." checked={s.downloads.addOnlyNoStart} onChange={(v) => d({ addOnlyNoStart: v })} />
        <Toggle label="Show “Download complete”" checked={s.downloads.showCompleteDialog} onChange={(v) => d({ showCompleteDialog: v })} />
        <Row label="Progress window">
          <Select value={s.downloads.progressDialog} onChange={(v) => d({ progressDialog: v })} options={[['show', 'Show'], ['minimized', 'Show minimized'], ['none', "Don't show"]]} className="w-40" />
        </Row>
        <Toggle label="Ask which queue for “Download later”" checked={s.downloads.showQueuePanelOnLater} onChange={(v) => d({ showQueuePanelOnLater: v })} />
      </Section>
      <Section title="Behavior">
        <Row label="If the same address is added again">
          <Select value={s.downloads.duplicateAction} onChange={(v) => d({ duplicateAction: v })} options={[['ask', 'Ask me'], ['number', 'Add with a numbered name'], ['overwrite', 'Replace the download'], ['resume', 'Use the existing download']]} className="w-52" />
        </Row>
        <Row label="If the file already exists">
          <Select value={s.downloads.existingFileAction} onChange={(v) => d({ existingFileAction: v })} options={[['rename', 'Save with a numbered name'], ['overwrite', 'Overwrite it']]} className="w-52" />
        </Row>
        <Row label="Downloads at the same time" hint="Others wait for a free slot. 0 = no limit.">
          <NumberInput value={s.downloads.maxSimultaneous} min={0} max={64} onValue={(v) => d({ maxSimultaneous: v })} />
        </Row>
        <Toggle label="Ignore server file changes when resuming" checked={s.downloads.ignoreModTimeChanges} onChange={(v) => d({ ignoreModTimeChanges: v })} />
        <Toggle label="Restart automatically when the file changes on the server" hint="Off keeps the partial file and asks what to do." checked={s.downloads.autoRestartOnChange} onChange={(v) => d({ autoRestartOnChange: v })} />
        <Row label="User-Agent for manual downloads" stack>
          <Input value={s.downloads.userAgent} onChange={(e) => d({ userAgent: e.target.value })} placeholder="Default (current Chrome)" className="font-mono text-xs" />
        </Row>
      </Section>
    </>
  );
}

export function Folders({ s, set, cats, setCats }: SectionProps) {
  const st = useGroup(set, 'saveTo');
  return (
    <>
      <Section title="Category folders" description="Each file type is saved into its category's folder.">
        {cats.map((c, i) => (
          <Row key={c.id} label={c.name} stack>
            <FolderInput value={c.folder} onChange={(v) => setCats(cats.map((x, j) => (j === i ? { ...x, folder: v } : x)))} className="w-full" />
          </Row>
        ))}
      </Section>
      <Section>
        <Toggle label="Remember the last folder chosen for each category" checked={s.saveTo.rememberLastPath} onChange={(v) => st({ rememberLastPath: v })} />
        <Row label="Unfinished downloads" hint="New downloads only. Automatic keeps them next to the file, except in cloud-synced folders.">
          <Select value={s.saveTo.partialLocation} onChange={(v) => st({ partialLocation: v })} options={[['auto', 'Automatic'], ['beside', 'Next to the file'], ['tempDir', 'Temporary folder']]} className="w-44" />
        </Row>
        <Row label="Temporary folder" hint="Used for video downloads, cloud-synced folders and when chosen above." stack>
          <FolderInput value={s.saveTo.tempDir} onChange={(v) => st({ tempDir: v })} className="w-full" />
        </Row>
        <Row label="Cloud-synced folders" hint="One folder per line, for Dropbox, Google Drive and others. OneDrive is detected." stack>
          <Textarea rows={3} value={(s.saveTo.syncedFolders ?? []).join('\n')} onChange={(e) => st({ syncedFolders: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) })} className="font-mono text-xs" />
        </Row>
      </Section>
    </>
  );
}

export function FileTypes({ s, set }: SectionProps) {
  const ft = useGroup(set, 'fileTypes');
  return (
    <Section title="Take over from the browser">
      <Row label="Start downloading these file types" hint="Extensions separated by spaces; * is allowed." stack>
        <Textarea rows={5} value={s.fileTypes.capture} onChange={(e) => ft({ capture: e.target.value })} className="font-mono text-xs" />
      </Row>
      <Row label="Except from these sites" hint="Separate names with spaces; * is allowed." stack>
        <Textarea rows={3} value={s.fileTypes.excludedSites} onChange={(e) => ft({ excludedSites: e.target.value })} className="font-mono text-xs" />
      </Row>
      <Row label="Except these addresses" hint="One per line; * is allowed." stack>
        <Textarea rows={4} value={s.fileTypes.excludedAddresses.join('\n')} onChange={(e) => ft({ excludedAddresses: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) })} className="font-mono text-xs" />
      </Row>
    </Section>
  );
}

// ---- Network -----------------------------------------------------------------------------------

const CONN = [1, 2, 4, 6, 8, 12, 16, 24, 32].map((v) => [v, String(v)] as const);

export function Connections({ s, set }: SectionProps) {
  const c = useGroup(set, 'connection');
  const [srv, setSrv] = React.useState('');
  const [n, setN] = React.useState(1);
  const ex = s.connection.serverExceptions;
  return (
    <>
      <Section title="Connections">
        <Row label="Connections per download" hint="More connections can be faster, but some servers limit them.">
          <Select value={s.connection.maxConnections} onChange={(v) => c({ maxConnections: v })} options={CONN} className="w-24" />
        </Row>
        <Row label="Timeout">
          <NumberInput value={s.connection.timeoutSec} min={5} max={600} onValue={(v) => c({ timeoutSec: v })} />
          <Unit>seconds</Unit>
        </Row>
        <Row label="Retries per connection" hint="0 keeps retrying.">
          <NumberInput value={s.connection.connectionRetries} min={0} max={1000} onValue={(v) => c({ connectionRetries: v })} />
        </Row>
        <Row label="Minimum segment size">
          <NumberInput value={s.connection.minSegmentKB} min={64} max={65536} onValue={(v) => c({ minSegmentKB: v })} className="w-24" />
          <Unit>KB</Unit>
        </Row>
      </Section>
      <Section title="Server exceptions" description="Fewer connections for servers that block many at once.">
        {ex.length === 0 && <Row hint="No exceptions" />}
        {ex.map((x, i) => (
          <Row key={i} label={<span className="font-mono text-xs">{x.server}</span>}>
            <span className="text-sm text-fg-2">{x.maxConnections} connections</span>
            <Button variant="ghost" size="icon-sm" onClick={() => c({ serverExceptions: ex.filter((_, j) => j !== i) })} aria-label="Delete exception">
              <Trash2 />
            </Button>
          </Row>
        ))}
        <Row>
          <div className="flex w-full items-center gap-2">
            <Input value={srv} onChange={(e) => setSrv(e.target.value)} placeholder="*.example.com" className="flex-1 font-mono text-xs" />
            <NumberInput value={n} min={1} max={32} onValue={setN} />
            <Button
              disabled={!srv.trim()}
              onClick={() => {
                c({ serverExceptions: [...ex, { server: srv.trim(), maxConnections: n || 1 }] });
                setSrv('');
              }}
            >
              <Plus />
              Add
            </Button>
          </div>
        </Row>
      </Section>
    </>
  );
}

export function Limits({ s, set }: SectionProps) {
  const lim = useGroup(set, 'speedLimiter');
  const q = s.connection.quota;
  const setQ = (patch: Partial<typeof q>) => set((x) => ({ ...x, connection: { ...x.connection, quota: { ...x.connection.quota, ...patch } } }));
  return (
    <>
      <Section title="Speed limiter" description="Also in the status bar. Per-download limits are in each download's properties.">
        <Toggle label="Limit the total download speed" checked={s.speedLimiter.enabled} onChange={(v) => lim({ enabled: v })} />
        <Row label="Maximum speed" className={cn(!s.speedLimiter.enabled && 'opacity-50')}>
          <NumberInput value={s.speedLimiter.kbps} min={1} onValue={(v) => lim({ kbps: v })} className="w-24" disabled={!s.speedLimiter.enabled} />
          <Unit>KB/s</Unit>
        </Row>
      </Section>
      <Section title="Download quota" description="Downloads pause at the limit and resume on their own when the period allows.">
        <Toggle label="Limit how much is downloaded in a period" checked={q.enabled} onChange={(v) => setQ({ enabled: v })} />
        <Row label="No more than" className={cn(!q.enabled && 'opacity-50')}>
          <NumberInput value={q.mb} min={1} onValue={(v) => setQ({ mb: v })} disabled={!q.enabled} className="w-24" />
          <Unit>MB every</Unit>
          <NumberInput value={q.hours} min={1} max={720} onValue={(v) => setQ({ hours: v })} disabled={!q.enabled} />
          <Unit>hours</Unit>
        </Row>
        <Toggle label="Notify me when downloads pause at the limit" checked={q.warn} onChange={(v) => setQ({ warn: v })} disabled={!q.enabled} />
      </Section>
    </>
  );
}

export function Proxy({ s, set }: SectionProps) {
  const px = s.proxy;
  const p = useGroup(set, 'proxy');
  const entry = (k: 'http' | 'https' | 'ftp' | 'socks', label: string) => {
    const e = px[k];
    const up = (patch: Partial<ProxyEntry>) => p({ [k]: { ...e, ...patch } } as Partial<Settings['proxy']>);
    return (
      <Row key={k}>
        <div className="grid w-full grid-cols-[6.5rem_1fr_5rem_7rem_7rem] items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={e.enabled} onChange={(v) => up({ enabled: v })} />
            {label}
          </label>
          <Input value={e.host} onChange={(x) => up({ host: x.target.value })} placeholder="Address" disabled={!e.enabled} />
          <NumberInput value={e.port} min={1} max={65535} onValue={(v) => up({ port: v })} disabled={!e.enabled} className="w-full" aria-label={`${label} port`} />
          <Input value={e.user} onChange={(x) => up({ user: x.target.value })} placeholder="User" disabled={!e.enabled} autoComplete="off" />
          <Input type="password" value={e.pass} onChange={(x) => up({ pass: x.target.value })} placeholder="Password" disabled={!e.enabled} autoComplete="off" />
        </div>
      </Row>
    );
  };
  return (
    <>
      <Section title="Connection">
        <Row stack>
          <RadioGroup
            value={px.mode}
            onChange={(v) => p({ mode: v })}
            options={[
              { value: 'none', label: 'No proxy' },
              { value: 'system', label: 'Use the system proxy settings' },
              { value: 'pac', label: 'Automatic configuration script' },
              { value: 'manual', label: 'Manual configuration' },
            ]}
          />
        </Row>
        {px.mode === 'pac' && (
          <Row label="Script address" stack>
            <Input value={px.pacUrl} onChange={(e) => p({ pacUrl: e.target.value })} placeholder="http://wpad/wpad.dat" className="font-mono text-xs" />
          </Row>
        )}
      </Section>
      {px.mode === 'manual' && (
        <Section title="Proxy servers">
          {entry('http', 'HTTP')}
          {entry('https', 'HTTPS')}
          {entry('ftp', 'FTP')}
          {entry('socks', 'SOCKS')}
          <Row label="SOCKS version">
            <Select value={px.socks.version || 5} onChange={(v) => p({ socks: { ...px.socks, version: v } })} options={[[5, 'SOCKS 5'], [4, 'SOCKS 4']]} className="w-32" />
          </Row>
        </Section>
      )}
      <Section>
        <Row label="No proxy for" hint="Separate with spaces. <local> means names without dots." stack>
          <Input value={px.bypass} onChange={(e) => p({ bypass: e.target.value })} className="font-mono text-xs" />
        </Row>
        <Toggle label="Use passive mode for FTP" checked={px.ftpPassive} onChange={(v) => p({ ftpPassive: v })} />
      </Section>
    </>
  );
}

export function Logins({ s, set }: SectionProps) {
  const [sv, setSv] = React.useState('');
  const [us, setUs] = React.useState('');
  const [pw, setPw] = React.useState('');
  const list = s.siteLogins;
  const setList = (siteLogins: Settings['siteLogins']) => set((x) => ({ ...x, siteLogins }));
  return (
    <Section title="Saved logins" description="Used automatically for matching servers. Add a path only when folders need different logins; * is allowed.">
      {list.length === 0 && <Row hint="No saved logins" />}
      {list.map((l, i) => (
        <Row key={i} label={<span className="font-mono text-xs">{l.server}</span>}>
          <span className="text-sm text-fg-2">{l.user}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Delete login">
            <Trash2 />
          </Button>
        </Row>
      ))}
      <Row>
        <div className="flex w-full items-center gap-2">
          <Input value={sv} onChange={(e) => setSv(e.target.value)} placeholder="ftp.example.com/private" className="flex-1 font-mono text-xs" />
          <Input value={us} onChange={(e) => setUs(e.target.value)} placeholder="User" className="w-28" autoComplete="off" />
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" className="w-28" autoComplete="off" />
          <Button
            disabled={!sv.trim() || !us}
            onClick={() => {
              setList([...list, { server: sv.trim(), user: us, pass: pw }]);
              setSv('');
              setUs('');
              setPw('');
            }}
          >
            <Plus />
            Add
          </Button>
        </div>
      </Row>
    </Section>
  );
}

// ---- Integrations ------------------------------------------------------------------------------

const KEYS = (none: string) => [['Insert', 'Insert'], ['Shift', 'Shift'], ['Ctrl', 'Ctrl'], ['Alt', 'Alt'], ['', none]] as const;

export function Browser({ s, set }: SectionProps) {
  const g = useGroup(set, 'general');
  const cm = (patch: Partial<Settings['general']['contextMenu']>) => g({ contextMenu: { ...s.general.contextMenu, ...patch } });
  return (
    <>
      <Callout className="mb-6 flex items-center gap-3">
        <span className="flex-1">The OpenDM extension for Chrome and Edge hands downloads to the app and adds the video panel.</span>
        <Button size="sm" onClick={() => openDialog({ type: 'help', topic: 'extension' })}>
          Install the extension…
        </Button>
      </Callout>
      <Section title="Browser integration">
        <Toggle label="Take over downloads from browsers" checked={s.general.browserIntegration} onChange={(v) => g({ browserIntegration: v })} />
        <Row label="Local port" hint="The extension talks to the app on 127.0.0.1 at this port. Change it in the extension options too.">
          <NumberInput value={s.general.integrationPort} min={1024} max={65535} onValue={(v) => g({ integrationPort: v })} className="w-24" aria-invalid={s.general.integrationPort < 1024 || s.general.integrationPort > 65535} />
        </Row>
        <Row label="Force download key" hint="Hold while clicking a link to always download it with OpenDM.">
          <Select value={s.general.forceKey} onChange={(v) => g({ forceKey: v })} options={KEYS('None').filter(([k]) => k !== 'Alt')} className="w-28" />
        </Row>
        <Row label="Bypass key" hint="Hold while clicking a link to let the browser download it.">
          <Select value={s.general.preventKey} onChange={(v) => g({ preventKey: v })} options={KEYS('None').filter(([k]) => k !== 'Insert')} className="w-28" />
        </Row>
      </Section>
      <Section title="Browser context menu">
        <Toggle label="Download with OpenDM" checked={s.general.contextMenu.downloadLink} onChange={(v) => cm({ downloadLink: v })} />
        <Toggle label="Download all links" checked={s.general.contextMenu.downloadAll} onChange={(v) => cm({ downloadAll: v })} />
        <Toggle label="Download selected links" checked={s.general.contextMenu.downloadSelected} onChange={(v) => cm({ downloadSelected: v })} />
      </Section>
    </>
  );
}

function ToolStatus({ which, path }: { which: 'ffmpeg' | 'ytdlp'; path: string }) {
  const [found, setFound] = React.useState<string | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(() => void invoke(which === 'ffmpeg' ? 'util:ffmpeg' : 'util:ytdlp').then(setFound), [which]);
  React.useEffect(load, [load, path]);
  return (
    <div className="flex items-center gap-2 text-xs">
      {found === undefined ? <span className="text-fg-3">Checking…</span> : found ? <Badge tone="ok">Found</Badge> : <Badge tone="warn">Not found</Badge>}
      <span className="min-w-0 flex-1 truncate font-mono text-fg-3" title={found || undefined}>
        {found || (which === 'ffmpeg' ? 'Video and audio from DASH sites will be saved as separate files.' : 'Needed for YouTube and other video pages.')}
      </span>
      {which === 'ytdlp' && (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await invoke('util:ytdlpInstall');
              toast('yt-dlp is up to date');
            } catch (e) {
              toast.error((e as Error).message);
            }
            setBusy(false);
            load();
          }}
        >
          {busy && <Spinner />}
          {busy ? 'Downloading…' : found ? 'Update yt-dlp' : 'Install yt-dlp'}
        </Button>
      )}
    </div>
  );
}

export function VideoSection({ s, set }: SectionProps) {
  const vp = useGroup(set, 'videoPanel');
  return (
    <>
      <Section title="Video panel" description="The browser extension can show “Download this video” when a web player loads media.">
        <Toggle label="Show the download panel on web players" checked={s.videoPanel.enabled} onChange={(v) => vp({ enabled: v })} />
        <Row label="Panel style">
          <Select value={s.videoPanel.mode} onChange={(v) => vp({ mode: v })} options={[['full', 'Full'], ['mini', 'Mini (icon only)']]} className="w-40" />
        </Row>
        <Row label="Media types" stack>
          <Input value={s.videoPanel.types} onChange={(e) => vp({ types: e.target.value })} className="font-mono text-xs" />
        </Row>
        <Row label="Minimum size">
          <NumberInput value={s.videoPanel.minSizeKB} min={0} onValue={(v) => vp({ minSizeKB: v })} className="w-24" />
          <Unit>KB</Unit>
        </Row>
        <Row label="Don't show on these sites" stack>
          <Input value={s.videoPanel.excludedSites} onChange={(e) => vp({ excludedSites: e.target.value })} placeholder="example.com *.example.org" className="font-mono text-xs" />
        </Row>
        <Toggle label="Don't take over media requests from web players automatically" checked={s.videoPanel.dontCaptureFromPlayers} onChange={(v) => vp({ dontCaptureFromPlayers: v })} />
      </Section>
      <Section title="Tools">
        <Row label="FFmpeg" hint="Merges separate video and audio streams (YouTube and other DASH sites)." stack>
          <div className="flex w-full min-w-0 flex-col gap-2">
            <FolderInput file value={s.videoPanel.ffmpegPath} onChange={(v) => vp({ ffmpegPath: v })} placeholder="Built in, or found on PATH" className="w-full" />
            <ToolStatus which="ffmpeg" path={s.videoPanel.ffmpegPath} />
          </div>
        </Row>
        <Row label="yt-dlp" hint="Downloads video pages such as YouTube. Update it when a site stops working." stack>
          <div className="flex w-full min-w-0 flex-col gap-2">
            <FolderInput file value={s.videoPanel.ytdlpPath} onChange={(v) => vp({ ytdlpPath: v })} placeholder="Installed by OpenDM, or found on PATH" className="w-full" />
            <ToolStatus which="ytdlp" path={s.videoPanel.ytdlpPath} />
          </div>
        </Row>
      </Section>
    </>
  );
}

const FIREWALL: Record<string, [string, 'ok' | 'danger' | 'warn']> = {
  allowed: ['Allowed — peers can connect to you', 'ok'],
  blocked: ['Blocked — peers cannot connect to you, so torrents are slower', 'danger'],
  none: ['Not allowed yet — Windows may ask the first time a torrent starts', 'warn'],
};

function Firewall() {
  const [state, setState] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => void invoke('util:torrentFirewall').then(setState, () => setState('unsupported')), []);
  if (state === 'unsupported') return null;
  const info = state ? FIREWALL[state] : null;
  return (
    <Row label="Windows Firewall" hint={info ? <span className={cn(info[1] === 'ok' ? 'text-ok' : info[1] === 'danger' ? 'text-danger' : 'text-warn')}>{info[0]}</span> : 'Checking…'}>
      {state && state !== 'allowed' && (
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setState(await invoke('util:torrentFirewall', 'allow'));
            } catch (e) {
              toast.error((e as Error).message);
              setState(await invoke('util:torrentFirewall'));
            }
            setBusy(false);
          }}
        >
          {busy && <Spinner />}
          {busy ? 'Waiting for Windows…' : 'Allow incoming peers'}
        </Button>
      )}
    </Row>
  );
}

export function Torrent({ s, set }: SectionProps) {
  const bt = useGroup(set, 'torrent');
  return (
    <>
      <Callout tone="info" className="mb-6">
        Used for magnet links and .torrent files. Changes apply the next time OpenDM starts.
      </Callout>
      <Section title="Finding peers">
        <Toggle label="DHT" hint="Find peers without a tracker." checked={s.torrent.enableDht} onChange={(v) => bt({ enableDht: v })} />
        <Toggle label="Local peer discovery" hint="Find peers on the local network." checked={s.torrent.enableLsd} onChange={(v) => bt({ enableLsd: v })} />
        <Toggle label="Peer exchange (PEX)" hint="Learn about peers from other peers." checked={s.torrent.enablePex} onChange={(v) => bt({ enablePex: v })} />
        <Toggle label="uTP as well as TCP" checked={s.torrent.enableUtp} onChange={(v) => bt({ enableUtp: v })} />
        <Toggle label="Forward the listening port on the router (UPnP)" checked={s.torrent.enablePortForwarding} onChange={(v) => bt({ enablePortForwarding: v })} />
      </Section>
      <Section title="Connection">
        <Row label="Encryption" hint="Hides BitTorrent traffic from ISP throttling. Requiring it finds fewer peers.">
          <Select value={s.torrent.encryption} onChange={(v) => bt({ encryption: v })} options={[['prefer', 'Prefer encrypted'], ['require', 'Require'], ['disable', 'Never encrypt']]} className="w-40" />
        </Row>
        <Row label="Listening port" hint="0 picks a free port.">
          <NumberInput value={s.torrent.listenPort} min={0} max={65535} onValue={(v) => bt({ listenPort: v })} className="w-24" />
        </Row>
        <Firewall />
      </Section>
      <Section title="Seeding">
        <Row label="Keep sharing until uploaded" hint="0 stops when the download is complete.">
          <NumberInput value={s.torrent.seedRatio} min={0} step={0.1} onValue={(v) => bt({ seedRatio: v })} />
          <Unit>× the size</Unit>
        </Row>
      </Section>
      <Section title="Trackers" description="Added to every public torrent.">
        <Row label="Extra trackers" hint="One per line." stack>
          <Textarea rows={4} value={s.torrent.trackers} onChange={(e) => bt({ trackers: e.target.value })} className="font-mono text-xs" />
        </Row>
        <Row label="Also load trackers from" hint="A list with one tracker per line, read when OpenDM starts." stack>
          <Input value={s.torrent.trackersUrl} onChange={(e) => bt({ trackersUrl: e.target.value })} placeholder="https://…" className="font-mono text-xs" />
        </Row>
      </Section>
    </>
  );
}

// ---- About -------------------------------------------------------------------------------------

export function About() {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);
  return (
    <>
      <div className="mb-7 flex items-center gap-4 rounded-xl border border-line p-5">
        <img src={logo} alt="" className="size-14 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold">OpenDM {version}</div>
          <div className="text-sm text-fg-2">Multi-connection download manager with browser integration, queues, scheduler, site grabber and stream capture.</div>
          <div className="mt-1 text-xs text-fg-3">
            {platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'} · MIT license
          </div>
        </div>
      </div>
      <Section title="Files">
        <Row label="Data folder" hint="Settings, the download list, queues and logs.">
          <Button onClick={() => runMenu('data-folder')}>
            <FolderOpen />
            Open
          </Button>
        </Row>
        <Row label="Browser extension folder">
          <Button onClick={() => invoke('util:extensionDir').then((d) => copyText(d, 'Path copied'))}>
            <Copy />
            Copy path
          </Button>
          <Button onClick={() => runMenu('ext-folder')}>
            <FolderOpen />
            Open
          </Button>
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Reset all settings" hint="Downloads, queues and categories are kept.">
          <Button variant="danger-ghost" onClick={resetAllSettings}>
            <RotateCcw />
            Reset…
          </Button>
        </Row>
      </Section>
    </>
  );
}

import * as React from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { closeWindow, invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, CheckField, Select } from '@/components/ui/controls';
import { Callout, FileIcon, Field, Spinner } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { bytes, nameFromUrl } from '@/utils/format';
import { typeOfName } from '@/utils/files';
import { cn } from '@/utils/cn';
import type { DescribeResult, HlsVariant, NewDownloadPayload, TorrentFiles, YtdlpInfo } from '@/types/models';
import { WindowShell, usePayload } from './shell';

const VALID = /^((https?|ftp):\/\/|magnet:\?|file:\/\/\/\S+\.torrent$)/i;
type Parts = NonNullable<NewDownloadPayload['parts']>;
type Extra =
  | { type: 'none' }
  | { type: 'hls'; variants: HlsVariant[] }
  | { type: 'torrent'; loading?: boolean; error?: string; t?: TorrentFiles }
  | { type: 'ytdlp'; loading?: boolean; missing?: boolean; error?: string; info?: YtdlpInfo };

export default function NewDownloadWindow() {
  const p = usePayload<NewDownloadPayload>();
  if (p === undefined) return null;
  return <Form p={p || {}} />;
}

/** “Download File Info”: check the address, choose name, folder and quality, then start or queue it. */
function Form({ p }: { p: NewDownloadPayload }) {
  const settings = useApp((s) => s.settings);
  const cats = useApp((s) => s.categories);
  const queues = useApp((s) => s.queues);
  const items = useApp((s) => s.items);

  const [url, setUrl] = React.useState(p.url || '');
  const [fileName, setFileName] = React.useState(p.fileName || '');
  const [saveDir, setSaveDir] = React.useState(p.saveDir || '');
  const [category, setCategory] = React.useState('');
  const [description, setDescription] = React.useState(p.description || '');
  const [remember, setRemember] = React.useState(false);
  const [user, setUser] = React.useState(p.auth?.user || '');
  const [pass, setPass] = React.useState(p.auth?.pass || '');
  const [queueId, setQueueId] = React.useState('main');
  const [info, setInfo] = React.useState<DescribeResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [extra, setExtra] = React.useState<Extra>({ type: 'none' });
  const [variant, setVariant] = React.useState<string | null>(null);
  const [parts, setParts] = React.useState<Parts | null>(p.parts || null);
  const [quality, setQuality] = React.useState(0);
  const [ytQuality, setYtQuality] = React.useState<string | null>(null);
  const [torrentSel, setTorrentSel] = React.useState<Set<number> | null>(null);
  const [dupAction, setDupAction] = React.useState('number');
  const [busy, setBusy] = React.useState(false);
  const editedName = React.useRef(!!p.fileName);
  const editedDir = React.useRef(!!p.saveDir);
  const seq = React.useRef(0);
  const loaded = React.useRef({ yt: '', torrent: '' });

  const folderFor = (cat: string) => (settings.saveTo.rememberLastPath && settings.lastSaveDirs[cat]) || cats.find((c) => c.id === cat)?.folder || cats[0]?.folder || '';
  const partsSize = (ps: Parts | null) => (ps && ps.every((x) => x.size) ? ps.reduce((a, x) => a + (x.size || 0), 0) : null);
  const catName = cats.find((c) => c.id === category)?.name || 'General';

  const loadYtdlp = async (u: string) => {
    if (loaded.current.yt === u) return;
    loaded.current.yt = u;
    setExtra({ type: 'ytdlp', loading: true });
    const yi = await invoke('util:ytdlpInfo', u).catch((e: Error) => ({ error: e.message }) as YtdlpInfo);
    if (u !== loaded.current.yt) return;
    setExtra({ type: 'ytdlp', missing: yi.missing, error: yi.error, info: yi });
    if (yi.missing || yi.error) return;
    const opts = ['best', ...yi.heights.map(String), 'audio'];
    const want = p.ytdlp?.quality != null && opts.includes(String(p.ytdlp.quality)) ? String(p.ytdlp.quality) : 'best';
    setYtQuality(want);
    if (!editedName.current && yi.title) setFileName(yi.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) + (want === 'audio' ? '.m4a' : '.mp4'));
  };
  const loadTorrent = async (u: string) => {
    if (loaded.current.torrent === u) return;
    loaded.current.torrent = u;
    setExtra({ type: 'torrent', loading: true });
    try {
      const t = await invoke('util:torrentFiles', u);
      if (u !== loaded.current.torrent) return;
      setExtra({ type: 'torrent', t });
      setTorrentSel(new Set(t.files.map((f) => f.index)));
      if (!editedName.current && t.name) setFileName(t.name);
    } catch (e) {
      if (u === loaded.current.torrent) setExtra({ type: 'torrent', error: (e as Error).message });
    }
  };
  const loadVariants = async (u: string) => {
    try {
      const vs = await invoke('util:hlsVariants', u, p.referer);
      if (!vs.length) return;
      setVariant(vs[0].uri);
      setExtra({ type: 'hls', variants: vs });
    } catch {
      /* not a master playlist */
    }
  };

  const probe = async (u: string, force = false) => {
    const my = ++seq.current;
    if (!VALID.test(u)) return setInfo(null);
    if (!force) await new Promise((r) => setTimeout(r, 250));
    if (my !== seq.current) return;
    setChecking(true);
    const r = await invoke('dl:describe', u, {
      referer: p.referer,
      cookies: p.cookies,
      fileName: editedName.current ? fileName || p.fileName : p.fileName,
      mime: p.mime,
      auth: user ? { user, pass } : undefined,
      category: category || undefined,
      kind: parts ? 'muxed' : p.kind,
      parts: parts || undefined,
      size: partsSize(parts) || p.size,
      probe: p.kind !== 'hls' && !parts,
    }).catch((e: Error) => ({ fileName: '', category: '', saveDir: '', error: e.message }) as DescribeResult);
    if (my !== seq.current) return;
    setChecking(false);
    setInfo(r);
    if (!editedName.current && r.fileName) setFileName(r.fileName);
    if (!editedDir.current) {
      if (r.category) setCategory(r.category);
      setSaveDir(p.saveDir || r.saveDir);
    } else if (!category && r.category) setCategory(r.category);
    if (r.kind === 'hls') void loadVariants(u);
    if (r.kind === 'ytdlp') void loadYtdlp(u);
    if (r.kind === 'torrent') void loadTorrent(u);
  };

  React.useEffect(() => {
    void probe(url, true);
    if (p.qualities?.length) setParts(p.qualities[0].parts);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dup = React.useMemo(() => Object.values(items).find((x) => x.url === url), [items, url]);
  const askDup = !!dup && settings.downloads.duplicateAction === 'ask';

  // What the line under the file name says.
  let summary: React.ReactNode = 'Enter a valid address';
  let summaryErr = false;
  const t = extra.type === 'torrent' ? extra.t : undefined;
  if (VALID.test(url)) {
    if (checking && !info) summary = 'Checking…';
    else if (extra.type === 'ytdlp' && extra.info && !extra.error && !extra.missing) {
      const d = extra.info.duration;
      summary = `${extra.info.extractor || 'Video'}${d ? ` · ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : ''} · video and audio are merged after download`;
    } else if (extra.type === 'ytdlp' && (extra.missing || extra.loading)) summary = 'Video page';
    else if (extra.type === 'ytdlp' && extra.error) {
      summary = 'Could not read this video';
      summaryErr = true;
    } else if (t && torrentSel) summary = `Torrent · ${torrentSel.size} of ${t.files.length} files · ${bytes(t.files.filter((f) => torrentSel.has(f.index)).reduce((a, f) => a + f.size, 0))}`;
    else if (extra.type === 'hls') summary = 'Stream (HLS) · size known after download';
    else if (p.qualities?.length && parts) {
      const sz = partsSize(parts);
      summary = `${p.qualities[quality]?.label}${sz ? ' · ' + bytes(sz) : ''}${parts.length > 1 ? ' · video and audio are merged after download' : ''}`;
    } else if (info?.error) {
      summary = info.authRequired ? 'The server asks for a login' : 'Could not check: ' + info.error;
      summaryErr = true;
    } else if (info) summary = `${(info.size ?? p.size) ? bytes(info.size ?? p.size) : 'Size unknown'}${info.resumable === false ? ' · cannot be resumed' : ''}`;
  }

  const go = async (start: boolean) => {
    if (!VALID.test(url)) return toast.error('Enter a valid address');
    if (torrentSel && t && !torrentSel.size) return toast.error('Choose at least one file');
    setBusy(true);
    try {
      await invoke('dl:add', {
        url,
        fileName: fileName || undefined,
        saveDir,
        category,
        description,
        referer: p.referer,
        source: p.source,
        parentPage: p.parentPage,
        cookies: p.cookies,
        userAgent: p.userAgent,
        mime: p.mime,
        size: info?.size ?? p.size,
        kind: parts ? 'muxed' : p.kind,
        auth: user ? { user, pass } : undefined,
        rememberPath: remember,
        duplicateAction: askDup ? dupAction : undefined,
        hls: variant ? { variant } : p.hls,
        start,
        queueId: start ? null : queueId,
        parts: parts || undefined,
        ytdlp: ytQuality ? { quality: ytQuality } : undefined,
        torrentFiles: t && torrentSel && torrentSel.size !== t.files.length ? [...torrentSel] : undefined,
      });
      void closeWindow();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  React.useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'TEXTAREA' && !(e.target as HTMLElement).closest('[role=listbox],[role=combobox],[role=menu]')) void go(true);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });

  const title = fileName || p.fileName || nameFromUrl(url) || url;
  const ytOpts = extra.type === 'ytdlp' && extra.info?.heights ? [['best', 'Best available'] as const, ...extra.info.heights.map((x) => [String(x), `${x}p${extra.info!.sizes[x] ? ' — about ' + bytes(extra.info!.sizes[x]) : ''}`] as const), ['audio', 'Audio only (M4A)'] as const] : [];

  return (
    <WindowShell
      className="flex flex-col gap-4"
      footerStart={
        settings.downloads.showQueuePanelOnLater && (
          <>
            <span className="text-sm text-fg-3">Later into</span>
            <Select value={queueId} onChange={setQueueId} options={queues.filter((q) => q.type === 'download').map((q) => [q.id, q.name] as const)} className="w-36" aria-label="Queue for later" />
          </>
        )
      }
      footer={
        <>
          <Button disabled={busy} onClick={() => go(false)}>
            Download later
          </Button>
          <Button onClick={() => closeWindow()}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => go(true)}>
            <Download />
            Start download
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <FileIcon type={typeOfName(title.split('?')[0])} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" title={title}>
            {title}
          </div>
          <div className={cn('flex items-center gap-1.5 truncate text-sm', summaryErr ? 'text-danger' : 'text-fg-2')}>
            {checking && <Spinner className="size-3" />}
            {summary}
          </div>
        </div>
      </div>

      <Field label="Address">
        <Input
          type="url"
          value={url}
          autoFocus={!url}
          onChange={(e) => {
            const v = e.target.value.trim();
            setUrl(v);
            void probe(v);
          }}
          className="font-mono text-xs"
          spellCheck={false}
        />
      </Field>

      {(info?.authRequired || user) && (
        <Field label="Login">
          <div className="flex gap-2">
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User" autoComplete="off" className="flex-1" />
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Password" autoComplete="off" className="flex-1" />
            <Button onClick={() => probe(url, true)}>
              <RefreshCw />
              Retry
            </Button>
          </div>
        </Field>
      )}

      {extra.type === 'hls' && (
        <Field label="Quality">
          <Select value={variant || ''} onChange={setVariant} options={extra.variants.map((v) => [v.uri, `${v.resolution || 'Audio or other'} · ${Math.round(v.bandwidth / 1000)} kbps`] as const)} />
        </Field>
      )}
      {!!p.qualities?.length && extra.type === 'none' && (
        <Field label="Quality" hint="Only qualities the player has loaded are listed. Switch quality in the player to add more.">
          <Select
            value={quality}
            onChange={(i) => {
              setQuality(i);
              setParts(p.qualities![i].parts);
            }}
            options={p.qualities.map((q, i) => [i, `${q.label}${q.size ? ' — ' + bytes(q.size) : ''}`] as const)}
          />
        </Field>
      )}
      {extra.type === 'ytdlp' && <YtdlpPanel extra={extra} opts={ytOpts} value={ytQuality} onRetry={() => { loaded.current.yt = ''; void loadYtdlp(url); }} onChange={(v) => {
        setYtQuality(v);
        if (!editedName.current) setFileName((f) => f.replace(/\.(mp4|m4a)$/i, '') + (v === 'audio' ? '.m4a' : '.mp4'));
      }} />}
      {extra.type === 'torrent' && (
        <Field label="Files">
          {extra.loading ? (
            <span className="text-sm text-fg-3">Reading the torrent's file list…</span>
          ) : extra.error ? (
            <span className="text-sm text-danger">{extra.error}</span>
          ) : (
            t &&
            torrentSel && (
              <div className="flex flex-col gap-1.5">
                <div className="max-h-36 overflow-y-auto rounded-lg border border-line p-1">
                  {t.files.map((f) => (
                    <label key={f.index} className="flex h-7 items-center gap-2 rounded px-1.5 text-sm hover:bg-subtle">
                      <Checkbox
                        checked={torrentSel.has(f.index)}
                        onChange={(v) => {
                          const n = new Set(torrentSel);
                          v ? n.add(f.index) : n.delete(f.index);
                          setTorrentSel(n);
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate" title={f.path}>
                        {f.path}
                      </span>
                      <span className="tnum text-xs text-fg-3">{bytes(f.size)}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setTorrentSel(new Set(t.files.map((f) => f.index)))}>
                    All
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setTorrentSel(new Set())}>
                    None
                  </Button>
                </div>
              </div>
            )
          )}
        </Field>
      )}

      <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-3">
        <Field label="Category">
          <div className="flex gap-1.5">
            <Select
              value={category}
              onChange={(c) => {
                setCategory(c);
                if (!editedDir.current) setSaveDir(folderFor(c));
              }}
              options={cats.map((c) => [c.id, c.name] as const)}
              className="min-w-0 flex-1"
            />
            <Button size="icon" onClick={() => saveDir && invoke('util:openPath', saveDir)} aria-label="Open the folder">
              <FolderOpen />
            </Button>
          </div>
        </Field>
        <Field label="File name">
          <Input
            value={fileName}
            onChange={(e) => {
              editedName.current = true;
              setFileName(e.target.value);
            }}
          />
        </Field>
      </div>
      <Field label="Save to">
        <FolderInput
          value={saveDir}
          onChange={(v) => {
            editedDir.current = true;
            setSaveDir(v);
          }}
        />
        <CheckField label={`Remember this folder for “${catName}”`} checked={remember} onChange={setRemember} />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </Field>
      {askDup && dup && (
        <Callout tone="warn" className="flex items-center gap-3">
          <span className="flex-1 text-sm">This address is already in the list ({dup.status === 'complete' ? 'downloaded' : 'not finished'}).</span>
          <Select
            value={dupAction}
            onChange={setDupAction}
            options={[['number', 'Add it again with a numbered name'], ['overwrite', 'Replace the existing download'], ['resume', dup.status === 'complete' ? 'Keep the existing file' : 'Resume the existing download']]}
            className="w-60"
          />
        </Callout>
      )}
    </WindowShell>
  );
}

function YtdlpPanel({ extra, opts, value, onChange, onRetry }: { extra: Extract<Extra, { type: 'ytdlp' }>; opts: readonly (readonly [string, string])[]; value: string | null; onChange: (v: string) => void; onRetry: () => void }) {
  const [installing, setInstalling] = React.useState(false);
  if (extra.loading) return <div className="text-sm text-fg-3">Reading video information…</div>;
  if (extra.missing)
    return (
      <Callout className="flex flex-col gap-2">
        <span className="text-sm">Video pages like YouTube are downloaded with yt-dlp, a free open-source tool. It is not installed yet.</span>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              try {
                await invoke('util:ytdlpInstall');
                onRetry();
              } catch (e) {
                toast.error('Could not download yt-dlp: ' + (e as Error).message);
              }
              setInstalling(false);
            }}
          >
            {installing && <Spinner />}
            {installing ? 'Downloading yt-dlp…' : 'Download yt-dlp'}
          </Button>
          <span className="text-xs text-fg-3">About 18 MB, from the official github.com/yt-dlp releases.</span>
        </div>
      </Callout>
    );
  if (extra.error) return <div className="text-sm text-danger">{extra.error}</div>;
  return (
    <Field label="Quality">
      <Select value={value || 'best'} onChange={onChange} options={opts} />
    </Field>
  );
}

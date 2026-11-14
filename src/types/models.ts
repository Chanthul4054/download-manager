export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

// Shapes of the data the Rust backend sends (see src-tauri/src/item.rs, defaults.rs, queues.rs,
// linkgrabber.rs, grabber.rs). Field names are the backend's camelCase JSON.

export type DownloadStatus = 'downloading' | 'waiting' | 'paused' | 'error' | 'complete' | '';
export type DownloadKind = 'http' | 'ftp' | 'hls' | 'muxed' | 'ytdlp' | 'torrent';

export interface DownloadPart {
  role?: string;
  label?: string;
  size?: number | null;
  ext?: string;
  done?: boolean;
}

export interface DownloadItem {
  id: string;
  url: string;
  kind?: DownloadKind | string;
  fileName: string;
  saveDir?: string;
  category?: string;
  description?: string;
  referer?: string;
  parentPage?: string;
  userAgent?: string;
  status: DownloadStatus;
  statusText?: string | null;
  error?: string | null;
  /** Code of the failure in `error`; 'ECHANGED' = the file changed on the server. */
  errorCode?: string | null;
  size?: number | null;
  estimatedSize?: number | null;
  downloaded: number;
  resumable?: boolean | null;
  added?: number;
  lastTry?: number | null;
  /** Event log, oldest first. Only in the `dl:item` reply. */
  log?: LogEntry[];
  completedAt?: number | null;
  rate?: number | null;
  eta?: number | null;
  maxConnections?: number;
  speedLimitKB?: number;
  savedPath?: string | null;
  contentType?: string | null;
  onComplete?: CompletionOptions | null;
  ytdlp?: { quality?: string } | null;
  hls?: { variant?: string; total?: number; done?: number[] } | null;
  parts?: DownloadPart[];
  hasAuth?: boolean;
  /** Only in `dl:item`. */
  auth?: { user: string; pass: string } | null;
  segmentCount?: number;
  active?: boolean;
}

export interface CompletionOptions {
  showDialog?: boolean | null;
  exitApp?: boolean;
  power?: PowerAction;
  forceTerminate?: boolean;
}

export type PowerAction = 'none' | 'shutdown' | 'restart' | 'sleep' | 'hibernate';

export interface Connection {
  start: number;
  pos: number;
  receiving?: boolean;
  id?: number | string;
  bytes?: number;
}

export interface DownloadStats {
  downloaded: number;
  size?: number | null;
  estimatedSize?: number | null;
  rate?: number;
  eta?: number | null;
  resumable?: boolean | null;
  fraction?: number | null;
  connections?: Connection[];
  /** [start, end, pos] */
  segments?: [number, number, number][];
  hlsSegments?: { total: number; done: number[] };
  // BitTorrent only
  uploaded?: number;
  uploadRate?: number;
  peers?: number;
  peersSeen?: number;
}

export interface ProgressEntry {
  id: string;
  item: Partial<DownloadItem>;
  stats: DownloadStats;
}

export interface Category {
  id: string;
  name: string;
  exts: string;
  folder: string;
  builtin?: boolean;
}

export interface Schedule {
  startEnabled: boolean;
  startTime: string;
  mode: 'daily' | 'once';
  days: number[];
  onceDate: string;
  stopEnabled: boolean;
  stopTime: string;
  periodic: boolean;
  everyMinutes: number;
}

export interface QueueCompletion {
  exitApp: boolean;
  power: PowerAction;
  forceTerminate: boolean;
  runFile: string;
}

export interface Queue {
  id: string;
  name: string;
  type: 'download' | 'sync';
  builtin?: boolean;
  maxConcurrent: number;
  retries: number;
  items: string[];
  schedule: Schedule;
  onComplete: QueueCompletion;
  running?: boolean;
}

export interface ProxyEntry {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  pass: string;
  version?: 4 | 5;
  proxyDns?: boolean;
}

export type ThemeSetting = 'system' | 'light' | 'dark';
export type ColumnKey =
  | 'name' | 'queue' | 'size' | 'status' | 'timeLeft' | 'rate' | 'lastTry' | 'description'
  | 'saveDir' | 'referer' | 'parentPage' | 'url' | 'added' | 'connections';

export interface Settings {
  firstRun?: boolean;
  general: {
    launchOnStartup: boolean;
    minimizeToTray: boolean;
    monitorClipboard: boolean;
    browserIntegration: boolean;
    integrationPort: number;
    forceKey: string;
    preventKey: string;
    contextMenu: { downloadLink: boolean; downloadAll: boolean; downloadSelected: boolean };
    language: string;
  };
  fileTypes: { capture: string; excludedSites: string; excludedAddresses: string[] };
  connection: {
    maxConnections: number;
    serverExceptions: { server: string; maxConnections: number }[];
    timeoutSec: number;
    connectionRetries: number;
    minSegmentKB: number;
    quota: { enabled: boolean; mb: number; hours: number; warn: boolean };
    tls13?: boolean;
  };
  storage: { backupIntervalMin: number };
  saveTo: { tempDir: string; rememberLastPath: boolean; createCategoryFolders?: boolean };
  downloads: {
    showStartDialog: boolean;
    addOnlyNoStart: boolean;
    showCompleteDialog: boolean;
    progressDialog: 'show' | 'minimized' | 'none';
    duplicateAction: 'ask' | 'number' | 'overwrite' | 'resume';
    existingFileAction: 'rename' | 'overwrite';
    userAgent: string;
    ignoreModTimeChanges: boolean;
    autoRestartOnChange: boolean;
    showQueuePanelOnLater: boolean;
    maxSimultaneous: number;
  };
  proxy: {
    mode: 'none' | 'system' | 'pac' | 'manual';
    pacUrl: string;
    http: ProxyEntry;
    https: ProxyEntry;
    ftp: ProxyEntry;
    socks: ProxyEntry;
    bypass: string;
    ftpPassive: boolean;
    useBrowserProxyOnError?: boolean;
  };
  siteLogins: { server: string; user: string; pass: string }[];
  sounds: { complete: boolean; failed: boolean; queueDone: boolean; volume: number };
  appearance: {
    theme: ThemeSetting;
    fontSize: number;
    columns: ColumnKey[];
    columnWidths: Partial<Record<ColumnKey, number>>;
    sort: { key: string; dir: 'asc' | 'desc' };
    showCategories: boolean;
    toolbar: 'large' | 'small' | 'icons';
  };
  videoPanel: {
    enabled: boolean;
    mode: 'full' | 'mini';
    types: string;
    minSizeKB: number;
    excludedSites: string;
    dontCaptureFromPlayers: boolean;
    ffmpegPath: string;
    ytdlpPath: string;
  };
  speedLimiter: { enabled: boolean; kbps: number };
  linkGrabber: {
    useForLinkLists: boolean;
    clipboard: boolean;
    deepAnalyse: boolean;
    captchaApiKey: string;
    checkThreads: number;
    variousPackage: boolean;
    packageFolders: boolean;
    expandPackages: boolean;
    autoConfirm: boolean;
    autoConfirmDelaySec: number;
    autoStart: boolean;
    offlineAction: 'exclude' | 'include';
    dupeAction: 'skip' | 'add';
    queueId: string;
    columnWidths: Record<string, number>;
  };
  torrent: {
    enableDht: boolean;
    enableLsd: boolean;
    enableUtp: boolean;
    enablePortForwarding: boolean;
    enablePex: boolean;
    encryption: 'prefer' | 'require' | 'disable';
    listenPort: number;
    trackers: string;
    trackersUrl: string;
    seedRatio: number;
  };
  lastSaveDirs: Record<string, string>;
}

export type GrabberPresets = Record<'images' | 'audio' | 'video' | 'documents' | 'archives' | 'programs' | 'all', string>;

export interface AppState {
  version: string;
  platform: string;
  settings: Settings;
  categories: Category[];
  queues: Queue[];
  items: DownloadItem[];
  grabberPresets: GrabberPresets;
}

// ---- LinkGrabber -------------------------------------------------------------------------------

export type LinkStatus = 'online' | 'offline' | 'unknown' | 'checking';

export interface LgLink {
  id: string;
  url: string;
  name: string;
  host: string;
  size?: number | null;
  type?: string;
  status: LinkStatus;
  error?: string | null;
  enabled: boolean;
  inList?: boolean;
}

export interface LgPackage {
  id: string;
  name: string;
  kind: 'normal' | 'custom' | 'various' | 'offline' | string;
  expanded?: boolean;
  saveDir?: string;
  links: LgLink[];
}

export interface LgState {
  packages: LgPackage[];
  busy: boolean;
  pending: number;
}

// ---- Site grabber ------------------------------------------------------------------------------

export interface GrabberStats {
  explored: number;
  matched: number;
  downloaded: number;
  pagesFound: number;
  filesFound: number;
  errors: number;
}

export interface GrabberSchedule {
  enabled: boolean;
  mode: string;
  action: 'explore' | 'explore-download' | 'download';
  startTime: string;
  days: number[];
  periodicMinutes: number;
  stopEnabled: boolean;
  stopTime: string;
}

export interface GrabberPage {
  url: string;
  title?: string;
  level: number;
  status?: string;
}

export interface GrabberFile {
  url: string;
  page: string;
  size?: number | null;
  status?: string;
  description?: string;
  checked: boolean;
  savedPath?: string;
}

export interface GrabberProject {
  id: string;
  name: string;
  startUrl: string;
  auth: { user: string; pass: string } | null;
  saveDir: string;
  category: string;
  useSubfolders: boolean;
  overwrite: boolean;
  levelsThis: number;
  levelsOther: number;
  dontExploreParent: boolean;
  exploreMainDomain: boolean;
  pageInclude: string;
  pageExclude: string;
  fileTypes: string;
  fileExcludeTypes: string;
  pathInclude: string;
  pathExclude: string;
  thisSiteOnly: boolean;
  hideDuplicates: boolean;
  minSizeKB: number;
  maxSizeKB: number;
  startDownloadAll: boolean;
  concurrentExplore: number;
  concurrentDownload: number;
  schedule: GrabberSchedule;
  results: { pages: GrabberPage[]; files: GrabberFile[] };
  stats: GrabberStats;
}

export interface GrabberSummary {
  id: string;
  name: string;
  startUrl: string;
  stats?: GrabberStats;
  running: boolean;
}

// ---- dialogs and probes ------------------------------------------------------------------------

export interface DescribeResult {
  fileName: string;
  category: string;
  saveDir: string;
  size?: number | null;
  resumable?: boolean | null;
  kind?: string;
  error?: string;
  authRequired?: boolean;
}

export interface YtdlpInfo {
  missing?: boolean;
  error?: string;
  title?: string;
  extractor?: string;
  duration?: number;
  heights: number[];
  sizes: Record<string, number>;
}

export interface HlsVariant {
  uri: string;
  resolution?: string;
  bandwidth: number;
}

export interface TorrentFiles {
  name?: string;
  files: { index: number; path: string; size: number }[];
}

/** What the browser extension, CLI or drop target sends to the "Download File Info" window. */
export interface NewDownloadPayload {
  url?: string;
  fileName?: string;
  saveDir?: string;
  description?: string;
  referer?: string;
  parentPage?: string;
  cookies?: string;
  userAgent?: string;
  mime?: string;
  size?: number;
  kind?: string;
  auth?: { user: string; pass: string };
  hls?: unknown;
  parts?: { url: string; size?: number; [k: string]: unknown }[];
  qualities?: { label: string; size?: number; parts: NonNullable<NewDownloadPayload['parts']> }[];
  ytdlp?: { quality?: string | number };
  source?: string;
}

export interface LinksPayload {
  links: { url: string; text?: string }[];
  title?: string;
  referer?: string;
  cookies?: string;
  userAgent?: string;
  auth?: { user: string; pass: string } | null;
  noProbe?: boolean;
}

export interface LogEntry {
  tsMs: number;
  kind: string;
  text: string;
}

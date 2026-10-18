'use strict';
const os = require('os');
const path = require('path');

const DOWNLOADS = path.join(os.homedir(), 'Downloads');

const CAPTURE_TYPES =
  '3GP 7Z AAC ACE AIF APK ARJ ASF AVI BIN BZ2 EXE GZ GZIP IMG ISO LZH M4A M4V MKV MOV MP3 MP4 MPA MPE MPEG MPG ' +
  'MSI MSU OGG OGV PDF PLJ PPS PPT QT R0* R1* RA RAR RM RMVB SEA SIT SITX TAR TIF TIFF WAV WMA WMV Z ZIP DMG DEB RPM ' +
  'FLAC OPUS WEBM XZ ZST';

function defaultCategories() {
  const c = (id, name, exts) => ({ id, name, exts, folder: path.join(DOWNLOADS, name), builtin: true });
  return [
    { id: 'general', name: 'General', exts: '', folder: DOWNLOADS, builtin: true },
    c('compressed', 'Compressed', 'zip rar r0* r1* arj gz sit sitx sea ace bz2 7z tar xz zst lzh'),
    c('documents', 'Documents', 'doc docx pdf ppt pptx pps xls xlsx txt rtf odt ods epub'),
    c('music', 'Music', 'mp3 wav wma mpa ram ra aac aif m4a flac ogg opus'),
    c('programs', 'Programs', 'exe msi msu apk dmg deb rpm iso img bin'),
    c('video', 'Video', 'avi mpg mpe mpeg asf wmv mov qt rm mp4 flv m4v webm ogv ogm mkv 3gp ts'),
  ];
}

function defaultQueues() {
  return [
    { id: 'main', name: 'Main Download queue', type: 'download', builtin: true, maxConcurrent: 2, retries: 0, items: [], schedule: defaultSchedule(), onComplete: defaultOnComplete() },
    { id: 'sync', name: 'Synchronization queue', type: 'sync', builtin: true, maxConcurrent: 1, retries: 0, items: [], schedule: { ...defaultSchedule(), periodic: true, everyMinutes: 120 }, onComplete: defaultOnComplete() },
  ];
}

function defaultSchedule() {
  return {
    startEnabled: false, startTime: '02:00', mode: 'daily', days: [0, 1, 2, 3, 4, 5, 6], onceDate: '',
    stopEnabled: false, stopTime: '08:00', periodic: false, everyMinutes: 60,
  };
}

function defaultOnComplete() {
  return { exitApp: false, power: 'none', forceTerminate: false, runFile: '' };
}

function defaultSettings() {
  return {
    general: {
      launchOnStartup: false,
      minimizeToTray: true,
      monitorClipboard: true,
      browserIntegration: true,
      integrationPort: 52790,
      forceKey: 'Insert',
      preventKey: 'Alt',
      contextMenu: { downloadLink: true, downloadAll: true, downloadSelected: true },
      language: 'en',
    },
    fileTypes: {
      capture: CAPTURE_TYPES,
      excludedSites: 'update.microsoft.com download.windowsupdate.com siteseal.thawte.com ecom.cimetz.com *.voice2page.com',
      excludedAddresses: ['*.googlevideo.com/videoplayback*'],
    },
    connection: {
      maxConnections: 8,
      serverExceptions: [], // { server, maxConnections }
      timeoutSec: 30,
      connectionRetries: 20,
      minSegmentKB: 256,
      quota: { enabled: false, mb: 200, hours: 1, warn: true },
      tls13: true,
    },
    saveTo: {
      tempDir: path.join(os.tmpdir(), 'OpenDM'),
      rememberLastPath: true,
      createCategoryFolders: true,
    },
    downloads: {
      showStartDialog: true,
      addOnlyNoStart: false,
      showCompleteDialog: true,
      progressDialog: 'show', // show | minimized | none
      duplicateAction: 'ask', // ask | number | overwrite | resume
      existingFileAction: 'rename', // rename | overwrite | ask
      userAgent: '',
      ignoreModTimeChanges: false,
      showQueuePanelOnLater: true,
      maxSimultaneous: 8,
    },
    proxy: {
      mode: 'system', // none | system | pac | manual
      pacUrl: '',
      http: { enabled: false, host: '', port: 8080, user: '', pass: '' },
      https: { enabled: false, host: '', port: 8080, user: '', pass: '' },
      ftp: { enabled: false, host: '', port: 8080, user: '', pass: '' },
      socks: { enabled: false, host: '', port: 1080, user: '', pass: '', version: 5, proxyDns: true },
      bypass: 'localhost 127.0.0.1 <local>',
      ftpPassive: true,
      useBrowserProxyOnError: true,
    },
    siteLogins: [], // { server, user, pass }
    sounds: { complete: true, failed: true, queueDone: true, volume: 0.4 },
    appearance: {
      theme: 'system', // system | light | dark
      fontSize: 13,
      columns: ['name', 'queue', 'size', 'status', 'timeLeft', 'rate', 'lastTry', 'description'],
      columnWidths: {},
      sort: { key: 'added', dir: 'asc' },
      showCategories: true,
      toolbar: 'large',
    },
    videoPanel: {
      enabled: true,
      mode: 'full', // full | mini
      types: 'mp4 webm mkv mov m4v flv 3gp ts m3u8 mpd mp3 m4a aac ogg opus wav',
      minSizeKB: 300,
      excludedSites: '',
      dontCaptureFromPlayers: true,
    },
    speedLimiter: { enabled: false, kbps: 500 },
    lastSaveDirs: {},
  };
}

module.exports = { defaultSettings, defaultCategories, defaultQueues, defaultSchedule, defaultOnComplete, DOWNLOADS };

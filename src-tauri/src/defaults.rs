//! Default settings, categories and queues (port of src/main/defaults.js).

use std::path::PathBuf;

use serde_json::{json, Value};

pub fn downloads_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Downloads")
}

fn p(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

const CAPTURE_TYPES: &str = "3GP 7Z AAC ACE AIF APK ARJ ASF AVI BIN BZ2 EXE GZ GZIP IMG ISO LZH M4A M4V MKV MOV MP3 MP4 MPA MPE MPEG MPG \
MSI MSU OGG OGV PDF PLJ PPS PPT QT R0* R1* RA RAR RM RMVB SEA SIT SITX TAR TIF TIFF WAV WMA WMV Z ZIP DMG DEB RPM \
FLAC OPUS WEBM XZ ZST";

pub fn default_categories() -> Value {
    let d = downloads_dir();
    let c = |id: &str, name: &str, exts: &str| json!({ "id": id, "name": name, "exts": exts, "folder": p(d.join(name)), "builtin": true });
    json!([
        { "id": "general", "name": "General", "exts": "", "folder": p(d.clone()), "builtin": true },
        c("compressed", "Compressed", "zip rar r0* r1* arj gz sit sitx sea ace bz2 7z tar xz zst lzh"),
        c("documents", "Documents", "doc docx pdf ppt pptx pps xls xlsx txt rtf odt ods epub"),
        c("music", "Music", "mp3 wav wma mpa ram ra aac aif m4a flac ogg opus"),
        c("programs", "Programs", "exe msi msu apk dmg deb rpm iso img bin"),
        c("video", "Video", "avi mpg mpe mpeg asf wmv mov qt rm mp4 flv m4v webm ogv ogm mkv 3gp ts"),
    ])
}

pub fn default_queues() -> Value {
    let mut sync_schedule = default_schedule();
    sync_schedule["periodic"] = json!(true);
    sync_schedule["everyMinutes"] = json!(120);
    json!([
        { "id": "main", "name": "Main Download queue", "type": "download", "builtin": true, "maxConcurrent": 2, "retries": 0, "items": [], "schedule": default_schedule(), "onComplete": default_on_complete() },
        { "id": "sync", "name": "Synchronization queue", "type": "sync", "builtin": true, "maxConcurrent": 1, "retries": 0, "items": [], "schedule": sync_schedule, "onComplete": default_on_complete() },
    ])
}

pub fn default_schedule() -> Value {
    json!({
        "startEnabled": false, "startTime": "02:00", "mode": "daily", "days": [0, 1, 2, 3, 4, 5, 6], "onceDate": "",
        "stopEnabled": false, "stopTime": "08:00", "periodic": false, "everyMinutes": 60,
    })
}

pub fn default_on_complete() -> Value {
    json!({ "exitApp": false, "power": "none", "forceTerminate": false, "runFile": "" })
}

pub fn default_settings() -> Value {
    json!({
        "general": {
            "launchOnStartup": false,
            "minimizeToTray": true,
            "monitorClipboard": true,
            "browserIntegration": true,
            "integrationPort": 52790,
            "forceKey": "Insert",
            "preventKey": "Alt",
            "contextMenu": { "downloadLink": true, "downloadAll": true, "downloadSelected": true },
            "language": "en",
        },
        "fileTypes": {
            "capture": CAPTURE_TYPES,
            "excludedSites": "update.microsoft.com download.windowsupdate.com siteseal.thawte.com ecom.cimetz.com *.voice2page.com",
            "excludedAddresses": ["*.googlevideo.com/videoplayback*"],
        },
        "connection": {
            "maxConnections": 8,
            "serverExceptions": [],
            "timeoutSec": 30,
            "connectionRetries": 20,
            "minSegmentKB": 256,
            "quota": { "enabled": false, "mb": 200, "hours": 1, "warn": true },
            "tls13": true,
        },
        "saveTo": {
            "tempDir": p(std::env::temp_dir().join("OpenDM")),
            "rememberLastPath": true,
            "createCategoryFolders": true,
        },
        "downloads": {
            "showStartDialog": true,
            "addOnlyNoStart": false,
            "showCompleteDialog": true,
            "progressDialog": "show",
            "duplicateAction": "ask",
            "existingFileAction": "rename",
            "userAgent": "",
            "ignoreModTimeChanges": false,
            "showQueuePanelOnLater": true,
            "maxSimultaneous": 8,
        },
        "proxy": {
            "mode": "system",
            "pacUrl": "",
            "http": { "enabled": false, "host": "", "port": 8080, "user": "", "pass": "" },
            "https": { "enabled": false, "host": "", "port": 8080, "user": "", "pass": "" },
            "ftp": { "enabled": false, "host": "", "port": 8080, "user": "", "pass": "" },
            "socks": { "enabled": false, "host": "", "port": 1080, "user": "", "pass": "", "version": 5, "proxyDns": true },
            "bypass": "localhost 127.0.0.1 <local>",
            "ftpPassive": true,
            "useBrowserProxyOnError": true,
        },
        "siteLogins": [],
        "sounds": { "complete": true, "failed": true, "queueDone": true, "volume": 0.4 },
        "appearance": {
            "theme": "system",
            "fontSize": 13,
            "columns": ["name", "queue", "size", "status", "timeLeft", "rate", "lastTry", "description"],
            "columnWidths": {},
            "sort": { "key": "added", "dir": "asc" },
            "showCategories": true,
            "toolbar": "large",
        },
        "videoPanel": {
            "enabled": true,
            "mode": "full",
            "types": "mp4 webm mkv mov m4v flv 3gp ts m3u8 mpd mp3 m4a aac ogg opus wav",
            "minSizeKB": 300,
            "excludedSites": "",
            "dontCaptureFromPlayers": true,
            "ffmpegPath": "",
            "ytdlpPath": "",
        },
        "speedLimiter": { "enabled": false, "kbps": 500 },
        "linkGrabber": {
            "useForLinkLists": true,
            "clipboard": false,
            "deepAnalyse": false,
            "captchaApiKey": "",
            "checkThreads": 4,
            "variousPackage": true,
            "packageFolders": true,
            "expandPackages": false,
            "autoConfirm": false,
            "autoConfirmDelaySec": 15,
            "autoStart": true,
            "offlineAction": "exclude",
            "dupeAction": "skip",
            "queueId": "main",
            "columnWidths": {},
        },
        "torrent": {
            "enableDht": true,
            "enableLsd": true,
            "enableUtp": false,
            "enablePortForwarding": true,
            "enablePex": true,
            "encryption": "prefer",
            "listenPort": 0,
            "trackers": "",
            "seedRatio": 1,
        },
        "lastSaveDirs": {},
    })
}

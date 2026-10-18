# OpenDM

A multi-connection download manager for Windows (also runs on macOS/Linux) modelled on the
feature set of Internet Download Manager 6.43, built clean-room with Electron and plain Node.js.

```
npm install
npm start            # run the app
npm test             # engine/queue/scheduler tests against a local server
node scripts/make-icons.js   # regenerate icons (already committed)
```

Set `OPENDM_DATA_DIR=<folder>` to keep settings and the download list somewhere other than the
default profile (portable mode, testing).

### Browser extension (Chrome / Edge)
`chrome://extensions` → Developer mode → **Load unpacked** → choose the `extension/` folder.
It talks to the app on `127.0.0.1:52790` (Options → General → Local port).

## How it was derived

The feature list comes from IDM's shipped artifacts, analysed with REA and the Windows help compiler —
no IDM code or artwork is reused:

| Source | What it gave |
|---|---|
| `IDMan.exe` PE resources (REA `inspect_pe_resources`: 105 dialogs, 37 string tables, 2 menus, decoded from REA's file ranges) | Main menu tree, every Options tab and control, scheduler, grabber, progress/complete dialogs |
| `idman.chm`, `scheduler.chm`, `grabber.chm`, `tutor.chm` (decompiled) | Behaviour: dynamic segmentation, queue retry rules, grabber levels/filters, command line |
| `IDMGCExt.crx` (REA `extract_artifact` + `analyze_javascript_application`) | Extension surface: MV3 service worker, native messaging, download/webRequest hooks, 4 context-menu items, toolbar toggle |
| `IDMMsgHost.json`, file inventory | Browser ↔ app bridge, video-panel, shell/driver integration pieces |

## Feature map

| IDM feature | OpenDM |
|---|---|
| Dynamic segmentation: new connection takes half of the largest remaining segment | ✅ `src/main/engine/http-download.js` |
| Connection reuse: finished connection continues into the next unstarted segment | ✅ same stream is kept open |
| Resume after pause / crash / power loss (positions saved several times a minute) | ✅ every 3 s; verified across app restart |
| Detects server-side file changes on resume (ETag / Last-Modified / size) | ✅ + "ignore modification changes" option |
| Non-resumable servers, redirects, Content-Disposition names (RFC 5987) | ✅ |
| Default max connections + per-server exceptions | ✅ |
| Timeouts, per-connection retries, 429/503 → fewer connections | ✅ |
| Speed limiter (global, per download) | ✅ token bucket |
| Download limits (X MB every Y hours, auto-resume) | ✅ |
| FTP (passive), multi-connection with REST | ✅ `ftp-download.js` |
| Video streams | ✅ HLS (master → best variant or chosen quality, AES-128). Generic DASH `.mpd` manifests ❌ |
| YouTube: capture the player's `googlevideo.com/videoplayback` streams, pick quality, download video + audio in `&range=` chunks, merge | ✅ `extension/background.js`, `engine/muxed-download.js` (merge needs FFmpeg; without it the audio is saved beside the video) |
| Proxy: none / system / PAC / manual HTTP, HTTPS, FTP, SOCKS4/5, bypass list | ✅ |
| Site logins (server/path patterns), Basic auth, login prompt on 401 | ✅ Basic only (no NTLM/Digest) |
| Categories with extensions + folders, auto-categorise, remember last folder | ✅ |
| Temp folder, numbered names for existing files, duplicate-link handling | ✅ |
| Main window: categories/Unfinished/Finished tree, queues, sortable/resizable/reorderable columns, column chooser | ✅ |
| Toolbar (large/small/icons), menus (Tasks/File/Downloads/View/Help) | ✅ |
| Find / Find next with options | ✅ |
| Download File Info dialog (category, Save As, remember path, description, Later → queue) | ✅ |
| Download progress window: status, segment map with start markers, per-connection table, speed limiter tab, options-on-completion tab | ✅ |
| Download complete dialog with Open / Open folder / drag-the-file | ✅ |
| Properties: change URL ("refresh download address"), folder, name, login | ✅ |
| Redownload, Delete (+files), Delete all completed | ✅ |
| Queues: main download, synchronization, custom; N files at once; retries; failed file → end, lone file retried every 30 s | ✅ |
| Scheduler: start/stop time, daily days or one date, periodic sync, on-finish open file / exit / shutdown / restart / sleep / hibernate, force close, 30 s cancel | ✅ |
| Site Grabber: 4-step wizard, link levels this/other sites, parent dirs, main-domain, page & path filters, type presets, size limits, hide duplicates, subfolders, explore → check → download or add to list, statistics, save/copy projects, scheduled/periodic sync | ✅ (no "run page JavaScript", no IE cache) |
| Batch download with `*` (numbers with wildcard size, letters), batch from clipboard | ✅ |
| Import/export: own format and text files (links extracted) | ✅ |
| Clipboard monitoring for matching file types | ✅ |
| Drop target window, drag links onto main window | ✅ |
| Command line `/d /p /f /a /n /q /s` (+ single instance) | ✅ (`/h` accepted, no-op) |
| Tray icon and menu, minimize to tray, launch at sign-in | ✅ |
| Sounds on complete / failure / queue done | ✅ generated tones |
| Dark mode, font size | ✅ |
| Browser takeover by file type, excluded sites/addresses, force key (Insert) & bypass key (Alt) | ✅ extension |
| Browser context menu: Download with…, Download all links, Download selected links | ✅ + "Download all links" picker with background size/type checks |
| Video panel on web players with media list | ✅ extension `content.js` |
| Toolbar button toggles integration | ✅ |
| YouTube with server-driven streaming (most videos today), and YouTube links pasted into Add URL: handed to [yt-dlp](https://github.com/yt-dlp/yt-dlp) with quality choice, progress, pause/resume, queues | ✅ `engine/ytdlp.js` — yt-dlp is downloaded on first use (Options → Video panel); OpenDM's own Electron runtime is passed to it as the JavaScript runtime YouTube now requires |
| FFmpeg comes from the optional `ffmpeg-static` package (GPL-3.0), PATH, or Options → Video panel | ℹ️ |
| Firefox / Opera extensions, IE BHO, network-driver (WFP/TDI) capture of any app, shell extension | ❌ Chrome/Edge MV3 only |
| ZIP preview before download, "Open with…", Tip of the Day | Tip ✅, others ❌ |
| Dial-up/hang-up modem, toolbar skin downloads, registration, Tell a friend, 30+ language packs | ❌ (obsolete or out of scope; English only) |

## Layout

```
src/main/        Electron main process
  engine/        net (proxy agents), http/ftp/hls downloads, limiter
  manager.js     download list, categories, quotas, finalisation
  queues.js      queues + scheduler
  grabber.js     site crawler
  integration.js localhost endpoint for the extension
src/renderer/    UI (no framework): main window, dialogs, secondary windows
extension/       Chrome/Edge MV3 extension
test/            node:test suite with a local range-capable server
```

The extension endpoint only accepts requests from extension origins that send `X-OpenDM: 1`;
browser pages can't make that request without a CORS preflight, which is never approved.

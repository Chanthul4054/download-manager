# OpenDM

A multi-connection download manager for Windows, macOS and Linux, built with Electron and plain
Node.js. It comes with a Chrome/Edge extension that hands browser downloads and web videos to the app.

## Features

- **Fast, resumable downloads**: each file is split across several connections, and a free
  connection takes over half of the largest remaining piece. Downloads resume after a pause, crash
  or restart, and OpenDM notices if the file changed on the server.
- **HTTP, HTTPS and FTP**, with redirects, server-provided file names, per-server connection
  limits, retries and timeouts.
- **Video**: HLS streams (with quality choice and AES-128), and YouTube through the extension or
  [yt-dlp](https://github.com/yt-dlp/yt-dlp). Separate video and audio streams are merged with FFmpeg.
- **Queues and scheduler**: run several files at once, retry failed ones, start and stop on a
  schedule, and shut down, sleep or exit when done.
- **Site grabber**: crawl a website and download the files that match your filters.
- **Speed limiter and download quotas** (X MB every Y hours).
- **Proxy support**: system, PAC, HTTP/HTTPS/FTP and SOCKS4/5.
- **Categories** with their own file types and folders, batch downloads (`file*.zip`), import and
  export, clipboard monitoring, a drop target, a tray icon, dark mode and sounds.
- **Browser integration**: take over downloads by file type, a "Download with OpenDM" context
  menu, "Download all links", and a video button on web players.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- Optional: [FFmpeg](https://ffmpeg.org/), used to merge video and audio. It is installed with the
  optional `ffmpeg-static` package, or OpenDM finds it on your `PATH`. You can also set its path
  in **Options → Video panel**.
- Optional: yt-dlp. OpenDM downloads it the first time you need it.

## Getting started

```sh
npm install
npm start
```

### Browser extension (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Keep OpenDM running. The extension talks to it on `127.0.0.1:52790`. To use a different port,
   change it in **Options → General**.

## Command line

```sh
opendm /d <url> [/p <folder>] [/f <file name>] [/a] [/n] [/q] [/s]
```

| Switch | Meaning |
| --- | --- |
| `/d <url>` | Download the URL (a URL on its own also works) |
| `/p <folder>` | Folder to save to |
| `/f <name>` | File name to save as |
| `/a` | Add to the queue without starting the download |
| `/n` | Silent: don't show dialogs |
| `/q` | Exit after the download finishes |
| `/s` | Start the main queue |

Only one copy of OpenDM runs at a time. Starting it again passes the switches to the copy that is
already open.

## Configuration

Set the `OPENDM_DATA_DIR` environment variable to keep settings and the download list in a
different folder, for example for portable use or testing.

## Development

```sh
npm test                     # run the test suite against a local test server
node scripts/make-icons.js   # regenerate the icons
```

### Project structure

```
src/main/          Electron main process
  engine/          networking and proxies, HTTP/FTP/HLS/video downloads, speed limiter
  manager.js       download list, categories, quotas
  queues.js        queues and scheduler
  grabber.js       site grabber
  integration.js   local server for the browser extension
src/renderer/      user interface (no framework)
extension/         Chrome/Edge extension (Manifest V3)
scripts/           helper scripts
test/              tests (node:test)
```

### Security

The local server only accepts requests from the browser extension, which sends an
`X-OpenDM: 1` header. Ordinary web pages can't send that header without a CORS preflight, and
OpenDM never approves the preflight.

## License

MIT. The optional `ffmpeg-static` package is licensed separately under GPL-3.0.

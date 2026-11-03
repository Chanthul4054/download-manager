# Changelog

## [2.0.0] - 2026-10-31

OpenDM 2.0 is a full rewrite: the app now runs on Rust and Tauri instead of Electron. Everything
from 1.1 is still there.

### Added
- BitTorrent: magnet links and .torrent files, with peer encryption (MSE/PE), PEX, uTP, extra
  tracker lists, and a Windows Firewall button for incoming peers.
- macOS and Linux builds alongside Windows.
- LinkGrabber resolves hoster pages to direct links, opens PrivateBin pastes, and can solve
  captchas through 2Captcha.

### Security
- A page's cookies are only sent to links, video segments and redirects on that page's own host.
- A crafted .torrent can no longer write files outside the download folder (Windows).
- Web pages can no longer fake the force key or link clicks to push downloads through the
  browser extension.
- The local integration server only answers requests addressed to localhost (blocks DNS rebinding).
- The built-in yt-dlp installer checks the download against its published SHA-256 checksum.
- On macOS and Linux, settings and download lists are readable only by your user account.

## [1.1.0] - 2026-10-23

### Added
- LinkGrabber for collecting and checking links before download.
- A global limit on simultaneous downloads.
- Resizable table columns.

### Changed
- Hardened the HTTP download engine.
- Smaller installer (maximum compression, fewer bundled languages).

## [1.0.0] - 2026-10-18

First release: multi-connection resumable downloads, HTTP/HTTPS/FTP/HLS, YouTube via the
extension and yt-dlp, queues and scheduler, site grabber, speed limiter, quotas, proxies,
categories, batch downloads, clipboard monitoring, dark mode, and a Chrome/Edge extension.

[2.0.0]: https://github.com/Chanthul4054/download-manager/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/Chanthul4054/download-manager/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Chanthul4054/download-manager/releases/tag/v1.0.0

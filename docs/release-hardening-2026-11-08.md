# OpenDM 2.0.0 — Windows beta release hardening (2026-11-08)

Branch `release-hardening/windows-beta-2.0.0`, based on `eaac00e`. Every change described here is
**uncommitted** and waiting for review. The security-audit fixes (`0a09f50` … `c1beb6c`) were
committed before this work started and were not touched.

## A. Summary and recommendation

**Recommendation: READY FOR INTERNAL BETA.**
It is not yet ready for a controlled or public Windows beta.

What is solid:
- **Downloads survive a crash or power cut.**
  - The download engine now writes to disk before it records how far a download got.
  - Three real `taskkill /F` kills of the release build in the middle of a download left no
    corruption, and the download resumed to a byte-identical file.
- **Defects found and fixed:**
  - With PEX turned off (a setting), no torrent could download at all.
  - Four ways a download could become corrupt or wrong after a crash (C.1).
  - A flaky test.
- **Test results:**
  - 101 automated Rust tests pass.
  - Every Windows end-to-end check on the release build passes: features, yt-dlp, crash, and the
    browser extension in Chrome.

What holds it back from a controlled beta. Each item is in J.
1. **The installer has not been run yet.** I prepared the test package (D). Clean install,
   uninstall and both upgrade paths are unverified until you run it in a test account.
2. **Version-number collision.** The release candidate is numbered 2.0.0. A *different* 2.0.0 is
   already published on GitHub (2026-10-31, from `b4d60f9`). Testers and support could not tell
   the two builds apart. Choose a new version (for example `2.0.1` or `2.1.0-beta.1`) before any
   external beta.
3. **Microsoft Edge was not tested,** because Edge is not installed on this PC. The context-menu
   item was not tested in any browser; it needs a manual check.

What is needed for a public beta:
- **Code signing (G.3).** The installer and the program are unsigned, so SmartScreen will warn
  every user who downloads them.

## B. Scope, environment and build record

| | |
|---|---|
| OS | Windows 11 Pro, build 26300, x64 |
| WebView2 | 157.0.4341.42 |
| Toolchain | rustc 1.99.1, cargo 1.99.1, Node 24.20.0, npm 11.19.0, tauri-cli 2.12.4 |
| Browser | Chrome 156.0.8078.80 (Edge not installed) |
| Source | `eaac00e` plus the uncommitted changes in I |
| RC built | 2026-11-08 17:49 with `npm run dist` (`tauri build`: release profile, LTO, stripped) |

Test data:
- No real user data was used.
- Every run used a throwaway data folder (`OPENDM_DATA_DIR`) under the session's temp directory,
  except the installer test. That test is designed to run in a separate Windows account.
- Your own `%APPDATA%\OpenDM` was neither read nor modified.

## C. Download durability (Phase A)

### C.1 Defects found and fixed

1. **Saved progress could run ahead of the data on disk.**
   - What went wrong:
     - The download list was saved every 3 seconds with each segment's position.
     - The file data itself was never flushed to disk.
     - After a power cut, a segment could claim bytes that were never written.
     - The download would then resume past a hole of zeros and finish as "complete", but corrupt.
   - The fix (`engine/mod.rs`, `item.rs`):
     1. Each segment keeps two offsets: the *live* one and the *synced* one.
     2. Every checkpoint takes a snapshot of the live offsets.
     3. It flushes the file (`FlushFileBuffers`, on a blocking thread).
     4. Only then does it advance the synced offsets, and only up to the snapshot.
     5. Only synced offsets are saved, still under the existing key `pos`, so the file format is
        unchanged and older data loads fine.
   - When a download stops or finishes, it takes one last checkpoint.
   - If that final flush fails on a "complete" download, the download now ends with an error
     ("Could not write the file") instead of being marked complete.
2. **FTP: a missing temp file was recreated empty, but the saved positions were kept.** The
   result was a corrupt file. Fixed by checking the saved positions against the real file
   (`reconcile`). Confirmed by mutation: the new test fails without the fix.
3. **HTTP and FTP trusted saved positions past the end of a shortened temp file.** Positions are
   now limited to the file's real length. Confirmed by mutation.
4. **HLS: each segment file was marked done before its data was flushed.** It is now written and
   flushed first.
5. **`write_json_atomic` left a `.tmp` file behind on every failed save** (for example, when
   `downloads.json` is read-only). The temp file is now removed.

Related change:
- On restart, an interrupted download shows the durable amount, not the last live amount
  (`manager.rs`).

New setting:
- `connection.checkpointSec`: default **2 s**, limited to 1–60 s.
- It is not in `defaults.json` and has no UI; the default applies.

### C.2 Tests

- **Unit tests: 5 new `checkpoint_tests`.**
  - An injected sync failure records no progress.
  - Only bytes written before the sync become durable.
  - Loading sets pos = synced.
  - `reconcile` limits positions correctly.
  - Sync works on a real file.
- **`tests/durability.rs` (6 tests):**
  - Saved offsets never run ahead of the file, with 4 downloads running at once.
  - Pause saves the exact position.
  - A shortened temp file resumes correctly.
  - Garbage written after the offsets is overwritten.
  - A missing temp file restarts the download.
  - A read-only list leaves no `.tmp` files.
- **`tests/ftp.rs` (3 tests, new local FTP server):**
  - A multi-connection download.
  - Resume after a crash with the temp file gone or shortened.
- **`scripts/qa/crash-e2e.mjs`, on the release build: 7/7.**
  - It hard-kills the app three times during a 128 MB, 4-connection download.
  - After each kill, every saved offset is inside the temp file, and the bytes before it match
    the server's bytes for that range.
  - On restart, the app shows exactly the durable amount, as paused.
  - The finished file is byte-identical.

| Kill | Durable (saved) | Live at kill | Temp file |
|---|---|---|---|
| 1 | 15.44 MB | 19.69 MB | 106 MB (pre-allocated) |
| 2 | 31.19 MB | 33.44 MB | 110 MB |
| 3 | 38.94 MB | 47.19 MB | 114 MB |

The gap between "live" and "durable" is the most that a crash can cost: at most one checkpoint
interval of data has to be downloaded again.

### C.3 Benchmarks and the default interval

Full table: `bench/README.md`, section "Rust engine: durable checkpoints". Setup: loopback, 3 runs.

- Throughput for 8 × 128 MB at 1 MB/s each: **63.2 MB/s in every mode**.
- Event-loop p99: 6.8 ms (no sync), 9.5 ms (1 s), **7.5 ms (2 s)**, 7.1 ms (5 s).
- Syncs per run: 136 / 72 / 32, taking 3.5 / 2.7 / 2.0 s in total, all on blocking threads.
- The final sync for a 2 GB file takes about 0.6 s.
- Bytes written and memory use are unchanged.

**Default: 2 s.** It costs much less than 1 s and loses at most 2 s of data on a crash.

### C.4 Not covered

- A true power cut (needs hardware).
- Sync latency on a spinning hard disk.
- BitTorrent: librqbit checks pieces by hash, so it re-verifies after a crash.
- yt-dlp: it manages its own `.part` files.

## D. Installer (Phase B) — prepared, **not yet executed**

The installer has **not** been run, so no installer result is claimed.

Why it hasn't run:
- This Windows account has your real OpenDM data.
- Windows Sandbox is unavailable.
- You chose to run a prepared script in a dedicated test account.

The package is at `C:\Users\Public\OpenDM-installer-test\`; `README.txt` there has the steps. The
script is `installer-test.ps1`, also kept in `scripts/qa/`.

What the script does:
- It refuses to run if the account already has OpenDM installed or an OpenDM data folder.
- It checks the SHA-256 and signature of every installer.
- **Clean install:** silent install of the RC, then checks the entry, files, shortcuts and binary
  hash, starts the app, and checks the data folder is created.
- **Uninstall:** the app is removed, and the download list is kept.
- **Upgrade from the published 1.1.0 (Electron)**, then the same from the **published 2.0.0
  (Tauri)**:
  - It seeds a finished download, a half-finished download and changed settings.
  - It runs the old version once.
  - It upgrades and checks that no second copy is left installed.
  - It resumes the half-finished download, checks the SHA, and checks the settings were kept.
- It cleans up the test account.

Manual checks listed in the README:
- The SmartScreen prompt on a downloaded copy.
- The Start menu entry.
- Settings > Apps.
- Notifications and the tray.

Static review results:

1. **Possible leftover 1.1.0 install.** The Tauri NSIS installer registers as
   `HKCU\…\Uninstall\OpenDM` and installs to `%LOCALAPPDATA%\OpenDM`. The 1.1.0 Electron installer
   used a GUID key and `%LOCALAPPDATA%\Programs\opendm`. So upgrading from 1.1.0 probably leaves
   the old copy installed next to the new one. The script checks this ("upgrade replaces 1.1.0").
   If it fails, the fix is either an uninstall step for the old key in the NSIS installer hooks, or
   release notes telling users to uninstall 1.1.0 first.
2. **Data compatibility.** Every version uses `%APPDATA%\OpenDM`. The download-list format is
   unchanged by this work.
3. **Same version number.** Upgrading from the published 2.0.0 installs over the same version
   number. In interactive mode, NSIS may show "already installed" instead of "upgrade". This is one
   more reason to choose a new version (A.2).
4. **What uninstall deletes.** Uninstall keeps `%APPDATA%\OpenDM`. Its optional "delete app data"
   step removes only `%APPDATA%\com.opendm.app` and `%LOCALAPPDATA%\com.opendm.app` (WebView data),
   so **the download list and settings survive even that option**. Release notes should say so.

Installers used:

| File | SHA-256 | Source |
|---|---|---|
| `OpenDM-Setup-1.1.0.exe` | `1266cdaa396a92fcaed1bf54a0074d5f17d065fe4dd9e97dedb3ee3fd6c3ff3f` | GitHub v1.1.0 (local copy matches it byte for byte) |
| `OpenDM-Setup-2.0.0-published.exe` | `ed4724e40c82e3aeeb5ea796cbf219ddaee1fbf812864535c214b6734ffefc57` | GitHub v2.0.0 (matches GitHub's digest) |
| `OpenDM_2.0.0_x64-setup.exe` (RC) | `b88a6135ce0ba8f963b9742bc32d8cfd32ca80a2b07f54848b4d6834b07eeb9f` | This build |

All three installers are **NotSigned**.

## E. Browser extension (Phase C)

Run: `scripts/qa/extension-test.mjs` against the release app, Chrome 156.0.8078.80, throwaway
profiles. The extension was loaded with CDP `Extensions.loadUnpacked`, because branded Chrome
ignores `--load-extension`. Result: **13/13 pass.**

- **Deny:** the browser is marked refused and gets no token. It keeps its own downloads.
- **No early token:** none is issued before the user answers the prompt. A separate 40 s probe
  over raw HTTP stayed at 202 (pending) / 429 (busy) and never issued a token.
- **Allow:** the browser gets a 64-character token.
- **Capture:** a 2 MB `.zip` is captured by OpenDM, its SHA-256 is correct, and the browser does
  not also save it.
- **Refusals:** an ordinary web page's `fetch` to the API is blocked, and a request without a
  token gets 401. The pairing and Origin checks were not bypassed or weakened.
- **App closed:** the browser downloads the file itself.
- **Errors:** no uncaught errors in the extension's service worker.

About the pairing prompt:
- The prompt is a native Windows TaskDialog. Its buttons expose no UI Automation pattern, so
  `scripts/qa/dialog.ps1` clicks them through their native window handles.
- In two runs, a token appeared without the script's click. You confirmed you clicked Allow on
  those prompts yourself, so this was not a bypass.

Not tested:
- **Edge:** not installed here.
- **The "Download with OpenDM" context-menu item:** Chrome's native menu cannot be driven over CDP.
  This is a manual check.

## F. Features (Phase D)

| Area | How | Result |
|---|---|---|
| HTTP proxy, with login (wrong password → 407 error), SOCKS5 (remote DNS), PAC via WinHTTP | `tests/proxy.rs`, local proxies; the host is only reachable through the proxy | 4/4 |
| BitTorrent from a local seeder and tracker (DHT, LSD, uTP and UPnP off) | `tests/torrent_local.rs`; PEX off, PEX on, encryption off | pass ×3 |
| Download File Info window: shows name and size; Start download | `scripts/qa/features-e2e.mjs`, release build | pass |
| Batch dialog (Ctrl+B): `part*.bin` → 10 addresses → review window → all 10 finish | same | pass |
| Export to an OpenDM file and to a text file, through the real Save dialog | same (`filedialog.ps1`) | pass, 11/11 entries |
| Remove (keep files); import of the OpenDM file through the real Open dialog; "Imported 11 downloads." message | same | pass |
| Import of a text file → LinkGrabber gets exactly the 2 addresses (prose line ignored) → they download | same | pass |
| Redownload of a damaged, completed file | same | pass (fetched again, intact) |
| Remove with files, for a finished download and for a paused partial (temp data deleted) | same | pass |
| All 8 sidebar pages in light and dark: 16 screenshots, reviewed by eye | same | pass, no rendering problems or JS errors |
| yt-dlp installed by the app into its own `bin` (SHA-256 checked); generic extractor on a local HTML5 `<video>` page; byte-identical | `scripts/qa/ytdlp-e2e.mjs` | 4/4 |

`features-e2e.mjs` passed 14/14 on two consecutive runs.

**BitTorrent defect found and fixed:**
- What went wrong:
  - With `torrent.enablePex = false`, OpenDM's vendored librqbit set `ut_pex = None` in the
    extended handshake.
  - That struct (from the registry crate `librqbit-peer-protocol`) has no `skip_serializing_if`,
    so encoding failed with "bencode doesn't support None".
  - Every peer connection then dropped right after the BitTorrent handshake.
  - Result: **no torrent could download** with PEX off.
- How it was found: a byte relay, a two-process librqbit pair, and a temporary tracing subscriber
  (since removed; `Cargo.toml` and `Cargo.lock` are unchanged).
- The fix (`vendor/librqbit/src/torrent_state/live/mod.rs`): keep advertising `ut_pex`.
- PEX off is still enforced: no PEX task starts, and incoming PEX messages are ignored (existing
  code).

Minor issues, not blocking:
- **Import resets entries.** Importing an OpenDM export re-adds every entry as queued and without
  its size, even entries that were complete. The status and size in the file are ignored.
- **Silent failures.** Export does not report a write error. Import of an invalid file does
  nothing, with no message.
- **"Start now" off by default.** The review window adds downloads to the Main queue unless
  "Start now" is ticked. This matches IDM, but first-time users may expect the downloads to start.

Intermittent stall, not reproduced:
- Twice, early in development, the first download stayed at "downloading, 0 B" for 30 s.
- Both times came right after an aborted run that had left a modal Save dialog open. An app stuck
  in a modal dialog survives `app:quit`, and the app is single-instance.
- It did not happen in 20 isolated runs or 5 clean full runs. It is classed as a test-harness
  artefact and listed in J.

Not automated (manual): notifications, the tray, and the per-OS Start menu. See D, manual checks.

## G. Security and distribution (Phase E)

### G.1 Review

- **Integration server:**
  - Listens on `127.0.0.1` only.
  - Checks the Host header against DNS rebinding.
  - Requires an Origin from an extension and a token from pairing (E).
- **App security settings:**
  - CSP: `default-src 'self'; script-src 'self'`.
  - `withGlobalTauri: false`.
  - One `ipc` command with an allow-list of channels.
- **yt-dlp install:** checked against the release's `SHA2-256SUMS` before it is used. That file
  comes from the same GitHub release, so it catches corruption, not a compromised release.
  yt-dlp runs with `--ignore-config`, and the address goes after `--` (`5243e75`).
- **FFmpeg:** its checksum is checked when packaging (`fa51e10`).
- **Test hooks:** the release keeps two documented, opt-in environment variables.
  `OPENDM_DATA_DIR` sets a portable data folder. `OPENDM_DIAG` turns on diagnostics with addresses
  reduced to origin and path. Using them requires local code execution, which is already full
  access.
- **No debug or mock code ships.** The built frontend has no `console.log` or `debugger`, and no
  mock code exists in `src` or `src-tauri/src`.
- **Dependencies:**
  - `npm audit`: 0 vulnerabilities, including dev dependencies.
  - `cargo audit`: **not run**, because `cargo-audit` is not installed. I did not install tooling
    unasked. Recommended before a public beta: `cargo install cargo-audit && cargo audit`.
- **Finding: developer tools ship in release builds.**
  - The `devtools` feature is on in `Cargo.toml`, and the app menu has "Developer tools"
    (Ctrl+Shift+I). This has been so since the Tauri port (`c630c44`).
  - It gives no remote access. It does make "paste this into the console" social engineering
    possible against the app's IPC, for example pairing or changing settings.
  - Recommendation: remove the feature and the menu item for public builds, or gate them behind a
    debug build.
  - **Not changed.** It is an existing product behaviour, and changing it needs your decision.
- **`install.sh`** (Linux and macOS only) downloads without checking checksums. This is outside
  the Windows scope, noted for later.

### G.2 Checksums

The RC artifacts are in D and H. Publish a `SHA256SUMS` file next to the installer. The package
folder has an example (`SHA256SUMS.txt`).

### G.3 Code signing: requirements

The RC is **unsigned**; I invented no certificate or signature. What users will see:
- SmartScreen will show "Windows protected your PC" for the downloaded installer, with "More
  info → Run anyway". Some managed PCs block unsigned installers outright.

What signing needs:
1. **A code-signing certificate from a CA Microsoft trusts.** The options are:
   - **Azure Trusted Signing** (now called Artifact Signing): low cost. Check whether individual
     developers in your country are eligible.
   - **An OV certificate** on a hardware token or cloud HSM. Since 2023, CA rules require keys on
     hardware.
   - **SignPath Foundation:** free for qualifying open-source projects.

   EV certificates no longer skip SmartScreen reputation, so reputation still builds with download
   volume for any certificate.
2. **Sign both `opendm.exe` and the NSIS installer.** The uninstaller is generated inside the
   installer and is signed when the installer build signs it. Configure
   `bundle.windows.signCommand` (or `certificateThumbprint`, `digestAlgorithm: sha256`,
   `timestampUrl`) in `tauri.conf.json`. Always use an RFC 3161 timestamp so signatures outlive
   the certificate.
3. **Check after building:** `Get-AuthenticodeSignature` on both files reports `Valid` with the
   expected signer, and `signtool verify /pa /v`.

## H. Release candidate (Phase F)

Release-candidate files:

| Artifact | Size (bytes) | SHA-256 |
|---|---|---|
| `dist/OpenDM-Setup-2.0.0.exe` (= `bundle/nsis/OpenDM_2.0.0_x64-setup.exe`) | 28,631,524 | `b88a6135ce0ba8f963b9742bc32d8cfd32ca80a2b07f54848b4d6834b07eeb9f` |
| `src-tauri/target/release/opendm.exe` | 25,312,768 | `3e96537fafc01d26d5e61e8a28c71dd4ec37cb24db716ee9d99eb6a23313bd3b` |

Regression results:

- **`cargo test --release` (full suite): 101 passed, 0 failed, 2 ignored.** The 2 ignored tests
  need the internet and were already ignored before this work.
  - lib 46, durability 6, engine 9, failures 10, features 4, ftp 3, grabber 2, linkgrabber 6,
    proxy 4, robustness 8, streams 2, torrent_local 1.
  - Before the flaky test was fixed, `tests/engine.rs` failed 1 run in about 10. Its pause/resume
    test asserted "no request started at byte 0" against a server shared by 7 tests running in
    parallel. The test now records requests per URL and uses its own URL.
- **`cargo clippy --all-targets`:** no warnings in new or changed code. The 12 remaining warnings
  were already there.
- **Frontend build:** passes, as part of `tauri build`.
- **End-to-end runs on a copy of the release exe:**

  | Run | Result |
  |---|---|
  | `features-e2e.mjs` | 14/14 |
  | `ytdlp-e2e.mjs` | 4/4 |
  | `crash-e2e.mjs` | 7/7 |
  | `extension-test.mjs` | 13/13 (run on the 17:03 build; the extension and integration code did not change after it) |

- **Build lesson:** the first RC build failed with "Access is denied", because a test was running
  `target/release/opendm.exe`. The end-to-end scripts now run a copy of the exe.

## I. Changes made (uncommitted, for review)

**Engine (durability):**
- `src-tauri/src/item.rs`
- `src-tauri/src/engine/mod.rs`
- `src-tauri/src/engine/http_download.rs`
- `src-tauri/src/engine/ftp_download.rs`
- `src-tauri/src/engine/hls_download.rs`
- `src-tauri/src/manager.rs`
- `src-tauri/src/util.rs`

**BitTorrent:**
- `src-tauri/vendor/librqbit/src/torrent_state/live/mod.rs`

**Benchmarks:**
- `src-tauri/examples/download_bench.rs`: adds `--checkpoint`, long and 2 GB scenarios, and
  sync/IO columns.
- `bench/README.md`

**Tests:**
- New: `tests/durability.rs`, `tests/ftp.rs`, `tests/proxy.rs`, `tests/torrent_local.rs`.
- Fixed flake: `tests/engine.rs`.

**QA scripts (`scripts/qa/`):**
- `crash-e2e.mjs`
- `features-e2e.mjs`
- `ytdlp-e2e.mjs`
- `extension-test.mjs`
- `dialog.ps1`
- `filedialog.ps1`
- `installer-test.ps1`
- `installer-check.mjs`

**Compatibility:**
- No IPC contract changed.
- No settings or data format changed. The saved key is still `pos`, and the new setting is
  optional.
- No security control was changed.
- The React UI was not changed.

**Suggested commits, separated by feature:**
1. Durable checkpoints (engine, plus the unit and durability tests).
2. FTP local server tests.
3. HLS segment flush.
4. Atomic JSON temp cleanup.
5. The librqbit PEX fix, plus `torrent_local.rs`.
6. Proxy tests.
7. The engine test flake fix.
8. Checkpoint benchmarks.
9. The Windows QA scripts.
10. This report.

## J. Residual risks and what remains

**Before a controlled Windows beta:**
1. **Run the installer test** (D) in a test account, plus its manual checks. If "upgrade replaces
   1.1.0" fails, add an uninstall of the old Electron install, or document it.
2. **Choose a new version number** so the RC differs from the published 2.0.0, then rebuild and
   re-hash.
3. **Test Edge,** with the same `extension-test.mjs` and Edge's executable path.
4. **Check the context-menu item** by hand in Chrome and in Edge.
5. **Decide about developer tools** in release builds (G.1).

**Before a public Windows beta:**
1. **Code-sign** the program and the installer (G.3), and publish checksums.
2. **Run `cargo audit`.**
3. **Optional:** fix the silent export/import failures, and keep status and size when importing
   an OpenDM export.

**Known limits of this pass:**
- No hardware power-cut test, and no measurement on a spinning hard disk.
- The intermittent first-download stall (F) was not reproduced and is attributed to the test
  harness.
- The extension test ran on the 17:03 build, not the 17:49 RC. The code paths it covers did not
  change between the two builds.

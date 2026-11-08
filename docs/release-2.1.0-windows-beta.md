# OpenDM 2.1.0 — Windows internal beta: release preparation (2026-11-08)

Branch `release/2.1.0-windows-beta`, based on `277fa2c`. Every change in this report is
**uncommitted** and waiting for review. Nothing was committed, pushed or published.

Evidence labels used below:
- **[auto]** checked by a script in this session, with the result shown.
- **[manual]** checked by a person.
- **[not run]** prepared but not executed. No result is claimed.

## A. Release overview

| | |
|---|---|
| Version | **2.1.0** |
| Target | Windows 10/11 x64, per-user NSIS installer |
| Installer | `dist/OpenDM-Setup-2.1.0.exe` (28,624,201 bytes), **unsigned** |
| Supported install paths | fresh install of 2.1.0; upgrade from the published **2.0.0** (Tauri); uninstall |
| Not supported | a direct upgrade from the Electron **1.1.0**: uninstall 1.1.0 first (L) |

**Recommendation (M): READY for internal beta (unsigned), after a commit and a rebuild from that
commit.**
- The build, the version, the hash provenance and the app regressions are done and verified.
- The installer test ran twice in the test account (G):
  - The first run exposed a data-loss bug with BOM-prefixed data files. It is fixed.
  - The second run, on the current build, passed clean install, in-place upgrade from 2.0.0 with
    data kept, and uninstall.
  - Its only failure was a test-script bug in the resume step, which was then verified on the
    release exe.

## B. Version changes

All of these are now 2.1.0:
- `package.json` and both version fields of `package-lock.json` (the root package).
- `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` (the `opendm` package).
- `src-tauri/tauri.conf.json`. This sets the installer's version, the Installed Apps
  `DisplayVersion` and the exe's version resource.
- The `.github` bug-report placeholder.
- `CHANGELOG.md`: a new 2.1.0 entry.

Kept unchanged, on purpose:
- The identifier `com.opendm.app`.
- The product name `OpenDM`.
- The install folder `%LOCALAPPDATA%\OpenDM` and the uninstall key `HKCU\…\Uninstall\OpenDM`.
- The data folder `%APPDATA%\OpenDM`.
- The browser extension's own version (1.0.0). It is versioned separately from the app.

So 2.1.0 installs over 2.0.0 in place, under the same uninstall entry.

Checked on the built files [auto]:
- `opendm.exe`: ProductName `OpenDM`, ProductVersion `2.1.0`, FileVersion `2.1.0`, CompanyName
  `OpenDM contributors`. PE machine `0x8664` (x64).
- Installer: ProductVersion `2.1.0`, FileVersion `2.1.0`.
- The app reports `2.1.0`. Its version comes from `CARGO_PKG_VERSION` and the Tauri config.
- No `2.0.0` release-candidate metadata remains in the sources. `grep "2.0.0"` now finds only
  the CHANGELOG history, third-party lockfile entries and `installer-test.ps1`, which refers to
  the *published* 2.0.0.

Installer name:
- Tauri builds `bundle/nsis/OpenDM_2.1.0_x64-setup.exe`.
- `scripts/dist.js` copies it to `dist/OpenDM-Setup-2.1.0.exe`. This is the project's existing
  naming, as used for `OpenDM-Setup-2.0.0.exe`.

## C. Changes since the published 2.0.0

The published 2.0.0 was built from `b4d60f9` (2026-10-31). Since then:
- **New React interface.** `febcc96` … `4dbd409`, plus the animation work up to `a99855f`.
- **Security audit fixes.** `0a09f50` … `c1beb6c`:
  - The extension pairing prompt.
  - Site cookies stay on their own site.
  - Captcha solves are rate-limited.
  - HLS and paste size caps.
  - BitTorrent input hardening.
  - yt-dlp runs with `--ignore-config`.
  - The FFmpeg checksum is checked when packaging.
  - Data files are created owner-only on Unix.
- **Durability and recovery.**
  - Progress is saved only after the data is on disk (`67b28a9`).
  - Each HLS segment is flushed before it is marked done.
  - A failed JSON save no longer leaves a temp file.
  - Saving the list while downloads run; History loads quickly with thousands of entries.
- **BitTorrent.** Torrents download with PEX turned off (`9b8c1df`).
- **Tests.** Durability, FTP, proxy and local-torrent tests; the Windows QA scripts.
- **This pass:**
  - The version is 2.1.0 (B).
  - Developer tools are limited to debug builds (F.4).
  - Build provenance manifest (E).
  - Installer test rewritten (G).
  - Three UI fixes you reported during this session (F.3).

## D. Executable hash mismatch: investigation and resolution

**Symptom.** In the 2.0.0-RC installer test:
- Expected exe SHA-256: `3e96537f…bd3b`.
- Installed exe SHA-256: `2f7912b2…9a66`.
- The installer's own SHA-256 matched.

**What each hash belonged to:**
- `3e96537f…` was `src-tauri/target/release/opendm.exe` from the 17:49 build. It was still on
  disk, with the same hash.
- That exe was the input to the installer, built in the same `tauri build` run (same
  timestamp).

**Root cause: a packaging transformation, not a stale build.**
- Tauri's bundler writes the bundle type into the main binary before it runs makensis. It
  replaces the marker `__TAURI_BUNDLE_TYPE_VAR_UNK` with `__TAURI_BUNDLE_TYPE_VAR_NSS`, so the
  app can know which installer it came from.
- Afterwards it puts the original binary back into `target/release`.
- So the exe *inside* the installer differs from `target/release/opendm.exe` in exactly 3 bytes.
  The expected hash was taken from the restored, unpatched file.

**Proof [auto].**
- `3e96537f…` contains exactly one marker, at offset 20,251,983.
- Replacing `UNK` with `NSS` there gives SHA-256
  `2f7912b20a77b5fcc8cb266ce49309190666e46f73153fb490e85f9f21f39a66`. That is exactly the
  installed hash.
- So the installer contained the fresh, intended binary.

**What was ruled out:**
- Stale artifacts.
- An older exe in the installer.
- A wrong target directory.
- Build scripts copying the wrong file. `dist.js` only copies the installer, and filters by
  version.

**Fix.** The expected hash is not edited by hand. `scripts/dist.js` now derives it:
1. It reads the freshly built exe.
2. It requires exactly one `UNK` marker, and fails the build otherwise.
3. It applies the same 3-byte patch.
4. It records the result as `exe.nsisPackaged.sha256` in the manifest, next to the raw exe hash
   and the patch offset.

The installer test compares the installed exe with that value, so a stale or wrong binary still
fails. Byte-for-byte confirmation for 2.1.0 comes from the installer test (G), which is
**[not run]**.

## E. Build provenance and checksums

Build: `npm run dist`. This runs `verify-ffmpeg.js` (FFmpeg SHA-256 pin: ok), then `tauri build`
(`npm run build` inside it, then release `cargo build`, then makensis), then `dist.js`.
- Before the build, `cargo clean --release -p opendm` removed OpenDM's own release artifacts, so
  nothing was reused. Dependencies, user data and the working tree were not touched.
- The build ran three times. The last run includes the UI fixes; only its artifacts are listed
  and staged.

`dist/OpenDM-2.1.0-manifest.json` (final build):

| Field | Value |
|---|---|
| Source | `277fa2c2952c91472d2bd51e390d80ed46521b7b` + uncommitted changes, `git diff HEAD` SHA-256 `b2cc21ae41aa784772c622411c75ee9f802a9521ee889853fb8711fa50a7e8df` |
| Built | 2026-11-08T17:00:42Z (time the bundler restored the exe; `cargo clean -p opendm` first) |
| Version / arch | 2.1.0 / win32 x64 (PE `0x8664`) |
| Toolchain | rustc 1.99.1, Node 24.20.0, tauri-cli 2.12.4 |
| `src-tauri/target/release/opendm.exe` | 25,287,680 bytes, SHA-256 `151353896f1e701f8dd6adc4bd7d61606a3e1143d557e653f96f51f47ac7ccb8` |
| exe as packaged in the installer (`UNK→NSS` at offset 20,235,055) | SHA-256 `fdcd26ad819ee2d01df88cff5409cc031f17b064efd613b638421fe9a7684570` |
| `dist/OpenDM-Setup-2.1.0.exe` | SHA-256 `b1d7b0e7cb3c8ebdf5cb053d40422d85f6c8afc0257dfcd59bd63600478e469a` |

`dist/SHA256SUMS-2.1.0.txt` holds the installer line. Once the source is committed, rebuild so
the manifest records a clean commit (`dirty: false`).

Bundled resources:
- FFmpeg (pinned hash, checked by `verify-ffmpeg.js`).
- `extension/`: `manifest.json`, `background.js`, `content.js`, the options page and icons.

Both are verified in the installed folder by the installer test **[not run]**. Both are verified
at runtime from the release exe by the end-to-end tests [auto].

## F. Automated results on this build [auto]

### F.1 Rust and frontend

- **`npm test` (`cargo test`): 102 passed, 0 failed, 2 ignored.**
  - lib 47 (one new store test, I), durability 6, engine 9, failures 10, features 4, ftp 3, grabber 2, linkgrabber 6,
    proxy 4, robustness 8, streams 2, torrent_local 1.
  - It ran after the last Rust change. Later changes are frontend-only.
- **`npm run build` (`tsc --noEmit` + Vite): passes.**
  - The production bundle contains neither "Developer tools" nor a `devtools` call.
- **`tauri build`: no Rust compiler warnings** in the release build log.
- **The 2 ignored tests (not run):** both in `tests/torrent.rs`, both need the internet.
  - `downloads_from_the_swarm_then_stops_and_cleans_up`: a real swarm.
  - `bench`: a benchmark.
  - Not claimed as passed. Run with `cargo test --test torrent -- --ignored`.

### F.2 End-to-end on a copy of the final release exe (throwaway data folders)

| Run | Result |
|---|---|
| `features-e2e.mjs` (Download File Info, Batch, export/import through real dialogs, redownload, remove, all pages light/dark) | **14/14** |
| `crash-e2e.mjs` (3 hard kills mid-download, durable offsets, byte-identical result) | **7/7** |
| `ytdlp-e2e.mjs` (install yt-dlp through the app, byte-identical video) | **4/4** |
| `extension-test.mjs`, Chrome 156, on its own integration port (see J.1) | **13/13**, one Allow press |
| UI and developer-tools check (below) | **9/9** |

Durability, resume, extension capture and the PEX fix remain intact:
- Durability and resume: `crash-e2e` and the durability tests.
- Extension capture: capture, token refusal and fallback all pass.
- The PEX fix: the `torrent_local` test.

### F.3 UI fixes you asked for during this session

1. **Sideways scroll crash** ("Cannot read properties of null (reading 'scrollTop')").
   - Cause: `DownloadList.tsx` read `e.currentTarget` inside a deferred `setView` updater. React
     had already cleared it by then.
   - Fix: read the value before calling the setter.
2. **Progress window blank space and empty details.**
   - Cause: the window opened at a fixed 560 px. "Hide details" left the gap. The details are
     empty for torrents, yt-dlp, paused and finished downloads, because the engine reports
     connections only for active HTTP/FTP/HLS downloads.
   - Fix: the window now fits its content. The details toggle only appears when there are live
     connections or a map of downloaded parts.
3. **Downloads table in a small window.**
   - Columns first shrank to fit. That made them unreadable and broke column resizing: a dragged
     width was saved scaled down.
   - At your request, columns keep their widths and the table scrolls sideways (the original
     behaviour, now without the crash).
   - Resizing was confirmed with the real Windows mouse (`SendInput`), not only CDP: 88 → 155 px
     for a 100-physical-pixel drag at 150 % scaling.

Results of `ui-check` on the release build:
- Columns keep their width and the table scrolls sideways.
- Resize by drag, and the width is saved (88 → 148).
- 40 sideways and vertical wheel events cause no crash.
- Progress window: the gap between content and footer is ≤ 1 px with details shown (542 px),
  hidden (336 px) and shown again, and when paused.

### F.4 Developer tools policy (Phase F)

Change:
- Removed Tauri's `devtools` Cargo feature. Release builds then create WebView2 with
  `AreDevToolsEnabled = false`, which blocks F12, Ctrl+Shift+I and "Inspect" at the WebView
  level.
- The native menu item and its handler are compiled only with `debug_assertions`.
- The React menu item and the Ctrl+Shift+I shortcut exist only when `import.meta.env.DEV`.

Tested [auto]:
- **Release:** the menu opens without "Developer tools", and Ctrl+Shift+I opens no DevTools
  target.
- **Debug** (`target/debug` + Vite dev server): the item is present and Ctrl+Shift+I opens
  DevTools.
- F12 and the right-click "Inspect" are covered by the same WebView2 setting but were not
  pressed separately (manual check D in the package README).

What it doesn't remove:
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` still exposes CDP. The QA
  scripts rely on it. Using it requires local code execution, which is already full access.

## G. Installer test: clean install (Test 1), upgrade from 2.0.0 (Test 2), uninstall (Test 3)

**Status: second run on the current build (`results\tedt-20261108-224222`): 46 of 48 checks
passed. Both failures are one harness bug, now fixed. The resume step was verified separately
[auto].**
- No installer was run in your account.

**Second run (current build, installer `b1d7b0e7…469a`):**
- Passed: everything in the first run, plus "one Installed Apps entry" (clean and upgrade),
  "upgraded in place", and no duplicate startup entries.
- After the upgrade, 2.1.0 loaded both seeded items (History complete, paused at 24 MB) and
  `maxConnections = 5`. Uninstall kept them.
- Failed: "resumed download completes intact" and the upgrade data check that includes it. The
  item stayed `paused`.
  - Cause: `installer-check.mjs` called `dl:start` with a bare id. The command takes a list of
    ids, and the app's UI always passes one, so nothing was started.
  - Fix: pass `[id]`.
  - Verified on the release exe with the same seed and `bench_server.exe` [auto]: it resumed from
    24 MB and completed, and the file's SHA-256 equals the server's.
  - The upgrade-resume step has not been re-run in `tedt` itself.

**First run, what passed:**
- Hashes, signature status and installer version.
- The installed exe equals the packaged hash, on both clean install and upgrade. This confirms
  the B/D explanation of the old mismatch on a real install.
- Required files; one Start-menu and one desktop shortcut; both start the app; it reports 2.1.0.
- Uninstall while running: no process left, data folder kept.

**First run, what failed and why:**
1. "Clean install", "one Installed Apps entry" (×2), "upgraded in place": **script bug**. Windows
   PowerShell returns a one-item list from a function as the bare item, so `.Count` counted that
   entry's fields. The recorded snapshot shows exactly one entry, with the same uninstall key and
   folder before and after the upgrade. Fixed: the snapshot wraps each list in `@()`.
2. Data kept after upgrade (2 items, `maxConnections = 5`, resume): **a real product bug,
   exposed by the script.**
   - The script seeded `downloads.json`/`settings.json` with `Set-Content -Encoding UTF8`, which
     writes a byte-order mark. `serde_json` rejects a BOM, so 2.1.0 (and 2.0.0) treated both
     files as empty, and the next save **overwrote the user's list with `[]`**. Reproduced on
     the release exe [auto].
   - Users hit this too if they edit a data file in Notepad or PowerShell 5.
   - Fix (`util.rs`, `store.rs`): the loader strips a BOM; any data file that exists but cannot
     be parsed is first copied to `<name>.json.unreadable-<timestamp>`, so a later save can no
     longer destroy it. Unit test `bom_files_load_and_unreadable_files_are_kept`. Re-checked on
     the rebuilt release exe: BOM files load (1 item, `maxConnections = 5`) and stay intact
     [auto].
   - The script now seeds without a BOM, so the upgrade test checks the upgrade, not this bug.

**Package** (`C:\Users\Public\OpenDM-installer-test\`, all hashes in `SHA256SUMS.txt`):

| File | SHA-256 |
|---|---|
| `OpenDM-Setup-2.1.0.exe` | `b1d7b0e7…469a` (= E) |
| `OpenDM-Setup-2.0.0-published.exe` | `ed4724e4…fc57` (GitHub v2.0.0 digest) |
| `bench_server.exe` (rebuilt from `examples/bench_server.rs`) | `3ed7667f…1633` |
| `expected.json` | `version`, `newSetup`, `new` (installer), `newExe` (= packaged exe hash from E), `published200` |

The old 2.0.0-RC and 1.1.0 installers were moved to `obsolete\`.

**Bench-server failure (issue 2): root cause.**
- `bench_server.exe` started fine and printed `PORT 61989`.
- The script read the port with `((Get-Content server.out) -match 'PORT' -replace …)[0]`. With a
  one-line file, `-match` returns `$true`, not the line, so the "port" became `"T"`.
- `curl.exe -s` then failed silently with exit 3 on `http://127.0.0.1:T`, and `.Trim()` ran on
  `$null`. Reproduced here [auto].

**The fix:**
- The port is parsed with an anchored regex, with a 30 s start timeout and an "exited at start"
  check that includes stderr.
- Every request goes through `Http`, which checks curl's exit code, the HTTP status
  (2xx only), a 10 s connect / 300 s total timeout, and whether the server is still alive. Any
  failure throws a message with all of these.
- `/hash` must return 64 hex characters.
- Downloads must have the expected byte count.
- The server is stopped in `finally`.

These helpers were exercised against the real server [auto]:
- A good hash.
- A 404, reported as "curl exit 0, HTTP status '404'".
- A killed server, reported as "bench_server.exe has exited".

The first attempt also exposed that `curl` is a built-in alias in Windows PowerShell 5.1, which
shadows a function of that name; the helper is called `Http`.

**Obsolete 1.1.0 upgrade scenario removed.** The previous run also showed a script bug there: an
empty `InstallLocation` made it hash `C:\Windows\system32\agentactivationruntimestarter.exe`.

**What the script now checks** (requirements 1–12):
1. Installer SHA-256 and signature status, and the installer version.
2. Clean install: exactly one Installed Apps entry, version 2.1.0, publisher; required files
   (`opendm.exe`, `uninstall.exe`, `ffmpeg\ffmpeg.exe`, `extension\manifest.json`,
   `extension\background.js`).
3. The installed exe equals the packaged hash; exe version 2.1.0.
4. Launch with defaults; the app reports 2.1.0; the data folder is created.
5. Start from the Start-menu shortcut and from the desktop shortcut.
6. Uninstall *while the app is running*: program, entry and shortcuts are gone, no process is
   left, the data folder is kept.
7. Upgrade from the published 2.0.0:
   - Seed a completed download (a History entry), a half-finished 64 MB download and a
     non-default setting (`maxConnections = 5`), then run 2.0.0 once.
   - Install 2.1.0 silently over it.
   - Checks: same uninstall key and folder; exactly one entry; one shortcut each; at most one
     startup entry; installed exe = packaged hash and version 2.1.0; the app reports 2.1.0; 2
     items kept with History complete; the setting is kept; the half-finished download resumes
     to the server's SHA-256; the shortcuts start 2.1.0.
   - Then uninstall while running; the user's downloads and settings remain.

Safety:
- The script refuses to start if the account has OpenDM installed, running, or a data folder.
- Every deletion is under that account's own `%APPDATA%`, `%LOCALAPPDATA%` and `%USERPROFILE%`.

**Before re-running it:**
- The script keeps the data folder on purpose (it checks that uninstall keeps it), so `tedt` is
  not clean afterwards. It now refuses to start and lists exactly what to remove.
- In `tedt` only: delete `%APPDATA%\OpenDM`, `%LOCALAPPDATA%\com.opendm.app` and
  `%USERPROFILE%\odm-installer-test` if present. Then follow `README.txt`.

## H. Uninstallation

Covered by G steps 6 and 7. **Passed** on the current build, for both clean and upgraded
installs: the program, entry and shortcuts are removed; no process is left; the data is kept.

Existing policy, unchanged:
- Uninstall keeps `%APPDATA%\OpenDM`.
- The optional "delete app data" option removes only the WebView folders (`com.opendm.app`).

## I. Automated test summary

See F. All automated suites pass, except the two internet-only tests, which were not run.

## J. Remaining risks and limitations

1. **"Duplicate pairing prompt": a test-harness fault, not a product bug.**
   - What happened: `extension-test.mjs` needed Allow pressed 3 times before its browser got a
     token.
   - Cause [auto]:
     - A stub server on port 52790 with no test browser running received `/api/pair` polls every
       second from the developer's own everyday Chrome, which has the unpaired OpenDM extension
       installed.
     - That browser took the test app's single prompt slot. The test's browser got `429 busy`,
       and the script's Allow approved the developer's browser instead.
   - The product behaved as designed: one prompt at a time, one per browser.
   - This also explains the old report's "a token appeared without the script's click".
   - An earlier guess, two service-worker copies with different nonces, was **disproved**. The
     second nonce was the other browser's. The experimental extension and app changes for it
     were reverted, and both files match `277fa2c`.
   - Fix (harness only): the test runs the app and its extension on port 52796. Result: 13/13
     with one Allow.
   - Residual product limit (unchanged): the prompt does not say *which* browser is asking. With
     two unpaired browsers, a user answers whichever asked first.
2. **The installer test's resume-after-upgrade step was verified outside `tedt`.** In `tedt` it
   failed because of a harness bug, now fixed (G). Everything else passed in `tedt` on the
   current build.
3. **Unsigned installer and exe** (K).
4. **Edge** and the **"Download with OpenDM" context-menu item** are still not tested.
5. **`cargo audit`** was not run (the tool is not installed).
6. **The internet-only torrent tests** were not run.
7. **The manifest records a dirty tree.** Rebuild from the commit before handing out the build.
8. **A real Electron 1.1.0 → 2.1.0 migration** is not supported or tested (L).

## K. Unsigned installer and SmartScreen

- Both the installer and `opendm.exe` are **NotSigned**. No certificate was invented or used.
- A downloaded copy gets the Mark of the Web, so SmartScreen shows "Windows protected your PC"
  with "More info > Run anyway". Some managed or Smart App Control PCs block it outright.
- Testers should check the installer's SHA-256 against `SHA256SUMS-2.1.0.txt` before running
  it.
- Signing options and steps are unchanged from `docs/release-hardening-2026-11-08.md` G.3.

## L. Users on the Electron 1.1.0

- 2.1.0 does not upgrade 1.1.0 in place. 1.1.0 installs to `%LOCALAPPDATA%\Programs\OpenDM`
  under a GUID uninstall key; 2.1.0 uses `%LOCALAPPDATA%\OpenDM`. Installing over it would leave
  two copies.
- What to do:
  1. Quit OpenDM 1.1.0 (tray > Exit).
  2. Optional: back up `%APPDATA%\OpenDM`.
  3. Settings > Apps > Installed apps > **OpenDM 1.1.0** > Uninstall.
  4. Install `OpenDM-Setup-2.1.0.exe`.
- Data: both versions use `%APPDATA%\OpenDM`, and the 1.1.0 uninstaller is not known to delete
  it.
- **Automatic migration of 1.1.0 data was not verified for this release.** Do not promise it.
  Users should check their list and settings after installing, and expect to re-add anything
  missing.

## M. Beta-readiness

| Criterion | Status |
|---|---|
| Version consistently 2.1.0 | **Done** [auto] |
| Fresh release build succeeds | **Done** [auto] |
| Installer SHA-256 recorded | **Done**, verified in the test account |
| Installed exe matches the packaged exe | **Passed** in the test account (clean + upgrade) |
| Previous hash mismatch explained and resolved | **Done** [auto, proven, confirmed by a real install] |
| Clean install / upgrade from 2.0.0 / no duplicates / data survives / uninstall | **Passed** in the test account. Resume after upgrade passed outside it (harness bug, G) |
| Unreadable data file can no longer be overwritten | **Done** [auto] |
| Core regression tests pass | **Done** [auto] |
| Developer tools policy implemented and tested | **Done** [auto] |
| Release documentation | **Done** (this file) |

**READY FOR INTERNAL BETA**, as an unsigned build (K), once these changes are committed and the
build is rebuilt from that commit (J.7). An optional re-run of the installer test in `tedt` would
also confirm the resume step there.

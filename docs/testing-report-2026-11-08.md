# OpenDM 2.0.0: functional, performance and regression test report

Date: 2026-11-08 · Branch: `react-ui` (uncommitted work, including the earlier security-audit changes,
left in place) · Machine: AMD Ryzen AI 9 HX 370 (12C/24T), 31 GB RAM, NVMe SSD, Windows 11 Pro,
rustc 1.99.1, Node 24.20, WebView2 157.0.4341.42.

Everything below was executed on this machine. All network tests use local servers
(`src-tauri/tests/common`, `src-tauri/examples/bench_server.rs`); no internet hosts were used. The
end-to-end runs drive the **release build** (`target/release/opendm.exe`, built by `npm run dist`)
over the WebView2 DevTools protocol with scripts kept in [`scripts/qa/`](../scripts/qa), each using a
throw-away `OPENDM_DATA_DIR`.

## A. Executive summary

**Health: good on Windows.** The download engine held up against every hostile server behavior I
could build locally: wrong ranges, short bodies, stalls, 403/404/429/500, redirects, Unicode names,
crashes mid-download. Every downloaded file in every test, benchmark and stress run matched its
SHA-256: 10/10 and 60/60 files in the app, and 768/768 across the benchmark runs. The packaged app starts in about 0.8 s, idles at
about 0.5 % of one core, quits in about 50 ms, and showed no event-listener, DOM or task leaks over
hundreds of navigations, dialogs and restarts.

**Major issues found and fixed**

1. *High, data loss:* the download list was **never written to disk while three or more downloads
   ran**: the save debounce kept restarting itself. A crash during a long session lost every new
   download and all its progress.
2. *High, data loss:* the atomic JSON save **returned before the data reached the file and dropped
   write errors**. On a full disk, or at quit, a short temp file could replace a good
   `downloads.json` or `settings.json`.
3. *Medium, performance:* the History page took **2.5 s to open and used 2 GB of memory** with 5000
   finished downloads. It now opens in 0.21 s, and memory with every row mounted dropped by 1.8 GB.
4. *Medium, performance:* a single HTTP connection was capped at **~165 MB/s** by a per-piece
   round trip to the blocking pool. It is now 206 MB/s on one connection and 2–3× faster on several.
5. *Low:* importing an OpenDM JSON list stopped at the first entry with a bad address.

**Remaining risks:** BitTorrent, YouTube/yt-dlp, proxies, the extension inside a real browser,
notifications and the installer's install/uninstall were not exercised end to end. They need the
internet, a browser session or a manual check. Linux and macOS were not built. The installer is unsigned.

## B. Feature testing matrix

Evidence key: **T** = automated test in the repo (`cargo test`), **E2E** = scripted run against the
release build (`scripts/qa`), **R** = code review only.

| # | Feature | Test performed | Result | Evidence | Related files | Outstanding |
|---|---|---|---|---|---|---|
| 1 | Dashboard / Downloads list | 10 real downloads shown as complete in the DOM; 5000-item list: virtualised (24–32 DOM rows), search 14–17 ms, scroll 0 long frames | PASS | E2E `qa.mjs` | `components/downloads/*`, `stores/app.ts` | — |
| 2 | Add download by URL | `dl:add` IPC (the same call the dialog makes), Ctrl+N dialog opened/closed 100× | PARTIAL | E2E, T | `AddUrlDialog.tsx`, `manager.rs::add` | Typing into and submitting the dialog was not scripted |
| 3 | Multi-connection | Byte-identical 8-connection downloads; 8 × 64 MB and 60 × 32 MB concurrent with SHA-256 | PASS | T `engine.rs`, bench, E2E | `engine/http_download.rs` | — |
| 4 | Pause / resume / cancel / restart | 25 pause→resume cycles on one file (progress monotonic, SHA ok); stop of a waiting item | PARTIAL | E2E, T | `manager.rs` | "Redownload" and remove-with-files not exercised |
| 5 | Recovery after restart | Unclean exit with the file ahead of the saved list → resumes, SHA ok; app killed with `taskkill /F` at 13.2 MB → restored *paused* at 13.2 MB → completes, SHA ok | PASS | T `failures.rs`, E2E | `manager.rs::new`, `store.rs` | — |
| 6 | Interrupted / failed downloads | Truncated body, short body forever, stall, unreachable host, invalid URL, unwritable folder, 404/403/500 | PASS | T `failures.rs`, `robustness.rs` | `http_download.rs` | — |
| 7 | Automatic retry | 429 honours Retry-After; transient 500 retried; stalled connection times out and retries; persistent 500 gives up at the limit | PASS | T | `http_download.rs::backoff` | — |
| 8 | Queues | Queue runs items and empties; max-simultaneous respected (peak ≤ 2) | PASS | T | `queues.rs` | Queue UI page only navigated |
| 9 | Scheduling | Scheduler starts a queue at its start time | PASS | T | `queues.rs` | Stop time, periodic sync not tested |
| 10 | Speed limits, quotas | Global 2 MB/s and per-download 1 MB/s limits held; quota pauses running downloads and resumes them when lifted | PASS | T `features.rs` (new) | `engine/limiter.rs`, `manager.rs` | Bucket starts full: about 1 s of burst at the start (by design) |
| 11 | Categories | Extension → category routing (zip, MP3, pdf, mkv, none, unknown) | PASS | T `features.rs` (new) | `manager.rs::category_for_name` | — |
| 12 | History | 5000 items: open, scroll to end, hover actions, More menu, keyboard focus, day totals | PASS (after fix) | E2E `qa.mjs`, `histui.mjs` | `pages/HistoryPage.tsx` | — |
| 13 | Batch downloads | `expand_batch` patterns (numeric, padded, letters) | PARTIAL | T `util.rs` | `BatchDialog.tsx`, `util.rs` | Dialog → download flow not run |
| 14 | Import / export | — | NOT TESTED | R (bug fixed by review) | `app.rs::import_list/export_list` | Both go through native file dialogs; needs a manual check |
| 15 | Clipboard monitoring | Plain text ignored; a file URL opens "Download File Info" | PASS | E2E `qa2.mjs` | `app.rs::poll_clipboard` | — |
| 16 | LinkGrabber | Link checking, packages, deep analysis, cookie isolation, confirm to list | PASS | T `linkgrabber.rs` (6) | `linkgrabber.rs` | — |
| 17 | Site Grabber | Crawl and download, login scoping | PASS | T `grabber.rs` (2) | `grabber.rs` | — |
| 18 | HLS | Master playlist → best variant, AES-128 decryption | PASS | T `engine.rs` | `engine/hls_download.rs` | Live streams not tested |
| 19 | YouTube / video | Separate video+audio streams downloaded and merged with the bundled FFmpeg; bounded `range=` mode | PARTIAL | T `streams.rs` | `engine/muxed_download.rs`, `ytdlp.rs` | yt-dlp and YouTube need the internet |
| 20 | BitTorrent | Unit tests only (tracker lists, address detection) | NOT TESTED | T (unit) | `engine/torrent.rs` | The swarm test needs the internet (`cargo test --test torrent -- --ignored`) |
| 21 | Proxy | Proxy string parsing, env/PAC/scutil conversion | PARTIAL | T (unit) | `engine/net.rs`, `proxy_resolver.rs` | No download through a real HTTP/SOCKS proxy |
| 22 | Browser extension | Live server: 403 without header, 403 from a web origin, 200 extension ping, 401 unpaired config/download; extension JS parses; app-down fallback reviewed | PARTIAL | E2E `qa2.mjs`, T `integration.rs`, R | `integration.rs`, `extension/` | Not loaded into Chrome/Edge; pairing prompt not clicked |
| 23 | System tray | Closing the main window keeps the app alive; a second launch exits 0 and forwards to the running one | PARTIAL | E2E `qa2.mjs` | `app.rs` | Tray icon/menu clicks and window hiding not verified (WebView2 reports `visible` either way) |
| 24 | Notifications | — | NOT TESTED | — | `app.rs::notify` | OS toasts can't be observed from the scripts |
| 25 | Settings persistence | Seeded settings take effect on launch; `settings:save` applies live; 10 restarts keep the 2000-item list; JSON save path fixed and tested | PASS | E2E, T | `store.rs`, `util.rs` | — |
| 26 | Dark / light themes | `settings:save` theme → `data-theme` and body colour change (`rgb(18,19,22)` / `rgb(255,255,255)`) | PASS | E2E | `hooks/useAppearance.ts` | Visual review of every page in both themes not done |
| 27 | Startup / shutdown | Cold/warm start, quit, 10 start/quit cycles, killed-process restart | PASS | E2E | `app.rs::quit_app` | — |

## C. Functional test results

`cargo test` (`npm test`): **84 passed, 0 failed, 2 ignored** (the internet-only torrent tests):
41 unit tests, plus integration tests engine 9, failures 10 (new), features 4 (new), grabber 2,
linkgrabber 6, robustness 8 (1 new), streams 2. `npm run build` (tsc + Vite): passes.

New regression tests and what they check:

| Test | Scenario | Expected | Actual |
|---|---|---|---|
| `robustness::progress_of_several_running_downloads_is_saved_to_disk_while_they_run` | 4 slow downloads started 800 ms apart, read `downloads.json` after ~9 s | Saved progress > 0 for each | **Failed before the fix** (file never written), passes after |
| `util::json_is_complete_on_disk_when_write_json_atomic_returns` | 50 000-entry list saved 5×, read back at once | Identical | Pass (timing-dependent smoke test; the fix is from reading tokio's `File::poll_write`) |
| `failures::http_403_fails_with_the_status_in_the_error` | 403 | Fails, error names 403, not complete | Pass |
| `failures::a_transient_500_is_retried_and_the_file_is_intact` | One 500, then data | Completes, bytes identical | Pass |
| `failures::a_persistent_500_gives_up_after_the_retry_limit` | Always 500, 1 retry | Fails under 20 s | Pass |
| `failures::a_server_that_always_sends_less_than_its_content_length_is_never_marked_complete` | Content-Length 1 MB, 512 KB sent, no ranges | Never "complete" | Pass |
| `failures::a_connection_that_stalls_times_out_and_is_retried` | 16 KB then 60 s of silence, 2 s timeout | Retries, completes intact | Pass |
| `failures::an_unreachable_host_fails_with_a_useful_error` | Connection refused | Fails with a message | Pass |
| `failures::an_invalid_url_is_rejected_when_added` | `"not a url"`, `""` | `add` errors | Pass |
| `failures::a_save_folder_that_cannot_be_created_fails_instead_of_hanging` | Save folder under a file | Fails with a message | Pass |
| `failures::spaces_and_unicode_in_the_url_path_name_the_file` | `/отчёт №2 📦.bin` (percent-encoded) | File named `отчёт №2 📦.bin`, bytes identical | Pass |
| `failures::after_an_unclean_exit_the_saved_list_resumes_and_the_file_is_intact` | List snapshot older than the file, new manager over the same folder | Restored paused, resumes, bytes identical | Pass |
| `features::the_global_speed_limit_holds_across_connections` | 6 MB at 2 MB/s, 4 connections | 1.9–2.6 s (1 s burst + 2 s) | Pass |
| `features::a_per_download_speed_limit_holds` | 3 MB at 1 MB/s | 1.9–2.6 s | Pass |
| `features::the_quota_pauses_running_downloads_and_resumes_them_when_lifted` | 1 MB quota, 4 MB download | Paused with "limit" text, then completes intact | Pass |
| `features::files_go_to_the_category_for_their_extension` | 6 names | Right category each | Pass |

Already covered by existing tests and re-run: wrong 206 range → single connection, dropped
connection resumed, 429 with Retry-After, permanent 404, max simultaneous, redirects +
Content-Disposition (`réport final.bin`), numbered duplicate names, no-range servers, cookies not
following cross-host redirects, HLS AES-128, queues, scheduler.

End to end against the release build (`scripts/qa/qa.mjs`, final run):

| Scenario | Result |
|---|---|
| 10 concurrent downloads, 1–200 MB (441 MB total) | 10/10 complete, size and SHA-256 match, 0.66–0.89 s; all 10 rows show "complete" in the UI |
| 25 pause/resume cycles on a 64 MB capped download | Completed, progress never went backwards, SHA ok |
| 404 | Status `error`, message "HTTP 404 Not Found" in the list |
| Kill the process at 13.2 MB, relaunch | Restored as `paused` at 13 231 616 bytes, resumed, SHA ok |
| UI exceptions / console errors during the session | none |

Not verified: disk-full (would need a full volume; the code now surfaces the error instead of
renaming a short file), duplicate-URL prompt flow in the UI, misleading extension sniffing by MIME.

## D. Performance benchmark results

### Download engine (`download_bench`, loopback, 5 runs, MB/s median (min..max))

Workload: the real `DownloadManager` against `bench_server` in a separate process; every file
SHA-256-checked. Full table and discussion in [bench/README.md](../bench/README.md).

| Scenario | Before (64 KB pieces) | After (1 MB pieces when unlimited) |
|---|---|---|
| 20 × 1 MB, 8 conn | 147 (111..173) | 120 (116..215), overlapping, noise |
| 256 MB, 1 conn | 167 (144..186) | 206 (187..230) |
| 256 MB, 8 conn | 343 (281..393) | 708 (474..768) |
| 8 × 64 MB, 8 conn | 888 (758..1025) | 2589 (2072..2956) |
| 128 MB, no range support | 123 (113..131) | 327 (254..557) |
| 64 MB via 3 redirects | 213 (199..236), 3 runs | 338 (254..562) |
| 32 MB, server caps 4 MB/s per conn: 1 / 4 / 8 / 16 conn | 4.0 / 15.0 / 27.6 / 47.7 | 4.0 / 15.0 / 27.9 / 48.7 |

- More connections help when the server caps each one (4 → 48.7 MB/s with 16). On an uncapped
  loopback server, 8 connections beat 1 by about 3.4×. These are loopback numbers. They show the engine
  is not the limit at internet speeds; they say nothing about any real host.
- The server alone does 635–715 MB/s on one connection (curl). Receiving without writing measured
  1.7–3.1 GB/s, a blocking-pool write per chunk 321–324 MB/s, a synchronous write 0.9–1.0 GB/s.
  The remaining single-connection gap is that round trip. See section I.
- Client CPU stayed under 14 CPU-s per GB in every scenario (most under 3); peak memory 16–78 MB; executor timer
  p99 6–30 ms.
- Failure and retry rates: 0 failed files in all benchmark runs.

### Application (release build, `qa.mjs`)

| Metric | Value |
|---|---|
| Launch → window target / UI rendered, warm | 0.31–0.55 s / 0.77–1.01 s (3 warm runs per build, 4 builds) |
| Cold, first launch of a freshly built exe | 0.77–1.40 s rendered (the slow case is the first run after a rebuild, probably antivirus) |
| Quit (`app:quit` → process gone) | 44–83 ms |
| Idle CPU (10 s, % of one core) | app 0–0.5 %, app + WebView2 0–2 % |
| Idle memory | app 32–35 MB working set; app + 6 WebView2 processes 430–450 MB working set, 230–250 MB private |
| Startup with 5000 history items | 0.87–0.95 s |
| Search 5000 items (type → one row shown) | 14–17 ms |
| Page navigation (200 switches, 8 pages) | p50 12 ms, p95 118 ms, max 162 ms |

### History page with 5000 finished downloads (the optimisation)

| | Before | After |
|---|---|---|
| Open History (click → two frames) | 2476 ms (2543–2600 in other runs) | 211–302 ms |
| Rows mounted on open | 5000 | 200 (more as you scroll) |
| JS heap with all 5000 rows mounted | 362 MB | 48 MB |
| App + WebView2 private memory, all rows mounted | 2048–2482 MB | 652–827 MB |
| DOM nodes, all rows mounted | 145 227 | 95 227 |

Scrolling straight to the end of 5000 rows now mounts them in pages; doing it as fast as possible
took 11–21 s with ~41 frames over 50 ms. Normal scrolling only mounts what comes into view.

## E. Stress and endurance results (`scripts/qa/stress.mjs`, release build)

| Workload | Duration | Result |
|---|---|---|
| 60 concurrent downloads, 32 MB each, 4 conn × 128 KB/s, on top of 2000 history items | ~70 s | 60/60 complete, 60/60 SHA ok, 0 errors. UI 234–241 fps, one frame of 65 ms. App process 7–17 % of one core, app + WebView2 23–77 %; private memory 395–433 MB, flat |
| 100 failing downloads (404/403/500 mix) | < 10 s | 100/100 ended `error` with the right message, none stuck |
| 200 page navigations | ~10 s | JS listeners 438 → 399, DOM nodes 1220 → 1172 (no growth) |
| 300 New-download dialog open/close | ~95 s | 100/100 opened per round, 0 left open; listeners 256 → 467 after the first 100, then flat at 467 / 467 (one-time setup, not a leak); heap 7.1 → 7.5 MB |
| 10 start/quit cycles over the same data | ~15 s | 2000 items every time, exit code 0, quit 49–65 ms, 0 `.tmp` files left, 0 leftover processes |
| 25 pause/resume cycles | 27 s | Completed, SHA ok, JS heap 12.7 → 5.6 MB after GC |

Observed problem: in the first stress run, the navigation step found no sidebar buttons right after
the 100 failures. I could not reproduce it in the re-run (same build, same data), so I can't say
whether it was the app or the script. The same run also showed that a leftover instance makes a new
launch exit at once (single-instance hand-off). That is expected behaviour, but test scripts must
make sure no instance is running.

## F. Bugs discovered

### F1. Download list not saved while several downloads run — High (data loss)
- **Repro:** start 4 slow downloads ~1 s apart; watch `%APPDATA%\OpenDM\downloads.json`: it isn't
  written until they stop. Kill the app: the new downloads and their progress are gone.
- **Root cause:** `Store::save_after` aborted and restarted its 1 s timer on every call. Each running
  download asks for a save every 3 s, so with ≥ 3 at different phases a request arrives within
  every 1 s window and the timer never fires.
- **Fix:** keep a pending timer instead of restarting it (at most one write per delay; the data is
  read when the write runs, so it's the latest). `src-tauri/src/store.rs`.
- **Regression test:** `robustness::progress_of_several_running_downloads_is_saved_to_disk_while_they_run`
  (failed before, passes after).

### F2. Atomic JSON save could replace a good file with a short one — High (data loss)
- **Repro (by analysis):** a disk-full error or a quit immediately after a save.
- **Root cause:** `write_json_atomic` used tokio's `write_all`, which returns as soon as the write is
  *queued* on the blocking pool and holds back its error until the next operation. The file was then
  dropped and renamed over the original without waiting.
  If the write failed (disk full), `downloads.json` or `settings.json` became truncated, and
  `Store::new` then treats an unreadable list as empty. Two saves could also share one temp file name.
- **Fix:** `sync_all()` before rename (waits for the write, surfaces its error, makes the file
  durable), delete the temp file on error, unique temp name per write. `src-tauri/src/util.rs`.
- **Regression test:** `util::json_is_complete_on_disk_when_write_json_atomic_returns` (smoke test;
  a real disk-full can't be produced in a unit test).

### F3. History page slow and memory-heavy with many finished downloads — Medium (performance)
- **Repro:** 5000 completed items → click History: 2.5 s freeze, about 2 GB of memory.
- **Root cause:** every row mounted at once, each with two Radix tooltips and a dropdown menu
  (~72 KB of JS heap per row), and the day grouping copied the group array for every item (O(n²)).
- **Fix:** linear grouping (day totals still count every match); rows mount 200 at a time as the end
  scrolls into view; a row's action buttons mount only while it is hovered or focused, or while its
  menu is open. Invisible stand-in buttons keep the Tab order, and focusing one moves focus to the
  real button. `src/pages/HistoryPage.tsx`.
- **Regression check:** `scripts/qa/histui.mjs` (hover shows the buttons, menu stays open after the
  pointer leaves, Escape closes, focus lands on the real button, Tab continues, day total = 5000) and
  `histmem.mjs`. The repo has no frontend test framework, so these run against the built app rather
  than in `npm test`.

### F4. Single connection capped at ~165 MB/s — Medium (performance)
- **Root cause:** each 64 KB piece waits for a blocking-pool write (~0.4 ms round trip on the app's
  single-threaded runtime), with one write in flight.
- **Fix:** pieces up to 1 MB when no speed limit applies; limited downloads keep 64 KB so metering is
  unchanged. `src-tauri/src/engine/{mod.rs,limiter.rs,http_download.rs}`.
- **Regression coverage:** all engine/robustness/limiter tests pass; `download_bench` integrity
  checks pass for every file (see D).

### F5. JSON import stops at the first bad entry — Low
- **Root cause:** `import_list` did `break` when `add` failed (only for an invalid address), dropping
  every later entry while reporting "Imported N downloads".
- **Fix:** `continue`. `src-tauri/src/app.rs`.
- **Regression test:** none. The function sits behind a native file dialog, and the fix was not run
  end to end.

### Noted, not changed
- **Speed-limit burst (by design):** the token bucket starts full, so the first second can run at up
  to 2× the limit. Long downloads converge on the limit exactly.
- **LinkGrabber page:** the initial `lg:state` reply could in theory overwrite a newer `lg:changed`
  event that arrives first. Not observed; low.
- **Power-loss durability of file data:** download data isn't fsynced, while the list now is. After a
  power cut, the saved progress can be ahead of data that never reached the disk. A crash of the app
  alone is safe (verified in section C). Fixing it means periodic fsyncs before each save, which costs
  throughput, so it needs a decision.

No security controls were changed. The pairing and Origin checks were verified live (section B, row
22) and the security-audit changes already in the working tree were left as they were.

## G. Optimizations performed

| Change | Before | After | Measured by |
|---|---|---|---|
| History incremental rows + lazy row actions + linear grouping | open 2476 ms; 362 MB heap / 2.0–2.5 GB private at 5000 rows | open 211–302 ms; 48 MB heap / 0.65–0.83 GB private | `qa.mjs`, `histmem.mjs` |
| 1 MB write pieces when unlimited | 1 conn 167, 8 conn 343, 8 × 64 MB 888, no-range 123 MB/s | 206, 708, 2589, 327 MB/s | `download_bench`, 5 runs |

Tried and rejected: 256 KB pieces (single connection got slower: 142 MB/s median).

## H. Cross-platform build status

| Platform | Status |
|---|---|
| Windows x64: `npm run build`, `cargo test`, `tauri build` + NSIS (`npm run dist`) | **Built** (6 m 13 s first, 4 m 9 s final). `dist/OpenDM-Setup-2.0.0.exe`, 28.6 MB. One bundler warning: identifier `com.opendm.app` ends in `.app` (a macOS concern) |
| Windows: packaged app start-up | Tested from `target/release/opendm.exe`, the binary the installer packs. **Running the installer itself (install, Start menu, uninstall, extension copy) was not tested** |
| Linux (.deb, AppImage) | Not tested: no Linux environment here |
| macOS (.dmg) | Not tested: no macOS environment here |
| Browser extension (Chrome/Edge MV3) | Scripts parse (`node --check`); not loaded into a browser |

## I. Remaining work

Needs internet, other hardware, or a person:
- BitTorrent swarm test (`cargo test --test torrent -- --ignored`), YouTube / yt-dlp downloads.
- Proxies: a download through real HTTP and SOCKS5 proxies and a PAC file.
- Extension: load unpacked in Chrome/Edge, pair (Allow/Deny), capture a download, context menu,
  video panel, and behaviour with the app closed (code falls back to the browser download).
- Installer: install, upgrade over 1.1.0 (data kept), uninstall; SmartScreen; FFmpeg and extension
  copied next to the app. Code-signing is still missing.
- Tray icon menu and window hiding; Windows notifications; sounds.
- Import/export through the file dialogs (F5 fix), Add-download dialog submission, batch dialog,
  redownload, delete-with-files.
- Disk-full and read-only volume during a download.
- Linux and macOS builds (CI workflow exists, not run here).
- A light/dark visual pass over every page and window.

Engineering follow-ups:
- Single connection is still below what the disk and network allow (206 MB/s vs ~0.9 GB/s with
  synchronous writes). Keeping more than one write in flight per connection is the next step, if
  multi-gigabit LANs matter.
- A frontend test setup (none exists) would let the History checks run in `npm test`.

## J. Final assessment

| Stage | Ready? | Why |
|---|---|---|
| Development use | **Yes** | Builds clean, 84 tests pass, core download paths verified byte for byte |
| Internal testing | **Yes** | Windows release build is stable under 60 concurrent downloads, crashes and restart loops; the two data-loss bugs are fixed |
| Beta release | **Yes, Windows only, after the manual checks in I** | Core downloading is solid, but the installer flow, the extension in a real browser, torrent and YouTube haven't been run end to end |
| Production release | **No** | Unsigned installer, Linux/macOS unbuilt here, several user-facing features (torrent, YouTube, proxies, notifications, import/export) not exercised, and power-loss durability of partial files is an open decision |

# OpenDM implementation prompts (R1–R28)

One prompt per pull request, in the revised order from the review of
`docs/reverse-engineering/mdm/`. To use one:

1. Open a fresh coding-agent session in `D:\Projects\download-manager`.
2. Paste the **shared preamble** below.
3. Paste the prompt for the phase you're on.
4. Start the next phase only after the previous PR is merged, because later phases build on earlier
   ones.

Line numbers come from `release/2.1.0-windows-beta` @ `eb11ffa` and will drift as PRs land. Every
prompt tells the agent to check the code again before it trusts them.

| Phase | Items | Needs merged first |
|---|---|---|
| 1 | R1 + R2: If-Range and overlap check | — |
| 2 | R15 + R9: backups and per-item event log | 1 (logs R1/R2 events) |
| 3 | R3: partial file beside the destination | 1 |
| 4 | R4: sparse preallocation | 1, 3 |
| 5 | R5: native-messaging browser integration | — |
| 6 | R6: signed yt-dlp verification | — |
| 7 | R7: endgame racing | 1 |
| 8 | R10: headless CLI | 1 |
| 9 | R16: automation API + MCP server | 5, 8 |
| 10a–e | R8, R11, R12, R13, R14 | see each prompt |
| 11 | Tier 3/4 (R17–R28): design first | case by case |
| 12 | Release hardening | everything you shipped |

---

## Shared preamble (paste first, every time)

```markdown
# Context for this session

You are working in the OpenDM repository: a download manager with a Rust + Tauri backend in
`src-tauri/`, a React + TypeScript frontend in `src/`, and a browser extension in `extension/`.

Before any work, read:
- `docs/reverse-engineering/mdm/README.md` and `implementation-roadmap.md`. These are findings from
  studying a competitor, Mister Download Manager (MDM).
- Any sections of the other docs in that folder that the task below names.

## Hard rules
1. **Licensing.** MDM is GPL-3.0 and OpenDM is MIT. Never look up, copy or paraphrase MDM source
   code. Work only from the behaviour described in the docs, public specs and OpenDM's own code.
2. **Scope.** Implement only the items named in this task. Do not start other roadmap items, even
   where it looks convenient. Don't refactor unrelated code.
3. **Preserve behaviour.** Anything the task doesn't explicitly change must behave exactly as it does
   today. Existing `downloads.json` and settings files must keep loading: add new persisted fields
   as `#[serde(default)]` and new settings to `src-tauri/src/defaults.rs`.
4. **Dependencies.** No new crates or npm packages unless the task allows one by name. If you think
   you need one, stop and ask. Adding *features* to crates already in `Cargo.toml` (for example the
   `windows` crate) is fine. List them in your plan.
5. **Style.** Match the existing patterns: the `Rc`/`RefCell` engine on `spawn_local`, `js::`
   helpers for settings, `EngineEvent`s, the error codes in `error.rs`, and the existing component
   structure under `src/components/`.
6. **Truth over this prompt.** If the code differs from what this prompt describes, or a
   requirement looks wrong once you've read the code, stop and ask. Don't guess.
7. **Git.** Create the branch named in the task from the current release branch. Don't commit,
   push or open a PR until I approve at Checkpoint 4.

## Standard process (every task)

**Checkpoint 1: plan. STOP and wait for my approval.**
Report:
- the files, functions and line ranges you'll change
- new types, fields, settings, error codes and UI strings
- any place where this prompt's description of the code is wrong
- the test list, and which existing tests might be affected
- risks, open questions and anything you propose to leave out

**Checkpoint 2: failing tests. STOP.**
- Write the new tests and any test-harness changes first. Keep `src-tauri/tests/common/mod.rs`
  (`bench_handler`) and `bench/bench-server.js` behaving identically.
- Run `npm test` (= `cargo test --manifest-path src-tauri/Cargo.toml`). Show which new tests fail
  and confirm every existing test still passes.

**Checkpoint 3: implementation. STOP.**
Implement the task, then run all of these and report the results:
- `npm test`
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- `npm run build` (TypeScript + Vite)
- if engine code changed:
  - `cargo build --release --examples --manifest-path src-tauri/Cargo.toml`
  - `download_bench --runs 5 --json before.json` on the base branch, and `--json after.json` on
    yours, against the same server
  - a table of median MB/s per scenario. A regression over 1 % fails unless I accept it.

**Checkpoint 4: review.**
Give me:
- `git diff --stat` and the important hunks
- how old data and settings migrate
- the remaining risks
- a manual QA checklist for me
- a proposed commit message

Add one line under the item in `docs/reverse-engineering/mdm/implementation-roadmap.md` saying it
was implemented, with the branch name. Commit only after I say so.
```

---

## Phase 1: R1 + R2, resume integrity

Branch: `feat/resume-integrity`

````markdown
# Task: R1 + R2. Validator-pinned continuations and overlap verification

Read `download-engine-analysis.md` and `evidence-and-experiments.md` (E-01, E-02b, E-03a, E-03b,
E-08, E-18, E-19). Specs: RFC 9110 §13.1.5 (If-Range) and §8.8.3 (ETag, weak validators).

## Current code (check it again; line numbers are approximate)
- `src-tauri/src/engine/http_download.rs`
  - `run_worker` (~662): sends `Range: bytes={from}-` with no validator. `from = seg.pos`.
    Query-range mode branches to `run_query_worker` (~568).
  - Response handling (~815–910): the first response stores `it.etag` / `it.last_modified`.
    - Later 206s are compared:
      `size_changed || (!ignore_mod && (etag_changed || mod_changed))`.
    - On a change it cancels the other workers, resets to one segment, and calls
      `set_len(fh, 0)`. That's a silent truncation, and removing it is the point of R1.
    - `if st == 200 || bad_range` treats a 200 as "server ignored Range" and goes to
      `restart_non_resumable`, which also truncates.
  - ~739: a non-resumable mid-stream error does `set_len(0)`. Leave this alone: it's correct for
    servers that can't resume.
  - `open_file` (~212): `reconcile(segs, file_len)` resumes only from durable data.
  - Finalize (~330): checks the file length against the expected size.
- `src-tauri/src/item.rs`: the persisted item (`etag`, `last_modified`, `segments`, …).
- The `downloads.ignoreModTimeChanges` setting already exists. Respect it.

## R1 requirements
1. Every continuation request (`from > 0`) in normal Range mode sends `If-Range` when a usable
   validator is known. Query-range mode is excluded (R2 only):
   - Prefer a strong ETag.
   - Never put a weak ETag (`W/"…"`) in If-Range.
   - Otherwise use Last-Modified.
   - Otherwise send no If-Range (today's behaviour).
   - If `ignoreModTimeChanges` is on, send no If-Range at all. Today that setting already ignores
     both ETag and Last-Modified changes.
   - Put the header logic in one helper. Phase 7 (endgame racing) will reuse it.
2. Store `etag_host`: the final host, after redirects, that issued the stored ETag.
   - Send ETag-based If-Range, or compare ETags, only when the current final host matches
     `etag_host`.
   - For a different host, use Last-Modified + size instead.
3. Handle a 200 response carefully:
   - A 200 to an If-Range request whose validators **differ** from the stored ones means "file
     changed".
   - A 200 with the **same** or no validators to an If-Range request: retry once without If-Range
     (remember that for this item for the rest of the session). Go to the existing no-range path only
     if that retry also returns 200.
   - Items saved before this change have no `etag_host`. Don't send or compare their ETag; use
     Last-Modified + size. If a later 206 returns the same ETag, record that host as `etag_host`.
4. A detected change must not truncate. Instead:
   - Stop all workers. Keep the temp file and segment positions exactly as they are, and persist
     them.
   - Set error code `ECHANGED` with the message "File changed on the server".
   - Offer two actions:
     - **Restart**: discard the partial and start over. This is today's behaviour, now done only
       when the user asks.
     - **Keep partial** (`dl:keepPartial`): move the item from error to paused with the status
       "File changed on the server — partial kept". The temp file and positions stay. A later
       Resume checks again with one request, and if the file is still changed it returns to
       `ECHANGED`. It never restarts automatically.
   - New setting `downloads.autoRestartOnChange` (default `false`) restores today's automatic
     restart for unattended queues. Put it in `defaults.rs` and in the Settings UI next to
     `ignoreModTimeChanges`.
5. Frontend: show the error and both actions on the item, following existing patterns.

## R2 requirements
1. When `from > seg.start`, set `K = min(64, from − seg.start)` and request from `from − K`.
2. Compare the first K bytes of the response with K bytes read from the temp file at `from − K`.
   Add a positional `read_at` next to `write_at` in `engine/mod.rs` if there isn't one.
3. On a match: discard those K bytes. Don't write them and don't count them toward progress or
   speed. Then continue as normal.
4. On a mismatch: rewind only that segment (`pos = start`) and retry it. A second mismatch on the
   same segment in the same session goes to `ECHANGED`. No loops.
5. Progress never counts overlap bytes. It never goes above 100 %, and it only goes backwards on an
   explicit rewind.

## Test harness additions
- `?etag=<v>`, with a version that can change mid-test (a shared atomic, or `/versioned/…`).
- `?weaketag`.
- If-Range handling: when If-Range doesn't match, answer `200` with the full body.
- `?ignoreifrange`: always honour Range.
- `?etagbyhost`: a different ETag per Host header.
- A request log the tests can inspect.

## Tests
- `robustness.rs`
  - a. ETag changes mid-download → `ECHANGED`; temp file length and segment positions are
    unchanged.
  - b. Same as (a) with `autoRestartOnChange` on → completes with the correct SHA-256.
  - c. The server ignores If-Range → completes, SHA-256 OK.
  - d. Weak ETag → it is never sent in If-Range; Last-Modified is used instead.
  - e. Different ETags per host → no false `ECHANGED`.
  - f. Every continuation carries If-Range when a strong validator is known.
- `durability.rs`
  - g. Corrupt 16 bytes just before a segment cursor, then resume → that segment is rewound,
    SHA-256 OK.
  - h. The same corruption twice → `ECHANGED`, no loop.
  - i. Final `downloaded` equals the file size exactly.
- j. `?ifrange200` (a 200 to any If-Range request) → retry without If-Range, then completes
  multi-connection, SHA-256 OK.
- k. A legacy item with no `etag_host` → resumes using Last-Modified + size, with no false
  `ECHANGED`.
- A query-range version of (g). Query mode gets the R2 overlap check only, no If-Range.

## Acceptance
- No resumable partial is truncated because of a validator change, unless the user chooses
  Restart or the setting is on.
- Weak ETags are never used in If-Range.
- The corrupt-overlap tests pass.
- Throughput stays within 1 %.
- No new crates.
````

---

## Phase 2: R15 + R9, backups and per-item event log

Branch: `feat/backups-and-item-log`

````markdown
# Task: R15 (rotating backups of persisted JSON) + R9 (per-item event log)

Read `filesystem-and-persistence.md` (E-24, E-25).

## Current code
- `src-tauri/src/store.rs`: `save` / `save_after` (debounced), `write`, `flush`, `flush_all`, and
  `NAMES` (the persisted files, `downloads` among them).
- `src-tauri/src/util.rs` `write_json_atomic` (~376): writes a unique temp file, runs `sync_all`,
  then renames over the target. There is only one copy.
- `read_json` (~410) returns `None` on a parse error. Find out what the store does on load when that
  happens (probably starts empty) and report it at Checkpoint 1.

## R15 requirements
1. Rotate backups: `<file>.bak`, `<file>.1.bak`, `<file>.2.bak`.
   - **Don't rotate on every save.** Downloads are checkpointed every ~2 s, and rotating each time
     would churn the disk and leave all three backups seconds apart, which makes them useless.
   - Rotate (a) once after a successful load at startup, (b) at most once every
     `storage.backupIntervalMin` minutes (default 10) during a save, and (c) on a clean shutdown in
     `flush_all`.
   - Only a file that parsed successfully may become a backup.
2. On load, if the main file is missing or fails to parse, try `.bak`, then `.1.bak`, then
   `.2.bak`, and use the first that parses.
   - Rename the broken file to `<file>.corrupt-<unix-ms>` so it's kept for diagnosis.
   - Log it, and send a one-time UI notice: "Your download list was restored from a backup".
   - If all copies fail, start empty as today, but keep every broken file.
3. Apply this to every name in `NAMES`. The settings file holds credentials, so backups must get the
   same owner-only permissions as the main file (see the `#[cfg(unix)]` block in
   `write_json_atomic`).

## R9 requirements
1. Add `log: Vec<LogEntry>` to the item, where `LogEntry { ts_ms, kind, text }`.
   - It's a ring buffer of the last 50 entries. Truncate `text` to 300 characters.
   - Persist it with `#[serde(default)]`.
2. Events to record:
   - added (source: UI, browser, CLI, queue)
   - started or resumed
   - connected (final URL host, HTTP status, size, range support, and remote IP if the network
     layer exposes it; don't build new plumbing for it here)
   - each retry, with its reason and delay
   - R1 `ECHANGED` and R2 overlap-mismatch rewinds
   - connection count reduced (429/503)
   - paused or stopped, and by whom
   - completed (size, duration) or failed (error code and message)
3. Record entries through one helper so engines can't format them inconsistently. Make it cheap,
   with no allocation on the hot data path.
4. Frontend: add a "Log" section or tab to the existing Properties dialog with the timestamp, kind
   and text, newest last, and a "Copy log" button.

## Tests
- Corrupt `downloads.json` → loads from `.bak`, the corrupt copy is kept, and a notice is raised.
- All three backups corrupt → starts empty and keeps the files.
- 100 saves in quick succession → at most one rotation.
- A 503-flaky download logs the retry reasons. An `ECHANGED` item logs why.
- The log survives a restart and is capped at 50 entries.
- Backup files have the same permissions as the main file (Unix test, `#[cfg(unix)]`).

## Acceptance
- A corrupted list recovers automatically.
- Retry and validator reasons can be seen in Properties.
- No measurable change in save time or throughput.
````

---

## Phase 3: R3, partial file beside the destination

Branch: `feat/partial-beside-destination`

````markdown
# Task: R3. Write the partial file on the destination volume

Read `filesystem-and-persistence.md` and `performance-analysis.md` (E-02, E-23).

## Current code
- `manager.rs` ~493: `temp_dir = setting saveTo.tempDir`. The default in `defaults.rs` ~81 is
  `%TEMP%\OpenDM`.
- `manager.rs` ~523: `temp_path = <temp_dir>\<id>_<file_name>`.
- `util.rs` `move_file` (~416): tries `rename`. On EXDEV it uses `tokio::fs::copy` and then
  `remove_file`, with **no `sync_all` on the destination before deleting the source**. Fix this
  whatever else you change.
- Find every place that reads or removes `temp_path`: remove, cancel, restart, overwrite, rename,
  move, the "open folder" actions, and cleanup at startup. List them at Checkpoint 1.

## Requirements
1. New setting `saveTo.partialLocation`: `"auto"` (default), `"beside"` or `"tempDir"`.
   - `beside`: `<dest_dir>\.<file_name>.<id8>.opendm-part`. The id fragment prevents collisions
     between two downloads with the same name. On Windows, set the hidden attribute
     (`SetFileAttributesW`, via the existing `windows` crate plus the needed features).
   - `tempDir`: today's behaviour.
   - `auto`: `beside`, except when the destination is in a cloud-synced folder. Detect these:
     - paths under the `OneDrive`, `OneDriveConsumer` or `OneDriveCommercial` environment folders
     - any folder whose attributes include `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`,
       `FILE_ATTRIBUTE_RECALL_ON_OPEN` or `FILE_ATTRIBUTE_PINNED`/`UNPINNED`
     - a user list in `saveTo.syncedFolders` (for Dropbox, Google Drive and others)

     In a synced folder, use `tempDir`, because sync clients upload and lock partial files.
2. **Existing items keep their current `temp_path`.** Don't migrate in-flight downloads. The new
   location applies only to newly added items.
3. Completion is an atomic rename when the volumes match. When a copy is still needed: copy, run
   `sync_all` on the destination, rename it into place if a temp name was used, and only then delete
   the source.
4. If the user changes the folder or file name of a queued or paused item that has a partial, move
   the partial with the fixed `move_file`. For a running item, either do the same safely or block the
   change with a clear message. Pick one and justify it at Checkpoint 1.
5. Remove, cancel and Restart delete the partial wherever it is. Startup cleanup must never delete a
   `.opendm-part` file that an item still references, and must not scan users' folders. Only touch
   paths that items reference.
6. Check that the destination folder is writable when the download *starts*, not at completion.
7. Hide `.opendm-part` files from the app's own "open file" actions and file pickers.

## Tests
- Same volume: completion is a rename, verified by inode or file ID where available, or by timing.
- Cross volume (simulate with the `tempDir` mode and a mocked EXDEV if needed): `sync_all` happens
  before the source is deleted. Inject a failure between copy and delete → no data loss.
- Two items with the same name in the same folder → no collision.
- Remove, cancel and restart leave no orphaned partials (E2E suite).
- Folder change on a paused item → the partial moves and the download resumes, SHA-256 OK.
- `auto` in a fake synced folder (env var override in the test) → uses tempDir.
- Old items with `%TEMP%` paths still resume.

## Benchmark
`huge-2GB-8conn` saving to a second drive, with the old default vs `beside`. Measure the time from
100 % to Complete. Target: under 100 ms regardless of size.

## Acceptance
- O(1) completion on the same volume.
- No orphaned partials.
- No partials written into synced folders when the setting is `auto`.
- In-flight items are untouched.
````

---

## Phase 4: R4, sparse preallocation

Branch: `feat/sparse-preallocation`. **Requires Phase 1 (R2) and Phase 3 to be merged.**

````markdown
# Task: R4. Sparse preallocation with a truncation check

Read `filesystem-and-persistence.md` (E-02, E-20). The NTFS zero-fill cost is *inferred*, not
measured. **Step 0 is to measure it.**

## Why this is risky
Today the temp file's length tracks how much was really written. Two safety checks depend on that:
- `open_file` → `reconcile(segs, file_len)` clamps resume points to the file's length
- finalize (~330) fails with "The file is incomplete" when the length is short

Once the file is created at full size, both checks always pass. R2's overlap check (Phase 1) and
the durable segment checkpoints become the only protection. You must **replace** those length
checks, not delete them.

## Step 0: measure first (report at Checkpoint 1)
Add a bench scenario: a 2 GB file, 8 connections, where the last segment is written first. Record
the maximum and p99 duration of single `write_at` calls on NTFS without preallocation. If no write
takes more than 50 ms, report that and **stop**. R4 may not be worth doing.

## Requirements (only if Step 0 shows stalls)
1. When the size is known and the server supports ranges, preallocate before the first write:
   - Check whether the volume supports sparse files (`GetVolumeInformationW` →
     `FILE_SUPPORTS_SPARSE_FILES`).
   - If it does: `FSCTL_SET_SPARSE` (`DeviceIoControl`), then `set_len(size)`.
   - If it doesn't (FAT32, exFAT, some network shares): skip preallocation by default. A full
     `set_len` there zero-fills the whole file. Add setting `connection.preallocateNonSparse`,
     default off.
   - Add the needed `windows` crate features (e.g. `Win32_System_Ioctl`, `Win32_Storage_FileSystem`,
     `Win32_System_IO`). Non-Windows: plain `set_len`.
2. Check free space before allocating (`GetDiskFreeSpaceExW` / `statvfs`). If the free space is less
   than the remaining bytes, fail early with `ENOSPC` and a clear message. Sparse allocation doesn't
   reserve space, so this check is the early warning.
3. Add an item field `preallocated: bool`. When it's true:
   - Finalize checks completion with segment accounting (every segment has `pos >= end`) instead of
     file length. Keep the length check for non-preallocated files.
   - On resume, a file length **smaller** than `size` means the file was truncated: rewind every
     segment beyond the length. A length **larger** than `size` is an error.
4. Sparse files must not mislead users. A completed file is the same as a normal one, so verify that
   Explorer shows the correct size on disk after completion (report what you observe).

## Tests
- A truncated preallocated temp file → segments past the length are rewound, SHA-256 OK.
- Finalize on a preallocated file with an unfinished segment → error, not a false Complete.
- A volume without sparse support (mock the capability check) → no preallocation by default.
- Not enough free space (mock) → `ENOSPC` before any bytes are fetched.
- Every Phase 1 durability test still passes with preallocation on.

## Acceptance
- No write call over 50 ms caused by zero-fill in the 2 GB bench.
- No completion check that is weaker than today's.
````

---

## Phase 5: R5, native-messaging browser integration

Branch: `feat/native-messaging`

````markdown
# Task: R5. Browser integration through native messaging (keep HTTP as a fallback)

Read `advanced-features.md` (the browser section, S-10, S-12) and `network-analysis.md`.

## Current code
- `extension/background.js`: `DEFAULT_PORT = 52790`. It `fetch`es `http://127.0.0.1:<port>/api/…`
  with a pairing flow (`/api/pair` with a nonce) and the `X-OpenDM-Token` header.
- `extension/manifest.json`: MV3. Permissions include `downloads`, `cookies`, `webRequest`, …. It has
  no `nativeMessaging` and no `key`, so the extension ID isn't stable for unpacked installs.
- `src-tauri/src/integration.rs`: the HTTP server (`start(port, handler)`), `load_token`, pairing
  state, and the request router in `handle()`.
- Known failure: on the maintainer's PC, port 52790 falls inside a Windows excluded port range
  (`netsh int ipv4 show excludedportrange protocol=tcp`), so integration fails.

## Requirements
1. **Host binary** `opendm-nmhost` (a new `[[bin]]` in `src-tauri`, console subsystem, std +
   serde_json + what's already in the tree):
   - Speaks the native-messaging protocol on stdin/stdout: a 4-byte native-endian length, then UTF-8
     JSON. Host→browser messages are capped at 1 MB.
   - On each message: read `{port, token, pid}` from `%APPDATA%\OpenDM\ipc.json`, forward the request
     to the app's local HTTP API with the token, and return the response.
   - If the app isn't running (no file, stale pid, or connection refused), start it hidden with
     `--hidden`, wait up to 10 s for `ipc.json` to update, then forward.
   - Never log the token. Write nothing to stdout except protocol frames.
2. **App side:**
   - Choose the integration port at runtime. Try the configured port first; if it fails to bind (for
     example an excluded range), use an OS-assigned free port.
   - Write `ipc.json` (port, token, pid) atomically with owner-only permissions, and remove it on a
     clean exit.
   - The fixed-port HTTP path keeps working for existing installs.
3. **Registration** (per user, no admin rights): write `com.opendm.host.json` next to the host exe
   with:
   - Chrome/Edge: `allowed_origins: ["chrome-extension://<ID>/"]`
   - Firefox: a separate manifest with `allowed_extensions: ["<gecko id>"]`

   Register it under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opendm.host`,
   `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\…` and
   `HKCU\Software\Mozilla\NativeMessagingHosts\…` (Brave and Vivaldi read the Chrome key; confirm
   this and report). Do it in the installer **and** re-check it at app startup, so a moved install
   repairs itself. Find out which installer Tauri is configured with (NSIS or WiX) and report.
4. **Extension:**
   - Add the `nativeMessaging` permission and a `key` to the manifest for a stable ID. Generate a new
     key and tell me where you stored the private part. Don't commit a private key.
   - Transport order: `chrome.runtime.connectNative` first, then the existing HTTP + pairing path.
   - Native messaging needs no pairing prompt, because the browser restricts which extension can
     call the host.
   - Show the active transport on the options page.
5. Security:
   - The host only accepts messages that map to existing API routes. No arbitrary URLs or paths to
     the local server.
   - The app treats native-messaging requests exactly like paired HTTP requests (same handlers, same
     validation).

## Tests
- Rust unit tests for frame encoding and decoding: lengths, the 1 MB cap, partial reads.
- Host integration test: spawn the host with piped stdio and a fake `ipc.json` pointing at a test
  server → round trip.
- App not running → the host starts a stub (inject the command in tests) and waits.
- Port fallback: occupy the configured port → the app binds another and `ipc.json` records it.
- `scripts/qa/extension-test.mjs` variant: register the host in a test profile, kill the app, click
  a download link → the app starts and receives the download.

## Acceptance
- Integration works with port 52790 blocked and with the app not running.
- Existing paired installs keep working.
- No admin rights needed.
````

---

## Phase 6: R6, signed yt-dlp verification

Branch: `feat/ytdlp-signature`

````markdown
# Task: R6. Verify yt-dlp's checksum list against the yt-dlp signing key

Read `advanced-features.md` (S-08, S-14).

## Current code
`src-tauri/src/engine/ytdlp.rs`: downloads the binary and `SHA2-256SUMS` from the same release
(~72) and compares hashes (~93). If the release or mirror is compromised, both files are wrong
together, so this check proves nothing.

## Step 0 (report at Checkpoint 1)
From the official yt-dlp repository and release assets, confirm:
- the exact signature file name (expected `SHA2-256SUMS.sig`, a detached OpenPGP signature)
- where the official public key is published, and its fingerprint
- whether the key has rotated in the past

Show me the fingerprint so I can confirm it independently before you embed it.

## Requirements
1. Embed the public key in the app (`src-tauri/resources/` or `include_bytes!`), with a comment
   giving its fingerprint and source URL.
2. Download `SHA2-256SUMS.sig`. Verify the signature over the exact bytes of `SHA2-256SUMS` *before*
   parsing it. Then check the binary's hash as today.
3. **New dependency allowed:** one small, maintained, verify-only OpenPGP crate. Propose it at
   Checkpoint 1 with its size, licence (must be MIT/Apache-compatible) and maintenance status.
   Prefer `default-features = false`.
4. Fail closed. A missing signature, bad signature or wrong key means the binary isn't installed or
   updated, and the user sees a clear message.
   - Keep any previously verified binary working.
   - No silent fallback to checksum-only.
   - Add `media.allowUnsignedYtdlp` (default `false`, a hidden or advanced setting) for people who
     build yt-dlp themselves. When it's on, the UI shows a warning.
5. Write a short `docs/security/ytdlp-key-rotation.md`: how to update the embedded key, and what
   users see when it rotates.
6. If OpenDM also downloads other executables (ffmpeg, gallery-dl or others; check
   `scripts/verify-ffmpeg.js` and the engine), list how each is verified today at Checkpoint 1. Don't
   change them in this task.

## Tests
- A known-good fixture (a real SUMS + .sig pair checked into `tests/fixtures`) → passes.
- A tampered SUMS → refused. A wrong signature → refused. A missing `.sig` → refused.
- A previously installed binary stays usable after a failed update.

## Acceptance
- Only a SUMS file signed with the embedded key can lead to an executable being installed.
````

---

## Phase 7: R7, endgame racing

Branch: `feat/endgame-racing`. **Requires Phase 1.**

````markdown
# Task: R7. Duplicate the slowest tail range when connections are idle

Read `download-engine-analysis.md` (E-01) and `performance-analysis.md`.

## Current code
`http_download.rs` ~421–450: splitting uses `connection.minSegmentKB` (default 256) and
`min_split = max(64 KiB, minSegmentKB)`. A segment is split only if `rem >= 2 * min_split`. Near the
end, one slow connection finishes alone while the others sit idle.

## Requirements
1. Enter endgame only when **all** of these are true:
   - total remaining < `2 * min_split * active_connections`
   - at least one connection is idle
   - the server isn't in adaptive back-off (no recent 429/503 reduction)
   - the item is resumable with a known size
2. In endgame, pick the owned range with the latest estimated finish time (remaining bytes divided by
   that connection's recent speed). Start a duplicate request on an idle connection, beginning at
   that range's current position + 64 KiB lookahead.
   - At most one duplicate per range.
   - At most `connection.endgameMaxDuplicates` duplicates in total (default 2).
   - Duplicates use the Phase 1 If-Range helper and R2's overlap check.
3. Writing and accounting:
   - Both writers write the same bytes to the same offsets. That's safe *only because* If-Range pins
     the file version.
   - Track a per-range high-water mark. Progress counts each byte once.
   - When one writer reaches the other's position, abort the slower one.
   - The checkpoint records only durable positions, as today.
4. Setting `connection.endgame` (default on), so users can turn it off.
5. Log entering endgame and each duplicate start or abort to the R9 item log.

## Test harness
Add `?slowrange=<start>-<end>:<KBps>` to throttle requests that start inside a byte range.

## Tests
- A throttled tail → total time drops by at least 50 % compared with endgame off, SHA-256 OK.
- Progress never goes above 100 % and is monotonic. Final `downloaded == size`.
- A server that returns 429 during endgame → endgame stops and no extra requests are opened.
- Small file (< 2 × min_split) → no extra requests compared with today (protects OpenDM's lead in
  polite segmentation).

## Acceptance
- A tail-latency bench scenario shows the gain.
- No throughput regression in the other scenarios.
- No change to the number of requests on small files.
````

---

## Phase 8: R10, headless CLI

Branch: `feat/headless-cli`. **Requires Phase 1.**

````markdown
# Task: R10. A headless CLI that reuses the real engine, with NDJSON output

Read `advanced-features.md` (S-07, S-08).

## Current code
- `src-tauri/src/cli.rs` parses IDM-style switches (`/d`, `/p`, `/f`, `/a`, `/n`, `/q`, `/s`, …) and
  forwards them to the GUI. **Keep this exactly as it is.**
- `src-tauri/examples/download_bench.rs` already drives `DownloadManager` without the GUI. Use it as
  the reference for headless setup.
- Release builds probably use the Windows GUI subsystem, so `println!` from the main exe goes
  nowhere. Confirm this.

## Requirements
1. A new `[[bin]] opendm-cli` (console subsystem) that links `opendm_lib`. Ship it next to the main
   exe.
2. Commands:
   - `opendm-cli get <url>... [-o DIR] [-n NAME] [-c CONNECTIONS] [--checksum ALGO:HEX]`
     `[--header K:V]... [--json]`
   - `opendm-cli resume <partial-or-sidecar>`. Resume a download this CLI started, using a small
     sidecar `<partial>.opendm.json` (URL, validators, segments) next to the partial.
   - `opendm-cli --version`, `opendm-cli --help`
3. **State isolation.** The CLI must never read or write the GUI's `downloads.json` and settings. It
   uses its own state directory (`%APPDATA%\OpenDM\cli\`) and engine defaults. It may *read* the
   GUI's proxy and connection settings with `--use-app-settings`. Sending a URL to the running GUI is
   Phase 9's job, not this task's.
4. Output:
   - Default: a human-readable progress line on stderr.
   - `--json`: NDJSON on stdout, one object per event:
     `{"event":"meta"|"progress"|"retry"|"complete"|"error", ...}`, with a stable schema.
     Document it in `docs/cli.md`.
5. Exit codes: 0 success; 1 download failed; 2 usage error; 3 checksum mismatch; 4 `ECHANGED`;
   130 interrupted. Ctrl+C checkpoints and exits so `resume` works.
6. If Phase 10b (checksum) hasn't merged yet, implement `--checksum` with SHA-256 only, using
   whatever hash crate the tests already use.

## Tests
- CI: `opendm-cli get` against the test server → file SHA-256 OK, exit code 0.
- 404 → exit 1 with an NDJSON error event.
- Ctrl+C (send the signal in the test), then `resume` → completes, SHA-256 OK.
- The GUI's `downloads.json` is untouched (hash it before and after).
- Snapshot test of the NDJSON event schema.

## Acceptance
- Scripts and CI have a supported, documented entry point.
- Existing IDM switches behave the same.
````

---

## Phase 9: R16, automation API + MCP server

Branch: `feat/automation-api-mcp`. **Requires Phases 5 and 8.**

````markdown
# Task: R16. An opt-in local automation API and a stdio MCP server

Read `advanced-features.md` (S-09: the API and MCP section).

## Current code
- `integration.rs`: the local HTTP server, browser token, pairing and router.
- Phase 5 added `ipc.json` (port, token, pid). Phase 8 added `opendm-cli`.

## Requirements
1. **API** (off by default, setting `automation.enabled`):
   - Routes under `/api/v1/` on the existing integration server. Only bind to `127.0.0.1`, never to
     the LAN.
   - A **separate** automation token: `automation-token.json`, owner-only. The browser token must not
     grant API access. The user can regenerate the token in Settings.
   - Endpoints:
     - `GET downloads` (filter by status)
     - `GET downloads/{id}` (including the R9 log)
     - `POST downloads` (url, dir, name, queue, start)
     - `POST downloads/{id}/pause|resume`
     - `DELETE downloads` with a body `{ids:[...], deleteFiles:false}`
     - `GET queues`, `POST queues/{id}/start|stop`
   - Destructive calls need an explicit id list. No "all" wildcard. `deleteFiles` defaults to false.
   - Validate everything: URL schemes (http/https/ftp/magnet), save paths (absolute, existing or
     creatable, no device paths), body size limits.
   - Rate-limit requests, and write an audit line to the app log for each mutating call.
2. **CLI integration:** `opendm-cli send <url>` posts to the running app through the API, using
   `ipc.json` and the automation token. If automation is off, it says how to enable it.
3. **MCP server** `opendm-mcp` (new `[[bin]]`, stdio JSON-RPC):
   - Prefer a small hand-written implementation of `initialize`, `tools/list` and `tools/call`
     against the current MCP spec version. If you want an MCP SDK crate, ask first.
   - It talks only to `/api/v1`.
   - Tools:
     - `list_downloads`, `get_download`: `readOnlyHint: true`
     - `add_download`
     - `pause_downloads`, `resume_downloads`: `idempotentHint: true`
     - `remove_downloads`: `destructiveHint: true`, requires `ids`, `delete_files` defaults to false
   - Clear errors when the app isn't running or automation is off.
   - Write `docs/mcp.md` with a config snippet for Claude Desktop / Claude Code.
4. Settings UI: an "Automation" section with the enable toggle, the token (show, copy, regenerate),
   and a warning that local programs with the token can control downloads.

## Tests
- API disabled → 404 or 403 on every `/api/v1` route.
- The browser token → 401 on `/api/v1`.
- `DELETE` without ids → 400. With ids → removes only those, and files are kept by default.
- MCP: a `tools/list` snapshot (names, schemas, annotations). A `tools/call` round trip against a
  test app.
- Path-traversal and bad-scheme inputs are rejected.

## Acceptance
- Off by default.
- No LAN exposure.
- Destructive actions are explicit and auditable.
- MCP works with a standard client.
````

---

## Phase 10: UX and torrent features (any order)

### 10a: R8, start downloading while the confirm dialog is open

Branch: `feat/predownload-on-confirm`. **Requires Phases 1 and 3.**

````markdown
# Task: R8. Keep the probe request streaming while the New Download dialog is open

Read `advanced-features.md` and `evidence-and-experiments.md` (E-23: MDM finished a 200 MB file
before the user confirmed).

## Requirements
1. Setting `downloads.predownload` (default **off** for now).
2. When the New Download window opens and the probe gets a resumable 206 or a 200 with a known
   size, keep streaming into a partial in the *default* folder (Phase 3 naming). Cap it at
   `downloads.predownloadMaxMB` (default 50). Don't open extra connections before confirm.
3. On confirm with the same folder and name: adopt the partial and its segment as connection 0, and
   don't send a new request for the bytes already received.
   - Changed folder or name: move the partial with `move_file`.
   - Cancel, window closed or app exit: delete the partial and abort the request.
4. Never pre-download when the dialog shows a warning: duplicate file, dangerous file type, or an
   auth prompt.
5. Log it to the R9 item log.

## Tests
- Confirm after 5 s on a 50 MB file → completes, the server sees no new request for bytes 0..N.
- Cancel → no file left.
- Folder change → the partial moves, SHA-256 OK.
- Cap reached → streaming pauses, and resumes on confirm.

## Acceptance
- No orphaned files.
- No extra requests.
- Off by default.
````

### 10b: R11, checksums on add and Verify checksum

Branch: `feat/checksums`

````markdown
# Task: R11. Optional checksum on add, an automatic Repr-Digest check, and "Verify checksum…"

Read `advanced-features.md` (S-08, U-32).

## Requirements
1. Algorithms: SHA-256 (required) and SHA-512, SHA-1, MD5, CRC32 (for legacy sites).
   - Check `Cargo.toml` first and use hash crates already present.
   - Allowed new crates if missing: RustCrypto `sha2`, `sha1`, `md-5`, and `crc32fast`. List exactly
     which ones you'd add.
2. Add dialog and Properties: an optional "Checksum" field that accepts `algo:hex`, or bare hex with
   the algorithm guessed from its length.
3. If the server sends `Repr-Digest` or `Digest` (RFC 9530) for the full representation (not a
   range), record it and verify it automatically.
4. Hash after completion in a blocking task with progress, without blocking the engine thread.
   - Item state `verifying` → `verified` (badge) or `ECHECKSUM` (error; **keep the file**).
5. Context-menu action "Verify checksum…" for completed items. It also computes and shows all
   hashes for copying.
6. Log the result to the R9 item log. The Phase 8 CLI `--checksum` uses the same code.

## Tests
- Right hash → verified. Wrong hash → `ECHECKSUM`, file kept.
- `Repr-Digest` on a full 200 → verified automatically. On a 206 → ignored.
- Hashing a 2 GB file doesn't stall the UI or other downloads.

## Acceptance
- Hashes are opt-in, except when the server provides a digest.
- No file is deleted on a mismatch.
````

### 10c: R12, server info

Branch: `feat/server-info`

````markdown
# Task: R12. Record and show server info (IP, connect time, whether a proxy was used)

## Requirements
1. Find out how `engine/net.rs` makes requests (reqwest or custom) and whether the peer address is
   available. Report at Checkpoint 1. If it isn't exposed, propose the smallest change.
2. On the first response, record `remote_ip`, `connect_ms`, `tls` (true/false), `proxied`
   (true/false) and the final host on the item (`#[serde(default)]`).
3. Show them in Properties, and in the R9 "connected" log entry.
4. Don't add a country lookup or offline geo database.

## Tests
- A finished item in the test server has `remote_ip == 127.0.0.1`.
- A proxied request (see `tests/proxy.rs`) → `proxied == true`.

## Acceptance
- Properties shows the IP for finished items.
- No new dependencies.
````

### 10d: R13, per-column filters

Branch: `feat/column-filters`

````markdown
# Task: R13. Per-column filters in the download list

Read `ui-ux-analysis.md` (U-01 and screenshots).

## Current code
Find the download list component under `src/components/downloads/` and the existing column chooser
and search.

## Requirements
1. A filter button on each filterable column header:
   - Status: multi-select
   - Type/category: multi-select
   - Size: min/max with units
   - Added and Completed dates: presets (today, 7 days, 30 days) plus a custom range
   - Name/URL: contains
2. Filters combine (AND) with each other and with the existing search. An active filter highlights
   its header. "Clear all filters" appears when any filter is active.
3. Remember filters per list view in existing UI state storage. Keep it frontend-only and use no new
   npm packages.
4. Accessibility: keyboard reachable, `aria-expanded` and labels, Esc closes, focus returns to the
   header button.
5. Performance: filtering 10,000 items stays under 16 ms per keystroke. Memoize and debounce text
   input.

## Tests
- Add frontend tests if the project has a test runner. If it doesn't, say so at Checkpoint 1 and
  propose a manual QA script instead of adding a framework.

## Acceptance
- Filters combine correctly.
- Clear resets everything.
- No lag at 10k items.
````

### 10e: R14, torrent sequential mode and IP blocklist

Branch: `feat/torrent-sequential-blocklist`

````markdown
# Task: R14. A "download in order" option and an IP blocklist for torrents

Read `advanced-features.md` (U-24, U-25).

## Current code
`src-tauri/src/engine/torrent.rs`, plus the **vendored** `librqbit` in `src-tauri/vendor/librqbit`,
patched for MSE/PE and PEX (see `Cargo.toml` `[patch]`).

## Step 0 (report at Checkpoint 1)
Check whether the vendored librqbit version supports:
- sequential or prioritised piece selection
- peer IP filtering

Name the exact APIs. If one isn't supported, estimate the size of a patch to the vendored crate and
**stop for my decision**. Don't patch it without approval.

## Requirements (for each supported feature)
1. Sequential: a "Download in order" checkbox in Add Torrent and Properties, stored per item.
2. Blocklist:
   - A setting with a URL (P2P/DAT plain-text format, optionally gzip) and a refresh interval
     (default weekly).
   - Parse it into sorted IPv4/IPv6 ranges and check peers with binary search.
   - Download it through OpenDM's own network stack, respecting the proxy settings.
   - Fail open, with a warning, if the list can't be loaded.
3. Log blocked peer counts to the R9 item log.

## Tests
- Sequential: pieces requested in increasing order (log assertion in `tests/torrent_local.rs`).
- A blocklisted 127.0.0.x peer is never connected.
- A malformed blocklist line is skipped, not fatal.

## Acceptance
- Both features work, or Step 0 explains why one was deferred.
````

---

## Phase 11: Tier 3/4 (R17–R28), design first

Use this template for each item. These are "by demand" items, so the agent writes a design note
before any code.

````markdown
# Task: <RXX — title>. Design note first, implementation after approval

Read the RXX entry in `implementation-roadmap.md` and the related sections of the other docs.

## Step 1: design note only (STOP)
Write `docs/design/<rxx-slug>.md` covering:
- the problem and who it's for
- the evidence from the MDM docs (and what was only inferred)
- the current OpenDM code involved
- the proposed design
- settings and defaults
- security and privacy
- new dependencies (name, licence, size), if any
- the test plan
- effort estimate
- what you'd leave out

Don't change code yet.

## Step 2: after my approval
Follow the standard process with branch `feat/<rxx-slug>`.

## Item-specific notes
<paste the matching block below>
````

Item-specific notes to paste into that template:

- **R17, custom DNS (DoH/DoT):**
  - Proposed dependency: `hickory-resolver`, plugged in through reqwest's `dns_resolver` hook. Needs
    approval.
  - Presets (Cloudflare, Google, Quad9) plus a custom DoH URL.
  - Falling back to system DNS is off by default for privacy, and the UI states that.
  - Apply it to yt-dlp and torrent trackers too, or document that it doesn't.
  - Tests: a local DoH stub server, and DNS failure behaviour.
- **R18, network-adapter binding (fail-closed):**
  - Bind outgoing sockets to the selected interface's IP (reqwest `local_address`; check `net.rs`).
  - If the adapter is missing or goes down, refuse to start or stop the download. Never fall back to
    another interface.
  - Pass `--source-address` to yt-dlp. Check whether librqbit can bind.
  - Re-check when the interface changes.
  - Tests: bind to 127.0.0.1 versus an absent address.
- **R19, browser proxy and POST forwarding:**
  - The extension sends the effective proxy (`chrome.proxy.settings`, the PAC result if
    determinable) and the form POST body for captured downloads.
  - The engine uses them for that item only.
  - Needs the `proxy` permission (store review impact). Cap and validate the body size.
  - Requires Phase 5.
- **R20, RSS feeds with rules:** confirm there's demand first.
  - Feed list, interval, regex/size/category rules, a seen-GUID set, add to a chosen queue.
  - Use a minimal RSS/Atom parser (existing XML crate if present).
  - Tests: fixture feeds, dedup, a malformed feed.
- **R21, crash reports:**
  - Start with a panic hook that writes the message, backtrace, version and OS to the log folder,
    plus a "Copy crash report" button on the next start.
  - Minidumps (`crash-handler`/`minidumper`) only if the panic hook isn't enough.
  - Nothing is uploaded automatically.
- **R22, automatic archive extraction:**
  - zip and tar built in. 7z/RAR only through an installed 7-Zip found on PATH or in the registry.
    Never bundle unRAR (licence).
  - Mandatory zip-slip, symlink and absolute-path tests, a size-bomb limit, and extraction into a
    new subfolder by default.
- **R23, quota warning:** check what OpenDM's existing quota does. Add only a "warn at X % before
  stopping" prompt if one is missing. Size: S.
- **R24, wake the computer for scheduled queues:**
  - Windows waitable timers (`SetWaitableTimer` with resume) and a setting.
  - Document the "Allow wake timers" power-plan requirement. Niche, so it's low priority.
- **R25, LAN remote control:** only after R16 has been stable for a while.
  - Needs TLS with a pinned self-signed certificate, a QR pairing code, per-device tokens and
    revocation.
  - Off by default, with a visible "remote control is on" indicator.
  - Write a full threat model in the design note.
- **R26, debrid accounts:** a product decision. The note should compare against OpenDM's existing
  hoster resolution and captcha support, and handle credential storage like the existing site
  logins.
- **R27, "Disable GPU" toggle:**
  - Set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu` (or the Tauri equivalent) before the
    webview is created. Needs a restart.
  - Size: S. Test on a machine with a broken driver if possible.
- **R28, reduce UI memory:**
  - Measure first: WebView2 process count and working set with the main window, tray only, and each
    dialog open.
  - Then close or destroy hidden windows' webviews, and lazy-create dialogs.
  - Target: report before/after numbers. No native-UI rewrite.

---

## Phase 12: release hardening (after the phases you ship)

Branch: `chore/release-hardening`

````markdown
# Task: Hardening pass after the MDM-derived improvements

## Do
1. Run the full test suite, clippy, `npm run build`, and `download_bench --runs 5`. Compare with the
   numbers in `docs/reverse-engineering/mdm/performance-analysis.md` and the Phase 1 baseline, and
   report a table.
2. Run the experiments from `evidence-and-experiments.md` that the original study **couldn't**
   complete, against OpenDM itself:
   - disk full (use a small VHD or RAM disk, never the system drive)
   - read-only and permission-denied destination
   - TLS and HTTP/2 against a local rustls test server
   - IPv6 loopback
   - HTTP and SOCKS proxies (see `tests/proxy.rs`)
   - a 5,000-item `downloads.json` for startup time and memory

   Report the results and file each failure as a separate issue draft. Don't fix them in this task.
3. Write `docs/reverse-engineering/mdm/STATUS.md` with:
   - each of R1–R28 marked done, partial, deferred or rejected, with the branch or PR and a
     one-line reason
   - the two inferred findings (NTFS zero-fill cost, CDN ETag risk) marked confirmed or disproved,
     with evidence
4. Update the user-facing docs for every new setting, error code (`ECHANGED`, `ECHECKSUM`, `ENOSPC`
   early check), the CLI, API and MCP.

## Don't
- Change engine behaviour in this task.
- Test against real third-party servers without asking.
````

---

## Before you start: leftovers from the MDM study

- In MDM, select `gui-test.bin` and `gui2.bin` → Delete. Then delete
  `C:\Users\chant\Downloads\gui-test.bin` (200 MB).
- The backup of MDM's original `downloads.json` was in the old session's scratch folder, which may
  be gone. If MDM still works normally, you don't need it.
- `docs/reverse-engineering/` is still uncommitted. Commit it on its own (e.g.
  `docs: add MDM reverse-engineering study`) before Phase 1, so every PR diff stays clean.

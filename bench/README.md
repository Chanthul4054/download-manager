# Download benchmarks

```sh
node bench/download-bench.js [--runs 5] [--only name,name] [--src path/to/other/src] [--json out.json]
```

`download-bench.js` drives the real `DownloadManager` against `bench-server.js`, a local server
started as a separate process so its CPU time is not counted. Every file is a slice of one random
buffer and is SHA-256 checked after download, so data written at the wrong offset is caught.
`--src` runs another copy of `src/` (for example a checkout of an older commit) for A/B comparisons.

Reported per scenario: median MB/s (with min..max over the runs), wall time, client CPU per GB,
peak RSS, event-loop delay p99, and how many files passed the integrity check.

`bench-server.js` can also simulate: no range support (`?norange`), a per-connection speed cap
(`?rate=`), redirects (`/redirect/<n>/…`), a wrong `Content-Range` (`?badrange`), a dropped
connection (`?truncate`), and failures before success (`/flaky/<n>/<status>/…`, 429 sends
`Retry-After: 1`). The regression tests in `test/robustness.test.js` use these.

## Results (2026-10-20, loopback, 5 runs)

Machine: AMD Ryzen AI 9 HX 370, NVMe SSD, Windows 11, Node 24.20. Before = commit 4b0dd53 engine.

| Scenario | Before MB/s (min..max) | After MB/s (min..max) |
|---|---|---|
| 20 × 1 MB, 8 conn | 105 (93..135) | 118 (90..154) |
| 256 MB, 1 conn | 728 (689..860) | 827 (740..1016) |
| 256 MB, 8 conn | 434 (422..556) | 515 (385..562) |
| 8 × 64 MB, 8 conn | 770 (631..819) | 734 (669..791) |
| 128 MB, no range support | 1053 (790..1120) | 1099 (677..1107) |
| 64 MB via 3 redirects | 987 (621..1111) | 921 (682..1065) |
| 32 MB, server caps 4 MB/s per conn: 1 / 4 / 8 / 16 conn | 4.0 / 15.0 / 27.8 / 48.6 | 4.0 / 15.0 / 28.1 / 47.8 |

The ranges overlap in every row: throughput did not measurably change, and none is claimed.
These are loopback numbers. They show the engine is not the limit at internet speeds, and that
extra connections help when a server caps each connection; they say nothing about how fast any
particular internet host will be.

Write coalescing (1 MB per connection, `writev`, with and without overlapping network and disk)
was tried and rejected: single-connection throughput became erratic (230..1015 MB/s against a
steady ~800 MB/s with one write per chunk), and the multi-connection gain was not consistent.

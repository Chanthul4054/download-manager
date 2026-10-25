//! Download benchmark (port of bench/download-bench.js): runs the real DownloadManager against the
//! local bench server, started as a separate process so its CPU time is not counted.
//!
//!   cargo build --release --examples
//!   target/release/examples/download_bench [--runs 3] [--only name,name] [--json out.json]
//!
//! Results are for the loopback network only and say nothing about how fast a particular
//! internet host will be.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use opendm_lib::engine::net::NetContext;
use opendm_lib::manager::{DownloadManager, MgrEvent};
use opendm_lib::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MB: usize = 1024 * 1024;

struct Scenario {
    name: &'static str,
    files: Vec<(String, usize)>,
    conns: u32,
}

fn scenarios() -> Vec<Scenario> {
    let one = |p: String, b: usize| vec![(p, b)];
    vec![
        Scenario { name: "small-1MB-x20", files: (0..20).map(|i| (format!("/file/{}", MB + i), MB + i)).collect(), conns: 8 },
        Scenario { name: "large-256MB-1conn", files: one(format!("/file/{}", 256 * MB), 256 * MB), conns: 1 },
        Scenario { name: "large-256MB-8conn", files: one(format!("/file/{}", 256 * MB), 256 * MB), conns: 8 },
        Scenario { name: "multi-8x64MB-8conn", files: (0..8).map(|i| (format!("/file/{}", 64 * MB + i), 64 * MB + i)).collect(), conns: 8 },
        Scenario { name: "norange-128MB", files: one(format!("/file/{}?norange", 128 * MB), 128 * MB), conns: 8 },
        Scenario { name: "redirect3-64MB", files: one(format!("/redirect/3/file/{}", 64 * MB), 64 * MB), conns: 8 },
        // 4 MB/s per connection: a server that caps each connection, where extra connections help.
        Scenario { name: "capped-32MB-1conn", files: one(format!("/file/{}?rate={}", 32 * MB, 4 * MB), 32 * MB), conns: 1 },
        Scenario { name: "capped-32MB-4conn", files: one(format!("/file/{}?rate={}", 32 * MB, 4 * MB), 32 * MB), conns: 4 },
        Scenario { name: "capped-32MB-8conn", files: one(format!("/file/{}?rate={}", 32 * MB, 4 * MB), 32 * MB), conns: 8 },
        Scenario { name: "capped-32MB-16conn", files: one(format!("/file/{}?rate={}", 32 * MB, 4 * MB), 32 * MB), conns: 16 },
    ]
}

/// (CPU ms used by this process so far, current working set in bytes).
fn process_usage() -> (f64, usize) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let h = GetCurrentProcess();
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let _ = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
        let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 10_000.0;
        let mut m = PROCESS_MEMORY_COUNTERS::default();
        let _ = K32GetProcessMemoryInfo(h, &mut m, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32);
        return (t(k) + t(u), m.WorkingSetSize);
    }
    #[allow(unreachable_code)]
    (0.0, 0)
}

struct Run {
    mbps: f64,
    wall_ms: f64,
    cpu_per_gb: f64,
    peak_rss_mb: f64,
    loop_p99_ms: f64,
    ok: usize,
    files: usize,
    errors: Vec<String>,
}

async fn run_once(base: &str, sc: &Scenario, hashes: &HashMap<usize, String>) -> Run {
    let dir = std::env::temp_dir().join(format!("odm-bench-{}", opendm_lib::util::id()));
    let store = Store::new(&dir.join("data"));
    {
        let mut s = store.settings.borrow_mut();
        s["saveTo"]["tempDir"] = json!(dir.join("tmp").to_string_lossy());
        s["proxy"]["mode"] = json!("none");
        s["connection"]["maxConnections"] = json!(sc.conns);
        s["downloads"]["maxSimultaneous"] = json!(8);
        let out = dir.join("out").to_string_lossy().into_owned();
        drop(s);
        for c in store.categories.borrow_mut().as_array_mut().unwrap() {
            c["folder"] = json!(out);
        }
    }
    let net = NetContext::new(store.clone(), None);
    let mgr = DownloadManager::new(store.clone(), net);

    // How late a 10 ms timer fires on the app's executor (the JS event-loop delay).
    let lags: Rc<RefCell<Vec<f64>>> = Rc::new(RefCell::new(Vec::new()));
    let peak = Rc::new(RefCell::new(0usize));
    let (l2, p2) = (lags.clone(), peak.clone());
    let sampler = tokio::task::spawn_local(async move {
        loop {
            let t = Instant::now();
            tokio::time::sleep(Duration::from_millis(10)).await;
            l2.borrow_mut().push((t.elapsed().as_secs_f64() * 1000.0 - 10.0).max(0.0));
            let rss = process_usage().1;
            let mut p = p2.borrow_mut();
            *p = (*p).max(rss);
        }
    });
    let (cpu0, _) = process_usage();
    let t0 = Instant::now();
    let finished: Rc<RefCell<Vec<(String, bool, Value)>>> = Rc::new(RefCell::new(Vec::new()));
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = RefCell::new(Some(tx));
    let n = sc.files.len();
    let f2 = finished.clone();
    mgr.events.on(move |e| {
        let r = match e {
            MgrEvent::Complete(it) => Some((it["id"].as_str().unwrap_or("").to_string(), true, it.clone())),
            MgrEvent::Failed(it, _) => Some((it["id"].as_str().unwrap_or("").to_string(), false, it.clone())),
            _ => None,
        };
        if let Some(r) = r {
            f2.borrow_mut().push(r);
            if f2.borrow().len() == n {
                if let Some(t) = tx.borrow_mut().take() {
                    let _ = t.send(());
                }
            }
        }
    });
    let mut ids = Vec::new();
    for (i, (p, _)) in sc.files.iter().enumerate() {
        let r = mgr.add(&json!({ "url": format!("{}{}", base, p), "fileName": format!("f{}.bin", i), "duplicateAction": "number" })).unwrap();
        ids.push(r["item"]["id"].as_str().unwrap().to_string());
    }
    for id in &ids {
        mgr.start(id);
    }
    let _ = rx.await;
    let wall = t0.elapsed().as_secs_f64() * 1000.0;
    let (cpu1, _) = process_usage();
    sampler.abort();
    mgr.dispose();

    let mut ok = 0;
    let mut errors = Vec::new();
    for (id, good, it) in finished.borrow().iter() {
        let bytes = sc.files[ids.iter().position(|x| x == id).unwrap()].1;
        if !good {
            errors.push(it["error"].as_str().unwrap_or("").to_string());
            continue;
        }
        let data = std::fs::read(it["savedPath"].as_str().unwrap()).unwrap_or_default();
        if hex::encode(Sha256::digest(&data)) == hashes[&bytes] {
            ok += 1;
        } else {
            errors.push(format!("hash mismatch {}", it["fileName"]));
        }
    }
    let bytes: usize = sc.files.iter().map(|f| f.1).sum();
    store.flush_all().await;
    let _ = std::fs::remove_dir_all(&dir);
    let mut l = lags.borrow().clone();
    l.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p99 = l.get(((l.len() as f64) * 0.99) as usize).copied().unwrap_or(0.0);
    let cpu = cpu1 - cpu0;
    let peak_rss = *peak.borrow();
    Run {
        mbps: bytes as f64 / MB as f64 / (wall / 1000.0),
        wall_ms: wall,
        cpu_per_gb: cpu / (bytes as f64 / (1024.0 * MB as f64)),
        peak_rss_mb: peak_rss as f64 / MB as f64,
        loop_p99_ms: p99,
        ok,
        files: sc.files.len(),
        errors,
    }
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = xs.len();
    if n % 2 == 1 { xs[n / 2] } else { (xs[n / 2 - 1] + xs[n / 2]) / 2.0 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let runs: usize = arg("--runs").and_then(|r| r.parse().ok()).unwrap_or(3);
    let only: Option<Vec<String>> = arg("--only").map(|o| o.split(',').map(String::from).collect());

    // --server <url> benchmarks against an already running server (e.g. to compare with the JS engine).
    let mut child = None;
    let base = match arg("--server") {
        Some(s) => s,
        None => {
            let server_exe = std::env::current_exe().unwrap().with_file_name(if cfg!(windows) { "bench_server.exe" } else { "bench_server" });
            let mut c = Command::new(&server_exe).stdout(Stdio::piped()).spawn().expect("run `cargo build --release --examples` first");
            let mut line = String::new();
            BufReader::new(c.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
            child = Some(c);
            format!("http://127.0.0.1:{}", line.trim().trim_start_matches("PORT ").trim())
        }
    };

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    let results = local.block_on(&rt, async {
        // The expected hashes, from the server.
        let client = reqwest::Client::new();
        let mut hashes = HashMap::new();
        for sc in scenarios() {
            for (_, b) in &sc.files {
                if !hashes.contains_key(b) {
                    let h = client.get(format!("{}/hash/{}", base, b)).send().await.unwrap().text().await.unwrap();
                    hashes.insert(*b, h);
                }
            }
        }
        println!("opendm (Rust) engine · runs {}\n", runs);
        println!("{:<22}{:>10}{:>17}{:>8}{:>10}{:>8}{:>9}  integrity", "scenario", "MB/s(med)", "MB/s(min..max)", "wall s", "CPU ms/GB", "RSS MB", "loop p99");
        let mut out = serde_json::Map::new();
        let mut warmed = false;
        for sc in scenarios() {
            if only.as_ref().is_some_and(|o| !o.iter().any(|x| x == sc.name)) {
                continue;
            }
            // One warm-up run so the disk and caches are not part of the first sample.
            if !warmed {
                run_once(&base, &sc, &hashes).await;
                warmed = true;
            }
            let mut rs = Vec::new();
            for _ in 0..runs {
                rs.push(run_once(&base, &sc, &hashes).await);
            }
            let mbps: Vec<f64> = rs.iter().map(|r| r.mbps).collect();
            let errors: Vec<String> = rs.iter().flat_map(|r| r.errors.clone()).collect();
            let r = json!({
                "mbps": median(mbps.clone()),
                "mbpsMin": mbps.iter().cloned().fold(f64::MAX, f64::min),
                "mbpsMax": mbps.iter().cloned().fold(0.0, f64::max),
                "wallS": median(rs.iter().map(|r| r.wall_ms).collect()) / 1000.0,
                "cpuPerGB": median(rs.iter().map(|r| r.cpu_per_gb).collect()),
                "peakRssMB": rs.iter().map(|r| r.peak_rss_mb).fold(0.0, f64::max),
                "loopP99ms": median(rs.iter().map(|r| r.loop_p99_ms).collect()),
                "ok": rs.iter().map(|r| r.ok).sum::<usize>(),
                "files": rs.iter().map(|r| r.files).sum::<usize>(),
                "errors": errors,
            });
            let mut uniq: Vec<String> = errors.clone();
            uniq.dedup();
            println!(
                "{:<22}{:>10.1}{:>17}{:>8.2}{:>10.0}{:>8.0}{:>9.1}  {}/{}{}",
                sc.name,
                r["mbps"].as_f64().unwrap(),
                format!("{:.0}..{:.0}", r["mbpsMin"].as_f64().unwrap(), r["mbpsMax"].as_f64().unwrap()),
                r["wallS"].as_f64().unwrap(),
                r["cpuPerGB"].as_f64().unwrap(),
                r["peakRssMB"].as_f64().unwrap(),
                r["loopP99ms"].as_f64().unwrap(),
                r["ok"],
                r["files"],
                if uniq.is_empty() { String::new() } else { format!(" {}", uniq.join("; ")) }
            );
            out.insert(sc.name.into(), r);
        }
        out
    });
    if let Some(path) = arg("--json") {
        std::fs::write(path, serde_json::to_string_pretty(&json!({ "engine": "rust", "runs": runs, "results": results })).unwrap()).unwrap();
    }
    if let Some(mut c) = child {
        let _ = c.kill();
    }
}

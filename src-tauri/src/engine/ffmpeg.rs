//! Finding ffmpeg and merging video+audio streams (port of engine/ffmpeg.js).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use std::sync::LazyLock;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();
static CACHED: Mutex<Option<Option<String>>> = Mutex::new(None);

/// Where the installer put ffmpeg (set once at startup).
pub fn set_bundled(path: PathBuf) {
    let _ = BUNDLED.set(path);
}

pub fn exe() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Creates a command that never opens a console window (Node's `windowsHide`).
pub fn command(program: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

pub fn std_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Finds ffmpeg: the configured path, the bundled binary, then PATH. None if none.
pub fn find_ffmpeg(configured: &str) -> Option<String> {
    if !configured.is_empty() && std::path::Path::new(configured).exists() {
        return Some(configured.to_string());
    }
    let mut cache = CACHED.lock().unwrap();
    if let Some(c) = cache.as_ref() {
        return c.clone();
    }
    let mut found = None;
    if let Some(p) = BUNDLED.get().filter(|p| p.exists()) {
        found = Some(p.to_string_lossy().into_owned());
    } else {
        let ok = std_command(exe()).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        if ok {
            found = Some(exe().to_string());
        }
    }
    *cache = Some(found.clone());
    found
}

/// The last `n` bytes of `s`, moved forward to a character boundary.
pub fn tail(s: &str, n: usize) -> String {
    let mut cut = s.len().saturating_sub(n);
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    s[cut..].to_string()
}

static MP4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.mp4$").unwrap());

/// Copies the first video stream of `video` and first audio stream of `audio` into `out`
/// without re-encoding.
pub async fn mux(ffmpeg: &str, video: &str, audio: &str, out: &str, signal: &CancellationToken) -> Result<()> {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if MP4.is_match(out) {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push(out.into());
    let mut p = command(ffmpeg).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true).spawn()?;
    let mut stderr = p.stderr.take().unwrap();
    let mut err = String::new();
    let read = async {
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    err.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if err.len() > 8000 {
                        err = tail(&err, 4000);
                    }
                }
            }
        }
    };
    let status = tokio::select! {
        (_, s) = async { tokio::join!(read, p.wait()) } => s?,
        _ = signal.cancelled() => {
            let _ = p.kill().await;
            p.wait().await?
        }
    };
    if status.success() {
        return Ok(());
    }
    let last = err.trim().split('\n').next_back().unwrap_or("").to_string();
    let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into());
    Err(Error::new(format!(
        "Merging video and audio failed: {}",
        if last.is_empty() { format!("ffmpeg exited with {}", code) } else { last }
    )))
}

//! Command-line switches (port of src/main/cli.js), both `/x` and `-x` forms:
//!   /d URL   download URL          /p path   save folder        /f name   file name
//!   /a       add to queue only     /n        silent (no dialogs) /q       exit after the download
//!   /h       hang up when done (accepted, no-op)                 /s       start the main queue
//! A bare http(s)/ftp URL is treated as /d URL.

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Args {
    pub url: Option<String>,
    pub path: Option<String>,
    pub file: Option<String>,
    pub add: bool,
    pub silent: bool,
    pub quit: bool,
    pub hangup: bool,
    pub start_queue: bool,
    pub hidden: bool,
}

static SWITCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:/|-{1,2})([a-z]+)$").unwrap());
static BARE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(https?|ftp)://").unwrap());

pub fn parse_args(argv: &[String]) -> Args {
    let mut out = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(m) = SWITCH.captures(a) {
            let k = m[1].to_lowercase();
            let v = if matches!(k.as_str(), "d" | "p" | "f") {
                i += 1;
                argv.get(i).cloned()
            } else {
                None
            };
            match k.as_str() {
                "d" => out.url = v,
                "p" => out.path = v,
                "f" => out.file = v,
                "a" => out.add = true,
                "n" => out.silent = true,
                "q" => out.quit = true,
                "h" => out.hangup = true,
                "s" => out.start_queue = true,
                "hidden" | "tray" => out.hidden = true,
                _ => {}
            }
        } else if BARE_URL.is_match(a) && out.url.is_none() {
            out.url = Some(a.clone());
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches() {
        let a = parse_args(&["/d".into(), "http://x/y.zip".into(), "-n".into(), "--tray".into()]);
        assert_eq!(a.url.as_deref(), Some("http://x/y.zip"));
        assert!(a.silent && a.hidden);
        let b = parse_args(&["ftp://h/f".into(), "/s".into()]);
        assert_eq!(b.url.as_deref(), Some("ftp://h/f"));
        assert!(b.start_queue);
    }
}

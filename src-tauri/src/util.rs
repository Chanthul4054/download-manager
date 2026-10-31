//! File naming, URL and list helpers (port of src/main/util.js).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rand::RngCore;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use crate::error::{Error, Result};
use crate::js;

static ILLEGAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());
static TRAILING_DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[. ]+$").unwrap());
static RESERVED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$").unwrap());

/// JS `str.length` (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `str.slice(a, b)` in UTF-16 code units.
pub fn js_slice(s: &str, a: usize, b: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let b = b.min(u.len());
    let a = a.min(b);
    String::from_utf16_lossy(&u[a..b])
}

pub fn sanitize_file_name(name: &str) -> String {
    let n = ILLEGAL.replace_all(name, "_");
    let n = TRAILING_DOTS.replace(&n, "");
    let mut n = n.trim().to_string();
    if n.is_empty() {
        n = "download".into();
    }
    if RESERVED.is_match(&n) {
        n = format!("_{}", n);
    }
    if js_len(&n) > 200 {
        let ext = js_slice(&extname(&n), 0, 20);
        n = js_slice(&n, 0, 200 - js_len(&ext)) + &ext;
    }
    n
}

/// Node's `path.extname` (Windows flavour: both slashes separate).
pub fn extname(p: &str) -> String {
    let chars: Vec<char> = p.chars().collect();
    let mut start_dot: isize = -1;
    let mut start_part: isize = 0;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut pre_dot_state = 0;
    let mut i = chars.len() as isize - 1;
    while i >= 0 {
        let c = chars[i as usize];
        if c == '/' || c == '\\' {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if c == '.' {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    chars[start_dot as usize..end as usize].iter().collect()
}

/// Node's `path.basename(p)`.
pub fn basename(p: &str) -> String {
    let t = p.trim_end_matches(['/', '\\']);
    t.rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// Node's `path.dirname(p)` for the absolute paths the app builds.
pub fn dirname(p: &str) -> PathBuf {
    Path::new(p).parent().map(|x| x.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

pub fn join(a: &str, b: &str) -> String {
    Path::new(a).join(b).to_string_lossy().into_owned()
}

/// JS `decodeURIComponent`: fails on a malformed escape or invalid UTF-8.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// JS `unescape` (%XX and %uXXXX).
fn unescape(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '%' {
            if i + 5 < c.len() + 0 && c[i + 1] == 'u' {
                let h: String = c[i + 2..(i + 6).min(c.len())].iter().collect();
                if h.len() == 4 && h.chars().all(|x| x.is_ascii_hexdigit()) {
                    if let Some(ch) = char::from_u32(u32::from_str_radix(&h, 16).unwrap()) {
                        out.push(ch);
                        i += 6;
                        continue;
                    }
                }
            }
            if i + 2 < c.len() {
                let h: String = c[i + 1..i + 3].iter().collect();
                if h.chars().all(|x| x.is_ascii_hexdigit()) {
                    out.push(u8::from_str_radix(&h, 16).unwrap() as char);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Bytes of a string read as latin1 (each char code truncated to a byte), decoded as UTF-8.
fn latin1_to_utf8(v: &str) -> String {
    let bytes: Vec<u8> = v.chars().map(|c| c as u32 as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

static DISP_STAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)filename\*\s*=\s*([^']*)'[^']*'([^;]+)").unwrap());
static DISP_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)filename\s*=\s*("((?:\\.|[^"\\])*)"|[^;]+)"#).unwrap());
static UTF8_CHARSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)utf-?8").unwrap());
static BACKSLASH_ESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());

/// RFC 6266 / 5987 Content-Disposition filename parsing. `header` is the raw value read as latin1.
pub fn file_name_from_disposition(header: Option<&str>) -> Option<String> {
    let header = header.filter(|h| !h.is_empty())?;
    if let Some(star) = DISP_STAR.captures(header) {
        let mut v = star[2].trim().to_string();
        if v.starts_with('"') {
            v.remove(0);
        }
        if v.ends_with('"') {
            v.pop();
        }
        if !star[1].is_empty() && !UTF8_CHARSET.is_match(&star[1]) {
            return Some(unescape(&v).chars().map(|c| (c as u32 as u8) as char).collect());
        }
        if let Some(d) = decode_uri_component(&v) {
            return Some(d);
        }
    }
    if let Some(plain) = DISP_PLAIN.captures(header) {
        let mut v = match plain.get(2) {
            Some(q) => BACKSLASH_ESC.replace_all(q.as_str(), "$1").into_owned(),
            None => plain[1].trim().to_string(),
        };
        // Many servers send raw UTF-8 bytes, which arrive here as latin1.
        let re = latin1_to_utf8(&v);
        if !re.contains('\u{FFFD}') {
            v = re;
        }
        return Some(v);
    }
    None
}

pub fn file_name_from_url(u: &str) -> Option<String> {
    let url = url::Url::parse(u).ok()?;
    let seg = url.path().split('/').filter(|s| !s.is_empty()).next_back().unwrap_or("").to_string();
    let dec = decode_uri_component(&seg)?;
    if dec.is_empty() {
        Some(url.host_str().unwrap_or("").to_string())
    } else {
        Some(dec)
    }
}

const MIME_EXT: &[(&str, &str)] = &[
    ("application/zip", ".zip"), ("application/x-rar-compressed", ".rar"), ("application/vnd.rar", ".rar"),
    ("application/x-7z-compressed", ".7z"), ("application/pdf", ".pdf"), ("application/x-msdownload", ".exe"),
    ("application/x-msi", ".msi"), ("application/gzip", ".gz"), ("application/x-tar", ".tar"),
    ("video/mp4", ".mp4"), ("video/webm", ".webm"), ("video/x-matroska", ".mkv"), ("video/quicktime", ".mov"),
    ("video/mp2t", ".ts"), ("audio/mpeg", ".mp3"), ("audio/mp4", ".m4a"), ("audio/ogg", ".ogg"), ("audio/wav", ".wav"),
    ("audio/webm", ".weba"), ("image/jpeg", ".jpg"), ("image/png", ".png"), ("image/gif", ".gif"), ("image/webp", ".webp"),
    ("text/html", ".html"), ("text/plain", ".txt"), ("application/json", ".json"), ("application/octet-stream", ""),
    ("application/vnd.apple.mpegurl", ".ts"), ("application/x-mpegurl", ".ts"),
];

pub fn ext_for_mime(mime: &str) -> &'static str {
    if mime.is_empty() {
        return "";
    }
    let m = mime.split(';').next().unwrap_or("").trim().to_lowercase();
    MIME_EXT.iter().find(|(k, _)| *k == m).map(|(_, v)| *v).unwrap_or("")
}

pub fn ext_of(name: &str) -> String {
    let e = extname(name);
    e.strip_prefix('.').unwrap_or(&e).to_lowercase()
}

/// Glob with only `*` (any run) and `?` (one char), case-insensitive.
pub fn wildcard_to_regex(pattern: &str) -> Regex {
    let mut re = String::from("(?i)^");
    for c in pattern.trim().chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    Regex::new(&re).unwrap_or_else(|_| Regex::new("^$").unwrap())
}

pub fn wildcard_match(pattern: &str, value: &str) -> bool {
    wildcard_to_regex(pattern).is_match(value)
}

pub fn host_matches(patterns: &Value, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    split_list(patterns).iter().any(|p| wildcard_match(p, host) || wildcard_match(&format!("*.{}", p), host))
}

static LIST_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s,;]+").unwrap());

pub fn split_list(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().map(|s| js::str_of(s).trim().to_string()).filter(|s| !s.is_empty()).collect(),
        other => split_str(&js::str_of(other)),
    }
}

pub fn split_str(s: &str) -> Vec<String> {
    LIST_SEP.split(s).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub async fn unique_path(p: &str, taken: &HashSet<String>) -> String {
    let path = Path::new(p);
    let dir = path.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let ext = extname(&basename(p));
    let file = basename(p);
    let base = file.strip_suffix(ext.as_str()).unwrap_or(&file).to_string();
    let mut candidate = p.to_string();
    let mut i = 2;
    loop {
        let exists = taken.contains(&candidate.to_lowercase()) || tokio::fs::metadata(&candidate).await.is_ok();
        if !exists {
            return candidate;
        }
        candidate = dir.join(format!("{} ({}){}", base, i, ext)).to_string_lossy().into_owned();
        i += 1;
    }
}

pub fn format_bytes(n: Option<f64>) -> String {
    let Some(mut n) = n else { return String::new() };
    if n < 0.0 || !n.is_finite() {
        return String::new();
    }
    let u = ["Bytes", "KB", "MB", "GB", "TB"];
    let mut i = 0;
    while n >= 1024.0 && i < u.len() - 1 {
        n /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{:.0} {}", n, u[i])
    } else if n >= 100.0 {
        format!("{:.1} {}", n, u[i])
    } else {
        format!("{:.2} {}", n, u[i])
    }
}

pub fn id() -> String {
    let mut b = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

/// Expands a batch pattern containing a single `*` into URLs. from/to are letters (a..z) or
/// numbers; width zero-pads numbers.
pub fn expand_batch(pattern: &str, from: &Value, to: &Value, width: &Value) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !pattern.contains('*') {
        return Ok(vec![pattern.to_string()]);
    }
    let (fs, ts) = (js::str_of(from), js::str_of(to));
    let is_num = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if is_num(&fs) && is_num(&ts) {
        let a: i64 = fs.parse().unwrap_or(0);
        let b: i64 = ts.parse().unwrap_or(0);
        let width = js::num(width);
        let width = if width.is_nan() || width < 0.0 { 0 } else { width as usize };
        if (b - a).abs() > 100000 {
            return Err(Error::new("Batch range too large"));
        }
        let step = if a <= b { 1 } else { -1 };
        let mut i = a;
        while if step > 0 { i <= b } else { i >= b } {
            out.push(pattern.replacen('*', &format!("{:0>width$}", i, width = width), 1));
            i += step;
        }
    } else {
        let (Some(a), Some(b)) = (fs.encode_utf16().next(), ts.encode_utf16().next()) else { return Ok(out) };
        let (a, b) = (a as i64, b as i64);
        let step = if a <= b { 1 } else { -1 };
        let mut c = a;
        while if step > 0 { c <= b } else { c >= b } {
            out.push(pattern.replacen('*', &String::from_utf16_lossy(&[c as u16]), 1));
            c += step;
        }
    }
    Ok(out)
}

static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?-u:\b)(?:https?|ftp)://[^\s"'<>`]+"#).unwrap());
static URL_TRAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[),.;\]]+$").unwrap());

pub fn extract_urls(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in URL_RE.find_iter(text) {
        let u = URL_TRAIL.replace(m.as_str(), "").into_owned();
        if seen.insert(u.clone()) {
            out.push(u);
        }
    }
    out
}

pub async fn write_json_atomic(file: &Path, data: &Value) -> Result<()> {
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    if let Some(d) = file.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    tokio::fs::write(&tmp, serde_json::to_string_pretty(data)?).await?;
    // Settings hold site logins, proxy and 2Captcha keys; downloads hold cookies. Owner-only on
    // Unix (on Windows the per-user AppData folder already is).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await?;
    }
    tokio::fs::rename(&tmp, file).await?;
    Ok(())
}

pub fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

pub async fn move_file(src: &str, dest: &str) -> Result<()> {
    if let Some(d) = Path::new(dest).parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    match tokio::fs::rename(src, dest).await {
        Ok(()) => Ok(()),
        Err(e) if crate::error::io_code(&e) == "EXDEV" || e.raw_os_error() == Some(17) => {
            tokio::fs::copy(src, dest).await?;
            tokio::fs::remove_file(src).await?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// `fs.promises.rm(p, { force: true })` — also removes directories when `recursive`.
pub async fn rm_force(p: &str, recursive: bool) {
    match tokio::fs::metadata(p).await {
        Ok(m) if m.is_dir() => {
            if recursive {
                let _ = tokio::fs::remove_dir_all(p).await;
            }
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(p).await;
        }
        Err(_) => {}
    }
}

/// The URL's hostname as JS `new URL(u).hostname` reports it ("" when invalid).
pub fn hostname(u: &str) -> String {
    url::Url::parse(u).ok().and_then(|x| x.host_str().map(|h| h.to_string())).unwrap_or_default()
}

/// `cookies` captured for `origin`, or none when `url` is on another host: a page's cookies must
/// never reach a third-party link, CDN or redirect target.
pub fn cookies_for(url: &str, origin: &str, cookies: &str) -> String {
    let h = hostname(url);
    if !h.is_empty() && h.eq_ignore_ascii_case(&hostname(origin)) { cookies.to_string() } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cookies_stay_on_their_host() {
        assert_eq!(cookies_for("https://mail.example.com/a.zip", "https://mail.example.com/inbox", "sid=1"), "sid=1");
        assert_eq!(cookies_for("https://evil.test/x", "https://mail.example.com/inbox", "sid=1"), "");
        assert_eq!(cookies_for("https://evil.test/x", "", "sid=1"), "");
    }

    #[test]
    fn utilities() {
        assert_eq!(
            expand_batch("http://x/img*.jpg", &json!(1), &json!(3), &json!(2)).unwrap(),
            vec!["http://x/img01.jpg", "http://x/img02.jpg", "http://x/img03.jpg"]
        );
        assert_eq!(
            expand_batch("http://x/*.zip", &json!("a"), &json!("c"), &Value::Null).unwrap(),
            vec!["http://x/a.zip", "http://x/b.zip", "http://x/c.zip"]
        );
        assert_eq!(file_name_from_disposition(Some("attachment; filename*=UTF-8''na%C3%AFve.pdf")).unwrap(), "naïve.pdf");
        assert_eq!(sanitize_file_name("a<b>:c?.txt"), "a_b__c_.txt");
        assert!(host_matches(&json!("*.tonec.com"), "www.tonec.com"));
        assert_eq!(extract_urls("see http://a.com/x.zip, and ftp://b/y)"), vec!["http://a.com/x.zip", "ftp://b/y"]);
    }

    #[test]
    fn node_path_semantics() {
        assert_eq!(extname("a.tar.gz"), ".gz");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("name."), ".");
        assert_eq!(extname("noext"), "");
        assert_eq!(ext_of("Movie.MKV"), "mkv");
        assert_eq!(sanitize_file_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_file_name("  . "), "download");
    }

    #[test]
    fn disposition_latin1_utf8() {
        // "réport final.bin" sent as raw UTF-8 bytes, read as latin1.
        let raw: String = "attachment; filename=\"réport final.bin\"".bytes().map(|b| b as char).collect();
        assert_eq!(file_name_from_disposition(Some(&raw)).unwrap(), "réport final.bin");
        assert_eq!(file_name_from_url("http://h/a%20b.zip?x=1").unwrap(), "a b.zip");
        assert_eq!(file_name_from_url("http://h/").unwrap(), "h");
        assert_eq!(file_name_from_url("http://h/%E0%A4%A"), None);
    }
}

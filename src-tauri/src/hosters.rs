//! Link containers and file hosters the LinkGrabber looks through, after LinkExtractor's
//! scraper/engine: PrivateBin pastes (decrypted here with the key from the address's #fragment,
//! as the paste's own page script would) and fuckingfast.co file pages, whose direct address comes
//! from POST /f/<id>/go once Cloudflare Turnstile has been solved.

use std::sync::LazyLock;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::aes::Aes256;
use aes_gcm::{AesGcm, Nonce};
use base64::Engine as _;
use regex::Regex;
use serde_json::Value;

use crate::captcha;
use crate::engine::net::{NetContext, ReqOpts};
use crate::error::{Error, Result};
use crate::util::{self as u, decode_uri_component};

// A PrivateBin paste: 16 hex digits of paste id in the query, the base58 key in the fragment
// ("-" in front asks for a confirmation click in newer versions).
static PASTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://[^/?#]+/[^?#]*\?(?:pasteid=)?[0-9a-f]{16}#-?[1-9A-HJ-NP-Za-km-z]{32,}$").unwrap());
// The direct address, should a page carry it outright.
static FF_DIRECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https://dl\.fuckingfast\.co/[^\s"'<>]+"#).unwrap());

pub fn is_paste(url: &str) -> bool {
    PASTE.is_match(url)
}

fn is_fuckingfast(u: &url::Url) -> bool {
    matches!(u.host_str(), Some("fuckingfast.co" | "www.fuckingfast.co")) && u.path().len() > 1 && !u.path().starts_with("/dl/")
}

/// File pages that only lead to the file; the download engine resolves them when it starts.
pub fn needs_resolve(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| is_fuckingfast(&u))
}

/// Addresses whose #fragment carries data (a paste key, a hoster's file name) and must be kept.
pub fn keeps_fragment(url: &str) -> bool {
    is_paste(url) || needs_resolve(url)
}

/// The file name a hoster page names in its fragment (fuckingfast.co/abc#Name.part01.rar).
pub fn file_name(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok().filter(is_fuckingfast)?;
    decode_uri_component(u.fragment()?).map(|n| u::sanitize_file_name(&n)).filter(|n| !n.is_empty())
}

/// Newer PrivateBin marks burn-after-reading pastes with "#-" so they are not read by accident.
pub fn burns_after_reading(url: &str) -> bool {
    url.split_once('#').is_some_and(|(_, k)| k.starts_with('-'))
}

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new(); // little-endian
    for c in s.bytes() {
        let mut carry = B58.iter().position(|&b| b == c)? as u32;
        for b in out.iter_mut() {
            carry += *b as u32 * 58;
            *b = carry as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.push(carry as u8);
            carry >>= 8;
        }
    }
    out.extend(s.bytes().take_while(|&c| c == b'1').map(|_| 0));
    out.reverse();
    Some(out)
}

/// Decrypts a PrivateBin v2 paste: PBKDF2-SHA256 key, AES-GCM with the JSON-encoded parameters
/// as associated data, optionally raw-deflated. Returns the paste's text.
pub fn decrypt_paste(paste: &Value, key: &[u8]) -> Result<String> {
    let bad = || Error::new("Unreadable paste");
    let adata = &paste["adata"];
    let spec = if adata[0].is_array() { &adata[0] } else { adata };
    let b64 = |v: &Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap_or("")).map_err(|_| bad());
    let (iv, salt, ct) = (b64(&spec[0])?, b64(&spec[1])?, b64(&paste["ct"])?);
    let iter = spec[2].as_u64().ok_or_else(bad)? as u32;
    if spec[5] != "aes" || spec[6] != "gcm" || spec[3] != 256 || spec[4] != 128 || iv.len() != 16 {
        return Err(Error::new("Unsupported paste encryption"));
    }
    // shortcut: password-protected pastes are not supported (the password is appended to the key).
    let mut derived = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(key, &salt, iter, &mut derived);
    let aad = serde_json::to_string(adata).map_err(|_| bad())?;
    let cipher = AesGcm::<Aes256, aes_gcm::aead::consts::U16>::new((&derived).into());
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: aad.as_bytes() })
        .map_err(|_| Error::new("Paste key does not fit (password-protected?)"))?;
    let plain = if spec[7] == "zlib" {
        let mut s = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::DeflateDecoder::new(&plain[..]), &mut s).map_err(|_| bad())?;
        s
    } else {
        plain
    };
    let v: Value = serde_json::from_slice(&plain).map_err(|_| bad())?;
    Ok(v["paste"].as_str().unwrap_or("").to_string())
}

/// Fetches and decrypts a PrivateBin paste address.
pub async fn fetch_paste(net: &NetContext, url: &str, opts: &ReqOpts) -> Result<String> {
    let (addr, frag) = url.split_once('#').ok_or_else(|| Error::new("Paste address has no key"))?;
    let key = base58(frag.trim_start_matches('-')).ok_or_else(|| Error::new("Invalid paste key"))?;
    let o = opts.clone().header("X-Requested-With", "JSONHttpRequest").header("Accept", "application/json");
    let f = net.fetch_buffer(addr, &o).await?;
    let v: Value = serde_json::from_slice(&f.body).map_err(|_| Error::new("Not a PrivateBin paste"))?;
    if v["status"].as_i64().unwrap_or(0) != 0 {
        return Err(Error::new(format!("Paste: {}", v["message"].as_str().unwrap_or("not found"))));
    }
    decrypt_paste(&v, &key)
}

/// Turns a fuckingfast.co file page into its direct download address.
pub async fn resolve(net: &NetContext, page_url: &str, captcha_key: &str) -> Result<String> {
    let mut page = url::Url::parse(page_url).map_err(|_| Error::with_code("Invalid URL", "ERR_INVALID_URL"))?;
    page.set_fragment(None);
    let id = page.path().trim_matches('/').to_string();
    let f = net.fetch_buffer(page.as_str(), &ReqOpts { max_bytes: Some(2 * 1024 * 1024), timeout_sec: Some(30.0), ..Default::default() }).await?;
    let html = String::from_utf8_lossy(&f.body);
    if let Some(m) = FF_DIRECT.find(&html) {
        return Ok(m.as_str().replace("&amp;", "&"));
    }
    let c = captcha::detect(&html).ok_or_else(|| Error::new("File not found on fuckingfast.co (no download button)"))?;
    if captcha_key.is_empty() {
        return Err(Error::new(format!("{} — add a 2Captcha API key in the LinkGrabber settings", c.label())));
    }
    let token = captcha::solve(net, captcha_key, &c, page.as_str()).await?;
    let cookies = captcha::merge_cookies("", f.headers.get("set-cookie").map(|s| s.as_str()));
    let body = url::form_urlencoded::Serializer::new(String::new()).append_pair("cf-turnstile-response", &token).finish();
    let mut o = ReqOpts { method: Some(reqwest::Method::POST), body: Some(body.into_bytes()), timeout_sec: Some(30.0), ..Default::default() }
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("HX-Request", "true")
        .header("Referer", page.as_str());
    if !cookies.is_empty() {
        o = o.header("Cookie", &cookies);
    }
    // Headers are enough: the answer names the file in HX-Redirect, or redirects straight to it.
    let go = page.join(&format!("/f/{}/go", id)).map_err(|_| Error::new("Invalid URL"))?;
    let mut r = net.request(go.as_str(), &o).await?;
    let direct = r.header("hx-redirect").map(String::from).or_else(|| (u::hostname(&r.url) == "dl.fuckingfast.co").then(|| r.url.clone()));
    r.destroy();
    direct.filter(|d| !d.is_empty()).ok_or_else(|| Error::new(format!("fuckingfast.co refused the download (HTTP {})", r.status)))
}


#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::DeflateEncoder;
    use std::io::Write;

    #[test]
    fn recognises_pastes_and_hoster_pages() {
        let paste = "https://paste.fitgirl-repacks.site/?dc64365f494f3ba0#8n4uE9cXrsNZHSeBn4iFnQq2gaC5x7k7aDs6M4L9h3pW";
        assert!(is_paste(paste) && keeps_fragment(paste));
        assert!(!is_paste("https://paste.fitgirl-repacks.site/?dc64365f494f3ba0"));
        assert!(!burns_after_reading(paste) && burns_after_reading(&paste.replace('#', "#-")));
        let ff = "https://fuckingfast.co/abc123xyz#Some_Game_--_fitgirl-repacks.site_--_.part01.rar";
        assert!(needs_resolve(ff) && !needs_resolve("https://dl.fuckingfast.co/abc") && !needs_resolve("https://fuckingfast.co/"));
        assert_eq!(file_name(ff).as_deref(), Some("Some_Game_--_fitgirl-repacks.site_--_.part01.rar"));
        assert_eq!(file_name("https://example.com/a#b.rar"), None);
        assert!(!file_name("https://fuckingfast.co/a#..%2F..%2Fx%3A%3F.rar").unwrap().contains(['/', ':', '?']));
    }

    #[test]
    fn base58_keeps_leading_zeros() {
        assert_eq!(base58("1112").unwrap(), [0, 0, 0, 1]);
        assert_eq!(base58("5Q").unwrap(), [255]); // 4 * 58 + 23
        assert!(base58("0OIl").is_none());
    }

    #[test]
    fn decrypts_a_privatebin_v2_paste() {
        // Encrypt the way PrivateBin's privatebin.js does, then read it back.
        let key = [7u8; 32];
        let (iv, salt) = ([1u8; 16], [2u8; 8]);
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let adata = serde_json::json!([[b64(&iv), b64(&salt), 1000, 256, 128, "aes", "gcm", "zlib"], "plaintext", 0, 0]);
        let mut z = DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(br#"{"paste":"https://fuckingfast.co/a1#G.part1.rar\nhttps://fuckingfast.co/a2#G.part2.rar"}"#).unwrap();
        let mut derived = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&key, &salt, 1000, &mut derived);
        let cipher = AesGcm::<Aes256, aes_gcm::aead::consts::U16>::new((&derived).into());
        let aad = serde_json::to_string(&adata).unwrap();
        let ct = cipher.encrypt(Nonce::from_slice(&iv), Payload { msg: &z.finish().unwrap(), aad: aad.as_bytes() }).unwrap();
        let paste = serde_json::json!({ "v": 2, "adata": adata, "ct": b64(&ct) });
        let text = decrypt_paste(&paste, &key).unwrap();
        assert_eq!(crate::util::extract_urls(&text).len(), 2);
        assert!(decrypt_paste(&paste, &[8u8; 32]).is_err());
    }
}

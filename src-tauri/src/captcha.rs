//! Captchas met by the LinkGrabber's deep analysis, after JDownloader 2's
//! org.jdownloader.captcha.v2: a page's reCAPTCHA, hCaptcha or Turnstile widget is recognised by
//! its site key, solved by 2Captcha (the createTask/getTaskResult API JDownloader's TwoCaptchaSolver
//! uses), and the token is sent back with the form around the widget.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::engine::net::{NetContext, ReqOpts};
use crate::error::{Error, Result};

const API: &str = "https://api.2captcha.com";
/// JDownloader's default challenge timeout is a few minutes; 2Captcha usually answers in under one.
const SOLVE_TIMEOUT_SEC: u64 = 180;

// Site keys as JDownloader's AbstractRecaptchaV2 / AbstractHCaptcha / AbstractCloudflareTurnstileCaptcha find them.
static SITE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:data-sitekey\s*=\s*['"]\s*|['"]?sitekey['"]?\s*:\s*['"]\s*|recaptcha/(?:api|enterprise)\.js\?render=|recaptcha/(?:api|enterprise)/fallback\?k=)([\w-]{20,})"#).unwrap()
});
static RECAPTCHA_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^6L[\w-]{14,}$").unwrap());
static HCAPTCHA_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$").unwrap());
static TURNSTILE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+x[\w-]{22}$").unwrap());
static INVISIBLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)data-size\s*=\s*['"]\s*invisible"#).unwrap());
static FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<form\b([^>]*)>(.*?)</form>").unwrap());
static INPUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<input\b[^>]*>").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?"#).unwrap());
// The first name=value of each cookie in a (comma-joined) Set-Cookie header; "Expires=Wed, 21 Oct"
// does not match because the date after the comma has no "=".
static SET_COOKIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|,\s*)([^=;,\s]+)=([^;,]*)").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct Challenge {
    /// recaptcha, hcaptcha or turnstile
    pub kind: &'static str,
    pub site_key: String,
    pub invisible: bool,
    pub enterprise: bool,
}

impl Challenge {
    pub fn label(&self) -> &'static str {
        match self.kind {
            "recaptcha" => "reCAPTCHA",
            "hcaptcha" => "hCaptcha",
            _ => "Turnstile",
        }
    }

    /// The form fields the widget fills in with the token.
    fn response_fields(&self) -> &'static [&'static str] {
        match self.kind {
            "recaptcha" => &["g-recaptcha-response"],
            "hcaptcha" => &["h-captcha-response", "g-recaptcha-response"],
            _ => &["cf-turnstile-response"],
        }
    }
}

/// Finds the first captcha widget on a page.
pub fn detect(html: &str) -> Option<Challenge> {
    SITE_KEY.captures_iter(html).find_map(|c| {
        let key = c[1].to_string();
        let kind = if RECAPTCHA_KEY.is_match(&key) {
            "recaptcha"
        } else if HCAPTCHA_KEY.is_match(&key) {
            "hcaptcha"
        } else if TURNSTILE_KEY.is_match(&key) {
            "turnstile"
        } else {
            return None;
        };
        Some(Challenge { kind, site_key: key, invisible: INVISIBLE.is_match(html), enterprise: html.contains("recaptcha/enterprise.js") })
    })
}

fn attrs(tag: &str) -> Vec<(String, Option<String>)> {
    let inner = tag.trim_start_matches('<').trim_end_matches('>');
    // Skip the tag name itself.
    ATTR.captures_iter(inner)
        .skip(1)
        .map(|c| (c[1].to_lowercase(), c.get(2).or(c.get(3)).or(c.get(4)).map(|m| decode_entities(m.as_str()))))
        .collect()
}

fn attr(list: &[(String, Option<String>)], name: &str) -> Option<String> {
    list.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone().unwrap_or_default())
}

fn decode_entities(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#39;", "'").replace("&#039;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub action: String,
    /// GET or POST
    pub method: String,
    pub fields: Vec<(String, String)>,
}

/// The form around the widget with the solved token filled in. Pages without one get the token
/// posted back to themselves.
pub fn answer_form(html: &str, page_url: &str, c: &Challenge, token: &str) -> Form {
    let forms: Vec<_> = FORM.captures_iter(html).collect();
    let hit = forms
        .iter()
        .find(|f| f[2].contains(&c.site_key))
        .or_else(|| forms.iter().find(|f| f[2].to_lowercase().contains("captcha")));
    let mut form = Form { action: page_url.to_string(), method: "POST".into(), fields: Vec::new() };
    if let Some(f) = hit {
        let a = attrs(&format!("<form {}>", &f[1]));
        if let Some(action) = attr(&a, "action").filter(|x| !x.trim().is_empty()) {
            if let Some(abs) = url::Url::parse(page_url).ok().and_then(|b| b.join(action.trim()).ok()) {
                form.action = abs.to_string();
            }
        }
        if attr(&a, "method").is_some_and(|m| m.eq_ignore_ascii_case("get")) {
            form.method = "GET".into();
        }
        // shortcut: <select>, <textarea> and submit buttons are not sent; add them if a site needs them.
        for tag in INPUT.find_iter(&f[2]) {
            let ia = attrs(tag.as_str());
            let Some(name) = attr(&ia, "name").filter(|n| !n.is_empty()) else { continue };
            let kind = attr(&ia, "type").unwrap_or_default().to_lowercase();
            if matches!(kind.as_str(), "submit" | "button" | "image" | "reset" | "file") {
                continue;
            }
            if matches!(kind.as_str(), "checkbox" | "radio") && attr(&ia, "checked").is_none() {
                continue;
            }
            form.fields.push((name, attr(&ia, "value").unwrap_or_default()));
        }
    }
    for name in c.response_fields() {
        form.fields.retain(|(k, _)| k != name);
        form.fields.push((name.to_string(), token.to_string()));
    }
    form
}

/// Adds the cookies a response set to a Cookie header, replacing same-named ones.
pub fn merge_cookies(cookie: &str, set_cookie: Option<&str>) -> String {
    let mut jar: Vec<(String, String)> = cookie
        .split(';')
        .filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .filter(|(k, _)| !k.is_empty())
        .collect();
    for c in SET_COOKIE.captures_iter(set_cookie.unwrap_or("")) {
        jar.retain(|(k, _)| k != &c[1]);
        jar.push((c[1].to_string(), c[2].trim().to_string()));
    }
    jar.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join("; ")
}

async fn call(net: &NetContext, path: &str, body: Value) -> Result<Value> {
    let o = ReqOpts { method: Some(reqwest::Method::POST), body: Some(body.to_string().into_bytes()), timeout_sec: Some(30.0), ..Default::default() }
        .header("Content-Type", "application/json");
    let f = net.fetch_buffer(&format!("{}{}", API, path), &o).await?;
    let v: Value = serde_json::from_slice(&f.body).map_err(|_| Error::new("2Captcha sent an unreadable answer"))?;
    if v["errorId"].as_i64().unwrap_or(0) != 0 {
        let why = v["errorDescription"].as_str().or(v["errorCode"].as_str()).unwrap_or("unknown error");
        return Err(Error::new(format!("2Captcha: {}", why)));
    }
    Ok(v)
}

/// Has 2Captcha solve the challenge and returns the token.
pub async fn solve(net: &NetContext, api_key: &str, c: &Challenge, page_url: &str) -> Result<String> {
    let kind = match (c.kind, c.enterprise) {
        ("recaptcha", true) => "RecaptchaV2EnterpriseTaskProxyless",
        ("recaptcha", false) => "RecaptchaV2TaskProxyless",
        ("hcaptcha", _) => "HCaptchaTaskProxyless",
        _ => "TurnstileTaskProxyless",
    };
    let mut task = json!({ "type": kind, "websiteURL": page_url, "websiteKey": c.site_key });
    if c.invisible {
        task["isInvisible"] = json!(true);
    }
    let created = call(net, "/createTask", json!({ "clientKey": api_key, "task": task })).await?;
    let task_id = created["taskId"].clone();
    for _ in 0..SOLVE_TIMEOUT_SEC / 5 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let r = call(net, "/getTaskResult", json!({ "clientKey": api_key, "taskId": task_id })).await?;
        if r["status"] == "ready" {
            let s = &r["solution"];
            return s["gRecaptchaResponse"].as_str().or(s["token"].as_str()).map(String::from).ok_or_else(|| Error::new("2Captcha returned no token"));
        }
    }
    Err(Error::new(format!("{} was not solved in time", c.label())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_widgets_by_site_key_shape() {
        let r = detect(r#"<div class="g-recaptcha" data-sitekey="6LcABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"></div>"#).unwrap();
        assert_eq!((r.kind, r.invisible, r.enterprise), ("recaptcha", false, false));
        let h = detect(r#"<div class="h-captcha" data-size="invisible" data-sitekey="10000000-ffff-ffff-ffff-000000000001">"#).unwrap();
        assert_eq!((h.kind, h.invisible), ("hcaptcha", true));
        let t = detect(r#"turnstile.render('#w', { sitekey: '0x4AAAAAAAABCDEFGHIJKLMN' })"#).unwrap();
        assert_eq!(t.kind, "turnstile");
        assert_eq!(detect(r#"<script src="https://www.google.com/recaptcha/enterprise.js?render=6LcABCDEFGHIJKLMNOPQRSTUV"></script>"#).unwrap().enterprise, true);
        assert!(detect(r#"<div data-sitekey="not-a-real-key-at-all-xx">"#).is_none());
        assert!(detect("<a href='file.zip'>file</a>").is_none());
    }

    #[test]
    fn fills_in_the_form_around_the_widget() {
        let html = r#"<form action="/search"><input name="q"></form>
            <form method="post" action="go.php?a=1&amp;b=2">
              <input type="hidden" name="id" value="42">
              <input type="checkbox" name="tos" checked>
              <input type="checkbox" name="news">
              <input type="submit" name="go" value="Go">
              <div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>
            </form>"#;
        let c = detect(html).unwrap();
        let f = answer_form(html, "https://host.example/files/page.html", &c, "TOKEN");
        assert_eq!(f.action, "https://host.example/files/go.php?a=1&b=2");
        assert_eq!(f.method, "POST");
        let fields: Vec<(&str, &str)> = f.fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(fields, [("id", "42"), ("tos", ""), ("h-captcha-response", "TOKEN"), ("g-recaptcha-response", "TOKEN")]);
    }

    #[test]
    fn pages_without_a_form_get_the_token_posted_back() {
        let html = r#"<script>grecaptcha.render('x', { 'sitekey': '6LcABCDEFGHIJKLMNOPQRSTUV' })</script>"#;
        let f = answer_form(html, "https://h.example/p", &detect(html).unwrap(), "T");
        assert_eq!(f, Form { action: "https://h.example/p".into(), method: "POST".into(), fields: vec![("g-recaptcha-response".into(), "T".into())] });
    }

    #[test]
    fn merges_set_cookie_into_cookie() {
        let set = "sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, lang=en; HttpOnly";
        assert_eq!(merge_cookies("a=1; sid=old", Some(set)), "a=1; sid=abc; lang=en");
        assert_eq!(merge_cookies("", None), "");
    }
}

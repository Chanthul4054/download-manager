//! System and PAC proxy resolution. The Electron version asked Chromium's resolver; here Windows'
//! own resolver (WinHTTP) answers the same question: the Internet Options proxy, WPAD auto-detect
//! and PAC scripts. The answer uses Chromium's format ("PROXY host:port; DIRECT") so
//! `parse_proxy_string` reads it the same way.

/// Resolves the proxy for `url`. mode: "system" (Windows settings) or "pac" (`pac_url`).
pub async fn resolve(url: String, mode: String, pac_url: String) -> String {
    tokio::task::spawn_blocking(move || imp::resolve(&url, &mode, &pac_url)).await.unwrap_or_else(|_| "DIRECT".into())
}

/// macOS and Linux: "system" means the standard proxy environment variables (http_proxy,
/// https_proxy, ftp_proxy, all_proxy, no_proxy), which desktop proxy settings usually export.
/// shortcut: PAC scripts are not evaluated here (DIRECT), and the macOS/GNOME proxy panels are not
/// read directly; add a PAC engine or a scutil/gsettings reader if users need them.
#[cfg(not(windows))]
mod imp {
    pub fn resolve(url: &str, mode: &str, _pac: &str) -> String {
        if mode == "system" {
            from_env(url, &|k| std::env::var(k).ok()).unwrap_or_else(|| "DIRECT".into())
        } else {
            "DIRECT".into()
        }
    }

    pub(super) fn from_env(url: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        let var = |k: &str| env(k).or_else(|| env(&k.to_uppercase())).filter(|v| !v.trim().is_empty());
        let u = url::Url::parse(url).ok()?;
        let host = u.host_str()?.trim_matches(['[', ']']).to_ascii_lowercase();
        let bypass = var("no_proxy").unwrap_or_default();
        for p in bypass.split(',').map(|p| p.trim().trim_start_matches('*').trim_start_matches('.').to_ascii_lowercase()) {
            let p = p.split(':').next().unwrap_or("");
            if bypass.trim() == "*" || (!p.is_empty() && (host == p || host.ends_with(&format!(".{p}")))) {
                return None;
            }
        }
        let key = match u.scheme() {
            "https" => "https_proxy",
            "ftp" => "ftp_proxy",
            _ => "http_proxy",
        };
        let raw = var(key).or_else(|| var("all_proxy"))?;
        let p = url::Url::parse(&raw).or_else(|_| url::Url::parse(&format!("http://{raw}"))).ok()?;
        let kind = match p.scheme() {
            "socks5" | "socks5h" | "socks" => "SOCKS5",
            "socks4" | "socks4a" => "SOCKS4",
            _ => "PROXY",
        };
        let port = p.port_or_known_default().unwrap_or(if kind == "PROXY" { 80 } else { 1080 });
        Some(format!("{kind} {}:{port}", p.host_str()?))
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::imp::from_env;

    #[test]
    fn env_proxies_follow_scheme_and_no_proxy() {
        let env = |k: &str| match k {
            "http_proxy" => Some("http://proxy.lan:3128".to_string()),
            "ALL_PROXY" => Some("socks5h://sock.lan".to_string()),
            "no_proxy" => Some("localhost, .corp.example".to_string()),
            _ => None,
        };
        assert_eq!(from_env("http://a.com/x", &env).as_deref(), Some("PROXY proxy.lan:3128"));
        assert_eq!(from_env("https://a.com/x", &env).as_deref(), Some("SOCKS5 sock.lan:1080"));
        assert_eq!(from_env("http://files.corp.example/", &env), None);
        assert_eq!(from_env("http://localhost:8080/", &env), None);
        assert_eq!(from_env("http://a.com/", &|_| None), None);
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows::Win32::Networking::WinHttp::*;

    use crate::util::wildcard_match;

    struct Session(usize);
    static SESSION: OnceLock<Session> = OnceLock::new();

    fn session() -> *mut core::ffi::c_void {
        SESSION
            .get_or_init(|| {
                let agent = wide("OpenDM");
                let h = unsafe { WinHttpOpen(PCWSTR(agent.as_ptr()), WINHTTP_ACCESS_TYPE_NO_PROXY, PCWSTR::null(), PCWSTR::null(), 0) };
                Session(h as usize)
            })
            .0 as *mut core::ffi::c_void
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Copies and frees a string WinHTTP allocated.
    fn take(p: PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let s = unsafe { p.to_string().ok() };
        unsafe {
            let _ = GlobalFree(Some(HGLOBAL(p.0 as _)));
        }
        s.filter(|x| !x.trim().is_empty())
    }

    /// Runs WinHTTP's auto-proxy (WPAD and/or a PAC address). None when it found no answer.
    fn auto_proxy(url: &str, pac: Option<&str>, detect: bool) -> Option<(String, Option<String>)> {
        let h = session();
        if h.is_null() {
            return None;
        }
        let url_w = wide(url);
        let pac_w = pac.map(wide);
        let mut opts = WINHTTP_AUTOPROXY_OPTIONS::default();
        if detect {
            opts.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
            opts.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
        }
        if let Some(p) = &pac_w {
            opts.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
            opts.lpszAutoConfigUrl = PCWSTR(p.as_ptr());
        }
        opts.fAutoLogonIfChallenged = true.into();
        let mut info = WINHTTP_PROXY_INFO::default();
        let ok = unsafe { WinHttpGetProxyForUrl(h, PCWSTR(url_w.as_ptr()), &mut opts, &mut info) }.is_ok();
        let proxy = take(info.lpszProxy);
        let bypass = take(info.lpszProxyBypass);
        if !ok {
            return None;
        }
        Some((proxy.unwrap_or_default(), bypass))
    }

    /// Picks the entry for the URL's scheme from a WinHTTP/IE proxy list
    /// ("host:port" or "http=h:p;https=h:p;socks=h:p") and writes it in Chromium's format.
    fn to_chromium(list: &str, scheme: &str) -> String {
        let entries: Vec<&str> = list.split([';', ' ']).map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let mut plain = None;
        let mut socks = None;
        for e in &entries {
            match e.split_once('=') {
                Some((k, v)) if k.eq_ignore_ascii_case(scheme) => return format!("PROXY {}", strip_scheme(v)),
                Some((k, v)) if k.eq_ignore_ascii_case("socks") => socks = Some(strip_scheme(v)),
                Some(_) => {}
                None => {
                    if plain.is_none() {
                        plain = Some(strip_scheme(e));
                    }
                }
            }
        }
        if let Some(p) = plain {
            return format!("PROXY {}", p);
        }
        if let Some(s) = socks {
            return format!("SOCKS {}", s);
        }
        "DIRECT".into()
    }

    fn strip_scheme(v: &str) -> String {
        v.split_once("://").map(|(_, r)| r).unwrap_or(v).trim_end_matches('/').to_string()
    }

    /// IE-style bypass list: "<local>" (no dot in the host) and wildcard hosts.
    fn bypassed(bypass: Option<&str>, url: &str) -> bool {
        let Some(list) = bypass else { return false };
        let host = crate::util::hostname(url);
        list.split([';', ' ', ',']).map(|s| s.trim()).filter(|s| !s.is_empty()).any(|b| {
            if b.eq_ignore_ascii_case("<local>") {
                !host.contains('.')
            } else {
                wildcard_match(strip_scheme(b).as_str(), &host)
            }
        })
    }

    pub fn resolve(url: &str, mode: &str, pac: &str) -> String {
        let scheme = url.split(':').next().unwrap_or("http").to_ascii_lowercase();
        if mode == "pac" {
            return match auto_proxy(url, Some(pac), false) {
                Some((p, _)) if !p.is_empty() => to_chromium(&p, &scheme),
                _ => "DIRECT".into(),
            };
        }
        let mut cfg = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut cfg) }.is_err() {
            return "DIRECT".into();
        }
        let auto_url = take(cfg.lpszAutoConfigUrl);
        let proxy = take(cfg.lpszProxy);
        let bypass = take(cfg.lpszProxyBypass);
        if cfg.fAutoDetect.as_bool() || auto_url.is_some() {
            if let Some((p, _)) = auto_proxy(url, auto_url.as_deref(), cfg.fAutoDetect.as_bool()) {
                if !p.is_empty() {
                    return to_chromium(&p, &scheme);
                }
            }
        }
        match proxy {
            Some(p) if !bypassed(bypass.as_deref(), url) => to_chromium(&p, &scheme),
            _ => "DIRECT".into(),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn proxy_lists_become_chromium_strings() {
            assert_eq!(to_chromium("proxy:8080", "https"), "PROXY proxy:8080");
            assert_eq!(to_chromium("http=a:1;https=b:2", "https"), "PROXY b:2");
            assert_eq!(to_chromium("socks=s:1080", "http"), "SOCKS s:1080");
            assert_eq!(to_chromium("ftp=f:21", "http"), "DIRECT");
            assert!(bypassed(Some("<local>;*.corp"), "http://intranet/x"));
            assert!(bypassed(Some("*.corp"), "http://a.corp/x"));
            assert!(!bypassed(Some("*.corp"), "http://a.com/x"));
        }
    }
}

//! The app core (port of src/main/main.js): windows, menu, tray, browser integration, clipboard
//! monitoring, the command line and every IPC channel the UI uses.
//!
//! The core runs on its own thread with a single-threaded executor, the way the JS main process
//! ran on Node's event loop. The Tauri main thread only forwards IPC calls, menu clicks, tray
//! clicks and window events here as `CoreMsg`s.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter as _, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot};

use crate::cli::parse_args;
use crate::defaults::default_categories;
use crate::engine::ffmpeg::find_ffmpeg;
use crate::engine::hls_download::parse_playlist;
use crate::engine::net::{NetContext, ReqOpts, Resolver};
use crate::engine::{interval, ytdlp};
use crate::error::{Error, Result};
use crate::grabber::{file_presets, new_project, GEvent, GrabberRun};
use crate::integration::{route, IntegrationRequest, IntegrationServer};
use crate::js;
use crate::linkgrabber::{LgEvent, LinkGrabber};
use crate::manager::{DownloadManager, MgrEvent};
use crate::power::{cancel_shutdown, power_action};
use crate::queues::{QEvent, QueueManager};
use crate::store::{deep_merge, Store};
use crate::util as u;

/// Set once quitting starts; the main thread reads it when a window closes or the app is asked to exit.
pub static QUITTING: AtomicBool = AtomicBool::new(false);
/// Mirrors settings.general.minimizeToTray for the main thread's close handler.
pub static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const INVOKE: &[&str] = &[
    "state", "pending",
    "dl:describe", "dl:add", "dl:addMany", "dl:start", "dl:stop", "dl:stopAll", "dl:remove", "dl:removeCompleted", "dl:redownload",
    "dl:update", "dl:stats", "dl:item", "dl:open", "dl:openFolder", "dl:progressWindow", "dl:refreshAddress", "dl:drag",
    "q:list", "q:create", "q:update", "q:remove", "q:start", "q:stop", "q:addItems", "q:removeItems", "q:move",
    "cats:save", "cats:reset", "settings:save", "settings:replaceList", "settings:reset",
    "dialog:folder", "dialog:file", "dialog:confirm",
    "win:open", "win:close", "win:resize", "win:setTitle", "win:showMain", "win:toggleDrop",
    "clip:urls", "clip:write", "util:batch", "util:openExternal", "util:openPath", "util:probe", "util:hlsVariants", "util:ffmpeg", "util:extensionDir", "util:ytdlp", "util:ytdlpInstall", "util:ytdlpInfo", "util:torrentFiles", "util:torrentFirewall",
    "import", "export", "batch:clipboard", "power:run", "power:cancel", "app:quit",
    "grabber:list", "grabber:get", "grabber:new", "grabber:save", "grabber:delete", "grabber:run", "grabber:stop",
    "grabber:setChecked", "grabber:addToList", "grabber:open",
    "lg:state", "lg:add", "lg:confirm", "lg:remove", "lg:removeOffline", "lg:clear", "lg:enable", "lg:updatePackage", "lg:renameLink",
    "lg:merge", "lg:splitByHost", "lg:recheck",
];

pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub enum CoreMsg {
    Invoke { channel: String, args: Vec<Value>, label: String, reply: oneshot::Sender<std::result::Result<Value, String>> },
    Menu(String),
    TrayClick,
    SecondInstance(Vec<String>),
    MainClosing { bounds: Option<Bounds>, maximized: bool },
    WindowDestroyed(String),
    WindowMoved(String, f64, f64),
    Integration(IntegrationRequest, std::sync::mpsc::Sender<(u16, Value)>),
}

/// The handle the Tauri side keeps to talk to the core.
pub struct CoreHandle {
    pub tx: mpsc::UnboundedSender<CoreMsg>,
}

/// Starts the core thread.
pub fn start(handle: AppHandle, tx: mpsc::UnboundedSender<CoreMsg>, rx: mpsc::UnboundedReceiver<CoreMsg>) {
    std::thread::Builder::new()
        .name("opendm-core".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, async move {
                let app = App::new(handle, tx);
                app.clone().run(rx).await;
            });
        })
        .expect("core thread");
}

#[derive(Default, Clone)]
struct ViewOpts {
    key: Option<String>,
    payload: Option<Value>,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    title: String,
    resizable: bool,
    always_on_top: bool,
    frame: bool,
    transparent: bool,
    skip_taskbar: bool,
    minimizable: bool,
    maximizable: bool,
    x: Option<f64>,
    y: Option<f64>,
    minimized: bool,
    inactive: bool,
    background: bool,
}

impl ViewOpts {
    fn new() -> ViewOpts {
        ViewOpts {
            width: 520.0,
            height: 420.0,
            min_width: 360.0,
            min_height: 200.0,
            title: "OpenDM".into(),
            resizable: true,
            frame: true,
            minimizable: true,
            ..Default::default()
        }
    }

    /// Options the renderer passed to `win:open`.
    fn from_value(v: &Value) -> ViewOpts {
        let mut o = ViewOpts::new();
        let n = |k: &str, d: f64| js::num_or(js::get(v, k), d);
        o.key = Some(js::str_of(js::get(v, "key"))).filter(|k| !k.is_empty());
        o.payload = Some(js::get(v, "payload").clone()).filter(|p| js::truthy(p));
        o.width = n("width", 520.0);
        o.height = n("height", 420.0);
        o.min_width = n("minWidth", 360.0);
        o.min_height = n("minHeight", 200.0);
        let t = js::str_of(js::get(v, "title"));
        if !t.is_empty() {
            o.title = t;
        }
        o.resizable = js::get(v, "resizable") != &Value::Bool(false);
        o.always_on_top = js::truthy(js::get(v, "alwaysOnTop"));
        o.frame = js::get(v, "frame") != &Value::Bool(false);
        o.transparent = js::truthy(js::get(v, "transparent"));
        o.skip_taskbar = js::truthy(js::get(v, "skipTaskbar"));
        o.minimizable = js::get(v, "minimizable") != &Value::Bool(false);
        o.maximizable = js::truthy(js::get(v, "maximizable"));
        o.x = js::get(v, "x").as_f64();
        o.y = js::get(v, "y").as_f64();
        o.minimized = js::truthy(js::get(v, "minimized"));
        o.inactive = js::truthy(js::get(v, "inactive"));
        o.background = js::truthy(js::get(v, "background"));
        o
    }
}

/// Menu template entries.
enum M {
    Item(String, String, Option<&'static str>),
    Check(String, String, bool, Option<&'static str>),
    Sep,
    Sub(String, Vec<M>),
}

fn item(id: &str, label: &str) -> M {
    M::Item(id.into(), label.into(), None)
}

fn item_acc(id: &str, label: &str, acc: &'static str) -> M {
    M::Item(id.into(), label.into(), Some(acc))
}

fn check(id: &str, label: &str, on: bool) -> M {
    M::Check(id.into(), label.into(), on, None)
}

fn sub(label: &str, items: Vec<M>) -> M {
    M::Sub(label.into(), items)
}

fn build_items(app: &AppHandle, items: Vec<M>) -> Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for m in items {
        match m {
            M::Item(id, label, acc) => {
                let it = MenuItem::with_id(app, &id, &label, true, acc).or_else(|_| MenuItem::with_id(app, &id, &label, true, None::<&str>))?;
                out.push(Box::new(it));
            }
            M::Check(id, label, on, acc) => {
                let it = CheckMenuItem::with_id(app, &id, &label, true, on, acc).or_else(|_| CheckMenuItem::with_id(app, &id, &label, true, on, None::<&str>))?;
                out.push(Box::new(it));
            }
            M::Sep => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            M::Sub(label, kids) => {
                let kids = build_items(app, kids)?;
                let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|k| k.as_ref()).collect();
                out.push(Box::new(Submenu::with_items(app, &label, true, &refs)?));
            }
        }
    }
    Ok(out)
}

fn build_menu(app: &AppHandle, items: Vec<M>) -> Result<Menu<Wry>> {
    let built = build_items(app, items)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|k| k.as_ref()).collect();
    Ok(Menu::with_items(app, &refs)?)
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(js::str_of).collect()).unwrap_or_default()
}

/// The OS dark-mode setting. On Windows, the "apps use dark mode" setting (Electron's nativeTheme.shouldUseDarkColors for "system").
/// Read from the registry, as Chromium does: the window toolkit's own check misreports it on some
/// Windows builds.
pub fn system_dark() -> bool {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut value: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
                w!("AppsUseLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        return r.is_ok() && value == 0;
    }
    #[cfg(not(windows))]
    {
        // The check starts a helper program, so it runs on its own thread: a stalled `gsettings`
        // (slow D-Bus) or `defaults` must not freeze the event loop that polls this every 2 seconds.
        use std::sync::atomic::{AtomicBool, Ordering};
        static DARK: AtomicBool = AtomicBool::new(false);
        static WATCH: std::sync::Once = std::sync::Once::new();
        WATCH.call_once(|| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || loop {
                DARK.store(read_system_dark(), Ordering::Relaxed);
                let _ = tx.send(());
                std::thread::sleep(std::time::Duration::from_secs(2));
            });
            // Wait briefly for the first answer so the first window opens in the right theme.
            let _ = rx.recv_timeout(std::time::Duration::from_secs(1));
        });
        return DARK.load(Ordering::Relaxed);
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(not(windows))]
fn read_system_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Prints "Dark" only in dark mode; light mode has no such key.
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleInterfaceStyle"]).output();
        return out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "Dark");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // The freedesktop color-scheme key (GNOME 42+, also set by KDE); older desktops name a "-dark" GTK theme.
        let get = |key: &str| {
            std::process::Command::new("gsettings").args(["get", "org.gnome.desktop.interface", key]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase()).unwrap_or_default()
        };
        return get("color-scheme").contains("dark") || get("gtk-theme").contains("-dark");
    }
}

pub struct App {
    me: RefCell<std::rc::Weak<App>>,
    handle: AppHandle,
    tx: mpsc::UnboundedSender<CoreMsg>,
    data_dir: PathBuf,
    store: Rc<Store>,
    net: Rc<NetContext>,
    manager: Rc<DownloadManager>,
    queues: Rc<QueueManager>,
    link_grabber: Rc<LinkGrabber>,
    server: RefCell<IntegrationServer>,
    tray: RefCell<Option<TrayIcon>>,
    has_main: Cell<bool>,
    drop_label: RefCell<Option<String>>,
    /// key → window label
    views: RefCell<HashMap<String, String>>,
    /// label → (key, payload token)
    labels: RefCell<HashMap<String, (String, Option<String>)>>,
    pending: RefCell<HashMap<String, Value>>,
    grab_runs: RefCell<HashMap<String, Rc<GrabberRun>>>,
    interactive: RefCell<HashSet<String>>,
    cli_quit_after: RefCell<HashSet<String>>,
    quitting: Cell<bool>,
    last_clip: RefCell<String>,
    grabber_fired: RefCell<HashSet<String>>,
    win_counter: Cell<u64>,
    dark: Cell<bool>,
}

impl App {
    fn new(handle: AppHandle, tx: mpsc::UnboundedSender<CoreMsg>) -> Rc<App> {
        // Portable/test mode: keep settings and the download list in a custom folder.
        let data_dir = match std::env::var_os("OPENDM_DATA_DIR") {
            Some(d) => std::path::absolute(PathBuf::from(d)).unwrap_or_default(),
            None => dirs::config_dir().unwrap_or_default().join("OpenDM"),
        };
        let store = Store::new(&data_dir);
        let st = store.clone();
        let resolver: Resolver = Rc::new(move |url: String| {
            let p = st.s(&["proxy"]);
            let mode = js::str_of(js::get(&p, "mode"));
            let pac = js::str_of(js::get(&p, "pacUrl"));
            Box::pin(async move {
                if mode == "pac" && pac.is_empty() {
                    // Electron fell back to the system proxy when no PAC address was set.
                    return crate::engine::proxy_resolver::resolve(url, "system".into(), String::new()).await;
                }
                crate::engine::proxy_resolver::resolve(url, mode, pac).await
            })
        });
        let net = NetContext::new(store.clone(), Some(resolver));
        let manager = DownloadManager::new(store.clone(), net.clone());
        let queues = QueueManager::new(store.clone(), manager.clone());
        let link_grabber = LinkGrabber::new(store.clone(), net.clone(), manager.clone());
        if let Ok(res) = handle.path().resource_dir() {
            crate::engine::ffmpeg::set_bundled(PathBuf::from(dunce(res.join("ffmpeg").join(crate::engine::ffmpeg::exe()))));
        }
        let app = Rc::new(App {
            me: RefCell::new(std::rc::Weak::new()),
            handle,
            tx,
            data_dir,
            store,
            net,
            manager,
            queues,
            link_grabber,
            server: RefCell::new(IntegrationServer::default()),
            tray: RefCell::new(None),
            has_main: Cell::new(false),
            drop_label: RefCell::new(None),
            views: RefCell::new(HashMap::new()),
            labels: RefCell::new(HashMap::new()),
            pending: RefCell::new(HashMap::new()),
            grab_runs: RefCell::new(HashMap::new()),
            interactive: RefCell::new(HashSet::new()),
            cli_quit_after: RefCell::new(HashSet::new()),
            quitting: Cell::new(false),
            last_clip: RefCell::new(String::new()),
            grabber_fired: RefCell::new(HashSet::new()),
            win_counter: Cell::new(0),
            dark: Cell::new(false),
        });
        *app.me.borrow_mut() = Rc::downgrade(&app);
        app
    }

    fn rc(&self) -> Rc<App> {
        self.me.borrow().upgrade().expect("app alive")
    }

    fn settings(&self) -> Value {
        self.store.settings()
    }

    // ---- windows -----------------------------------------------------------------------------------

    /// The installer copies the extension next to the app (resources/extension).
    fn extension_dir(&self) -> String {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("extension");
        let packaged = self.handle.path().resource_dir().map(|r| r.join("extension")).ok().filter(|p| p.exists());
        let p = packaged.unwrap_or(dev);
        dunce(p)
    }

    fn bg_color(&self, transparent: bool) -> tauri::window::Color {
        if transparent {
            tauri::window::Color(0, 0, 0, 0)
        } else if self.dark.get() {
            tauri::window::Color(0x1b, 0x1d, 0x21, 255)
        } else {
            tauri::window::Color(0xf6, 0xf7, 0xf9, 255)
        }
    }

    /// The theme every window uses; "system" is resolved here, not left to the window toolkit.
    fn theme(&self) -> Option<tauri::Theme> {
        Some(match js::s(&self.settings()["appearance"]["theme"]) {
            "light" => tauri::Theme::Light,
            "dark" => tauri::Theme::Dark,
            _ if system_dark() => tauri::Theme::Dark,
            _ => tauri::Theme::Light,
        })
    }

    fn main_window(&self) -> Option<WebviewWindow> {
        self.handle.get_webview_window("main")
    }

    fn query(params: &Map<String, Value>) -> String {
        let mut s = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in params {
            s.append_pair(k, &js::str_of(v));
        }
        s.finish()
    }

    /// Wires navigation guards: the UI never navigates away; web links open in the browser.
    fn guarded<'a>(&self, b: WebviewWindowBuilder<'a, Wry, AppHandle>) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
        let h1 = self.handle.clone();
        let h2 = self.handle.clone();
        // `tauri dev` serves the UI over http from its dev server instead of tauri://.
        let dev = self.handle.config().build.dev_url.as_ref().map(|u| u.origin());
        b.on_navigation(move |url| {
            let internal = url.scheme() == "tauri"
                || url.host_str() == Some("tauri.localhost")
                || dev.as_ref() == Some(&url.origin());
            if !internal && (url.scheme() == "http" || url.scheme() == "https") {
                let _ = h1.opener().open_url(url.as_str(), None::<&str>);
            }
            internal
        })
        .on_new_window(move |url, _| {
            if url.scheme() == "http" || url.scheme() == "https" {
                let _ = h2.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
    }

    /// Sizes a window so its outer frame matches the requested size, as Electron's width/height did.
    fn fit_outer(w: &WebviewWindow, width: f64, height: f64, min_w: f64, min_h: f64) {
        let (Ok(outer), Ok(inner), Ok(scale)) = (w.outer_size(), w.inner_size(), w.scale_factor()) else { return };
        let dw = (outer.width as f64 - inner.width as f64) / scale;
        let dh = (outer.height as f64 - inner.height as f64) / scale;
        let _ = w.set_size(LogicalSize::new((width - dw).max(1.0), (height - dh).max(1.0)));
        let _ = w.set_min_size(Some(LogicalSize::new((min_w - dw).max(1.0), (min_h - dh).max(1.0))));
    }

    fn create_main_window(&self, show: bool) {
        let b = self.settings()["appearance"]["window"].clone();
        let width = js::num_or(js::get(&b, "width"), 1100.0);
        let height = js::num_or(js::get(&b, "height"), 680.0);
        let menu = self.menu_template().ok();
        let mut builder = WebviewWindowBuilder::new(&self.handle, "main", WebviewUrl::App("index.html?view=main".into()))
            .title("OpenDM")
            .inner_size(width, height)
            .visible(false)
            .background_color(self.bg_color(false))
            .theme(self.theme());
        if let (Some(x), Some(y)) = (js::get(&b, "x").as_f64(), js::get(&b, "y").as_f64()) {
            builder = builder.position(x, y);
        } else {
            builder = builder.center();
        }
        if let Some(m) = menu {
            builder = builder.menu(m);
        }
        builder = self.guarded(builder).on_page_load(move |w, p| {
            page_title(&w, &p);
            if show && matches!(p.event(), tauri::webview::PageLoadEvent::Finished) && !w.is_visible().unwrap_or(true) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
        match builder.build() {
            Ok(w) => {
                self.apply_color_scheme(&w);
                Self::fit_outer(&w, width, height, 720.0, 420.0);
                if js::truthy(js::get(&b, "maximized")) {
                    let _ = w.maximize();
                }
                self.has_main.set(true);
            }
            Err(e) => eprintln!("[opendm] could not open the main window: {e}"),
        }
    }

    fn save_window_bounds(&self, bounds: Option<Bounds>, maximized: bool) {
        let mut s = self.store.settings.borrow_mut();
        let w = js::get_mut(js::get_mut(&mut s, "appearance"), "window");
        if !w.is_object() {
            *w = json!({});
        }
        if let Some(b) = bounds {
            w["x"] = json!(b.x.round());
            w["y"] = json!(b.y.round());
            w["width"] = json!(b.width.round());
            w["height"] = json!(b.height.round());
        }
        w["maximized"] = json!(maximized);
        drop(s);
        self.store.save("settings");
    }

    fn snapshot_main_bounds(&self) {
        let Some(w) = self.main_window() else { return };
        let maximized = w.is_maximized().unwrap_or(false);
        let bounds = if maximized || w.is_minimized().unwrap_or(false) { None } else { window_bounds(&w) };
        self.save_window_bounds(bounds, maximized);
    }

    fn show_main(&self) {
        match self.main_window() {
            None => self.create_main_window(true),
            Some(w) => {
                if w.is_minimized().unwrap_or(false) {
                    let _ = w.unminimize();
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }

    /// Opens (or focuses) a secondary view. key de-duplicates windows (e.g. one progress window per download).
    fn open_view(&self, view: &str, params: Map<String, Value>, opts: ViewOpts) -> Option<String> {
        let key = opts.key.clone().unwrap_or_else(|| view.to_string());
        let existing = self.views.borrow().get(&key).cloned();
        if let Some(label) = existing {
            if let Some(w) = self.handle.get_webview_window(&label) {
                if let Some(p) = &opts.payload {
                    self.send_to(&label, "payload", vec![p.clone()]);
                }
                if !opts.background {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                return Some(label);
            }
        }
        let mut token = None;
        let mut q = Map::new();
        q.insert("view".into(), json!(view));
        q.extend(params);
        if let Some(p) = &opts.payload {
            let t = u::id();
            self.pending.borrow_mut().insert(t.clone(), p.clone());
            q.insert("token".into(), json!(t));
            token = Some(t);
        }
        let n = self.win_counter.get() + 1;
        self.win_counter.set(n);
        let label = format!("v{}", n);
        let url = format!("index.html?{}", Self::query(&q));
        let show_now = opts.minimized || opts.inactive;
        let mut b = WebviewWindowBuilder::new(&self.handle, &label, WebviewUrl::App(url.into()))
            .title(&opts.title)
            .inner_size(opts.width, opts.height)
            .resizable(opts.resizable)
            .always_on_top(opts.always_on_top)
            .decorations(opts.frame)
            .transparent(opts.transparent)
            .skip_taskbar(opts.skip_taskbar)
            .minimizable(opts.minimizable)
            .maximizable(opts.maximizable)
            .background_color(self.bg_color(opts.transparent))
            .theme(self.theme())
            .visible(show_now)
            .focused(!show_now);
        if let (Some(x), Some(y)) = (opts.x, opts.y) {
            b = b.position(x, y);
        } else {
            b = b.center();
        }
        b = self.guarded(b).on_page_load(move |w, p| {
            page_title(&w, &p);
            if !show_now && matches!(p.event(), tauri::webview::PageLoadEvent::Finished) && !w.is_visible().unwrap_or(true) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
        let w = match b.build() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[opendm] could not open a window: {e}");
                return None;
            }
        };
        self.apply_color_scheme(&w);
        if opts.frame {
            Self::fit_outer(&w, opts.width, opts.height, opts.min_width, opts.min_height);
        } else {
            let _ = w.set_size(LogicalSize::new(opts.width, opts.height));
        }
        if opts.minimized {
            let _ = w.minimize();
        }
        self.views.borrow_mut().insert(key.clone(), label.clone());
        self.labels.borrow_mut().insert(label.clone(), (key, token));
        Some(label)
    }

    fn close_window(&self, label: &str) {
        if let Some(w) = self.handle.get_webview_window(label) {
            let _ = w.close();
        }
    }

    fn on_window_destroyed(&self, label: &str) {
        if label == "main" {
            self.has_main.set(false);
            return;
        }
        if let Some((key, token)) = self.labels.borrow_mut().remove(label) {
            let mut v = self.views.borrow_mut();
            if v.get(&key).map(|l| l == label).unwrap_or(false) {
                v.remove(&key);
            }
            if let Some(t) = token {
                self.pending.borrow_mut().remove(&t);
            }
        }
        if self.drop_label.borrow().as_deref() == Some(label) {
            *self.drop_label.borrow_mut() = None;
            self.build_menu();
        }
    }

    /// Sends an event to every window (`webContents.send` on all of them).
    fn broadcast(&self, channel: &str, args: Vec<Value>) {
        let _ = self.handle.emit("odm", json!({ "channel": channel, "args": args }));
    }

    /// Sends an event to one window.
    fn send_to(&self, label: &str, channel: &str, args: Vec<Value>) {
        let _ = self.handle.emit("odm", json!({ "channel": channel, "args": args, "target": label }));
    }

    fn notify(&self, title: &str, body: &str) {
        let _ = self.handle.notification().builder().title(title).body(body).show();
    }

    fn main_visible(&self) -> bool {
        self.main_window().and_then(|w| w.is_visible().ok()).unwrap_or(false)
    }

    // ---- download flows ----------------------------------------------------------------------------

    /// Entry for every new URL (browser, clipboard, CLI, drop target). Shows "Download File Info" unless silent.
    async fn new_download(&self, payload: Value, silent: bool, start_now: Option<bool>, queue_only: bool) -> Result<Option<Value>> {
        let s = self.settings()["downloads"].clone();
        if !silent && js::truthy(&s["showStartDialog"]) {
            let mut o = ViewOpts::new();
            o.key = Some(format!("newdl:{}", u::id()));
            o.payload = Some(payload);
            o.width = 620.0;
            o.height = 430.0;
            o.title = "Download File Info".into();
            o.always_on_top = true;
            o.resizable = true;
            self.open_view("newdl", Map::new(), o);
            return Ok(None);
        }
        let start = if queue_only { false } else { start_now.unwrap_or(!js::truthy(&s["addOnlyNoStart"])) };
        let mut p = payload;
        p["start"] = json!(false);
        let res = self.manager.add(&p)?;
        let id = js::str_of(&res["item"]["id"]);
        if queue_only {
            self.queues.add_items("main", &[id.clone()], false);
        }
        if start {
            self.start_interactive(&id, !silent);
        }
        Ok(Some(res["item"].clone()))
    }

    fn start_interactive(&self, id: &str, show_progress: bool) {
        if show_progress {
            self.interactive.borrow_mut().insert(id.to_string());
        }
        self.manager.start(id);
    }

    fn open_progress(&self, id: &str) {
        let mode = js::str_of(&self.settings()["downloads"]["progressDialog"]);
        let Some(item) = self.manager.get(id) else { return };
        let mut o = ViewOpts::new();
        o.key = Some(format!("progress:{}", id));
        o.width = 580.0;
        o.height = 560.0;
        o.min_width = 460.0;
        o.min_height = 300.0;
        o.title = item.borrow().file_name.clone();
        o.minimized = mode == "minimized";
        let mut p = Map::new();
        p.insert("id".into(), json!(id));
        self.open_view("progress", p, o);
    }

    fn on_complete(&self, item: &Value) {
        let id = js::str_of(&item["id"]);
        let full = self.manager.get(&id);
        let oc = full.as_ref().map(|f| f.borrow().on_complete.clone()).unwrap_or(Value::Null);
        let want_dialog = match js::get(&oc, "showDialog") {
            Value::Null => js::truthy(&self.settings()["downloads"]["showCompleteDialog"]),
            v => js::truthy(v),
        };
        if let Some(l) = self.views.borrow().get(&format!("progress:{}", id)).cloned() {
            self.close_window(&l);
        }
        if want_dialog && self.interactive.borrow().contains(&id) {
            let mut o = ViewOpts::new();
            o.key = Some(format!("complete:{}", id));
            o.width = 540.0;
            o.height = 300.0;
            o.title = "Download complete".into();
            o.resizable = false;
            o.always_on_top = true;
            let mut p = Map::new();
            p.insert("id".into(), json!(id));
            self.open_view("complete", p, o);
        } else if !self.main_visible() {
            self.notify("Download complete", js::s(&item["fileName"]));
        }
        self.interactive.borrow_mut().remove(&id);
        self.broadcast("sound", vec![json!("complete")]);
        let power = js::str_of(js::get(&oc, "power"));
        if !power.is_empty() && power != "none" {
            self.schedule_shutdown(&power, js::truthy(js::get(&oc, "forceTerminate")), &format!("\"{}\" finished downloading.", js::s(&item["fileName"])));
        } else if js::truthy(js::get(&oc, "exitApp")) {
            self.spawn_quit();
        }
        let quit_now = {
            let mut c = self.cli_quit_after.borrow_mut();
            c.remove(&id) && c.is_empty()
        };
        if quit_now {
            self.spawn_quit();
        }
    }

    fn schedule_shutdown(&self, kind: &str, force: bool, reason: &str) {
        let mut o = ViewOpts::new();
        o.width = 420.0;
        o.height = 220.0;
        o.title = "OpenDM".into();
        o.always_on_top = true;
        o.resizable = false;
        let mut p = Map::new();
        p.insert("kind".into(), json!(kind));
        p.insert("force".into(), json!(if force { 1 } else { 0 }));
        p.insert("reason".into(), json!(reason));
        self.open_view("countdown", p, o);
    }

    fn on_queue_finished(&self, q: &Value) {
        self.broadcast("sound", vec![json!("queueDone")]);
        let oc = js::get(q, "onComplete").clone();
        let run_file = js::str_of(js::get(&oc, "runFile"));
        if !run_file.is_empty() {
            let _ = self.handle.opener().open_path(&run_file, None::<&str>);
        }
        let power = js::str_of(js::get(&oc, "power"));
        if !power.is_empty() && power != "none" {
            self.schedule_shutdown(&power, js::truthy(js::get(&oc, "forceTerminate")), &format!("Queue \"{}\" has finished.", js::s(js::get(q, "name"))));
        } else if js::truthy(js::get(&oc, "exitApp")) {
            let me = self.rc();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(10000)).await;
                me.quit_app().await;
            });
        } else if !self.main_visible() {
            self.notify("Queue finished", js::s(js::get(q, "name")));
        }
    }

    // ---- grabber -----------------------------------------------------------------------------------

    fn grabber_project(&self, id: &str) -> Option<crate::store::ProjectRef> {
        self.store.grabber.borrow().iter().find(|p| js::s(&p.borrow()["id"]) == id).cloned()
    }

    fn run_grabber(&self, id: &str, mode: &str) -> Result<bool> {
        let p = self.grabber_project(id).ok_or_else(|| Error::new("No such project"))?;
        if let Some(r) = self.grab_runs.borrow().get(id) {
            r.stop();
        }
        let run = GrabberRun::new(p.clone(), self.net.clone(), self.manager.clone());
        self.grab_runs.borrow_mut().insert(id.to_string(), run.clone());
        let me = self.rc();
        let pid = id.to_string();
        let pending = Rc::new(Cell::new(false));
        run.events.on(move |e| match e {
            GEvent::Update => {
                if pending.replace(true) {
                    return;
                }
                let (me, pid, pending, p) = (me.clone(), pid.clone(), pending.clone(), p.clone());
                tokio::task::spawn_local(async move {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    pending.set(false);
                    let snapshot = p.borrow().clone();
                    me.broadcast("grabber:update", vec![json!(pid), snapshot]);
                });
            }
            GEvent::Done => {
                me.store.save("grabber");
                let snapshot = p.borrow().clone();
                me.broadcast("grabber:update", vec![json!(pid), snapshot]);
                me.broadcast("grabber:done", vec![json!(pid)]);
            }
        });
        if mode == "download" {
            let r2 = run.clone();
            tokio::task::spawn_local(async move {
                r2.download_checked(None).await;
                r2.running.set(false);
                r2.events.emit(GEvent::Done);
            });
        } else {
            if mode == "explore-download" {
                self.grabber_project(id).unwrap().borrow_mut()["startDownloadAll"] = json!(true);
            }
            match run.start() {
                Ok(fut) => {
                    tokio::task::spawn_local(fut);
                }
                Err(e) => {
                    self.broadcast("grabber:error", vec![json!(id), json!(e.message)]);
                }
            }
        }
        Ok(true)
    }

    fn check_grabber_schedules(&self) {
        let now = chrono::Local::now().naive_local();
        use chrono::{Datelike, Timelike};
        let t = format!("{:02}:{:02}", now.hour(), now.minute());
        let projects = self.store.grabber.borrow().clone();
        for p in projects {
            let (id, s) = {
                let b = p.borrow();
                (js::str_of(&b["id"]), b["schedule"].clone())
            };
            if !js::truthy(js::get(&s, "enabled")) {
                continue;
            }
            let key = format!("{}|{}|{}", id, now.format("%a %b %d %Y"), t);
            if self.grabber_fired.borrow().contains(&key) {
                continue;
            }
            let day = now.weekday().num_days_from_sunday() as f64;
            let day_ok = js::get(&s, "days").as_array().is_some_and(|a| a.iter().any(|x| js::num(x) == day));
            let start_time = js::str_of(js::get(&s, "startTime"));
            let start_min = js::num(&json!(u::js_slice(&start_time, 0, 2))) * 60.0 + js::num(&json!(u::js_slice(&start_time, 3, 99)));
            let now_min = (now.hour() * 60 + now.minute()) as f64;
            let stop_enabled = js::truthy(js::get(&s, "stopEnabled"));
            let stop_time = js::str_of(js::get(&s, "stopTime"));
            let in_window = !stop_enabled || t < stop_time;
            let periodic = js::num(js::get(&s, "periodicMinutes"));
            let due = t == start_time || (periodic > 0.0 && now_min > start_min && in_window && (now_min - start_min) % periodic == 0.0);
            let running = self.grab_runs.borrow().get(&id).is_some_and(|r| r.running.get());
            if day_ok && due && !running {
                self.grabber_fired.borrow_mut().insert(key);
                if periodic > 0.0 {
                    // Synchronization replaces changed files.
                    p.borrow_mut()["overwrite"] = json!(true);
                }
                let action = js::str_of(js::get(&s, "action"));
                let mode = match action.as_str() {
                    "explore" => "explore",
                    "download" => "download",
                    _ => "explore-download",
                };
                let _ = self.run_grabber(&id, mode);
            }
            if stop_enabled && t == stop_time {
                if let Some(r) = self.grab_runs.borrow().get(&id) {
                    r.stop();
                }
            }
        }
    }

    // ---- clipboard ---------------------------------------------------------------------------------

    fn read_clipboard() -> Option<String> {
        arboard::Clipboard::new().ok()?.get_text().ok()
    }

    fn poll_clipboard(&self) {
        let s = self.settings();
        if !js::truthy(&s["general"]["monitorClipboard"]) {
            return;
        }
        let Some(text) = Self::read_clipboard() else { return };
        let text = text.trim().to_string();
        if text.is_empty() || text == *self.last_clip.borrow() {
            return;
        }
        let first = self.last_clip.borrow().is_empty();
        *self.last_clip.borrow_mut() = text.clone();
        if first {
            return;
        }
        if js::truthy(&s["linkGrabber"]["clipboard"]) {
            let links: Vec<Value> = u::extract_urls(&u::js_slice(&text, 0, 1024 * 1024))
                .into_iter()
                .filter(|url| self.manager.find_duplicate(url).is_none())
                .map(|url| json!({ "url": url }))
                .collect();
            if !links.is_empty() && self.link_grabber.add(&json!({ "links": links, "source": "clipboard" })) > 0 {
                self.open_link_grabber(true);
            }
            return;
        }
        if u::js_len(&text) > 2048 || text.chars().any(char::is_whitespace) {
            return;
        }
        let lower = text.to_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://")) {
            return;
        }
        let Ok(parsed) = url::Url::parse(&text) else { return };
        let ext = u::ext_of(parsed.path());
        if ext.is_empty() || !u::split_list(&s["fileTypes"]["capture"]).iter().any(|p| u::wildcard_match(p, &ext)) {
            return;
        }
        if self.manager.find_duplicate(&text).is_some() {
            return;
        }
        let me = self.rc();
        tokio::task::spawn_local(async move {
            let _ = me.new_download(json!({ "url": text, "source": "clipboard" }), false, None, false).await;
        });
    }

    // ---- CLI ---------------------------------------------------------------------------------------

    async fn handle_args(&self, argv: &[String], first: bool) {
        let a = parse_args(argv);
        if a.start_queue {
            self.queues.start("main");
        }
        let Some(url) = a.url.clone() else {
            if !first && !a.start_queue {
                self.show_main();
            }
            return;
        };
        let mut payload = json!({ "url": url, "source": "cli" });
        if let Some(p) = a.path.filter(|p| !p.is_empty()) {
            payload["saveDir"] = json!(p);
        }
        if let Some(f) = a.file.filter(|f| !f.is_empty()) {
            payload["fileName"] = json!(f);
        }
        let r = self.new_download(payload, a.silent || a.add, Some(!a.add), a.add).await;
        if let Ok(Some(item)) = r {
            if a.quit && first {
                self.cli_quit_after.borrow_mut().insert(js::str_of(&item["id"]));
            }
        }
    }

    // ---- menu / tray -------------------------------------------------------------------------------

    /// Shows the main window and passes a menu command to it.
    fn cmd(&self, name: &str, args: Vec<Value>) {
        self.show_main();
        let mut all = vec![json!(name)];
        all.extend(args);
        self.send_to("main", "menu", all);
    }

    fn drop_open(&self) -> bool {
        self.drop_label.borrow().as_ref().is_some_and(|l| self.handle.get_webview_window(l).is_some())
    }

    fn menu_template(&self) -> Result<Menu<Wry>> {
        let s = self.settings();
        let queues = self.queues.list();
        let qitems = |prefix: &str| -> Vec<M> {
            queues.iter().map(|q| item(&format!("{}:{}", prefix, js::s(&q["id"])), js::s(&q["name"]))).collect()
        };
        let sort_key = js::str_of(&s["appearance"]["sort"]["key"]);
        let toolbar = js::str_of(&s["appearance"]["toolbar"]);
        let theme = js::str_of(&s["appearance"]["theme"]);
        let limiter = js::truthy(&s["speedLimiter"]["enabled"]);
        let template = vec![
            sub("&Tasks", vec![
                item_acc("cmd:addUrl", "&Add new download...", "CmdOrCtrl+N"),
                item_acc("cmd:batch", "Add &batch download...", "CmdOrCtrl+B"),
                item("batch-clipboard", "Add batch download from &clipboard"),
                M::Sep,
                item_acc("linkgrabber", "&LinkGrabber...", "CmdOrCtrl+L"),
                item_acc("grabber", "Run site &grabber", "CmdOrCtrl+G"),
                check("drop", "Show &drop target", self.drop_open()),
                M::Sep,
                sub("E&xport", vec![item("export:json", "To OpenDM export &file..."), item("export:txt", "To &text file...")]),
                sub("&Import", vec![item("import:json", "From OpenDM export &file..."), item("import:txt", "From &text file...")]),
                M::Sep,
                item_acc("quit", "E&xit", "CmdOrCtrl+Q"),
            ]),
            sub("&File", vec![
                item("cmd:resume", "&Download Now"),
                item("cmd:stop", "&Stop Download"),
                item("cmd:delete", "&Remove"),
                item("cmd:redownload", "R&edownload"),
                M::Sep,
                item("cmd:open", "&Open"),
                item("cmd:openFolder", "Open &folder"),
                item_acc("cmd:properties", "&Properties", "Alt+Enter"),
            ]),
            sub("&Downloads", vec![
                item("pause-all", "&Pause All"),
                item("stop-all", "&Stop All"),
                M::Sep,
                item("cmd:deleteCompleted", "&Delete All Completed"),
                M::Sep,
                item_acc("cmd:find", "Find...", "CmdOrCtrl+F"),
                item_acc("cmd:findNext", "Find Next", "F3"),
                M::Sep,
                item("cmd:scheduler", "S&cheduler..."),
                sub("Start &queue", qitems("qstart")),
                sub("S&top queue", qitems("qstop")),
                M::Sep,
                sub("Speed &Limiter", vec![
                    check("limiter:on", "Turn o&n", limiter),
                    check("limiter:off", "Turn of&f", !limiter),
                    M::Sep,
                    item("cmd:limiter", "S&ettings..."),
                ]),
                M::Sep,
                item_acc("cmd:options", "&Options...", "CmdOrCtrl+,"),
            ]),
            sub("&View", vec![
                check("hide-categories", "Hide &categories", !js::truthy(&s["appearance"]["showCategories"])),
                sub(
                    "&Arrange files",
                    [
                        ("added", "By &Order Of Addition"), ("name", "By &File Name"), ("size", "By &Size"), ("status", "By St&atus"), ("timeLeft", "By &Time Left"),
                        ("rate", "By Transfer &Rate"), ("lastTry", "By &Last Try Date"), ("description", "By &Description"), ("saveDir", "By Save &Path"), ("referer", "By R&eferer"), ("parentPage", "By Parent &Web Page"),
                    ]
                    .iter()
                    .map(|(k, l)| check(&format!("sort:{}", k), l, sort_key == *k))
                    .collect(),
                ),
                sub("&Toolbar", vec![
                    check("toolbar:large", "&Large Buttons", toolbar == "large"),
                    check("toolbar:small", "&Small Buttons", toolbar == "small"),
                    check("toolbar:icons", "&Icons only", toolbar == "icons"),
                ]),
                item("cmd:columns", "C&ustomize columns..."),
                sub("&Theme", ["system", "light", "dark"].iter().map(|t| {
                    let mut l = t.to_string();
                    l[..1].make_ascii_uppercase();
                    check(&format!("theme:{}", t), &l, theme == *t)
                }).collect()),
                sub("Font", vec![
                    item_acc("font:larger", "Larger", "CmdOrCtrl+="),
                    item_acc("font:smaller", "Smaller", "CmdOrCtrl+-"),
                    item("font:reset", "Reset to default font"),
                ]),
                sub("&Language", vec![check("lang:en", "&English", true)]),
                M::Sep,
                item_acc("devtools", "Developer tools", "CmdOrCtrl+Shift+I"),
            ]),
            sub("&Help", vec![
                item_acc("cmd:help", "H&elp contents", "F1"),
                item("cmd:help:extension", "Browser &extension setup..."),
                item("ext-folder", "Open browser extension folder"),
                item("cmd:help:queues", "&Scheduler and queues"),
                item("cmd:help:linkgrabber", "&LinkGrabber help"),
                item("cmd:help:grabber", "&Grabber help"),
                item("cmd:tip", "Tip of the &Day..."),
                M::Sep,
                item("data-folder", "Open data folder"),
                item("cmd:about", "&About OpenDM"),
            ]),
        ];
        build_menu(&self.handle, template)
    }

    fn build_menu(&self) {
        if let (Some(w), Ok(m)) = (self.main_window(), self.menu_template()) {
            let _ = w.set_menu(m);
        }
        self.update_tray();
    }

    fn tray_menu(&self) -> Result<Menu<Wry>> {
        let s = self.settings();
        build_menu(&self.handle, vec![
            item("tray:open", "Open OpenDM"),
            item("tray:cmd:addUrl", "Add new download..."),
            item("tray:linkgrabber", "LinkGrabber"),
            item("tray:grabber", "Run site grabber"),
            check("tray:drop", "Show drop target", self.drop_open()),
            M::Sep,
            item("tray:main-queue", "Start main queue"),
            item("tray:stop-all", "Stop all downloads"),
            check("tray:limiter", "Speed limiter", js::truthy(&s["speedLimiter"]["enabled"])),
            check("tray:integration", "Browser integration", js::truthy(&s["general"]["browserIntegration"])),
            check("tray:clipboard", "Monitor clipboard", js::truthy(&s["general"]["monitorClipboard"])),
            M::Sep,
            item("tray:quit", "Exit"),
        ])
    }

    fn create_tray(&self) {
        let tx = self.tx.clone();
        let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/icon16.png")).ok().or_else(|| self.handle.default_window_icon().cloned());
        let mut b = TrayIconBuilder::with_id("opendm").tooltip("OpenDM").show_menu_on_left_click(false).on_tray_icon_event(move |_t, e| {
            let hit = matches!(e, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } | TrayIconEvent::DoubleClick { .. });
            if hit {
                let _ = tx.send(CoreMsg::TrayClick);
            }
        });
        if let Some(i) = icon {
            b = b.icon(i);
        }
        if let Ok(m) = self.tray_menu() {
            b = b.menu(&m);
        }
        match b.build(&self.handle) {
            Ok(t) => *self.tray.borrow_mut() = Some(t),
            Err(e) => eprintln!("[opendm] tray icon failed: {e}"),
        }
        self.update_tray();
    }

    fn update_tray(&self) {
        let tray = self.tray.borrow();
        let Some(t) = tray.as_ref() else { return };
        let active = self.manager.active_count();
        let tip = if active > 0 { format!("OpenDM — {} active download{}", active, if active > 1 { "s" } else { "" }) } else { "OpenDM".into() };
        let _ = t.set_tooltip(Some(tip));
        if let Ok(m) = self.tray_menu() {
            let _ = t.set_menu(Some(m));
        }
    }

    async fn on_menu(&self, id: &str) {
        let s = self.settings();
        let id = id.strip_prefix("tray:").map(|x| x.to_string()).unwrap_or_else(|| id.to_string());
        if let Some(rest) = id.strip_prefix("cmd:") {
            let mut parts = rest.splitn(2, ':');
            let name = parts.next().unwrap_or("");
            let extra: Vec<Value> = parts.next().map(|x| vec![json!(x)]).unwrap_or_default();
            return self.cmd(name, extra);
        }
        if let Some(q) = id.strip_prefix("qstart:") {
            return self.queues.start(q);
        }
        if let Some(q) = id.strip_prefix("qstop:") {
            return self.queues.stop(q, true);
        }
        if let Some(k) = id.strip_prefix("sort:") {
            self.save_settings(&json!({ "appearance": { "sort": { "key": k, "dir": "asc" } } }));
            return;
        }
        if let Some(k) = id.strip_prefix("toolbar:") {
            self.save_settings(&json!({ "appearance": { "toolbar": k } }));
            return;
        }
        if let Some(k) = id.strip_prefix("theme:") {
            self.save_settings(&json!({ "appearance": { "theme": k } }));
            return;
        }
        if let Some(k) = id.strip_prefix("export:") {
            return self.export_list(k).await;
        }
        if let Some(k) = id.strip_prefix("import:") {
            return self.import_list(k).await;
        }
        match id.as_str() {
            "batch-clipboard" => self.batch_from_clipboard(),
            "linkgrabber" => self.open_link_grabber(false),
            "grabber" => self.open_grabber(None),
            "drop" => self.toggle_drop_target(),
            "quit" => self.quit_app().await,
            "pause-all" => self.manager.stop_all(),
            "stop-all" => {
                self.queues.stop_all();
                self.manager.stop_all();
            }
            "limiter:on" => self.set_limiter(true),
            "limiter:off" => self.set_limiter(false),
            "hide-categories" => {
                let show = js::truthy(&s["appearance"]["showCategories"]);
                self.save_settings(&json!({ "appearance": { "showCategories": !show } }));
            }
            "font:larger" => {
                let f = js::num(&s["appearance"]["fontSize"]);
                self.save_settings(&json!({ "appearance": { "fontSize": 20f64.min(f + 1.0) } }));
            }
            "font:smaller" => {
                let f = js::num(&s["appearance"]["fontSize"]);
                self.save_settings(&json!({ "appearance": { "fontSize": 10f64.max(f - 1.0) } }));
            }
            "font:reset" => {
                self.save_settings(&json!({ "appearance": { "fontSize": 13 } }));
            }
            "lang:en" => self.build_menu(),
            "devtools" => {
                if let Some(w) = self.handle.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)) {
                    if w.is_devtools_open() {
                        w.close_devtools();
                    } else {
                        w.open_devtools();
                    }
                }
            }
            "ext-folder" => {
                let _ = self.handle.opener().open_path(self.extension_dir(), None::<&str>);
            }
            "data-folder" => {
                let _ = self.handle.opener().open_path(dunce(self.data_dir.clone()), None::<&str>);
            }
            // Tray menu.
            "open" => self.show_main(),
            "main-queue" => self.queues.start("main"),
            "limiter" => self.set_limiter(!js::truthy(&s["speedLimiter"]["enabled"])),
            "integration" => {
                let on = js::truthy(&s["general"]["browserIntegration"]);
                self.save_settings(&json!({ "general": { "browserIntegration": !on } }));
            }
            "clipboard" => {
                let on = js::truthy(&s["general"]["monitorClipboard"]);
                self.save_settings(&json!({ "general": { "monitorClipboard": !on } }));
            }
            _ => {}
        }
    }

    fn set_limiter(&self, on: bool) {
        self.save_settings(&json!({ "speedLimiter": { "enabled": on } }));
    }

    fn toggle_drop_target(&self) {
        if self.drop_open() {
            if let Some(l) = self.drop_label.borrow_mut().take() {
                self.close_window(&l);
            }
        } else {
            let s = self.settings();
            let pos = s["appearance"]["dropPos"].clone();
            let (x, y) = match (pos["x"].as_f64(), pos["y"].as_f64()) {
                (Some(x), Some(y)) => (x, y),
                _ => {
                    let m = self.handle.primary_monitor().ok().flatten();
                    match m {
                        Some(m) => {
                            let wa = m.work_area();
                            let sc = m.scale_factor();
                            (wa.position.x as f64 / sc + wa.size.width as f64 / sc - 110.0, wa.position.y as f64 / sc + wa.size.height as f64 / sc - 110.0)
                        }
                        None => (100.0, 100.0),
                    }
                }
            };
            let mut o = ViewOpts::new();
            o.width = 72.0;
            o.height = 72.0;
            o.min_width = 48.0;
            o.min_height = 48.0;
            o.frame = false;
            o.transparent = true;
            o.always_on_top = true;
            o.skip_taskbar = true;
            o.resizable = false;
            o.x = Some(x);
            o.y = Some(y);
            o.inactive = true;
            o.title = "Drop target".into();
            *self.drop_label.borrow_mut() = self.open_view("drop", Map::new(), o);
        }
        self.build_menu();
    }

    fn open_grabber(&self, project_id: Option<String>) {
        let mut o = ViewOpts::new();
        o.key = Some(format!("grabber:{}", project_id.clone().unwrap_or_else(|| "new".into())));
        o.width = 980.0;
        o.height = 680.0;
        o.min_width = 760.0;
        o.min_height = 480.0;
        o.title = "Site Grabber".into();
        o.maximizable = true;
        let mut p = Map::new();
        if let Some(id) = project_id {
            p.insert("project".into(), json!(id));
        }
        self.open_view("grabber", p, o);
    }

    fn open_link_grabber(&self, background: bool) {
        let mut o = ViewOpts::new();
        o.key = Some("linkgrabber".into());
        o.width = 1080.0;
        o.height = 660.0;
        o.min_width = 760.0;
        o.min_height = 420.0;
        o.title = "LinkGrabber".into();
        o.maximizable = true;
        o.inactive = background;
        o.background = background;
        self.open_view("linkgrabber", Map::new(), o);
    }

    fn message(&self, text: &str) {
        let mut b = self.handle.dialog().message(text).kind(MessageDialogKind::Info).title("OpenDM");
        if let Some(w) = self.main_window() {
            b = b.parent(&w);
        }
        b.show(|_| {});
    }

    fn batch_from_clipboard(&self) {
        let urls = u::extract_urls(&Self::read_clipboard().unwrap_or_default());
        if urls.is_empty() {
            self.message("The clipboard does not contain any web addresses.");
            return;
        }
        let links: Vec<Value> = urls.into_iter().map(|url| json!({ "url": url })).collect();
        self.collect_links(json!({ "links": links, "title": "Batch download from clipboard", "source": "clipboard" }));
    }

    /// A list of links to choose from: goes to the LinkGrabber, or the "Download all links" dialog.
    fn collect_links(&self, payload: Value) {
        if !js::truthy(&self.settings()["linkGrabber"]["useForLinkLists"]) {
            return self.open_links(payload);
        }
        self.link_grabber.add(&json!({
            "links": payload["links"], "referer": payload["referer"], "cookies": payload["cookies"],
            "userAgent": payload["userAgent"], "source": payload["source"],
        }));
        self.open_link_grabber(false);
    }

    fn open_links(&self, payload: Value) {
        let mut o = ViewOpts::new();
        o.key = Some(format!("links:{}", u::id()));
        o.title = {
            let t = js::str_of(js::get(&payload, "title"));
            if t.is_empty() { "Download all links".into() } else { t }
        };
        o.payload = Some(payload);
        o.width = 860.0;
        o.height = 560.0;
        o.min_width = 600.0;
        o.min_height = 360.0;
        o.maximizable = true;
        self.open_view("links", Map::new(), o);
    }

    async fn export_list(&self, kind: &str) {
        let (tx, rx) = oneshot::channel();
        let mut d = self.handle.dialog().file();
        d = if kind == "json" {
            d.set_file_name("opendm-export.json").add_filter("OpenDM export", &["json"])
        } else {
            d.set_file_name("opendm-links.txt").add_filter("Text", &["txt"])
        };
        if let Some(w) = self.main_window() {
            d = d.set_parent(&w);
        }
        d.save_file(move |p| {
            let _ = tx.send(p);
        });
        let Ok(Some(path)) = rx.await else { return };
        let Ok(path) = path.into_path() else { return };
        let list = self.manager.export_list();
        let text = if kind == "json" {
            serde_json::to_string_pretty(&json!({ "app": "OpenDM", "version": 1, "downloads": list })).unwrap_or_default()
        } else {
            list.iter().map(|d| js::str_of(&d["url"])).collect::<Vec<_>>().join("\r\n")
        };
        let _ = tokio::fs::write(path, text).await;
    }

    async fn import_list(&self, kind: &str) {
        let (tx, rx) = oneshot::channel();
        let mut d = self.handle.dialog().file();
        d = if kind == "json" {
            d.add_filter("OpenDM export", &["json"])
        } else {
            d.add_filter("Text / HTML", &["txt", "htm", "html", "csv", "lst"]).add_filter("All files", &["*"])
        };
        if let Some(w) = self.main_window() {
            d = d.set_parent(&w);
        }
        d.pick_file(move |p| {
            let _ = tx.send(p);
        });
        let Ok(Some(path)) = rx.await else { return };
        let Ok(path) = path.into_path() else { return };
        let Ok(text) = tokio::fs::read_to_string(&path).await else { return };
        if kind == "json" {
            let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
            let mut n = 0;
            for d in v["downloads"].as_array().cloned().unwrap_or_default() {
                let o = json!({
                    "url": d["url"], "fileName": d["fileName"], "saveDir": d["saveDir"], "category": d["category"],
                    "description": d["description"], "referer": d["referer"], "duplicateAction": "resume",
                });
                if self.manager.add(&o).is_err() {
                    break;
                }
                n += 1;
            }
            self.message(&format!("Imported {} downloads.", n));
        } else {
            let urls = u::extract_urls(&text);
            if urls.is_empty() {
                return self.message("No web addresses were found in this file.");
            }
            let links: Vec<Value> = urls.into_iter().map(|url| json!({ "url": url })).collect();
            self.collect_links(json!({ "links": links, "title": "Import downloads from text file", "source": "import" }));
        }
    }

    // ---- settings ----------------------------------------------------------------------------------

    fn apply_theme(&self) {
        let theme = self.theme();
        self.dark.set(theme == Some(tauri::Theme::Dark));
        self.handle.set_theme(theme);
        for w in self.handle.webview_windows().values() {
            self.apply_color_scheme(w);
        }
    }

    /// Sets the page's prefers-color-scheme (the UI's light/dark CSS). Tauri derives it from the
    /// window toolkit's theme, which ignores the setting on some Windows builds, so it is set on
    /// the WebView2 profile directly.
    #[cfg_attr(not(windows), allow(unused_variables))]
    fn apply_color_scheme(&self, w: &WebviewWindow) {
        #[cfg(windows)]
        {
            let dark = self.dark.get();
            let _ = w.with_webview(move |pw| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::*;
                use windows_core::Interface;
                let Ok(core) = pw.controller().CoreWebView2() else { return };
                let Ok(c13) = core.cast::<ICoreWebView2_13>() else { return };
                let Ok(profile) = c13.Profile() else { return };
                let _ = profile.SetPreferredColorScheme(if dark { COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK } else { COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT });
            });
        }
    }

    fn apply_proxy(&self) {
        self.net.reset_agents();
    }

    fn apply_startup(&self) {
        if cfg!(debug_assertions) || cfg!(target_os = "linux") {
            return;
        }
        use tauri_plugin_autostart::ManagerExt;
        let al = self.handle.autolaunch();
        let _ = if js::truthy(&self.settings()["general"]["launchOnStartup"]) { al.enable() } else { al.disable() };
    }

    fn save_settings(&self, patch: &Value) -> Value {
        let before = self.settings();
        let mut next = deep_merge(&before, patch);
        // Arrays/lists replace wholesale.
        if let Some(p) = patch.as_object() {
            for (k, v) in p {
                if let Some(o) = v.as_object() {
                    for (k2, v2) in o {
                        if v2.is_array() {
                            *js::get_mut(js::get_mut(&mut next, k), k2) = v2.clone();
                        }
                    }
                }
            }
        }
        *self.store.settings.borrow_mut() = next.clone();
        MINIMIZE_TO_TRAY.store(js::truthy(&next["general"]["minimizeToTray"]), Ordering::SeqCst);
        self.store.save("settings");
        self.manager.apply_speed_limiter();
        self.apply_theme();
        if patch.get("proxy").is_some() || patch.get("connection").is_some() {
            self.apply_proxy();
        }
        let g = js::get(patch, "general");
        if let Some(port) = g.get("integrationPort") {
            if port != &before["general"]["integrationPort"] {
                self.start_server();
            }
        }
        if g.get("launchOnStartup").is_some() {
            self.apply_startup();
        }
        self.build_menu();
        self.broadcast("settings", vec![next.clone()]);
        next
    }

    fn start_server(&self) {
        let port = js::num(&self.settings()["general"]["integrationPort"]);
        let tx = self.tx.clone();
        let handler: crate::integration::Handler = std::sync::Arc::new(move |req| {
            let (rtx, rrx) = std::sync::mpsc::channel();
            if tx.send(CoreMsg::Integration(req, rtx)).is_err() {
                return (503, json!({ "error": "unavailable" }));
            }
            rrx.recv_timeout(Duration::from_secs(30)).unwrap_or((503, json!({ "error": "unavailable" })))
        });
        let r = self.server.borrow_mut().start(if port.is_finite() && port > 0.0 { port as u16 } else { 0 }, handler);
        if let Err(e) = r {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                self.notify(
                    "Browser integration unavailable",
                    &format!("Port {} is in use. Change it in Options → General.", js::fmt_num(port)),
                );
            }
        }
    }

    fn on_integration(&self, req: IntegrationRequest) -> (u16, Value) {
        let s = self.settings();
        let me = self.rc();
        let me2 = self.rc();
        route(
            req,
            &s,
            VERSION,
            move |d| {
                let pick = |k: &str| -> Value {
                    let v = js::get(&d, k);
                    if js::truthy(v) { v.clone() } else { Value::Null }
                };
                let referer = [pick("referrer"), pick("pageUrl")].into_iter().find(js::truthy).unwrap_or(json!(""));
                let mut payload = json!({
                    "url": d["url"], "referer": referer, "parentPage": if js::truthy(&d["pageUrl"]) { d["pageUrl"].clone() } else { json!("") },
                    "cookies": if js::truthy(&d["cookies"]) { d["cookies"].clone() } else { json!("") },
                    "userAgent": if js::truthy(&d["userAgent"]) { d["userAgent"].clone() } else { json!("") },
                    "mime": d["mime"], "size": d["size"], "kind": d["kind"],
                    "description": if js::truthy(&d["title"]) { d["title"].clone() } else { json!("") },
                    "source": "browser", "hls": d["hls"],
                });
                if js::truthy(&d["fileName"]) {
                    payload["fileName"] = d["fileName"].clone();
                }
                if let Some(parts) = d["parts"].as_array() {
                    payload["parts"] = json!(parts.iter().take(2).cloned().collect::<Vec<_>>());
                }
                if d["ytdlp"].is_object() {
                    let q = js::get(&d["ytdlp"], "quality");
                    payload["ytdlp"] = json!({ "quality": if js::truthy(q) { js::str_of(q) } else { "best".into() } });
                }
                if let Some(qs) = d["qualities"].as_array() {
                    payload["qualities"] = json!(qs.iter().take(40).cloned().collect::<Vec<_>>());
                }
                tokio::task::spawn_local(async move {
                    if let Err(e) = me.new_download(payload, false, None, false).await {
                        eprintln!("[integration] could not add download: {}", e.message);
                        me.notify("Could not add download", &e.message);
                    }
                });
            },
            move |d| {
                let title = if js::truthy(&d["selected"]) { "Download selected links" } else { "Download all links" };
                me2.collect_links(json!({ "links": d["links"], "referer": d["pageUrl"], "cookies": d["cookies"], "userAgent": d["userAgent"], "title": title, "source": "browser" }));
            },
        )
    }

    // ---- IPC ---------------------------------------------------------------------------------------

    async fn invoke(&self, channel: &str, args: Vec<Value>, label: &str) -> Result<Value> {
        if !INVOKE.contains(&channel) {
            return Err(Error::new(format!("Blocked channel {}", channel)));
        }
        let a = |i: usize| arg(&args, i);
        let m = &self.manager;
        Ok(match channel {
            "state" => json!({
                "version": VERSION,
                "platform": std::env::consts::OS.replace("windows", "win32").replace("macos", "darwin"),
                "settings": self.settings(),
                "categories": self.store.categories.borrow().clone(),
                "queues": self.queues.list(),
                "items": m.list(),
                "grabberPresets": file_presets(),
            }),
            "pending" => self.pending.borrow().get(&js::str_of(&a(0))).cloned().unwrap_or(Value::Null),

            "dl:describe" => m.describe(&js::str_of(&a(0)), &a(1)).await,
            "dl:add" => {
                let mut opts = a(0);
                let start = js::truthy(js::get(&opts, "start"));
                let queue_id = js::str_of(js::get(&opts, "queueId"));
                let show_progress = match js::get(&opts, "showProgress") {
                    Value::Null => true,
                    v => js::truthy(v),
                };
                if let Some(o) = opts.as_object_mut() {
                    o.remove("queueId");
                    o.remove("showProgress");
                    o.insert("start".into(), json!(false));
                }
                let res = m.add(&opts)?;
                let id = js::str_of(&res["item"]["id"]);
                if !queue_id.is_empty() {
                    self.queues.add_items(&queue_id, &[id.clone()], false);
                }
                if start {
                    self.start_interactive(&id, show_progress);
                }
                res
            }
            "dl:addMany" => {
                let list = a(0).as_array().cloned().unwrap_or_default();
                let o = a(1);
                let mut ids = Vec::new();
                for mut x in list {
                    x["start"] = json!(false);
                    if !js::truthy(js::get(&x, "duplicateAction")) {
                        x["duplicateAction"] = json!("number");
                    }
                    ids.push(js::str_of(&m.add(&x)?["item"]["id"]));
                }
                let qid = js::str_of(js::get(&o, "queueId"));
                if !qid.is_empty() {
                    self.queues.add_items(&qid, &ids, js::truthy(js::get(&o, "top")));
                }
                if js::truthy(js::get(&o, "start")) {
                    for id in &ids {
                        m.start(id);
                    }
                }
                json!(ids)
            }
            "dl:start" => {
                let show = match a(1) {
                    Value::Null => true,
                    v => js::truthy(&v),
                };
                for id in str_list(&a(0)) {
                    self.start_interactive(&id, show);
                }
                Value::Null
            }
            "dl:stop" => {
                for id in str_list(&a(0)) {
                    m.stop(&id, None);
                }
                Value::Null
            }
            "dl:stopAll" => {
                self.queues.stop_all();
                m.stop_all();
                Value::Null
            }
            "dl:remove" => {
                m.remove(&str_list(&a(0)), js::truthy(&a(1))).await;
                Value::Null
            }
            "dl:removeCompleted" => json!(m.remove_completed().await),
            "dl:redownload" => {
                let id = js::str_of(&a(0));
                self.interactive.borrow_mut().insert(id.clone());
                m.redownload(&id, true).await;
                Value::Null
            }
            "dl:update" => m.update(&js::str_of(&a(0)), &a(1)).await?,
            "dl:stats" => m.stats(&js::str_of(&a(0))),
            "dl:item" => match m.get(&js::str_of(&a(0))) {
                Some(it) => {
                    let mut v = m.public_item(&it);
                    let b = it.borrow();
                    v["auth"] = json!(b.auth);
                    v["cookies"] = json!(b.cookies);
                    v
                }
                None => Value::Null,
            },
            "dl:open" => {
                let saved = m.get(&js::str_of(&a(0))).and_then(|it| it.borrow().saved_path.clone());
                match saved {
                    Some(p) => json!(self.open_path(&p)),
                    None => Value::Null,
                }
            }
            "dl:openFolder" => {
                if let Some(it) = m.get(&js::str_of(&a(0))) {
                    let (saved, dir) = {
                        let b = it.borrow();
                        (b.saved_path.clone(), b.save_dir.clone())
                    };
                    match saved {
                        Some(p) => {
                            let _ = self.handle.opener().reveal_item_in_dir(&p);
                        }
                        None => {
                            self.open_path(&dir);
                        }
                    }
                }
                Value::Null
            }
            "dl:progressWindow" => {
                self.open_progress(&js::str_of(&a(0)));
                Value::Null
            }
            "dl:refreshAddress" => m.update(&js::str_of(&a(0)), &json!({ "url": a(1) })).await?,
            "dl:drag" => {
                self.start_drag(&js::str_of(&a(0)), label);
                Value::Null
            }

            "q:list" => json!(self.queues.list()),
            "q:create" => self.queues.create(&js::str_of(&a(0)), &js::str_of(&a(1))),
            "q:update" => self.queues.update(&js::str_of(&a(0)), &a(1)),
            "q:remove" => json!(self.queues.remove(&js::str_of(&a(0)))),
            "q:start" => {
                self.queues.start(&js::str_of(&a(0)));
                Value::Null
            }
            "q:stop" => {
                self.queues.stop(&js::str_of(&a(0)), true);
                Value::Null
            }
            "q:addItems" => {
                self.queues.add_items(&js::str_of(&a(0)), &str_list(&a(1)), js::truthy(js::get(&a(2), "top")));
                Value::Null
            }
            "q:removeItems" => {
                self.queues.remove_items(&js::str_of(&a(0)), &str_list(&a(1)));
                Value::Null
            }
            "q:move" => {
                self.queues.move_items(&js::str_of(&a(0)), &str_list(&a(1)), &js::str_of(&a(2)));
                Value::Null
            }

            "cats:save" => {
                let cats: Vec<Value> = a(0)
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|mut c| {
                        if !js::truthy(js::get(&c, "id")) {
                            *js::get_mut(&mut c, "id") = json!(u::id());
                        }
                        c
                    })
                    .collect();
                *self.store.categories.borrow_mut() = json!(cats);
                self.store.save("categories");
                let c = self.store.categories.borrow().clone();
                self.broadcast("categories", vec![c.clone()]);
                c
            }
            "cats:reset" => {
                *self.store.categories.borrow_mut() = default_categories();
                self.store.save("categories");
                let c = self.store.categories.borrow().clone();
                self.broadcast("categories", vec![c.clone()]);
                c
            }

            "settings:save" => self.save_settings(&a(0)),
            "settings:replaceList" => {
                {
                    let mut s = self.store.settings.borrow_mut();
                    *js::get_mut(js::get_mut(&mut s, &js::str_of(&a(0))), &js::str_of(&a(1))) = a(2);
                }
                self.store.save("settings");
                let s = self.settings();
                self.broadcast("settings", vec![s.clone()]);
                s
            }
            "settings:reset" => {
                self.store.reset_settings();
                self.save_settings(&json!({}))
            }

            "dialog:folder" | "dialog:file" => {
                let (tx, rx) = oneshot::channel();
                let mut d = self.handle.dialog().file();
                let def = js::str_of(&a(0));
                if !def.is_empty() {
                    d = d.set_directory(&def);
                }
                if let Some(w) = self.handle.get_webview_window(label) {
                    d = d.set_parent(&w);
                }
                let send = move |p: Option<tauri_plugin_dialog::FilePath>| {
                    let _ = tx.send(p);
                };
                if js::s(&a(1)) == "torrent" {
                    d = d.add_filter("Torrent files", &["torrent"]);
                }
                if channel == "dialog:folder" {
                    d.pick_folder(send);
                } else {
                    d.pick_file(send);
                }
                match rx.await.ok().flatten().and_then(|p| p.into_path().ok()) {
                    Some(p) => json!(dunce(p)),
                    None => Value::Null,
                }
            }
            "dialog:confirm" => {
                let buttons: Vec<String> = match a(2).as_array() {
                    Some(b) if !b.is_empty() => b.iter().map(js::str_of).collect(),
                    _ => vec!["OK".into(), "Cancel".into()],
                };
                let (tx, rx) = oneshot::channel();
                let mut d = self.handle.dialog().message(js::str_of(&a(0))).kind(MessageDialogKind::Info).title("OpenDM");
                let detail = js::str_of(&a(1));
                if !detail.is_empty() {
                    d = self.handle.dialog().message(format!("{}\n\n{}", js::str_of(&a(0)), detail)).kind(MessageDialogKind::Info).title("OpenDM");
                }
                d = d.buttons(match buttons.len() {
                    1 => MessageDialogButtons::OkCustom(buttons[0].clone()),
                    2 => MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone()),
                    _ => MessageDialogButtons::YesNoCancelCustom(buttons[0].clone(), buttons[1].clone(), buttons[2].clone()),
                });
                if let Some(w) = self.handle.get_webview_window(label) {
                    d = d.parent(&w);
                }
                d.show_with_result(move |r| {
                    let _ = tx.send(r);
                });
                let r = rx.await.unwrap_or(MessageDialogResult::Cancel);
                let idx = match r {
                    MessageDialogResult::Custom(t) => buttons.iter().position(|b| *b == t).unwrap_or(buttons.len() - 1),
                    MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
                    MessageDialogResult::No => 1.min(buttons.len() - 1),
                    MessageDialogResult::Cancel => buttons.len() - 1,
                };
                json!(idx)
            }

            "win:open" => {
                let view = js::str_of(&a(0));
                let params = a(1);
                let opts = a(2);
                match view.as_str() {
                    "grabber" => self.open_grabber(Some(js::str_of(js::get(&params, "project"))).filter(|x| !x.is_empty())),
                    "progress" => self.open_progress(&js::str_of(js::get(&params, "id"))),
                    "links" => self.open_links(if js::truthy(js::get(&opts, "payload")) { opts["payload"].clone() } else { json!({}) }),
                    "linkgrabber" => self.open_link_grabber(false),
                    _ => {
                        self.open_view(&view, params.as_object().cloned().unwrap_or_default(), ViewOpts::from_value(&opts));
                    }
                }
                Value::Null
            }
            "win:close" => {
                self.close_window(label);
                Value::Null
            }
            "win:resize" => {
                if let Some(w) = self.handle.get_webview_window(label) {
                    let _ = w.set_size(LogicalSize::new(js::num(&a(0)).round(), js::num(&a(1)).round()));
                }
                Value::Null
            }
            "win:setTitle" => {
                if let Some(w) = self.handle.get_webview_window(label) {
                    let _ = w.set_title(&js::str_of(&a(0)));
                }
                Value::Null
            }
            "win:showMain" => {
                self.show_main();
                Value::Null
            }
            "win:toggleDrop" => {
                self.toggle_drop_target();
                Value::Null
            }

            "clip:urls" => json!(u::extract_urls(&Self::read_clipboard().unwrap_or_default())),
            "clip:write" => {
                if let Ok(mut c) = arboard::Clipboard::new() {
                    let _ = c.set_text(js::str_of(&a(0)));
                }
                Value::Null
            }
            "util:batch" => json!(u::expand_batch(&js::str_of(&a(0)), &a(1), &a(2), &a(3))?),
            "util:openExternal" => {
                let url = js::str_of(&a(0));
                if url.starts_with("http:") || url.starts_with("https:") {
                    let _ = self.handle.opener().open_url(&url, None::<&str>);
                    Value::Null
                } else {
                    json!(false)
                }
            }
            "util:openPath" => json!(self.open_path(&js::str_of(&a(0)))),
            "util:extensionDir" => json!(self.extension_dir()),
            "util:ffmpeg" => json!(find_ffmpeg(&js::str_of(&self.settings()["videoPanel"]["ffmpegPath"]))),
            "util:ytdlp" => json!(ytdlp::find_ytdlp(&js::str_of(&self.settings()["videoPanel"]["ytdlpPath"]), &self.bin_dir())),
            "util:ytdlpInstall" => json!(ytdlp::install_ytdlp(&self.net, &self.bin_dir()).await?),
            "util:torrentFirewall" => json!(crate::engine::torrent::firewall(js::str_of(&a(0)) == "allow").await?),
            "util:torrentFiles" => crate::engine::torrent::list_files(&self.store, &self.net, &js::str_of(&a(0))).await?,
            "util:ytdlpInfo" => {
                let s = self.settings();
                match ytdlp::find_ytdlp(&js::str_of(&s["videoPanel"]["ytdlpPath"]), &self.bin_dir()) {
                    None => json!({ "missing": true }),
                    Some(bin) => ytdlp::video_info(&bin, &js::str_of(&a(0)), &s).await?,
                }
            }
            "util:probe" => {
                let urls = str_list(&a(0));
                let referer = js::str_of(js::get(&a(1), "referer"));
                let futs: Vec<_> = urls
                    .iter()
                    .map(|url| {
                        let mut o = ReqOpts { timeout_sec: Some(15.0), ..Default::default() };
                        if !referer.is_empty() {
                            o = o.header("Referer", &referer);
                        }
                        let net = self.net.clone();
                        let url = url.clone();
                        async move {
                            let r = match net.probe(&url, &o).await {
                                Ok(p) => json!({ "size": p.size, "type": p.content_type, "status": p.status }),
                                Err(e) => json!({ "error": e.message }),
                            };
                            (url, r)
                        }
                    })
                    .collect();
                let mut out = Map::new();
                for (url, r) in join_all(futs).await {
                    out.insert(url, r);
                }
                Value::Object(out)
            }
            "util:hlsVariants" => {
                let mut o = ReqOpts { max_bytes: Some(4 * 1024 * 1024), ..Default::default() };
                let r = js::str_of(&a(1));
                if !r.is_empty() {
                    o = o.header("Referer", &r);
                }
                let f = self.net.fetch_buffer(&js::str_of(&a(0)), &o).await?;
                let pl = parse_playlist(&String::from_utf8_lossy(&f.body), &f.url)?;
                json!(pl.variants.unwrap_or_default().iter().map(|v| v.to_value()).collect::<Vec<_>>())
            }
            "import" => {
                self.import_list(&js::str_of(&a(0))).await;
                Value::Null
            }
            "export" => {
                self.export_list(&js::str_of(&a(0))).await;
                Value::Null
            }
            "batch:clipboard" => {
                self.batch_from_clipboard();
                Value::Null
            }
            "power:run" => json!(power_action(&js::str_of(&a(0)), js::truthy(&a(1)))),
            "power:cancel" => {
                cancel_shutdown();
                Value::Null
            }
            "app:quit" => {
                self.spawn_quit();
                Value::Null
            }

            "grabber:list" => json!(self
                .store
                .grabber
                .borrow()
                .iter()
                .map(|p| {
                    let p = p.borrow();
                    let id = js::str_of(&p["id"]);
                    let running = self.grab_runs.borrow().get(&id).is_some_and(|r| r.running.get());
                    json!({ "id": id, "name": p["name"], "startUrl": p["startUrl"], "stats": p["stats"], "running": running })
                })
                .collect::<Vec<_>>()),
            "grabber:get" => self.grabber_project(&js::str_of(&a(0))).map(|p| p.borrow().clone()).unwrap_or(Value::Null),
            "grabber:new" => {
                let mut patch = json!({ "saveDir": m.folder_for_category("general") });
                if let Some(o) = a(0).as_object() {
                    for (k, v) in o {
                        patch[k] = v.clone();
                    }
                }
                let p = new_project(&patch);
                self.store.grabber.borrow_mut().push(Rc::new(RefCell::new(p.clone())));
                self.store.save("grabber");
                p
            }
            "grabber:save" => {
                let p = a(0);
                let id = js::str_of(js::get(&p, "id"));
                let existing = self.grabber_project(&id);
                let merged = match &existing {
                    Some(e) => {
                        let mut m2 = e.borrow().clone();
                        if let (Some(t), Some(o)) = (m2.as_object_mut(), p.as_object()) {
                            for (k, v) in o {
                                t.insert(k.clone(), v.clone());
                            }
                        }
                        m2
                    }
                    None => new_project(&p),
                };
                match &existing {
                    // Keep the live run pointed at the same object.
                    Some(e) => *e.borrow_mut() = merged.clone(),
                    None => self.store.grabber.borrow_mut().push(Rc::new(RefCell::new(merged.clone()))),
                }
                self.store.save("grabber");
                self.broadcast("grabber:list", vec![]);
                merged
            }
            "grabber:delete" => {
                let id = js::str_of(&a(0));
                if let Some(r) = self.grab_runs.borrow().get(&id) {
                    r.stop();
                }
                self.store.grabber.borrow_mut().retain(|p| js::s(&p.borrow()["id"]) != id);
                self.store.save("grabber");
                self.broadcast("grabber:list", vec![]);
                Value::Null
            }
            "grabber:run" => {
                let mode = js::str_of(&a(1));
                json!(self.run_grabber(&js::str_of(&a(0)), if mode.is_empty() { "explore" } else { &mode })?)
            }
            "grabber:stop" => {
                if let Some(r) = self.grab_runs.borrow().get(&js::str_of(&a(0))) {
                    r.stop();
                }
                Value::Null
            }
            "grabber:setChecked" => {
                let Some(p) = self.grabber_project(&js::str_of(&a(0))) else { return Ok(Value::Null) };
                let urls: HashSet<String> = str_list(&a(1)).into_iter().collect();
                let checked = a(2);
                {
                    let mut pb = p.borrow_mut();
                    if let Some(files) = pb["results"]["files"].as_array_mut() {
                        for f in files {
                            if urls.is_empty() || urls.contains(js::s(&f["url"])) {
                                f["checked"] = checked.clone();
                            }
                        }
                    }
                }
                self.store.save("grabber");
                let v = p.borrow().clone();
                v
            }
            "grabber:addToList" => {
                let id = js::str_of(&a(0));
                let qid = js::str_of(&a(1));
                let run = match self.grab_runs.borrow().get(&id).cloned() {
                    Some(r) => r,
                    None => {
                        let p = self.grabber_project(&id).ok_or_else(|| Error::new("Cannot read properties of undefined (reading 'results')"))?;
                        GrabberRun::new(p, self.net.clone(), m.clone())
                    }
                };
                let ids = run.add_to_list();
                if !qid.is_empty() {
                    self.queues.add_items(&qid, &ids, false);
                }
                json!(ids.len())
            }
            "grabber:open" => {
                self.open_grabber(Some(js::str_of(&a(0))).filter(|x| !x.is_empty()));
                Value::Null
            }

            "lg:state" => self.link_grabber.snapshot(),
            "lg:add" => {
                let mut opts = a(0);
                if !opts.is_object() {
                    opts = json!({});
                }
                if !js::truthy(js::get(&opts, "source")) {
                    opts["source"] = json!("manual");
                }
                json!(self.link_grabber.add(&opts))
            }
            "lg:confirm" => json!(self.link_grabber.confirm(&str_list(&a(0)), &a(1))),
            "lg:remove" => {
                self.link_grabber.remove(&str_list(&a(0)));
                Value::Null
            }
            "lg:removeOffline" => {
                self.link_grabber.remove_offline();
                Value::Null
            }
            "lg:clear" => {
                self.link_grabber.clear();
                Value::Null
            }
            "lg:enable" => {
                self.link_grabber.set_enabled(&str_list(&a(0)), js::truthy(&a(1)));
                Value::Null
            }
            "lg:updatePackage" => {
                self.link_grabber.update_package(&js::str_of(&a(0)), &a(1));
                Value::Null
            }
            "lg:renameLink" => {
                self.link_grabber.rename_link(&js::str_of(&a(0)), &js::str_of(&a(1)));
                Value::Null
            }
            "lg:merge" => json!(self.link_grabber.merge(&str_list(&a(0)), &js::str_of(&a(1)))),
            "lg:splitByHost" => {
                self.link_grabber.split_by_host(&str_list(&a(0)));
                Value::Null
            }
            "lg:recheck" => {
                self.link_grabber.recheck(&str_list(&a(0)));
                Value::Null
            }
            _ => return Err(Error::new(format!("No handler registered for '{}'", channel))),
        })
    }

    fn bin_dir(&self) -> PathBuf {
        self.data_dir.join("bin")
    }

    /// `shell.openPath`: "" on success, otherwise the error message.
    fn open_path(&self, p: &str) -> String {
        match self.handle.opener().open_path(p, None::<&str>) {
            Ok(()) => String::new(),
            Err(e) => e.to_string(),
        }
    }

    /// Drags a finished file out of the window (to Explorer, a chat, an editor...).
    fn start_drag(&self, id: &str, label: &str) {
        let Some(it) = self.manager.get(id) else { return };
        let Some(path) = it.borrow().saved_path.clone().filter(|p| std::path::Path::new(p).exists()) else { return };
        let Some(w) = self.handle.get_webview_window(label) else { return };
        let _ = self.handle.run_on_main_thread(move || {
            // GTK drags start from the native window; Windows and macOS take the Tauri window.
            #[cfg(target_os = "linux")]
            let Ok(w) = w.gtk_window() else { return };
            let _ = drag::start_drag(
                &w,
                drag::DragItem::Files(vec![PathBuf::from(path)]),
                drag::Image::Raw(include_bytes!("../../assets/icon32.png").to_vec()),
                |_, _| {},
                drag::Options::default(),
            );
        });
    }

    // ---- lifecycle ---------------------------------------------------------------------------------

    fn spawn_quit(&self) {
        let me = self.rc();
        tokio::task::spawn_local(async move { me.quit_app().await });
    }

    async fn quit_app(&self) {
        if self.quitting.replace(true) {
            return;
        }
        QUITTING.store(true, Ordering::SeqCst);
        if self.has_main.get() {
            self.snapshot_main_bounds();
        }
        self.queues.dispose();
        for r in self.grab_runs.borrow().values() {
            r.stop();
        }
        self.link_grabber.dispose();
        self.manager.stop_all();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while self.manager.active_count() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.manager.dispose();
        self.server.borrow_mut().stop();
        self.store.flush_all().await;
        if let Some(t) = self.tray.borrow_mut().take() {
            let _ = t.set_visible(false);
        }
        self.handle.exit(0);
    }

    async fn run(self: Rc<Self>, mut rx: mpsc::UnboundedReceiver<CoreMsg>) {
        MINIMIZE_TO_TRAY.store(js::truthy(&self.settings()["general"]["minimizeToTray"]), Ordering::SeqCst);
        self.apply_theme();
        self.apply_proxy();
        self.start_server();

        let me = self.clone();
        self.manager.events.on(move |e| match e {
            MgrEvent::Changed(it) => me.broadcast("dl:changed", vec![it.clone()]),
            MgrEvent::Removed(ids) => me.broadcast("dl:removed", vec![json!(ids)]),
            MgrEvent::Started(id) => {
                if me.interactive.borrow().contains(id) && js::s(&me.settings()["downloads"]["progressDialog"]) != "none" {
                    me.open_progress(id);
                }
                me.update_tray();
            }
            MgrEvent::Stopped(_) => me.update_tray(),
            MgrEvent::Complete(it) => {
                me.on_complete(it);
                me.update_tray();
            }
            MgrEvent::Failed(it, _) => {
                me.broadcast("sound", vec![json!("failed")]);
                me.interactive.borrow_mut().remove(js::s(&it["id"]));
                me.update_tray();
            }
            MgrEvent::Quota(q) => {
                if js::truthy(js::get(q, "exceeded")) && js::truthy(&me.settings()["connection"]["quota"]["warn"]) {
                    me.notify("Download limit reached", "Downloads will resume automatically when the quota allows.");
                }
            }
            _ => {}
        });
        // Progress is sent in batches every 500 ms.
        let progress: Rc<RefCell<Vec<(String, Value)>>> = Rc::new(RefCell::new(Vec::new()));
        let pb = progress.clone();
        self.manager.events.on(move |e| {
            if let MgrEvent::Progress(id, st) = e {
                let mut b = pb.borrow_mut();
                match b.iter_mut().find(|(x, _)| x == id) {
                    Some(slot) => slot.1 = st.clone(),
                    None => b.push((id.clone(), st.clone())),
                }
            }
        });
        let me = self.clone();
        let _progress_timer = interval(500, move || {
            let buf = std::mem::take(&mut *progress.borrow_mut());
            if buf.is_empty() {
                return;
            }
            // Snapshot items now, not when progress fired, so a finished download is never reported as running.
            let batch: Vec<Value> = buf
                .into_iter()
                .filter_map(|(id, stats)| me.manager.get(&id).map(|it| json!({ "id": id, "item": me.manager.public_item(&it), "stats": stats })))
                .collect();
            me.broadcast("dl:progress", vec![json!(batch)]);
        });
        let me = self.clone();
        self.queues.events.on(move |e| match e {
            QEvent::Changed(list) => {
                me.broadcast("q:changed", vec![json!(list)]);
                me.build_menu();
            }
            QEvent::Finished(q) => me.on_queue_finished(q),
            _ => {}
        });
        let me = self.clone();
        let lg_pending = Rc::new(Cell::new(false));
        self.link_grabber.events.on(move |e| {
            if let LgEvent::Changed = e {
                if lg_pending.replace(true) {
                    return;
                }
                let (me, p) = (me.clone(), lg_pending.clone());
                tokio::task::spawn_local(async move {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    p.set(false);
                    me.broadcast("lg:changed", vec![me.link_grabber.snapshot()]);
                });
            }
        });
        let me = self.clone();
        let _grab_timer = interval(20000, move || me.check_grabber_schedules());
        let me = self.clone();
        let _clip_timer = interval(1000, move || me.poll_clipboard());
        // "system" follows Windows' light/dark setting while the app runs, as Electron's nativeTheme did.
        let me = self.clone();
        let _theme_timer = interval(2000, move || {
            if (me.theme() == Some(tauri::Theme::Dark)) != me.dark.get() {
                me.apply_theme();
            }
        });

        let argv: Vec<String> = std::env::args().skip(1).collect();
        let args = parse_args(&argv);
        self.create_main_window(!args.hidden);
        self.create_tray();
        self.build_menu();
        self.apply_startup();
        let me = self.clone();
        tokio::task::spawn_local(async move { me.handle_args(&argv, true).await });

        while let Some(msg) = rx.recv().await {
            let me = self.clone();
            match msg {
                CoreMsg::Invoke { channel, args, label, reply } => {
                    tokio::task::spawn_local(async move {
                        let r = me.invoke(&channel, args, &label).await.map_err(|e| e.message);
                        let _ = reply.send(r);
                    });
                }
                CoreMsg::Menu(id) => {
                    tokio::task::spawn_local(async move { me.on_menu(&id).await });
                }
                CoreMsg::TrayClick => self.show_main(),
                CoreMsg::SecondInstance(argv) => {
                    tokio::task::spawn_local(async move { me.handle_args(&argv.into_iter().skip(1).collect::<Vec<_>>(), false).await });
                }
                CoreMsg::MainClosing { bounds, maximized } => self.save_window_bounds(bounds, maximized),
                CoreMsg::WindowDestroyed(label) => self.on_window_destroyed(&label),
                CoreMsg::WindowMoved(label, x, y) => {
                    if self.drop_label.borrow().as_deref() == Some(label.as_str()) {
                        {
                            let mut s = self.store.settings.borrow_mut();
                            *js::get_mut(js::get_mut(&mut s, "appearance"), "dropPos") = json!({ "x": x.round(), "y": y.round() });
                        }
                        self.store.save("settings");
                    }
                }
                CoreMsg::Integration(req, reply) => {
                    let _ = reply.send(self.on_integration(req));
                }
            }
        }
    }
}

/// Electron replaced a window's title with the page's <title> ("OpenDM") as the page loaded; the
/// UI then sets its own titles with win:setTitle.
fn page_title(w: &WebviewWindow, p: &tauri::webview::PageLoadPayload<'_>) {
    if matches!(p.event(), tauri::webview::PageLoadEvent::Started) {
        let _ = w.set_title("OpenDM");
    }
}

/// The window's outer bounds in logical pixels (Electron's DIP bounds).
pub fn window_bounds(w: &WebviewWindow) -> Option<Bounds> {
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?;
    let size = w.outer_size().ok()?;
    let p: LogicalPosition<f64> = pos.to_logical(scale);
    let s: LogicalSize<f64> = size.to_logical(scale);
    Some(Bounds { x: p.x, y: p.y, width: s.width, height: s.height })
}

/// A path without Windows' `\\?\` prefix, for showing to people and passing to other programs.
fn dunce(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

async fn join_all<T, F: std::future::Future<Output = T>>(futs: Vec<F>) -> Vec<T> {
    let mut set: Vec<Option<std::pin::Pin<Box<F>>>> = futs.into_iter().map(|f| Some(Box::pin(f))).collect();
    let mut out: Vec<Option<T>> = set.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, slot) in set.iter_mut().enumerate() {
            if let Some(f) = slot {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => {
                        out[i] = Some(v);
                        *slot = None;
                    }
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    out.into_iter().map(|x| x.unwrap()).collect()
}

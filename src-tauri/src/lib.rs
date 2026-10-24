//! OpenDM — a multi-connection download manager. The Tauri shell: plugins, the IPC entry point
//! and main-thread window events. Everything else runs in the app core (`app.rs`).

pub mod app;
pub mod captcha;
pub mod cli;
pub mod defaults;
pub mod diag;
pub mod emitter;
pub mod engine;
pub mod error;
pub mod grabber;
pub mod integration;
pub mod item;
pub mod js;
pub mod linkgrabber;
pub mod manager;
pub mod power;
pub mod queues;
pub mod store;
pub mod util;

use std::sync::atomic::Ordering;

use serde_json::Value;
use tauri::{Manager, RunEvent, WindowEvent};
use tokio::sync::{mpsc, oneshot};

use app::{CoreHandle, CoreMsg, MINIMIZE_TO_TRAY, QUITTING};

/// The one command the UI calls: `api.invoke(channel, ...args)`.
#[tauri::command]
async fn ipc(channel: String, args: Vec<Value>, window: tauri::Window, core: tauri::State<'_, CoreHandle>) -> Result<Value, String> {
    let (reply, rx) = oneshot::channel();
    core.tx
        .send(CoreMsg::Invoke { channel, args, label: window.label().to_string(), reply })
        .map_err(|_| "OpenDM is shutting down".to_string())?;
    rx.await.map_err(|_| "OpenDM is shutting down".to_string())?
}

pub fn run() {
    let (tx, rx) = mpsc::unbounded_channel::<CoreMsg>();
    let tx_si = tx.clone();
    let tx_menu = tx.clone();
    let tx_win = tx.clone();
    let tx_core = tx.clone();
    let mut rx = Some(rx);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |_app, argv, _cwd| {
            let _ = tx_si.send(CoreMsg::SecondInstance(argv));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["/tray"])))
        .manage(CoreHandle { tx })
        .invoke_handler(tauri::generate_handler![ipc])
        .on_menu_event(move |_app, e| {
            let _ = tx_menu.send(CoreMsg::Menu(e.id().0.clone()));
        })
        .on_window_event(move |w, e| match e {
            WindowEvent::CloseRequested { api, .. } if w.label() == "main" => {
                let maximized = w.is_maximized().unwrap_or(false);
                let bounds = if maximized || w.is_minimized().unwrap_or(false) {
                    None
                } else {
                    w.get_webview_window("main").and_then(|ww| app::window_bounds(&ww))
                };
                let _ = tx_win.send(CoreMsg::MainClosing { bounds, maximized });
                if !QUITTING.load(Ordering::SeqCst) && MINIMIZE_TO_TRAY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
            WindowEvent::Destroyed => {
                let _ = tx_win.send(CoreMsg::WindowDestroyed(w.label().to_string()));
            }
            WindowEvent::Moved(p) => {
                let scale = w.scale_factor().unwrap_or(1.0);
                let l = p.to_logical::<f64>(scale);
                let _ = tx_win.send(CoreMsg::WindowMoved(w.label().to_string(), l.x, l.y));
            }
            _ => {}
        })
        .setup(move |a| {
            app::start(a.handle().clone(), tx_core.clone(), rx.take().expect("setup runs once"));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenDM")
        .run(|_app, event| {
            // Keep running in the tray when every window is closed; only quitApp exits.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

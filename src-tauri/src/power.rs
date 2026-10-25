//! System power actions (port of src/main/power.js).
//! kind: shutdown | restart | sleep | hibernate | logoff

use std::process::{Command, Stdio};

fn spawn_detached(cmd: &str, args: &[&str]) {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        c.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    let _ = c.spawn();
}

pub fn power_action(kind: &str, force: bool) -> bool {
    let user = std::env::var("USER").unwrap_or_default();
    let (cmd, args): (&str, Vec<&str>) = if cfg!(windows) {
        let f: Vec<&str> = if force { vec!["/f"] } else { vec![] };
        match kind {
            "shutdown" => ("shutdown", [vec!["/s", "/t", "30"], f].concat()),
            "restart" => ("shutdown", [vec!["/r", "/t", "30"], f].concat()),
            "hibernate" => ("shutdown", vec!["/h"]),
            "logoff" => ("shutdown", [vec!["/l"], f].concat()),
            "sleep" => ("rundll32.exe", vec!["powrprof.dll,SetSuspendState", "0,1,0"]),
            _ => return false,
        }
    } else if cfg!(target_os = "macos") {
        match kind {
            "shutdown" => ("osascript", vec!["-e", "tell app \"System Events\" to shut down"]),
            "restart" => ("osascript", vec!["-e", "tell app \"System Events\" to restart"]),
            "sleep" | "hibernate" => ("pmset", vec!["sleepnow"]),
            "logoff" => ("osascript", vec!["-e", "tell app \"System Events\" to log out"]),
            _ => return false,
        }
    } else {
        match kind {
            "shutdown" => ("systemctl", vec!["poweroff"]),
            "restart" => ("systemctl", vec!["reboot"]),
            "sleep" => ("systemctl", vec!["suspend"]),
            "hibernate" => ("systemctl", vec!["hibernate"]),
            "logoff" => ("loginctl", vec!["terminate-user", user.as_str()]),
            _ => return false,
        }
    };
    spawn_detached(cmd, &args);
    true
}

pub fn cancel_shutdown() {
    if cfg!(windows) {
        spawn_detached("shutdown", &["/a"]);
    }
}

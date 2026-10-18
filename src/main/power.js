'use strict';
const { spawn } = require('child_process');

// Runs a system power action. kind: shutdown | restart | sleep | hibernate | logoff
function powerAction(kind, force = false) {
  const p = process.platform;
  let cmd, args;
  if (p === 'win32') {
    const f = force ? ['/f'] : [];
    const map = {
      shutdown: ['shutdown', ['/s', '/t', '30', ...f]],
      restart: ['shutdown', ['/r', '/t', '30', ...f]],
      hibernate: ['shutdown', ['/h']],
      logoff: ['shutdown', ['/l', ...f]],
      sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
    };
    [cmd, args] = map[kind] || [];
  } else if (p === 'darwin') {
    const map = {
      shutdown: ['osascript', ['-e', 'tell app "System Events" to shut down']],
      restart: ['osascript', ['-e', 'tell app "System Events" to restart']],
      sleep: ['pmset', ['sleepnow']],
      hibernate: ['pmset', ['sleepnow']],
      logoff: ['osascript', ['-e', 'tell app "System Events" to log out']],
    };
    [cmd, args] = map[kind] || [];
  } else {
    const map = {
      shutdown: ['systemctl', ['poweroff']],
      restart: ['systemctl', ['reboot']],
      sleep: ['systemctl', ['suspend']],
      hibernate: ['systemctl', ['hibernate']],
      logoff: ['loginctl', ['terminate-user', process.env.USER || '']],
    };
    [cmd, args] = map[kind] || [];
  }
  if (!cmd) return false;
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function cancelShutdown() {
  if (process.platform === 'win32') spawn('shutdown', ['/a'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { powerAction, cancelShutdown };

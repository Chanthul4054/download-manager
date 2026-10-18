'use strict';

/**
 * Parses command-line switches (both `/x` and `-x` forms):
 *   /d URL   download URL          /p path   save folder        /f name   file name
 *   /a       add to queue only     /n        silent (no dialogs) /q       exit after the download
 *   /h       hang up when done (accepted, no-op)                 /s       start the main queue
 * A bare http(s)/ftp URL is treated as /d URL.
 */
function parseArgs(argv) {
  const out = { url: null, path: null, file: null, add: false, silent: false, quit: false, hangup: false, startQueue: false, hidden: false };
  const takesValue = new Set(['d', 'p', 'f']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^(?:\/|-{1,2})([a-z]+)$/i.exec(a);
    if (m) {
      const k = m[1].toLowerCase();
      const v = takesValue.has(k) ? argv[++i] : null;
      if (k === 'd') out.url = v;
      else if (k === 'p') out.path = v;
      else if (k === 'f') out.file = v;
      else if (k === 'a') out.add = true;
      else if (k === 'n') out.silent = true;
      else if (k === 'q') out.quit = true;
      else if (k === 'h') out.hangup = true;
      else if (k === 's') out.startQueue = true;
      else if (k === 'hidden' || k === 'tray') out.hidden = true;
    } else if (/^(https?|ftp):\/\//i.test(a) && !out.url) out.url = a;
  }
  return out;
}

module.exports = { parseArgs };

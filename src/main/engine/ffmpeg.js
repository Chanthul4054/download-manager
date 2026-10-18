'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

let cached;

/** Finds ffmpeg: the configured path, the bundled ffmpeg-static binary, then PATH. Returns null if none. */
function findFfmpeg(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (cached !== undefined) return cached;
  cached = null;
  try {
    // Inside an asar archive the binary is unpacked next to it.
    const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return (cached = p);
  } catch { /* optional dependency not installed */ }
  const r = spawnSync(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { windowsHide: true });
  if (r.status === 0) cached = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return cached;
}

/** Copies the first video stream of `video` and first audio stream of `audio` into `out` without re-encoding. */
function mux(ffmpeg, video, audio, out, signal) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'];
    if (/\.mp4$/i.test(out)) args.push('-movflags', '+faststart');
    args.push(out);
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d).length > 8000 && (err = err.slice(-4000)));
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error('Merging video and audio failed: ' + (err.trim().split('\n').pop() || `ffmpeg exited with ${code}`)));
    });
  });
}

module.exports = { findFfmpeg, mux };

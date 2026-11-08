// Copies the installers `tauri build` made on this OS into dist/ under a versioned name, and writes
// dist/OpenDM-<version>-manifest.json and dist/SHA256SUMS-<version>.txt (provenance and checksums).
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const v = require('../package.json').version;
const release = 'src-tauri/target/release/';
const bundle = release + 'bundle/';
const outputs = { nsis: ['-setup.exe', `OpenDM-Setup-${v}.exe`], dmg: ['.dmg', `OpenDM-${v}.dmg`], appimage: ['.AppImage', `OpenDM-${v}.AppImage`], deb: ['.deb', `OpenDM-${v}.deb`] };
// The bundle targets in tauri.<os>.conf.json.
const expected = { win32: ['nsis'], darwin: ['dmg'], linux: ['appimage', 'deb'] }[process.platform] || [];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (c) => execSync('git ' + c, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
fs.mkdirSync('dist', { recursive: true });
let missing = 0;
const artifacts = [];
for (const dir of expected) {
  const [ext, out] = outputs[dir];
  // Tauri names files OpenDM_<version>_<arch>…; the version check skips installers left over from older builds.
  const f = fs.existsSync(bundle + dir) && fs.readdirSync(bundle + dir).find((f) => f.includes(`_${v}_`) && f.endsWith(ext));
  if (f) {
    fs.copyFileSync(bundle + dir + '/' + f, 'dist/' + out);
    console.log('dist/' + out);
    artifacts.push({ type: dir, built: bundle + dir + '/' + f, path: 'dist/' + out, sha256: sha(fs.readFileSync('dist/' + out)) });
  } else {
    console.error(`No ${ext} for version ${v} in ${bundle + dir}`);
    missing++;
  }
}
if (missing || !expected.length) process.exit(1);

const exePath = release + (process.platform === 'win32' ? 'opendm.exe' : 'opendm');
const exe = fs.readFileSync(exePath);
const manifest = {
  version: v,
  manifestWritten: new Date().toISOString(),
  exeBuilt: fs.statSync(exePath).mtime.toISOString(),
  source: { commit: git('rev-parse HEAD'), dirty: git('status --porcelain') !== '', diffSha256: sha(git('diff HEAD --binary')) },
  platform: process.platform,
  arch: process.arch,
  exe: { path: exePath, size: exe.length, sha256: sha(exe) },
  artifacts,
};
if (process.platform === 'win32') {
  const pe = exe.readUInt32LE(0x3c);
  manifest.exe.peMachine = '0x' + exe.readUInt16LE(pe + 4).toString(16); // 0x8664 = x64
  if (manifest.exe.peMachine !== '0x8664') throw new Error(`${exePath} is not x64 (${manifest.exe.peMachine})`);
  // Tauri's bundler writes the bundle type into the main binary before it runs NSIS
  // (__TAURI_BUNDLE_TYPE_VAR_UNK → …_NSS) and puts the original back afterwards, so the exe inside
  // the installer differs from target/release/opendm.exe in exactly these 3 bytes.
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const at = exe.indexOf(marker);
  if (at < 0 || exe.indexOf(marker, at + 1) >= 0) throw new Error(`expected exactly one bundle-type marker in ${exePath}`);
  const packaged = Buffer.from(exe);
  packaged.write('NSS', at + marker.length - 3, 'ascii');
  manifest.exe.nsisPackaged = { sha256: sha(packaged), patchOffset: at + marker.length - 3, patch: 'UNK -> NSS (Tauri bundle-type marker)' };
}
fs.writeFileSync(`dist/OpenDM-${v}-manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(`dist/SHA256SUMS-${v}.txt`, artifacts.map((a) => `${a.sha256} *${a.path.replace('dist/', '')}\n`).join(''));
console.log(`dist/OpenDM-${v}-manifest.json`);

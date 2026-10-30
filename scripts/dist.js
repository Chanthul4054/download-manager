// Copies the installers `tauri build` made on this OS into dist/ under a versioned name.
const fs = require('fs');
const v = require('../package.json').version;
const bundle = 'src-tauri/target/release/bundle/';
const outputs = { nsis: ['-setup.exe', `OpenDM-Setup-${v}.exe`], dmg: ['.dmg', `OpenDM-${v}.dmg`], appimage: ['.AppImage', `OpenDM-${v}.AppImage`], deb: ['.deb', `OpenDM-${v}.deb`] };
// The bundle targets in tauri.<os>.conf.json.
const expected = { win32: ['nsis'], darwin: ['dmg'], linux: ['appimage', 'deb'] }[process.platform] || [];
fs.mkdirSync('dist', { recursive: true });
let missing = 0;
for (const dir of expected) {
  const [ext, out] = outputs[dir];
  // Tauri names files OpenDM_<version>_<arch>…; the version check skips installers left over from older builds.
  const f = fs.existsSync(bundle + dir) && fs.readdirSync(bundle + dir).find((f) => f.includes(`_${v}_`) && f.endsWith(ext));
  if (f) {
    fs.copyFileSync(bundle + dir + '/' + f, 'dist/' + out);
    console.log('dist/' + out);
  } else {
    console.error(`No ${ext} for version ${v} in ${bundle + dir}`);
    missing++;
  }
}
if (missing || !expected.length) process.exit(1);

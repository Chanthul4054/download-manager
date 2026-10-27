// Copies the installer `tauri build` made on this OS into dist/ under a versioned name.
const fs = require('fs');
const v = require('../package.json').version;
const bundle = 'src-tauri/target/release/bundle/';
const outputs = { nsis: ['-setup.exe', `OpenDM-Setup-${v}.exe`], dmg: ['.dmg', `OpenDM-${v}.dmg`], appimage: ['.AppImage', `OpenDM-${v}.AppImage`], deb: ['.deb', `OpenDM-${v}.deb`] };
fs.mkdirSync('dist', { recursive: true });
for (const [dir, [ext, out]] of Object.entries(outputs)) {
  const f = fs.existsSync(bundle + dir) && fs.readdirSync(bundle + dir).find((f) => f.endsWith(ext));
  if (f) {
    fs.copyFileSync(bundle + dir + '/' + f, 'dist/' + out);
    console.log('dist/' + out);
  }
}

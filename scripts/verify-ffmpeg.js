// Checks the ffmpeg that ffmpeg-static downloaded at install time before it is bundled into the
// installer: ffmpeg-static fetches it from a GitHub release with no checksum of its own.
// Pins are for ffmpeg-static 5.3.0 (binary release b6.1.1); update them together with that version.
const fs = require('fs');
const crypto = require('crypto');

const PINS = {
  'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  // Fill in from a trusted download: gunzip ffmpeg-<platform>.gz from the b6.1.1 release, then sha256sum.
  'darwin-arm64': '',
  'linux-x64': '',
};

const key = `${process.platform}-${process.arch}`;
const file = `node_modules/ffmpeg-static/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`;
if (!fs.existsSync(file)) {
  console.error(`verify-ffmpeg: ${file} is missing (npm ci installs it)`);
  process.exit(1);
}
const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!PINS[key] || PINS[key] !== got) {
  console.error(`verify-ffmpeg: ${file} for ${key} has SHA-256 ${got}, expected ${PINS[key] || '(no pin)'}`);
  process.exit(1);
}
console.log(`verify-ffmpeg: ${key} ok`);

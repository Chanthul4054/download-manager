'use strict';
// Renders the OpenDM icon (rounded tile with a down arrow into a tray) to PNGs. No dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4; // supersampling for anti-aliasing
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        const a = p[3] / 255;
        acc[0] += p[0] * a; acc[1] += p[1] * a; acc[2] += p[2] * a; acc[3] += a;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / (SS * SS);
      raw[o] = a ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function icon(variant) {
  const top = variant === 'off' ? [120, 126, 138] : [24, 132, 112];
  const bot = variant === 'off' ? [84, 90, 102] : [14, 92, 84];
  const arrow = [[0.42, 0.18], [0.58, 0.18], [0.58, 0.46], [0.72, 0.46], [0.5, 0.68], [0.28, 0.46], [0.42, 0.46]];
  return (x, y) => {
    if (!inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.2)) return [0, 0, 0, 0];
    if (inPoly(x, y, arrow)) return [255, 255, 255, 255];
    const tray = (inRoundRect(x, y, 0.22, 0.74, 0.78, 0.82, 0.03)) || (inRoundRect(x, y, 0.22, 0.6, 0.3, 0.82, 0.03)) || (inRoundRect(x, y, 0.7, 0.6, 0.78, 0.82, 0.03));
    if (tray) return [255, 255, 255, 235];
    const t = y;
    return [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t, 255];
  };
}

const root = path.join(__dirname, '..');
const targets = [
  ['assets', [16, 24, 32, 48, 64, 128, 256], ''],
  ['extension/icons', [16, 32, 48, 128], ''],
];
for (const [dir, sizes] of targets) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const s of sizes) {
    fs.writeFileSync(path.join(root, dir, `icon${s}.png`), png(s, icon('on')));
    fs.writeFileSync(path.join(root, dir, `icon${s}-off.png`), png(s, icon('off')));
  }
}

// Windows .ico with embedded PNGs.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = icoSizes.map((s) => fs.readFileSync(path.join(root, 'assets', `icon${s}.png`)));
const header = Buffer.alloc(6 + 16 * imgs.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(imgs.length, 4);
let offset = header.length;
imgs.forEach((img, i) => {
  const s = icoSizes[i];
  const e = 6 + i * 16;
  header[e] = s >= 256 ? 0 : s; header[e + 1] = s >= 256 ? 0 : s; header[e + 2] = 0; header[e + 3] = 0;
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...imgs]));
console.log('icons written');

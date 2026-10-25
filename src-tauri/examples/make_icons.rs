//! Renders the OpenDM icon (rounded tile with a down arrow into a tray) to PNGs, the Windows .ico
//! and the app's bundle icons (port of scripts/make-icons.js).
//!
//!   cargo run --example make_icons

use std::io::Write;
use std::path::Path;

fn crc32(buf: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in buf {
        let mut c = (crc ^ b as u32) & 0xff;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        crc = (crc >> 8) ^ c;
    }
    crc ^ 0xffff_ffff
}

fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut td = kind.to_vec();
    td.extend_from_slice(data);
    out.extend_from_slice(&td);
    out.extend_from_slice(&crc32(&td).to_be_bytes());
}

fn png(size: usize, pixel: &dyn Fn(f64, f64) -> [f64; 4]) -> Vec<u8> {
    const SS: usize = 4; // supersampling for anti-aliasing
    let row = size * 4 + 1;
    let mut raw = vec![0u8; row * size];
    for y in 0..size {
        for x in 0..size {
            let mut acc = [0.0f64; 4];
            for sy in 0..SS {
                for sx in 0..SS {
                    let p = pixel((x as f64 + (sx as f64 + 0.5) / SS as f64) / size as f64, (y as f64 + (sy as f64 + 0.5) / SS as f64) / size as f64);
                    let a = p[3] / 255.0;
                    acc[0] += p[0] * a;
                    acc[1] += p[1] * a;
                    acc[2] += p[2] * a;
                    acc[3] += a;
                }
            }
            let o = y * row + 1 + x * 4;
            let a = acc[3] / (SS * SS) as f64;
            for c in 0..3 {
                raw[o + c] = if a > 0.0 { (acc[c] / acc[3]).round() as u8 } else { 0 };
            }
            raw[o + 3] = (a * 255.0).round() as u8;
        }
    }
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(size as u32).to_be_bytes());
    ihdr.extend_from_slice(&(size as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&raw).unwrap();
    let idat = z.finish().unwrap();
    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn in_round_rect(x: f64, y: f64, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) -> bool {
    if x < x0 || x > x1 || y < y0 || y > y1 {
        return false;
    }
    let cx = x.max(x0 + r).min(x1 - r);
    let cy = y.max(y0 + r).min(y1 - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

fn in_poly(x: f64, y: f64, pts: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let mut j = pts.len() - 1;
    for i in 0..pts.len() {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn icon(off: bool) -> impl Fn(f64, f64) -> [f64; 4] {
    let top = if off { [120.0, 126.0, 138.0] } else { [24.0, 132.0, 112.0] };
    let bot = if off { [84.0, 90.0, 102.0] } else { [14.0, 92.0, 84.0] };
    let arrow = [(0.42, 0.18), (0.58, 0.18), (0.58, 0.46), (0.72, 0.46), (0.5, 0.68), (0.28, 0.46), (0.42, 0.46)];
    move |x, y| {
        if !in_round_rect(x, y, 0.04, 0.04, 0.96, 0.96, 0.2) {
            return [0.0; 4];
        }
        if in_poly(x, y, &arrow) {
            return [255.0, 255.0, 255.0, 255.0];
        }
        let tray = in_round_rect(x, y, 0.22, 0.74, 0.78, 0.82, 0.03) || in_round_rect(x, y, 0.22, 0.6, 0.3, 0.82, 0.03) || in_round_rect(x, y, 0.7, 0.6, 0.78, 0.82, 0.03);
        if tray {
            return [255.0, 255.0, 255.0, 235.0];
        }
        let t = y;
        [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t, 255.0]
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for (dir, sizes) in [("assets", &[16, 24, 32, 48, 64, 128, 256][..]), ("extension/icons", &[16, 32, 48, 128][..])] {
        let d = root.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        for &s in sizes {
            std::fs::write(d.join(format!("icon{}.png", s)), png(s, &icon(false))).unwrap();
            std::fs::write(d.join(format!("icon{}-off.png", s)), png(s, &icon(true))).unwrap();
        }
    }

    // Windows .ico with embedded PNGs.
    let ico_sizes = [16usize, 24, 32, 48, 64, 128, 256];
    let imgs: Vec<Vec<u8>> = ico_sizes.iter().map(|s| std::fs::read(root.join("assets").join(format!("icon{}.png", s))).unwrap()).collect();
    let mut header = vec![0u8; 6 + 16 * imgs.len()];
    header[2..4].copy_from_slice(&1u16.to_le_bytes());
    header[4..6].copy_from_slice(&(imgs.len() as u16).to_le_bytes());
    let mut offset = header.len() as u32;
    for (i, img) in imgs.iter().enumerate() {
        let s = ico_sizes[i];
        let e = 6 + i * 16;
        header[e] = if s >= 256 { 0 } else { s as u8 };
        header[e + 1] = if s >= 256 { 0 } else { s as u8 };
        header[e + 4..e + 6].copy_from_slice(&1u16.to_le_bytes());
        header[e + 6..e + 8].copy_from_slice(&32u16.to_le_bytes());
        header[e + 8..e + 12].copy_from_slice(&(img.len() as u32).to_le_bytes());
        header[e + 12..e + 16].copy_from_slice(&offset.to_le_bytes());
        offset += img.len() as u32;
    }
    let mut ico = header;
    for img in &imgs {
        ico.extend_from_slice(img);
    }
    std::fs::write(root.join("assets").join("icon.ico"), &ico).unwrap();

    // The app bundle's icons (src-tauri/icons).
    let icons = root.join("src-tauri").join("icons");
    std::fs::create_dir_all(&icons).unwrap();
    std::fs::write(icons.join("icon.ico"), &ico).unwrap();
    for (name, s) in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 256)] {
        std::fs::copy(root.join("assets").join(format!("icon{}.png", s)), icons.join(name)).unwrap();
    }
    println!("icons written");
}

/**
 * Generates the macOS menu-bar (tray) icon as a *template* image:
 * a monochrome kanban-columns glyph (black on transparent) so macOS can
 * auto-invert it for light/dark menu bars. No image libraries required —
 * RGBA pixels are drawn by hand and PNG-encoded with Node's built-in zlib.
 *
 *   node scripts/gen-tray-icon.js
 *   -> assets/kanban/trayTemplate.png      (18x18, @1x)
 *   -> assets/kanban/trayTemplate@2x.png   (36x36, @2x — Electron auto-loads it)
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ── CRC32 (PNG chunk checksums) ───────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Draw the glyph: 3 rounded vertical bars, top-aligned, varied heights ───
function drawColumns(size) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const pad = Math.round(size * 0.15);
  const innerW = size - 2 * pad;
  const innerH = size - 2 * pad;
  const top = pad;
  const gap = innerW * 0.13;
  const colW = (innerW - 2 * gap) / 3;
  const r = Math.max(1, colW * 0.28); // corner radius
  const heights = [1.0, 0.66, 0.84]; // fraction of innerH

  const setBlack = (x, y) => {
    const i = (y * size + x) * 4;
    rgba[i] = 0;
    rgba[i + 1] = 0;
    rgba[i + 2] = 0;
    rgba[i + 3] = 255;
  };

  for (let c = 0; c < 3; c++) {
    const x0 = pad + c * (colW + gap);
    const x1 = x0 + colW;
    const y0 = top;
    const y1 = top + innerH * heights[c];
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        // rounded-rect test (only top corners look rounded; bottoms too, subtle)
        let inside = true;
        const corners = [
          [x0 + r, y0 + r, x < x0 + r, y < y0 + r],
          [x1 - r, y0 + r, x > x1 - r, y < y0 + r],
          [x0 + r, y1 - r, x < x0 + r, y > y1 - r],
          [x1 - r, y1 - r, x > x1 - r, y > y1 - r],
        ];
        for (const [cx, cy, inX, inY] of corners) {
          if (inX && inY) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            if (dx * dx + dy * dy > r * r) inside = false;
          }
        }
        if (inside) setBlack(x, y);
      }
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'assets', 'kanban');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), encodePNG(18, 18, drawColumns(18)));
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), encodePNG(36, 36, drawColumns(36)));
console.log('Wrote trayTemplate.png (18) and trayTemplate@2x.png (36) to', outDir);

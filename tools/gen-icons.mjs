// Generates the PWA icons (PNG) without any dependencies.
// Usage: node tools/gen-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
};
const encodePNG = (w, h, rgba) => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const BG = [5, 7, 10], TEAL = [45, 212, 191];

// u,v in [-0.5, 0.5], already divided by content scale
function shade(u, v) {
  const d = Math.hypot(u, v);
  if (d > 0.45) return BG;
  if (d > 0.405) return TEAL;
  if (d > 0.36) return BG;
  let c = mix([214, 98, 40], [80, 22, 6], Math.pow(d / 0.36, 3));
  const dm = Math.hypot(u + 0.1, v - 0.02);
  c = mix(c, [105, 26, 8], Math.exp(-(dm * dm) / (2 * 0.05 * 0.05)) * 0.75);
  const arc = Math.abs(Math.hypot(u + 0.03, v) - 0.2);
  if (arc < 0.012 && u > -0.13) c = mix(c, [112, 22, 12], 0.9);
  const dd = Math.hypot(u - 0.15, v + 0.01);
  c = mix(c, [255, 228, 165], clamp((0.058 - dd) / 0.02, 0, 1));
  return c;
}

function render(size, scale) {
  const buf = Buffer.alloc(size * size * 4), SS = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = ((x + (sx + 0.5) / SS) / size - 0.5) / scale;
      const v = ((y + (sy + 0.5) / SS) / size - 0.5) / scale;
      const c = shade(u, v);
      acc = acc.map((a, i) => a + c[i]);
    }
    const i = (y * size + x) * 4;
    buf[i] = acc[0] / (SS * SS); buf[i + 1] = acc[1] / (SS * SS); buf[i + 2] = acc[2] / (SS * SS); buf[i + 3] = 255;
  }
  return encodePNG(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, scale] of [
  ['icon-192.png', 192, 1], ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78], ['apple-touch-icon.png', 180, 0.9],
]) {
  fs.writeFileSync(path.join(OUT, name), render(size, scale));
  console.log('wrote', name);
}

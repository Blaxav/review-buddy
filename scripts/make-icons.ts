// Draws the extension icon (a speech bubble on an indigo tile) as PNGs in
// extension/icons. Run once; the PNGs are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZES = [48, 96, 128, 256, 512];
const SUPERSAMPLE = 4;
const INDIGO: Rgba = [79, 70, 229, 255];
const WHITE: Rgba = [255, 255, 255, 255];

type Rgba = [number, number, number, number];

function inRoundedRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(x: number, y: number, [ax, ay, bx, by, cx, cy]: number[]): boolean {
  const side = (px: number, py: number, qx: number, qy: number) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = side(ax!, ay!, bx!, by!);
  const d2 = side(bx!, by!, cx!, cy!);
  const d3 = side(cx!, cy!, ax!, ay!);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Colour of the point (x, y) in a unit square, or null when transparent.
function colorAt(x: number, y: number): Rgba | null {
  if (!inRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  for (const dotX of [0.37, 0.5, 0.63]) {
    if ((x - dotX) ** 2 + (y - 0.45) ** 2 <= 0.045 ** 2) return INDIGO;
  }
  if (inRoundedRect(x, y, 0.2, 0.24, 0.8, 0.66, 0.1)) return WHITE;
  if (inTriangle(x, y, [0.3, 0.64, 0.29, 0.8, 0.46, 0.64])) return WHITE;
  return INDIGO;
}

function render(size: number): Buffer {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const color = colorAt((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
          if (!color) continue;
          for (let c = 0; c < 3; c++) sum[c]! += color[c]! * color[3];
          sum[3]! += color[3];
        }
      }
      const alpha = sum[3]!;
      const offset = row + 1 + px * 4;
      for (let c = 0; c < 3; c++) rows[offset + c] = alpha ? Math.round(sum[c]! / alpha) : 0;
      rows[offset + 3] = Math.round(alpha / samples);
    }
  }
  return encodePng(size, rows);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// `rows` holds each scanline prefixed with filter byte 0, as PNG expects.
function encodePng(size: number, rows: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("extension/icons", { recursive: true });
for (const size of SIZES) writeFileSync(`extension/icons/icon-${size}.png`, render(size));
console.log(`Wrote ${SIZES.length} icons to extension/icons`);

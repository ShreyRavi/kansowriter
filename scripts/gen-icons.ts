// Writes public/icon.svg and public/icon-512.png / icon-192.png (paper square, 2px-style olive line).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const PAPER = [0xf5, 0xf0, 0xe6];
const INK = [0x27, 0x23, 0x20];
const OLIVE = [0x5e, 0x6e, 0x3a];

function png(size: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let c = PAPER;
      const u = x / size, v = y / size;
      if (v > 0.62 && v < 0.655 && u > 0.22 && u < 0.78) c = OLIVE; // progress line
      if (u > 0.47 && u < 0.53 && v > 0.26 && v < 0.56) c = INK; // caret
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(b: Buffer): number {
  let c = ~0;
  for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}
writeFileSync('public/icon-512.png', png(512));
writeFileSync('public/icon-192.png', png(192));
writeFileSync('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="#F5F0E6"/><rect x="47" y="26" width="6" height="30" fill="#272320"/><rect x="22" y="62" width="56" height="3.5" fill="#5E6E3A"/></svg>\n`);
console.log('icons written');

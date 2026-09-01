// 4:5 recap card for X (1080x1350). Zero extra deps — raw PNG + zlib.
import zlib from 'node:zlib';

export const RECAP_CARD_WIDTH = 1080;
export const RECAP_CARD_HEIGHT = 1350;

const GOLD = [201, 162, 39];
const GOLD_DIM = [140, 112, 28];
const CREAM = [236, 230, 214];
const MUTED = [168, 162, 148];
const BG = [18, 16, 14];
const SLAT = [28, 24, 20];
const SLAT_EDGE = [42, 36, 30];

const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '$': ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'M': ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

export function parseRecapCard(text) {
  const source = String(text || '');
  const amountMatch = source.match(/\$[\d,]+(?:\.\d{2})?/);
  const jobMatch = source.match(/(\d+)\s+jobs?/i);
  const amount = amountMatch ? amountMatch[0] : '$0.00';
  const jobs = jobMatch ? Number(jobMatch[1]) : 1;
  const jobLabel = jobs === 1 ? '1 JOB' : `${jobs} JOBS`;
  return { amount, jobs, jobLabel, label: 'YESTERDAY' };
}

function blit(pixels, width, height, text, originX, originY, scale, rgb) {
  const gap = scale;
  let x = originX;
  for (const raw of String(text).toUpperCase()) {
    const glyph = GLYPHS[raw] || GLYPHS[' '];
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = x + col * scale + dx;
            const py = originY + row * scale + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = (py * width + px) * 3;
            pixels[i] = rgb[0];
            pixels[i + 1] = rgb[1];
            pixels[i + 2] = rgb[2];
          }
        }
      }
    }
    x += 5 * scale + gap;
  }
}

function textWidth(text, scale) {
  const n = String(text).length;
  if (!n) return 0;
  return n * 5 * scale + (n - 1) * scale;
}

function fillRect(pixels, width, height, x, y, w, h, rgb) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py += 1) {
    let i = (py * width + x0) * 3;
    for (let px = x0; px < x1; px += 1) {
      pixels[i] = rgb[0];
      pixels[i + 1] = rgb[1];
      pixels[i + 2] = rgb[2];
      i += 3;
    }
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b += 1) {
      const take = crc & 1;
      crc >>>= 1;
      if (take) crc ^= 0xedb88320;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgb, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (width * 3 + 1);
    raw[dest] = 0;
    rgb.copy(raw, dest + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderRecapCardPng(text) {
  const { amount, jobLabel, label } = parseRecapCard(text);
  const width = RECAP_CARD_WIDTH;
  const height = RECAP_CARD_HEIGHT;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = BG[0];
    pixels[i + 1] = BG[1];
    pixels[i + 2] = BG[2];
  }
  const slatW = 28;
  for (let x = 72; x < width - 72; x += slatW) {
    fillRect(pixels, width, height, x, 0, slatW - 6, height, SLAT);
    fillRect(pixels, width, height, x + slatW - 6, 0, 2, height, SLAT_EDGE);
  }
  fillRect(pixels, width, height, 0, 0, 72, height, BG);
  fillRect(pixels, width, height, width - 72, 0, 72, height, BG);
  fillRect(pixels, width, height, 90, 118, width - 180, 8, GOLD_DIM);
  fillRect(pixels, width, height, 90, height - 168, width - 180, 4, GOLD_DIM);
  const amountScale = amount.length > 10 ? 14 : 16;
  blit(pixels, width, height, amount, Math.floor((width - textWidth(amount, amountScale)) / 2), 430, amountScale, GOLD);
  blit(pixels, width, height, label, Math.floor((width - textWidth(label, 8)) / 2), 620, 8, CREAM);
  blit(pixels, width, height, jobLabel, Math.floor((width - textWidth(jobLabel, 7)) / 2), 760, 7, MUTED);
  const brand = 'THE MOUNTING MAN';
  blit(pixels, width, height, brand, Math.floor((width - textWidth(brand, 5)) / 2), 1188, 5, GOLD);
  return encodePng(pixels, width, height);
}

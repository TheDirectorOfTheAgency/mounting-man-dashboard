// lib/install-post-photo-client.mjs
//
// Browser-side photo preparation for the phone card.
//
// The photo is converted to bounded WebP before it leaves the device, and both
// digests are computed there: SHA-256 binds the photo to the job revision, MD5
// is what Webflow signs its asset upload against (SubtleCrypto has no MD5, so
// it is implemented here).
//
// Every browser API is injectable so the logic is testable under `node --test`.

const DEFAULT_MAX_DIMENSION = 2000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_QUALITY_STEPS = Object.freeze([0.85, 0.75, 0.65, 0.5]);

// ---------------------------------------------------------------------------
// MD5 (RFC 1321)
// ---------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

function rotl(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

/** Hex MD5 of a byte array. Pure. */
export function md5Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = new Array(16);
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(offset + i * 4, true);

    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Default browser implementations
// ---------------------------------------------------------------------------

async function defaultLoadImage(file) {
  const bitmap = await globalThis.createImageBitmap(file);
  return { width: bitmap.width, height: bitmap.height, source: bitmap };
}

async function defaultRenderWebP({ source, width, height, quality }) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, width, height);
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas produced no image'))),
      'image/webp',
      quality,
    );
  });
}

function fitWithin(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const ratio = maxDimension / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/**
 * Convert one selected photo to bounded WebP and digest the exact bytes.
 *
 * Fails closed: an oversized photo that cannot be compressed within the budget
 * throws instead of silently uploading something the API would reject.
 */
export async function prepareInstallPhoto(file, {
  maxDimension = DEFAULT_MAX_DIMENSION,
  maxBytes = DEFAULT_MAX_BYTES,
  qualitySteps = DEFAULT_QUALITY_STEPS,
  loadImage = defaultLoadImage,
  renderWebP = defaultRenderWebP,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!file) throw new Error('No file was selected');
  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('That file is not an image');
  }

  const { width, height, source } = await loadImage(file);
  const target = fitWithin(width, height, maxDimension);

  let blob = null;
  for (const quality of qualitySteps) {
    blob = await renderWebP({ source, width: target.width, height: target.height, quality });
    if (blob.size <= maxBytes) break;
    blob = null;
  }
  if (!blob) {
    throw new Error('That photo could not be compressed under the upload limit');
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(await subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    blob,
    bytes: bytes.length,
    contentType: 'image/webp',
    sha256,
    md5: md5Hex(bytes),
    width: target.width,
    height: target.height,
  };
}

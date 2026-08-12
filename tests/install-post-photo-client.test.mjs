import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { md5Hex, prepareInstallPhoto } from '../lib/install-post-photo-client.mjs';

// ---------------------------------------------------------------------------
// MD5 — Webflow signs asset uploads against it, and SubtleCrypto has no MD5.
// ---------------------------------------------------------------------------

test('md5Hex matches the RFC 1321 test vectors', () => {
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(md5Hex(new TextEncoder().encode(input)), expected, input);
  }
});

test('md5Hex agrees with node crypto across block boundaries', () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 1000, 4096, 100000]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);
    const expected = createHash('md5').update(Buffer.from(bytes)).digest('hex');
    assert.equal(md5Hex(bytes), expected, `length ${length}`);
  }
});

// ---------------------------------------------------------------------------
// Bounded WebP conversion
// ---------------------------------------------------------------------------

function fakeBlob(bytes, type = 'image/webp') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    size: data.length,
    type,
    async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
  };
}

function makeDeps({ width = 4032, height = 3024, sizeForQuality = () => 400_000 } = {}) {
  const renders = [];
  return {
    renders,
    deps: {
      async loadImage() { return { width, height, source: 'bitmap' }; },
      async renderWebP({ width: w, height: h, quality }) {
        renders.push({ width: w, height: h, quality });
        return fakeBlob(new Uint8Array(sizeForQuality(quality)).fill(7));
      },
      subtle: {
        async digest(algorithm, data) {
          const name = String(algorithm).toLowerCase().replace('-', '');
          return createHash(name).update(Buffer.from(data)).digest().buffer;
        },
      },
    },
  };
}

test('prepareInstallPhoto downscales to the configured bound and returns both digests', async () => {
  const { deps, renders } = makeDeps();
  const result = await prepareInstallPhoto(fakeBlob([1, 2, 3], 'image/jpeg'), {
    ...deps,
    maxDimension: 2000,
  });

  assert.equal(renders[0].width, 2000);
  assert.equal(renders[0].height, 1500);
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.bytes, 400_000);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.md5, /^[0-9a-f]{32}$/);

  const expectedBytes = new Uint8Array(400_000).fill(7);
  assert.equal(result.sha256, createHash('sha256').update(Buffer.from(expectedBytes)).digest('hex'));
  assert.equal(result.md5, md5Hex(expectedBytes));
});

test('prepareInstallPhoto leaves already-small images at their native size', async () => {
  const { deps, renders } = makeDeps({ width: 1200, height: 900 });
  await prepareInstallPhoto(fakeBlob([1], 'image/png'), { ...deps, maxDimension: 2000 });
  assert.equal(renders[0].width, 1200);
  assert.equal(renders[0].height, 900);
});

test('prepareInstallPhoto steps quality down until it fits the byte budget', async () => {
  const sizes = { 0.85: 9_000_000, 0.75: 7_000_000, 0.65: 3_000_000 };
  const { deps, renders } = makeDeps({ sizeForQuality: (q) => sizes[q] ?? 1_000_000 });

  const result = await prepareInstallPhoto(fakeBlob([1], 'image/jpeg'), {
    ...deps,
    maxBytes: 5 * 1024 * 1024,
  });

  assert.deepEqual(renders.map((r) => r.quality), [0.85, 0.75, 0.65]);
  assert.equal(result.bytes, 3_000_000);
});

test('prepareInstallPhoto fails closed when nothing fits the byte budget', async () => {
  const { deps } = makeDeps({ sizeForQuality: () => 20_000_000 });
  await assert.rejects(
    prepareInstallPhoto(fakeBlob([1], 'image/jpeg'), { ...deps, maxBytes: 5 * 1024 * 1024 }),
    /could not be compressed/i,
  );
});

test('prepareInstallPhoto rejects non-image input before touching the canvas', async () => {
  const { deps, renders } = makeDeps();
  await assert.rejects(
    prepareInstallPhoto(fakeBlob([1], 'application/pdf'), deps),
    /not an image/i,
  );
  await assert.rejects(prepareInstallPhoto(null, deps), /no file/i);
  assert.equal(renders.length, 0);
});

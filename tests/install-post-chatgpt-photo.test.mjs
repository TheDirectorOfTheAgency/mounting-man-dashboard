import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  MAX_CHATGPT_PHOTO_INPUT_BYTES,
  createWebflowPhotoStore,
  downloadChatGptPhoto,
  normalizeInstallationPhoto,
  validateChatGptFileDescriptor,
} from '../lib/install-post-chatgpt-photo.mjs';

async function image(format, options = {}) {
  let pipeline = sharp({
    create: {
      width: options.width || 32,
      height: options.height || 24,
      channels: 3,
      background: { r: 13, g: 92, b: 121 },
    },
  });
  if (options.metadata) pipeline = pipeline.withMetadata({ orientation: 6 });
  return pipeline[format]().toBuffer();
}

for (const [format, contentType] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
  test(`normalizes valid ${format} bytes to bounded metadata-free WebP`, async () => {
    const input = await image(format, { metadata: true });
    const normalized = await normalizeInstallationPhoto({
      imageBase64: input.toString('base64'),
      contentType,
    });
    assert.equal(normalized.contentType, 'image/webp');
    assert.match(normalized.sha256, /^[0-9a-f]{64}$/);
    assert.match(normalized.md5, /^[0-9a-f]{32}$/);
    assert.equal(normalized.bytes, normalized.buffer.length);
    const metadata = await sharp(normalized.buffer).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.orientation, undefined);
  });
}

test('rejects MIME spoofing, malformed base64, unsupported types, and oversized payloads', async () => {
  const jpeg = await image('jpeg');
  await assert.rejects(
    normalizeInstallationPhoto({ imageBase64: jpeg.toString('base64'), contentType: 'image/png' }),
    /image_type_mismatch/,
  );
  await assert.rejects(
    normalizeInstallationPhoto({ imageBase64: 'not base64', contentType: 'image/jpeg' }),
    /invalid_image_base64/,
  );
  await assert.rejects(
    normalizeInstallationPhoto({ imageBase64: jpeg.toString('base64'), contentType: 'image/svg+xml' }),
    /unsupported_image_type/,
  );
  await assert.rejects(
    normalizeInstallationPhoto({
      imageBase64: Buffer.alloc(MAX_CHATGPT_PHOTO_INPUT_BYTES + 1).toString('base64'),
      contentType: 'image/jpeg',
    }),
    /image_too_large/,
  );
});

test('rejects absurd dimensions before normalization', async () => {
  const tooWide = await image('png', { width: 12001, height: 1 });
  await assert.rejects(
    normalizeInstallationPhoto({ imageBase64: tooWide.toString('base64'), contentType: 'image/png' }),
    /invalid_image_dimensions/,
  );
});

test('accepts only allowlisted HTTPS ChatGPT file descriptors and refuses redirects', async () => {
  const descriptor = {
    download_url: 'https://files.openai.example/download/signed?opaque=1',
    file_id: 'file_123',
    mime_type: 'image/jpeg',
  };
  assert.equal(validateChatGptFileDescriptor(descriptor, {
    allowedHosts: ['files.openai.example'],
  }).fileId, 'file_123');
  assert.throws(() => validateChatGptFileDescriptor({
    ...descriptor,
    download_url: 'http://files.openai.example/photo',
  }, { allowedHosts: ['files.openai.example'] }), /unsafe_download_url/);
  assert.throws(() => validateChatGptFileDescriptor({
    ...descriptor,
    download_url: 'https://127.0.0.1/photo',
  }, { allowedHosts: ['127.0.0.1'] }), /unsafe_download_url/);
  assert.throws(() => validateChatGptFileDescriptor({
    ...descriptor,
    download_url: 'https://[::ffff:127.0.0.1]/photo',
  }, { allowedHosts: ['[::ffff:7f00:1]'] }), /unsafe_download_url/);
  assert.throws(() => validateChatGptFileDescriptor(descriptor, {
    allowedHosts: ['other.example'],
  }), /download_host_not_allowed/);

  await assert.rejects(downloadChatGptPhoto(descriptor, {
    allowedHosts: ['files.openai.example'],
    async lookupImpl() { return [{ address: '203.0.113.10', family: 4 }]; },
    async fetchImpl() {
      return { ok: false, status: 302, headers: new Headers() };
    },
  }), /photo_download_failed/);
});

test('downloads a bounded declared image without exposing the signed URL', async () => {
  const bytes = await image('jpeg');
  const result = await downloadChatGptPhoto({
    download_url: 'https://files.openai.example/download/private-token',
    file_id: 'file_456',
    mime_type: 'image/jpeg',
  }, {
    allowedHosts: ['files.openai.example'],
    async lookupImpl() { return [{ address: '203.0.113.10', family: 4 }]; },
    async fetchImpl(_url, options) {
      assert.equal(options.redirect, 'manual');
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(result.fileId, 'file_456');
  assert.deepEqual(Buffer.from(result.imageBase64, 'base64'), bytes);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test('rejects an allowlisted hostname when DNS resolves to a private address', async () => {
  await assert.rejects(downloadChatGptPhoto({
    download_url: 'https://files.openai.example/opaque',
    file_id: 'file_private',
    mime_type: 'image/jpeg',
  }, {
    allowedHosts: ['files.openai.example'],
    async lookupImpl() { return [{ address: '10.0.0.5', family: 4 }]; },
    async fetchImpl() { throw new Error('must not fetch'); },
  }), /unsafe_download_host/);
});

test('Webflow photo store keeps credentials server-side and uploads normalized bytes', async () => {
  const normalized = await normalizeInstallationPhoto({
    imageBase64: (await image('jpeg')).toString('base64'),
    contentType: 'image/jpeg',
  });
  let signedRequest;
  let uploadedRequest;
  const store = createWebflowPhotoStore({
    siteId: 'site-1',
    token: 'server-secret',
    httpClient: {
      async post(url, body, config) {
        signedRequest = { url, body, config };
        return {
          data: {
            id: 'asset-1',
            hostedUrl: 'https://cdn.example.test/asset.webp',
            uploadUrl: 'https://uploads.example.test/',
            uploadDetails: { key: 'opaque/object' },
          },
        };
      },
    },
    async uploadClient(url, options) {
      uploadedRequest = { url, options };
      return { ok: true };
    },
  });
  const stored = await store.store({
    record: { jobId: 'job_1', revision: 'abcdef1234', seed: { city: 'Austin', 'tv-size': '65-inch' } },
    normalized,
  });
  assert.equal(stored.assetId, 'asset-1');
  assert.equal(stored.sha256, normalized.sha256);
  assert.equal(signedRequest.body.fileHash, normalized.md5);
  assert.equal(signedRequest.config.headers.Authorization, 'Bearer server-secret');
  assert.equal(uploadedRequest.url, 'https://uploads.example.test/');
  assert.equal(JSON.stringify(stored).includes('server-secret'), false);
});

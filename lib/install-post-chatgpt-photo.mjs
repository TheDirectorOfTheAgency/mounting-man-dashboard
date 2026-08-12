import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import sharp from 'sharp';

export const MAX_CHATGPT_PHOTO_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_CHATGPT_PHOTO_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_CHATGPT_PHOTO_DIMENSION = 12000;
export const MAX_CHATGPT_PHOTO_PIXELS = 50_000_000;

const CONTENT_TYPE_FORMAT = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function ipv6Bytes(address) {
  let host = String(address || '').toLowerCase();
  if (host.includes('.')) {
    const separator = host.lastIndexOf(':');
    const dotted = host.slice(separator + 1);
    if (separator < 0 || isIP(dotted) !== 4) return null;
    const octets = dotted.split('.').map(Number);
    host = `${host.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(omitted).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.flatMap((word) => {
    const value = Number.parseInt(word, 16);
    return [value >> 8, value & 0xff];
  });
}

function unsafeIpv4Bytes(bytes) {
  const [a, b] = bytes;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function unsafeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) {
    return unsafeIpv4Bytes(host.split('.').map(Number));
  }
  if (isIP(host) === 6) {
    const bytes = ipv6Bytes(host);
    if (!bytes) return true;
    if (bytes.every((byte) => byte === 0)) return true;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
    if ((bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)) return true;
    if (bytes[0] === 0xff) return true;
    const wellKnownNat64 = bytes[0] === 0 && bytes[1] === 0x64
      && bytes[2] === 0xff && bytes[3] === 0x9b
      && bytes.slice(4, 12).every((byte) => byte === 0);
    if (wellKnownNat64) return unsafeIpv4Bytes(bytes.slice(12));
    const localUseNat64 = bytes[0] === 0 && bytes[1] === 0x64
      && bytes[2] === 0xff && bytes[3] === 0x9b
      && bytes[4] === 0 && bytes[5] === 1;
    if (localUseNat64) return true;
    const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
    const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
      && bytes[10] === 0xff && bytes[11] === 0xff;
    if (compatible || mapped) return unsafeIpv4Bytes(bytes.slice(12));
    return false;
  }
  return false;
}

function pinnedHttpsFetch(url, { address, family, contentType }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers: { Accept: contentType },
      agent: false,
      lookup(_hostname, _options, callback) {
        callback(null, address, family);
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_CHATGPT_PHOTO_INPUT_BYTES) {
          request.destroy(photoError('image_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode || 500,
        headers: response.headers,
      })));
    });
    request.setTimeout(15000, () => request.destroy(photoError('photo_download_failed')));
    request.on('error', reject);
    request.end();
  });
}

function photoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function decodeBase64(value) {
  const encoded = String(value || '');
  const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
  const decodedLength = Math.floor(encoded.length * 3 / 4) - padding;
  if (decodedLength > MAX_CHATGPT_PHOTO_INPUT_BYTES) {
    throw photoError('image_too_large');
  }
  if (!encoded || encoded.length % 4 !== 0 || !BASE64_RE.test(encoded)) {
    throw photoError('invalid_image_base64');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64') !== encoded) {
    throw photoError('invalid_image_base64');
  }
  if (buffer.length > MAX_CHATGPT_PHOTO_INPUT_BYTES) throw photoError('image_too_large');
  return buffer;
}

export function validateChatGptFileDescriptor(file, { allowedHosts = [] } = {}) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw photoError('invalid_file_descriptor');
  }
  const downloadUrl = String(file.download_url || '');
  const fileId = String(file.file_id || '');
  if (!downloadUrl || !fileId || fileId.length > 256) throw photoError('invalid_file_descriptor');
  let parsed;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw photoError('invalid_download_url');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || unsafeHost(parsed.hostname)) {
    throw photoError('unsafe_download_url');
  }
  const hosts = new Set(allowedHosts.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
  if (!hosts.size || !hosts.has(parsed.hostname.toLowerCase())) {
    throw photoError('download_host_not_allowed');
  }
  const contentType = String(file.mime_type || file.mimeType || '').toLowerCase();
  if (!CONTENT_TYPE_FORMAT[contentType]) throw photoError('unsupported_image_type');
  return { downloadUrl: parsed.toString(), hostname: parsed.hostname, fileId, contentType };
}

export async function downloadChatGptPhoto(file, {
  allowedHosts = [],
  fetchImpl,
  lookupImpl = lookup,
} = {}) {
  const descriptor = validateChatGptFileDescriptor(file, { allowedHosts });
  let addresses;
  try {
    addresses = await lookupImpl(descriptor.hostname, { all: true, verbatim: true });
  } catch {
    throw photoError('photo_download_failed');
  }
  if (!Array.isArray(addresses) || !addresses.length
    || addresses.some((entry) => unsafeHost(entry?.address))) {
    throw photoError('unsafe_download_host');
  }
  let response;
  try {
    response = fetchImpl
      ? await fetchImpl(descriptor.downloadUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: descriptor.contentType },
        signal: AbortSignal.timeout(15000),
      })
      : await pinnedHttpsFetch(descriptor.downloadUrl, {
        address: addresses[0].address,
        family: addresses[0].family,
        contentType: descriptor.contentType,
      });
  } catch {
    throw photoError('photo_download_failed');
  }
  if (!response?.ok) throw photoError('photo_download_failed');
  const responseType = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
  if (responseType && responseType !== descriptor.contentType) throw photoError('image_type_mismatch');
  const declaredBytes = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CHATGPT_PHOTO_INPUT_BYTES) {
    throw photoError('image_too_large');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw photoError('invalid_image_bytes');
  if (buffer.length > MAX_CHATGPT_PHOTO_INPUT_BYTES) throw photoError('image_too_large');
  return {
    imageBase64: buffer.toString('base64'),
    contentType: descriptor.contentType,
    fileId: descriptor.fileId,
  };
}

/** Decode actual bytes, reject spoofed/unsafe images, and strip all metadata. */
export async function normalizeInstallationPhoto({ imageBase64, contentType } = {}) {
  const declaredType = String(contentType || '').toLowerCase();
  const declaredFormat = CONTENT_TYPE_FORMAT[declaredType];
  if (!declaredFormat) throw photoError('unsupported_image_type');
  const input = decodeBase64(imageBase64);

  let metadata;
  try {
    metadata = await sharp(input, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_CHATGPT_PHOTO_PIXELS,
      sequentialRead: true,
    }).metadata();
  } catch {
    throw photoError('invalid_image_bytes');
  }
  if (metadata.format !== declaredFormat) throw photoError('image_type_mismatch');
  if (!metadata.width || !metadata.height) throw photoError('invalid_image_dimensions');
  if (metadata.width > MAX_CHATGPT_PHOTO_DIMENSION
    || metadata.height > MAX_CHATGPT_PHOTO_DIMENSION
    || metadata.width * metadata.height > MAX_CHATGPT_PHOTO_PIXELS) {
    throw photoError('invalid_image_dimensions');
  }
  if (Number(metadata.pages || 1) !== 1) throw photoError('animated_image_not_allowed');

  let output;
  try {
    output = await sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_CHATGPT_PHOTO_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // No withMetadata(): Sharp therefore strips EXIF, GPS, XMP, and ICC data.
      .webp({ quality: 88, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw photoError('image_normalization_failed');
  }
  if (!output.data.length || output.data.length > MAX_CHATGPT_PHOTO_OUTPUT_BYTES) {
    throw photoError('normalized_image_too_large');
  }
  return {
    buffer: output.data,
    sha256: createHash('sha256').update(output.data).digest('hex'),
    md5: createHash('md5').update(output.data).digest('hex'),
    bytes: output.data.length,
    width: output.info.width,
    height: output.info.height,
    contentType: 'image/webp',
  };
}

function slugPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/"/g, '-inch')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assetFileName(record) {
  const seed = record?.seed || {};
  const parts = [
    slugPart(seed['tv-size']),
    slugPart(seed['tv-brand']),
    'tv-installation',
    slugPart(seed.city),
  ].filter(Boolean);
  return `${parts.join('-')}-${String(record?.revision || '').slice(0, 8)}.webp`;
}

/** Server-owned Webflow asset upload. Tokens and signed form details never leave the backend. */
export function createWebflowPhotoStore({
  siteId,
  token,
  httpClient,
  uploadClient = fetch,
} = {}) {
  return {
    normalize: normalizeInstallationPhoto,

    async store({ record, normalized }) {
      if (!siteId || !token) throw photoError('photo_store_unavailable');
      if (!record?.jobId || !normalized?.buffer) throw photoError('invalid_photo_store_request');
      const client = httpClient || (await import('axios')).default;
      const response = await client.post(
        `https://api.webflow.com/v2/sites/${siteId}/assets`,
        { fileName: assetFileName(record), fileHash: normalized.md5 },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );
      const asset = response?.data || {};
      if (!asset.id || !asset.hostedUrl || !asset.uploadUrl || !asset.uploadDetails) {
        throw photoError('photo_store_invalid_response');
      }
      const form = new FormData();
      for (const [key, value] of Object.entries(asset.uploadDetails)) {
        form.append(key, String(value));
      }
      form.append('file', new Blob([normalized.buffer], { type: normalized.contentType }), assetFileName(record));
      const uploaded = await uploadClient(asset.uploadUrl, { method: 'POST', body: form });
      if (!uploaded?.ok) throw photoError('photo_upload_failed');
      return {
        assetId: String(asset.id),
        hostedUrl: String(asset.hostedUrl),
        sha256: normalized.sha256,
        md5: normalized.md5,
        bytes: normalized.bytes,
        width: normalized.width,
        height: normalized.height,
        contentType: normalized.contentType,
      };
    },
  };
}

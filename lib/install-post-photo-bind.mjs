// Shared Webflow signed-upload + photo-bind path used by the phone card
// (pages/api/install-post/upload.js) and the desk ingest route.
//
// The desk POSTs bytes. This module signs the same Webflow asset upload, puts
// the WebP on the signed slot, then commits the photo transition. Auto-publish
// stays in the caller so both routes share one lease + one GitHub dispatcher.

import { createHash, randomBytes } from 'node:crypto';

import axios from 'axios';

import { timingSafeEqualString } from './mcp-http.mjs';
import { md5Hex } from './install-post-photo-client.mjs';
import { INSTALL_POST_STATES, statusForReason, transitionRecord } from './install-post-queue.mjs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_PHONE_CONTENT_TYPES = new Set(['image/webp']);
export const ALLOWED_INGEST_CONTENT_TYPES = new Set(['image/webp', 'image/jpeg']);

const SHA256_RE = /^[0-9a-f]{64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;

const WEBFLOW_SITE_ID =
  process.env.WEBFLOW_SITE_ID || process.env.NEXT_PUBLIC_WEBFLOW_SITE_ID;
const WEBFLOW_TOKEN =
  process.env.WEBFLOW_TOKEN || process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF = Buffer.from('RIFF');
const WEBP_MARK = Buffer.from('WEBP');

export function slugPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/"/g, '-inch')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Descriptive but PII-free asset name: no customer, no street number. */
export function assetFileName(record) {
  const seed = record.seed || {};
  const parts = [
    slugPart(seed['tv-size']),
    slugPart(seed['tv-brand']),
    seed['job-type'] === 'unmount' ? 'tv-unmounting' : 'tv-installation',
    slugPart(seed.city),
  ].filter(Boolean);
  return `${parts.join('-')}-${String(record.revision).slice(0, 8)}.webp`;
}

export function createWebflowUploadClient({
  httpClient = axios,
  siteId = WEBFLOW_SITE_ID,
  token = WEBFLOW_TOKEN,
} = {}) {
  return {
    async createSignedUpload({ fileName, fileHash }) {
      const response = await httpClient.post(
        `https://api.webflow.com/v2/sites/${siteId}/assets`,
        { fileName, fileHash },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      const asset = response.data || {};
      return {
        assetId: asset.id,
        hostedUrl: asset.hostedUrl,
        uploadUrl: asset.uploadUrl,
        uploadDetails: asset.uploadDetails,
      };
    },

    async putSignedUpload({ uploadUrl, uploadDetails, bytes, fileName }) {
      const form = new FormData();
      for (const [key, value] of Object.entries(uploadDetails || {})) {
        form.append(key, String(value));
      }
      form.append('file', new Blob([bytes], { type: 'image/webp' }), fileName || 'installation.webp');
      await httpClient.post(uploadUrl, form, {
        timeout: 30000,
        maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
        maxContentLength: MAX_UPLOAD_BYTES + 1024 * 1024,
      });
    },
  };
}

export function digestPhotoBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    sha256: createHash('sha256').update(view).digest('hex'),
    md5: md5Hex(view),
    bytes: view.byteLength,
  };
}

export function looksLikeJpeg(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC);
}

export function looksLikeWebP(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return buf.length >= 12
    && buf.subarray(0, 4).equals(WEBP_RIFF)
    && buf.subarray(8, 12).equals(WEBP_MARK);
}

/**
 * Convert a desk JPEG to bounded WebP so Webflow / Instagram never see JPEG.
 * Injectable `convert` keeps tests off native sharp.
 */
export async function convertJpegToWebP(jpegBytes, {
  maxBytes = MAX_UPLOAD_BYTES,
  convert,
} = {}) {
  if (typeof convert === 'function') {
    const out = await convert(jpegBytes);
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out || []);
    if (!buf.length || buf.length > maxBytes) {
      const err = new Error('file_too_large');
      err.code = 'file_too_large';
      throw err;
    }
    return buf;
  }

  const sharp = (await import('sharp')).default;
  const qualitySteps = [85, 75, 65, 50];
  let last = null;
  for (const quality of qualitySteps) {
    last = await sharp(jpegBytes)
      .rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (last.length <= maxBytes) return last;
  }
  const err = new Error('file_too_large');
  err.code = 'file_too_large';
  throw err;
}

export function parseMultipartForm(buffer, contentType) {
  const match = String(contentType || '').match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) return { ok: false, reason: 'invalid_multipart' };
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  let offset = raw.indexOf(boundary);
  if (offset === -1) return { ok: false, reason: 'invalid_multipart' };
  offset += boundary.length;

  while (offset < raw.length) {
    if (raw[offset] === 0x2d && raw[offset + 1] === 0x2d) break;
    if (raw[offset] === 0x0d && raw[offset + 1] === 0x0a) offset += 2;
    const next = raw.indexOf(boundary, offset);
    if (next === -1) break;
    let part = raw.subarray(offset, next);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      offset = next + boundary.length;
      continue;
    }
    const header = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    const filename = /filename="([^"]*)"/i.exec(header)?.[1];
    const partType = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim().toLowerCase() || '';
    if (name) {
      if (filename !== undefined) {
        files[name] = { filename, contentType: partType, bytes: body };
      } else {
        fields[name] = body.toString('utf8');
      }
    }
    offset = next + boundary.length;
  }

  return { ok: true, fields, files };
}

export function headerValue(headers, name) {
  if (!headers) return '';
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return value;
  }
  return '';
}

export function providedIngestSecret(req) {
  return String(headerValue(req?.headers, 'x-install-post-secret') || '').trim();
}

export function isAuthorizedIngestSecret(req, cronSecret) {
  const expected = String(cronSecret || '').trim();
  const provided = providedIngestSecret(req);
  if (!expected || !provided) return false;
  return timingSafeEqualString(provided, expected);
}

/** Prefer jobId; otherwise match paymentId/orderId in the source namespace. */
export async function resolveIngestJob(store, { jobId, paymentId, orderId } = {}) {
  if (!store) return { ok: false, reason: 'unavailable' };
  const id = String(jobId || '').trim();
  if (id) {
    const record = await store.loadRecord(id);
    if (!record) return { ok: false, reason: 'not_found' };
    return { ok: true, record };
  }

  const matches = typeof store.findRecordsBySource === 'function'
    ? await store.findRecordsBySource({ paymentId, orderId })
    : [];
  if (!matches.length) return { ok: false, reason: 'not_found' };

  const awaiting = matches.filter((record) => record.state === INSTALL_POST_STATES.AWAITING_PHOTO);
  const published = matches.filter((record) => record.state === INSTALL_POST_STATES.PUBLISHED);
  const inFlight = matches.filter((record) => (
    record.state === INSTALL_POST_STATES.PUBLISHING
    || record.state === INSTALL_POST_STATES.VERIFYING
  ));

  if (awaiting.length === 1) return { ok: true, record: awaiting[0] };
  if (awaiting.length > 1) return { ok: false, reason: 'ambiguous_job', record: awaiting[0] };
  if (inFlight.length) return { ok: false, reason: 'publish_in_flight', record: inFlight[0] };
  if (published.length) return { ok: false, reason: 'already_published', record: published[0] };
  if (matches.length === 1) return { ok: true, record: matches[0] };
  return { ok: false, reason: 'ambiguous_job', record: matches[0] };
}

export async function signAndStoreUpload({ store, webflow, record, sha256, md5, byteLength, now = Date.now }) {
  if (!SHA256_RE.test(sha256) || !MD5_RE.test(md5)) {
    return { ok: false, reason: 'invalid_digest' };
  }
  let signed;
  try {
    signed = await webflow.createSignedUpload({
      fileName: assetFileName(record),
      fileHash: md5,
    });
  } catch (err) {
    console.error('[install-post-photo] signed upload failed:', err.response?.status || err.message);
    return { ok: false, reason: 'upload_signing_failed' };
  }

  const uploadId = randomBytes(16).toString('hex');
  await store.saveUploadSession({
    uploadId,
    jobId: record.jobId,
    revision: record.revision,
    sha256,
    md5,
    bytes: byteLength,
    contentType: 'image/webp',
    assetId: signed.assetId,
    hostedUrl: signed.hostedUrl,
    createdAt: new Date(now()).toISOString(),
  });

  return {
    ok: true,
    uploadId,
    uploadUrl: signed.uploadUrl,
    uploadDetails: signed.uploadDetails,
    assetId: signed.assetId,
    hostedUrl: signed.hostedUrl,
    maxBytes: MAX_UPLOAD_BYTES,
  };
}

export async function putSignedPhoto({ webflow, signed, bytes, fileName }) {
  try {
    await webflow.putSignedUpload({
      uploadUrl: signed.uploadUrl,
      uploadDetails: signed.uploadDetails,
      bytes,
      fileName,
    });
    return { ok: true };
  } catch (err) {
    console.error('[install-post-photo] asset put failed:', err.response?.status || err.message);
    return { ok: false, reason: 'upload_put_failed' };
  }
}

/**
 * Bind a previously signed upload session to the job (phone commit path).
 */
export async function commitUploadSession({ store, jobId, uploadId, sha256 }) {
  const session = await store.loadUploadSession(uploadId);
  if (!session || session.jobId !== jobId) {
    return { ok: false, reason: 'upload_not_found', status: 409 };
  }
  if (String(sha256 || '').toLowerCase() !== session.sha256) {
    return { ok: false, reason: 'digest_mismatch', status: 409 };
  }

  let refusal = null;
  const outcome = await store.withRecordLock(jobId, async (current) => {
    if (session.revision !== current.revision) {
      refusal = 'stale_revision';
      return null;
    }
    const transition = transitionRecord(current, {
      type: 'photo',
      image: {
        sha256: session.sha256,
        bytes: session.bytes,
        contentType: session.contentType,
        assetId: session.assetId,
        hostedUrl: session.hostedUrl,
      },
    });
    if (!transition.ok) {
      refusal = transition.reason;
      return null;
    }
    return transition.record;
  });

  if (!outcome.ok) {
    const reason = refusal || outcome.reason;
    return { ok: false, reason, status: statusForReason(reason), record: outcome.record };
  }

  await store.deleteUploadSession(uploadId);
  return { ok: true, record: outcome.record };
}

export { SHA256_RE, MD5_RE };

// pages/api/install-post/ingest-photo.js
//
// Secret-authenticated desk ingest. Square has already staged the job
// (AWAITING_PHOTO). Grok Bot / Woodward POSTs the photo bytes here — no
// operator session cookie, no publish_one.py, no Q capability mint.
//
//   POST /api/install-post/ingest-photo
//   Header: x-install-post-secret: <CRON_SECRET>   (same secret as /pending)
//   Body:   multipart/form-data
//           photo     = image/webp | image/jpeg
//           jobId     = opaque job id (optional)
//           paymentId = Square payment id (optional)
//           orderId   = Square order id (optional)
//
// JPEG is converted to WebP on this server, then the same Webflow
// signed-upload + commit path as /api/install-post/upload runs. After bind,
// the existing Square+photo auto-publish claims the lease and dispatches
// publish-install-post.yml at the tip of GitHub main.

import { autoDispatchIfPhotoBound } from '../../../lib/install-post-auto-publish.mjs';
import { createConfiguredDispatcher } from '../../../lib/install-post-dispatch.mjs';
import {
  ALLOWED_INGEST_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  assetFileName,
  commitUploadSession,
  convertJpegToWebP,
  createWebflowUploadClient,
  digestPhotoBytes,
  isAuthorizedIngestSecret,
  looksLikeJpeg,
  looksLikeWebP,
  parseMultipartForm,
  putSignedPhoto,
  resolveIngestJob,
  signAndStoreUpload,
} from '../../../lib/install-post-photo-bind.mjs';
import { INSTALL_POST_STATES, publicJobView, statusForReason } from '../../../lib/install-post-queue.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const IN_FLIGHT = new Set([
  INSTALL_POST_STATES.PUBLISHING,
  INSTALL_POST_STATES.VERIFYING,
]);

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '6mb',
  },
};

async function readRequestBytes(req) {
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (req?.body instanceof Uint8Array) return Buffer.from(req.body);
  if (typeof req?.body === 'string') return Buffer.from(req.body);
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    return Buffer.alloc(0);
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createIngestPhotoHandler({
  store,
  cronSecret = CRON_SECRET,
  webflow,
  dispatcher,
  convertJpeg,
  now = Date.now,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    // Origin check is intentionally off. This is a secret-header desk path,
    // not the phone cookie. Same secret as /api/install-post/pending.
    if (!isAuthorizedIngestSecret(req, cronSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const raw = await readRequestBytes(req);
    const parsed = parseMultipartForm(raw, req.headers?.['content-type'] || req.headers?.['Content-Type']);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.reason });
    }

    const photo = parsed.files.photo;
    if (!photo?.bytes?.length) {
      return res.status(400).json({ error: 'photo_required' });
    }
    if (photo.bytes.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: 'file_too_large' });
    }

    const contentType = String(photo.contentType || '').toLowerCase();
    if (!ALLOWED_INGEST_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({ error: 'unsupported_content_type' });
    }

    const job = await resolveIngestJob(store, {
      jobId: parsed.fields.jobId,
      paymentId: parsed.fields.paymentId,
      orderId: parsed.fields.orderId,
    });
    if (!job.ok) {
      if (job.reason === 'not_found') {
        return res.status(404).json({ error: 'not_found' });
      }
      if (job.reason === 'already_published' || job.reason === 'publish_in_flight') {
        return res.status(409).json({
          error: job.reason,
          ...(job.record ? { job: publicJobView(job.record) } : {}),
        });
      }
      return res.status(statusForReason(job.reason)).json({ error: job.reason });
    }

    const record = job.record;
    if (record.state === INSTALL_POST_STATES.PUBLISHED) {
      return res.status(409).json({ error: 'already_published', job: publicJobView(record) });
    }
    if (IN_FLIGHT.has(record.state)) {
      return res.status(409).json({ error: 'publish_in_flight', job: publicJobView(record) });
    }

    let webpBytes = photo.bytes;
    const mustConvert = contentType === 'image/jpeg' || looksLikeJpeg(photo.bytes);
    if (mustConvert && !looksLikeWebP(photo.bytes)) {
      try {
        webpBytes = await convertJpegToWebP(photo.bytes, { convert: convertJpeg });
      } catch (err) {
        const reason = err?.code === 'file_too_large' ? 'file_too_large' : 'jpeg_conversion_failed';
        return res.status(reason === 'file_too_large' ? 400 : 422).json({ error: reason });
      }
    } else if (contentType === 'image/webp' && !looksLikeWebP(photo.bytes)) {
      return res.status(400).json({ error: 'unsupported_content_type' });
    }

    if (webpBytes.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: 'file_too_large' });
    }

    const digest = digestPhotoBytes(webpBytes);
    const signed = await signAndStoreUpload({
      store,
      webflow,
      record,
      sha256: digest.sha256,
      md5: digest.md5,
      byteLength: digest.bytes,
      now,
    });
    if (!signed.ok) {
      const status = signed.reason === 'upload_signing_failed' ? 502 : 400;
      return res.status(status).json({ error: signed.reason });
    }

    const put = await putSignedPhoto({
      webflow,
      signed,
      bytes: webpBytes,
      fileName: assetFileName(record),
    });
    if (!put.ok) {
      await store.deleteUploadSession(signed.uploadId);
      return res.status(502).json({ error: put.reason });
    }

    const bound = await commitUploadSession({
      store,
      jobId: record.jobId,
      uploadId: signed.uploadId,
      sha256: digest.sha256,
    });
    if (!bound.ok) {
      return res.status(bound.status || 409).json({ error: bound.reason });
    }

    const dispatched = await autoDispatchIfPhotoBound({
      store,
      jobId: record.jobId,
      dispatcher,
      now,
    });
    if (dispatched.ok) {
      return res.status(200).json({ ok: true, job: publicJobView(dispatched.record) });
    }
    if (dispatched.reason === 'already_published' || dispatched.reason === 'publish_in_flight') {
      return res.status(409).json({
        error: dispatched.reason,
        job: publicJobView(dispatched.record || bound.record),
      });
    }
    return res.status(dispatched.status || statusForReason(dispatched.reason)).json({
      error: dispatched.reason || 'dispatch_failed',
      job: publicJobView(dispatched.record || bound.record),
    });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createIngestPhotoHandler({
    store,
    cronSecret: CRON_SECRET,
    webflow: createWebflowUploadClient(),
    dispatcher: createConfiguredDispatcher(),
  })(req, res);
}

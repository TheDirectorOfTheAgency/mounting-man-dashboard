// pages/api/install-post/upload.js
//
// Two-step photo binding for one job.
//
//   POST { action: 'init',   revision, contentType, bytes, sha256, md5 }
//     → validates the payload against the job's current revision and returns a
//       job-scoped Webflow signed-upload payload. No Webflow token is exposed.
//
//   POST { action: 'commit', revision, uploadId, sha256 }
//     → binds the uploaded asset to the exact job/revision that signed it.
//
// The upload session is stored server-side and keyed to one job, so a session
// signed for TV 1 can never be committed against TV 2.
//
// Auth is the operator session cookie alone; the URL carries nothing.

import { autoDispatchIfPhotoBound } from '../../../lib/install-post-auto-publish.mjs';
import { createConfiguredDispatcher } from '../../../lib/install-post-dispatch.mjs';
import {
  ALLOWED_PHONE_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  MD5_RE,
  SHA256_RE,
  commitUploadSession,
  createWebflowUploadClient,
  signAndStoreUpload,
} from '../../../lib/install-post-photo-bind.mjs';
import { publicJobView } from '../../../lib/install-post-queue.mjs';
import { guardOperatorRequest } from '../../../lib/install-post-session.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

export { MAX_UPLOAD_BYTES };

export function createUploadHandler({ store, sessionSecret, webflow, dispatcher, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const jobId = guardOperatorRequest(req, res, { secret: sessionSecret, now: now() });
    if (!jobId) return undefined;
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const body = req.body || {};
    if (body.action === 'init') return init(req, res, jobId, body);
    if (body.action === 'commit') return commit(req, res, jobId, body);
    return res.status(400).json({ error: 'unsupported_action' });
  };

  async function init(req, res, jobId, body) {
    const contentType = String(body.contentType || '').toLowerCase();
    if (!ALLOWED_PHONE_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({ error: 'unsupported_content_type' });
    }
    const bytes = Number(body.bytes || 0);
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: 'file_too_large' });
    }
    const sha256 = String(body.sha256 || '').toLowerCase();
    const md5 = String(body.md5 || '').toLowerCase();
    if (!SHA256_RE.test(sha256) || !MD5_RE.test(md5)) {
      return res.status(400).json({ error: 'invalid_digest' });
    }

    const record = await store.loadRecord(jobId);
    if (!record) return res.status(404).json({ error: 'not_found' });
    if (body.revision !== record.revision) {
      return res.status(409).json({ error: 'stale_revision' });
    }

    const signed = await signAndStoreUpload({
      store,
      webflow,
      record,
      sha256,
      md5,
      byteLength: bytes,
      now,
    });
    if (!signed.ok) {
      const status = signed.reason === 'upload_signing_failed' ? 502 : 400;
      return res.status(status).json({ error: signed.reason });
    }

    return res.status(200).json({
      uploadId: signed.uploadId,
      uploadUrl: signed.uploadUrl,
      uploadDetails: signed.uploadDetails,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  async function commit(req, res, jobId, body) {
    const outcome = await commitUploadSession({
      store,
      jobId,
      uploadId: body.uploadId,
      sha256: body.sha256,
    });
    if (!outcome.ok) {
      return res.status(outcome.status || 409).json({ error: outcome.reason });
    }

    // Square already staged the job. Once the photo is bound, the cloud runner
    // is the publisher — no Woodward/Q Python, no second desk hop.
    if (dispatcher) {
      const dispatched = await autoDispatchIfPhotoBound({
        store,
        jobId,
        dispatcher,
        now,
      });
      if (dispatched.ok) {
        return res.status(200).json({ job: publicJobView(dispatched.record) });
      }
    }

    return res.status(200).json({ job: publicJobView(outcome.record) });
  }
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createUploadHandler({
    store,
    sessionSecret: (process.env.INSTALL_POST_ACCESS_SECRET || '').trim(),
    webflow: createWebflowUploadClient(),
    dispatcher: createConfiguredDispatcher(),
  })(req, res);
}

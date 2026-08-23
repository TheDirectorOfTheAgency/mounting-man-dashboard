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

import { randomBytes } from 'node:crypto';

import axios from 'axios';

import {
  publicJobView,
  statusForReason,
  transitionRecord,
} from '../../../lib/install-post-queue.mjs';
import { guardOperatorRequest } from '../../../lib/install-post-session.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(['image/webp']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;

const WEBFLOW_SITE_ID =
  process.env.WEBFLOW_SITE_ID || process.env.NEXT_PUBLIC_WEBFLOW_SITE_ID;
const WEBFLOW_TOKEN =
  process.env.WEBFLOW_TOKEN || process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;

function slugPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/"/g, '-inch')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Descriptive but PII-free asset name: no customer, no street number. */
function assetFileName(record) {
  const seed = record.seed || {};
  const parts = [
    slugPart(seed['tv-size']),
    slugPart(seed['tv-brand']),
    seed['job-type'] === 'unmount' ? 'tv-unmounting' : 'tv-installation',
    slugPart(seed.city),
  ].filter(Boolean);
  return `${parts.join('-')}-${String(record.revision).slice(0, 8)}.webp`;
}

function createWebflowUploadClient({ httpClient = axios, siteId = WEBFLOW_SITE_ID, token = WEBFLOW_TOKEN } = {}) {
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
  };
}

export function createUploadHandler({ store, sessionSecret, webflow, now = Date.now } = {}) {
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
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
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

    let signed;
    try {
      signed = await webflow.createSignedUpload({
        fileName: assetFileName(record),
        fileHash: md5,
      });
    } catch (err) {
      console.error('[install-post-upload] signed upload failed:', err.response?.status || err.message);
      return res.status(502).json({ error: 'upload_signing_failed' });
    }

    const uploadId = randomBytes(16).toString('hex');
    await store.saveUploadSession({
      uploadId,
      jobId,
      revision: record.revision,
      sha256,
      md5,
      bytes,
      contentType,
      assetId: signed.assetId,
      hostedUrl: signed.hostedUrl,
      createdAt: new Date(now()).toISOString(),
    });

    return res.status(200).json({
      uploadId,
      uploadUrl: signed.uploadUrl,
      uploadDetails: signed.uploadDetails,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  async function commit(req, res, jobId, body) {
    const session = await store.loadUploadSession(body.uploadId);
    if (!session || session.jobId !== jobId) {
      return res.status(409).json({ error: 'upload_not_found' });
    }
    if (String(body.sha256 || '').toLowerCase() !== session.sha256) {
      return res.status(409).json({ error: 'digest_mismatch' });
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
      return res.status(statusForReason(reason)).json({ error: reason });
    }

    await store.deleteUploadSession(body.uploadId);
    return res.status(200).json({ job: publicJobView(outcome.record) });
  }
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createUploadHandler({
    store,
    sessionSecret: (process.env.INSTALL_POST_ACCESS_SECRET || '').trim(),
    webflow: createWebflowUploadClient(),
  })(req, res);
}

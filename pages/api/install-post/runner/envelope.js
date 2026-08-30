// pages/api/install-post/runner/envelope.js
//
// Signed internal endpoint the cloud runner calls to fetch exactly what was
// approved. It returns the safe seed and the bound photo reference — never a
// Square identifier, a customer detail, or a credential.

import { verifyRunnerRequest } from '../../../../lib/install-post-dispatch.mjs';
import { collectPostedDestinations, INSTALL_POST_STATES } from '../../../../lib/install-post-queue.mjs';
import { getInstallPostStore } from '../../../../lib/install-post-store.mjs';

export const ENVELOPE_PATH = '/api/install-post/runner/envelope';

const APPROVABLE_STATES = new Set([
  INSTALL_POST_STATES.PUBLISHING,
  INSTALL_POST_STATES.VERIFYING,
]);

export function createRunnerEnvelopeHandler({ store, runnerSecret, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const verified = verifyRunnerRequest({
      secret: runnerSecret,
      signature: req.headers?.['x-install-post-signature'],
      timestamp: req.headers?.['x-install-post-timestamp'],
      method: 'POST',
      path: ENVELOPE_PATH,
      body: req.body,
      now: now(),
    });
    if (!verified.ok) {
      return res.status(401).json({ error: 'unauthorized', reason: verified.reason });
    }
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const { jobId, revision } = req.body || {};
    const record = await store.loadRecord(jobId);
    if (!record) return res.status(404).json({ error: 'not_found' });

    if (!record.approval || !APPROVABLE_STATES.has(record.state)) {
      return res.status(409).json({ error: 'not_approved' });
    }
    if (record.approval.revision !== revision || record.revision !== revision) {
      return res.status(409).json({ error: 'stale_revision' });
    }
    if (!record.image?.hostedUrl) {
      return res.status(409).json({ error: 'photo_required' });
    }

    const postedDestinations = collectPostedDestinations(
      record.postedDestinations,
      record.result?.destinations,
    );

    return res.status(200).json({
      jobId: record.jobId,
      revision: record.revision,
      approvedAt: record.approval.approvedAt,
      seed: record.seed,
      image: {
        sha256: record.image.sha256,
        bytes: record.image.bytes,
        contentType: record.image.contentType,
        hostedUrl: record.image.hostedUrl,
        assetId: record.image.assetId || '',
      },
      postedDestinations,
      // The cloud path never generates TV art; it publishes the real photo.
      artMode: 'never',
    });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createRunnerEnvelopeHandler({
    store,
    runnerSecret: (process.env.INSTALL_POST_RUNNER_SECRET || '').trim(),
  })(req, res);
}

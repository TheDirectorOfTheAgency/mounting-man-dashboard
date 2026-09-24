// pages/api/install-post/m1/claim.js
//
// Signed pull endpoint for the M1 publish worker (launchd
// com.themountingman.install-post-worker).
//
// POST { workerId, rescan? } → { job: envelope | null }
//
// Claims the oldest READY_FOR_M1 job: takes the publish lease for its approved
// revision and moves it to PUBLISHING, then returns the same envelope the
// runner envelope route serves plus the dispatchId the worker must echo to
// /api/install-post/runner/callback. `rescan: true` rebuilds the ready index
// first (once after deploy, for jobs parked before the index existed).
//
// Auth: the runner HMAC scheme (x-install-post-signature / -timestamp) with
// INSTALL_POST_RUNNER_SECRET. No GitHub Actions dispatch is involved.

import { verifyRunnerRequest } from '../../../../lib/install-post-dispatch.mjs';
import { claimNextReadyForM1 } from '../../../../lib/install-post-m1-queue.mjs';
import { getInstallPostStore } from '../../../../lib/install-post-store.mjs';

export const M1_CLAIM_PATH = '/api/install-post/m1/claim';

export function createM1ClaimHandler({ store, runnerSecret, now = Date.now, dispatchIdFactory } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const verified = verifyRunnerRequest({
      secret: runnerSecret,
      signature: req.headers?.['x-install-post-signature'],
      timestamp: req.headers?.['x-install-post-timestamp'],
      method: 'POST',
      path: M1_CLAIM_PATH,
      body: req.body,
      now: now(),
    });
    if (!verified.ok) {
      return res.status(401).json({ error: 'unauthorized', reason: verified.reason });
    }
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const outcome = await claimNextReadyForM1({
      store,
      workerId: req.body?.workerId,
      now,
      rescan: req.body?.rescan === true,
      ...(dispatchIdFactory ? { dispatchIdFactory } : {}),
    });
    if (!outcome.ok) {
      const status = outcome.reason === 'worker_id_required' ? 400 : 503;
      return res.status(status).json({ error: outcome.reason });
    }
    return res.status(200).json({ job: outcome.job });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createM1ClaimHandler({
    store,
    runnerSecret: (process.env.INSTALL_POST_RUNNER_SECRET || '').trim(),
  })(req, res);
}

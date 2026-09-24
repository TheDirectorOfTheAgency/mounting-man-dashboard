// pages/api/install-post/runner/callback.js
//
// Signed internal endpoint a publisher posts its outcome to: the M1 worker
// (m1/install-post-worker) today, the frozen cloud runner historically.
//
// The result is sanitized before it is stored, and a callback is only accepted
// from the dispatch that currently holds the lease on the approved revision. A
// late callback from an abandoned run, a replay, or a run for a newer approval
// is refused rather than allowed to overwrite the job.
//
// A verified website result settles on its own. GBP is a paste pack for Mr.
// Wayne (caption + Book URL), sent after the record is saved and fail-open. No
// machine GBP queue is written or waited on here.

import axios from 'axios';
import { deliverGbpFenceToOwner } from '../../../../lib/install-post-gbp-fence-notify.mjs';
import { verifyRunnerRequest } from '../../../../lib/install-post-dispatch.mjs';
import {
  INSTALL_POST_STATES,
  publicJobView,
  statusForReason,
  transitionRecord,
} from '../../../../lib/install-post-queue.mjs';
import { getInstallPostStore } from '../../../../lib/install-post-store.mjs';

export const CALLBACK_PATH = '/api/install-post/runner/callback';

const LEASE_CLEARING_STATES = new Set([
  INSTALL_POST_STATES.RETRYABLE_FAILURE,
  INSTALL_POST_STATES.BLOCKED,
]);

export function createRunnerCallbackHandler({
  store,
  runnerSecret,
  gbpFenceNotify,
  now = Date.now,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const verified = verifyRunnerRequest({
      secret: runnerSecret,
      signature: req.headers?.['x-install-post-signature'],
      timestamp: req.headers?.['x-install-post-timestamp'],
      method: 'POST',
      path: CALLBACK_PATH,
      body: req.body,
      now: now(),
    });
    if (!verified.ok) {
      return res.status(401).json({ error: 'unauthorized', reason: verified.reason });
    }
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const { jobId, revision, dispatchId, result } = req.body || {};
    let refusal = null;

    const outcome = await store.withRecordLock(jobId, async (current) => {
      if (!current.approval || current.approval.revision !== revision) {
        refusal = 'stale_revision';
        return null;
      }
      // Only the run that currently holds the lease may report. Without this a
      // reconcile run and the abandoned run it replaced would race.
      if (!dispatchId || current.lease?.dispatchId !== dispatchId) {
        refusal = 'dispatch_mismatch';
        return null;
      }
      const transition = transitionRecord(current, {
        type: 'result',
        result,
        at: new Date(now()).toISOString(),
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

    if (LEASE_CLEARING_STATES.has(outcome.record.state)) {
      await store.releasePublishLease({ jobId, revision });
    }

    let gbpPastePack = null;
    if (outcome.record.state === INSTALL_POST_STATES.PUBLISHED && typeof gbpFenceNotify === 'function') {
      try {
        gbpPastePack = await gbpFenceNotify({ record: outcome.record });
      } catch (err) {
        console.warn('[install-post-callback] GBP paste pack failed open', {
          errorType: err?.name || 'Error',
        });
        gbpPastePack = { forwarded: false, error: true };
      }
    }

    return res.status(200).json({
      job: publicJobView(outcome.record),
      ...(gbpPastePack ? { gbpPastePack } : {}),
    });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createRunnerCallbackHandler({
    store,
    runnerSecret: (process.env.INSTALL_POST_RUNNER_SECRET || '').trim(),
    gbpFenceNotify: (args) => deliverGbpFenceToOwner({
      ...args,
      httpClient: axios,
      url: process.env.INSTALL_POST_GBP_NOTIFY_URL,
      key: process.env.INSTALL_POST_GBP_NOTIFY_KEY,
    }),
  })(req, res);
}

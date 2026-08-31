// pages/api/install-post/runner/callback.js
//
// Signed internal endpoint the cloud runner posts its outcome to.
//
// The result is sanitized before it is stored, and a callback is only accepted
// from the dispatch that currently holds the lease on the approved revision. A
// late callback from an abandoned run, a replay, or a run for a newer approval
// is refused rather than allowed to overwrite the job.

import {
  attachGbpQueuedDestination,
  enqueueGbpAfterPublish,
  getInstallPostGbpQueue,
} from '../../../../lib/install-post-gbp-queue.mjs';
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

export function createRunnerCallbackHandler({ store, runnerSecret, gbpQueue, now = Date.now } = {}) {
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
      // Website is the first asset. GBP is the second — establish durable GBP
      // intent before this callback persists the terminal website result.
      let record = transition.record;
      if (record.state === INSTALL_POST_STATES.PUBLISHED) {
        if (!gbpQueue) {
          refusal = 'gbp_queue_unavailable';
          return null;
        }
        let enqueued;
        try {
          enqueued = await enqueueGbpAfterPublish({
            queue: gbpQueue,
            record,
            at: new Date(now()).toISOString(),
          });
        } catch {
          refusal = 'gbp_enqueue_failed';
          return null;
        }
        if (!enqueued.item && !['already_queued', 'already_posted'].includes(enqueued.reason)) {
          refusal = 'gbp_enqueue_failed';
          return null;
        }
        record = attachGbpQueuedDestination(record, {
          slug: enqueued.item?.slug || record.result?.slug,
          reason: enqueued.queued ? 'queued' : enqueued.reason,
        });
      }
      return record;
    });

    if (!outcome.ok) {
      const reason = refusal || outcome.reason;
      if (reason === 'gbp_queue_unavailable' || reason === 'gbp_enqueue_failed') {
        return res.status(503).json({ error: reason });
      }
      return res.status(statusForReason(reason)).json({ error: reason });
    }

    if (LEASE_CLEARING_STATES.has(outcome.record.state)) {
      await store.releasePublishLease({ jobId, revision });
    }

    return res.status(200).json({ job: publicJobView(outcome.record) });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  const gbpQueue = await getInstallPostGbpQueue();
  return createRunnerCallbackHandler({
    store,
    gbpQueue,
    runnerSecret: (process.env.INSTALL_POST_RUNNER_SECRET || '').trim(),
  })(req, res);
}

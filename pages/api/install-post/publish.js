// pages/api/install-post/publish.js
//
// The explicit Publish tap, and the explicit Reconcile tap.
//
// Publish creates an immutable approval receipt for one exact (seed, photo)
// revision and dispatches exactly one cloud runner for it. Reconcile
// (`{ reconcile: true }`) re-runs an unresolved dispatch against that same
// approval, which is the only way out of INDETERMINATE — the runner reuses an
// existing post for that photo rather than publishing a second one.
//
// Both paths claim the publish lease *while holding the job's record lock*, so
// a lease can never outlive the record change it was claimed for.
//
// Auth is the operator session cookie alone; the URL carries nothing.

import { randomBytes } from 'node:crypto';

import { createConfiguredDispatcher } from '../../../lib/install-post-dispatch.mjs';
import {
  INSTALL_POST_STATES,
  publicJobView,
  statusForReason,
  transitionRecord,
} from '../../../lib/install-post-queue.mjs';
import { guardOperatorRequest } from '../../../lib/install-post-session.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

export function createPublishHandler({ store, sessionSecret, dispatcher, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const jobId = guardOperatorRequest(req, res, { secret: sessionSecret, now: now() });
    if (!jobId) return undefined;
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    const requestedRevision = req.body?.revision;
    const wantsReconcile = req.body?.reconcile === true;
    const at = new Date(now()).toISOString();
    const dispatchId = randomBytes(12).toString('hex');

    let refusal = null;
    let refused = null;
    let claimed = false;

    const approved = await store.withRecordLock(jobId, async (stored) => {
      // A dispatch that never reported back is indistinguishable from one that
      // published, so age it into INDETERMINATE and let reconciliation decide.
      const expired = transitionRecord(stored, { type: 'timeout', at });
      const current = expired.ok ? expired.record : stored;
      refused = current;

      if (current.state === INSTALL_POST_STATES.PUBLISHED) {
        refusal = 'already_published';
        return null;
      }
      if (!current.image) {
        refusal = 'photo_required';
        return null;
      }
      if (requestedRevision !== current.revision) {
        refusal = 'stale_revision';
        return null;
      }

      const unresolved = current.state === INSTALL_POST_STATES.INDETERMINATE;
      if (unresolved && !wantsReconcile) {
        refusal = 'reconcile_required';
        return null;
      }
      if (!unresolved && wantsReconcile) {
        refusal = 'not_reconcilable';
        return null;
      }

      // Atomic gate: exactly one dispatch per approved revision. Claiming it
      // here — under the record lock — means a `duplicate` answer with no
      // matching record lease can only be an orphan from a request that died
      // mid-flight, because any live claimant would still hold this lock.
      let claim = await store.claimPublishLease({ jobId, revision: current.revision, dispatchId });
      if (claim === 'duplicate') {
        const held = current.lease?.revision === current.revision;
        if (held && !unresolved) {
          refusal = 'duplicate_publish';
          return null;
        }
        claim = await store.claimPublishLease({
          jobId, revision: current.revision, dispatchId, takeover: true,
        });
      }
      if (claim !== 'claimed') {
        refusal = 'unavailable';
        return null;
      }
      claimed = true;

      const transition = transitionRecord(current, {
        type: unresolved ? 'reconcile' : 'approve',
        revision: current.revision,
        dispatchId,
        at,
      });
      if (!transition.ok) {
        refusal = transition.reason;
        return null;
      }
      return transition.record;
    });

    if (!approved.ok) {
      if (claimed) await store.releasePublishLease({ jobId, revision: requestedRevision });
      const reason = refusal || approved.reason;
      return res.status(statusForReason(reason)).json({
        error: reason,
        ...(refused ? { job: publicJobView(refused) } : {}),
      });
    }

    try {
      await dispatcher.dispatch({ jobId, revision: approved.record.revision, dispatchId });
    } catch (err) {
      console.error('[install-post-publish] dispatch failed:', err.message);
      await store.releasePublishLease({ jobId, revision: approved.record.revision });
      await store.withRecordLock(jobId, async (current) => transitionRecord(current, {
        type: 'result',
        result: { status: INSTALL_POST_STATES.RETRYABLE_FAILURE, message: 'Cloud dispatch failed' },
        at: new Date(now()).toISOString(),
      }).record);
      return res.status(502).json({ error: 'dispatch_failed' });
    }

    return res.status(200).json({ job: publicJobView(approved.record) });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createPublishHandler({
    store,
    sessionSecret: (process.env.INSTALL_POST_ACCESS_SECRET || '').trim(),
    dispatcher: createConfiguredDispatcher(),
  })(req, res);
}

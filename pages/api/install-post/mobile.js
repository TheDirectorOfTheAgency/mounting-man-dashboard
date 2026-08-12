// pages/api/install-post/mobile.js
//
// Phone card state for one installation job.
//
//   GET   → safe card state for the job the session is bound to
//   PATCH → apply a safe correction, producing a new revision
//
// Auth is the operator session cookie alone. The URL carries nothing, so the
// job this route acts on is decided entirely by a header no log records.

import {
  publicJobView,
  statusForReason,
  transitionRecord,
} from '../../../lib/install-post-queue.mjs';
import { guardOperatorRequest } from '../../../lib/install-post-session.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

export function createMobileJobHandler({ store, sessionSecret, now = Date.now } = {}) {
  /**
   * The card is the only thing that reliably comes back to look at a job, so it
   * is also where an abandoned dispatch gets aged out. Best-effort: if the
   * write loses a race the next poll simply tries again.
   */
  async function expireIfAbandoned(record) {
    const at = new Date(now()).toISOString();
    if (!transitionRecord(record, { type: 'timeout', at }).ok) return record;

    const outcome = await store.withRecordLock(record.jobId, async (current) => {
      const expired = transitionRecord(current, { type: 'timeout', at });
      return expired.ok ? expired.record : null;
    });
    return outcome.ok ? outcome.record : record;
  }

  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'PATCH') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const jobId = guardOperatorRequest(req, res, { secret: sessionSecret, now: now() });
    if (!jobId) return undefined;
    if (!store) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    if (req.method === 'GET') {
      const record = await store.loadRecord(jobId);
      if (!record) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ job: publicJobView(await expireIfAbandoned(record)) });
    }

    const { revision, patch } = req.body || {};
    let refusal = null;

    const outcome = await store.withRecordLock(jobId, async (current) => {
      if (revision !== current.revision) {
        refusal = 'stale_revision';
        return null;
      }
      const transition = transitionRecord(current, { type: 'correct', patch });
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
    return res.status(200).json({ job: publicJobView(outcome.record) });
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  return createMobileJobHandler({
    store,
    sessionSecret: (process.env.INSTALL_POST_ACCESS_SECRET || '').trim(),
  })(req, res);
}

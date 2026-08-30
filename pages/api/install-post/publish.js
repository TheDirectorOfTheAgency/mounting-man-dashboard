// pages/api/install-post/publish.js
//
// The explicit Publish tap, and the explicit Reconcile tap.
//
// Both share approveAndDispatchInstallPost with the Square+photo auto-run so
// there is one signed envelope/callback protocol. Reconcile (`{ reconcile: true }`)
// re-runs an unresolved dispatch against that same approval.
//
// Auth is the operator session cookie alone; the URL carries nothing.

import { approveAndDispatchInstallPost } from '../../../lib/install-post-auto-publish.mjs';
import { createConfiguredDispatcher } from '../../../lib/install-post-dispatch.mjs';
import { publicJobView, statusForReason } from '../../../lib/install-post-queue.mjs';
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

    const outcome = await approveAndDispatchInstallPost({
      store,
      jobId,
      revision: req.body?.revision,
      dispatcher,
      now,
      reconcile: req.body?.reconcile === true,
    });

    if (!outcome.ok) {
      return res.status(outcome.status || statusForReason(outcome.reason)).json({
        error: outcome.reason,
        ...(outcome.record ? { job: publicJobView(outcome.record) } : {}),
      });
    }

    return res.status(200).json({ job: publicJobView(outcome.record) });
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

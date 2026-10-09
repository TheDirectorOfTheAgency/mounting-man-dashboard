// Daily Google review reply drafts (~7 PM America/Chicago via vercel.json cron).
// Never posts replies — stores drafts for operator approval.

import { loadReviewLoopStore } from '../../../lib/review-loop-store.mjs';
import { syncGoogleReplyDrafts } from '../../../lib/review-reply-drafts.mjs';

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  return Boolean(cronSecret) && req.headers.authorization === `Bearer ${cronSecret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store = await loadReviewLoopStore();
  if (!store) {
    return res.status(503).json({ error: 'KV unavailable' });
  }

  try {
    const result = await syncGoogleReplyDrafts({ store, logger: console });
    return res.status(200).json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error('[review-reply-drafts-cron]', error.message);
    return res.status(500).json({ error: 'sync_failed', details: error.message });
  }
}

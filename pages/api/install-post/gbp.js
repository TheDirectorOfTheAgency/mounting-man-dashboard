// pages/api/install-post/gbp.js
//
// Pull API for the M1 GBP worker (launchd com.themountingman.gbp-worker).
//
// GET  /api/install-post/gbp
//   → { pending, latest, count } — update + photos items independently
// POST /api/install-post/gbp
//   { action: "claim", slug, kind }     → mark in-progress
//   { action: "complete", slug, kind }  → mark posted so that kind skips
//
// kind is required: "update" | "photos". Completing an Update never skips Photos.
//
// Auth: Authorization: Bearer INSTALL_POST_GBP_WORKER_SECRET
//       (x-install-post-gbp-secret accepted; no query-string secret)
//
// This does not post to Google. Official localPosts is SERVICE_DISABLED.
// Never Reddit. Do not change GBP website or NAP.

import { timingSafeEqualString, headerValue } from '../../../lib/mcp-http.mjs';
import {
  getInstallPostGbpQueue,
  parseGbpQueueId,
} from '../../../lib/install-post-gbp-queue.mjs';

export const GBP_PATH = '/api/install-post/gbp';

function providedGbpSecret(req) {
  const auth = headerValue(req?.headers, 'authorization');
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(\S+)/i);
    if (match) return match[1].trim();
  }
  const headerSecret = headerValue(req?.headers, 'x-install-post-gbp-secret');
  return headerSecret ? String(headerSecret).trim() : '';
}

export function isAuthorizedGbpWorker(req, secret) {
  const expected = String(secret || '').trim();
  const provided = providedGbpSecret(req);
  if (!expected || !provided) return false;
  return timingSafeEqualString(provided, expected);
}

function resolveTarget(body = {}) {
  return parseGbpQueueId(body.id || body.slug, body.kind);
}

export function createGbpHandler({ queue, workerSecret } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!isAuthorizedGbpWorker(req, workerSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!queue) {
      return res.status(503).json({ error: 'store_unavailable' });
    }

    if (req.method === 'GET') {
      const pending = await queue.listPending();
      return res.status(200).json({
        pending,
        latest: pending[0] || null,
        count: pending.length,
      });
    }

    const action = String(req.body?.action || '').trim().toLowerCase();
    const target = resolveTarget(req.body || {});
    if (!target) return res.status(400).json({ error: 'slug_and_kind_required' });

    if (action === 'claim') {
      const result = await queue.claim(target.slug, target.kind);
      if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
      return res.status(200).json({ ok: true, item: result.item });
    }

    if (action === 'complete') {
      const result = await queue.complete(target.slug, target.kind);
      if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
      return res.status(200).json({ ok: true, item: result.item });
    }

    return res.status(400).json({ error: 'unsupported_action' });
  };
}

export default async function handler(req, res) {
  const queue = await getInstallPostGbpQueue();
  return createGbpHandler({
    queue,
    workerSecret: (process.env.INSTALL_POST_GBP_WORKER_SECRET || '').trim(),
  })(req, res);
}

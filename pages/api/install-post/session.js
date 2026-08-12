// pages/api/install-post/session.js
//
// The one-time fragment exchange.
//
//   POST { capability } → Set-Cookie: an operator session for that one job
//
// This route's own URL is tokenless, so the capability appears nowhere except
// the request body: not in a path, not in a query string, not in a referrer,
// and therefore not in any access log. It is the only place a capability is
// ever accepted; every other installation-post route reads the cookie alone.

import {
  signOperatorSession,
  verifyJobCapability,
} from '../../../lib/install-post-queue.mjs';
import {
  buildSessionCookie,
  clearedSessionCookie,
  originAllowed,
} from '../../../lib/install-post-session.mjs';

export function createSessionHandler({ capabilitySecret, sessionSecret, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!originAllowed(req)) {
      return res.status(403).json({ error: 'forbidden_origin' });
    }

    const capability = typeof req.body?.capability === 'string' ? req.body.capability : '';
    const at = now();
    const verified = verifyJobCapability(capability, { secret: capabilitySecret, now: at });
    if (!verified.ok) {
      // Drop any session already held: a dead link must not silently leave the
      // previous job's card on screen.
      res.setHeader('Set-Cookie', clearedSessionCookie());
      return res.status(401).json({ error: 'unauthorized', reason: verified.reason });
    }

    const token = signOperatorSession({
      jobId: verified.jobId,
      secret: sessionSecret,
      expiresAt: verified.expiresAt,
    });
    res.setHeader('Set-Cookie', buildSessionCookie({
      token,
      expiresAt: verified.expiresAt,
      now: at,
    }));
    // Nothing about the capability comes back — the page needs no copy of it.
    return res.status(200).json({ ok: true, expiresAt: verified.expiresAt });
  };
}

export default async function handler(req, res) {
  const secret = (process.env.INSTALL_POST_ACCESS_SECRET || '').trim();
  return createSessionHandler({
    capabilitySecret: secret,
    sessionSecret: secret,
    now: Date.now,
  })(req, res);
}

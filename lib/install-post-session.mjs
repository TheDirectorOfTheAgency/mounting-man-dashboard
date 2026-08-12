// lib/install-post-session.mjs
//
// The HTTP half of operator authentication for the installation-post queue.
//
// The capability reaches the phone in a URL fragment and is exchanged, once,
// through a POST body for the cookie defined here. From then on the credential
// lives only in a header that is HttpOnly (no script can read it), Secure (no
// cleartext hop), SameSite=Strict (no cross-site request carries it), and
// path-scoped to the installation-post APIs (no other route on the origin ever
// receives it). Nothing about the operator's access appears in a URL, so no
// request line, referrer, browser history entry, or access log can leak it.

import { verifyOperatorSession } from './install-post-queue.mjs';

// `__Secure-` is refused by the browser unless the cookie is set over HTTPS
// with the Secure attribute. `__Host-` would be stronger still, but it forces
// Path=/, which is the opposite of the narrow scoping we want here.
export const SESSION_COOKIE_NAME = '__Secure-mm-install-post';
export const SESSION_COOKIE_PATH = '/api/install-post';

const BASE_COOKIE_ATTRIBUTES = `Path=${SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

/** Read the session cookie out of a raw request. Never throws. */
export function readSessionToken(req) {
  const header = String(req?.headers?.cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    return part.slice(index + 1).trim();
  }
  return '';
}

/** The `Set-Cookie` value that installs a session, dying with its capability. */
export function buildSessionCookie({ token, expiresAt, now = Date.now() }) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    BASE_COOKIE_ATTRIBUTES,
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join('; ');
}

/** The `Set-Cookie` value that removes a session on the same narrow scope. */
export function clearedSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; ${BASE_COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * Is this request same-origin?
 *
 * SameSite=Strict already stops a cross-site request from carrying the cookie;
 * this is the independent server-side check. Absent or opaque (`null`) origins
 * are refused rather than trusted: browsers always send `Origin` on the
 * non-GET requests this guards.
 */
export function originAllowed(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin || origin === 'null') return false;

  let host;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    host = url.host.toLowerCase();
  } catch {
    return false;
  }

  const forwarded = req?.headers?.['x-forwarded-host'];
  const expected = [req?.headers?.host, ...String(forwarded || '').split(',')]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  return expected.includes(host);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(req) {
  return MUTATING_METHODS.has(String(req?.method || '').toUpperCase());
}

/** Resolve the one job this request is allowed to touch, from the cookie only. */
export function authenticateOperator(req, { secret, now = Date.now() } = {}) {
  const token = readSessionToken(req);
  if (!token) return { ok: false, reason: 'no_session' };
  return verifyOperatorSession(token, { secret, now });
}

/**
 * The single gate every operator route opens with.
 *
 * Returns the bound `jobId`, or writes the refusal and returns null. Origin is
 * checked before the cookie so a cross-site attempt is refused without the
 * response depending on whether a session happened to exist.
 */
export function guardOperatorRequest(req, res, { secret, now = Date.now() } = {}) {
  if (isMutating(req) && !originAllowed(req)) {
    res.status(403).json({ error: 'forbidden_origin' });
    return null;
  }
  const session = authenticateOperator(req, { secret, now });
  if (!session.ok) {
    res.status(401).json({ error: 'unauthorized', reason: session.reason });
    return null;
  }
  return session.jobId;
}

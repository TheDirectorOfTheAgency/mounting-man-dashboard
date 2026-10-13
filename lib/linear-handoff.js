// Event-driven Linear handoffs between Q (Grok Bot) and CODEX.
// Linear Comment webhook -> verify HMAC + freshness -> allowlist -> header gate
// -> dedupe (delivery, comment and handoff id; KV) -> forward to Q routine or email Codex a wake-up notice.
// Only comments whose body STARTS with "HANDOFF -> Q" / "HANDOFF -> CODEX" trigger.
// Receipts ("RECEIPT from ...") and everything else are ignored. This module never posts to Linear.

import crypto from 'node:crypto';

export const HEADER_Q = 'HANDOFF -> Q';
export const HEADER_CODEX = 'HANDOFF -> CODEX';
export const MAX_BODY = 2000;
export const FRESHNESS_MS = 60 * 1000;
export const DEDUPE_TTL_S = 60 * 60 * 24 * 30;
const KEY_PREFIX = 'linear-handoff';

export function verifyLinearSignature(rawBody, signature, secret) {
  if (!secret || !signature || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b;
  try { b = Buffer.from(signature.trim(), 'hex'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isFresh(webhookTimestamp, now = Date.now()) {
  const ts = Number(webhookTimestamp);
  return Number.isFinite(ts) && Math.abs(now - ts) <= FRESHNESS_MS;
}

export function parseAllowlist(raw) {
  return String(raw || 'THE-330')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toUpperCase());
}

export function issueIdentifierFromPayload(payload) {
  const d = payload?.data || {};
  if (d.issue?.identifier) return String(d.issue.identifier).toUpperCase();
  const url = payload?.url || d.url || '';
  const m = /\/issue\/([A-Za-z0-9]+-\d+)/.exec(url);
  return m ? m[1].toUpperCase() : null;
}

export function routeFor(body) {
  if (typeof body !== 'string') return null;
  if (body.startsWith(HEADER_Q)) {
    const next = body.charAt(HEADER_Q.length);
    if (next === '' || /\s/.test(next)) return 'Q';
  }
  if (body.startsWith(HEADER_CODEX)) {
    const next = body.charAt(HEADER_CODEX.length);
    if (next === '' || /\s/.test(next)) return 'CODEX';
  }
  return null;
}

// Loop guard. A comment is never routed back to the side that wrote it:
// (1) its author is listed in LINEAR_HANDOFF_<ROUTE>_SELF_ACTOR_IDS, or
// (2) its `From:` line names the receiving side (e.g. `From: Q` on `HANDOFF -> Q`).
export function senderFor(body) {
  const m = /^From:[ \t]*([A-Za-z]+)/im.exec(String(body || ''));
  return m ? m[1].toUpperCase() : null;
}

export function listEnv(raw) {
  return String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export function loopReason(payload, route, env = process.env) {
  const actorId = payload?.actor?.id || payload?.data?.userId || null;
  const self = listEnv(env[`LINEAR_HANDOFF_${route}_SELF_ACTOR_IDS`]);
  if (actorId && self.includes(actorId)) return 'self_actor';
  if (senderFor(payload?.data?.body) === route) return 'self_sender';
  return null;
}

export function qForwardHeaders(key, headerName) {
  const name = String(headerName || '').trim() || 'Authorization';
  return { 'Content-Type': 'application/json', [name]: name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key };
}

export const FORWARD_TIMEOUT_MS = 4000; // Linear abandons a delivery after 5s

export function minimalPayload(payload, identifier, route) {
  const d = payload.data || {};
  const body = String(d.body || '');
  return {
    source: 'linear',
    route,
    issue: identifier,
    issueTitle: d.issue?.title || null,
    commentId: d.id,
    url: payload.url || null,
    author: payload.actor?.name || d.user?.name || null,
    authorId: payload.actor?.id || d.userId || null,
    createdAt: d.createdAt || null,
    body: body.slice(0, MAX_BODY),
    truncated: body.length > MAX_BODY,
    handoffId: handoffIdFromBody(body),
    issueUuid: d.issueId || d.issue?.id || null,
    issueUrl: (payload.url || '').split('#')[0] || null,
  };
}

export async function forwardToQ(msg, { env = process.env, fetchImpl = fetch } = {}) {
  const url = env.LINEAR_HANDOFF_Q_WEBHOOK_URL;
  const key = env.LINEAR_HANDOFF_Q_WEBHOOK_KEY;
  if (!url || !key) return { ok: false, configured: false };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: qForwardHeaders(key, env.LINEAR_HANDOFF_Q_WEBHOOK_HEADER),
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  return { ok: res.ok, configured: true, status: res.status };
}

export function handoffIdFromBody(body) {
  const m = /^\s*id\s*:\s*([A-Za-z0-9._:-]{1,80})\s*$/im.exec(String(body || ''));
  return m ? m[1] : null;
}

export const CODEX_EMAIL_TO_DEFAULT = 'marshallwayneemail@gmail.com';

// Minimal wake-up notification per handoff/2026-10-13-codex-to-q-linear-wakeup-contract.md:
// handoff id, recipient CODEX, issue UUID/URL, comment id/URL only. No comment text;
// Codex fetches and verifies the original Linear comment itself.
export function codexEmail(msg) {
  const hid = msg.handoffId || `comment-${msg.commentId}`;
  return {
    subject: `[LINEAR-HANDOFF] CODEX ${msg.issue} ${hid}`,
    text: [
      'LINEAR-HANDOFF v1',
      `handoff_id: ${hid}`,
      'recipient: CODEX',
      `issue: ${msg.issue}`,
      `issue_uuid: ${msg.issueUuid || ''}`,
      `issue_url: ${msg.issueUrl || ''}`,
      `comment_id: ${msg.commentId}`,
      `comment_url: ${msg.url || ''}`,
      '',
      'Notification only. Fetch the original Linear comment and verify it before acting.',
    ].join('\n'),
  };
}

export async function emailCodex(msg, { env = process.env, sendMail } = {}) {
  const user = env.HANDOFF_SMTP_USER;
  const pass = env.HANDOFF_SMTP_PASS;
  const from = env.HANDOFF_EMAIL_FROM || user;
  const to = env.CODEX_HANDOFF_EMAIL_TO || CODEX_EMAIL_TO_DEFAULT;
  if (!user || !pass || !from) return { ok: false, configured: false };
  const mail = codexEmail(msg);
  const send = sendMail || (async (m) => {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({
      host: env.HANDOFF_SMTP_HOST || 'smtp.mail.me.com', port: Number(env.HANDOFF_SMTP_PORT || 587),
      secure: false, requireTLS: true, auth: { user, pass },
      connectionTimeout: FORWARD_TIMEOUT_MS, greetingTimeout: FORWARD_TIMEOUT_MS, socketTimeout: FORWARD_TIMEOUT_MS,
    });
    return t.sendMail(m);
  });
  const info = await send({ from, to, subject: mail.subject, text: mail.text });
  return { ok: true, configured: true, messageId: info?.messageId || null };
}

async function claim(kv, key) {
  const r = await kv.set(key, String(Date.now()), { nx: true, ex: DEDUPE_TTL_S });
  return r === 'OK' || r === true;
}

export async function processLinearWebhook({ rawBody, headers, kv, env = process.env, now = Date.now(), fetchImpl = fetch, sendMail, log = console }) {
  const sig = headers['linear-signature'];
  if (!verifyLinearSignature(rawBody, sig, env.LINEAR_WEBHOOK_SECRET)) {
    return { status: 401, body: { ok: false, error: 'bad_signature' } };
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch {
    return { status: 400, body: { ok: false, error: 'bad_json' } };
  }
  if (!isFresh(payload.webhookTimestamp, now)) {
    return { status: 401, body: { ok: false, error: 'stale_timestamp' } };
  }
  if (payload.type !== 'Comment' || payload.action !== 'create') {
    return { status: 200, body: { ok: true, ignored: 'not_comment_create' } };
  }
  const identifier = issueIdentifierFromPayload(payload);
  const allow = parseAllowlist(env.LINEAR_HANDOFF_ALLOWLIST);
  const issueUuid = String(payload.data?.issueId || payload.data?.issue?.id || '').toUpperCase();
  if (!(identifier && allow.includes(identifier)) && !(issueUuid && allow.includes(issueUuid))) {
    return { status: 200, body: { ok: true, ignored: 'issue_not_allowlisted' } };
  }
  const authors = listEnv(env.LINEAR_HANDOFF_ALLOWED_AUTHORS);
  const authorId = payload.actor?.id || payload.data?.userId;
  if (authors.length && !authors.includes(authorId)) return { status: 200, body: { ok: true, ignored: 'author_not_allowed' } };
  const route = routeFor(payload.data?.body);
  if (!route) return { status: 200, body: { ok: true, ignored: 'not_a_handoff' } };
  const loop = loopReason(payload, route, env);
  if (loop) return { status: 200, body: { ok: true, ignored: loop } };
  if (!kv) return { status: 503, body: { ok: false, error: 'kv_unavailable' } };

  const deliveryId = headers['linear-delivery'] || payload.webhookId + ':' + payload.webhookTimestamp;
  const commentId = payload.data?.id;
  if (!commentId) return { status: 200, body: { ok: true, ignored: 'no_comment_id' } };
  const dKey = `${KEY_PREFIX}:delivery:${deliveryId}`;
  const cKey = `${KEY_PREFIX}:comment:${commentId}`;
  if (!(await claim(kv, dKey))) return { status: 200, body: { ok: true, duplicate: 'delivery' } };
  if (!(await claim(kv, cKey))) return { status: 200, body: { ok: true, duplicate: 'comment' } };

  const msg = minimalPayload(payload, identifier || issueUuid, route);
  const hKey = msg.handoffId ? `${KEY_PREFIX}:handoff:${route}:${msg.handoffId}` : null;
  if (hKey && !(await claim(kv, hKey))) return { status: 200, body: { ok: true, duplicate: 'handoff_id' } };
  let result;
  try {
    result = route === 'Q' ? await forwardToQ(msg, { env, fetchImpl }) : await emailCodex(msg, { env, sendMail });
  } catch (err) {
    result = { ok: false, configured: true, error: String(err?.message || err) };
  }
  log.info?.('linear_handoff', { route, issue: msg.issue, commentId, ok: result.ok, configured: result.configured, status: result.status });
  if (result.ok) {
    await kv.set(`${KEY_PREFIX}:last`, JSON.stringify({ route, issue: msg.issue, commentId, at: now }), { ex: DEDUPE_TTL_S });
    return { status: 200, body: { ok: true, route, forwarded: true } };
  }
  // Release claims so a retry (or a later config fix + Linear redelivery) can process it.
  await kv.del(...[dKey, cKey, hKey].filter(Boolean));
  if (!result.configured) return { status: 200, body: { ok: true, route, forwarded: false, reason: 'route_unconfigured' } };
  return { status: 502, body: { ok: false, route, error: 'forward_failed', upstream: result.status || null } };
}

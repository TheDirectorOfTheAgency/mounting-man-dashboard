// Event-driven Linear handoffs between Q (Grok Bot) and CODEX.
// Linear Comment webhook -> verify HMAC + freshness -> allowlist -> header gate
// -> dedupe (delivery id + comment id, KV) -> forward to Q routine or mirror to GitHub (@codex).
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
  const m = /^From:[ \t]*([A-Za-z]+)/m.exec(String(body || ''));
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

export function codexCommentBody(msg) {
  const quoted = msg.body.split('\n').map((l) => `> ${l}`).join('\n');
  return [
    `@codex Linear handoff for you on ${msg.issue} (Linear comment ${msg.commentId}, by ${msg.author || 'unknown'}).`,
    '',
    `Linear: ${msg.url || 'n/a'}`,
    '',
    quoted,
    msg.truncated ? '\n> [truncated at 2000 chars; read the full comment in Linear]' : '',
    '',
    'When done, post a Linear comment on that issue starting with `RECEIPT from CODEX` (and `HANDOFF -> Q` as a separate comment if Q must act). Details/code belong in GitHub.',
    '',
    `<!-- linear-handoff comment:${msg.commentId} -->`,
  ].join('\n');
}

export async function mirrorToCodex(msg, { env = process.env, fetchImpl = fetch } = {}) {
  const repo = env.CODEX_HANDOFF_GITHUB_REPO;
  const num = env.CODEX_HANDOFF_GITHUB_PR;
  const token = env.CODEX_HANDOFF_GITHUB_TOKEN;
  if (!repo || !num || !token) return { ok: false, configured: false };
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${num}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'tmm-linear-handoff',
    },
    body: JSON.stringify({ body: codexCommentBody(msg) }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  let htmlUrl = null;
  try { htmlUrl = (await res.json())?.html_url || null; } catch { /* ignore */ }
  return { ok: res.ok, configured: true, status: res.status, htmlUrl };
}

async function claim(kv, key) {
  const r = await kv.set(key, String(Date.now()), { nx: true, ex: DEDUPE_TTL_S });
  return r === 'OK' || r === true;
}

export async function processLinearWebhook({ rawBody, headers, kv, env = process.env, now = Date.now(), fetchImpl = fetch, log = console }) {
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
  let result;
  try {
    result = route === 'Q' ? await forwardToQ(msg, { env, fetchImpl }) : await mirrorToCodex(msg, { env, fetchImpl });
  } catch (err) {
    result = { ok: false, configured: true, error: String(err?.message || err) };
  }
  log.info?.('linear_handoff', { route, issue: msg.issue, commentId, ok: result.ok, configured: result.configured, status: result.status });
  if (result.ok) {
    await kv.set(`${KEY_PREFIX}:last`, JSON.stringify({ route, issue: msg.issue, commentId, at: now }), { ex: DEDUPE_TTL_S });
    return { status: 200, body: { ok: true, route, forwarded: true } };
  }
  // Release claims so a retry (or a later config fix + Linear redelivery) can process it.
  await kv.del(dKey, cKey);
  if (!result.configured) return { status: 202, body: { ok: true, route, forwarded: false, reason: 'route_unconfigured' } };
  return { status: 502, body: { ok: false, route, error: 'forward_failed', upstream: result.status || null } };
}

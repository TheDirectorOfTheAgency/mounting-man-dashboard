import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { processLinearWebhook, routeFor } from '../lib/linear-handoff.js';

const SECRET = 'test-secret';
function memKV() {
  const m = new Map();
  return { m, async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; }, async del(...ks) { ks.forEach((k) => m.delete(k)); } };
}
function mk(body, { id = 'c1', ts = Date.now(), url = 'https://linear.app/x/issue/THE-330/foo#comment-1' } = {}) {
  return Buffer.from(JSON.stringify({ action: 'create', type: 'Comment', url, webhookTimestamp: ts, webhookId: 'w', actor: { id: 'u', name: 'Q' }, data: { id, body, issueId: 'iss' } }));
}
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const env = { LINEAR_WEBHOOK_SECRET: SECRET, LINEAR_HANDOFF_Q_WEBHOOK_URL: 'https://q.example/hook', LINEAR_HANDOFF_Q_WEBHOOK_KEY: 'k', CODEX_HANDOFF_GITHUB_REPO: 'o/r', CODEX_HANDOFF_GITHUB_PR: '5', CODEX_HANDOFF_GITHUB_TOKEN: 't' };
function run(raw, { kv = memKV(), headers = {}, e = env, calls = [] } = {}) {
  const fetchImpl = async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, json: async () => ({ html_url: 'h' }) }; };
  return processLinearWebhook({ rawBody: raw, headers: { 'linear-signature': sign(raw), 'linear-delivery': 'd1', ...headers }, kv, env: e, fetchImpl, log: {} });
}

test('header gate', () => {
  assert.equal(routeFor('HANDOFF -> Q\nx'), 'Q');
  assert.equal(routeFor('HANDOFF -> CODEX do it'), 'CODEX');
  assert.equal(routeFor(' HANDOFF -> Q'), null);
  assert.equal(routeFor('RECEIPT from Q\nHANDOFF -> Q'), null);
  assert.equal(routeFor('HANDOFF -> QUICK'), null);
});
test('bad signature rejected', async () => {
  const raw = mk('HANDOFF -> Q');
  const r = await run(raw, { headers: { 'linear-signature': 'deadbeef' } });
  assert.equal(r.status, 401);
});
test('stale timestamp rejected', async () => {
  const r = await run(mk('HANDOFF -> Q', { ts: Date.now() - 120000 }));
  assert.equal(r.body.error, 'stale_timestamp');
});
test('non-allowlisted ignored', async () => {
  const r = await run(mk('HANDOFF -> Q', { url: 'https://linear.app/x/issue/THE-1/foo' }));
  assert.equal(r.body.ignored, 'issue_not_allowlisted');
});
test('receipt ignored', async () => {
  const calls = [];
  const r = await run(mk('RECEIPT from CODEX'), { calls });
  assert.equal(r.body.ignored, 'not_a_handoff');
  assert.equal(calls.length, 0);
});
test('Q forward with bearer, then dedupe delivery and comment', async () => {
  const kv = memKV(); const calls = [];
  const raw = mk('HANDOFF -> Q\n' + 'x'.repeat(3000));
  const r = await run(raw, { kv, calls });
  assert.equal(r.body.forwarded, true);
  assert.equal(calls[0].o.headers.Authorization, 'Bearer k');
  const sent = JSON.parse(calls[0].o.body);
  assert.equal(sent.issue, 'THE-330'); assert.equal(sent.body.length, 2000); assert.equal(sent.truncated, true);
  assert.equal((await run(raw, { kv, calls })).body.duplicate, 'delivery');
  assert.equal((await run(raw, { kv, calls, headers: { 'linear-delivery': 'd2' } })).body.duplicate, 'comment');
  assert.equal(calls.length, 1);
});
test('CODEX mirrors to GitHub PR comment with @codex', async () => {
  const calls = [];
  const r = await run(mk('HANDOFF -> CODEX\nreview PR', { id: 'c9' }), { calls });
  assert.equal(r.body.forwarded, true);
  assert.match(calls[0].u, /repos\/o\/r\/issues\/5\/comments/);
  assert.match(JSON.parse(calls[0].o.body).body, /^@codex /);
});
test('unconfigured Q route releases claims', async () => {
  const kv = memKV();
  const r = await run(mk('HANDOFF -> Q'), { kv, e: { LINEAR_WEBHOOK_SECRET: SECRET } });
  assert.equal(r.status, 202); assert.equal(kv.m.size, 0);
});

// ---- loop guard + configurable Q header (follow-up to #89) ----
function mkActor(body, actorId, opts = {}) {
  const o = JSON.parse(mk(body, opts).toString());
  o.actor = { id: actorId, name: 'x' };
  return Buffer.from(JSON.stringify(o));
}

test('HANDOFF -> Q written by Q (From: Q) is never forwarded to Q', async () => {
  const calls = [];
  const out = await run(mk('HANDOFF -> Q\nID: THE-330-20261013-01\nFrom: Q\nAction: x'), { calls });
  assert.equal(out.body.ignored, 'self_sender');
  assert.equal(calls.length, 0);
});

test('HANDOFF -> CODEX with From: CODEX is not mirrored back to Codex', async () => {
  const calls = [];
  const out = await run(mk('HANDOFF -> CODEX\nFrom: CODEX\nAction: x'), { calls });
  assert.equal(out.body.ignored, 'self_sender');
  assert.equal(calls.length, 0);
});

test('comments by a listed self actor are ignored for that route only', async () => {
  const e = { ...env, LINEAR_HANDOFF_Q_SELF_ACTOR_IDS: 'q-bot, other' };
  const calls = [];
  const q = await run(mkActor('HANDOFF -> Q\nFrom: CODEX', 'q-bot'), { e, calls });
  assert.equal(q.body.ignored, 'self_actor');
  const c = await run(mkActor('HANDOFF -> CODEX\nFrom: Q', 'q-bot', { id: 'c9' }), { e, calls });
  assert.equal(c.body.forwarded, true);
  assert.equal(calls.length, 1);
});

test('Q forward uses Bearer by default and a configurable header name', async () => {
  const calls = [];
  await run(mk('HANDOFF -> Q\nFrom: CODEX'), { calls });
  assert.equal(calls[0].o.headers.Authorization, 'Bearer k');
  const calls2 = [];
  await run(mk('HANDOFF -> Q\nFrom: CODEX', { id: 'c2' }), { calls: calls2, e: { ...env, LINEAR_HANDOFF_Q_WEBHOOK_HEADER: 'X-Api-Key' } });
  assert.equal(calls2[0].o.headers['X-Api-Key'], 'k');
  assert.equal(calls2[0].o.headers.Authorization, undefined);
});

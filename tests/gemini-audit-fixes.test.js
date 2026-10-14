// Regression tests for the Oct 2026 attribution audit fixes (#1, #5-#10).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceReportHandler } from '../pages/api/attribution/sources.js';
import { createDeferredIdentityCronHandler } from '../pages/api/cron/deferred-booking-identity.js';
import { selectBridge } from '../lib/attribution-bridge.js';
import { createDeferredIdentityStore, sweepDeferredIdentities } from '../lib/deferred-booking-identity.js';
import { recordJobSource } from '../lib/job-source.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { alertBodyForError, sanitizeAlertText } from '../lib/q-alert.js';
import { createResponse } from './webhook-test-helpers.js';

const DAY = 24 * 60 * 60;
const HOST = 'mounting-man-dashboard.vercel.app';

function fakeKv({ withIncr = true } = {}) {
  const values = new Map();
  const sets = new Map();
  const writes = [];
  const expires = [];
  const kv = {
    values, sets, writes, expires,
    async set(key, value, options = {}) {
      writes.push({ key, options });
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async del(key) { sets.delete(key); return values.delete(key) ? 1 : 0; },
    async sadd(key, ...members) {
      const set = sets.get(key) || new Set();
      members.forEach((m) => set.add(m));
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) { return [...(sets.get(key) || [])]; },
    async srem(key, ...members) { const set = sets.get(key); members.forEach((m) => set?.delete(m)); return 1; },
    async expire(key, seconds) { expires.push({ key, seconds }); return 1; },
  };
  if (withIncr) {
    kv.incr = async (key) => {
      const next = (Number(values.get(key)) || 0) + 1;
      values.set(key, next);
      return next;
    };
  }
  return kv;
}

function stubStore() {
  return {
    async listSourceMonths() { return []; },
    async listJobSources() { return []; },
  };
}

// #1
test('#1 source report rejects unauthenticated and cross-site requests', async () => {
  const handler = createSourceReportHandler({ attributionStore: stubStore(), env: { CRON_SECRET: 'cron-secret-value' } });
  for (const headers of [
    {},
    { host: HOST },
    { host: HOST, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    { host: HOST, 'sec-fetch-site': 'same-origin', referer: 'https://evil.example/' },
    { host: HOST, authorization: 'Bearer wrong' },
  ]) {
    const res = createResponse();
    await handler({ method: 'GET', headers }, res);
    assert.equal(res.statusCode, 401, JSON.stringify(headers));
    assert.equal(res.body.months, undefined);
  }
});

test('#1 source report still serves the dashboard panel and operator bearer callers', async () => {
  const handler = createSourceReportHandler({ attributionStore: stubStore(), env: { CRON_SECRET: 'cron-secret-value', MCP_SQUARE_PAYROLL_SECRET: 'mcp-secret-value' } });
  for (const headers of [
    { host: HOST, 'sec-fetch-site': 'same-origin', referer: `https://${HOST}/` },
    { host: HOST, 'sec-fetch-site': 'same-origin' },
    { host: HOST, authorization: 'Bearer cron-secret-value' },
    { host: HOST, authorization: 'Bearer mcp-secret-value' },
  ]) {
    const res = createResponse();
    await handler({ method: 'GET', headers }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
    assert.ok(Array.isArray(res.body.months));
  }
});

// #5
test('#5 a later payload without totals keeps the stored revenue', async () => {
  const store = createAttributionStore(fakeKv());
  await recordJobSource({ store, payload: { data: { id: 'job-r', created: '2026-10-06T18:02:00.000Z', invoice: { total: 250 }, customer: { id: 'cust-r' } } } });
  await recordJobSource({ store, payload: { data: { id: 'job-r', created: '2026-10-06T18:02:00.000Z', customer: { id: 'cust-r' } } } });
  assert.equal((await store.getJobSource('job-r')).revenue, 250);
  await recordJobSource({ store, payload: { data: { id: 'job-r', created: '2026-10-06T18:02:00.000Z', invoice: { total: 300 }, customer: { id: 'cust-r' } } } });
  assert.equal((await store.getJobSource('job-r')).revenue, 300);
});

// #6
test('#6 one capture between two far-apart jobs binds to neither', () => {
  const W = 60 * 60 * 1000;
  const t = (ms) => new Date(Date.parse('2026-10-06T12:00:00Z') + ms).toISOString();
  const jobs = [{ jobId: 'A', createdAt: t(0) }, { jobId: 'B', createdAt: t(1.5 * W) }];
  const captures = [{ sessionRef: 's1', capturedAt: t(0.9 * W) }];
  assert.equal(selectBridge({ captures, jobs, anchorCreatedAt: t(0), windowMs: W }).decision, 'no_bridge');
  assert.equal(selectBridge({ captures, jobs, anchorCreatedAt: t(1.5 * W), windowMs: W }).decision, 'no_bridge');
  const single = selectBridge({ captures, jobs: [jobs[0]], anchorCreatedAt: t(0), windowMs: W });
  assert.equal(single.decision, 'bridge');
  assert.equal(single.job.jobId, 'A');
});

// #7
test('#7 sweep is not starved by waiting items and attempts refresh the index TTL', async () => {
  const kv = fakeKv();
  const idStore = createDeferredIdentityStore(kv);
  const NOW = Date.parse('2026-10-13T15:00:00.000Z');
  // 60 fresh (not yet due) items, then one due item.
  for (let i = 0; i < 60; i += 1) await idStore.savePending({ bookingSession: `wait-${i}`, customerId: 'c', now: NOW - 1000 });
  const due = await idStore.savePending({ bookingSession: 'due-1', customerId: 'c', now: NOW - 2 * 60 * 60 * 1000 });
  const seen = [];
  const summary = await sweepDeferredIdentities({
    idStore,
    attributionStore: { async getJobIdForSession() { seen.push('lookup'); return null; } },
    loadJob: async () => null,
    upload: async () => { throw new Error('should not upload'); },
    logger: { info() {}, warn() {}, error() {} },
    now: NOW,
    limit: 50,
  });
  assert.equal(summary.scanned, 61);
  assert.equal(summary.counts.waiting, 60);
  assert.ok(Object.keys(summary.counts).some((k) => k !== 'waiting'), JSON.stringify(summary));
  kv.expires.length = 0;
  await idStore.recordAttempt(due.sessionRef, { nextAttemptAt: NOW + 1000 });
  assert.ok(kv.expires.some((e) => e.key === 'ec:pending-index' && e.seconds > 0));
});

// #8
test('#8 alert text redacts contact data and secrets', () => {
  const body = alertBodyForError(Object.assign(new Error('Failed for jane.doe@gmail.com (612) 555-1234 url=/x?secret=abc123 Bearer tok_live'), { name: 'TypeError' }));
  assert.ok(body.startsWith('TypeError: '));
  for (const leak of ['jane.doe', 'gmail.com', '555-1234', 'abc123', 'tok_live']) assert.equal(body.includes(leak), false, leak);
  assert.equal(sanitizeAlertText('', 'fallback'), 'fallback');
  assert.ok(sanitizeAlertText('x'.repeat(1000)).length <= 300);
  assert.equal(alertBodyForError({}), 'Error: Unhandled error');
});

test('#8 deferred cron still authorizes the correct bearer and rejects others', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret-value';
  try {
    const handler = createDeferredIdentityCronHandler({ loadKV: async () => null, logger: { info() {}, error() {} } });
    const bad = createResponse();
    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret-valuX' }, query: {} }, bad);
    assert.equal(bad.statusCode, 401);
    const good = createResponse();
    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret-value' }, query: {} }, good);
    assert.equal(good.statusCode, 500); // passes auth, then stops at "KV not configured" (no sweep run)
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

// #9
test('#9 success markers and payment bindings expire with the 400-day retention; old identity members are pruned', async () => {
  const kv = fakeKv();
  const store = createAttributionStore(kv);
  await store.markSuccess('job-ttl', {});
  await store.bindPaymentToJob('pay-ttl', 'job-ttl');
  const success = kv.writes.find((w) => w.key.startsWith('conv:success:'));
  const binding = kv.writes.find((w) => w.key.startsWith('attrib:payment-binding:'));
  assert.equal(success.options.ex, 400 * DAY);
  assert.equal(binding.options.ex, 400 * DAY);

  const token = `e:${'a'.repeat(64)}`;
  const key = `attrib:src-who:${token}`;
  const ancient = Date.now() - 500 * DAY * 1000;
  kv.sets.set(key, new Set([`${ancient}:${'b'.repeat(24)}`]));
  const repeat = await store.flagRepeatIdentity({ jobId: 'job-new', tokens: [token], createdAt: new Date().toISOString() });
  assert.equal(repeat, false);
  assert.equal([...kv.sets.get(key)].some((m) => m.startsWith(`${ancient}:`)), false);
});

// #10
test('#10 identity resolve limiter is atomic under concurrency', async () => {
  const kv = fakeKv();
  const store = createAttributionStore(kv);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.allowRecentIdentityResolve('sess-limit', { limit: 3 })));
  assert.equal(results.filter(Boolean).length, 3);
});

test('#10 concurrent session touches keep the first touch', async () => {
  const kv = fakeKv();
  const store = createAttributionStore(kv);
  const first = { utmSource: 'google', utmMedium: 'organic' };
  const later = { referrerHost: 'chatgpt.com' };
  await Promise.all([
    store.saveSessionTouch({ bookingSession: 'sess-touch', first, last: first }),
    store.saveSessionTouch({ bookingSession: 'sess-touch', first: later, last: later }),
  ]);
  const touch = await store.getSessionTouch({ bookingSession: 'sess-touch' });
  assert.ok(touch.first);
  assert.ok(touch.last);
  assert.equal(kv.values.has([...kv.values.keys()].find((k) => k.startsWith('attrib:lock:'))), false);
});

// Follow-ups
test('empty touches never overwrite the stored last touch', async () => {
  const { createVisitHandler } = await import('../pages/api/attribution/visit.js');
  const store = createAttributionStore(fakeKv());
  const real = { referrerHost: 'chatgpt.com', landingPath: '/samsung-frame/', at: '2026-10-06T18:00:00.000Z' };
  await store.saveSessionTouch({ bookingSession: 'sess-empty', first: real, last: real });
  const handler = createVisitHandler({ attributionStore: store, origins: new Set(['https://www.themountingman.com']), logger: { error() {} } });
  for (const body of [{ booking_session: 'sess-empty', first: null, last: null }, { booking_session: 'sess-empty', first: {}, last: { at: '2026-10-07T00:00:00Z' } }]) {
    const res = createResponse();
    await handler({ method: 'POST', headers: { origin: 'https://www.themountingman.com' }, body }, res);
    assert.equal(res.statusCode, 200);
  }
  await store.saveSessionTouch({ bookingSession: 'sess-empty', first: { landingPath: '' }, last: { utmSource: '' } });
  const touch = await store.getSessionTouch({ bookingSession: 'sess-empty' });
  assert.equal(touch.last.referrerHost, 'chatgpt.com');
  assert.equal(touch.first.referrerHost, 'chatgpt.com');
});

test('short all-digit gclids are rejected; real click ids kept', async () => {
  const { sanitizeTouch } = await import('../lib/source-classifier.js');
  assert.equal(sanitizeTouch({ gclid: '6125550100' }).gclid, '');
  assert.equal(sanitizeTouch({ gbraid: '16125550100' }).gbraid, '');
  const realId = 'Cj0KCQjw' + '1234567890'.repeat(3) + 'AbC_d-E';
  assert.equal(sanitizeTouch({ gclid: realId }).gclid, realId);
  assert.equal(sanitizeTouch({ gclid: 'ok-click' }).gclid, 'ok-click');
});

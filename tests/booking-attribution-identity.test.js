import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import { completedPayload, createRequest, createResponse, installTestEnvironment } from './webhook-test-helpers.js';

// In-memory KV only: exercise the production lookup, never an external service.
function memoryKv() {
  const values = new Map();
  return {
    async set(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.get(key) ?? null; },
    async del(key) { values.delete(key); },
    async sadd() {},
    async smembers() { return []; },
    async expire() {},
  };
}

test('webhook attribution is isolated per booking across repeat customers and retries', async (t) => {
  t.after(installTestEnvironment());
  const kv = memoryKv();
  const store = createAttributionStore(kv);
  const calls = [];
  const logs = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: store,
    coordinator: { async registerJob(job) { calls.push(job); return { status: 'observed' }; } },
    disclosureVersion: '2026-07-10',
    logger: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push(args)])),
  });
  for (const suffix of ['first', 'second']) {
    await store.saveBookingAttribution({
      zenCustomerId: 'test-customer-123',
      bookingSession: `session-${suffix}`,
      acquisition: { paidEvidence: true, paidMarker: 'gclid' },
      gclid: `private-click-${suffix}`,
      gbraid: `private-app-${suffix}`,
      wbraid: `private-web-${suffix}`,
    });
    await store.saveJobMapping({ jobId: `job-${suffix}`, squareCustomerId: 'square-repeat-customer' });
  }
  const responses = [];
  async function deliver(overrides) {
    const res = createResponse();
    await handler(createRequest(completedPayload(overrides)), res);
    responses.push(res.body);
    assert.equal(res.statusCode, 200);
    return res.body;
  }

  for (const booking_session of [undefined, null, '', '   ', 'unknown-session']) {
    // Prior paid history must not turn a new organic booking into paid evidence.
    const before = calls.length;
    const organic = await deliver({ id: 'job-second', booking_session, tracking: { source: 'Google' } });
    assert.equal(organic.reason, 'NO_PAID_ACQUISITION');
    assert.equal(calls.length, before);
    // A booking with its own paid evidence may proceed, without borrowed IDs.
    await deliver({ id: 'job-second', booking_session });
    for (const field of ['gclid', 'gbraid', 'wbraid']) assert.equal(calls.at(-1)[field], null);
  }
  // Replays of the first booking still use its session, even after a newer capture.
  for (const suffix of ['first', 'second', 'first']) {
    await deliver({ id: `job-${suffix}`, booking_session: `session-${suffix}`, tracking: { source: 'Google' } });
    const job = calls.at(-1);
    assert.equal(job.jobId, `job-${suffix}`);
    assert.equal(job.gclid, `private-click-${suffix}`);
    assert.equal(job.gbraid, `private-app-${suffix}`);
    assert.equal(job.wbraid, `private-web-${suffix}`);
  }
  await deliver({ id: 'job-first', booking_session: 'session-first', tracking: { gclid: 'own-webhook-click' } });
  assert.equal(calls.at(-1).gclid, 'own-webhook-click');

  const beforeDenied = calls.length;
  assert.equal((await deliver({ id: 'job-first', booking_session: 'session-first', consent: { ad_user_data: 'DENIED' } })).reason, 'CONSENT_DENIED');
  assert.equal(calls.length, beforeDenied);

  const originalGet = kv.get;
  kv.get = async () => { throw new Error('synthetic read failure'); };
  const failed = await deliver({ id: 'job-first', booking_session: 'session-first' });
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorCode, 'ATTRIBUTION_PROCESSING_FAILED');
  assert.equal(calls.length, beforeDenied);
  kv.get = originalGet;
  await deliver({ id: 'job-first', booking_session: 'session-first' });
  assert.equal(calls.at(-1).gclid, 'private-click-first');
  assert.equal(/private-click|private-app|private-web|own-webhook-click/.test(JSON.stringify({ logs, responses })), false);
});

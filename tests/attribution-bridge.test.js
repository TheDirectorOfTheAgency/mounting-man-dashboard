import assert from 'node:assert/strict';
import test from 'node:test';

import { considerIncomingJob, defaultListJobs } from '../lib/attribution-bridge.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import { completedPayload, createRequest, createResponse, installTestEnvironment } from './webhook-test-helpers.js';

const T0 = '2026-10-06T18:00:00.000Z';
const CUSTOMER = 'test-customer-123';
const GCLID = 'bridge-gclid-single';
const GBRAID = 'bridge-gbraid-single';
const WBRAID = 'bridge-wbraid-single';

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    values,
    sets,
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
    async sadd(key, ...members) {
      const set = sets.get(key) || new Set();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || new Set())];
    },
    async expire() {
      return 1;
    },
  };
}

function captureLogs(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  t.after(() => {
    console.log = original;
  });
  return lines;
}

function decisions(lines) {
  return lines
    .filter((line) => line.startsWith('ZB_BRIDGE_DECISION '))
    .map((line) => JSON.parse(line.slice('ZB_BRIDGE_DECISION '.length)));
}

function assertNoClickValues(text) {
  for (const secret of [GCLID, GBRAID, WBRAID, 'summary-gclid-win', 'window-gclid-other', 'exact-gclid-win']) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
}

async function seedCapture(store, {
  session,
  at,
  gclid = GCLID,
  gbraid = GBRAID,
  wbraid = WBRAID,
  customer = CUSTOMER,
}) {
  await store.saveBookingAttribution({
    zenCustomerId: customer,
    bookingSession: session,
    capturedAt: at,
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    gclid,
    gbraid,
    wbraid,
  });
}

function handlerFor(store, { mode = 'shadow', calls = [] } = {}) {
  return createZenbookerWebhookHandler({
    attributionStore: store,
    attributionBridgeMode: mode,
    listJobs: async () => [],
    coordinator: {
      async registerJob(job) {
        calls.push(job);
        return { status: 'observed' };
      },
    },
    disclosureVersion: '2026-07-10',
    logger: { info() {}, warn() {}, error() {} },
  });
}

async function deliver(handler, overrides) {
  const res = createResponse();
  await handler(createRequest(completedPayload({
    tracking: { source: 'direct' },
    ...overrides,
  })), res);
  return res;
}

test('a single in-window capture bridges one job and shadow mode does not attach click ids', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const calls = [];
  await seedCapture(store, { session: 'session-single', at: T0 });
  const res = await deliver(handlerFor(store, { calls }), {
    id: 'job-single',
    created: '2026-10-06T18:02:00.000Z',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(calls.length, 0);
  const bridge = await store.getJobBridge('job-single');
  assert.equal(bridge.source, 'window');
  assert.equal(bridge.gclid, GCLID);
  const decision = decisions(lines).at(-1);
  assert.deepEqual(decision, {
    jobId: 'job-single',
    decision: 'bridge',
    reason: 'single_match',
    hasGclid: true,
    hasGbraid: true,
    hasWbraid: true,
  });
  assertNoClickValues(lines.join('\n'));
  assertNoClickValues(JSON.stringify(res.body));
  const storedKeys = [...kv.values.keys(), ...kv.sets.keys()];
  assert.equal(storedKeys.some((key) => key.includes(CUSTOMER) || key.includes('session-single')), false);
});

test('a repeat customer capture outside the window does not bridge', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  await seedCapture(store, { session: 'session-old', at: '2026-10-06T16:00:00.000Z' });
  const res = await deliver(handlerFor(store), {
    id: 'job-repeat',
    created: T0,
  });

  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(await store.getJobBridge('job-repeat'), null);
  assert.deepEqual(decisions(lines).at(-1), {
    jobId: 'job-repeat',
    decision: 'no_bridge',
    reason: 'no_capture',
    hasGclid: false,
    hasGbraid: false,
    hasWbraid: false,
  });
});

test('two captures inside the window do not bridge', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  const calls = [];
  await seedCapture(store, { session: 'session-a', at: T0, gclid: 'window-gclid-other' });
  await seedCapture(store, { session: 'session-b', at: '2026-10-06T18:04:00.000Z' });
  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-ambiguous-captures',
    created: '2026-10-06T18:02:00.000Z',
  });

  assert.equal(calls.length, 0);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(await store.getJobBridge('job-ambiguous-captures'), null);
  assert.equal(decisions(lines).at(-1).reason, 'multiple_captures');
  assert.equal(decisions(lines).at(-1).decision, 'no_bridge');
  assertNoClickValues(lines.join('\n'));
});

test('a second job inside the window revokes the bridge', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  const listJobs = async () => [];
  await seedCapture(store, { session: 'session-one-job', at: T0 });
  const first = {
    type: 'job.created',
    data: {
      id: 'job-first',
      created: T0,
      status: 'scheduled',
      customer: { id: CUSTOMER },
    },
  };
  const second = {
    type: 'job.created',
    data: {
      id: 'job-second',
      created: '2026-10-06T18:05:00.000Z',
      status: 'scheduled',
      customer: { id: CUSTOMER },
    },
  };
  await considerIncomingJob({ payload: first, store, listJobs });
  assert.equal((await store.getJobBridge('job-first')).source, 'window');
  await considerIncomingJob({ payload: second, store, listJobs });

  assert.equal(await store.getJobBridge('job-first'), null);
  assert.equal(await store.getJobBridge('job-second'), null);
  assert.equal(decisions(lines).at(-1).reason, 'multiple_jobs');
  assert.equal(decisions(lines).at(-1).hasGclid, false);

  const calls = [];
  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-first',
    created: T0,
  });
  assert.equal(calls.length, 0);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(decisions(lines).at(-1).reason, 'multiple_jobs');
  assertNoClickValues(lines.join('\n'));
});

test('live mode attaches the single-match click ids and shadow mode does not', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const created = '2026-10-06T18:02:00.000Z';

  const shadowStore = createAttributionStore(createFakeKv());
  const shadowCalls = [];
  await seedCapture(shadowStore, { session: 'session-shadow', at: T0 });
  await deliver(handlerFor(shadowStore, { calls: shadowCalls }), { id: 'job-shadow', created });
  assert.equal(shadowCalls.length, 0);

  const liveStore = createAttributionStore(createFakeKv());
  const liveCalls = [];
  await seedCapture(liveStore, { session: 'session-live', at: T0 });
  await liveStore.saveJobMapping({ jobId: 'job-live', squareCustomerId: 'square-customer-1' });
  const res = await deliver(handlerFor(liveStore, { mode: 'live', calls: liveCalls }), {
    id: 'job-live',
    created,
  });

  assert.equal(res.body.status, 'observed');
  assert.equal(liveCalls.length, 1);
  assert.equal(liveCalls[0].gclid, GCLID);
  assert.equal(liveCalls[0].gbraid, GBRAID);
  assert.equal(liveCalls[0].wbraid, WBRAID);
  assert.equal(liveCalls[0].acquisition.paidEvidence, true);
  assert.equal(decisions(lines).at(-1).reason, 'single_match');
  assertNoClickValues(lines.join('\n'));
  assertNoClickValues(JSON.stringify(res.body));
});

test('an explicit booking session wins over a different in-window capture', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  const calls = [];
  await seedCapture(store, { session: 'session-window', at: T0, gclid: 'window-gclid-other' });
  await seedCapture(store, {
    session: 'session-exact',
    at: T0,
    gclid: 'exact-gclid-win',
    gbraid: null,
    wbraid: null,
  });
  await store.saveJobMapping({ jobId: 'job-exact', squareCustomerId: 'square-customer-1' });
  const res = await deliver(handlerFor(store, { calls }), {
    id: 'job-exact',
    created: '2026-10-06T18:01:00.000Z',
    booking_session: 'session-exact',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].gclid, 'exact-gclid-win');
  assert.equal((await store.getJobBridge('job-exact')).source, 'exact_session');
  assert.equal(decisions(lines).at(-1).reason, 'exact_session');
  assert.equal(res.body.status, 'observed');
  assertNoClickValues(lines.join('\n'));
});

test('conversion_summary click ids win over the window and attach only in live mode', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const created = '2026-10-06T18:03:00.000Z';
  const summary = { gclid: 'summary-gclid-win' };

  const shadowStore = createAttributionStore(createFakeKv());
  const shadowCalls = [];
  await seedCapture(shadowStore, { session: 'session-summary', at: T0, gclid: 'window-gclid-other' });
  const shadow = await deliver(handlerFor(shadowStore, { calls: shadowCalls }), {
    id: 'job-summary',
    created,
    conversion_summary: summary,
  });
  assert.equal(shadowCalls.length, 0);
  assert.equal(shadow.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal((await shadowStore.getJobBridge('job-summary')).source, 'conversion_summary');
  assert.equal(decisions(lines).at(-1).reason, 'summary_click_ids');
  assert.equal(decisions(lines).at(-1).hasGclid, true);

  const liveStore = createAttributionStore(createFakeKv());
  const liveCalls = [];
  await seedCapture(liveStore, { session: 'session-summary-live', at: T0, gclid: 'window-gclid-other' });
  await liveStore.saveJobMapping({ jobId: 'job-summary-live', squareCustomerId: 'square-customer-1' });
  await deliver(handlerFor(liveStore, { mode: 'live', calls: liveCalls }), {
    id: 'job-summary-live',
    created,
    conversion_summary: summary,
  });
  assert.equal(liveCalls[0].gclid, 'summary-gclid-win');
  assert.equal(liveCalls[0].gbraid, null);
  assertNoClickValues(lines.join('\n'));
});

test('a top-level job envelope records created time and summary click ids', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const envelopes = [
    {
      id: 'job-nested',
      payload: {
        data: {
          job: {
            id: 'job-nested',
            created: T0,
            customer: { id: CUSTOMER },
          },
        },
      },
    },
    {
      id: 'job-top',
      payload: {
        data: { type: 'job.created' },
        job: {
          id: 'job-top',
          created: T0,
          customer: { id: CUSTOMER },
          conversion_summary: { gclid: 'summary-gclid-win' },
        },
      },
    },
  ];

  for (const envelope of envelopes) {
    const store = createAttributionStore(createFakeKv());
    await seedCapture(store, { session: `session-${envelope.id}`, at: T0 });
    const decision = await considerIncomingJob({
      payload: envelope.payload,
      store,
      listJobs: async () => [],
    });
    assert.equal(decision.jobId, envelope.id);
    assert.equal(decision.decision, 'bridge');
    const bridge = await store.getJobBridge(envelope.id);
    assert.equal(bridge.gclid, envelope.id === 'job-top' ? 'summary-gclid-win' : GCLID);
    assert.equal(bridge.source, envelope.id === 'job-top' ? 'conversion_summary' : 'window');
  }
  assert.equal(decisions(lines).at(-1).reason, 'summary_click_ids');
  assertNoClickValues(lines.join('\n'));
});

test('a missing booking session uses summary click ids and keeps an existing summary', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  const calls = [];
  await seedCapture(store, { session: 'session-other-job', at: T0, gclid: 'window-gclid-other' });
  await store.saveJobMapping({ jobId: 'job-session-miss', squareCustomerId: 'square-customer-1' });
  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-session-miss',
    created: T0,
    booking_session: 'session-missing',
    conversion_summary: { gclid: 'summary-gclid-win' },
  });

  assert.equal(res.body.status, 'observed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gclid, 'summary-gclid-win');
  assert.equal((await store.getJobBridge('job-session-miss')).source, 'conversion_summary');
  assert.equal(decisions(lines).at(-1).reason, 'summary_click_ids');

  const keptCalls = [];
  await deliver(handlerFor(store, { mode: 'live', calls: keptCalls }), {
    id: 'job-session-miss',
    created: T0,
    booking_session: 'session-still-missing',
  });
  assert.equal(keptCalls.length, 1);
  assert.equal(keptCalls[0].gclid, 'summary-gclid-win');
  assert.equal((await store.getJobBridge('job-session-miss')).source, 'conversion_summary');
  assert.equal((await store.getJobBridge('job-session-miss')).gclid, 'summary-gclid-win');
  assert.equal(decisions(lines).at(-1).reason, 'summary_click_ids');
  assertNoClickValues(lines.join('\n'));
  assertNoClickValues(JSON.stringify(res.body));
});

test('a missing booking session does not fall back to the time window', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  const calls = [];
  await seedCapture(store, { session: 'session-window-only', at: T0 });
  await store.saveJobMapping({ jobId: 'job-no-window-fallback', squareCustomerId: 'square-customer-1' });
  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-no-window-fallback',
    created: T0,
    booking_session: 'session-missing',
  });

  assert.equal(calls.length, 0);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(await store.getJobBridge('job-no-window-fallback'), null);
  assert.equal(decisions(lines).at(-1).reason, 'session_not_found');
  assertNoClickValues(lines.join('\n'));
});

test('an unavailable job listing does not create a window bridge', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const store = createAttributionStore(createFakeKv());
  await seedCapture(store, { session: 'session-unlisted', at: T0 });
  const decision = await considerIncomingJob({
    payload: {
      data: {
        id: 'job-unlisted',
        created: T0,
        customer: { id: CUSTOMER },
      },
    },
    store,
    listJobs: async () => null,
  });

  assert.equal(decision.reason, 'job_count_unavailable');
  assert.equal(decision.decision, 'no_bridge');
  assert.equal(await store.getJobBridge('job-unlisted'), null);
  const missingKey = await defaultListJobs({
    zenCustomerId: CUSTOMER,
    createdAfter: T0,
    createdBefore: T0,
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.deepEqual(missingKey, { error: true });
  const badBody = await defaultListJobs({
    zenCustomerId: CUSTOMER,
    createdAfter: T0,
    createdBefore: T0,
    env: { ZENBOOKER_API_KEY: 'test-key' },
    fetchImpl: async () => ({
      ok: true,
      text: async () => '{"results":{"id":"not-a-list"}}',
    }),
  });
  assert.deepEqual(badBody, { error: true });
  assertNoClickValues(lines.join('\n'));
});

test('a completed top-level job envelope attaches summary click ids only in live mode', async (t) => {
  t.after(installTestEnvironment());
  const lines = captureLogs(t);
  const job = {
    id: 'job-envelope-live',
    status: 'completed',
    created_by: 'customer',
    created: T0,
    completed_at: '2026-07-09T18:30:00-05:00',
    booking_session: 'session-missing',
    customer: {
      id: CUSTOMER,
      email: 'test.person@example.com',
      phone: '6125550100',
      first_name: 'Test',
      last_name: 'Person',
    },
    tracking: { source: 'direct' },
    conversion_summary: { gclid: 'summary-gclid-win' },
  };

  const shadowStore = createAttributionStore(createFakeKv());
  const shadowCalls = [];
  const shadowRes = createResponse();
  await handlerFor(shadowStore, { calls: shadowCalls })(createRequest({
    event: 'job.completed',
    job,
  }), shadowRes);
  assert.equal(shadowCalls.length, 0);
  assert.equal(shadowRes.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal((await shadowStore.getJobBridge('job-envelope-live')).source, 'conversion_summary');

  const liveStore = createAttributionStore(createFakeKv());
  const liveCalls = [];
  await liveStore.saveJobMapping({ jobId: 'job-envelope-live', squareCustomerId: 'square-customer-1' });
  const liveRes = createResponse();
  await handlerFor(liveStore, { mode: 'live', calls: liveCalls })(createRequest({
    event: 'job.completed',
    job,
  }), liveRes);
  assert.equal(liveRes.body.status, 'observed');
  assert.equal(liveCalls.length, 1);
  assert.equal(liveCalls[0].gclid, 'summary-gclid-win');
  assert.equal(decisions(lines).at(-1).reason, 'summary_click_ids');
  assertNoClickValues(lines.join('\n'));
  assertNoClickValues(JSON.stringify(liveRes.body));
});

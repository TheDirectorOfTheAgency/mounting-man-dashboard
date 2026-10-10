import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import { createVisitHandler } from '../pages/api/attribution/visit.js';
import { createSourceReportHandler } from '../pages/api/attribution/sources.js';
import { buildSourceReport, recordJobSource } from '../lib/job-source.js';
import { completedPayload, createRequest, createResponse, installTestEnvironment } from './webhook-test-helpers.js';

const T0 = '2026-10-06T18:00:00.000Z';
const CREATED = '2026-10-06T18:02:00.000Z';
const CUSTOMER = 'test-customer-123';
const GCLID = 'paid-click-kept';

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

test('an unpaid session matches a job and does not attach a click id', async (t) => {
  t.after(installTestEnvironment());
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const calls = [];
  await store.saveSessionTouch({
    bookingSession: 'sess-organic',
    zenCustomerId: CUSTOMER,
    capturedAt: T0,
    first: { referrerHost: 'www.google.com', referrerPath: '/search' },
    last: { referrerHost: 'chatgpt.com', referrerPath: '/' },
  });

  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-organic',
    created: CREATED,
    booking_session: 'sess-organic',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  assert.equal(calls.length, 0);
  const bridge = await store.getJobBridge('job-organic');
  assert.equal(bridge.source, 'exact_session');
  assert.equal(bridge.gclid, null);
  assert.equal(bridge.acquisition.paidEvidence, false);
  const report = createSourceReportHandler({ attributionStore: store });
  const reportRes = createResponse();
  await report({ method: 'GET' }, reportRes);
  const month = reportRes.body.months[0];
  assert.equal(month.jobs, 1);
  assert.equal(month.revenue, 499.5);
  assert.equal(month.byFirstTouch.find((row) => row.bucket === 'google_organic').jobs, 1);
  assert.equal(month.byLastTouch.find((row) => row.bucket === 'ai_assistant').jobs, 1);
  assert.equal(month.unknownJobs, 0);
  const stored = JSON.stringify([...kv.values.values()]);
  assert.equal(stored.includes('test.person@example.com'), false);
  assert.equal(stored.includes('6125550100'), false);
  assert.equal(reportRes.body.months[0].jobs, 1);
  assert.equal(JSON.stringify(reportRes.body).includes('test.person@example.com'), false);
});

test('an unpaid session matches by the bridge window when the job has no session field', async (t) => {
  t.after(installTestEnvironment());
  const store = createAttributionStore(createFakeKv());
  await store.saveSessionTouch({
    bookingSession: 'sess-window',
    zenCustomerId: CUSTOMER,
    capturedAt: T0,
    first: { referrerHost: 'www.yelp.com' },
    last: { utmMedium: 'email', utmSource: 'newsletter' },
  });

  const res = await deliver(handlerFor(store), {
    id: 'job-window',
    created: CREATED,
  });

  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
  const bridge = await store.getJobBridge('job-window');
  assert.equal(bridge.source, 'window');
  assert.equal(bridge.gclid, null);
  const rows = await store.listJobSources('2026-10');
  assert.equal(rows[0].firstBucket, 'yelp');
  assert.equal(rows[0].lastBucket, 'email');
  assert.equal(rows[0].revenue, 499.5);
});

test('a paid click still bridges when an unpaid session is in the same window', async (t) => {
  t.after(installTestEnvironment());
  const store = createAttributionStore(createFakeKv());
  const calls = [];
  await store.saveBookingAttribution({
    zenCustomerId: CUSTOMER,
    bookingSession: 'sess-paid',
    capturedAt: T0,
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    gclid: GCLID,
  });
  await store.saveSessionTouch({
    bookingSession: 'sess-other',
    zenCustomerId: CUSTOMER,
    capturedAt: T0,
    first: { referrerHost: 'www.yelp.com' },
    last: { referrerHost: 'www.yelp.com' },
  });
  await store.saveJobMapping({ jobId: 'job-paid', squareCustomerId: 'square-customer-1' });

  const res = await deliver(handlerFor(store, { mode: 'live', calls }), {
    id: 'job-paid',
    created: CREATED,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].gclid, GCLID);
  assert.equal(calls[0].acquisition.paidEvidence, true);
  assert.equal((await store.getJobBridge('job-paid')).source, 'window');
  assert.equal(res.body.status, 'observed');
});

test('unmatched jobs stay unknown and a repeat customer is flagged', async () => {
  const store = createAttributionStore(createFakeKv());
  const first = await recordJobSource({
    store,
    jobId: 'job-first',
    createdAt: CREATED,
    zenCustomerId: CUSTOMER,
    email: 'repeat@example.com',
    phone: '6125550199',
    revenue: 200,
  });
  const second = await recordJobSource({
    store,
    jobId: 'job-second',
    createdAt: '2026-10-20T15:00:00.000Z',
    zenCustomerId: CUSTOMER,
    email: 'repeat@example.com',
    phone: '6125550199',
    revenue: 300,
  });
  assert.equal(first.repeat, false);
  assert.equal(first.lastBucket, 'unknown');
  assert.equal(second.repeat, true);
  assert.equal(second.lastBucket, 'unknown');

  const report = buildSourceReport([first, second]);
  assert.equal(report.months[0].unknownJobs, 2);
  assert.equal(report.months[0].repeatJobs, 1);
  assert.equal(report.months[0].byLastTouch.find((row) => row.bucket === 'unknown').share, 1);
  const rendered = JSON.stringify(report);
  assert.equal(rendered.includes('repeat@example.com'), false);
  assert.equal(rendered.includes('6125550199'), false);
});

test('visit capture stores the touch and returns nothing about the customer', async () => {
  const saved = [];
  const handler = createVisitHandler({
    attributionStore: {
      async saveSessionTouch(value) {
        saved.push(value);
        return { touch: { capturedAt: T0 } };
      },
      async listObservedJobs() { return []; },
    },
    origins: new Set(['https://www.themountingman.com']),
    logger: { error() {} },
  });
  const res = createResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://www.themountingman.com' },
    body: {
      booking_session: 'sess-visit',
      customer_id: 'cust-1',
      email: 'person@example.com',
      phone: '6125550100',
      first: { referrerHost: 'chatgpt.com', email: 'person@example.com' },
      last: { utmSource: 'google', utmMedium: 'organic', utmCampaign: 'gbp', phone: '6125550100' },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { captured: true });
  assert.equal(saved[0].first.referrerHost, 'chatgpt.com');
  assert.equal(saved[0].last.utmCampaign, 'gbp');
  assert.equal(JSON.stringify(saved).includes('person@example.com'), false);
  assert.equal(JSON.stringify(saved).includes('6125550100'), false);

  const foreign = createResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: { booking_session: 'sess-visit' },
  }, foreign);
  assert.equal(foreign.statusCode, 403);
});

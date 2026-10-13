import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  BOOKED_APPOINTMENT_ACTION_ID,
  createDeferredIdentityStore,
  createEnhancementUploader,
  resolveDeferredForJob,
  sweepDeferredIdentities,
} from '../lib/deferred-booking-identity.js';
import { opaqueRef } from '../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createBookingIdentityHandler } from '../pages/api/attribution/booking-identity.js';
import { createDeferredIdentityCronHandler } from '../pages/api/cron/deferred-booking-identity.js';
import { createResponse } from './webhook-test-helpers.js';

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const EMAIL = 'Jane.Doe@Gmail.com';
const PHONE = '(612) 555-1234';
const NOW = Date.parse('2026-10-13T15:00:00.000Z');

function memoryKv() {
  const map = new Map();
  const sets = new Map();
  return {
    map,
    sets,
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : null; },
    async set(k, v, opts = {}) {
      if (opts.nx && map.has(k)) return null;
      map.set(k, structuredClone(v));
      return 'OK';
    },
    async del(k) { map.delete(k); sets.delete(k); return 1; },
    async sadd(k, m) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); return 1; },
    async srem(k, m) { sets.get(k)?.delete(m); return 1; },
    async smembers(k) { return [...(sets.get(k) || [])]; },
    async expire() { return 1; },
  };
}

function zbJob(overrides = {}) {
  return { id: 'zb-job-1', customer: { id: 'cust-1', email: EMAIL, phone: PHONE }, ...overrides };
}

async function setup({ bridged = true } = {}) {
  const kv = memoryKv();
  const idStore = createDeferredIdentityStore(kv);
  const attributionStore = createAttributionStore(kv);
  await idStore.savePending({ bookingSession: 'sess-1', customerId: 'cust-1', now: NOW - 60_000 });
  if (bridged) {
    await attributionStore.saveJobBridge({ jobId: 'zb-job-1', sessionRef: opaqueRef('sess-1'), source: 'window' });
  }
  const uploads = [];
  const upload = async (args) => { uploads.push(args); return { ok: true }; };
  const logs = [];
  const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
  return { kv, idStore, attributionStore, uploads, upload, logs, logger };
}

test('webhook path enhances the parked booking once, by booking-session order id, hashes only', async () => {
  const ctx = await setup();
  const first = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, now: NOW });
  assert.equal(first.outcome, 'enhanced');
  assert.equal(ctx.uploads.length, 1);
  assert.equal(ctx.uploads[0].orderId, 'sess-1');
  assert.deepEqual(ctx.uploads[0].userData, {
    sha256_email_address: sha('janedoe@gmail.com'),
    sha256_phone_number: sha('+16125551234'),
  });
  // Second job event and a cron sweep must not upload again.
  assert.equal(await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, now: NOW }), null);
  const sweep = await sweepDeferredIdentities({ ...ctx, loadJob: async () => zbJob(), now: NOW });
  assert.equal(sweep.pending, 0);
  assert.equal(ctx.uploads.length, 1);
  const stored = JSON.stringify([...ctx.kv.map.entries()]);
  const logged = JSON.stringify(ctx.logs);
  for (const secret of ['Jane', 'jane', '555-1234', '6125551234', 'cust-1']) {
    assert.ok(!stored.includes(secret), `KV holds ${secret}`);
    assert.ok(!logged.includes(secret), `log holds ${secret}`);
  }
});

test('thank-you success dedupes: no pending record, deferred path never uploads', async () => {
  const ctx = await setup();
  await ctx.idStore.markThankYouResolved('sess-1');
  assert.equal(await ctx.idStore.getPending(opaqueRef('sess-1')), null);
  assert.equal(await ctx.idStore.savePending({ bookingSession: 'sess-1', customerId: 'cust-1' }), null);
  await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, now: NOW });
  await sweepDeferredIdentities({ ...ctx, loadJob: async () => zbJob(), now: NOW });
  assert.equal(ctx.uploads.length, 0);
});

test('cron waits for the session link, then fetches the job and enhances', async () => {
  const ctx = await setup({ bridged: false });
  let loads = 0;
  const loadJob = async (id) => { loads += 1; return { data: zbJob({ id }) }; };
  let sweep = await sweepDeferredIdentities({ ...ctx, loadJob, now: NOW });
  assert.deepEqual(sweep.counts, { not_linked: 1 });
  assert.equal(ctx.uploads.length, 0);
  await ctx.attributionStore.saveJobBridge({ jobId: 'zb-job-1', sessionRef: opaqueRef('sess-1'), source: 'window' });
  sweep = await sweepDeferredIdentities({ ...ctx, loadJob, now: NOW });
  assert.deepEqual(sweep.counts, { enhanced: 1 });
  assert.equal(loads, 1);
  assert.equal(ctx.uploads.length, 1);
});

test('customer mismatch, expiry and missing identifiers never upload', async () => {
  let ctx = await setup();
  let r = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob({ customer: { id: 'cust-2', email: EMAIL } }), ...ctx, now: NOW });
  assert.equal(r.outcome, 'customer_mismatch');
  ctx = await setup();
  r = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, now: NOW + 24 * 3600 * 1000 });
  assert.equal(r.outcome, 'expired');
  ctx = await setup();
  r = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob({ customer: { id: 'cust-1' } }), ...ctx, now: NOW });
  assert.equal(r.outcome, 'no_identifiers');
  assert.equal(ctx.uploads.length, 0);
});

test('transient upload failure keeps the booking parked; permanent failure drops it', async () => {
  const ctx = await setup();
  let result = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, upload: async () => ({ ok: false, permanent: false, codes: ['http_503'] }), now: NOW });
  assert.equal(result.outcome, 'upload_retry');
  assert.ok(await ctx.idStore.getPending(opaqueRef('sess-1')));
  result = await resolveDeferredForJob({ jobId: 'zb-job-1', job: zbJob(), ...ctx, upload: async () => ({ ok: false, permanent: true, codes: ['CONVERSION_NOT_FOUND'] }), now: NOW });
  assert.equal(result.outcome, 'rejected');
  assert.equal(await ctx.idStore.getPending(opaqueRef('sess-1')), null);
});

test('uploader sends an ENHANCEMENT adjustment for Booked Appointment keyed by order id', async () => {
  const posts = [];
  const upload = createEnhancementUploader({
    env: {},
    getToken: async () => 'tok',
    getDevToken: () => 'dev',
    httpClient: { post: async (url, body) => { posts.push({ url, body }); return { data: {} }; } },
  });
  const ok = await upload({ orderId: 'sess-1', userData: { sha256_email_address: 'a'.repeat(64), sha256_phone_number: 'b'.repeat(64) } });
  assert.equal(ok.ok, true);
  assert.match(posts[0].url, /:uploadConversionAdjustments$/);
  assert.deepEqual(posts[0].body.conversionAdjustments, [{
    conversionAction: `customers/1287907452/conversionActions/${BOOKED_APPOINTMENT_ACTION_ID}`,
    adjustmentType: 'ENHANCEMENT',
    orderId: 'sess-1',
    userIdentifiers: [{ hashedEmail: 'a'.repeat(64) }, { hashedPhoneNumber: 'b'.repeat(64) }],
  }]);
  assert.equal(posts[0].body.partialFailure, true);
  const already = await createEnhancementUploader({
    env: {}, getToken: async () => 't', getDevToken: () => 'd',
    httpClient: { post: async () => ({ data: { partialFailureError: { details: [{ errors: [{ errorCode: { conversionAdjustmentUploadError: 'CONVERSION_ALREADY_ENHANCED' } }] }] } } }) },
  })({ orderId: 'sess-1', userData: { sha256_email_address: 'a'.repeat(64) } });
  assert.equal(already.ok, true);
  assert.equal(already.alreadyEnhanced, true);
});

function identityRequest() {
  return {
    method: 'POST',
    headers: { origin: 'https://www.themountingman.com', 'x-forwarded-for': '203.0.113.9' },
    body: { customer_id: 'cust-1', booking_session: 'sess-9' },
  };
}

test('thank-you endpoint parks unresolved bookings and marks resolved ones', async () => {
  const kv = memoryKv();
  const idStore = createDeferredIdentityStore(kv);
  const logs = [];
  const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
  let handler = createBookingIdentityHandler({ logger, attributionStore: null, deferredStore: idStore, lookup: async () => ({ found: false, reason: 'not_found', jobsSeen: 0 }) });
  await handler(identityRequest(), createResponse());
  assert.equal((await idStore.getPending(opaqueRef('sess-9'))).orderId, 'sess-9');
  assert.equal(logs.find(([e]) => e === 'booking_identity_not_found')[1].deferred, true);
  handler = createBookingIdentityHandler({ logger, attributionStore: null, deferredStore: idStore, lookup: async () => ({ found: true, userData: { sha256_email_address: 'a'.repeat(64) }, path: 'window' }) });
  await handler(identityRequest(), createResponse());
  assert.equal(await idStore.getPending(opaqueRef('sess-9')), null);
  assert.equal(await idStore.isDone(opaqueRef('sess-9')), true);
});

test('deferred cron requires CRON_SECRET', async (t) => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  t.after(() => { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; });
  const kv = memoryKv();
  const handler = createDeferredIdentityCronHandler({ loadKV: async () => kv, upload: async () => ({ ok: true }), logger: { info() {}, error() {} } });
  let res = createResponse();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
  res = createResponse();
  await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pending, 0);
});

test('ZenBooker job webhook triggers the deferred enhancement for a linked, parked booking', async (t) => {
  const { createZenbookerToSquareHandler } = await import('../pages/api/webhooks/zenbooker-to-square.js');
  const prev = process.env.ZENBOOKER_WEBHOOK_SECRET;
  process.env.ZENBOOKER_WEBHOOK_SECRET = 's';
  t.after(() => { if (prev === undefined) delete process.env.ZENBOOKER_WEBHOOK_SECRET; else process.env.ZENBOOKER_WEBHOOK_SECRET = prev; });
  const ctx = await setup();
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => ({ id: 'sq-1' }),
    createOrder: async () => ({ order: { id: 'o' }, error: null }),
    createInvoice: async () => ({ invoice: { id: 'i', status: 'DRAFT' }, error: null }),
    readAudit: async () => null,
    writeAudit: async () => {},
    operationsNotifier: async () => {},
    loadZenbookerJob: async () => null,
    alert: async () => {},
    attributionStore: ctx.attributionStore,
    saveAttributionMapping: async () => ({ saved: true }),
    loadDeferredStore: async () => ctx.idStore,
    uploadEnhancement: ctx.upload,
  });
  await handler({ method: 'POST', query: { secret: 's' }, headers: {}, body: { type: 'job.created', data: zbJob({ job_number: '1' }) } }, createResponse());
  assert.equal(ctx.uploads.length, 1);
  assert.equal(ctx.uploads[0].orderId, 'sess-1');
});

test('tmm-probe- requests skip ZenBooker and KV and log as a probe', async () => {
  const kv = memoryKv();
  const logs = [];
  const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
  let lookups = 0;
  const handler = createBookingIdentityHandler({
    logger,
    kvClient: kv,
    lookup: async () => { lookups += 1; return { found: false, reason: 'upstream_error', upstreamKind: 'http_400', jobsSeen: 0 }; },
  });
  const res = createResponse();
  await handler({ ...identityRequest(), body: { customer_id: 'tmm-probe-abc', booking_session: 'tmm-probe-abc' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.errorCode, 'BOOKING_NOT_FOUND');
  assert.equal(lookups, 0);
  assert.equal(kv.map.size, 0);
  assert.deepEqual(logs.map(([event]) => event), ['booking_identity_probe']);
  // A real-looking id still goes through the lookup.
  await handler(identityRequest(), createResponse());
  assert.equal(lookups, 1);
});

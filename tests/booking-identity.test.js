import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  hashedUserData,
  LOOKUP_RETRY_TIMEOUT_MS,
  LOOKUP_TIMEOUT_MS,
  lookupBookingIdentity,
  normalizeEmailForEnhancedConversions,
  normalizePhoneForEnhancedConversions,
} from '../lib/booking-identity.js';
import { opaqueRef } from '../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createBookingIdentityHandler, createRateLimiter } from '../pages/api/attribution/booking-identity.js';
import { createResponse } from './webhook-test-helpers.js';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const NOW = Date.parse('2026-10-06T18:00:00.000Z');
const SECRET_EMAIL = 'Jane.Doe+Tag@Gmail.com';
const SECRET_PHONE = '(612) 555-1234';

function job(overrides = {}) {
  return {
    id: 'job-1',
    created: new Date(NOW - 60 * 60 * 1000).toISOString(),
    booking_session: 'session-exact',
    customer: { id: 'cust-1', email: SECRET_EMAIL, phone: SECRET_PHONE },
    ...overrides,
  };
}

function zbJob(overrides = {}) {
  return {
    id: 'zb-job-1',
    created: new Date(NOW - 30 * 1000).toISOString(),
    status: 'scheduled',
    job_number: '1001',
    customer: { id: 'cust-1', email: SECRET_EMAIL, phone: SECRET_PHONE },
    ...overrides,
  };
}

function httpClientReturning(results, calls = []) {
  return {
    async get(url, options) {
      calls.push({ url, options });
      return { data: { results } };
    },
  };
}

function request(overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://www.themountingman.com', 'x-forwarded-for': '203.0.113.9' },
    body: { customer_id: 'cust-1', booking_session: 'session-exact' },
    ...overrides,
  };
}

function captureLogger() {
  const logs = [];
  return {
    logs,
    info: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
    error: (...args) => logs.push(args),
  };
}

test('email normalization trims, lowercases, and strips dots only for gmail/googlemail', () => {
  assert.equal(normalizeEmailForEnhancedConversions('  Jane.Doe@Gmail.com '), 'janedoe@gmail.com');
  assert.equal(normalizeEmailForEnhancedConversions('a.b@googlemail.com'), 'ab@googlemail.com');
  assert.equal(normalizeEmailForEnhancedConversions('a.b@Example.com'), 'a.b@example.com');
  assert.equal(normalizeEmailForEnhancedConversions('not-an-email'), null);
  assert.equal(normalizeEmailForEnhancedConversions(''), null);
});

test('phone normalization yields E.164 with US default', () => {
  assert.equal(normalizePhoneForEnhancedConversions('(612) 555-1234'), '+16125551234');
  assert.equal(normalizePhoneForEnhancedConversions('612.555.1234'), '+16125551234');
  assert.equal(normalizePhoneForEnhancedConversions('1 612 555 1234'), '+16125551234');
  assert.equal(normalizePhoneForEnhancedConversions('+16125551234'), '+16125551234');
  assert.equal(normalizePhoneForEnhancedConversions('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhoneForEnhancedConversions('555-1234'), null);
  assert.equal(normalizePhoneForEnhancedConversions(null), null);
});

test('hashedUserData hashes the normalized values and omits missing fields', () => {
  assert.deepEqual(hashedUserData({ email: SECRET_EMAIL, phone: SECRET_PHONE }), {
    sha256_email_address: sha('janedoe+tag@gmail.com'),
    sha256_phone_number: sha('+16125551234'),
  });
  assert.deepEqual(hashedUserData({ email: 'x@example.com', phone: 'bad' }), {
    sha256_email_address: sha('x@example.com'),
  });
  assert.equal(hashedUserData({ email: '', phone: '' }), null);
});

test('lookup matches the exact session for the customer inside the 48h window', async () => {
  const calls = [];
  const result = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: httpClientReturning([
      job({ id: 'other', booking_session: 'session-other', customer: { id: 'cust-1', email: 'other@example.com' } }),
      job(),
    ], calls),
    now: NOW,
  });
  assert.equal(result.found, true);
  assert.equal(result.path, 'exact_session');
  assert.equal(result.userData.sha256_email_address, sha('janedoe+tag@gmail.com'));
  assert.equal(result.userData.sha256_phone_number, sha('+16125551234'));
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/jobs');
  assert.equal(url.searchParams.get('customer'), 'cust-1');
  assert.equal(Date.parse(url.searchParams.get('created_after')), NOW - 48 * 60 * 60 * 1000);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer key');
});

test('lookup rejects wrong session, wrong customer, expired booking, and missing key', async () => {
  const lookup = (jobs, env = { ZENBOOKER_API_KEY: 'key' }, bookingSession = 'session-exact') => lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession,
    env,
    httpClient: httpClientReturning(jobs),
    now: NOW,
  });
  assert.equal((await lookup([job()], undefined, 'session-bad')).reason, 'not_found');
  assert.equal((await lookup([job({ customer: { id: 'cust-2', email: 'x@example.com' } })])).reason, 'not_found');
  assert.equal(
    (await lookup([job({ created: new Date(NOW - 49 * 60 * 60 * 1000).toISOString() })])).reason,
    'not_found',
  );
  assert.equal((await lookup([job({ created: undefined })])).reason, 'not_found');
  assert.equal((await lookup([job({ booking_session: undefined })])).reason, 'not_found');
  assert.equal((await lookup([job({ customer: { id: 'cust-1' } })])).reason, 'no_identifiers');
  assert.equal((await lookup([job()], {})).reason, 'not_configured');
});

test('lookup treats upstream failures and unparsable bodies as not found', async () => {
  const calls = [];
  const failing = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: {
      get: async () => {
        calls.push(1);
        const err = new Error('boom');
        err.code = 'ECONNABORTED';
        throw err;
      },
    },
    now: NOW,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(failing, { found: false, reason: 'upstream_error', upstreamKind: 'timeout', jobsSeen: 0 });
  const garbage = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: { get: async () => ({ data: '<html>' }) },
    now: NOW,
  });
  assert.deepEqual(garbage, { found: false, reason: 'upstream_error', upstreamKind: 'parse', jobsSeen: 0 });
});

test('lookup parses a string body with bare empty coordinates', async () => {
  const body = JSON.stringify({ results: [job({ service_address: { lat: '__EMPTY__' } })] })
    .replace('"__EMPTY__"', '');
  assert.throws(() => JSON.parse(body));
  const result = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: { get: async () => ({ data: body }) },
    now: NOW,
  });
  assert.equal(result.found, true);
});

test('endpoint returns only hashes and logs no plain identifiers', async () => {
  const logger = captureLogger();
  const handler = createBookingIdentityHandler({
    logger,
    lookup: (args) => lookupBookingIdentity({
      ...args,
      env: { ZENBOOKER_API_KEY: 'key' },
      httpClient: httpClientReturning([job()]),
      now: NOW,
    }),
  });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.themountingman.com');
  assert.deepEqual(res.body, {
    found: true,
    user_data: {
      sha256_email_address: sha('janedoe+tag@gmail.com'),
      sha256_phone_number: sha('+16125551234'),
    },
  });
  const rendered = JSON.stringify({ body: res.body, logs: logger.logs });
  for (const secret of ['jane', 'Jane', 'gmail', '5551234', 'cust-1', 'session-exact']) {
    assert.equal(rendered.includes(secret), false, `leaked ${secret}`);
  }
  const resolvedLog = logger.logs.find(([event]) => event === 'booking_identity_resolved');
  assert.ok(resolvedLog);
  assert.equal(resolvedLog[1].path, 'exact_session');
  assert.equal(typeof resolvedLog[1].durationMs, 'number');
});

test('endpoint answers preflight and rejects foreign origins', async () => {
  const handler = createBookingIdentityHandler({
    logger: captureLogger(),
    lookup: async () => assert.fail('must not look up'),
  });
  const preflight = createResponse();
  await handler(request({ method: 'OPTIONS' }), preflight);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');

  for (const origin of ['https://example.com', 'https://themountingman.com', '']) {
    const res = createResponse();
    await handler(request({ headers: { origin } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const get = createResponse();
  await handler(request({ method: 'GET' }), get);
  assert.equal(get.statusCode, 405);
});

test('endpoint rejects malformed references and returns 404 for unknown or expired sessions', async () => {
  const logger = captureLogger();
  const handler = createBookingIdentityHandler({
    logger,
    lookup: (args) => lookupBookingIdentity({
      ...args,
      env: { ZENBOOKER_API_KEY: 'key' },
      httpClient: httpClientReturning([
        job({ created: new Date(NOW - 72 * 60 * 60 * 1000).toISOString() }),
      ]),
      now: NOW,
    }),
  });

  for (const body of [
    {},
    { customer_id: 'cust-1' },
    { customer_id: 'cust-1', booking_session: 'has space' },
    { customer_id: 'cust-1', booking_session: 'x'.repeat(201) },
    { customer_id: ['cust-1'], booking_session: 'session-exact' },
  ]) {
    const res = createResponse();
    await handler(request({ body }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errorCode, 'INVALID_BOOKING_REFERENCE');
  }

  const expired = createResponse();
  await handler(request(), expired);
  assert.equal(expired.statusCode, 404);
  assert.deepEqual(expired.body, { found: false, errorCode: 'BOOKING_NOT_FOUND' });
  assert.equal(JSON.stringify(logger.logs).includes('session-exact'), false);

  const unknown = createResponse();
  await handler(request({ body: { customer_id: 'cust-1', booking_session: 'no-such-session' } }), unknown);
  assert.equal(unknown.statusCode, 404);
});

test('endpoint returns 503 when the lookup throws, without echoing the error', async () => {
  const logger = captureLogger();
  const handler = createBookingIdentityHandler({
    logger,
    lookup: async () => { throw new Error('secret@example.com exploded'); },
  });
  const res = createResponse();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify({ body: res.body, logs: logger.logs }).includes('secret@example.com'), false);
});

test('endpoint rate-limits a single client', async () => {
  const handler = createBookingIdentityHandler({
    logger: captureLogger(),
    lookup: async () => ({ found: false, reason: 'not_found' }),
    rateLimiter: createRateLimiter({ max: 3 }),
  });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const res = createResponse();
    await handler(request(), res);
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);

  const other = createResponse();
  await handler(request({ headers: { origin: 'https://www.themountingman.com', 'x-forwarded-for': '198.51.100.7' } }), other);
  assert.equal(other.statusCode, 404);
});

test('rate limiter window expires', () => {
  let now = 0;
  const allow = createRateLimiter({ max: 1, windowMs: 1000, now: () => now });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  now = 1001;
  assert.equal(allow('a'), true);
});

function bridgeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async del(key) { return values.delete(key) ? 1 : 0; },
    async sadd(key, ...members) {
      const set = sets.get(key) || new Set();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) { return [...(sets.get(key) || new Set())]; },
    async expire() { return 1; },
  };
}

test('lookup uses the job-scoped mapping when the job has no booking_session', async () => {
  const store = createAttributionStore(bridgeKv());
  await store.saveJobBridge({
    jobId: 'job-mapped',
    sessionRef: (await store.saveBookingAttribution({
      zenCustomerId: 'cust-1',
      bookingSession: 'session-mapped',
      capturedAt: new Date(NOW - 60 * 1000).toISOString(),
      acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
      gclid: 'identity-click-secret',
    })).sessionRef,
    source: 'window',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    gclid: 'identity-click-secret',
  });
  const result = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-mapped',
    store,
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: httpClientReturning([
      job({ id: 'job-mapped', booking_session: undefined }),
      job({
        id: 'job-other',
        booking_session: undefined,
        customer: { id: 'cust-1', email: 'other@example.com', phone: '6125559999' },
      }),
    ]),
    now: NOW,
  });
  assert.equal(result.found, true);
  assert.equal(result.userData.sha256_email_address, sha('janedoe+tag@gmail.com'));
  assert.equal(JSON.stringify(result).includes('identity-click-secret'), false);
  assert.equal(result.path, 'stored');
  assert.equal(await store.getJobIdForSession('session-other'), null);
});

test('lookup bridges one in-window capture to the only in-window job without a session field', async () => {
  const store = createAttributionStore(bridgeKv());
  await store.saveBookingAttribution({
    zenCustomerId: 'cust-1',
    bookingSession: 'session-window',
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    gclid: 'identity-click-secret',
  });
  const result = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-window',
    store,
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: httpClientReturning([
      job({
        id: 'job-window',
        booking_session: undefined,
        created: new Date(NOW - 2 * 60 * 1000).toISOString(),
      }),
      job({
        id: 'job-old',
        booking_session: undefined,
        created: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
        customer: { id: 'cust-1', email: 'other@example.com', phone: '6125550000' },
      }),
    ]),
    now: NOW,
  });
  assert.equal(result.found, true);
  assert.equal(result.userData.sha256_email_address, sha('janedoe+tag@gmail.com'));
  assert.equal(result.path, 'window');
  assert.equal(await store.getJobIdForSession('session-window'), 'job-window');
  assert.equal(JSON.stringify(result).includes('identity-click-secret'), false);
});

test('lookup does not bridge when two jobs were created inside the window', async () => {
  const store = createAttributionStore(bridgeKv());
  await store.saveBookingAttribution({
    zenCustomerId: 'cust-1',
    bookingSession: 'session-two-jobs',
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    gclid: 'identity-click-secret',
  });
  const result = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-two-jobs',
    store,
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: httpClientReturning([
      job({
        id: 'job-a',
        booking_session: undefined,
        created: new Date(NOW - 45 * 60 * 1000).toISOString(),
      }),
      job({
        id: 'job-b',
        booking_session: undefined,
        created: new Date(NOW - 50 * 60 * 1000).toISOString(),
      }),
    ]),
    now: NOW,
  });
  assert.deepEqual(result, { found: false, reason: 'not_found', jobsSeen: 2 });
  assert.equal(await store.getJobIdForSession('session-two-jobs'), null);
});

test('random booking session with an existing customer and recent job returns HTTP 404', async (t) => {
  for (const attributionStore of [null, createAttributionStore(bridgeKv())]) {
    await t.test(attributionStore ? 'empty capture store' : 'no store', async () => {
      const handler = createBookingIdentityHandler({
        attributionStore,
        logger: captureLogger(),
        lookup: (options) => lookupBookingIdentity({
          ...options,
          env: { ZENBOOKER_API_KEY: 'key' },
          httpClient: httpClientReturning([zbJob()]),
          now: NOW,
        }),
      });
      const res = createResponse();
      await handler(request({ body: { customer_id: 'cust-1', booking_session: 'random-session' } }), res);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { found: false, errorCode: 'BOOKING_NOT_FOUND' });
    });
  }
});

test('every identity path rejects jobs with missing or mismatched customer IDs', async (t) => {
  for (const path of ['exact_session', 'stored', 'window']) {
    for (const id of [undefined, null, '', 'cust-other']) {
      await t.test(`${path}: customer ID ${String(id)}`, async () => {
        const store = createAttributionStore(bridgeKv());
        const capture = await store.saveBookingAttribution({
          zenCustomerId: 'cust-1',
          bookingSession: 'session-check',
          capturedAt: new Date(NOW - 60 * 1000).toISOString(),
        });
        if (path === 'stored') {
          await store.saveJobBridge({ jobId: 'job-check', sessionRef: capture.sessionRef, source: 'window' });
        }
        const result = await lookupBookingIdentity({
          customerId: 'cust-1',
          bookingSession: 'session-check',
          store,
          env: { ZENBOOKER_API_KEY: 'key' },
          httpClient: httpClientReturning([zbJob({
            id: 'job-check',
            booking_session: path === 'exact_session' ? 'session-check' : undefined,
            customer: { id, email: SECRET_EMAIL, phone: SECRET_PHONE },
          })]),
          now: NOW,
        });
        assert.deepEqual(result, { found: false, reason: 'not_found', jobsSeen: 1 });
        if (path !== 'stored') assert.equal(await store.getJobIdForSession('session-check'), null);
      });
    }
  }
});

test('window requires exactly one capture matching both the session and customer', async (t) => {
  const capture = {
    sessionRef: opaqueRef('session-window'),
    customerId: 'cust-1',
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
  };
  const cases = {
    'missing customer': [{ ...capture, customerId: undefined }],
    'wrong customer': [{ ...capture, customerId: 'cust-other' }],
    'wrong session': [{ ...capture, sessionRef: opaqueRef('other-session') }],
    'duplicate session': [capture, { ...capture }],
  };
  for (const [name, captures] of Object.entries(cases)) {
    await t.test(name, async () => {
      const result = await lookupBookingIdentity({
        customerId: 'cust-1',
        bookingSession: 'session-window',
        store: {
          async listCaptures() { return captures; },
          async saveJobBridge() { assert.fail('must not write an unverified bridge'); },
        },
        env: { ZENBOOKER_API_KEY: 'key' },
        httpClient: httpClientReturning([zbJob()]),
        now: NOW,
      });
      assert.deepEqual(result, { found: false, reason: 'not_found', jobsSeen: 1 });
    });
  }
});

test('zenbooker fetch retries timeout once then succeeds; 404 is not retried', async () => {
  const calls = [];
  const retryClient = {
    async get(_url, options) {
      calls.push(options.timeout);
      if (calls.length === 1) {
        const err = new Error('timeout');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return { data: { results: [job()] } };
    },
  };
  const ok = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: retryClient,
    now: NOW,
  });
  assert.equal(ok.found, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], LOOKUP_TIMEOUT_MS);
  assert.equal(calls[1], LOOKUP_RETRY_TIMEOUT_MS);

  const notFoundCalls = [];
  const notFoundClient = {
    async get() {
      notFoundCalls.push(1);
      const err = new Error('missing');
      err.response = { status: 404 };
      throw err;
    },
  };
  const missing = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: notFoundClient,
    now: NOW,
  });
  assert.equal(notFoundCalls.length, 1);
  assert.equal(missing.upstreamKind, 'http_404');

  const doubleTimeout = {
    async get() {
      const err = new Error('timeout');
      err.code = 'ECONNABORTED';
      throw err;
    },
  };
  const exhausted = await lookupBookingIdentity({
    customerId: 'cust-1',
    bookingSession: 'session-exact',
    env: { ZENBOOKER_API_KEY: 'key' },
    httpClient: doubleTimeout,
    now: NOW,
  });
  assert.deepEqual(exhausted, {
    found: false,
    reason: 'upstream_error',
    upstreamKind: 'timeout',
    jobsSeen: 0,
  });
});

test('handler not_found logs path durationMs and upstreamKind without PII', async () => {
  const logger = captureLogger();
  const handler = createBookingIdentityHandler({
    logger,
    lookup: async () => ({
      found: false,
      reason: 'upstream_error',
      upstreamKind: 'timeout',
      path: undefined,
      jobsSeen: 0,
    }),
  });
  const res = createResponse();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
  const notFoundLog = logger.logs.find(([event]) => event === 'booking_identity_not_found');
  assert.deepEqual(notFoundLog[1], {
    bookingRef: notFoundLog[1].bookingRef,
    reason: 'upstream_error',
    upstreamKind: 'timeout',
    path: undefined,
    jobsSeen: 0,
    durationMs: notFoundLog[1].durationMs,
  });
  assert.equal(typeof notFoundLog[1].durationMs, 'number');
  assert.equal(JSON.stringify(logger.logs).includes(SECRET_EMAIL), false);
});

test('capture store exposes customerId only for a verified persisted customer reference', async () => {
  const kv = bridgeKv();
  const store = createAttributionStore(kv);
  await store.saveBookingAttribution({ zenCustomerId: 'cust-1', bookingSession: 'session-check' });
  assert.equal((await store.listCaptures('cust-1'))[0].customerId, 'cust-1');
  const key = `attrib:capture:${opaqueRef('cust-1')}:${opaqueRef('session-check')}`;
  const saved = await kv.get(key);
  assert.equal(JSON.stringify(saved).includes('cust-1'), false);
  for (const customerRef of [undefined, opaqueRef('cust-other')]) {
    await kv.set(key, { ...saved, customerRef, customerId: 'cust-1' });
    assert.equal((await store.listCaptures('cust-1'))[0].customerId, null);
  }
});

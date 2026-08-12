// The capability must never appear in a URL path, a query string, or anything
// a server, proxy, or access log can see. It arrives once in a URL fragment,
// is exchanged through a POST body for an operator session cookie, and every
// installation-post route authenticates on that cookie alone.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  signJobCapability,
  signOperatorSession,
  verifyJobCapability,
  verifyOperatorSession,
} from '../lib/install-post-queue.mjs';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  buildSessionCookie,
  clearedSessionCookie,
  originAllowed,
  readSessionToken,
} from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createSessionHandler } from '../pages/api/install-post/session.js';
import { createMobileJobHandler } from '../pages/api/install-post/mobile.js';
import { createUploadHandler } from '../pages/api/install-post/upload.js';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createResponse } from './webhook-test-helpers.js';

const SECRET = 'test-capability-secret';
const HOST = 'mounting-man-dashboard.vercel.app';
const ORIGIN = `https://${HOST}`;
const NOW = 1_760_000_000_000;
const TWO_DAYS_SECONDS = 172_800;

const SEED = {
  city: 'Edina',
  'tv-size': '65"',
  'tv-brand': 'Samsung',
  'wall-surface': 'Stone',
  price: '$450',
  'street-name': '4821 Elm Street',
  'seed-index': 1,
  'seed-count': 1,
};

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) { values.delete(key); return 1; },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) { sets.get(key)?.delete(member); return 1; },
    async smembers(key) { return [...(sets.get(key) || [])]; },
  };
}

function request({ method = 'GET', origin = ORIGIN, session, body, cookieHeader } = {}) {
  const headers = { host: HOST };
  if (origin) headers.origin = origin;
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  else if (session) headers.cookie = `${SESSION_COOKIE_NAME}=${session}`;
  return { method, headers, body, query: {} };
}

function cookieAttributes(setCookie) {
  const [pair, ...rest] = String(setCookie).split(';').map((part) => part.trim());
  const attributes = Object.fromEntries(rest.map((part) => {
    const index = part.indexOf('=');
    return index === -1
      ? [part.toLowerCase(), true]
      : [part.slice(0, index).toLowerCase(), part.slice(index + 1)];
  }));
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

async function setup({ now = NOW } = {}) {
  const store = createInstallPostStore(createFakeKv());
  const [record] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-ABC-123', paymentId: 'PAY-XYZ-789' },
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });
  const capability = signJobCapability({
    jobId: record.jobId, secret: SECRET, issuedAt: now, ttlSeconds: TWO_DAYS_SECONDS,
  });
  return {
    store,
    record,
    capability,
    session: createSessionHandler({
      capabilitySecret: SECRET, sessionSecret: SECRET, now: () => now,
    }),
    mobile: createMobileJobHandler({ store, sessionSecret: SECRET, now: () => now }),
    upload: createUploadHandler({ store, sessionSecret: SECRET, webflow: {}, now: () => now }),
    publish: createPublishHandler({
      store, sessionSecret: SECRET, dispatcher: { async dispatch() {} }, now: () => now,
    }),
  };
}

async function exchange(context, overrides = {}) {
  const res = createResponse();
  await context.session(request({
    method: 'POST', body: { capability: context.capability }, ...overrides,
  }), res);
  return res;
}

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

test('an operator session round-trips and rejects tampering and expiry', () => {
  const expiresAt = NOW + TWO_DAYS_SECONDS * 1000;
  const token = signOperatorSession({ jobId: 'job_abc', secret: SECRET, expiresAt });

  assert.deepEqual(
    verifyOperatorSession(token, { secret: SECRET, now: NOW }),
    { ok: true, jobId: 'job_abc', expiresAt },
  );
  assert.equal(verifyOperatorSession(`${token}x`, { secret: SECRET, now: NOW }).reason, 'bad_signature');
  assert.equal(verifyOperatorSession(token, { secret: 'other', now: NOW }).reason, 'bad_signature');
  assert.equal(verifyOperatorSession(token, { secret: SECRET, now: expiresAt }).reason, 'expired');
  assert.equal(verifyOperatorSession('', { secret: SECRET, now: NOW }).reason, 'malformed');
  assert.equal(verifyOperatorSession(token, { secret: '', now: NOW }).reason, 'unconfigured');
});

test('a capability and a session are not interchangeable', () => {
  const expiresAt = NOW + TWO_DAYS_SECONDS * 1000;
  const capability = signJobCapability({ jobId: 'job_abc', secret: SECRET, issuedAt: NOW });
  const session = signOperatorSession({ jobId: 'job_abc', secret: SECRET, expiresAt });

  assert.equal(verifyOperatorSession(capability, { secret: SECRET, now: NOW }).ok, false);
  assert.equal(verifyJobCapability(session, { secret: SECRET, now: NOW }).ok, false);
});

// ---------------------------------------------------------------------------
// Cookie shape
// ---------------------------------------------------------------------------

test('the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to the install-post APIs', () => {
  const expiresAt = NOW + TWO_DAYS_SECONDS * 1000;
  const { name, value, attributes } = cookieAttributes(
    buildSessionCookie({ token: 'tok', expiresAt, now: NOW }),
  );

  assert.equal(name, SESSION_COOKIE_NAME);
  assert.equal(value, 'tok');
  assert.equal(attributes.path, SESSION_COOKIE_PATH);
  assert.equal(attributes.path, '/api/install-post');
  assert.equal(attributes.httponly, true);
  assert.equal(attributes.secure, true);
  assert.equal(attributes.samesite, 'Strict');
  assert.equal(attributes['max-age'], String(TWO_DAYS_SECONDS));

  // A page-scoped cookie would be handed to every route on the origin.
  assert.notEqual(attributes.path, '/');
  assert.equal(attributes.domain, undefined);
});

test('the cleared cookie expires immediately on the same narrow scope', () => {
  const { name, value, attributes } = cookieAttributes(clearedSessionCookie());
  assert.equal(name, SESSION_COOKIE_NAME);
  assert.equal(value, '');
  assert.equal(attributes.path, SESSION_COOKIE_PATH);
  assert.equal(attributes['max-age'], '0');
  assert.equal(attributes.httponly, true);
  assert.equal(attributes.secure, true);
  assert.equal(attributes.samesite, 'Strict');
});

test('readSessionToken finds the session beside unrelated cookies and nothing else', () => {
  assert.equal(
    readSessionToken({ headers: { cookie: `a=1; ${SESSION_COOKIE_NAME}=tok; b=2` } }),
    'tok',
  );
  assert.equal(readSessionToken({ headers: { cookie: 'a=1; b=2' } }), '');
  assert.equal(readSessionToken({ headers: {} }), '');
  assert.equal(readSessionToken({}), '');
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

test('only a same-origin request is allowed to mutate', () => {
  assert.equal(originAllowed(request({ origin: ORIGIN })), true);
  assert.equal(originAllowed(request({ origin: 'https://evil.example.com' })), false);
  assert.equal(originAllowed(request({ origin: `http://${HOST}` })), false);
  assert.equal(originAllowed(request({ origin: `https://${HOST}.evil.example.com` })), false);
  assert.equal(originAllowed(request({ origin: 'null' })), false);
  assert.equal(originAllowed(request({ origin: '' })), false);
});

// ---------------------------------------------------------------------------
// Fragment exchange
// ---------------------------------------------------------------------------

test('exchanging the capability issues a session bound to that one job', async () => {
  const context = await setup();
  const res = await exchange(context);

  assert.equal(res.statusCode, 200);
  const cookie = cookieAttributes(res.headers['set-cookie']);
  const verified = verifyOperatorSession(cookie.value, { secret: SECRET, now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.jobId, context.record.jobId);

  // The response must not hand the capability back to the page.
  assert.ok(!JSON.stringify(res.body).includes(context.capability));
});

test('the session inherits the capability expiry exactly, so 48h stays 48h', async () => {
  const context = await setup();
  const res = await exchange(context);

  const cookie = cookieAttributes(res.headers['set-cookie']);
  const capabilityExpiry = verifyJobCapability(context.capability, { secret: SECRET, now: NOW }).expiresAt;
  const sessionExpiry = verifyOperatorSession(cookie.value, { secret: SECRET, now: NOW }).expiresAt;

  assert.equal(capabilityExpiry, NOW + TWO_DAYS_SECONDS * 1000);
  assert.equal(sessionExpiry, capabilityExpiry);
  assert.equal(cookie.attributes['max-age'], String(TWO_DAYS_SECONDS));

  // A session minted from a nearly-dead capability dies with it.
  const late = createSessionHandler({
    capabilitySecret: SECRET, sessionSecret: SECRET, now: () => capabilityExpiry - 60_000,
  });
  const res2 = createResponse();
  await late(request({ method: 'POST', body: { capability: context.capability } }), res2);
  assert.equal(cookieAttributes(res2.headers['set-cookie']).attributes['max-age'], '60');
});

test('the exchange refuses a foreign, missing, or opaque Origin', async () => {
  const context = await setup();
  for (const origin of ['https://evil.example.com', '', 'null']) {
    const res = await exchange(context, { origin });
    assert.equal(res.statusCode, 403, origin);
    assert.equal(res.body.error, 'forbidden_origin');
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('the exchange refuses anything but POST, and never reads a URL', async () => {
  const context = await setup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = createResponse();
    await context.session({
      method,
      headers: { host: HOST, origin: ORIGIN },
      query: { capability: context.capability, token: context.capability },
    }, res);
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('a tampered, expired, or absent capability issues no session and clears any old one', async () => {
  const context = await setup();
  for (const [capability, reason] of [
    [undefined, 'malformed'],
    ['garbage', 'malformed'],
    [`${context.capability}x`, 'bad_signature'],
  ]) {
    const res = createResponse();
    await context.session(request({ method: 'POST', body: { capability } }), res);
    assert.equal(res.statusCode, 401, reason);
    assert.equal(res.body.reason, reason);
    assert.equal(cookieAttributes(res.headers['set-cookie']).value, '');
  }

  const stale = createSessionHandler({
    capabilitySecret: SECRET,
    sessionSecret: SECRET,
    now: () => NOW + (TWO_DAYS_SECONDS + 1) * 1000,
  });
  const res = createResponse();
  await stale(request({ method: 'POST', body: { capability: context.capability } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.reason, 'expired');
});

// ---------------------------------------------------------------------------
// Cookie-only authentication on the job routes
// ---------------------------------------------------------------------------

test('every job route refuses a request with no session cookie', async () => {
  const context = await setup();
  const calls = [
    [context.mobile, request({ method: 'GET' })],
    [context.mobile, request({ method: 'PATCH', body: { revision: 'r', patch: { city: 'X' } } })],
    [context.upload, request({ method: 'POST', body: { action: 'init' } })],
    [context.publish, request({ method: 'POST', body: { revision: 'r' } })],
  ];
  for (const [handler, req] of calls) {
    const res = createResponse();
    await handler(req, res);
    assert.equal(res.statusCode, 401, `${req.method}`);
    assert.equal(res.body.reason, 'no_session');
  }
});

test('a capability presented as a cookie or a query string authenticates nothing', async () => {
  const context = await setup();

  const asCookie = createResponse();
  await context.mobile(request({ session: context.capability }), asCookie);
  assert.equal(asCookie.statusCode, 401);

  const asQuery = createResponse();
  await context.mobile({
    method: 'GET',
    headers: { host: HOST },
    query: { token: context.capability, capability: context.capability },
  }, asQuery);
  assert.equal(asQuery.statusCode, 401);
  assert.equal(asQuery.body.reason, 'no_session');
});

test('the exchanged session opens exactly the job it was minted for', async () => {
  const context = await setup();
  const session = cookieAttributes((await exchange(context)).headers['set-cookie']).value;

  const res = createResponse();
  await context.mobile(request({ session }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.jobId, context.record.jobId);

  const foreign = signOperatorSession({
    jobId: 'job_deadbeefdeadbeef', secret: SECRET, expiresAt: NOW + 3600_000,
  });
  const missing = createResponse();
  await context.mobile(request({ session: foreign }), missing);
  assert.equal(missing.statusCode, 404);
});

test('mutations are refused when the Origin is foreign, even with a valid session', async () => {
  const context = await setup();
  const session = cookieAttributes((await exchange(context)).headers['set-cookie']).value;

  const calls = [
    [context.mobile, 'PATCH', { revision: context.record.revision, patch: { city: 'Hopkins' } }],
    [context.upload, 'POST', { action: 'init' }],
    [context.publish, 'POST', { revision: context.record.revision }],
  ];
  for (const [handler, method, body] of calls) {
    for (const origin of ['https://evil.example.com', '']) {
      const res = createResponse();
      await handler(request({ method, session, body, origin }), res);
      assert.equal(res.statusCode, 403, `${method} ${origin}`);
      assert.equal(res.body.error, 'forbidden_origin');
    }
  }

  // A same-origin read needs no Origin header — browsers omit it on GET.
  const read = createResponse();
  await context.mobile(request({ method: 'GET', session, origin: '' }), read);
  assert.equal(read.statusCode, 200);
});

test('an expired session stops working the moment the capability would have', async () => {
  const context = await setup();
  const session = cookieAttributes((await exchange(context)).headers['set-cookie']).value;

  const expired = createMobileJobHandler({
    store: context.store,
    sessionSecret: SECRET,
    now: () => NOW + (TWO_DAYS_SECONDS + 1) * 1000,
  });
  const res = createResponse();
  await expired(request({ session }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.reason, 'expired');
});

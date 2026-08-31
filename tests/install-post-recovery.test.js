// Recovery paths for the cloud installation-post queue.
//
// Every case here is a way a job could previously get stuck forever: an
// indeterminate outcome with no way back, a runner that died before its
// callback, or a publish lease that outlived the request that claimed it.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALL_POST_STATES,
  STALE_PUBLISH_MS,
  installPostPollDelayMs,
  signJobCapability,
  signOperatorSession,
  transitionRecord,
  verifyJobCapability,
} from '../lib/install-post-queue.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createMobileJobHandler } from '../pages/api/install-post/mobile.js';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createRunnerCallbackHandler } from '../pages/api/install-post/runner/callback.js';
import { signRunnerRequest } from '../lib/install-post-dispatch.mjs';
import { createResponse } from './webhook-test-helpers.js';

const CAPABILITY_SECRET = 'test-capability-secret';
const RUNNER_SECRET = 'test-runner-secret';
const CALLBACK_PATH = '/api/install-post/runner/callback';
const HOST = 'mounting-man-dashboard.vercel.app';
const NOW = 1_760_000_000_000;

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

const IMAGE = {
  sha256: 'a'.repeat(64),
  bytes: 320_000,
  contentType: 'image/webp',
  assetId: 'asset-1',
  hostedUrl: 'https://cdn.example.com/65-inch-samsung.webp',
};

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    values,
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

function createFakeDispatcher() {
  const dispatches = [];
  return {
    dispatches,
    async dispatch(payload) {
      dispatches.push(payload);
      return { dispatchId: payload.dispatchId };
    },
  };
}

/** A clock the test moves forward, so stale-publish windows are exercised. */
function createClock(start = NOW) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; };
  return now;
}

async function setup({ now = createClock() } = {}) {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-ABC-123', paymentId: 'PAY-XYZ-789' },
    source: 'square-webhook',
    stagedAt: new Date(NOW).toISOString(),
  });
  const record = transitionRecord(staged, {
    type: 'photo',
    image: IMAGE,
    at: new Date(NOW).toISOString(),
  }).record;
  await store.saveRecord(record);

  const dispatcher = createFakeDispatcher();
  const gbpQueue = {
    async enqueue(item) {
      return { queued: true, reason: 'queued', item };
    },
  };
  return {
    kv,
    store,
    record,
    dispatcher,
    now,
    session: signOperatorSession({
      jobId: record.jobId, secret: CAPABILITY_SECRET, expiresAt: NOW + 604_800_000,
    }),
    publish: createPublishHandler({ store, sessionSecret: CAPABILITY_SECRET, dispatcher, now }),
    mobile: createMobileJobHandler({ store, sessionSecret: CAPABILITY_SECRET, now }),
    callback: createRunnerCallbackHandler({ store, runnerSecret: RUNNER_SECRET, gbpQueue, now }),
  };
}

function operatorRequest({ method = 'GET', session, body } = {}) {
  return {
    method,
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body,
  };
}

function publishRequest(session, body) {
  return operatorRequest({ method: 'POST', session, body });
}

function callbackRequest(body, { timestamp = Math.floor(NOW / 1000) } = {}) {
  return {
    method: 'POST',
    url: CALLBACK_PATH,
    headers: {
      'x-install-post-signature': signRunnerRequest({
        secret: RUNNER_SECRET, method: 'POST', path: CALLBACK_PATH, body, timestamp,
      }),
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  };
}

/** Publish once and return the dispatch id the runner would have been given. */
async function publishOnce(context) {
  const res = createResponse();
  await context.publish(publishRequest(context.session, { revision: context.record.revision }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return context.dispatcher.dispatches.at(-1).dispatchId;
}

async function reportIndeterminate(context, dispatchId) {
  const res = createResponse();
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId,
    result: { status: 'INDETERMINATE', message: 'timed out after Webflow accepted the item' },
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

// ---------------------------------------------------------------------------
// Capability lifetime — the Discord link has to still work at the next job
// ---------------------------------------------------------------------------

test('a capability token lives for the seconds it was issued for', () => {
  const twoDays = 172_800;
  const token = signJobCapability({
    jobId: 'job_ttl', secret: CAPABILITY_SECRET, issuedAt: NOW, ttlSeconds: twoDays,
  });

  const hour = 60 * 60 * 1000;
  assert.equal(verifyJobCapability(token, { secret: CAPABILITY_SECRET, now: NOW + hour }).ok, true);
  assert.equal(
    verifyJobCapability(token, { secret: CAPABILITY_SECRET, now: NOW + 47 * hour }).ok,
    true,
    'a 48 hour link must survive the day after the install',
  );
  assert.equal(
    verifyJobCapability(token, { secret: CAPABILITY_SECRET, now: NOW + 49 * hour }).reason,
    'expired',
  );
});

// ---------------------------------------------------------------------------
// B1 — an indeterminate outcome must be recoverable, not terminal
// ---------------------------------------------------------------------------

test('an indeterminate outcome keeps the approval that bound the exact revision', async () => {
  const context = await setup();
  const dispatchId = await publishOnce(context);
  await reportIndeterminate(context, dispatchId);

  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.INDETERMINATE);
  assert.notEqual(reloaded.approval, null, 'approval must survive so reconciliation stays bound');
  assert.equal(reloaded.approval.revision, context.record.revision);
  assert.equal(reloaded.approval.imageSha256, IMAGE.sha256);
});

test('reconciling an indeterminate job re-dispatches the same approved revision', async () => {
  const context = await setup();
  const firstDispatch = await publishOnce(context);
  await reportIndeterminate(context, firstDispatch);

  const res = createResponse();
  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    res,
  );

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(context.dispatcher.dispatches.length, 2);

  const second = context.dispatcher.dispatches[1];
  assert.equal(second.revision, context.record.revision, 'reconcile must reuse the approved revision');
  assert.notEqual(second.dispatchId, firstDispatch, 'a reconcile run needs its own dispatch id');

  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.approval.revision, context.record.revision);
  assert.equal(reloaded.lease.dispatchId, second.dispatchId);
});

test('a reconcile run can finish the job as published', async () => {
  const context = await setup();
  await reportIndeterminate(context, await publishOnce(context));

  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    createResponse(),
  );
  const reconcileDispatch = context.dispatcher.dispatches[1].dispatchId;

  const done = createResponse();
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId: reconcileDispatch,
    result: {
      status: 'PUBLISHED',
      liveUrl: 'https://www.themountingman.com/installations/65-inch-samsung',
      publicStatus: 200,
      itemId: 'item-1',
      slug: '65-inch-samsung',
    },
  }), done);

  assert.equal(done.statusCode, 200);
  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.PUBLISHED);
  assert.equal(reloaded.result.liveUrl, 'https://www.themountingman.com/installations/65-inch-samsung');
});

test('a plain Publish tap still refuses an indeterminate job', async () => {
  const context = await setup();
  await reportIndeterminate(context, await publishOnce(context));

  const res = createResponse();
  await context.publish(publishRequest(context.session, { revision: context.record.revision }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'reconcile_required');
  assert.equal(context.dispatcher.dispatches.length, 1);
});

test('reconcile is refused for a job that is not indeterminate', async () => {
  const context = await setup();
  const res = createResponse();
  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'not_reconcilable');
  assert.equal(context.dispatcher.dispatches.length, 0);
});

test('an indeterminate job cannot be edited into a new revision before reconciling', async () => {
  const context = await setup();
  await reportIndeterminate(context, await publishOnce(context));

  const res = createResponse();
  await context.mobile(operatorRequest({
    method: 'PATCH',
    session: context.session,
    body: { revision: context.record.revision, patch: { 'tv-size': '75"' } },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'reconcile_required');

  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.revision, context.record.revision, 'the approved binding must not drift');
  assert.equal(reloaded.state, INSTALL_POST_STATES.INDETERMINATE);
});

// ---------------------------------------------------------------------------
// B2 — a runner that never reports back must not strand the job
// ---------------------------------------------------------------------------

test('a publish with no callback becomes recoverable once the window closes', async () => {
  const context = await setup();
  await publishOnce(context);

  const early = createResponse();
  await context.mobile(operatorRequest({ session: context.session }), early);
  assert.equal(early.body.job.state, INSTALL_POST_STATES.PUBLISHING, 'must not expire early');

  context.now.advance(STALE_PUBLISH_MS + 1000);

  const late = createResponse();
  await context.mobile(operatorRequest({ session: context.session }), late);
  assert.equal(late.statusCode, 200);
  assert.equal(late.body.job.state, INSTALL_POST_STATES.INDETERMINATE);

  const stored = await context.store.loadRecord(context.record.jobId);
  assert.equal(stored.state, INSTALL_POST_STATES.INDETERMINATE, 'the expiry must be persisted');

  const retry = createResponse();
  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    retry,
  );
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(context.dispatcher.dispatches.length, 2);
});

test('a stale publish can be reconciled directly without waiting for a card refresh', async () => {
  const context = await setup();
  await publishOnce(context);
  context.now.advance(STALE_PUBLISH_MS + 1000);

  const res = createResponse();
  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(context.dispatcher.dispatches.length, 2);
});

test('a late callback from the abandoned run cannot overwrite the reconcile run', async () => {
  const context = await setup();
  const abandoned = await publishOnce(context);
  context.now.advance(STALE_PUBLISH_MS + 1000);

  await context.publish(
    publishRequest(context.session, { revision: context.record.revision, reconcile: true }),
    createResponse(),
  );

  const late = createResponse();
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId: abandoned,
    result: { status: 'RETRYABLE_FAILURE', message: 'late failure from the abandoned run' },
  }, { timestamp: Math.floor(context.now() / 1000) }), late);

  assert.equal(late.statusCode, 409);
  assert.equal(late.body.error, 'dispatch_mismatch');
  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.PUBLISHING);
});

// ---------------------------------------------------------------------------
// Callback must be bound to the current approval and lease
// ---------------------------------------------------------------------------

test('a callback without a dispatch id is refused', async () => {
  const context = await setup();
  await publishOnce(context);

  const res = createResponse();
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    result: { status: 'PUBLISHED', liveUrl: 'https://x/y', publicStatus: 200 },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'dispatch_mismatch');
  assert.equal(
    (await context.store.loadRecord(context.record.jobId)).state,
    INSTALL_POST_STATES.PUBLISHING,
  );
});

test('a callback carrying a foreign dispatch id is refused', async () => {
  const context = await setup();
  await publishOnce(context);

  const res = createResponse();
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId: 'not-the-dispatch-we-issued',
    result: { status: 'PUBLISHED', liveUrl: 'https://x/y', publicStatus: 200 },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'dispatch_mismatch');
});

// ---------------------------------------------------------------------------
// B4 — a lease must never outlive the record change it was claimed for
// ---------------------------------------------------------------------------

test('an orphaned lease key from a crashed request does not block Publish forever', async () => {
  const context = await setup();

  // Exactly what a request that died between claiming the lease and writing
  // the approval leaves behind: a lease key with no matching record lease.
  const claim = await context.store.claimPublishLease({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId: 'crashed-request',
  });
  assert.equal(claim, 'claimed');
  const stranded = await context.store.loadRecord(context.record.jobId);
  assert.equal(stranded.lease, null, 'the crashed request never recorded its lease');

  const res = createResponse();
  await context.publish(publishRequest(context.session, { revision: context.record.revision }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(context.dispatcher.dispatches.length, 1);

  const reloaded = await context.store.loadRecord(context.record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(reloaded.lease.dispatchId, context.dispatcher.dispatches[0].dispatchId);
});

test('the publish lease is only claimed once the record lock is held', async () => {
  const context = await setup();
  const order = [];
  const kvSet = context.kv.set.bind(context.kv);
  context.kv.set = async (key, value, options) => {
    if (key.startsWith('install-post:lock:')) order.push('lock');
    if (key.startsWith('install-post:lease:')) order.push('lease');
    return kvSet(key, value, options);
  };

  await context.publish(
    publishRequest(context.session, { revision: context.record.revision }),
    createResponse(),
  );

  assert.deepEqual(order.slice(0, 2), ['lock', 'lease']);
});

test('a lease is never left behind when the approval is refused under the lock', async () => {
  const context = await setup();
  // Drive the record to PUBLISHED so the transition refuses after validation.
  const dispatchId = await publishOnce(context);
  await context.callback(callbackRequest({
    jobId: context.record.jobId,
    revision: context.record.revision,
    dispatchId,
    result: {
      status: 'PUBLISHED',
      liveUrl: 'https://www.themountingman.com/installations/terminal-test',
      publicStatus: 200,
      slug: 'terminal-test',
    },
  }), createResponse());

  const res = createResponse();
  await context.publish(publishRequest(context.session, { revision: context.record.revision }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'already_published');
  assert.equal(context.dispatcher.dispatches.length, 1);
  assert.equal((await context.store.loadRecord(context.record.jobId)).lease, null);
});

// ---------------------------------------------------------------------------
// B6 — the phone must know when to keep asking
// ---------------------------------------------------------------------------

test('the card polls only while a publish is in flight', async () => {
  for (const state of [INSTALL_POST_STATES.PUBLISHING, INSTALL_POST_STATES.VERIFYING]) {
    assert.ok(installPostPollDelayMs(state) > 0, `${state} must keep polling`);
  }
  for (const state of [
    INSTALL_POST_STATES.AWAITING_PHOTO,
    INSTALL_POST_STATES.READY,
    INSTALL_POST_STATES.PUBLISHED,
    INSTALL_POST_STATES.RETRYABLE_FAILURE,
    INSTALL_POST_STATES.BLOCKED,
    INSTALL_POST_STATES.INDETERMINATE,
    undefined,
  ]) {
    assert.equal(installPostPollDelayMs(state), 0, `${state} must not poll`);
  }
});

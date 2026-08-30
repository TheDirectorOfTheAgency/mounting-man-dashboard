import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGithubDispatcher,
  signRunnerRequest,
  verifyRunnerRequest,
} from '../lib/install-post-dispatch.mjs';
import { INSTALL_POST_STATES, signOperatorSession } from '../lib/install-post-queue.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createRunnerCallbackHandler } from '../pages/api/install-post/runner/callback.js';
import { createRunnerEnvelopeHandler } from '../pages/api/install-post/runner/envelope.js';
import { createResponse } from './webhook-test-helpers.js';

const SESSION_SECRET = 'test-session-secret';
const RUNNER_SECRET = 'test-runner-secret';
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

function createFakeDispatcher({ fail = false } = {}) {
  const dispatches = [];
  return {
    dispatches,
    async dispatch(payload) {
      dispatches.push(payload);
      if (fail) throw new Error('workflow_dispatch rejected');
      return { dispatchId: payload.dispatchId };
    },
  };
}

async function setup({ withPhoto = true, dispatcherOptions } = {}) {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-ABC-123', paymentId: 'PAY-XYZ-789' },
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });

  let record = staged;
  if (withPhoto) {
    const { transitionRecord } = await import('../lib/install-post-queue.mjs');
    record = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
    await store.saveRecord(record);
  }

  const dispatcher = createFakeDispatcher(dispatcherOptions);
  return {
    store,
    record,
    dispatcher,
    session: signOperatorSession({ jobId: record.jobId, secret: SESSION_SECRET, expiresAt: NOW + 3600_000 }),
    publish: createPublishHandler({
      store,
      sessionSecret: SESSION_SECRET,
      dispatcher,
      now: () => NOW,
    }),
    envelope: createRunnerEnvelopeHandler({ store, runnerSecret: RUNNER_SECRET, now: () => NOW }),
    callback: createRunnerCallbackHandler({ store, runnerSecret: RUNNER_SECRET, now: () => NOW }),
  };
}

function publishRequest(session, body) {
  return {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body,
  };
}

function signedRunnerRequest({ path, body, secret = RUNNER_SECRET, timestamp = Math.floor(NOW / 1000) }) {
  const signature = signRunnerRequest({ secret, method: 'POST', path, body, timestamp });
  return {
    method: 'POST',
    url: path,
    headers: {
      'x-install-post-signature': signature,
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Runner request signing
// ---------------------------------------------------------------------------

test('runner request signatures round-trip and reject tampering or replay', () => {
  const body = { jobId: 'job_1', revision: 'rev1' };
  const timestamp = 1_700_000_000;
  const signature = signRunnerRequest({ secret: RUNNER_SECRET, method: 'POST', path: '/api/x', body, timestamp });

  const base = { secret: RUNNER_SECRET, method: 'POST', path: '/api/x', body, timestamp, now: timestamp * 1000 };
  assert.equal(verifyRunnerRequest({ ...base, signature }).ok, true);
  assert.equal(verifyRunnerRequest({ ...base, signature, body: { jobId: 'job_2', revision: 'rev1' } }).reason, 'bad_signature');
  assert.equal(verifyRunnerRequest({ ...base, signature, path: '/api/y' }).reason, 'bad_signature');
  assert.equal(verifyRunnerRequest({ ...base, signature, secret: 'wrong' }).reason, 'bad_signature');
  assert.equal(verifyRunnerRequest({ ...base, signature, now: (timestamp + 3600) * 1000 }).reason, 'stale_timestamp');
  assert.equal(verifyRunnerRequest({ ...base, signature: 'v1=deadbeef' }).reason, 'bad_signature');
  assert.equal(verifyRunnerRequest({ ...base, signature, secret: '' }).reason, 'unconfigured');
});

// ---------------------------------------------------------------------------
// Publish approval
// ---------------------------------------------------------------------------

test('Publish approves the exact revision and dispatches one opaque job reference', async () => {
  const { publish, session, record, dispatcher } = await setup();
  const res = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(dispatcher.dispatches.length, 1);

  const dispatched = dispatcher.dispatches[0];
  assert.equal(dispatched.jobId, record.jobId);
  assert.equal(dispatched.revision, record.revision);
  const serialized = JSON.stringify(dispatched);
  for (const forbidden of ['ORDER-ABC-123', 'PAY-XYZ-789', '4821', 'Samsung', SESSION_SECRET]) {
    assert.ok(!serialized.includes(forbidden), `dispatch leaked ${forbidden}`);
  }
});

test('a duplicate Publish tap does not dispatch a second workflow', async () => {
  const { publish, session, record, dispatcher } = await setup();
  const first = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), first);
  assert.equal(first.statusCode, 200);

  const second = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), second);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, 'duplicate_publish');
  assert.equal(dispatcher.dispatches.length, 1);
});

test('concurrent Publish taps dispatch exactly once', async () => {
  const { publish, session, record, dispatcher } = await setup();
  const responses = Array.from({ length: 5 }, () => createResponse());
  await Promise.all(responses.map((res) => publish(publishRequest(session, { revision: record.revision }), res)));

  assert.equal(responses.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(dispatcher.dispatches.length, 1);
});

test('Publish refuses a stale revision after the seed changed', async () => {
  const { publish, store, session, record, dispatcher } = await setup();
  const { transitionRecord } = await import('../lib/install-post-queue.mjs');
  const corrected = transitionRecord(record, { type: 'correct', patch: { 'tv-size': '75"' } }).record;
  await store.saveRecord(corrected);

  const res = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'stale_revision');
  assert.equal(dispatcher.dispatches.length, 0);
});

test('Publish refuses a job with no photo bound', async () => {
  const { publish, session, record, dispatcher } = await setup({ withPhoto: false });
  const res = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'photo_required');
  assert.equal(dispatcher.dispatches.length, 0);
});

test('today\'s Oakdale 86-inch unmount does not publish without a before photo', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [{
      city: 'Oakdale',
      'job-type': 'unmount',
      title: 'TV Unmounting in Oakdale | 86" Near 2nd Street North',
      slug: 'tv-unmounting-oakdale-86-inch-2nd-street-north',
      'post-body': 'We took down this 86" TV near 2nd Street North in Oakdale.',
      'tv-size': '86"',
      'street-name': '2nd Street North',
      'local-reference': '2nd Street North',
      'seed-index': 1,
      'seed-count': 1,
    }],
    sourceRefs: { orderId: 'ORDER-OAKDALE-UNMOUNT', paymentId: 'PAY-OAKDALE-UNMOUNT' },
    source: 'square-webhook',
    stagedAt: '2026-08-23T15:00:00.000Z',
  });

  const dispatcher = createFakeDispatcher();
  const session = signOperatorSession({ jobId: staged.jobId, secret: SESSION_SECRET, expiresAt: NOW + 3600_000 });
  const publish = createPublishHandler({
    store,
    sessionSecret: SESSION_SECRET,
    dispatcher,
    now: () => NOW,
  });

  const res = createResponse();
  await publish(publishRequest(session, { revision: staged.revision }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'photo_required');
  assert.equal(dispatcher.dispatches.length, 0);
  assert.equal(staged.seed['job-type'], 'unmount');
  assert.doesNotMatch(JSON.stringify(staged.seed), /\b(?:apt|apartment|unit)\b/i);
});

test('a failed dispatch releases the lease so Publish can be retried', async () => {
  const { publish, store, session, record } = await setup({ dispatcherOptions: { fail: true } });
  const failed = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error, 'dispatch_failed');

  const reloaded = await store.loadRecord(record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.RETRYABLE_FAILURE);
  assert.equal(reloaded.lease, null);
  assert.equal(
    await store.claimPublishLease({ jobId: record.jobId, revision: record.revision, dispatchId: 'retry' }),
    'claimed',
  );
});

// ---------------------------------------------------------------------------
// Runner envelope
// ---------------------------------------------------------------------------

test('the runner envelope requires a valid signature', async () => {
  const { envelope, publish, session, record } = await setup();
  await publish(publishRequest(session, { revision: record.revision }), createResponse());

  const path = '/api/install-post/runner/envelope';
  const body = { jobId: record.jobId, revision: record.revision };

  const unsigned = createResponse();
  await envelope({ method: 'POST', url: path, headers: {}, body }, unsigned);
  assert.equal(unsigned.statusCode, 401);

  const wrongSecret = createResponse();
  await envelope(signedRunnerRequest({ path, body, secret: 'nope' }), wrongSecret);
  assert.equal(wrongSecret.statusCode, 401);
  assert.equal(wrongSecret.body.reason, 'bad_signature');
});

test('the runner envelope returns the approved seed and photo, and no secrets', async () => {
  const { envelope, publish, session, record } = await setup();
  await publish(publishRequest(session, { revision: record.revision }), createResponse());

  const path = '/api/install-post/runner/envelope';
  const body = { jobId: record.jobId, revision: record.revision };
  const res = createResponse();
  await envelope(signedRunnerRequest({ path, body }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jobId, record.jobId);
  assert.equal(res.body.revision, record.revision);
  assert.equal(res.body.seed['tv-size'], '65"');
  assert.equal(res.body.seed['street-name'], 'Elm Street');
  assert.equal(res.body.image.sha256, IMAGE.sha256);
  assert.equal(res.body.image.hostedUrl, IMAGE.hostedUrl);
  assert.equal(res.body.artMode, 'never');
  assert.ok(Array.isArray(res.body.postedDestinations));

  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['ORDER-ABC-123', 'PAY-XYZ-789', '4821', RUNNER_SECRET, SESSION_SECRET]) {
    assert.ok(!serialized.includes(forbidden), `envelope leaked ${forbidden}`);
  }
});

test('the runner envelope refuses a revision that is not the approved one', async () => {
  const { envelope, publish, session, record } = await setup();
  await publish(publishRequest(session, { revision: record.revision }), createResponse());

  const path = '/api/install-post/runner/envelope';
  const res = createResponse();
  await envelope(signedRunnerRequest({ path, body: { jobId: record.jobId, revision: 'rev-other' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'stale_revision');
});

test('the runner envelope refuses a job that was never approved', async () => {
  const { envelope, record } = await setup();
  const path = '/api/install-post/runner/envelope';
  const res = createResponse();
  await envelope(signedRunnerRequest({ path, body: { jobId: record.jobId, revision: record.revision } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'not_approved');
});

// ---------------------------------------------------------------------------
// Runner callback
// ---------------------------------------------------------------------------

async function publishedSetup() {
  const context = await setup();
  await context.publish(publishRequest(context.session, { revision: context.record.revision }), createResponse());
  // The runner is handed this id at dispatch and must quote it back; the
  // callback is bound to the lease, not just to the revision.
  return { ...context, dispatchId: context.dispatcher.dispatches.at(-1).dispatchId };
}

test('a verified success is recorded with a sanitized result', async () => {
  const { callback, store, record, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  const body = {
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: {
      status: 'PUBLISHED',
      liveUrl: 'https://www.themountingman.com/installations/65-inch-samsung',
      publicStatus: 200,
      itemId: 'item-1',
      slug: '65-inch-samsung',
      message: 'ok for jane@example.com',
      webflowToken: 'super-secret-token',
    },
  };

  const res = createResponse();
  await callback(signedRunnerRequest({ path, body }), res);
  assert.equal(res.statusCode, 200);

  const reloaded = await store.loadRecord(record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.PUBLISHED);
  assert.equal(reloaded.result.liveUrl, body.result.liveUrl);
  assert.equal(reloaded.result.webflowToken, undefined);
  assert.ok(!JSON.stringify(reloaded.result).includes('jane@example.com'));
  assert.ok(!JSON.stringify(reloaded.result).includes('super-secret-token'));
});

test('a publisher acknowledgement without a verified URL is not success', async () => {
  const { callback, store, record, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  const res = createResponse();
  await callback(signedRunnerRequest({
    path,
    body: { jobId: record.jobId, revision: record.revision, dispatchId, result: { status: 'PUBLISHED', liveUrl: '', publicStatus: 0 } },
  }), res);

  const reloaded = await store.loadRecord(record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.INDETERMINATE);
  assert.notEqual(reloaded.lease, null);
});

test('a retryable failure clears the lease so Publish works again', async () => {
  const { callback, store, publish, session, record, dispatcher, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  await callback(signedRunnerRequest({
    path,
    body: { jobId: record.jobId, revision: record.revision, dispatchId, result: { status: 'RETRYABLE_FAILURE', message: 'HTTP 503' } },
  }), createResponse());

  const reloaded = await store.loadRecord(record.jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.RETRYABLE_FAILURE);
  assert.equal(reloaded.lease, null);

  const retry = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(dispatcher.dispatches.length, 2);
});

test('an indeterminate outcome blocks retry until it is reconciled', async () => {
  const { callback, publish, session, record, dispatcher, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  await callback(signedRunnerRequest({
    path,
    body: {
      jobId: record.jobId,
      revision: record.revision,
      dispatchId,
      result: { status: 'INDETERMINATE', message: 'timed out after Webflow accepted the item' },
    },
  }), createResponse());

  const retry = createResponse();
  await publish(publishRequest(session, { revision: record.revision }), retry);
  assert.equal(retry.statusCode, 409);
  assert.equal(dispatcher.dispatches.length, 1);
});

test('a callback for a revision that is no longer approved is refused', async () => {
  const { callback, store, record, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  const res = createResponse();
  await callback(signedRunnerRequest({
    path,
    body: { jobId: record.jobId, revision: 'rev-other', dispatchId, result: { status: 'PUBLISHED', liveUrl: 'https://x/y', publicStatus: 200 } },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHING);
});

test('a replayed callback cannot resurrect a published job', async () => {
  const { callback, store, record, dispatchId } = await publishedSetup();
  const path = '/api/install-post/runner/callback';
  const success = {
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: { status: 'PUBLISHED', liveUrl: 'https://www.themountingman.com/installations/x', publicStatus: 200 },
  };
  await callback(signedRunnerRequest({ path, body: success }), createResponse());

  const replay = createResponse();
  await callback(signedRunnerRequest({
    path,
    body: { ...success, result: { status: 'RETRYABLE_FAILURE', message: 'late failure' } },
  }), replay);

  assert.equal(replay.statusCode, 409);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHED);
});

// ---------------------------------------------------------------------------
// GitHub dispatcher
// ---------------------------------------------------------------------------

test('createGithubDispatcher sends only opaque references to the workflow', async () => {
  const posts = [];
  const dispatcher = createGithubDispatcher({
    token: 'ghp_test',
    owner: 'TheDirectorOfTheAgency',
    repo: 'mounting-man-dashboard',
    workflowFile: 'publish-install-post.yml',
    ref: 'main',
    httpClient: {
      async post(url, payload, options) {
        posts.push({ url, payload, options });
        return { status: 204 };
      },
    },
  });

  await dispatcher.dispatch({ jobId: 'job_abc', revision: 'rev123', dispatchId: 'd1' });

  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /workflows\/publish-install-post\.yml\/dispatches$/);
  assert.deepEqual(posts[0].payload, {
    ref: 'main',
    inputs: { job_id: 'job_abc', revision: 'rev123', dispatch_id: 'd1' },
  });
  assert.ok(!JSON.stringify(posts[0].payload).includes('ghp_test'));
});

test('createGithubDispatcher refuses to run unconfigured', async () => {
  const dispatcher = createGithubDispatcher({ token: '', owner: 'o', repo: 'r' });
  await assert.rejects(dispatcher.dispatch({ jobId: 'j', revision: 'r', dispatchId: 'd' }), /not configured/i);
});

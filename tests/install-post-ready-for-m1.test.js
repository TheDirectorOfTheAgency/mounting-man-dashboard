import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveAndDispatchInstallPost,
  autoDispatchIfPhotoBound,
} from '../lib/install-post-auto-publish.mjs';
import { HOLD_REASONS } from '../lib/install-post-confidence.mjs';
import { createConfiguredDispatcher, signRunnerRequest } from '../lib/install-post-dispatch.mjs';
import {
  INSTALL_POST_STATES,
  installPostPollDelayMs,
  signOperatorSession,
  transitionRecord,
} from '../lib/install-post-queue.mjs';
import {
  READY_FOR_M1_KIND,
  buildReadyForM1Ping,
  readyNotifyKeyFromEnv,
  readyNotifyUrlFromEnv,
  sendReadyForM1Ping,
} from '../lib/install-post-ready-notify.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { notifyQInstallPost } from '../lib/notify-install-post.mjs';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createRunnerEnvelopeHandler, ENVELOPE_PATH } from '../pages/api/install-post/runner/envelope.js';
import { createResponse } from './webhook-test-helpers.js';

const SESSION_SECRET = 'test-session-secret';
const RUNNER_SECRET = 'test-runner-secret';
const HOST = 'mounting-man-dashboard.vercel.app';
const NOW = 1_760_000_000_000;
const WOODWARD_URL = 'https://woodward.example/square-wake';

const SEED = {
  city: 'Edina',
  state: 'MN',
  'tv-size': '65"',
  'tv-brand': 'Samsung',
  'wall-surface': 'Stone',
  price: '$450',
  'street-name': 'Elm Street',
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

const CUSTOMER = {
  address: {
    address_line_1: '4821 Elm Street',
    locality: 'Edina',
    administrative_district_level_1: 'MN',
    postal_code: '55424',
  },
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

function createPingRecorder() {
  const pings = [];
  return {
    pings,
    async notify({ record }) {
      pings.push(buildReadyForM1Ping(record));
      return { forwarded: true };
    },
  };
}

async function stageJob({ seed = SEED, withPhoto = true } = {}) {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [seed],
    sourceRefs: { orderId: 'ORDER-M1', paymentId: 'PAY-M1' },
    source: 'square-webhook',
    stagedAt: '2026-09-24T03:00:00.000Z',
  });
  let record = staged;
  if (withPhoto) {
    record = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
    await store.saveRecord(record);
  }
  return { kv, store, record };
}

function publishRequest(jobId, body) {
  const session = signOperatorSession({ jobId, secret: SESSION_SECRET, expiresAt: NOW + 3600_000 });
  return {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher factory
// ---------------------------------------------------------------------------

test('createConfiguredDispatcher returns null when the dispatch token is empty', () => {
  assert.equal(createConfiguredDispatcher({ env: {} }), null);
  assert.equal(createConfiguredDispatcher({ env: { INSTALL_POST_DISPATCH_TOKEN: '   ' } }), null);
  assert.equal(createConfiguredDispatcher({
    env: { INSTALL_POST_DISPATCH_OWNER: 'o', INSTALL_POST_DISPATCH_REPO: 'r' },
  }), null);
  const configured = createConfiguredDispatcher({ env: { INSTALL_POST_DISPATCH_TOKEN: 'ghp_test' } });
  assert.equal(typeof configured?.dispatch, 'function');
});

// ---------------------------------------------------------------------------
// PASS with no dispatcher → READY_FOR_M1
// ---------------------------------------------------------------------------

test('PASS + photo with no dispatcher lands in READY_FOR_M1 with one plain ping', async () => {
  const { kv, store, record } = await stageJob();
  const ping = createPingRecorder();
  const outcome = await autoDispatchIfPhotoBound({
    store,
    jobId: record.jobId,
    dispatcher: null,
    now: () => NOW,
    typesafeApiKey: '',
    readyNotifier: ping.notify,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.readyForM1, true);
  const saved = await store.loadRecord(record.jobId);
  assert.equal(saved.state, INSTALL_POST_STATES.READY_FOR_M1);
  assert.notEqual(saved.state, INSTALL_POST_STATES.RETRYABLE_FAILURE);
  assert.equal(saved.approval.revision, record.revision);
  assert.equal(saved.approval.imageSha256, IMAGE.sha256);
  assert.equal(saved.lease, null);
  assert.equal(saved.result, null);
  assert.equal([...kv.values.keys()].some((key) => key.includes('lease')), false, 'no cloud lease claimed');

  assert.equal(ping.pings.length, 1);
  assert.equal(ping.pings[0].kind, READY_FOR_M1_KIND);
  assert.equal(ping.pings[0].jobId, record.jobId);
  assert.match(ping.pings[0].body, /ready for M1 publish: 65" Samsung · Edina$/);
  const serialized = JSON.stringify(ping.pings[0]);
  for (const forbidden of ['Elm', '4821', 'ORDER-M1', 'PAY-M1']) {
    assert.equal(serialized.includes(forbidden), false, `ping leaked ${forbidden}`);
  }
});

test('READY_FOR_M1 is idempotent: a repeat PASS for the same revision does not ping again', async () => {
  const { store, record } = await stageJob();
  const ping = createPingRecorder();
  const args = { store, jobId: record.jobId, dispatcher: null, now: () => NOW, readyNotifier: ping.notify };
  await autoDispatchIfPhotoBound(args);
  const repeat = await autoDispatchIfPhotoBound(args);

  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyReady, true);
  assert.equal(ping.pings.length, 1);
});

test('READY_FOR_M1 never polls, never times out, and a correction reopens it', async () => {
  const { store, record } = await stageJob();
  await autoDispatchIfPhotoBound({
    store, jobId: record.jobId, dispatcher: null, now: () => NOW, readyNotifier: null,
  });
  const ready = await store.loadRecord(record.jobId);

  assert.equal(installPostPollDelayMs(ready.state), 0);
  const later = new Date(NOW + 24 * 3600_000).toISOString();
  assert.equal(transitionRecord(ready, { type: 'timeout', at: later }).ok, false);

  const corrected = transitionRecord(ready, { type: 'correct', patch: { 'tv-size': '75"' } });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.record.state, INSTALL_POST_STATES.READY);
  assert.equal(corrected.record.approval, null);
  assert.notEqual(corrected.record.revision, ready.revision);
});

test('the cloud runner envelope refuses a READY_FOR_M1 job', async () => {
  const { store, record } = await stageJob();
  await autoDispatchIfPhotoBound({
    store, jobId: record.jobId, dispatcher: null, now: () => NOW, readyNotifier: null,
  });
  const envelope = createRunnerEnvelopeHandler({ store, runnerSecret: RUNNER_SECRET, now: () => NOW });
  const body = { jobId: record.jobId, revision: record.revision };
  const timestamp = Math.floor(NOW / 1000);
  const res = createResponse();
  await envelope({
    method: 'POST',
    url: ENVELOPE_PATH,
    headers: {
      'x-install-post-signature': signRunnerRequest({
        secret: RUNNER_SECRET, method: 'POST', path: ENVELOPE_PATH, body, timestamp,
      }),
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'not_approved');
});

test('HOLD with no dispatcher stays READY and does not ping', async () => {
  const { store, record } = await stageJob({ seed: { ...SEED, city: 'Twin Cities' } });
  const ping = createPingRecorder();
  const outcome = await autoDispatchIfPhotoBound({
    store, jobId: record.jobId, dispatcher: null, now: () => NOW, readyNotifier: ping.notify,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'needs_human');
  assert.deepEqual(outcome.holdReasons, [HOLD_REASONS.METRO_PLACEHOLDER_CITY]);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY);
  assert.equal(ping.pings.length, 0);
});

test('reconcile with no dispatcher is refused clearly instead of handing off', async () => {
  const { store, record } = await stageJob();
  const indeterminate = {
    ...record,
    state: INSTALL_POST_STATES.INDETERMINATE,
    approval: { revision: record.revision, imageSha256: IMAGE.sha256, approvedAt: 'x' },
  };
  await store.saveRecord(indeterminate);
  const outcome = await approveAndDispatchInstallPost({
    store, jobId: record.jobId, revision: record.revision, dispatcher: null, reconcile: true,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'dispatch_unconfigured');
  assert.equal(outcome.status, 503);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.INDETERMINATE);
});

test('Square notify with a bound photo and an empty dispatch token hands off to M1, no Woodward wake', async () => {
  const saved = process.env.INSTALL_POST_DISPATCH_TOKEN;
  delete process.env.INSTALL_POST_DISPATCH_TOKEN;
  try {
    const { store, record } = await stageJob();
    const ping = createPingRecorder();
    const posts = [];
    const result = await notifyQInstallPost(
      {
        orderId: 'ORDER-M1',
        payment: { id: 'PAY-M1', source_type: 'CARD' },
        invoice: {},
        eventType: 'payment.created',
        firstName: 'Test',
        lastName: 'Customer',
        customer: CUSTOMER,
      },
      {
        exists: async () => false,
        set: async () => true,
        sadd: async () => true,
        installPostStore: store,
        capabilitySecret: SESSION_SECRET,
        queueBaseUrl: `https://${HOST}`,
        woodwardUrl: WOODWARD_URL,
        woodwardKey: 'woodward-sender-key',
        typesafeApiKey: '',
        readyNotifier: ping.notify,
        httpClient: {
          async get() {
            return {
              data: {
                order: {
                  id: 'ORDER-M1',
                  line_items: [{ name: '65" TV Installation', quantity: '1', base_price_money: { amount: 45000 } }],
                },
              },
            };
          },
          async post(url, body) {
            posts.push({ url, body });
            return { data: {} };
          },
        },
      },
    );

    assert.equal(posts.length, 0, 'PASS must not wake Woodward');
    assert.equal(result.woodwardPayload.deskAction, 'none');
    const entry = result.cloudDispatch.find((row) => row.jobId === record.jobId);
    assert.equal(entry.ok, true);
    assert.equal(entry.readyForM1, true);
    assert.notEqual(entry.reason, 'dispatch_failed');
    assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY_FOR_M1);
    assert.equal(ping.pings.length, 1);
  } finally {
    if (saved === undefined) delete process.env.INSTALL_POST_DISPATCH_TOKEN;
    else process.env.INSTALL_POST_DISPATCH_TOKEN = saved;
  }
});

// ---------------------------------------------------------------------------
// Manual Publish runs the same deterministic gate
// ---------------------------------------------------------------------------

const MANUAL_HOLDS = [
  ['placeholder city', { city: 'Twin Cities' }, HOLD_REASONS.METRO_PLACEHOLDER_CITY],
  ['unknown city', { city: 'Austin', state: 'TX' }, HOLD_REASONS.UNKNOWN_CITY],
  ['Google-blob street', { 'street-name': 'Gable Ln, Woodbury, MN 55129, USA', city: 'Woodbury' }, HOLD_REASONS.GOOGLE_BLOB_STREET],
  ['TV as size', { 'tv-size': 'TV' }, HOLD_REASONS.MISSING_TV_SIZE],
];

for (const [label, patch, reason] of MANUAL_HOLDS) {
  for (const withDispatcher of [true, false]) {
    test(`manual Publish HOLDs on ${label} (${withDispatcher ? 'cloud dispatcher' : 'no dispatcher'})`, async () => {
      const { store, record } = await stageJob({ seed: { ...SEED, ...patch } });
      const dispatcher = withDispatcher ? createFakeDispatcher() : null;
      const ping = createPingRecorder();
      const publish = createPublishHandler({
        store, sessionSecret: SESSION_SECRET, dispatcher, now: () => NOW, readyNotifier: ping.notify,
      });
      const res = createResponse();
      await publish(publishRequest(record.jobId, { revision: record.revision }), res);

      assert.equal(res.statusCode, 422);
      assert.equal(res.body.error, 'needs_human');
      assert.ok(res.body.holdReasons.includes(reason), JSON.stringify(res.body.holdReasons));
      assert.equal(res.body.job.state, INSTALL_POST_STATES.READY);
      assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY);
      if (dispatcher) assert.equal(dispatcher.dispatches.length, 0);
      assert.equal(ping.pings.length, 0);
      const serialized = JSON.stringify(res.body.holdReasons);
      assert.equal(serialized.includes('Gable'), false);
    });
  }
}

test('manual Publish on a clean job with no dispatcher answers READY_FOR_M1', async () => {
  const { store, record } = await stageJob();
  const ping = createPingRecorder();
  const publish = createPublishHandler({
    store, sessionSecret: SESSION_SECRET, dispatcher: null, now: () => NOW, readyNotifier: ping.notify,
  });
  const res = createResponse();
  await publish(publishRequest(record.jobId, { revision: record.revision }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.READY_FOR_M1);
  assert.equal(ping.pings.length, 1);

  const again = createResponse();
  await publish(publishRequest(record.jobId, { revision: record.revision }), again);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.job.state, INSTALL_POST_STATES.READY_FOR_M1);
  assert.equal(ping.pings.length, 1);
});

test('manual Publish on a clean job with a cloud dispatcher still dispatches', async () => {
  const { store, record } = await stageJob();
  const dispatcher = createFakeDispatcher();
  const publish = createPublishHandler({ store, sessionSecret: SESSION_SECRET, dispatcher, now: () => NOW });
  const res = createResponse();
  await publish(publishRequest(record.jobId, { revision: record.revision }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(dispatcher.dispatches.length, 1);
});

// ---------------------------------------------------------------------------
// Plain ready ping transport
// ---------------------------------------------------------------------------

test('ready ping env falls back to the GBP operator webhook', () => {
  const gbp = { INSTALL_POST_GBP_NOTIFY_URL: 'https://owner.example/gbp', INSTALL_POST_GBP_NOTIFY_KEY: 'gbp-key' };
  assert.equal(readyNotifyUrlFromEnv(gbp), 'https://owner.example/gbp');
  assert.equal(readyNotifyKeyFromEnv(gbp), 'gbp-key');
  const override = { ...gbp, INSTALL_POST_READY_NOTIFY_URL: 'https://owner.example/ready', INSTALL_POST_READY_NOTIFY_KEY: 'ready-key' };
  assert.equal(readyNotifyUrlFromEnv(override), 'https://owner.example/ready');
  assert.equal(readyNotifyKeyFromEnv(override), 'ready-key');
});

test('ready ping posts one Bearer-authenticated fixed-template body and fails open', async () => {
  const record = {
    jobId: 'job_ready',
    revision: 'rev1',
    state: INSTALL_POST_STATES.READY_FOR_M1,
    seed: { ...SEED, 'street-name': 'Elm Street' },
  };
  const posts = [];
  const sent = await sendReadyForM1Ping({
    record,
    url: 'https://owner.example/ready',
    key: 'ready-key',
    httpClient: {
      async post(url, body, config) {
        posts.push({ url, body, headers: config.headers });
        return { data: {} };
      },
    },
    logger: { warn() {} },
  });
  assert.deepEqual(sent, { forwarded: true });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.Authorization, 'Bearer ready-key');
  assert.equal(posts[0].body.kind, READY_FOR_M1_KIND);
  assert.equal(JSON.stringify(posts[0].body).includes('Elm'), false);

  const failed = await sendReadyForM1Ping({
    record,
    url: 'https://owner.example/ready',
    key: 'ready-key',
    httpClient: { async post() { throw new Error('offline'); } },
    logger: { warn() {} },
  });
  assert.deepEqual(failed, { forwarded: false, error: true });

  const notReady = await sendReadyForM1Ping({ record: { ...record, state: INSTALL_POST_STATES.READY } });
  assert.equal(notReady.skipped, 'not_ready');
});

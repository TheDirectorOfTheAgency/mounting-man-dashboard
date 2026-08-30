import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveAndDispatchInstallPost,
  autoDispatchIfPhotoBound,
} from '../lib/install-post-auto-publish.mjs';
import {
  INSTALL_POST_CLOUD_PUBLISHER,
  INSTALL_POST_FORBIDDEN_SCRIPTS,
  buildKronkiteSquarePayload,
  notifyQInstallPost,
} from '../lib/notify-install-post.mjs';
import { INSTALL_POST_STATES, signOperatorSession, transitionRecord } from '../lib/install-post-queue.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createUploadHandler } from '../pages/api/install-post/upload.js';
import { createResponse } from './webhook-test-helpers.js';

const SECRET = 'test-session-secret';
const HOST = 'mounting-man-dashboard.vercel.app';
const NOW = 1_760_000_000_000;
const KRONKITE_URL = 'https://kronkite.example/square-wake';

const SEED = {
  city: 'Edina',
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
  md5: 'b'.repeat(32),
};

const CUSTOMER = {
  given_name: 'Test',
  family_name: 'Customer',
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

function redditUrls(blob) {
  return String(blob).match(/reddit\.com|oauth\.reddit|old\.reddit/gi) || [];
}

async function stageJob({ withPhoto = false } = {}) {
  const store = createInstallPostStore(createFakeKv());
  const [staged] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-1', paymentId: 'PAY-1' },
    source: 'square-webhook',
    stagedAt: '2026-08-30T15:00:00.000Z',
  });
  let record = staged;
  if (withPhoto) {
    record = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
    await store.saveRecord(record);
  }
  return { store, record, dispatcher: createFakeDispatcher() };
}

test('auto-dispatch is skipped when the photo is missing', async () => {
  const { store, record, dispatcher } = await stageJob({ withPhoto: false });
  const outcome = await autoDispatchIfPhotoBound({
    store,
    jobId: record.jobId,
    dispatcher,
    now: () => NOW,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'photo_required');
  assert.equal(dispatcher.dispatches.length, 0);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.AWAITING_PHOTO);
});

test('approveAndDispatch refuses a job with no photo bound', async () => {
  const { store, record, dispatcher } = await stageJob({ withPhoto: false });
  const outcome = await approveAndDispatchInstallPost({
    store,
    jobId: record.jobId,
    revision: record.revision,
    dispatcher,
    now: () => NOW,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'photo_required');
  assert.equal(dispatcher.dispatches.length, 0);
});

test('Square+photo auto-dispatch uses the same opaque workflow inputs as the phone tap', async () => {
  const { store, record, dispatcher } = await stageJob({ withPhoto: true });
  const outcome = await autoDispatchIfPhotoBound({
    store,
    jobId: record.jobId,
    dispatcher,
    now: () => NOW,
  });
  assert.equal(outcome.ok, true);
  assert.equal(dispatcher.dispatches.length, 1);
  assert.equal(dispatcher.dispatches[0].jobId, record.jobId);
  assert.equal(dispatcher.dispatches[0].revision, record.revision);
  assert.ok(dispatcher.dispatches[0].dispatchId);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHING);

  const serialized = JSON.stringify(dispatcher.dispatches);
  assert.equal(redditUrls(serialized).length, 0);
  for (const forbidden of ['ORDER-1', 'PAY-1', '4821', 'publish_one.py', 'go.py']) {
    assert.ok(!serialized.includes(forbidden), `dispatch leaked ${forbidden}`);
  }
});

test('photo commit auto-dispatches the cloud runner and never Reddit', async () => {
  const { store, record, dispatcher } = await stageJob({ withPhoto: false });
  const session = signOperatorSession({
    jobId: record.jobId,
    secret: SECRET,
    expiresAt: NOW + 3600_000,
  });
  const webflow = {
    async createSignedUpload() {
      return {
        assetId: 'asset-1',
        hostedUrl: IMAGE.hostedUrl,
        uploadUrl: 'https://s3.example.com/upload',
        uploadDetails: { key: 'assets/photo.webp' },
      };
    },
  };
  const upload = createUploadHandler({
    store,
    sessionSecret: SECRET,
    webflow,
    dispatcher,
    now: () => NOW,
  });

  const init = createResponse();
  await upload({
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body: {
      action: 'init',
      revision: record.revision,
      contentType: IMAGE.contentType,
      bytes: IMAGE.bytes,
      sha256: IMAGE.sha256,
      md5: IMAGE.md5,
    },
  }, init);
  assert.equal(init.statusCode, 200);

  const commit = createResponse();
  await upload({
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body: {
      action: 'commit',
      revision: record.revision,
      uploadId: init.body.uploadId,
      sha256: IMAGE.sha256,
    },
  }, commit);

  assert.equal(commit.statusCode, 200);
  assert.equal(commit.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(dispatcher.dispatches.length, 1);
  assert.equal(redditUrls(JSON.stringify(commit.body)).length, 0);
  assert.equal(redditUrls(JSON.stringify(dispatcher.dispatches)).length, 0);
});

test('Kronkite wake asks for the photo only and forbids local Python publishers', () => {
  const payload = buildKronkiteSquarePayload({
    facts: { city: 'Edina', streetName: 'Elm Street', tvSize: '65"' },
    payment: { id: 'payment-1', source_type: 'CARD' },
    orderId: 'order-1',
    installSubtotal: '$450',
    photoPresent: false,
    deskAction: 'request_photo',
  });

  assert.equal(payload.publisher, INSTALL_POST_CLOUD_PUBLISHER);
  assert.equal(payload.photoPresent, false);
  assert.equal(payload.deskAction, 'request_photo');
  assert.deepEqual(payload.doNotRun, [...INSTALL_POST_FORBIDDEN_SCRIPTS]);
  assert.ok(payload.doNotRun.includes('publish_one.py'));
  assert.ok(payload.doNotRun.includes('go.py'));
  assert.equal(redditUrls(JSON.stringify(payload)).length, 0);
});

test('Square notify with no photo wakes Kronkite for the photo and does not dispatch', async () => {
  const store = createInstallPostStore(createFakeKv());
  const dispatcher = createFakeDispatcher();
  const posts = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'order-1',
      payment: { id: 'payment-1', source_type: 'CARD' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName: 'Test',
      lastName: 'Customer',
      customer: CUSTOMER,
      amount: '450.00',
      amountCents: 45000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      installPostStore: store,
      capabilitySecret: SECRET,
      queueBaseUrl: 'https://mounting-man-dashboard.vercel.app',
      kronkiteUrl: KRONKITE_URL,
      kronkiteKey: 'kronkite-sender-key',
      dispatcher,
      httpClient: {
        async get() {
          return {
            data: {
              order: {
                id: 'order-1',
                line_items: [{ name: '65" TV Installation', quantity: '1', base_price_money: { amount: 45000 } }],
              },
            },
          };
        },
        async post(url, body, config) {
          posts.push({ url, body, headers: config?.headers || {} });
          return { data: {} };
        },
      },
    },
  );

  assert.equal(dispatcher.dispatches.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, KRONKITE_URL);
  assert.equal(posts[0].body.deskAction, 'request_photo');
  assert.equal(posts[0].body.publisher, 'cloud-runner');
  assert.equal(posts[0].body.photoPresent, false);
  assert.deepEqual(posts[0].body.doNotRun, ['publish_one.py', 'go.py']);
  assert.equal(result.cloudDispatch.every((entry) => entry.skipped === 'photo_required' || !entry.ok), true);
  assert.equal(redditUrls(JSON.stringify(posts)).length, 0);
});

test('Square notify with a bound photo dispatches the cloud runner and skips the desk hop', async () => {
  const { store, record, dispatcher } = await stageJob({ withPhoto: true });
  const posts = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'ORDER-1',
      payment: { id: 'PAY-1', source_type: 'CARD' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName: 'Test',
      lastName: 'Customer',
      customer: CUSTOMER,
      amount: '450.00',
      amountCents: 45000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      installPostStore: store,
      capabilitySecret: SECRET,
      queueBaseUrl: 'https://mounting-man-dashboard.vercel.app',
      kronkiteUrl: KRONKITE_URL,
      kronkiteKey: 'kronkite-sender-key',
      dispatcher,
      httpClient: {
        async get() {
          return {
            data: {
              order: {
                id: 'ORDER-1',
                line_items: [{ name: '65" TV Installation', quantity: '1', base_price_money: { amount: 45000 } }],
              },
            },
          };
        },
        async post(url, body, config) {
          posts.push({ url, body, headers: config?.headers || {} });
          return { data: {} };
        },
      },
    },
  );

  assert.equal(posts.length, 0, 'photo present must not wake Woodward/Q');
  assert.equal(result.kronkite.skipped, 'photo_present_cloud_publisher');
  assert.equal(result.kronkitePayload.deskAction, 'none');
  assert.equal(result.kronkitePayload.publisher, 'cloud-runner');
  assert.ok(result.cloudDispatch.some((entry) => entry.ok && entry.jobId === record.jobId));
  assert.equal(dispatcher.dispatches.length, 1);
  assert.equal(dispatcher.dispatches[0].jobId, record.jobId);
});

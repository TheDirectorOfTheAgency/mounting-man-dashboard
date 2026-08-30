import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  attachGbpQueuedDestination,
  buildGbpCaption,
  createGbpQueue,
  enqueueGbpAfterPublish,
  gbpPayloadFromRecord,
  gbpSurfacesComplete,
  sanitizeGbpItem,
  shouldEnqueueGbp,
} from '../lib/install-post-gbp-queue.mjs';
import { signRunnerRequest } from '../lib/install-post-dispatch.mjs';
import { signOperatorSession, transitionRecord } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createGbpHandler } from '../pages/api/install-post/gbp.js';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createRunnerCallbackHandler } from '../pages/api/install-post/runner/callback.js';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createResponse } from './webhook-test-helpers.js';

const SESSION_SECRET = 'test-session-secret';
const RUNNER_SECRET = 'test-runner-secret';
const GBP_SECRET = 'test-gbp-worker-secret';
const HOST = 'mounting-man-dashboard.vercel.app';
const NOW = 1_760_000_000_000;

const SEED = {
  city: 'Edina',
  title: '65 Inch Samsung Frame TV Installation in Edina',
  'post-summary': 'We mounted a 65 inch Samsung on stone in Edina.',
  'tv-size': '65"',
  'tv-brand': 'Samsung',
  'wall-surface': 'Stone',
  price: '$450',
  'street-name': '4821 Elm Street',
  slug: '65-inch-samsung-edina',
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

function signedCallback({ jobId, revision, dispatchId, result }) {
  const path = '/api/install-post/runner/callback';
  const body = { jobId, revision, dispatchId, result };
  const timestamp = Math.floor(NOW / 1000);
  return {
    method: 'POST',
    url: path,
    headers: {
      'x-install-post-signature': signRunnerRequest({
        secret: RUNNER_SECRET, method: 'POST', path, body, timestamp,
      }),
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  };
}

function publishedResult(overrides = {}) {
  return {
    status: 'PUBLISHED',
    liveUrl: 'https://www.themountingman.com/installations/65-inch-samsung-edina',
    imageUrl: 'https://cdn.example.com/65-inch-samsung.webp',
    publicStatus: 200,
    itemId: 'item-1',
    slug: '65-inch-samsung-edina',
    destinations: [
      { name: 'website', status: 'PUBLISHED', detail: 'https://www.themountingman.com/installations/65-inch-samsung-edina' },
      { name: 'instagram', status: 'PUBLISHED', detail: 'ig-1' },
      { name: 'facebook', status: 'PUBLISHED', detail: 'fb-1' },
      { name: 'linkedin', status: 'SKIPPED', detail: 'credentials unset' },
      { name: 'x', status: 'PUBLISHED', detail: 'https://x.com/MountingManTV/status/1' },
    ],
    ...overrides,
  };
}

async function publishedSetup() {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const gbpQueue = createGbpQueue(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-ABC-123', paymentId: 'PAY-XYZ-789' },
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });
  const withPhoto = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
  await store.saveRecord(withPhoto);

  const dispatcher = {
    dispatches: [],
    async dispatch(payload) {
      this.dispatches.push(payload);
      return { dispatchId: payload.dispatchId };
    },
  };
  const session = signOperatorSession({
    jobId: withPhoto.jobId, secret: SESSION_SECRET, expiresAt: NOW + 3600_000,
  });
  const publish = createPublishHandler({
    store, sessionSecret: SESSION_SECRET, dispatcher, now: () => NOW,
  });
  await publish({
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body: { revision: withPhoto.revision },
  }, createResponse());

  return {
    kv,
    store,
    gbpQueue,
    record: withPhoto,
    dispatchId: dispatcher.dispatches.at(-1).dispatchId,
    callback: createRunnerCallbackHandler({
      store, gbpQueue, runnerSecret: RUNNER_SECRET, now: () => NOW,
    }),
    gbp: createGbpHandler({ queue: gbpQueue, workerSecret: GBP_SECRET }),
  };
}

function gbpRequest(method, { body, secret = GBP_SECRET } = {}) {
  return {
    method,
    headers: {
      authorization: secret ? `Bearer ${secret}` : '',
    },
    body,
  };
}

test('caption uses house copy and keeps the CTA on cta_url', () => {
  const caption = buildGbpCaption(SEED);
  assert.match(caption, /65 inch Samsung/);
  assert.match(caption, /\$450/);
  assert.doesNotMatch(caption, /4821/);
  assert.doesNotMatch(caption, /themountingman\.com/);
  assert.doesNotMatch(caption, /reddit/i);
});

test('sanitize rejects a non-installation URL and a Reddit field', () => {
  assert.equal(sanitizeGbpItem({
    slug: '65-inch-samsung-edina',
    live_url: 'https://old.reddit.com/r/something',
    caption: 'nope',
  }), null);
  assert.equal(sanitizeGbpItem({
    slug: '65-inch-samsung-edina',
    live_url: 'https://www.themountingman.com/tv-mounting/minneapolis',
    caption: 'nope',
  }), null);
});

test('shouldEnqueueGbp skips an item that is already queued', () => {
  const item = gbpPayloadFromRecord({
    jobId: 'job_1',
    seed: SEED,
    image: IMAGE,
    result: publishedResult(),
  });
  assert.equal(shouldEnqueueGbp({ item, existing: null }).ok, true);
  assert.equal(shouldEnqueueGbp({ item, existing: item }).reason, 'already_queued');
  assert.equal(shouldEnqueueGbp({ item, existing: { ...item, status: 'posted' } }).reason, 'already_posted');
  assert.equal(shouldEnqueueGbp({ item: null }).reason, 'live_url_required');
});

test('a verified publish enqueues GBP for the M1 worker', async () => {
  const { callback, gbpQueue, record, dispatchId } = await publishedSetup();
  const res = createResponse();
  await callback(signedCallback({
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: publishedResult(),
  }), res);

  assert.equal(res.statusCode, 200);
  const pending = await gbpQueue.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].slug, '65-inch-samsung-edina');
  assert.equal(pending[0].live_url, 'https://www.themountingman.com/installations/65-inch-samsung-edina');
  assert.equal(pending[0].cta_url, pending[0].live_url);
  assert.equal(pending[0].image_url, IMAGE.hostedUrl);
  assert.equal(pending[0].image_path, null);
  assert.deepEqual(pending[0].required_surfaces, ['update', 'photos']);
  assert.equal(pending[0].skip_photos_when_update_pending, false);
  assert.equal(pending[0].surfaces.update.status, 'pending');
  assert.equal(pending[0].surfaces.photos.status, 'pending');
  assert.match(pending[0].caption, /65 inch Samsung/);
  assert.doesNotMatch(pending[0].caption, /4821/);
  assert.doesNotMatch(JSON.stringify(pending[0]), /reddit/i);
  assert.doesNotMatch(JSON.stringify(pending[0]), /business\.google\.com/i);

  const gbpDest = res.body.job.result.destinations.find((entry) => entry.name === 'gbp');
  assert.equal(gbpDest.status, 'QUEUED');
});

test('a second publish of the same slug does not queue GBP again', async () => {
  const { callback, gbpQueue, record, dispatchId, store } = await publishedSetup();
  const first = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: {
      ...record,
      result: publishedResult(),
    },
  });
  assert.equal(first.queued, true);

  const second = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: {
      ...record,
      result: publishedResult(),
    },
  });
  assert.equal(second.queued, false);
  assert.equal(second.reason, 'already_queued');
  assert.equal((await gbpQueue.listPending()).length, 1);

  const afterCallback = createResponse();
  await callback(signedCallback({
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: publishedResult(),
  }), afterCallback);
  assert.equal(afterCallback.statusCode, 200);
  assert.equal((await gbpQueue.listPending()).length, 1);
  const gbpDest = afterCallback.body.job.result.destinations.find((entry) => entry.name === 'gbp');
  assert.equal(gbpDest.detail, 'already_queued');
  assert.equal((await store.loadRecord(record.jobId)).result.destinations.filter((e) => e.name === 'gbp').length, 1);
});

test('a publish without a live installation URL does not enqueue GBP', async () => {
  const { callback, gbpQueue, record, dispatchId } = await publishedSetup();
  await callback(signedCallback({
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: { status: 'RETRYABLE_FAILURE', message: 'HTTP 503' },
  }), createResponse());

  assert.equal((await gbpQueue.listPending()).length, 0);
});

test('the M1 worker can pull caption, live_url, image URL, and slug', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const res = createResponse();
  await gbp(gbpRequest('GET'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.latest.slug, '65-inch-samsung-edina');
  assert.equal(res.body.pending[0].live_url, res.body.latest.cta_url);
  assert.ok(res.body.latest.image_url.startsWith('https://'));
  assert.equal(res.body.latest.image_path, null);
  assert.ok(res.body.latest.caption);
  assert.deepEqual(res.body.latest.required_surfaces, ['update', 'photos']);
  assert.equal(res.body.latest.skip_photos_when_update_pending, false);
});

test('legacy complete without a surface records Update only and keeps Photos pending', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const claimed = createResponse();
  await gbp(gbpRequest('POST', { body: { action: 'claim', slug: '65-inch-samsung-edina' } }), claimed);
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.body.item.status, 'claimed');

  const updateOnly = createResponse();
  await gbp(gbpRequest('POST', { body: { action: 'complete', slug: '65-inch-samsung-edina' } }), updateOnly);
  assert.equal(updateOnly.statusCode, 200);
  assert.equal(updateOnly.body.item.status, 'pending');
  assert.equal(updateOnly.body.item.surfaces.update.status, 'posted');
  assert.equal(updateOnly.body.item.surfaces.photos.status, 'pending');
  assert.equal((await gbpQueue.listPending()).length, 1);
  assert.equal(gbpSurfacesComplete(updateOnly.body.item.surfaces), false);

  const again = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });
  assert.equal(again.queued, false);
  assert.equal(again.reason, 'already_queued');
});

test('pending-review Update never skips the independent Photos upload', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const review = createResponse();
  await gbp(gbpRequest('POST', {
    body: {
      action: 'complete',
      slug: '65-inch-samsung-edina',
      surface: 'update',
      status: 'pending_review',
      id: 'update-pending-1',
    },
  }), review);
  assert.equal(review.statusCode, 200);
  assert.equal(review.body.item.status, 'pending');
  assert.equal(review.body.item.surfaces.update.status, 'pending_review');
  assert.equal(review.body.item.surfaces.photos.status, 'pending');
  assert.equal(review.body.item.skip_photos_when_update_pending, false);
  assert.equal((await gbpQueue.listPending()).length, 1);
});

test('the M1 worker can mark a slug posted only after Update AND Photos', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const claimed = createResponse();
  await gbp(gbpRequest('POST', { body: { action: 'claim', slug: '65-inch-samsung-edina' } }), claimed);
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.body.item.status, 'claimed');

  const done = createResponse();
  await gbp(gbpRequest('POST', {
    body: {
      action: 'complete',
      slug: '65-inch-samsung-edina',
      surfaces: {
        update: { status: 'posted', id: 'local-post-1' },
        photos: { status: 'posted', id: 'photo-1' },
      },
    },
  }), done);
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.item.status, 'posted');
  assert.equal(done.body.item.surfaces.update.status, 'posted');
  assert.equal(done.body.item.surfaces.photos.status, 'posted');
  assert.equal((await gbpQueue.listPending()).length, 0);

  const again = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });
  assert.equal(again.queued, false);
  assert.equal(again.reason, 'already_posted');
});

test('the GBP pull API refuses a missing or wrong secret', async () => {
  const { gbp } = await publishedSetup();
  const missing = createResponse();
  await gbp(gbpRequest('GET', { secret: '' }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = createResponse();
  await gbp(gbpRequest('GET', { secret: 'nope' }), wrong);
  assert.equal(wrong.statusCode, 401);
});

test('attachGbpQueuedDestination never adds Reddit', () => {
  const record = attachGbpQueuedDestination({
    result: { destinations: [{ name: 'website', status: 'PUBLISHED', detail: 'ok' }] },
  }, { slug: '65-inch-samsung-edina' });
  const names = record.result.destinations.map((entry) => entry.name);
  assert.deepEqual(names, ['website', 'gbp']);
  assert.ok(!names.includes('reddit'));
});

test('GBP queue and pull API never drive Google or Reddit', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of [
    'lib/install-post-gbp-queue.mjs',
    'pages/api/install-post/gbp.js',
    'pages/api/install-post/runner/callback.js',
  ]) {
    const source = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(source, /reddit\.com/i, `${rel} mentions Reddit`);
    assert.doesNotMatch(source, /playwright|puppeteer|chromium/i, `${rel} drives a browser`);
    assert.doesNotMatch(source, /accounts\.google\.com|mybusinessaccountmanagement/i, `${rel} changes GBP login`);
    assert.doesNotMatch(source, /primaryPhone|regularHours|storefrontAddress/i, `${rel} edits NAP`);
  }
});

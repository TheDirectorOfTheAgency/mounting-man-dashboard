import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  attachGbpQueuedDestinations,
  buildGbpCaption,
  createGbpQueue,
  enqueueGbpAfterPublish,
  gbpPayloadFromRecord,
  GBP_KINDS,
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

function byKind(pending) {
  return Object.fromEntries(pending.map((item) => [item.kind, item]));
}

test('caption uses house copy and keeps the CTA on cta_url / gbp_cta_url', () => {
  const caption = buildGbpCaption(SEED);
  assert.match(caption, /65 inch Samsung/);
  assert.match(caption, /\$450/);
  assert.doesNotMatch(caption, /4821/);
  assert.doesNotMatch(caption, /themountingman\.com/);
  assert.doesNotMatch(caption, /reddit/i);
});

test('sanitize rejects a Reddit URL and requires a kind', () => {
  assert.equal(sanitizeGbpItem({
    slug: '65-inch-samsung-edina',
    kind: 'update',
    live_url: 'https://old.reddit.com/r/something',
    caption: 'nope',
  }), null);
  assert.equal(sanitizeGbpItem({
    slug: '65-inch-samsung-edina',
    live_url: 'https://www.themountingman.com/installations/65-inch-samsung-edina',
  }), null);
});

test('shouldEnqueueGbp is independent per kind', () => {
  const update = gbpPayloadFromRecord({
    jobId: 'job_1',
    seed: SEED,
    image: IMAGE,
    result: publishedResult(),
  }, { kind: GBP_KINDS.UPDATE });
  const photos = gbpPayloadFromRecord({
    jobId: 'job_1',
    seed: SEED,
    image: IMAGE,
    result: publishedResult(),
  }, { kind: GBP_KINDS.PHOTOS });

  assert.equal(shouldEnqueueGbp({ item: update, existing: null }).ok, true);
  assert.equal(shouldEnqueueGbp({ item: photos, existing: update }).ok, true);
  assert.equal(shouldEnqueueGbp({ item: update, existing: update }).reason, 'already_queued');
  assert.equal(shouldEnqueueGbp({ item: photos, existing: { ...photos, status: 'posted' } }).reason, 'already_posted');
});

test('a verified publish enqueues an Update and an independent Photos upload', async () => {
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
  assert.equal(pending.length, 2);
  const { update, photos } = byKind(pending);

  assert.equal(update.slug, '65-inch-samsung-edina');
  assert.equal(update.kind, 'update');
  assert.equal(update.live_url, 'https://www.themountingman.com/installations/65-inch-samsung-edina');
  assert.equal(update.cta_url, update.live_url);
  assert.equal(update.gbp_cta_url, update.live_url);
  assert.equal(update.image_url, IMAGE.hostedUrl);
  assert.equal(update.image_path, null);
  assert.equal(update.upload_photo, true);
  assert.equal(update.photo_only, undefined);
  assert.match(update.caption, /65 inch Samsung/);
  assert.doesNotMatch(update.caption, /4821/);

  assert.equal(photos.kind, 'photos');
  assert.equal(photos.slug, update.slug);
  assert.equal(photos.photo_only, true);
  assert.equal(photos.skip_update, true);
  assert.equal(photos.upload_photo, undefined);
  assert.equal(photos.image_url, IMAGE.hostedUrl);
  assert.ok(!('skip_photos_if_pending_review' in photos));
  assert.ok(!('pending_review' in photos));

  const names = res.body.job.result.destinations.map((entry) => entry.name);
  assert.ok(names.includes('gbp'));
  assert.ok(names.includes('gbp-photos'));
  assert.ok(!names.includes('reddit'));
});

test('a second publish of the same slug does not queue either kind again', async () => {
  const { callback, gbpQueue, record, dispatchId } = await publishedSetup();
  const first = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });
  assert.equal(first.update.queued, true);
  assert.equal(first.photos.queued, true);

  const second = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });
  assert.equal(second.update.queued, false);
  assert.equal(second.update.reason, 'already_queued');
  assert.equal(second.photos.queued, false);
  assert.equal(second.photos.reason, 'already_queued');
  assert.equal((await gbpQueue.listPending()).length, 2);

  const afterCallback = createResponse();
  await callback(signedCallback({
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: publishedResult(),
  }), afterCallback);
  assert.equal(afterCallback.statusCode, 200);
  assert.equal((await gbpQueue.listPending()).length, 2);
});

test('completing an Update does not skip or hide the Photos-tab item', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const claimed = createResponse();
  await gbp(gbpRequest('POST', {
    body: { action: 'claim', slug: '65-inch-samsung-edina', kind: 'update' },
  }), claimed);
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.body.item.kind, 'update');

  const afterClaim = await gbpQueue.listPending();
  assert.equal(afterClaim.length, 2, 'claimed Update must not hide Photos');
  assert.ok(afterClaim.some((item) => item.kind === 'photos' && item.status === 'pending'));

  const done = createResponse();
  await gbp(gbpRequest('POST', {
    body: { action: 'complete', slug: '65-inch-samsung-edina', kind: 'update' },
  }), done);
  assert.equal(done.statusCode, 200);

  const pending = await gbpQueue.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'photos');
  assert.equal(pending[0].photo_only, true);

  const again = await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });
  assert.equal(again.update.reason, 'already_posted');
  assert.equal(again.photos.reason, 'already_queued');
  assert.equal((await gbpQueue.listPending()).length, 1);
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

test('the M1 worker can pull caption, live_url, image URL, and slug for both kinds', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const res = createResponse();
  await gbp(gbpRequest('GET'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.latest.kind, 'update');
  const { update, photos } = byKind(res.body.pending);
  assert.equal(update.live_url, update.gbp_cta_url);
  assert.equal(update.upload_photo, true);
  assert.equal(photos.photo_only, true);
  assert.equal(photos.skip_update, true);
  assert.ok(photos.image_url.startsWith('https://'));
});

test('claim and complete require a kind so Update and Photos stay independent', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({
    queue: gbpQueue,
    record: { ...record, result: publishedResult() },
  });

  const missingKind = createResponse();
  await gbp(gbpRequest('POST', { body: { action: 'complete', slug: '65-inch-samsung-edina' } }), missingKind);
  assert.equal(missingKind.statusCode, 400);
  assert.equal((await gbpQueue.listPending()).length, 2);

  const photosDone = createResponse();
  await gbp(gbpRequest('POST', {
    body: { action: 'complete', id: '65-inch-samsung-edina:photos' },
  }), photosDone);
  assert.equal(photosDone.statusCode, 200);
  const pending = await gbpQueue.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'update');
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

test('attachGbpQueuedDestinations never adds Reddit and keeps Photos separate', () => {
  const record = attachGbpQueuedDestinations({
    result: { destinations: [{ name: 'website', status: 'PUBLISHED', detail: 'ok' }] },
  }, {
    update: { queued: true, item: { slug: '65-inch-samsung-edina' } },
    photos: { queued: true, item: { slug: '65-inch-samsung-edina' } },
  });
  const names = record.result.destinations.map((entry) => entry.name);
  assert.deepEqual(names, ['website', 'gbp', 'gbp-photos']);
});

test('GBP queue and pull API never drive Google or Reddit or encode a Photos skip', () => {
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
    assert.doesNotMatch(source, /skip_photos_if_pending_review/i, `${rel} encodes the old Photos skip`);
  }
});

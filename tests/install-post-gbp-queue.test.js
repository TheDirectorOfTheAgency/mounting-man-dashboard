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
  GBP_ITEM_LOCK_PREFIX,
  GBP_PENDING_INDEX_KEY,
  gbpItemKey,
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
  const setCalls = [];
  const evalCalls = [];
  return {
    values,
    sets,
    setCalls,
    evalCalls,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value, options = {}) {
      setCalls.push({ key, value, options });
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) { values.delete(key); return 1; },
    async eval(script, keys, args) {
      evalCalls.push({ script, keys, args });
      if (keys.length === 2) {
        const [itemKey, indexKey] = keys;
        const [value, member] = args;
        if (values.has(itemKey)) {
          if (!sets.has(indexKey)) sets.set(indexKey, new Set());
          sets.get(indexKey).add(member);
          return 0;
        }
        values.set(itemKey, value);
        if (!sets.has(indexKey)) sets.set(indexKey, new Set());
        sets.get(indexKey).add(member);
        return 1;
      }
      if (keys.length === 3) {
        const [lockKey, itemKey, indexKey] = keys;
        const [token, value, member, pending] = args;
        if (values.get(lockKey) !== token) return 0;
        values.set(itemKey, value);
        if (!sets.has(indexKey)) sets.set(indexKey, new Set());
        if (pending === '1') sets.get(indexKey).add(member);
        else sets.get(indexKey).delete(member);
        values.delete(lockKey);
        return 1;
      }
      const [key] = keys;
      const [token] = args;
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) { sets.get(key)?.delete(member); return 1; },
    async smembers(key) { return [...(sets.get(key) || [])]; },
  };
}

function completionProof(surface, overrides = {}) {
  return {
    account_verified: true,
    location_verified: true,
    surface_verified: true,
    caption_exact: surface === 'update',
    bound_image_preview_visible: surface === 'update',
    cta_verified: surface === 'update',
    matching_card: true,
    pending_review: false,
    gallery_confirmed: surface === 'photos',
    image_sha256: IMAGE.sha256,
    observed_at: new Date(NOW).toISOString(),
    worker_version: '1.0.0',
    artifact_id: 'abcdef1234567890',
    screenshot_sha256: 'b'.repeat(64),
    ...overrides,
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

function gbpRequest(method, { body, query, secret = GBP_SECRET } = {}) {
  return {
    method,
    headers: {
      authorization: secret && `Bearer ${secret}`,
    },
    body,
    query,
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

test('sanitize rejects a non-installation URL, Reddit, and unknown schemas', () => {
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
  assert.equal(sanitizeGbpItem({
    schemaVersion: 999,
    slug: '65-inch-samsung-edina',
    live_url: 'https://www.themountingman.com/installations/65-inch-samsung-edina',
    caption: 'unknown schema',
  }), null);
});

test('shouldEnqueueGbp skips an item that is already queued', () => {
  const item = gbpPayloadFromRecord({
    jobId: 'job_1',
    revision: 'b'.repeat(64),
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
  assert.equal(pending[0].image_sha256, IMAGE.sha256);
  assert.equal(pending[0].image_path, null);
  assert.equal(pending[0].jobId, record.jobId);
  assert.equal(pending[0].revision, record.revision);
  assert.equal(pending[0].schemaVersion, 2);
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

test('callback refuses to settle a published result until GBP intent is durable', async () => {
  const { store, record, dispatchId } = await publishedSetup();
  const callback = createRunnerCallbackHandler({
    store, gbpQueue: null, runnerSecret: RUNNER_SECRET, now: () => NOW,
  });
  const res = createResponse();
  await callback(signedCallback({
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: publishedResult(),
  }), res);

  assert.equal(res.statusCode, 503);
  const persisted = await store.loadRecord(record.jobId);
  assert.equal(persisted.result, null);
  assert.equal(persisted.lease.dispatchId, dispatchId);
});

test('enqueue atomically creates the item and pending-index membership', async () => {
  const kv = createFakeKv();
  const queue = createGbpQueue(kv);
  const item = gbpPayloadFromRecord({
    jobId: 'job_atomic', revision: 'c'.repeat(64), seed: SEED, image: IMAGE, result: publishedResult(),
  });
  const originalEval = kv.eval;
  kv.eval = async () => { throw new Error('atomic write unavailable'); };
  await assert.rejects(queue.enqueue(item), /atomic write unavailable/);
  assert.equal(kv.values.has(gbpItemKey(SEED.slug)), false);
  assert.deepEqual(await kv.smembers(GBP_PENDING_INDEX_KEY), []);
  kv.eval = originalEval;
  assert.equal((await queue.enqueue(item)).queued, true);
  assert.equal((await queue.listPending()).length, 1);
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

test('claim and concurrent per-surface completions use token-owned locks without losing data', async () => {
  const { kv, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });

  const [updateClaim, photosClaim] = await Promise.all([
    gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW }),
    gbpQueue.claim(SEED.slug, { surface: 'photos', workerId: 'm1-a', now: NOW }),
  ]);
  assert.equal(updateClaim.ok, true);
  assert.equal(photosClaim.ok, true);
  assert.notEqual(updateClaim.leaseToken, photosClaim.leaseToken);

  const [updateDone, photosDone] = await Promise.all([
    gbpQueue.complete(SEED.slug, {
      surface: 'update', status: 'posted', proof: completionProof('update'), leaseToken: updateClaim.leaseToken, now: NOW + 1,
    }),
    gbpQueue.complete(SEED.slug, {
      surface: 'photos', status: 'posted', proof: completionProof('photos'), leaseToken: photosClaim.leaseToken, now: NOW + 1,
    }),
  ]);
  assert.equal(updateDone.ok, true);
  assert.equal(photosDone.ok, true);
  const item = await gbpQueue.loadItem(SEED.slug);
  assert.equal(item.surfaces.update.status, 'posted');
  assert.equal(item.surfaces.photos.status, 'posted');
  assert.equal(item.status, 'posted');

  const lockSets = kv.setCalls.filter((call) => call.key.startsWith(GBP_ITEM_LOCK_PREFIX));
  assert.ok(lockSets.length >= 4);
  assert.ok(lockSets.every((call) => call.options.nx === true && Number.isInteger(call.options.px)));
  assert.ok(kv.evalCalls.length >= 4);
  assert.ok(kv.evalCalls.some((call) => call.keys.length === 3 && call.args.length === 5));
});

test('a stale lock owner cannot overwrite state after its fencing token is replaced', async () => {
  const { kv, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
  const originalGet = kv.get;
  let stoleLock = false;
  kv.get = async (key) => {
    const value = await originalGet(key);
    if (!stoleLock && key === gbpItemKey(SEED.slug)) {
      stoleLock = true;
      const lockKey = [...kv.values.keys()].find((candidate) => candidate.startsWith(GBP_ITEM_LOCK_PREFIX));
      kv.values.set(lockKey, 'new-owner-token');
    }
    return value;
  };

  const result = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'lock_lost' });
  assert.equal((await gbpQueue.loadItem(SEED.slug)).surfaces.update.status, 'pending');
});

test('a live lease blocks a second claim and an expired lease is reclaimed with retained attempt history', async () => {
  const { gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });

  const first = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW });
  await gbpQueue.complete(SEED.slug, {
    surface: 'update', status: 'retryable_failure', error: { reason_code: 'dialog_closed', retryable: true },
    leaseToken: first.leaseToken, now: NOW + 1,
  });
  const second = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW + 2 });
  assert.equal(second.item.surfaces.update.attempts, 2);
  assert.deepEqual(second.item.surfaces.update.lastError, { reason_code: 'dialog_closed', retryable: true });

  const blocked = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-b', now: NOW + 3 });
  assert.deepEqual(blocked, { ok: false, reason: 'lease_active' });

  const reclaimed = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-b', now: NOW + 5 * 60_000 + 3 });
  assert.equal(reclaimed.ok, true);
  assert.notEqual(reclaimed.leaseToken, second.leaseToken);
  assert.equal(reclaimed.item.surfaces.update.attempts, 3);
  assert.deepEqual(reclaimed.item.surfaces.update.lastError, { reason_code: 'dialog_closed', retryable: true });
});

test('completion rejects a missing, wrong, or expired lease token', async () => {
  const { gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
  const claim = await gbpQueue.claim(SEED.slug, { surface: 'photos', workerId: 'm1-a', now: NOW });
  const report = { surface: 'photos', status: 'posted', proof: completionProof('photos') };

  assert.equal((await gbpQueue.complete(SEED.slug, { ...report, now: NOW + 1 })).reason, 'lease_token_required');
  assert.equal((await gbpQueue.complete(SEED.slug, { ...report, leaseToken: 'wrong', now: NOW + 1 })).reason, 'lease_token_mismatch');
  assert.equal((await gbpQueue.complete(SEED.slug, {
    ...report, leaseToken: claim.leaseToken, now: NOW + 5 * 60_000 + 1,
  })).reason, 'lease_expired');
  assert.equal((await gbpQueue.loadItem(SEED.slug)).surfaces.photos.status, 'claimed');
});

test('completion validates surface-specific outcomes and posted proof strictly', async () => {
  const { gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
  const update = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW });
  const photos = await gbpQueue.claim(SEED.slug, { surface: 'photos', workerId: 'm1-a', now: NOW });

  for (const status of ['pending', 'claimed', 'unknown']) {
    assert.equal((await gbpQueue.complete(SEED.slug, {
      surface: 'update', status, leaseToken: update.leaseToken, now: NOW + 1,
    })).reason, 'invalid_status');
  }
  assert.equal((await gbpQueue.complete(SEED.slug, {
    surface: 'photos', status: 'pending_review', proof: { pending_review: true }, leaseToken: photos.leaseToken, now: NOW + 1,
  })).reason, 'invalid_status');
  assert.equal((await gbpQueue.complete(SEED.slug, {
    surface: 'update', status: 'posted', leaseToken: update.leaseToken, now: NOW + 1,
  })).reason, 'proof_required');
  assert.equal((await gbpQueue.complete(SEED.slug, {
    surface: 'photos', status: 'posted', leaseToken: photos.leaseToken, now: NOW + 1,
  })).reason, 'proof_required');
  for (const [surfaceName, claim, proof] of [
    ['update', update, { matching_card: true }],
    ['photos', photos, { gallery_confirmed: false }],
  ]) {
    assert.equal((await gbpQueue.complete(SEED.slug, {
      surface: surfaceName, status: 'posted', proof, leaseToken: claim.leaseToken, now: NOW + 1,
    })).reason, 'invalid_proof');
  }
});

test('Update and Photos accept exactly their documented completion outcomes', async () => {
  const allowed = {
    update: ['posted', 'pending_review', 'retryable_failure', 'indeterminate'],
    photos: ['posted', 'retryable_failure', 'indeterminate'],
  };
  for (const [surface, statuses] of Object.entries(allowed)) {
    for (const status of statuses) {
      const { gbpQueue, record } = await publishedSetup();
      await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
      const claim = await gbpQueue.claim(SEED.slug, { surface, workerId: 'm1-a', now: NOW });
      const result = await gbpQueue.complete(SEED.slug, {
        surface,
        status,
        proof: status === 'posted' || status === 'pending_review'
          ? completionProof(surface, status === 'pending_review' ? { pending_review: true } : {})
          : {},
        error: status.endsWith('failure') || status === 'indeterminate'
          ? { reason_code: 'reconcile_required', retryable: status.endsWith('failure') }
          : null,
        leaseToken: claim.leaseToken,
        now: NOW + 1,
      });
      assert.equal(result.ok, true, `${surface} ${status}`);
      assert.equal(result.item.surfaces[surface].status, status);
    }
  }
});

test('pending index remains until both surfaces complete and listPending removes stale members', async () => {
  const { kv, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
  const update = await gbpQueue.claim(SEED.slug, { surface: 'update', workerId: 'm1-a', now: NOW });
  await gbpQueue.complete(SEED.slug, {
    surface: 'update', status: 'pending_review', proof: completionProof('update', { pending_review: true }), leaseToken: update.leaseToken, now: NOW + 1,
  });
  assert.ok(kv.sets.get(GBP_PENDING_INDEX_KEY).has(SEED.slug));

  const photos = await gbpQueue.claim(SEED.slug, { surface: 'photos', workerId: 'm1-a', now: NOW + 2 });
  await gbpQueue.complete(SEED.slug, {
    surface: 'photos', status: 'posted', proof: completionProof('photos'), leaseToken: photos.leaseToken, now: NOW + 3,
  });
  assert.equal(kv.sets.get(GBP_PENDING_INDEX_KEY).has(SEED.slug), false);

  await kv.sadd(GBP_PENDING_INDEX_KEY, SEED.slug);
  await kv.sadd(GBP_PENDING_INDEX_KEY, 'missing-item');
  assert.deepEqual(await gbpQueue.listPending(), []);
  assert.deepEqual(await kv.smembers(GBP_PENDING_INDEX_KEY), []);
});

test('heartbeat stores a readable worker build identity and no caller-supplied data', async () => {
  const kv = createFakeKv();
  const queue = createGbpQueue(kv);
  const heartbeat = await queue.heartbeat({
    workerId: 'm1-primary', version: '2026.08.30', buildSha: 'a'.repeat(40), now: NOW,
    secret: 'must-not-store', customer: { phone: '555-0100' },
  });
  assert.deepEqual(heartbeat, {
    ok: true,
    heartbeat: {
      workerId: 'm1-primary', version: '2026.08.30', buildSha: 'a'.repeat(40), seenAt: new Date(NOW).toISOString(),
    },
  });
  const storedHeartbeat = [...kv.values.entries()].find(([key]) => key.includes(':heartbeat:'));
  assert.ok(storedHeartbeat);
  assert.deepEqual(Object.keys(JSON.parse(storedHeartbeat[1])).sort(), ['buildSha', 'seenAt', 'version', 'workerId']);
  assert.deepEqual(await queue.getHeartbeat('m1-primary'), heartbeat);

  const handler = createGbpHandler({ queue, workerSecret: GBP_SECRET });
  const res = createResponse();
  await handler(gbpRequest('POST', {
    body: {
      action: 'heartbeat', workerId: 'm1-primary', version: '2026.08.30', buildSha: 'a'.repeat(40), secret: 'nope',
    },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.heartbeat).sort(), ['buildSha', 'seenAt', 'version', 'workerId']);

  const read = createResponse();
  await handler(gbpRequest('GET', { query: { heartbeat: 'm1-primary' } }), read);
  assert.deepEqual(read.body, res.body);
});

test('legacy pending rows are quarantined instead of poisoning the schema-v2 pull', async () => {
  const kv = createFakeKv();
  const queue = createGbpQueue(kv);
  const legacySlug = 'legacy-pending';
  kv.values.set(gbpItemKey(legacySlug), JSON.stringify({
    slug: legacySlug,
    caption: 'Legacy item',
    live_url: 'https://www.themountingman.com/installations/legacy-pending',
    image_url: IMAGE.hostedUrl,
    status: 'pending',
    queuedAt: new Date(NOW).toISOString(),
  }));
  await kv.sadd(GBP_PENDING_INDEX_KEY, legacySlug);

  assert.deepEqual(await queue.listPending(), []);
  assert.equal((await kv.smembers(GBP_PENDING_INDEX_KEY)).includes(legacySlug), false);
});

test('new-schema API completion cannot use the legacy tokenless Update path', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });
  const res = createResponse();
  await gbp(gbpRequest('POST', { body: { action: 'complete', slug: SEED.slug } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'surface_required');
  assert.equal((await gbpQueue.loadItem(SEED.slug)).surfaces.update.status, 'pending');
});

test('API claim returns a lease token and complete requires that exact token', async () => {
  const { gbp, gbpQueue, record } = await publishedSetup();
  await enqueueGbpAfterPublish({ queue: gbpQueue, record: { ...record, result: publishedResult() } });

  const claimed = createResponse();
  await gbp(gbpRequest('POST', {
    body: { action: 'claim', slug: SEED.slug, surface: 'update', workerId: 'm1-primary' },
  }), claimed);
  assert.equal(claimed.statusCode, 200);
  assert.ok(claimed.body.leaseToken);
  assert.equal(claimed.body.item.surfaces.update.status, 'claimed');
  assert.equal(claimed.body.item.surfaces.update.lease.workerId, 'm1-primary');
  assert.equal(claimed.body.item.surfaces.update.lease.token, undefined);

  const completed = createResponse();
  await gbp(gbpRequest('POST', {
    body: {
      action: 'complete', slug: SEED.slug, surface: 'update', status: 'pending_review',
      proof: { ...completionProof('update', { pending_review: true }), customer_phone: '555-0100' },
      leaseToken: claimed.body.leaseToken,
    },
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.item.surfaces.update.status, 'pending_review');
  assert.deepEqual(
    completed.body.item.surfaces.update.proof,
    completionProof('update', { pending_review: true }),
  );
  assert.equal(completed.body.item.surfaces.update.proof.customer_phone, undefined);
  assert.equal(completed.body.item.surfaces.photos.status, 'pending');
});

test('legacy tokenless complete remains Update-only and historical posted rows are cleaned without invented receipts', async () => {
  const kv = createFakeKv();
  const queue = createGbpQueue(kv);
  const legacy = {
    slug: SEED.slug,
    caption: 'Legacy item',
    live_url: publishedResult().liveUrl,
    image_url: IMAGE.hostedUrl,
    status: 'pending',
    queuedAt: new Date(NOW).toISOString(),
  };
  kv.values.set(gbpItemKey(SEED.slug), JSON.stringify(legacy));
  await kv.sadd(GBP_PENDING_INDEX_KEY, SEED.slug);

  const result = await queue.complete(SEED.slug, {});
  assert.equal(result.ok, true);
  assert.equal(result.item.surfaces.update.status, 'posted');
  assert.equal(result.item.surfaces.update.legacy, true);
  assert.equal(result.item.surfaces.photos.status, 'pending');
  assert.equal(gbpSurfacesComplete(result.item.surfaces), false);

  const historicalSlug = 'historical-posted';
  kv.values.set(gbpItemKey(historicalSlug), JSON.stringify({ ...legacy, slug: historicalSlug, status: 'posted' }));
  await kv.sadd(GBP_PENDING_INDEX_KEY, historicalSlug);
  await queue.listPending();
  assert.equal(kv.sets.get(GBP_PENDING_INDEX_KEY).has(historicalSlug), false);
  const historical = await queue.loadItem(historicalSlug);
  assert.equal(historical.surfaces, undefined);
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

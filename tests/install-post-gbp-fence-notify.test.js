import assert from 'node:assert/strict';
import test from 'node:test';

import { approveAndDispatchInstallPost } from '../lib/install-post-auto-publish.mjs';
import { signRunnerRequest } from '../lib/install-post-dispatch.mjs';
import {
  GBP_FENCE_BOOK_URL_KIND,
  GBP_FENCE_CAPTION_KIND,
  buildGbpFenceNotifyBodies,
  buildGbpFenceNotifyHeaders,
  deliverGbpFenceToOwner,
  hasGbpFenceBearerAuthorization,
} from '../lib/install-post-gbp-fence-notify.mjs';
import { INSTALL_POST_STATES, transitionRecord } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createRunnerCallbackHandler } from '../pages/api/install-post/runner/callback.js';
import { createResponse } from './webhook-test-helpers.js';

const CALLBACK_PATH = '/api/install-post/runner/callback';

const LIVE_URL = 'https://www.themountingman.com/installations/65-inch-samsung-woodbury';
const NOTIFY_URL = 'https://owner.example/gbp-fence';
const NOTIFY_KEY = 'gbp-fence-sender-key';

const SEED = {
  city: 'Woodbury',
  'tv-size': '65"',
  'tv-brand': 'Samsung Frame',
  'gallery-style': true,
  'wall-surface': 'Tile',
  price: '$425',
  'street-name': 'Gable Ln',
  'cable-management': 'Recessed Power Bridge',
  'seed-index': 1,
  'seed-count': 1,
};

test('GBP fence bodies are caption then Book URL with no hashtags or caption URL', () => {
  const bodies = buildGbpFenceNotifyBodies({ seed: SEED, liveUrl: LIVE_URL });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].kind, GBP_FENCE_CAPTION_KIND);
  assert.equal(bodies[1].kind, GBP_FENCE_BOOK_URL_KIND);
  assert.match(bodies[0].body, /^Woodbury Samsung Frame 65" on tile — Gable Ln\./);
  assert.doesNotMatch(bodies[0].body, /#\w/);
  assert.doesNotMatch(bodies[0].body, /https?:\/\//i);
  assert.doesNotMatch(bodies[0].body, /themountingman\.com/i);
  assert.equal(bodies[1].body, LIVE_URL);
  assert.doesNotMatch(JSON.stringify(bodies), /reddit/i);
});

test('GBP fence notify headers mirror Kronkite Bearer + sender secret', () => {
  const headers = buildGbpFenceNotifyHeaders(`  ${NOTIFY_KEY}  `);
  assert.equal(hasGbpFenceBearerAuthorization(headers), true);
  assert.equal(headers.Authorization, `Bearer ${NOTIFY_KEY}`);
  assert.equal(headers['x-webhook-secret'], NOTIFY_KEY);
  assert.equal(buildGbpFenceNotifyHeaders(''), null);
});

test('deliverGbpFenceToOwner posts two fence bodies after a live HTTP 200 page', async () => {
  const posts = [];
  const result = await deliverGbpFenceToOwner({
    record: {
      state: INSTALL_POST_STATES.PUBLISHED,
      seed: SEED,
      result: { liveUrl: LIVE_URL, publicStatus: 200, slug: '65-inch-samsung-woodbury' },
    },
    url: NOTIFY_URL,
    key: NOTIFY_KEY,
    httpClient: {
      async post(url, body, config) {
        posts.push({ url, body, headers: config?.headers || {} });
        return { data: { ok: true } };
      },
    },
  });
  assert.equal(result.forwarded, true);
  assert.deepEqual(result.sent, [GBP_FENCE_CAPTION_KIND, GBP_FENCE_BOOK_URL_KIND]);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, NOTIFY_URL);
  assert.equal(posts[0].headers.Authorization, `Bearer ${NOTIFY_KEY}`);
  assert.equal(posts[0].body.kind, GBP_FENCE_CAPTION_KIND);
  assert.equal(posts[1].body.kind, GBP_FENCE_BOOK_URL_KIND);
  assert.equal(posts[1].body.body, LIVE_URL);
  assert.doesNotMatch(posts[0].body.body, /https?:\/\//);
  assert.equal(JSON.stringify(posts).includes('Jane'), false);
  assert.equal(JSON.stringify(posts).includes('555'), false);
});

test('deliverGbpFenceToOwner skips when the page is not a verified 200', async () => {
  const posts = [];
  const result = await deliverGbpFenceToOwner({
    record: {
      state: INSTALL_POST_STATES.INDETERMINATE,
      seed: SEED,
      result: { liveUrl: LIVE_URL, publicStatus: 0 },
    },
    url: NOTIFY_URL,
    key: NOTIFY_KEY,
    httpClient: {
      async post(url, body) {
        posts.push({ url, body });
        return { data: {} };
      },
    },
  });
  assert.equal(result.skipped, 'page_not_live');
  assert.equal(posts.length, 0);
});

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

test('runner callback success delivers GBP fence without a Woodward wake', async () => {
  const RUNNER_SECRET = 'test-runner-secret';
  const NOW = 1_760_000_000_000;
  const IMAGE = {
    sha256: 'a'.repeat(64),
    bytes: 320_000,
    contentType: 'image/webp',
    hostedUrl: 'https://cdn.example.com/frame.webp',
  };
  const store = createInstallPostStore(createFakeKv());
  const [staged] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs: { orderId: 'ORDER-1', paymentId: 'PAY-1' },
    source: 'square-webhook',
    stagedAt: '2026-09-20T15:00:00.000Z',
  });
  const record = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
  await store.saveRecord(record);
  const dispatcher = {
    dispatches: [],
    async dispatch(payload) {
      this.dispatches.push(payload);
      return { dispatchId: payload.dispatchId };
    },
  };
  const approved = await approveAndDispatchInstallPost({
    store,
    jobId: record.jobId,
    revision: record.revision,
    dispatcher,
    now: () => NOW,
  });
  assert.equal(approved.ok, true);
  const dispatchId = approved.dispatchId;
  const fencePosts = [];
  const callback = createRunnerCallbackHandler({
    store,
    runnerSecret: RUNNER_SECRET,
    gbpQueue: { async enqueue(item) { return { queued: true, reason: 'queued', item }; } },
    gbpFenceNotify: async ({ record: published }) => deliverGbpFenceToOwner({
      record: published,
      url: NOTIFY_URL,
      key: NOTIFY_KEY,
      httpClient: {
        async post(url, body, config) {
          fencePosts.push({ url, body, headers: config?.headers || {} });
          return { data: {} };
        },
      },
    }),
    now: () => NOW,
  });

  const body = {
    jobId: record.jobId,
    revision: record.revision,
    dispatchId,
    result: {
      status: INSTALL_POST_STATES.PUBLISHED,
      liveUrl: LIVE_URL,
      publicStatus: 200,
      slug: '65-inch-samsung-woodbury',
    },
  };
  const timestamp = Math.floor(NOW / 1000);
  const res = createResponse();
  await callback({
    method: 'POST',
    url: CALLBACK_PATH,
    headers: {
      'x-install-post-signature': signRunnerRequest({
        secret: RUNNER_SECRET,
        method: 'POST',
        path: CALLBACK_PATH,
        body,
        timestamp,
      }),
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(fencePosts.length, 2);
  assert.equal(fencePosts[0].body.kind, GBP_FENCE_CAPTION_KIND);
  assert.equal(fencePosts[1].body.body, LIVE_URL);
  assert.doesNotMatch(JSON.stringify(fencePosts), /kronkite|woodward|reddit/i);
});

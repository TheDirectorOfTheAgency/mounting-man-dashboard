import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTALL_POST_STATES, signOperatorSession } from '../lib/install-post-queue.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createMobileJobHandler } from '../pages/api/install-post/mobile.js';
import { MAX_UPLOAD_BYTES, createUploadHandler } from '../pages/api/install-post/upload.js';
import { createResponse } from './webhook-test-helpers.js';

const SECRET = 'test-session-secret';
const HOST = 'mounting-man-dashboard.vercel.app';
const NOW = 1_760_000_000_000;

const SEEDS = [
  {
    city: 'Edina',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Stone',
    price: '$450',
    'street-name': '4821 Elm Street',
    'seed-index': 1,
    'seed-count': 2,
  },
  {
    city: 'Edina',
    'tv-size': '55"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Drywall',
    price: '$150',
    'street-name': '4821 Elm Street',
    'seed-index': 2,
    'seed-count': 2,
  },
];

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

function createFakeWebflow() {
  const calls = [];
  return {
    calls,
    async createSignedUpload({ fileName, fileHash }) {
      calls.push({ fileName, fileHash });
      return {
        assetId: `asset-${calls.length}`,
        hostedUrl: `https://cdn.example.com/${fileName}`,
        uploadUrl: 'https://s3.example.com/upload',
        uploadDetails: { key: `assets/${fileName}`, 'X-Amz-Signature': 'sig' },
      };
    },
  };
}

async function setup() {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const records = await store.stageJobRecords({
    seeds: SEEDS,
    sourceRefs: { orderId: 'ORDER-ABC-123', paymentId: 'PAY-XYZ-789' },
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });
  const webflow = createFakeWebflow();
  return {
    store,
    webflow,
    records,
    sessions: records.map((r) => signOperatorSession({
      jobId: r.jobId, secret: SECRET, expiresAt: NOW + 3600_000,
    })),
    mobile: createMobileJobHandler({ store, sessionSecret: SECRET, now: () => NOW }),
    upload: createUploadHandler({ store, sessionSecret: SECRET, webflow, now: () => NOW }),
  };
}

/** The session cookie is the whole credential; the URL carries nothing. */
function request({ method = 'GET', session, body } = {}) {
  const headers = { host: HOST, origin: `https://${HOST}` };
  if (session) headers.cookie = `${SESSION_COOKIE_NAME}=${session}`;
  return { method, headers, query: {}, body };
}

const IMAGE = {
  sha256: 'a'.repeat(64),
  // Webflow's asset API signs an upload against the file's MD5, so the browser
  // reports both digests and the API signs only what it was given.
  md5: 'd'.repeat(32),
  bytes: 320_000,
  contentType: 'image/webp',
};

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

test('GET rejects a missing, malformed, tampered, or expired session cookie', async () => {
  const { mobile, sessions } = await setup();

  for (const [session, expected] of [
    [undefined, 'no_session'],
    ['garbage', 'malformed'],
    [`${sessions[0]}x`, 'bad_signature'],
  ]) {
    const res = createResponse();
    await mobile(request({ session }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.reason, expected);
  }

  const expiredHandler = createMobileJobHandler({
    store: (await setup()).store,
    sessionSecret: SECRET,
    now: () => NOW + 10_000_000,
  });
  const res = createResponse();
  await expiredHandler(request({ session: sessions[0] }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.reason, 'expired');
});

test('GET returns only safe card state for the exact bound job', async () => {
  const { mobile, sessions, records } = await setup();
  const res = createResponse();
  await mobile(request({ session: sessions[1] }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.jobId, records[1].jobId);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.AWAITING_PHOTO);
  assert.equal(res.body.job.seed['tv-size'], '55"');
  assert.ok(res.body.job.label.includes('55"'));
  assert.ok(res.body.job.label.includes('TV 2 of 2'));

  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['ORDER-ABC-123', 'PAY-XYZ-789', '4821', SECRET]) {
    assert.ok(!serialized.includes(forbidden), `response leaked ${forbidden}`);
  }
});

test('GET on an unknown job reports not found instead of an empty card', async () => {
  const { mobile } = await setup();
  const orphan = signOperatorSession({ jobId: 'job_deadbeefdeadbeef', secret: SECRET, expiresAt: NOW + 3600_000 });
  const res = createResponse();
  await mobile(request({ session: orphan }), res);
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Safe corrections
// ---------------------------------------------------------------------------

test('PATCH applies a safe correction and returns a new revision', async () => {
  const { mobile, sessions, records } = await setup();
  const res = createResponse();
  await mobile(request({
    method: 'PATCH',
    session: sessions[0],
    body: { revision: records[0].revision, patch: { 'tv-size': '75"', 'wall-surface': 'Tile' } },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.seed['tv-size'], '75"');
  assert.equal(res.body.job.seed['wall-surface'], 'Tile');
  assert.notEqual(res.body.job.revision, records[0].revision);
});

test('PATCH refuses fields outside the correction allowlist', async () => {
  const { mobile, sessions, records } = await setup();
  for (const patch of [
    { 'source-order-id': 'ORDER-999' },
    { customerName: 'Jane Doe' },
    { 'seed-count': 9 },
  ]) {
    const res = createResponse();
    await mobile(request({ method: 'PATCH', session: sessions[0], body: { revision: records[0].revision, patch } }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(res.body.error, 'field_not_correctable');
  }
});

test('PATCH with a stale revision is rejected rather than overwriting', async () => {
  const { mobile, sessions, records } = await setup();
  const first = createResponse();
  await mobile(request({
    method: 'PATCH', session: sessions[0], body: { revision: records[0].revision, patch: { city: 'Hopkins' } },
  }), first);
  assert.equal(first.statusCode, 200);

  const second = createResponse();
  await mobile(request({
    method: 'PATCH', session: sessions[0], body: { revision: records[0].revision, patch: { city: 'Wayzata' } },
  }), second);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, 'stale_revision');
});

// ---------------------------------------------------------------------------
// Photo upload binding
// ---------------------------------------------------------------------------

test('upload init validates content type, size, and digest before signing', async () => {
  const { upload, sessions, records } = await setup();
  const revision = records[0].revision;

  const cases = [
    [{ ...IMAGE, contentType: 'image/heic' }, 'unsupported_content_type'],
    [{ ...IMAGE, contentType: 'application/pdf' }, 'unsupported_content_type'],
    [{ ...IMAGE, bytes: MAX_UPLOAD_BYTES + 1 }, 'file_too_large'],
    [{ ...IMAGE, bytes: 0 }, 'file_too_large'],
    [{ ...IMAGE, sha256: 'nothex' }, 'invalid_digest'],
    [{ ...IMAGE, md5: 'nothex' }, 'invalid_digest'],
  ];

  for (const [image, expected] of cases) {
    const res = createResponse();
    await upload(request({ method: 'POST', session: sessions[0], body: { action: 'init', revision, ...image } }), res);
    assert.equal(res.statusCode, 400, expected);
    assert.equal(res.body.error, expected);
  }
});

test('upload init refuses a stale revision', async () => {
  const { upload, sessions } = await setup();
  const res = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: 'stale', ...IMAGE },
  }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'stale_revision');
});

test('a full init/commit cycle binds the photo to that exact job', async () => {
  const { upload, mobile, sessions, records, webflow } = await setup();

  const init = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: records[0].revision, ...IMAGE },
  }), init);
  assert.equal(init.statusCode, 200);
  assert.equal(init.body.uploadUrl, 'https://s3.example.com/upload');
  assert.equal(webflow.calls[0].fileHash.length, 32);

  const commit = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[0],
    body: { action: 'commit', revision: records[0].revision, uploadId: init.body.uploadId, sha256: IMAGE.sha256 },
  }), commit);
  assert.equal(commit.statusCode, 200);
  assert.equal(commit.body.job.state, INSTALL_POST_STATES.READY);
  assert.equal(commit.body.job.image.sha256, IMAGE.sha256);
  assert.notEqual(commit.body.job.revision, records[0].revision);

  // The other card is untouched — no cross-binding.
  const other = createResponse();
  await mobile(request({ session: sessions[1] }), other);
  assert.equal(other.body.job.state, INSTALL_POST_STATES.AWAITING_PHOTO);
  assert.equal(other.body.job.image, null);
});

test('an upload session cannot be committed against a different job', async () => {
  const { upload, sessions, records } = await setup();

  const init = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: records[0].revision, ...IMAGE },
  }), init);

  const stolen = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[1],
    body: { action: 'commit', revision: records[1].revision, uploadId: init.body.uploadId, sha256: IMAGE.sha256 },
  }), stolen);
  assert.equal(stolen.statusCode, 409);
  assert.equal(stolen.body.error, 'upload_not_found');
});

test('commit refuses a digest that differs from the signed session', async () => {
  const { upload, sessions, records } = await setup();
  const init = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: records[0].revision, ...IMAGE },
  }), init);

  const res = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[0],
    body: { action: 'commit', revision: records[0].revision, uploadId: init.body.uploadId, sha256: 'b'.repeat(64) },
  }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'digest_mismatch');
});

test('commit refuses when the seed changed after the upload was signed', async () => {
  const { upload, mobile, sessions, records } = await setup();
  const init = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: records[0].revision, ...IMAGE },
  }), init);

  const patched = createResponse();
  await mobile(request({
    method: 'PATCH', session: sessions[0], body: { revision: records[0].revision, patch: { city: 'Hopkins' } },
  }), patched);
  assert.equal(patched.statusCode, 200);

  const res = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[0],
    body: { action: 'commit', revision: records[0].revision, uploadId: init.body.uploadId, sha256: IMAGE.sha256 },
  }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'stale_revision');
});

test('reverse-order photo uploads still land on their own card', async () => {
  const { upload, mobile, sessions, records } = await setup();
  const second = { ...IMAGE, sha256: 'b'.repeat(64) };

  // Photo for TV 2 is uploaded first, then the photo for TV 1.
  const initB = createResponse();
  await upload(request({
    method: 'POST', session: sessions[1], body: { action: 'init', revision: records[1].revision, ...second },
  }), initB);
  const commitB = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[1],
    body: { action: 'commit', revision: records[1].revision, uploadId: initB.body.uploadId, sha256: second.sha256 },
  }), commitB);

  const initA = createResponse();
  await upload(request({
    method: 'POST', session: sessions[0], body: { action: 'init', revision: records[0].revision, ...IMAGE },
  }), initA);
  const commitA = createResponse();
  await upload(request({
    method: 'POST',
    session: sessions[0],
    body: { action: 'commit', revision: records[0].revision, uploadId: initA.body.uploadId, sha256: IMAGE.sha256 },
  }), commitA);

  const cardA = createResponse();
  await mobile(request({ session: sessions[0] }), cardA);
  const cardB = createResponse();
  await mobile(request({ session: sessions[1] }), cardB);

  assert.equal(cardA.body.job.image.sha256, IMAGE.sha256);
  assert.equal(cardA.body.job.seed['tv-size'], '65"');
  assert.equal(cardB.body.job.image.sha256, second.sha256);
  assert.equal(cardB.body.job.seed['tv-size'], '55"');
});

test('unsupported methods are rejected', async () => {
  const { mobile, upload, sessions } = await setup();
  const a = createResponse();
  await mobile(request({ method: 'DELETE', session: sessions[0] }), a);
  assert.equal(a.statusCode, 405);

  const b = createResponse();
  await upload(request({ method: 'GET', session: sessions[0] }), b);
  assert.equal(b.statusCode, 405);
});

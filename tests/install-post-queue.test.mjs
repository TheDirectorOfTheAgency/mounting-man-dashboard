import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALL_POST_STATES,
  SAFE_SEED_FIELDS,
  canonicalRevision,
  cardLabel,
  safeSeed,
  sanitizePublishResult,
  signJobCapability,
  transitionRecord,
  verifyJobCapability,
} from '../lib/install-post-queue.mjs';

const SECRET = 'test-install-post-secret';

function baseSeed(overrides = {}) {
  return {
    city: 'Edina',
    state: 'MN',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Stone',
    'fireplace-type': 'Stone Fireplace',
    'mount-type': 'MantelMount MM540',
    price: '$450',
    'performed-by': 'Michael',
    'street-name': 'Elm Street',
    'seed-index': 1,
    'seed-count': 2,
    ...overrides,
  };
}

function baseRecord(overrides = {}) {
  const seed = overrides.seed || baseSeed();
  return {
    jobId: 'job_aaaa1111',
    createdAt: '2026-08-12T15:00:00.000Z',
    state: INSTALL_POST_STATES.AWAITING_PHOTO,
    seed,
    image: null,
    revision: canonicalRevision({ seed, image: null }),
    approval: null,
    lease: null,
    result: null,
    ...overrides,
  };
}

const IMAGE_A = { sha256: 'a'.repeat(64), bytes: 240000, contentType: 'image/webp' };
const IMAGE_B = { sha256: 'b'.repeat(64), bytes: 250000, contentType: 'image/webp' };

// ---------------------------------------------------------------------------
// Field allowlisting
// ---------------------------------------------------------------------------

test('safeSeed keeps only allowlisted installation facts', () => {
  const result = safeSeed({
    ...baseSeed(),
    customerName: 'Jane Doe',
    'customer-email': 'jane@example.com',
    'source-order-id': 'ORD123',
    'source-payment-id': 'PAY456',
    'source-invoice-id': 'INV789',
    'address-line-1': '4821 Elm Street',
    phone: '+16125551234',
  });

  for (const key of Object.keys(result)) {
    assert.ok(SAFE_SEED_FIELDS.includes(key), `unexpected field leaked: ${key}`);
  }
  assert.equal(result.customerName, undefined);
  assert.equal(result['source-order-id'], undefined);
  assert.equal(result['source-payment-id'], undefined);
  assert.equal(result['source-invoice-id'], undefined);
  assert.equal(result.phone, undefined);
  assert.equal(result.city, 'Edina');
  assert.equal(result['tv-size'], '65"');
});

test('safeSeed strips house numbers and inline contact details', () => {
  const result = safeSeed({
    city: 'Edina',
    'street-name': '4821 Elm Street Apt 3',
    'local-reference': '4821 Elm Street',
    'job-notes': 'Call jane@example.com or 612-555-1234 before arrival',
  });

  assert.equal(result['street-name'], 'Elm Street');
  assert.equal(result['local-reference'], 'Elm Street');
  assert.ok(!result['job-notes'].includes('jane@example.com'));
  assert.ok(!result['job-notes'].includes('612-555-1234'));
});

// ---------------------------------------------------------------------------
// Recognizable card labels
// ---------------------------------------------------------------------------

test('cardLabel is recognizable and distinguishes two similar jobs', () => {
  const first = cardLabel(baseRecord());
  const second = cardLabel(baseRecord({
    jobId: 'job_bbbb2222',
    seed: baseSeed({ 'tv-size': '55"', 'seed-index': 2 }),
  }));

  assert.ok(first.includes('65"'), first);
  assert.ok(first.includes('Samsung'), first);
  assert.ok(first.includes('Edina'), first);
  assert.ok(first.includes('Elm Street'), first);
  assert.ok(first.includes('$450'), first);
  assert.ok(first.includes('MantelMount MM540'), first);
  assert.ok(first.includes('TV 1 of 2'), first);
  assert.notEqual(first, second);
  assert.ok(second.includes('TV 2 of 2'), second);
});

test('cardLabel never exposes customer identity', () => {
  const label = cardLabel(baseRecord({
    seed: baseSeed({ 'job-notes': 'Jane Doe jane@example.com' }),
  }));
  assert.ok(!label.includes('jane@example.com'), label);
});

// ---------------------------------------------------------------------------
// Deterministic revision hashing
// ---------------------------------------------------------------------------

test('canonicalRevision is stable across key order and sensitive to content', () => {
  const seed = baseSeed();
  const reordered = Object.fromEntries(Object.entries(seed).reverse());

  const a = canonicalRevision({ seed, image: IMAGE_A });
  const b = canonicalRevision({ seed: reordered, image: { ...IMAGE_A } });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);

  assert.notEqual(a, canonicalRevision({ seed, image: null }));
  assert.notEqual(a, canonicalRevision({ seed, image: IMAGE_B }));
  assert.notEqual(a, canonicalRevision({ seed: baseSeed({ 'tv-size': '75"' }), image: IMAGE_A }));
});

test('canonicalRevision ignores fields outside the safe allowlist', () => {
  const seed = baseSeed();
  const withNoise = { ...seed, customerName: 'Jane Doe', 'source-order-id': 'ORD123' };
  assert.equal(
    canonicalRevision({ seed, image: IMAGE_A }),
    canonicalRevision({ seed: withNoise, image: IMAGE_A }),
  );
});

// ---------------------------------------------------------------------------
// Signed capability tokens
// ---------------------------------------------------------------------------

test('signJobCapability round-trips and binds the exact job id', () => {
  const token = signJobCapability({ jobId: 'job_aaaa1111', secret: SECRET, issuedAt: 1000, ttlSeconds: 600 });
  const verified = verifyJobCapability(token, { secret: SECRET, now: 1200 });
  assert.equal(verified.ok, true);
  assert.equal(verified.jobId, 'job_aaaa1111');
});

test('verifyJobCapability rejects tampering, wrong secret, expiry, and junk', () => {
  const token = signJobCapability({ jobId: 'job_aaaa1111', secret: SECRET, issuedAt: 1000, ttlSeconds: 600 });

  const [version, payload, signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ jobId: 'job_bbbb2222', iat: 1000, exp: 1600 }),
  ).toString('base64url');
  const forged = [version, forgedPayload, signature].join('.');

  assert.equal(verifyJobCapability(forged, { secret: SECRET, now: 1200 }).ok, false);
  assert.equal(verifyJobCapability(forged, { secret: SECRET, now: 1200 }).reason, 'bad_signature');
  assert.equal(verifyJobCapability(token, { secret: 'other-secret', now: 1200 }).reason, 'bad_signature');
  // `now` and `exp` are both epoch milliseconds, so a 600 second token is only
  // spent 600_000 ms after it was issued.
  assert.equal(verifyJobCapability(token, { secret: SECRET, now: 1000 + 599_000 }).ok, true);
  assert.equal(verifyJobCapability(token, { secret: SECRET, now: 1000 + 600_001 }).reason, 'expired');
  assert.equal(verifyJobCapability('not-a-token', { secret: SECRET, now: 1200 }).reason, 'malformed');
  assert.equal(verifyJobCapability(token, { secret: '', now: 1200 }).reason, 'unconfigured');
});

// ---------------------------------------------------------------------------
// Workflow transitions, approval invalidation, publish lease
// ---------------------------------------------------------------------------

test('attaching a photo moves the job to READY and rebinds the revision', () => {
  const start = baseRecord();
  const { ok, record } = transitionRecord(start, { type: 'photo', image: IMAGE_A, at: '2026-08-12T15:05:00.000Z' });

  assert.equal(ok, true);
  assert.equal(record.state, INSTALL_POST_STATES.READY);
  assert.equal(record.image.sha256, IMAGE_A.sha256);
  assert.equal(record.image.bytes, IMAGE_A.bytes);
  assert.equal(record.image.contentType, IMAGE_A.contentType);
  assert.equal(record.image.uploadedAt, '2026-08-12T15:05:00.000Z');
  assert.equal(record.revision, canonicalRevision({ seed: start.seed, image: IMAGE_A }));
  assert.equal(record.approval, null);
});

test('a safe correction creates a new revision and invalidates approval', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const approved = transitionRecord(withPhoto, {
    type: 'approve',
    revision: withPhoto.revision,
    dispatchId: 'dispatch-1',
    at: '2026-08-12T15:10:00.000Z',
  }).record;
  assert.equal(approved.state, INSTALL_POST_STATES.PUBLISHING);

  const failed = transitionRecord(approved, {
    type: 'result',
    result: { status: 'RETRYABLE_FAILURE', message: 'timeout' },
  }).record;

  const corrected = transitionRecord(failed, { type: 'correct', patch: { 'tv-size': '75"' } });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.record.seed['tv-size'], '75"');
  assert.equal(corrected.record.approval, null);
  assert.equal(corrected.record.lease, null);
  assert.notEqual(corrected.record.revision, approved.revision);
  assert.equal(corrected.record.state, INSTALL_POST_STATES.READY);
});

test('corrections are limited to the safe correction allowlist', () => {
  const record = baseRecord();
  const rejected = transitionRecord(record, { type: 'correct', patch: { 'source-order-id': 'ORD999' } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'field_not_correctable');
});

test('a stale revision cannot approve publication', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const stale = transitionRecord(withPhoto, { type: 'approve', revision: 'deadbeef', dispatchId: 'd1' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_revision');
});

test('publishing without a photo is refused', () => {
  const record = baseRecord();
  const attempt = transitionRecord(record, { type: 'approve', revision: record.revision, dispatchId: 'd1' });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, 'photo_required');
});

test('a second Publish tap on the same revision is suppressed by the lease', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const first = transitionRecord(withPhoto, { type: 'approve', revision: withPhoto.revision, dispatchId: 'd1' });
  assert.equal(first.ok, true);

  const second = transitionRecord(first.record, {
    type: 'approve',
    revision: withPhoto.revision,
    dispatchId: 'd2',
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'duplicate_publish');
  assert.equal(second.record.lease.dispatchId, 'd1');
});

test('a changed photo mid-publish is refused rather than silently rebinding', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const publishing = transitionRecord(withPhoto, {
    type: 'approve',
    revision: withPhoto.revision,
    dispatchId: 'd1',
  }).record;

  const swap = transitionRecord(publishing, { type: 'photo', image: IMAGE_B });
  assert.equal(swap.ok, false);
  assert.equal(swap.reason, 'publish_in_flight');
  assert.equal(swap.record.image.sha256, IMAGE_A.sha256);
});

test('an indeterminate result keeps the lease so retries must reconcile first', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const publishing = transitionRecord(withPhoto, {
    type: 'approve',
    revision: withPhoto.revision,
    dispatchId: 'd1',
  }).record;

  const indeterminate = transitionRecord(publishing, {
    type: 'result',
    result: { status: 'INDETERMINATE', message: 'runner timed out after dispatch' },
  }).record;

  assert.equal(indeterminate.state, INSTALL_POST_STATES.INDETERMINATE);
  assert.equal(indeterminate.lease.dispatchId, 'd1');

  const retry = transitionRecord(indeterminate, {
    type: 'approve',
    revision: indeterminate.revision,
    dispatchId: 'd2',
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, 'reconcile_required');
});

test('a published job is terminal and cannot be republished or edited', () => {
  const withPhoto = transitionRecord(baseRecord(), { type: 'photo', image: IMAGE_A }).record;
  const publishing = transitionRecord(withPhoto, {
    type: 'approve',
    revision: withPhoto.revision,
    dispatchId: 'd1',
  }).record;
  const published = transitionRecord(publishing, {
    type: 'result',
    result: { status: 'PUBLISHED', liveUrl: 'https://www.themountingman.com/installations/x', publicStatus: 200 },
  }).record;

  assert.equal(published.state, INSTALL_POST_STATES.PUBLISHED);
  assert.equal(transitionRecord(published, { type: 'approve', revision: published.revision, dispatchId: 'd3' }).reason, 'already_published');
  assert.equal(transitionRecord(published, { type: 'correct', patch: { city: 'Hopkins' } }).reason, 'already_published');
  assert.equal(transitionRecord(published, { type: 'photo', image: IMAGE_B }).reason, 'already_published');
});

test('historical imports never arrive pre-approved', () => {
  const record = baseRecord({ approval: { revision: 'x', approvedAt: 'y' }, state: INSTALL_POST_STATES.PUBLISHED });
  const { record: imported } = transitionRecord(record, { type: 'import' });
  assert.equal(imported.approval, null);
  assert.equal(imported.lease, null);
  assert.equal(imported.state, INSTALL_POST_STATES.AWAITING_PHOTO);
});

// ---------------------------------------------------------------------------
// Result sanitization
// ---------------------------------------------------------------------------

test('sanitizePublishResult allowlists fields and redacts secrets and PII', () => {
  const sanitized = sanitizePublishResult({
    status: 'RETRYABLE_FAILURE',
    liveUrl: 'https://www.themountingman.com/installations/65-inch-samsung',
    imageUrl: 'https://cdn.prod.website-files.com/x/y.webp',
    itemId: '1234',
    slug: '65-inch-samsung',
    publicStatus: 500,
    message: 'Bearer abcdef123456 rejected for jane@example.com (612-555-1234)',
    webflowToken: 'super-secret',
    customerName: 'Jane Doe',
    destinations: [{ name: 'webflow', status: 'failed', detail: 'HTTP 500' }],
  });

  assert.deepEqual(Object.keys(sanitized).sort(), [
    'destinations', 'imageUrl', 'itemId', 'liveUrl', 'message', 'publicStatus', 'slug', 'status',
  ]);
  assert.ok(!sanitized.message.includes('abcdef123456'));
  assert.ok(!sanitized.message.includes('jane@example.com'));
  assert.ok(!sanitized.message.includes('612-555-1234'));
});

test('sanitizePublishResult refuses to report success without a verified public URL', () => {
  const sanitized = sanitizePublishResult({ status: 'PUBLISHED', liveUrl: '', publicStatus: 0 });
  assert.equal(sanitized.status, 'INDETERMINATE');

  const acknowledged = sanitizePublishResult({ status: 'PUBLISHED', liveUrl: 'https://x/y', publicStatus: 202 });
  assert.equal(acknowledged.status, 'INDETERMINATE');

  const verified = sanitizePublishResult({ status: 'PUBLISHED', liveUrl: 'https://x/y', publicStatus: 200 });
  assert.equal(verified.status, 'PUBLISHED');
});

test('sanitizePublishResult maps unknown statuses to a blocked state', () => {
  assert.equal(sanitizePublishResult({ status: 'weird' }).status, 'BLOCKED');
  assert.equal(sanitizePublishResult(null).status, 'BLOCKED');
});

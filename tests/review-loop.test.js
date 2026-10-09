import assert from 'node:assert/strict';
import test from 'node:test';

import { createReviewLoopStore } from '../lib/review-loop-store.mjs';
import {
  approveReviewRequest,
  buildReviewRequestEmailBody,
  isReviewRequestSendEnabled,
  reviewRequestEnvReady,
  sendReviewRequestEmail,
  stageReviewRequestForPayment,
} from '../lib/review-request.mjs';
import {
  buildReplyDraftText,
  reviewStableId,
  syncGoogleReplyDrafts,
} from '../lib/review-reply-drafts.mjs';

function memoryKv() {
  const strings = new Map();
  const sets = new Map();
  return {
    async set(key, value, { ex } = {}) {
      strings.set(key, { value, ex });
    },
    async get(key) {
      const entry = strings.get(key);
      return entry ? entry.value : null;
    },
    async del(key) {
      strings.delete(key);
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
    async expire() {},
  };
}

test('reviewRequestEnvReady requires GOOGLE_REVIEW_URL', () => {
  assert.equal(reviewRequestEnvReady({}), false);
  assert.equal(reviewRequestEnvReady({ GOOGLE_REVIEW_URL: 'https://example.com/review' }), true);
});

test('stageReviewRequestForPayment is idempotent per payment id', async () => {
  const store = createReviewLoopStore(memoryKv());
  const env = { GOOGLE_REVIEW_URL: 'https://example.com/review' };
  const input = {
    paymentId: 'pay-abc',
    email: 'guest@example.com',
    firstName: 'Alex',
    customer: { address: { locality: 'Minneapolis' } },
  };
  const first = await stageReviewRequestForPayment(input, {
    store,
    env,
    zenbookerClient: null,
  });
  assert.equal(first.status, 'staged');
  const second = await stageReviewRequestForPayment(input, { store, env, zenbookerClient: null });
  assert.equal(second.status, 'duplicate');
});

test('stageReviewRequestForPayment refuses when GOOGLE_REVIEW_URL missing', async () => {
  const store = createReviewLoopStore(memoryKv());
  const result = await stageReviewRequestForPayment(
    { paymentId: 'p1', email: 'a@b.com', firstName: 'A' },
    { store, env: {} },
  );
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'missing_google_review_url');
});

test('email body is neutral, personal, and signed Marshall', () => {
  const body = buildReviewRequestEmailBody({
    firstName: 'Sam',
    city: 'Edina',
    serviceLabel: 'Samsung Frame mount',
    reviewUrl: 'https://example.com/review',
  });
  assert.match(body, /Hi Sam/);
  assert.match(body, /Marshall, The Mounting Man/);
  assert.match(body, /https:\/\/example.com\/review/);
  assert.doesNotMatch(body, /SMS|text me/i);
});

test('sendReviewRequestEmail never sends when flag off or not approved', async () => {
  const record = {
    status: 'approved',
    email: 'guest@example.com',
    emailBody: 'Thanks',
    channel: 'email',
    sms: false,
  };
  const fetchCalls = [];
  const fetchImpl = async (...args) => {
    fetchCalls.push(args);
    return { ok: true };
  };
  const off = await sendReviewRequestEmail(record, {
    env: { REVIEW_REQUEST_SEND_ENABLED: 'false', RESEND_API_KEY: 'k', REVIEW_REQUEST_FROM_EMAIL: 'a@b.com' },
    fetchImpl,
  });
  assert.equal(off.sent, false);
  assert.equal(off.reason, 'send_disabled');
  assert.equal(fetchCalls.length, 0);

  const staged = await sendReviewRequestEmail(
    { ...record, status: 'staged' },
    {
      env: { REVIEW_REQUEST_SEND_ENABLED: 'true', RESEND_API_KEY: 'k', REVIEW_REQUEST_FROM_EMAIL: 'a@b.com' },
      fetchImpl,
    },
  );
  assert.equal(staged.sent, false);
  assert.equal(staged.reason, 'not_approved');
  assert.equal(fetchCalls.length, 0);
});

test('sendReviewRequestEmail sends only when enabled and approved', async () => {
  assert.equal(isReviewRequestSendEnabled({ REVIEW_REQUEST_SEND_ENABLED: 'true' }), true);
  const fetchCalls = [];
  const result = await sendReviewRequestEmail(
    {
      status: 'approved',
      email: 'guest@example.com',
      emailSubject: 'Hi',
      emailBody: 'Body',
      channel: 'email',
      sms: false,
    },
    {
      env: {
        REVIEW_REQUEST_SEND_ENABLED: 'true',
        RESEND_API_KEY: 'secret',
        REVIEW_REQUEST_FROM_EMAIL: 'Marshall <hello@example.com>',
      },
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true };
      },
    },
  );
  assert.equal(result.sent, true);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /resend\.com/);
});

test('sendReviewRequestEmail rejects SMS channel', async () => {
  const result = await sendReviewRequestEmail(
    { status: 'approved', channel: 'sms', sms: true, email: 'x@y.com' },
    { env: { REVIEW_REQUEST_SEND_ENABLED: 'true', RESEND_API_KEY: 'k', REVIEW_REQUEST_FROM_EMAIL: 'a@b.com' } },
  );
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'sms_forbidden');
});

test('approveReviewRequest does not send when send flag is off', async () => {
  const store = createReviewLoopStore(memoryKv());
  await store.saveReviewRequest({
    paymentId: 'p99',
    status: 'staged',
    email: 'guest@example.com',
    emailBody: 'x',
    channel: 'email',
    sms: false,
    createdAt: new Date().toISOString(),
  });
  const fetchCalls = [];
  const out = await approveReviewRequest('p99', {
    store,
    env: { REVIEW_REQUEST_SEND_ENABLED: 'false', RESEND_API_KEY: 'k', REVIEW_REQUEST_FROM_EMAIL: 'a@b.com' },
    fetchImpl: async () => {
      fetchCalls.push(1);
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.record.status, 'approved');
  assert.equal(fetchCalls.length, 0);
});

test('syncGoogleReplyDrafts degrades when Places not configured', async () => {
  const store = createReviewLoopStore(memoryKv());
  const result = await syncGoogleReplyDrafts({
    store,
    env: {},
    placesClient: null,
  });
  assert.equal(result.created, 0);
  assert.equal(result.degraded, true);
});

test('reply draft id is stable and draft text stays calm on low stars', () => {
  const review = {
    reviewer_first_name: 'Jane',
    stars: 2,
    time: '2026-10-01T12:00:00Z',
    text: 'Installer was late and rushed.',
  };
  const id = reviewStableId(review, 'google');
  assert.equal(id, reviewStableId(review, 'google'));
  const draft = buildReplyDraftText(review);
  assert.match(draft, /sorry|make it right/i);
  assert.doesNotMatch(draft, /wrong|liar|ridiculous/i);
});

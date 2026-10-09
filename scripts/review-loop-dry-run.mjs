#!/usr/bin/env node
// Dry-run review loop: sample Square payments + sample reviews → stdout (no KV, no send).

import {
  buildReviewRequestEmailBody,
  stageReviewRequestForPayment,
} from '../lib/review-request.mjs';
import { createReviewLoopStore } from '../lib/review-loop-store.mjs';
import {
  buildReplyDraftText,
  reviewStableId,
} from '../lib/review-reply-drafts.mjs';

const FIXTURE_PAYMENTS = [
  {
    paymentId: 'pay-fixture-001',
    firstName: 'Jordan',
    lastName: 'M.',
    email: 'redacted@example.com',
    city: 'Minneapolis',
    amount: '275.00',
    serviceLabel: '65 inch TV mount',
    customer: { address: { locality: 'Minneapolis', administrative_district_level_1: 'MN' } },
  },
  {
    paymentId: 'pay-fixture-002',
    firstName: 'Casey',
    lastName: 'R.',
    email: 'redacted2@example.com',
    city: 'Edina',
    amount: '425.00',
    serviceLabel: 'Samsung Frame installation',
    customer: { address: { locality: 'Edina' } },
  },
];

const FIXTURE_REVIEWS = [
  {
    reviewer_first_name: 'Morgan',
    stars: 5,
    time: '2026-10-08T18:00:00Z',
    text: 'Marshall was on time and the mount looks perfect in our living room.',
  },
  {
    reviewer_first_name: 'Drew',
    stars: 2,
    time: '2026-10-07T14:00:00Z',
    text: 'Cable management was not what we discussed.',
  },
];

function memoryKv() {
  const strings = new Map();
  const sets = new Map();
  return {
    async set(key, value) { strings.set(key, value); },
    async get(key) { return strings.get(key) ?? null; },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
    },
    async smembers(key) { return [...(sets.get(key) || [])]; },
    async expire() {},
  };
}

function redactEmailBody(body, firstName, city) {
  return String(body)
    .replace(/@[^\s]+/g, '@redacted.example')
    .replace(new RegExp(firstName, 'gi'), firstName);
}

async function main() {
  const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://example.com/google-review-link';
  const env = { GOOGLE_REVIEW_URL: reviewUrl };
  const store = createReviewLoopStore(memoryKv());

  const lines = [];
  lines.push('# Review loop dry-run (local memory KV only)');
  lines.push('');
  lines.push('## Staged review-request emails');
  lines.push('');

  for (const payment of FIXTURE_PAYMENTS) {
    const staged = await stageReviewRequestForPayment(
      {
        ...payment,
        squareCustomerId: 'sq-cust-redacted',
        phone: '+16125550000',
      },
      { store, env, zenbookerClient: null },
    );
    const body = staged.record?.emailBody || buildReviewRequestEmailBody({
      firstName: payment.firstName,
      city: payment.city,
      serviceLabel: payment.serviceLabel,
      reviewUrl,
    });
    lines.push(`### ${payment.firstName} — ${payment.city}`);
    lines.push('');
    lines.push('```');
    lines.push(redactEmailBody(body, payment.firstName, payment.city));
    lines.push('```');
    lines.push('');
  }

  lines.push('## Reply drafts (sample Google reviews)');
  lines.push('');
  for (const review of FIXTURE_REVIEWS) {
    const id = reviewStableId(review, 'google');
    const draft = buildReplyDraftText(review);
    lines.push(`### ${review.reviewer_first_name} (${review.stars}★) — id \`${id}\``);
    lines.push('');
    lines.push('```');
    lines.push(draft);
    lines.push('```');
    lines.push('');
  }

  const output = lines.join('\n');
  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

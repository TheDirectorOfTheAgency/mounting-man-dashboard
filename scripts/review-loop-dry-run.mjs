#!/usr/bin/env node
// Dry-run review requests: sample Square payments → stdout (no KV write to prod, no send).

import {
  buildReviewRequestEmailBody,
  stageReviewRequestForPayment,
} from '../lib/review-request.mjs';
import { createReviewLoopStore } from '../lib/review-loop-store.mjs';

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

function redactEmailBody(body, firstName) {
  return String(body)
    .replace(/@[^\s]+/g, '@redacted.example')
    .replace(new RegExp(firstName, 'gi'), firstName);
}

async function main() {
  const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://example.com/google-review-link';
  const env = { GOOGLE_REVIEW_URL: reviewUrl };
  const store = createReviewLoopStore(memoryKv());

  const lines = [];
  lines.push('# Review request dry-run (local memory KV only)');
  lines.push('');
  lines.push('Marshall replies to Google/Yelp reviews himself; this dry-run covers **paid-job review requests** only.');
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
    lines.push(redactEmailBody(body, payment.firstName));
    lines.push('```');
    lines.push('');
  }

  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

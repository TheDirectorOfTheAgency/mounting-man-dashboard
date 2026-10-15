import assert from 'node:assert/strict';
import test from 'node:test';
import { sendReviewSms } from '../pages/api/webhooks/square-payment.js';

test('sendReviewSms is paused unless REVIEW_SMS_ENABLED=true', async () => {
  const prev = process.env.REVIEW_SMS_ENABLED;
  delete process.env.REVIEW_SMS_ENABLED;
  assert.equal(await sendReviewSms({ firstName: 'T', phone: '+15555550100', amount: 1, paymentId: 'p1' }), false);
  process.env.REVIEW_SMS_ENABLED = 'false';
  assert.equal(await sendReviewSms({ firstName: 'T', phone: '+15555550100', amount: 1, paymentId: 'p2' }), false);
  if (prev === undefined) delete process.env.REVIEW_SMS_ENABLED; else process.env.REVIEW_SMS_ENABLED = prev;
});

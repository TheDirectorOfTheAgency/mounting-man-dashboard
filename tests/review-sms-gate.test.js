import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_SMS_PAUSED,
  createSquarePaymentHandler,
  sendReviewSms,
} from '../pages/api/webhooks/square-payment.js';

test('sendReviewSms returns a distinct paused outcome unless REVIEW_SMS_ENABLED=true', async () => {
  const prev = process.env.REVIEW_SMS_ENABLED;
  try {
    delete process.env.REVIEW_SMS_ENABLED;
    assert.equal(await sendReviewSms({ firstName: 'T', phone: '+15555550100', amount: 1, paymentId: 'p1' }), REVIEW_SMS_PAUSED);
    process.env.REVIEW_SMS_ENABLED = 'false';
    assert.equal(await sendReviewSms({ firstName: 'T', phone: '+15555550100', amount: 1, paymentId: 'p2' }), REVIEW_SMS_PAUSED);
  } finally {
    if (prev === undefined) delete process.env.REVIEW_SMS_ENABLED; else process.env.REVIEW_SMS_ENABLED = prev;
  }
});

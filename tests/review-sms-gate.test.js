import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEW_LINK,
  REVIEW_SMS_PAUSED,
  REVIEW_SMS_SKIP_ALREADY_ASKED,
  REVIEW_SMS_SKIP_CONSENT_UNKNOWN,
  REVIEW_SMS_SKIP_NO_CONSENT,
  REVIEW_SMS_SKIP_TEST_MODE,
  reviewSmsBody,
  sendReviewSms,
} from '../lib/review-sms.js';
import { createSquarePaymentHandler } from '../pages/api/webhooks/square-payment.js';
import { createResponse } from './webhook-test-helpers.js';

const SERVICE_SID = 'MG0123456789abcdef0123456789abcdef';
const ACCOUNT_SID = 'AC_test_sid';
const AUTH_TOKEN = 'test-auth-token';
const ALLOWED_PHONE = '+15555550100';

function consentedJob(overrides = {}) {
  return {
    firstName: 'Pat',
    phone: ALLOWED_PHONE,
    amount: 10,
    paymentId: 'pay-1',
    booking: {
      job_fields: [{
        field_name: 'Send me notifications about this appointment via text message',
        text_value: 'Yes',
      }],
    },
    ...overrides,
  };
}

async function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) delete process.env[key];
    else process.env[key] = updates[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function enabledEnv(overrides = {}) {
  return {
    REVIEW_SMS_ENABLED: 'true',
    REVIEW_SMS_TEST_TO: undefined,
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID,
    ...overrides,
  };
}

test('sendReviewSms returns a distinct paused outcome unless the flag is exactly true', async () => {
  const posts = [];
  const httpClient = { async post(...args) { posts.push(args); return { data: {} }; } };
  await withEnv({ REVIEW_SMS_ENABLED: undefined }, async () => {
    assert.equal(
      await sendReviewSms(consentedJob({ paymentId: 'p1' }), { httpClient }),
      REVIEW_SMS_PAUSED,
    );
  });
  await withEnv({ REVIEW_SMS_ENABLED: 'false' }, async () => {
    assert.equal(
      await sendReviewSms(consentedJob({ paymentId: 'p2' }), { httpClient }),
      REVIEW_SMS_PAUSED,
    );
  });
  assert.equal(posts.length, 0);
});

test('approved review wording keeps the Google review link, adds STOP, and has no emoji', () => {
  const body = reviewSmsBody('Pat');
  assert.equal(
    body,
    `Hi Pat, Marshall (The Mounting Man) here. Thanks for choosing us! If you have 30 seconds, we'd appreciate a Google review: ${REVIEW_LINK} Reply STOP to opt out.`,
  );
  assert.equal(body.includes('🎬'), false);
  assert.equal([...body].some((char) => char.codePointAt(0) > 0xffff), false);
  assert.equal(REVIEW_LINK, 'https://g.page/r/CVhbFMF9evLaEBE/review');
});

test('test allowlist sends only listed numbers and logs everyone else as skipped_test_mode', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
  const posts = [];
  const httpClient = { async post(...args) { posts.push(args); return { data: {} }; } };
  await withEnv(enabledEnv({ REVIEW_SMS_TEST_TO: `555-555-0100, ${ALLOWED_PHONE}` }), async () => {
    assert.equal(
      await sendReviewSms(consentedJob({ phone: '+15555550999', paymentId: 'other' }), { httpClient }),
      REVIEW_SMS_SKIP_TEST_MODE,
    );
    assert.equal(
      await sendReviewSms(consentedJob({ paymentId: 'listed' }), { httpClient }),
      true,
    );
  });
  assert.equal(posts.length, 1);
  assert.equal(logs.some((line) => line.includes('skipped_test_mode for payment other')), true);
  assert.equal(logs.some((line) => line.includes('skipped_test_mode for payment listed')), false);
});

test('missing ZenBooker SMS checkbox skips as skipped_consent_unknown', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
  const httpClient = { async post() { throw new Error('should not send'); } };
  await withEnv(enabledEnv(), async () => {
    assert.equal(
      await sendReviewSms({ firstName: 'Pat', phone: ALLOWED_PHONE, paymentId: 'no-field' }, { httpClient }),
      REVIEW_SMS_SKIP_CONSENT_UNKNOWN,
    );
    assert.equal(
      await sendReviewSms(consentedJob({
        paymentId: 'empty-field',
        booking: {
          job_fields: [{
            field_name: 'Send me notifications about this appointment via text message',
            text_value: '',
          }],
        },
      }), { httpClient }),
      REVIEW_SMS_SKIP_CONSENT_UNKNOWN,
    );
  });
  assert.equal(logs.filter((line) => line.includes('skipped_consent_unknown')).length, 2);
});

test('advertising measurement consent is not the booking SMS checkbox', async () => {
  const httpClient = { async post() { throw new Error('should not send'); } };
  await withEnv(enabledEnv(), async () => {
    assert.equal(await sendReviewSms({
      firstName: 'Pat',
      phone: ALLOWED_PHONE,
      paymentId: 'ads-consent',
      booking: {
        consent: { ad_user_data: 'GRANTED' },
        job_fields: [{
          field_name: 'I consent to The Mounting Man securely sharing hashed contact information and service outcome data with advertising platforms for measurement',
          text_value: 'yes',
        }],
      },
    }, { httpClient }), REVIEW_SMS_SKIP_CONSENT_UNKNOWN);
  });
});

test('unticked ZenBooker SMS checkbox skips as skipped_no_consent', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
  const httpClient = { async post() { throw new Error('should not send'); } };
  await withEnv(enabledEnv({ REVIEW_SMS_TEST_TO: ALLOWED_PHONE }), async () => {
    assert.equal(
      await sendReviewSms(consentedJob({
        paymentId: 'unticked',
        booking: { sms_consent: false },
      }), { httpClient }),
      REVIEW_SMS_SKIP_NO_CONSENT,
    );
  });
  assert.equal(logs.some((line) => line.includes('skipped_no_consent for payment unticked')), true);
});

test('during-job review ask skips when the hook says the customer was already asked', async () => {
  const httpClient = { async post() { throw new Error('should not send'); } };
  await withEnv(enabledEnv(), async () => {
    assert.equal(
      await sendReviewSms(consentedJob({ alreadyAskedForReview: true, paymentId: 'asked' }), { httpClient }),
      REVIEW_SMS_SKIP_ALREADY_ASKED,
    );
    assert.equal(
      await sendReviewSms(consentedJob({ paymentId: 'reader' }), {
        httpClient,
        wasAskedDuringJob: async () => true,
      }),
      REVIEW_SMS_SKIP_ALREADY_ASKED,
    );
    let posted = false;
    assert.equal(
      await sendReviewSms(consentedJob({ paymentId: 'not-asked' }), {
        httpClient: { async post() { posted = true; return { data: {} }; } },
        wasAskedDuringJob: async () => false,
      }),
      true,
    );
    assert.equal(posted, true);
  });
});

test('messaging service send posts MessagingServiceSid and StatusCallback, never a raw sender number', async () => {
  const posts = [];
  const httpClient = {
    async post(url, body, config) {
      posts.push({ url, body, config });
      return { data: { sid: 'SM_test' } };
    },
  };
  await withEnv(enabledEnv(), async () => {
    assert.equal(await sendReviewSms(consentedJob(), { httpClient }), true);
  });
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/Accounts\/AC_test_sid\/Messages\.json$/);
  const params = new URLSearchParams(posts[0].body);
  assert.equal(params.get('MessagingServiceSid'), SERVICE_SID);
  assert.equal(params.get('From'), null);
  assert.equal(params.has('From'), false);
  assert.equal(params.get('To'), ALLOWED_PHONE);
  assert.equal(params.get('Body'), reviewSmsBody('Pat'));
  assert.equal(
    params.get('StatusCallback'),
    'https://mounting-man-dashboard.vercel.app/api/webhooks/twilio-status',
  );
  assert.equal(posts[0].config.headers.Authorization, `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`);
});

test('a missing messaging service SID does not fall back to a sender number', async () => {
  const httpClient = { async post() { throw new Error('should not send'); } };
  await withEnv(enabledEnv({ TWILIO_MESSAGING_SERVICE_SID: '+19526496388' }), async () => {
    assert.equal(await sendReviewSms(consentedJob(), { httpClient }), false);
  });
  await withEnv(enabledEnv({ TWILIO_MESSAGING_SERVICE_SID: undefined }), async () => {
    assert.equal(await sendReviewSms(consentedJob(), { httpClient }), false);
  });
});

function paymentRequest(payment = {}) {
  return {
    method: 'POST',
    headers: {},
    body: {
      type: 'payment.updated',
      data: {
        object: {
          payment: {
            id: 'payment-1',
            customer_id: 'customer-1',
            status: 'COMPLETED',
            amount_money: { amount: 10000, currency: 'USD' },
            ...payment,
          },
        },
      },
    },
  };
}

function handlerDeps(overrides = {}) {
  return {
    readRawBody: async (req) => JSON.stringify(req.body),
    signatureKey: '',
    httpClient: {
      async get() {
        return {
          data: {
            customer: {
              given_name: 'Pat',
              family_name: 'Customer',
              phone_number: ALLOWED_PHONE,
            },
          },
        };
      },
    },
    followUpClaim: async () => 'claimed',
    operationsNotifier: async () => { throw new Error('should not notify'); },
    installPostNotifier: async () => {},
    attributionCoordinator: { async registerPayment() { return { status: 'observed' }; } },
    logger: { info() {}, warn() {} },
    ...overrides,
  };
}

test('the square payment handler stays paused by default and does not notify', async () => {
  await withEnv({ REVIEW_SMS_ENABLED: undefined }, async () => {
    const res = createResponse();
    await createSquarePaymentHandler(handlerDeps())(paymentRequest(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'sms_paused');
    assert.equal(res.body.reviewSmsStatus, 'paused');
  });
});

test('skip reasons are not treated as a successful review SMS', async () => {
  const logs = [];
  const res = createResponse();
  await createSquarePaymentHandler(handlerDeps({
    logger: { info: (...args) => { logs.push(args); }, warn() {} },
    reviewSmsSender: async () => REVIEW_SMS_SKIP_NO_CONSENT,
  }))(paymentRequest(), res);
  assert.equal(res.body.status, 'sms_skipped');
  assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_NO_CONSENT);
  assert.deepEqual(logs[0], [
    'square_payment_processed',
    { attributionStatus: 'observed', reviewSmsStatus: REVIEW_SMS_SKIP_NO_CONSENT },
  ]);
});

test('a card payment with no SMS checkbox is skipped_consent_unknown when the flag is on', async () => {
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    const res = createResponse();
    await createSquarePaymentHandler(handlerDeps())(paymentRequest(), res);
    assert.equal(res.body.status, 'sms_skipped');
    assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_CONSENT_UNKNOWN);
  });
});

test('an unticked checkbox on the payment booking skips before any send', async () => {
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    const res = createResponse();
    await createSquarePaymentHandler(handlerDeps())(paymentRequest({
      booking: { sms_consent: false },
    }), res);
    assert.equal(res.body.status, 'sms_skipped');
    assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_NO_CONSENT);
  });
});

test('invoice payments still return before review SMS', async () => {
  let smsCalls = 0;
  const res = createResponse();
  await createSquarePaymentHandler(handlerDeps({
    reviewSmsSender: async () => { smsCalls += 1; return true; },
  }))({
    method: 'POST',
    headers: {},
    body: {
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: 'invoice-1',
            primary_recipient: { customer_id: 'customer-1' },
            payment_requests: [
              { total_completed_amount_money: { amount: 32500, currency: 'USD' } },
            ],
          },
        },
      },
    },
  }, res);
  assert.equal(res.body.status, 'invoice_processed');
  assert.equal(smsCalls, 0);
});

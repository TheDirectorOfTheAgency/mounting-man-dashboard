import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttributionStore } from '../lib/offline-conversion-store.js';
import {
  REVIEW_LINK,
  REVIEW_SMS_PAUSED,
  REVIEW_SMS_SKIP_ALREADY_ASKED,
  REVIEW_SMS_SKIP_CONSENT_UNKNOWN,
  REVIEW_SMS_SKIP_DUPLICATE,
  REVIEW_SMS_SKIP_NO_CONSENT,
  REVIEW_SMS_SKIP_TEST_MODE,
  reviewSmsBody,
  reviewSmsSendLockKey,
  selectReviewSmsBooking,
  sendReviewSms,
} from '../lib/review-sms.js';
import { createSquarePaymentHandler } from '../pages/api/webhooks/square-payment.js';
import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import {
  completedPayload,
  createRequest,
  createResponse,
  installTestEnvironment,
} from './webhook-test-helpers.js';

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

test('approved review wording uses the Nov 9 body, Google review link, STOP line, and no emoji', () => {
  const body = reviewSmsBody('Pat');
  const expected = `Thank you so much for the business. If you could write a nice review on Google about me at the link here, and upload a photo of the work, that would help out a ton! ${REVIEW_LINK} Reply STOP to opt out.`;
  assert.equal(body, expected);
  assert.equal(reviewSmsBody(), expected);
  assert.equal(body.includes('Thank you so much for the business.'), true);
  assert.equal(
    body.includes('If you could write a nice review on Google about me at the link here, and upload a photo of the work, that would help out a ton!'),
    true,
  );
  assert.equal(body.includes('https://g.page/themountingman/review?id'), true);
  assert.equal(body.includes('Reply STOP to opt out.'), true);
  assert.equal(body.includes('Hi '), false);
  assert.equal(body.includes('Pat'), false);
  assert.equal(body.includes('🎬'), false);
  assert.equal(/\p{Extended_Pictographic}/u.test(body), false);
  assert.equal([...body].some((char) => char.codePointAt(0) > 0xffff), false);
  assert.equal(REVIEW_LINK, 'https://g.page/themountingman/review?id');
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
  assert.equal(params.get('Body'), reviewSmsBody());
  assert.equal(params.get('Body').includes('Pat'), false);
  assert.equal(params.get('Body').includes('Hi '), false);
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

const ADS_MEASUREMENT_LABEL = 'I consent to The Mounting Man securely sharing hashed contact information and service outcome data with advertising platforms for measurement';

function memoryKv() {
  const values = new Map();
  return {
    values,
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
    async sadd() {
      return 0;
    },
    async smembers() {
      return [];
    },
    async expire() {
      return 1;
    },
  };
}

function bookingRequest(event, data) {
  return {
    method: 'POST',
    query: { secret: 'test-webhook-secret' },
    headers: { event },
    body: { event, data },
  };
}

function quietZenbookerLogger() {
  return { info() {}, warn() {}, error() {} };
}

function invoicePaymentRequest() {
  return {
    method: 'POST',
    headers: {},
    body: {
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: 'invoice-1',
            order_id: 'order-invoice-1',
            primary_recipient: { customer_id: 'customer-1' },
            payment_requests: [
              { total_completed_amount_money: { amount: 32500, currency: 'USD' } },
            ],
          },
        },
      },
    },
  };
}

function senderThatMustNotPost() {
  return (job) => sendReviewSms(job, {
    httpClient: { async post() { throw new Error('should not send'); } },
  });
}

test('booking created and updated store the ZenBooker text checkbox', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const kv = memoryKv();
  const store = createAttributionStore(kv);
  const handler = createZenbookerWebhookHandler({
    attributionStore: store,
    logger: quietZenbookerLogger(),
  });

  const created = createResponse();
  await handler(bookingRequest('job.created', {
    id: 'job-created-1',
    customer: { accepts_sms: true },
  }), created);
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.status, 'sms_consent_stored');
  assert.deepEqual(await store.getReviewSmsConsent('job-created-1'), { smsConsent: 'granted' });

  const updated = createResponse();
  await handler(bookingRequest('job.updated', {
    id: 'job-created-1',
    customer: { accepts_sms: false },
  }), updated);
  assert.equal(updated.body.status, 'sms_consent_stored');
  assert.deepEqual(await store.getReviewSmsConsent('job-created-1'), { smsConsent: 'denied' });

  const labeled = createResponse();
  await handler(bookingRequest('job.created', {
    id: 'job-label-1',
    job_fields: [{
      field_name: 'Send me notifications about this appointment via text message',
      text_value: 'Yes',
    }],
  }), labeled);
  assert.equal(labeled.body.status, 'sms_consent_stored');
  assert.deepEqual(await store.getReviewSmsConsent('job-label-1'), { smsConsent: 'granted' });

  const entries = [...kv.values.entries()];
  assert.equal(entries.length, 2);
  for (const [key, value] of entries) {
    assert.equal(key.includes('job-created-1'), false);
    assert.equal(key.includes('job-label-1'), false);
    assert.equal(Object.keys(value).join(','), 'smsConsent');
    assert.equal(value.smsConsent === 'granted' || value.smsConsent === 'denied', true);
  }
});

test('advertising measurement consent is not stored as the booking SMS checkbox', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const store = createAttributionStore(memoryKv());
  const handler = createZenbookerWebhookHandler({
    attributionStore: store,
    logger: quietZenbookerLogger(),
  });
  const adsOnly = createResponse();
  await handler(bookingRequest('job.created', {
    id: 'job-ads-1',
    consent: { ad_user_data: 'GRANTED' },
    job_fields: [{ field_name: ADS_MEASUREMENT_LABEL, text_value: 'yes' }],
  }), adsOnly);
  assert.equal(adsOnly.body.status, 'sms_consent_not_stored');
  assert.equal(adsOnly.body.reason, 'consent_unknown');
  assert.equal(await store.getReviewSmsConsent('job-ads-1'), null);

  const unticked = createResponse();
  await handler(bookingRequest('job.updated', {
    id: 'job-ads-unticked',
    customer: { accepts_sms: false },
    consent: { ad_user_data: 'GRANTED' },
    job_fields: [{ field_name: ADS_MEASUREMENT_LABEL, text_value: 'yes' }],
  }), unticked);
  assert.deepEqual(await store.getReviewSmsConsent('job-ads-unticked'), { smsConsent: 'denied' });
});

test('job.completed keeps the paid-job path when the text checkbox is present', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const store = createAttributionStore(memoryKv());
  await store.saveJobMapping({ jobId: 'test-job-123', squareCustomerId: 'square-customer-1' });
  const calls = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: store,
    coordinator: {
      async registerJob(value) {
        calls.push(value);
        return { status: 'observed' };
      },
    },
    disclosureVersion: '2026-07-10',
    logger: quietZenbookerLogger(),
  });
  const res = createResponse();
  await handler(createRequest(completedPayload({ accepts_sms: true })), res);
  assert.equal(res.body.status, 'observed');
  assert.equal(calls.length, 1);
  assert.equal(await store.getReviewSmsConsent('test-job-123'), null);
});

test('square payment lookup uses the stored ZenBooker checkbox', async () => {
  const store = createAttributionStore(memoryKv());
  await store.saveReviewSmsConsent({ jobId: 'job-pay-1', smsConsent: 'denied' });
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    const res = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: store,
      loadSquareOrder: async (orderId) => {
        assert.equal(orderId, 'order-pay-1');
        return { metadata: { zenbooker_job_id: 'job-pay-1' } };
      },
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({ order_id: 'order-pay-1' }), res);
    assert.equal(res.body.status, 'sms_skipped');
    assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_NO_CONSENT);
  });
});

test('a payment with no stored checkbox stays skipped_consent_unknown', async () => {
  const store = createAttributionStore(memoryKv());
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    const res = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: store,
      loadSquareOrder: async () => ({ metadata: { zenbooker_job_id: 'job-missing' } }),
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({ order_id: 'order-missing' }), res);
    assert.equal(res.body.status, 'sms_skipped');
    assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_CONSENT_UNKNOWN);
  });
});

test('invoice payments reach the review SMS path', async () => {
  let smsCalls = 0;
  const seen = [];
  const res = createResponse();
  await createSquarePaymentHandler(handlerDeps({
    reviewSmsSender: async (job) => {
      smsCalls += 1;
      seen.push(job);
      return REVIEW_SMS_PAUSED;
    },
  }))(invoicePaymentRequest(), res);
  assert.equal(smsCalls, 1);
  assert.equal(seen[0].amount, '325.00');
  assert.equal(res.body.status, 'sms_paused');
  assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_PAUSED);
});

test('an invoice with the flag off pauses and an invoice with no stored checkbox stays unknown', async () => {
  const paused = createResponse();
  await withEnv({ REVIEW_SMS_ENABLED: undefined }, async () => {
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsSender: senderThatMustNotPost(),
    }))(invoicePaymentRequest(), paused);
  });
  assert.equal(paused.body.status, 'sms_paused');
  assert.equal(paused.body.reviewSmsStatus, REVIEW_SMS_PAUSED);

  const unknown = createResponse();
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: createAttributionStore(memoryKv()),
      loadSquareOrder: async () => ({ id: 'order-invoice-1' }),
      reviewSmsSender: senderThatMustNotPost(),
    }))(invoicePaymentRequest(), unknown);
  });
  assert.equal(unknown.body.status, 'sms_skipped');
  assert.equal(unknown.body.reviewSmsStatus, REVIEW_SMS_SKIP_CONSENT_UNKNOWN);
});

test('REVIEW_SMS_ENABLED still pauses a stored checkbox unless it is exactly true', async () => {
  const store = createAttributionStore(memoryKv());
  await store.saveReviewSmsConsent({ jobId: 'job-pause', smsConsent: 'granted' });
  const deps = handlerDeps({
    reviewSmsConsentStore: store,
    loadSquareOrder: async () => ({ metadata: { zenbooker_job_id: 'job-pause' } }),
    reviewSmsSender: senderThatMustNotPost(),
  });
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    const res = createResponse();
    await withEnv({ REVIEW_SMS_ENABLED: flag }, async () => {
      await createSquarePaymentHandler(deps)(paymentRequest({ order_id: 'order-pause' }), res);
    });
    assert.equal(res.body.status, 'sms_paused', `flag ${String(flag)}`);
    assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_PAUSED);
  }
});

test('ad measurement consent on a payment does not replace a missing or stored booking checkbox', async () => {
  const store = createAttributionStore(memoryKv());
  await store.saveReviewSmsConsent({ jobId: 'job-stored-deny', smsConsent: 'denied' });
  const adsBooking = {
    consent: { ad_user_data: 'GRANTED' },
    job_fields: [{ field_name: ADS_MEASUREMENT_LABEL, text_value: 'yes' }],
  };
  await withEnv(enabledEnv({
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
  }), async () => {
    const adsOnly = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: createAttributionStore(memoryKv()),
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({ booking: adsBooking }), adsOnly);
    assert.equal(adsOnly.body.reviewSmsStatus, REVIEW_SMS_SKIP_CONSENT_UNKNOWN);

    const stored = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: store,
      loadSquareOrder: async () => ({ metadata: { zenbooker_job_id: 'job-stored-deny' } }),
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({
      order_id: 'order-stored-deny',
      booking: adsBooking,
    }), stored);
    assert.equal(stored.body.reviewSmsStatus, REVIEW_SMS_SKIP_NO_CONSENT);
  });
});

test('stored consent keeps already-asked markers and does not treat ads consent as the checkbox', async () => {
  const httpClient = { async post() { throw new Error('should not send'); } };
  const markers = ['alreadyAskedForReview', 'duringJobReviewAsked', 'reviewAskedDuringJob'];
  await withEnv(enabledEnv(), async () => {
    for (const marker of markers) {
      const booking = selectReviewSmsBooking({
        attached: { [marker]: true },
        stored: { smsConsent: 'granted' },
      });
      assert.equal(booking[marker], true, marker);
      assert.equal(booking.sms_consent, true, marker);
      assert.equal(await sendReviewSms({
        firstName: 'Pat',
        phone: ALLOWED_PHONE,
        paymentId: marker,
        booking,
      }, { httpClient }), REVIEW_SMS_SKIP_ALREADY_ASKED, marker);
    }

    const denied = selectReviewSmsBooking({
      attached: { alreadyAskedForReview: true },
      stored: { smsConsent: 'denied' },
    });
    assert.equal(denied.alreadyAskedForReview, true);
    assert.equal(denied.sms_consent, false);
    assert.equal(await sendReviewSms({
      firstName: 'Pat',
      phone: ALLOWED_PHONE,
      paymentId: 'stored-denied',
      booking: denied,
    }, { httpClient }), REVIEW_SMS_SKIP_NO_CONSENT);

    const unknown = selectReviewSmsBooking({
      attached: { alreadyAskedForReview: true },
      stored: null,
    });
    assert.equal(unknown.alreadyAskedForReview, true);
    assert.equal(Object.hasOwn(unknown, 'sms_consent'), false);
    assert.equal(await sendReviewSms({
      firstName: 'Pat',
      phone: ALLOWED_PHONE,
      paymentId: 'stored-missing',
      booking: unknown,
    }, { httpClient }), REVIEW_SMS_SKIP_CONSENT_UNKNOWN);

    const adsAttached = {
      alreadyAskedForReview: true,
      consent: { ad_user_data: 'GRANTED' },
      job_fields: [{ field_name: ADS_MEASUREMENT_LABEL, text_value: 'yes' }],
    };
    const adsGranted = selectReviewSmsBooking({
      attached: adsAttached,
      stored: { smsConsent: 'granted' },
    });
    assert.equal(adsGranted.alreadyAskedForReview, true);
    assert.equal(adsGranted.sms_consent, true);
    assert.equal(await sendReviewSms({
      firstName: 'Pat',
      phone: ALLOWED_PHONE,
      paymentId: 'ads-and-asked',
      booking: adsGranted,
    }, { httpClient }), REVIEW_SMS_SKIP_ALREADY_ASKED);

    const explicitDenied = selectReviewSmsBooking({
      attached: { sms_consent: false, alreadyAskedForReview: true },
      stored: { smsConsent: 'granted' },
    });
    assert.equal(explicitDenied.sms_consent, false);
    assert.equal(explicitDenied.alreadyAskedForReview, true);
  });
});

test('the square handler skips already-asked bookings when only stored consent is granted', async () => {
  const store = createAttributionStore(memoryKv());
  await store.saveReviewSmsConsent({ jobId: 'job-asked', smsConsent: 'granted' });
  await store.saveReviewSmsConsent({ jobId: 'job-denied-asked', smsConsent: 'denied' });
  const markers = ['alreadyAskedForReview', 'duringJobReviewAsked', 'reviewAskedDuringJob'];
  await withEnv(enabledEnv(), async () => {
    for (const marker of markers) {
      const res = createResponse();
      await createSquarePaymentHandler(handlerDeps({
        reviewSmsConsentStore: store,
        loadSquareOrder: async () => ({ metadata: { zenbooker_job_id: 'job-asked' } }),
        reviewSmsSender: senderThatMustNotPost(),
      }))(paymentRequest({
        id: `payment-${marker}`,
        order_id: `order-${marker}`,
        booking: {
          [marker]: true,
          consent: { ad_user_data: 'GRANTED' },
          job_fields: [{ field_name: ADS_MEASUREMENT_LABEL, text_value: 'yes' }],
        },
      }), res);
      assert.equal(res.body.reviewSmsStatus, REVIEW_SMS_SKIP_ALREADY_ASKED, marker);
    }

    const denied = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: store,
      loadSquareOrder: async () => ({ metadata: { zenbooker_job_id: 'job-denied-asked' } }),
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({
      id: 'payment-denied-asked',
      order_id: 'order-denied-asked',
      booking: { alreadyAskedForReview: true },
    }), denied);
    assert.equal(denied.body.reviewSmsStatus, REVIEW_SMS_SKIP_NO_CONSENT);

    const unknown = createResponse();
    await createSquarePaymentHandler(handlerDeps({
      reviewSmsConsentStore: createAttributionStore(memoryKv()),
      loadSquareOrder: async () => ({}),
      reviewSmsSender: senderThatMustNotPost(),
    }))(paymentRequest({
      id: 'payment-unknown-asked',
      order_id: 'order-unknown-asked',
      booking: { duringJobReviewAsked: true },
    }), unknown);
    assert.equal(unknown.body.reviewSmsStatus, REVIEW_SMS_SKIP_CONSENT_UNKNOWN);
  });
});

function atomicClaim() {
  const held = new Set();
  const calls = [];
  let tail = Promise.resolve();
  return {
    calls,
    claim(key) {
      const run = tail.then(() => {
        calls.push(key);
        if (held.has(key)) return 'duplicate';
        held.add(key);
        return 'claimed';
      });
      tail = run.then(() => {}, () => {});
      return run;
    },
    async release(key) {
      held.delete(key);
      return 'released';
    },
  };
}

function sharedPaymentEvent() {
  return paymentRequest({
    id: 'pay-shared',
    order_id: 'order-shared',
    booking: { sms_consent: true },
  });
}

function sharedInvoiceEvent() {
  return {
    method: 'POST',
    headers: {},
    body: {
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: 'inv-shared',
            order_id: 'order-shared',
            primary_recipient: { customer_id: 'customer-1' },
            payment_requests: [
              { total_completed_amount_money: { amount: 10000, currency: 'USD' } },
            ],
            booking: { sms_consent: true },
          },
        },
      },
    },
  };
}

function lockHandler({ sender, follow = atomicClaim(), sms = atomicClaim(), install = [] } = {}) {
  return {
    follow,
    sms,
    install,
    handler: createSquarePaymentHandler(handlerDeps({
      followUpClaim: (key) => follow.claim(key),
      reviewSmsClaim: (key) => sms.claim(key),
      reviewSmsClaimRelease: (key) => sms.release(key),
      operationsNotifier: async () => {},
      installPostNotifier: async () => { install.push('install'); },
      reviewSmsSender: sender,
    })),
  };
}

test('review SMS send lock prefers the shared order and keeps a booking id opaque', () => {
  assert.equal(
    reviewSmsSendLockKey({
      orderId: 'order-shared',
      bookingId: 'job-shared-booking',
      paymentId: 'pay-shared',
      invoiceId: 'inv-shared',
    }),
    'review-sms:send:order:order-shared',
  );
  const bookingKey = reviewSmsSendLockKey({ bookingId: 'job-shared-booking', paymentId: 'unknown' });
  assert.equal(bookingKey.startsWith('review-sms:send:booking:'), true);
  assert.equal(bookingKey.includes('job-shared-booking'), false);
  assert.equal(bookingKey, reviewSmsSendLockKey({ bookingId: 'job-shared-booking' }));
  assert.equal(
    reviewSmsSendLockKey({ orderId: 'unknown', paymentId: 'pay-only' }),
    'review-sms:send:payment:pay-only',
  );
});

test('payment.updated and invoice.payment_made send one review SMS per transaction', async () => {
  for (const order of [['payment', 'invoice'], ['invoice', 'payment']]) {
    const sent = [];
    const install = [];
    const locked = lockHandler({
      install,
      sender: async () => {
        sent.push(order.join('>'));
        return true;
      },
    });
    const events = { payment: sharedPaymentEvent(), invoice: sharedInvoiceEvent() };
    const first = createResponse();
    await locked.handler(events[order[0]], first);
    const second = createResponse();
    await locked.handler(events[order[1]], second);
    assert.equal(sent.length, 1, order.join(' then '));
    assert.equal(install.length, 2, order.join(' then '));
    assert.equal(first.body.reviewSmsStatus, 'sent', order.join(' then '));
    assert.equal(second.body.reviewSmsStatus, REVIEW_SMS_SKIP_DUPLICATE, order.join(' then '));
    const expectedFollow = order[0] === 'payment'
      ? ['square:payment:pay-shared', 'square:invoice:inv-shared']
      : ['square:invoice:inv-shared', 'square:payment:pay-shared'];
    assert.deepEqual(locked.follow.calls, expectedFollow);
    assert.deepEqual(locked.sms.calls, [
      'review-sms:send:order:order-shared',
      'review-sms:send:order:order-shared',
    ]);
  }
});

test('repeat and concurrent review SMS callbacks still send once', async () => {
  const repeatSent = [];
  const repeat = lockHandler({
    sender: async () => {
      repeatSent.push('repeat');
      return true;
    },
  });
  const repeatFirst = createResponse();
  await repeat.handler(sharedPaymentEvent(), repeatFirst);
  const repeatSecond = createResponse();
  await repeat.handler(sharedPaymentEvent(), repeatSecond);
  assert.equal(repeatSent.length, 1);
  assert.equal(repeatFirst.body.reviewSmsStatus, 'sent');
  assert.equal(repeatSecond.body.status, 'duplicate');

  const concurrentSent = [];
  const concurrent = lockHandler({
    sender: async () => {
      concurrentSent.push('concurrent');
      return true;
    },
  });
  const responses = await Promise.all([sharedPaymentEvent(), sharedInvoiceEvent()].map(async (event) => {
    const res = createResponse();
    await concurrent.handler(event, res);
    return res;
  }));
  assert.equal(concurrentSent.length, 1);
  assert.equal(responses.filter((res) => res.body.reviewSmsStatus === 'sent').length, 1);
  assert.equal(responses.filter((res) => res.body.reviewSmsStatus === REVIEW_SMS_SKIP_DUPLICATE).length, 1);
  assert.equal(concurrent.install.length, 2);

  const bookingSent = [];
  const bookingLock = lockHandler({
    sender: async () => {
      bookingSent.push('booking');
      return true;
    },
  });
  const bookingPayment = paymentRequest({
    id: 'pay-book',
    metadata: { zenbooker_job_id: 'job-shared-booking' },
    booking: { sms_consent: true },
  });
  const bookingInvoice = {
    method: 'POST',
    headers: {},
    body: {
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: 'inv-book',
            metadata: { zenbooker_job_id: 'job-shared-booking' },
            primary_recipient: { customer_id: 'customer-1' },
            payment_requests: [
              { total_completed_amount_money: { amount: 10000, currency: 'USD' } },
            ],
          },
        },
      },
    },
  };
  await bookingLock.handler(bookingPayment, createResponse());
  await bookingLock.handler(bookingInvoice, createResponse());
  assert.equal(bookingSent.length, 1);
  assert.equal(bookingLock.sms.calls[0], bookingLock.sms.calls[1]);
  assert.equal(bookingLock.sms.calls[0].includes('job-shared-booking'), false);
});

test('a failed review send keeps the lock and a paused send releases it', async () => {
  const failedCalls = [];
  const failed = lockHandler({
    sender: async () => {
      failedCalls.push('failed');
      return false;
    },
  });
  const failedFirst = createResponse();
  await failed.handler(sharedPaymentEvent(), failedFirst);
  const failedSecond = createResponse();
  await failed.handler(sharedInvoiceEvent(), failedSecond);
  assert.equal(failedCalls.length, 1);
  assert.equal(failedFirst.body.reviewSmsStatus, 'failed');
  assert.equal(failedSecond.body.reviewSmsStatus, REVIEW_SMS_SKIP_DUPLICATE);

  const pausedCalls = [];
  const paused = lockHandler({
    sender: async () => {
      pausedCalls.push('paused');
      return REVIEW_SMS_PAUSED;
    },
  });
  const pausedPayment = createResponse();
  await paused.handler(sharedPaymentEvent(), pausedPayment);
  const pausedInvoice = createResponse();
  await paused.handler(sharedInvoiceEvent(), pausedInvoice);
  assert.equal(pausedCalls.length, 2);
  assert.equal(pausedPayment.body.reviewSmsStatus, REVIEW_SMS_PAUSED);
  assert.equal(pausedInvoice.body.reviewSmsStatus, REVIEW_SMS_PAUSED);
});

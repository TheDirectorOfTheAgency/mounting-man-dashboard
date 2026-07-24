import assert from 'node:assert/strict';
import test from 'node:test';

import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import {
  completedPayload,
  createRequest,
  createResponse,
  installTestEnvironment,
} from './webhook-test-helpers.js';

function mappedStore(
  mapping = { squareCustomerId: 'square-customer-1', squareBookingId: 'square-booking-1' },
  bookingAttribution = null
) {
  return {
    getJobMapping: async () => mapping,
    getBookingAttribution: async () => bookingAttribution,
  };
}

function quietLogger(output = []) {
  return {
    info: (...args) => output.push(args),
    warn: (...args) => output.push(args),
    error: (...args) => output.push(args),
  };
}

test('mapped eligible completion delegates to the coordinator without using invoice value', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const calls = [];
  const coordinator = {
    async registerJob(value) {
      calls.push(value);
      return { status: 'observed' };
    },
  };
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    coordinator,
    disclosureVersion: '2026-07-10',
    mode: 'observe',
    logger: quietLogger(),
  });

  const res = createResponse();
  await handler(createRequest(completedPayload({ invoice: { total: 999999 } })), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'observed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].squareCustomerId, 'square-customer-1');
  assert.equal('conversionValue' in calls[0], false);
});

test('staff and test jobs are rejected before mapping or coordinator work', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  let mappingCalls = 0;
  const handler = createZenbookerWebhookHandler({
    attributionStore: { getJobMapping: async () => { mappingCalls += 1; } },
    coordinator: { registerJob: async () => assert.fail('must not coordinate') },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });

  for (const payload of [
    completedPayload({ created_by: 'staff' }),
    completedPayload({ is_test: true }),
  ]) {
    const res = createResponse();
    await handler(createRequest(payload), res);
    assert.equal(res.body.reason, 'STAFF_OR_TEST_JOB');
  }
  assert.equal(mappingCalls, 0);
});

test('missing disclosure and denied consent are hard stops', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const withoutDisclosure = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    logger: quietLogger(),
  });
  const denied = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });

  const noDisclosureRes = createResponse();
  await withoutDisclosure(createRequest(completedPayload()), noDisclosureRes);
  assert.equal(noDisclosureRes.body.reason, 'PRIVACY_DISCLOSURE_MISSING');

  const deniedRes = createResponse();
  await denied(createRequest(completedPayload({ consent: { ad_user_data: 'DENIED' } })), deniedRes);
  assert.equal(deniedRes.body.reason, 'CONSENT_DENIED');
});

test('a missing exact ZenBooker-to-Square mapping remains pending without upload', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(null),
    coordinator: { registerJob: async () => assert.fail('must not coordinate') },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });

  const res = createResponse();
  await handler(createRequest(completedPayload()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending_mapping');
});

test('plain Google source is rejected when no captured paid evidence exists', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const calls = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    coordinator: { registerJob: async (value) => { calls.push(value); return { status: 'observed' }; } },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });
  const res = createResponse();
  await handler(createRequest(completedPayload({ tracking: { source: 'Google' } })), res);
  assert.equal(calls.length, 0);
  assert.equal(res.body.reason, 'NO_PAID_ACQUISITION');
});

test('captured booking attribution joins by ZenBooker customer and reaches the coordinator', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const calls = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(
      { squareCustomerId: 'square-customer-1' },
      {
        acquisition: {
          paidEvidence: true,
          paidMarker: 'gclid',
          sourceClass: 'google',
          mediumClass: 'cpc',
          hasGclid: true,
        },
      }
    ),
    coordinator: {
      registerJob: async (value) => {
        calls.push(value);
        return { status: 'observed' };
      },
    },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });
  const payload = completedPayload({ tracking: { source: 'Google' } });
  const res = createResponse();
  await handler(createRequest(payload), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'observed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].acquisition.paidEvidence, true);
  assert.equal(calls[0].acquisition.paidMarker, 'gclid');
});

test('retryable coordinator upload failure returns a retryable 503', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    coordinator: {
      registerJob: async () => ({
        status: 'upload_failed',
        retryable: true,
        errorCode: 'GOOGLE_TRANSIENT_FAILURE',
      }),
    },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });
  const res = createResponse();
  await handler(createRequest(completedPayload()), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.retryable, true);
});

test('logs and responses never contain raw job, secret, email, phone, or address', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const logs = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    coordinator: { registerJob: async () => ({ status: 'observed' }) },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(logs),
  });
  const payload = completedPayload();
  const res = createResponse();
  await handler(createRequest(payload), res);

  const rendered = JSON.stringify({ logs, body: res.body });
  for (const forbidden of [
    'test-webhook-secret',
    payload.data.id,
    payload.data.customer.email,
    payload.data.customer.phone,
    payload.data.service_address.line1,
  ]) {
    assert.equal(rendered.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('authentication and event filtering remain enforced', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const handler = createZenbookerWebhookHandler({ logger: quietLogger() });

  const unauthorized = createResponse();
  await handler(createRequest(completedPayload(), { query: { secret: 'wrong' } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const ignored = createResponse();
  await handler(createRequest(completedPayload(), { headers: { event: 'job.created' } }), ignored);
  assert.equal(ignored.body.reason, 'UNSUPPORTED_EVENT');
});

test('missing event type preserves origin compatibility for an otherwise valid completion', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const calls = [];
  const handler = createZenbookerWebhookHandler({
    attributionStore: mappedStore(),
    coordinator: {
      registerJob: async (value) => {
        calls.push(value);
        return { status: 'observed' };
      },
    },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });
  const req = createRequest(completedPayload(), { headers: {} });
  delete req.body.event;
  const res = createResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'observed');
  assert.equal(calls.length, 1);
});

test('default mode is observe and never calls Google when matching payment evidence exists', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  delete process.env.OFFLINE_CONVERSION_MODE;
  let pendingJob = null;
  let uploadCalls = 0;
  const store = {
    getBookingAttribution: async () => null,
    getJobMapping: async () => ({ squareCustomerId: 'square-customer-1' }),
    savePendingJob: async (value) => { pendingJob = value; },
    listPendingJobs: async () => pendingJob ? [{
      jobRef: 'job-ref-1',
      completedAt: pendingJob.completedAt,
      consentStatus: pendingJob.consentStatus,
      acquisition: pendingJob.acquisition,
    }] : [],
    listPayments: async () => [{
      paymentRef: 'payment-ref-1',
      status: 'COMPLETED',
      currency: 'USD',
      amount: 49950,
      refundedAmount: 0,
      completedAt: '2026-07-09T18:35:00-05:00',
    }],
    hasSuccess: async () => false,
  };
  const handler = createZenbookerWebhookHandler({
    attributionStore: store,
    uploadConversion: async () => {
      uploadCalls += 1;
      return { success: true };
    },
    disclosureVersion: '2026-07-10',
    logger: quietLogger(),
  });

  const res = createResponse();
  await handler(createRequest(completedPayload()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'observed');
  assert.equal(uploadCalls, 0);
});

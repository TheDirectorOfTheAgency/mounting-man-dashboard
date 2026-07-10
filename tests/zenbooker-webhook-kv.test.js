import assert from 'node:assert/strict';
import test from 'node:test';

import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import {
  completedPayload,
  createRequest,
  createResponse,
  installTestEnvironment,
} from './webhook-test-helpers.js';

test('KV/store failures remain retryable and never fall through to direct Google upload', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  let uploads = 0;
  const handler = createZenbookerWebhookHandler({
    attributionStore: {
      getJobMapping: async () => { throw new Error('temporary KV failure'); },
    },
    uploadConversion: async () => { uploads += 1; },
    disclosureVersion: '2026-07-10',
    logger: { info() {}, warn() {}, error() {} },
  });

  const res = createResponse();
  await handler(createRequest(completedPayload()), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.errorCode, 'ATTRIBUTION_PROCESSING_FAILED');
  assert.equal(uploads, 0);
});

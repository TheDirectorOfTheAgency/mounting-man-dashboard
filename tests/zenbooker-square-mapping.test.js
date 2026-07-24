import assert from 'node:assert/strict';
import test from 'node:test';

import { persistAttributionMapping } from '../pages/api/webhooks/zenbooker-to-square.js';

test('successful ZenBooker-to-Square results persist one mapping without logging raw IDs', async () => {
  const saved = [];
  const logs = [];
  const attributionStore = {
    async saveJobMapping(value) {
      saved.push(value);
    },
  };
  const logger = { info: (...args) => logs.push(args), error: (...args) => logs.push(args) };

  const result = await persistAttributionMapping({
    attributionStore,
    jobId: 'job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    squareBookingId: 'square-booking-sensitive',
    logger,
  });

  assert.equal(result.saved, true);
  assert.deepEqual(saved, [
    {
      jobId: 'job-sensitive',
      squareCustomerId: 'square-customer-sensitive',
      squareBookingId: 'square-booking-sensitive',
    },
  ]);
  const rendered = JSON.stringify(logs);
  for (const forbidden of ['job-sensitive', 'square-customer-sensitive', 'square-booking-sensitive']) {
    assert.equal(rendered.includes(forbidden), false);
  }
});
test('missing job or customer identifiers do not create a mapping', async () => {
  const attributionStore = { saveJobMapping: async () => assert.fail('must not save') };
  const result = await persistAttributionMapping({ attributionStore, jobId: null, squareCustomerId: null });
  assert.deepEqual(result, { saved: false, reason: 'MISSING_MAPPING_IDENTIFIER' });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeSquareError } from '../pages/api/cron/square-refresh.js';

test('square refresh errors keep status and drop request credentials', () => {
  const token = 'square-token-should-not-leak';
  const summary = summarizeSquareError({
    message: `Request failed with status code 503 Authorization Bearer ${token}`,
    code: 'ERR_BAD_RESPONSE',
    config: {
      headers: { Authorization: `Bearer ${token}` },
      url: 'https://connect.squareup.com/v2/payments?cursor=secret',
    },
    response: {
      status: 503,
      data: 'upstream connect error or disconnect/reset before headers. reset reason: overflow',
    },
  });

  assert.deepEqual(summary, { status: 503, message: 'upstream_text' });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('cursor'), false);
  assert.equal(serialized.includes('overflow'), false);
});

test('square refresh errors prefer a Square error code over the raw body', () => {
  const summary = summarizeSquareError({
    response: {
      status: 401,
      data: { errors: [{ code: 'UNAUTHORIZED', detail: 'secret detail' }] },
    },
  });
  assert.deepEqual(summary, { status: 401, message: 'UNAUTHORIZED' });
  assert.equal(JSON.stringify(summary).includes('secret detail'), false);
});

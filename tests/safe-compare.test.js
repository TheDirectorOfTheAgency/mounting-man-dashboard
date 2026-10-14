import assert from 'node:assert/strict';
import test from 'node:test';
import { hasBearer, safeEqual } from '../lib/safe-compare.js';

test('safeEqual matches only equal non-empty strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual('x', undefined), false);
});

test('hasBearer rejects when the secret is unset (no "Bearer undefined")', () => {
  assert.equal(hasBearer({ headers: { authorization: 'Bearer undefined' } }, undefined), false);
  assert.equal(hasBearer({ headers: { authorization: 'Bearer s3' } }, 's3'), true);
  assert.equal(hasBearer({ headers: {} }, 's3'), false);
});

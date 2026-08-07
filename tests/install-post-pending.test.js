import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeKvValue } from '../pages/api/install-post/pending.js';

test('decodeKvValue unwraps webhook records that were JSON-encoded twice', () => {
  const record = {
    seed: { city: 'Corcoran', 'tv-size': '55"' },
    seeds: [
      { city: 'Corcoran', 'tv-size': '55"' },
      { city: 'Corcoran', 'tv-size': '65"' },
    ],
    seedCount: 2,
  };

  assert.deepEqual(decodeKvValue(JSON.stringify(JSON.stringify(record))), record);
  assert.deepEqual(decodeKvValue(JSON.stringify(record)), record);
  assert.deepEqual(decodeKvValue(record), record);
});

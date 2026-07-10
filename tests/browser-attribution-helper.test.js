import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/tmm-attribution-v1.js', import.meta.url), 'utf8');

test('first-party helper captures ZenBooker redirect references and posts to the booking endpoint', () => {
  assert.match(source, /customer_id/);
  assert.match(source, /booking_session/);
  assert.match(source, /\/api\/attribution\/booking/);
  assert.match(source, /\/thank-you/);
});

test('first-party helper never reads or logs a raw Google click id', () => {
  assert.doesNotMatch(source, /params\.get\(['"]gclid['"]\)/);
  assert.doesNotMatch(source, /console\./);
  assert.match(source, /params\.has\(['"]gclid['"]\)/);
});

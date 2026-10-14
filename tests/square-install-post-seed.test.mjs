import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLocationIds,
  fetchRecentCompletedPayments,
  collectCronPayments,
} from '../pages/api/cron/square-install-post-seed.js';

const quiet = (t) => {
  for (const m of ['error', 'warn']) t.mock.method(console, m, () => {});
};
const fail = (status) => Object.assign(new Error('boom'), { response: { status, data: { secret: 'x' } } });
const locOf = (url) => new URL(url).searchParams.get('location_id');

test('discovery rejects + configured L0 -> scans L0 only, logs IDs only', async (t) => {
  quiet(t);
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    if (url.endsWith('/locations')) throw fail(403);
    return { data: { payments: [{ id: 'p1', status: 'COMPLETED' }, { id: 'p2', status: 'FAILED' }] } };
  };
  const out = await fetchRecentCompletedPayments({ get, configuredId: 'L0' });
  assert.deepEqual(out.map((p) => p.id), ['p1']);
  assert.deepEqual(calls.filter((u) => u.includes('/payments')).map(locOf), ['L0']);
  const logged = console.error.mock.calls.find((c) => c.arguments[0] === 'SQUARE_LOCATIONS_DISCOVERY_FAILED');
  assert.ok(logged);
  assert.deepEqual(logged.arguments[1], { status: 403, errorType: 'Error', fallbackLocationId: 'L0' });
});

test('discovery returns empty list -> configured id used', async () => {
  const get = async (url) => (url.endsWith('/locations') ? { data: { locations: [] } } : { data: {} });
  assert.deepEqual(await fetchLocationIds({ get, configuredId: 'L0' }), ['L0']);
});

test('discovery rejects + no configured id -> explicit 503 error, no throw', async (t) => {
  quiet(t);
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    throw fail(500);
  };
  const r = await collectCronPayments({ get, configuredId: '' });
  assert.deepEqual(r, { ok: false, status: 503, error: 'No Square locations available' });
  assert.equal(calls.filter((u) => u.includes('/payments')).length, 0);
});

test('one location payments failure does not stop the others', async (t) => {
  quiet(t);
  const get = async (url) => {
    if (locOf(url) === 'A') throw fail(429);
    return { data: { payments: [{ id: 'b1', status: 'COMPLETED' }] } };
  };
  const out = await fetchRecentCompletedPayments({ get, locationIds: ['A', 'B'] });
  assert.deepEqual(out.map((p) => p.id), ['b1']);
  assert.ok(console.error.mock.calls.some((c) => c.arguments[0] === 'SQUARE_LOCATION_PAYMENTS_FAILED' && c.arguments[1].locationId === 'A'));
});

test('discovery success -> every discovered location scanned', async () => {
  const seen = [];
  const get = async (url) => {
    if (url.endsWith('/locations')) return { data: { locations: [{ id: 'A' }, { id: 'B' }] } };
    seen.push(locOf(url));
    return { data: { payments: [{ id: locOf(url), status: 'COMPLETED' }] } };
  };
  const out = await fetchRecentCompletedPayments({ get, configuredId: 'L0' });
  assert.deepEqual(seen, ['A', 'B']);
  assert.deepEqual(out.map((p) => p.id), ['A', 'B']);
});

test('page cap hit logs a warning', async (t) => {
  quiet(t);
  let n = 0;
  const get = async () => ({ data: { payments: [{ id: String(n++), status: 'COMPLETED' }], cursor: 'more' } });
  const out = await fetchRecentCompletedPayments({ get, locationIds: ['A'] });
  assert.equal(out.length, 10);
  const w = console.warn.mock.calls.find((c) => c.arguments[0] === 'SQUARE_PAYMENTS_PAGE_CAP_HIT');
  assert.deepEqual(w.arguments[1], { locationId: 'A', maxPages: 10, pageLimit: 100 });
});

test('all location payments fail -> explicit 503, not ok scanned 0', async (t) => {
  quiet(t);
  const get = async () => {
    throw fail(503);
  };
  const r = await collectCronPayments({ get, locationIds: ['A', 'B'] });
  assert.deepEqual(r, { ok: false, status: 503, error: 'Square payments unavailable' });
  assert.ok(console.error.mock.calls.some((c) => c.arguments[0] === 'SQUARE_PAYMENTS_TOTAL_FAILURE'));
  assert.ok(console.error.mock.calls.filter((c) => c.arguments[0] === 'SQUARE_LOCATION_PAYMENTS_FAILED').length >= 2);
});

test('all locations succeed with zero payments -> ok empty', async () => {
  const get = async () => ({ data: { payments: [] } });
  const r = await collectCronPayments({ get, locationIds: ['A'] });
  assert.deepEqual(r, { ok: true, payments: [] });
});

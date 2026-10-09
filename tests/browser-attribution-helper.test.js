import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/tmm-attribution-v1.js', import.meta.url), 'utf8');

test('first-party helper captures ZenBooker redirect references and posts to the booking endpoint', () => {
  assert.match(source, /customer_id/);
  assert.match(source, /booking_session/);
  assert.match(source, /\/api\/attribution\/booking/);
  assert.match(source, /\/thank-you/);
});

test('first-party helper sends the click id to the booking endpoint and does not log it', () => {
  assert.match(source, /clickValue\('gclid'\)/);
  assert.match(source, /clickValue\('gbraid'\)/);
  assert.match(source, /clickValue\('wbraid'\)/);
  assert.match(source, /params\.get\(name\)/);
  assert.doesNotMatch(source, /console\./);
  assert.match(source, /gclid: storedAcquisition\.gclid/);
  assert.match(source, /wbraid: storedAcquisition\.wbraid/);
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function runHelper({ url, fetchImpl, storage = {} }) {
  const parsed = new URL(url);
  const store = { ...storage };
  const fetchCalls = [];
  const window = {
    location: { pathname: parsed.pathname, search: parsed.search },
    dataLayer: [],
  };
  const sandbox = {
    window,
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    fetch: (requestUrl, options) => {
      fetchCalls.push({ url: requestUrl, options });
      return fetchImpl(requestUrl, options);
    },
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    JSON,
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { dataLayer: JSON.parse(JSON.stringify(window.dataLayer)), fetchCalls, store };
}

function jsonResponse(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

test('thank-you pushes booking_confirmed once with hashed user_data', async () => {
  const { dataLayer, fetchCalls } = await runHelper({
    url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=sess-1',
    fetchImpl: () => jsonResponse(200, {
      found: true,
      user_data: { sha256_email_address: HASH_A, sha256_phone_number: HASH_B },
    }),
  });
  assert.deepEqual(dataLayer, [{
    event: 'booking_confirmed',
    booking_session: 'sess-1',
    user_data: { sha256_email_address: HASH_A, sha256_phone_number: HASH_B },
  }]);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/attribution\/booking-identity$/);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    customer_id: 'cust-1',
    booking_session: 'sess-1',
  });
  assert.equal(fetchCalls[0].options.credentials, 'omit');
});

test('thank-you pushes booking_confirmed without user_data when the lookup fails', async () => {
  for (const fetchImpl of [
    () => jsonResponse(404, { found: false }),
    () => jsonResponse(503, { found: false }),
    () => Promise.reject(new Error('network down')),
    () => jsonResponse(200, { found: true, user_data: { sha256_email_address: 'not-a-hash' } }),
  ]) {
    const { dataLayer } = await runHelper({
      url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=sess-1',
      fetchImpl,
    });
    assert.deepEqual(dataLayer, [{ event: 'booking_confirmed', booking_session: 'sess-1' }]);
  }
});

test('thank-you pushes booking_confirmed without user_data when the lookup exceeds the cap', async () => {
  const started = Date.now();
  const parsed = new URL('https://www.themountingman.com/thank-you?customer_id=c&booking_session=s');
  const window = { location: { pathname: parsed.pathname, search: parsed.search }, dataLayer: [] };
  let aborted = false;
  vm.runInNewContext(source, {
    window,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }),
    AbortController,
    Promise,
    setTimeout,
    JSON,
  });
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(aborted, true);
  assert.ok(Date.now() - started >= 3000);
  assert.deepEqual(JSON.parse(JSON.stringify(window.dataLayer)), [{ event: 'booking_confirmed', booking_session: 's' }]);
});

test('thank-you without booking references still pushes booking_confirmed and never calls the identity endpoint', async () => {
  const { dataLayer, fetchCalls } = await runHelper({
    url: 'https://www.themountingman.com/thank-you',
    fetchImpl: () => assert.fail('no fetch expected'),
  });
  assert.deepEqual(dataLayer, [{ event: 'booking_confirmed' }]);
  assert.equal(fetchCalls.length, 0);
});

test('pages other than thank-you push nothing', async () => {
  const { dataLayer, fetchCalls } = await runHelper({
    url: 'https://www.themountingman.com/?gclid=abc',
    fetchImpl: () => assert.fail('no fetch expected'),
  });
  assert.deepEqual(dataLayer, []);
  assert.equal(fetchCalls.length, 0);
});

test('paid capture POST finishes before identity lookup starts', async () => {
  const stored = JSON.stringify({ paidMarker: 'gclid', gclid: 'click-1', sourceClass: 'google' });
  let captureDone = false;
  const { dataLayer, fetchCalls, store } = await runHelper({
    url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=sess-1',
    storage: { tmm_paid_attribution_v1: stored },
    fetchImpl: (requestUrl) => {
      if (requestUrl.endsWith('/api/attribution/booking')) {
        captureDone = true;
        return jsonResponse(200, { captured: true });
      }
      assert.equal(captureDone, true);
      return jsonResponse(404, { found: false });
    },
  });
  assert.match(fetchCalls[0].url, /\/api\/attribution\/booking$/);
  assert.equal(JSON.parse(fetchCalls[0].options.body).gclid, 'click-1');
  assert.equal(fetchCalls[0].options.keepalive, true);
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1].url, /\/api\/attribution\/booking-identity$/);
  assert.equal('tmm_paid_attribution_v1' in store, false);
  assert.deepEqual(dataLayer, [{ event: 'booking_confirmed', booking_session: 'sess-1' }]);
});

test('unpaid thank-you calls identity immediately without waiting for capture', async () => {
  const order = [];
  const { fetchCalls } = await runHelper({
    url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=sess-1',
    fetchImpl: (requestUrl) => {
      order.push(requestUrl.endsWith('/api/attribution/booking-identity') ? 'identity' : 'other');
      return jsonResponse(404, { found: false });
    },
  });
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(order, ['identity']);
});

test('booking_confirmed fires once by 3000 ms when capture and identity hang', async () => {
  const parsed = new URL('https://www.themountingman.com/thank-you?customer_id=c&booking_session=s');
  const stored = JSON.stringify({ paidMarker: 'gclid', gclid: 'click-1' });
  const window = { location: { pathname: parsed.pathname, search: parsed.search }, dataLayer: [] };
  const started = Date.now();
  vm.runInNewContext(source, {
    window,
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key === 'tmm_paid_attribution_v1' ? stored : null),
      setItem() {},
      removeItem() {},
    },
    fetch: () => new Promise(() => {}),
    AbortController,
    Promise,
    setTimeout,
    JSON,
  });
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.ok(Date.now() - started >= 3000);
  assert.deepEqual(JSON.parse(JSON.stringify(window.dataLayer)), [{
    event: 'booking_confirmed',
    booking_session: 's',
  }]);
});

test('capture POST failure does not stop booking_confirmed', async () => {
  const stored = JSON.stringify({ paidMarker: 'gclid', gclid: 'click-1' });
  const { dataLayer } = await runHelper({
    url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=sess-1',
    storage: { tmm_paid_attribution_v1: stored },
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  assert.deepEqual(dataLayer, [{ event: 'booking_confirmed', booking_session: 'sess-1' }]);
});

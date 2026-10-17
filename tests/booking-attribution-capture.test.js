import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBookingAttributionHandler,
  normalizeCapturedAcquisition,
} from '../pages/api/attribution/booking.js';
import { createResponse } from './webhook-test-helpers.js';

function request(overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://www.themountingman.com' },
    body: {
      customer_id: 'zen-customer-sensitive',
      booking_session: 'booking-session-sensitive',
      acquisition: {
        paidMarker: 'gclid',
        sourceClass: 'Google',
        mediumClass: 'CPC',
        hasCampaign: true,
        hasLandingContext: true,
        gclid: 'raw-click-id-must-be-ignored',
      },
    },
    ...overrides,
  };
}

test('capture endpoint stores only sanitized paid evidence behind booking references', async () => {
  const saved = [];
  const logs = [];
  const handler = createBookingAttributionHandler({
    attributionStore: {
      async saveBookingAttribution(value) {
        saved.push(value);
      },
    },
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.captured, true);
  assert.match(res.body.bookingRef, /^[a-f0-9]{12}$/);
  assert.deepEqual(saved[0].acquisition, {
    paidEvidence: true,
    paidMarker: 'gclid',
    sourceClass: 'google',
    mediumClass: 'cpc',
    hasCampaign: true,
    hasLandingContext: true,
    hasGclid: true,
    hasGbraid: false,
    hasWbraid: false,
    channel: 'paid',
    campaignClass: null,
    contentClass: null,
    adPlatform: null,
    oppref: null,
    referrerHost: null,
    landingPath: null,
    firstSeenAt: null,
  });

  assert.equal(saved[0].gclid, 'raw-click-id-must-be-ignored');
  assert.equal(saved[0].gbraid, null);
  assert.equal(saved[0].zenCustomerId, 'zen-customer-sensitive');
  const rendered = JSON.stringify({ logs, response: res.body });
  assert.equal(rendered.includes('raw-click-id-must-be-ignored'), false);
  assert.equal(rendered.includes('zen-customer-sensitive'), false);
  assert.equal(rendered.includes('booking-session-sensitive'), false);
});

test('capture endpoint rejects foreign origins', async () => {
  const handler = createBookingAttributionHandler({
    attributionStore: { saveBookingAttribution: async () => assert.fail('must not save') },
    logger: { info() {}, warn() {}, error() {} },
  });

  const foreign = createResponse();
  await handler(request({ headers: { origin: 'https://example.com' } }), foreign);
  assert.equal(foreign.statusCode, 403);

});

test('capture endpoint stores a raw wbraid beside sanitized acquisition', async () => {
  const saved = [];
  const logs = [];
  const handler = createBookingAttributionHandler({
    attributionStore: {
      async saveBookingAttribution(value) {
        saved.push(value);
      },
    },
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  });
  const res = createResponse();
  await handler(request({
    body: {
      ...request().body,
      acquisition: {
        paidMarker: 'wbraid',
        sourceClass: 'google',
        mediumClass: 'cpc',
        hasLandingContext: true,
        wbraid: 'web-braid-must-not-log',
      },
      wbraid: 'web-braid-must-not-log',
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(saved[0].gclid, null);
  assert.equal(saved[0].gbraid, null);
  assert.equal(saved[0].wbraid, 'web-braid-must-not-log');
  assert.equal(saved[0].acquisition.hasWbraid, true);
  assert.equal(JSON.stringify(saved[0].acquisition).includes('web-braid-must-not-log'), false);
  assert.equal(JSON.stringify({ logs, response: res.body }).includes('web-braid-must-not-log'), false);
});

test('normalization never retains raw click identifiers', () => {
  const value = normalizeCapturedAcquisition({
    paidMarker: 'wbraid',
    sourceClass: 'Google Search!',
    mediumClass: 'Paid Search',
    wbraid: 'raw-click-id',
  });
  assert.equal(value.paidEvidence, true);
  assert.equal(value.hasWbraid, true);
  assert.equal(JSON.stringify(value).includes('raw-click-id'), false);
});

test('capture endpoint stores every unpaid session with a channel and only non-personal fields', async () => {
  const saved = [];
  const handler = createBookingAttributionHandler({
    attributionStore: { saveBookingAttribution: async (v) => { saved.push(v); return { capturedAt: '2026-10-12T20:00:00.000Z' }; } },
    logger: { info() {}, warn() {}, error() {} },
  });
  const cases = [
    [{ referrerHost: 'www.google.com', landingPath: '/samsung-frame-tv-mounting/' }, 'organic'],
    [{ sourceClass: 'google', mediumClass: 'organic', campaignClass: 'gbp', referrerHost: 'www.google.com' }, 'gbp'],
    [{ referrerHost: 'chatgpt.com' }, 'referral'],
    [{ referrerHost: 'm.yelp.com' }, 'referral'],
    [{}, 'direct'],
    [{ referrerHost: 'self' }, 'direct'],
    [{ paidMarker: 'paid_medium', sourceClass: 'bing', mediumClass: 'cpc' }, 'paid'],
  ];
  for (const [acquisition, channel] of cases) {
    const res = createResponse();
    await handler(request({ body: { customer_id: 'c-1', booking_session: 's-1', acquisition } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.channel, channel, JSON.stringify(acquisition));
  }
  const res = createResponse();
  await handler(request({ body: { customer_id: 'c-1', booking_session: 's-1', acquisition: {
    referrerHost: 'a@b', landingPath: '/x?email=a@b.com', email: 'a@b.com', phone: '6125550100',
  } } }), res);
  const last = saved.at(-1);
  assert.equal(last.acquisition.referrerHost, null);
  assert.equal(last.acquisition.landingPath, '/x');
  assert.equal(JSON.stringify(last).includes('a@b.com'), false);
  assert.equal(JSON.stringify(last).includes('6125550100'), false);
});

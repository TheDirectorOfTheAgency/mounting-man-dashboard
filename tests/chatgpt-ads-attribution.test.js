import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTouch, isEmptyTouch, sanitizeTouch, SOURCE_BUCKETS, SOURCE_LABELS } from '../lib/source-classifier.js';
import { classifyChannel, CHANNELS } from '../lib/acquisition-channel.js';
import { normalizeOppref } from '../lib/attribution-sanitize.js';
import { createBookingAttributionHandler, normalizeCapturedAcquisition } from '../pages/api/attribution/booking.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createResponse } from './webhook-test-helpers.js';

const OPPREF = 'Ab12Cd34.Ef56_Gh78~Ij90=Kl-MnOpQrSt';

test('sanitizeTouch carries contentClass, adPlatform and oppref (case preserved)', () => {
  const touch = sanitizeTouch({ utmSource: 'ChatGPT', utmMedium: 'CPC', utm_content: 'Ad_123', adPlatform: 'chatgpt_paid', oppref: OPPREF });
  assert.equal(touch.contentClass, 'ad_123');
  assert.equal(touch.adPlatform, 'chatgpt_paid');
  assert.equal(touch.oppref, OPPREF);
  assert.equal(sanitizeTouch({ contentClass: 'x1' }).contentClass, 'x1');
});

test('oppref: keeps case and charset, max 512, rejects everything else', () => {
  assert.equal(normalizeOppref(OPPREF), OPPREF);
  assert.equal(normalizeOppref('A'.repeat(512)), 'A'.repeat(512));
  assert.equal(normalizeOppref('A'.repeat(513)), '');
  for (const bad of ['abc def', 'a@b.com', 'abc%40def', 'abc/def', 'abc+def', 'abc:def', '6125550100', '612-555-0100', 'ab\u00e9cdefgh', '', null, 42, {}]) {
    assert.equal(normalizeOppref(bad), '', String(bad));
  }
  assert.equal(sanitizeTouch({ oppref: 'x@y.com' }).oppref, '');
});

const PHONE_EXTENSIONS = ['6125550100x123', '612-555-0100x123'];

test('oppref: phone numbers with extensions are rejected by the shared PII guard', () => {
  for (const bad of [...PHONE_EXTENSIONS, '612.555.0100', '612_555_0100', '612~555~0100', '1-612-555-0100', 'ref6125550100', '6125550100X9']) {
    assert.equal(normalizeOppref(bad), '', bad);
    assert.equal(sanitizeTouch({ oppref: bad }).oppref, '', bad);
  }
  // Legitimate mixed-case opaque ids survive byte for byte.
  for (const good of [OPPREF, 'aBcD-123456.EfGh_12~Zz', 'XyZ012345abcDEF', 'q-AbC.dEf~123=']) {
    assert.equal(normalizeOppref(good), good, good);
    assert.equal(sanitizeTouch({ oppref: good }).oppref, good, good);
  }
});

test('booking normalization rejects phone-extension oppref', () => {
  for (const bad of PHONE_EXTENSIONS) {
    assert.equal(normalizeCapturedAcquisition({ adPlatform: 'chatgpt_paid', oppref: bad }).oppref, null, bad);
  }
});

test('isEmptyTouch sees the new fields', () => {
  assert.equal(isEmptyTouch(sanitizeTouch({})), true);
  assert.equal(isEmptyTouch(sanitizeTouch({ oppref: OPPREF })), false);
  assert.equal(isEmptyTouch(sanitizeTouch({ adPlatform: 'chatgpt_paid' })), false);
  assert.equal(isEmptyTouch(sanitizeTouch({ contentClass: 'ad1' })), false);
});

test('paid ChatGPT is its own bucket; organic ChatGPT stays ai_assistant', () => {
  assert.ok(SOURCE_BUCKETS.includes('chatgpt_paid'));
  assert.ok(SOURCE_LABELS.chatgpt_paid);
  for (const medium of ['cpc', 'paid', 'ppc', 'paid_search', 'sem']) {
    assert.equal(classifyTouch({ utmSource: 'chatgpt', utmMedium: medium }).bucket, 'chatgpt_paid', medium);
  }
  assert.equal(classifyTouch({ utmSource: 'openai', utmMedium: 'cpc' }).bucket, 'chatgpt_paid');
  assert.equal(classifyTouch({ adPlatform: 'chatgpt_paid' }).bucket, 'chatgpt_paid');
  assert.equal(classifyTouch({ utmSource: 'chatgpt.com', utmMedium: 'referral' }).bucket, 'ai_assistant');
  assert.equal(classifyTouch({ utmSource: 'chatgpt' }).bucket, 'ai_assistant');
  assert.equal(classifyTouch({ referrerHost: 'chatgpt.com' }).bucket, 'ai_assistant');
  assert.equal(classifyTouch({ utmSource: 'perplexity', utmMedium: 'cpc' }).bucket, 'ai_assistant');
  assert.equal(classifyTouch({ utmSource: 'google', utmMedium: 'cpc' }).bucket, 'google_ads');
  // Google click ids still win.
  assert.equal(classifyTouch({ gclid: 'a'.repeat(30), utmSource: 'chatgpt', utmMedium: 'cpc' }).bucket, 'google_ads');
});

test('acquisition channel: chatgpt_paid added, Google paid unchanged', () => {
  assert.ok(CHANNELS.includes('chatgpt_paid'));
  assert.equal(classifyChannel({ paidMarker: 'paid_medium', sourceClass: 'chatgpt', mediumClass: 'cpc' }), 'chatgpt_paid');
  assert.equal(classifyChannel({ adPlatform: 'chatgpt_paid' }), 'chatgpt_paid');
  assert.equal(classifyChannel({ sourceClass: 'openai', mediumClass: 'paid' }), 'chatgpt_paid');
  assert.equal(classifyChannel({ paidMarker: 'gclid', sourceClass: 'chatgpt', mediumClass: 'cpc' }), 'paid');
  assert.equal(classifyChannel({ paidMarker: 'paid_medium', sourceClass: 'bing', mediumClass: 'cpc' }), 'paid');
  assert.equal(classifyChannel({ referrerHost: 'chatgpt.com' }), 'referral');
  assert.equal(classifyChannel({ sourceClass: 'chatgpt', mediumClass: 'referral' }), 'referral');
});

test('normalizeCapturedAcquisition carries the new fields and filters PII', () => {
  const a = normalizeCapturedAcquisition({
    paidMarker: 'paid_medium', sourceClass: 'ChatGPT', mediumClass: 'cpc', campaignClass: 'msp_v1',
    contentClass: 'Ad_77', adPlatform: 'chatgpt_paid', oppref: OPPREF,
  });
  assert.equal(a.channel, 'chatgpt_paid');
  assert.equal(a.contentClass, 'ad_77');
  assert.equal(a.adPlatform, 'chatgpt_paid');
  assert.equal(a.oppref, OPPREF);
  assert.equal(a.hasGclid, false);
  const bad = normalizeCapturedAcquisition({ contentClass: 'a@b.com', adPlatform: '612-555-0100', oppref: 'a@b.com' });
  assert.equal(bad.contentClass, null);
  assert.equal(bad.adPlatform, null);
  assert.equal(bad.oppref, null);
});

function fakeKv() {
  const values = new Map();
  return {
    values,
    set: async (k, v) => { values.set(k, structuredClone(v)); return 'OK'; },
    get: async (k) => (values.has(k) ? structuredClone(values.get(k)) : null),
    del: async () => 1, sadd: async () => 1, smembers: async () => [], expire: async () => 1,
  };
}

test('endpoint + store persist the new fields end to end without raw PII', async () => {
  const kv = fakeKv();
  const handler = createBookingAttributionHandler({
    attributionStore: createAttributionStore(kv),
    logger: { info() {}, warn() {}, error() {} },
  });
  const res = createResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://www.themountingman.com' },
    body: {
      customer_id: 'c-1', booking_session: 's-1',
      acquisition: {
        paidMarker: 'paid_medium', sourceClass: 'chatgpt', mediumClass: 'cpc', contentClass: 'ad_9',
        adPlatform: 'chatgpt_paid', oppref: OPPREF, landingPath: '/x?email=a@b.com', email: 'a@b.com', phone: '6125550100',
      },
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.channel, 'chatgpt_paid');
  const stored = [...kv.values.values()].map((v) => v?.acquisition).find(Boolean);
  assert.equal(stored.contentClass, 'ad_9');
  assert.equal(stored.adPlatform, 'chatgpt_paid');
  assert.equal(stored.oppref, OPPREF);
  assert.equal(stored.channel, 'chatgpt_paid');
  const dump = JSON.stringify([...kv.values.values()]);
  assert.equal(dump.includes('a@b.com'), false);
  assert.equal(dump.includes('6125550100'), false);
});

test('endpoint + store never persist a phone-extension oppref', async () => {
  for (const bad of PHONE_EXTENSIONS) {
    const kv = fakeKv();
    const handler = createBookingAttributionHandler({
      attributionStore: createAttributionStore(kv),
      logger: { info() {}, warn() {}, error() {} },
    });
    const res = createResponse();
    await handler({
      method: 'POST',
      headers: { origin: 'https://www.themountingman.com' },
      body: {
        customer_id: 'c-1', booking_session: 's-1',
        acquisition: { paidMarker: 'paid_medium', sourceClass: 'chatgpt', mediumClass: 'cpc', adPlatform: 'chatgpt_paid', oppref: bad },
      },
    }, res);
    assert.equal(res.statusCode, 200, bad);
    const dump = JSON.stringify([...kv.values.values()]);
    assert.equal(dump.includes(bad), false, bad);
    assert.equal(dump.includes('6125550100'), false, bad);
    assert.equal(dump.includes('612-555-0100'), false, bad);
  }
});

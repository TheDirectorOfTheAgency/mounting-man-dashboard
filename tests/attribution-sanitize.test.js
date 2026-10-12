import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {
  deepDecode, looksPersonal, normalizeLandingPath, normalizeReferrerHost, normalizeClass,
} from '../lib/attribution-sanitize.js';
import { normalizeCapturedAcquisition } from '../pages/api/attribution/booking.js';

const EMAIL_VARIANTS = [
  'jane.doe@example.com',
  'jane.doe%40example.com',
  'jane.doe%2540example.com',
  'jane.doe%252540example.com',
  'jane.doe＠example.com',
  'jane.doe%EF%BC%A0example.com',
  'jane+doe%40example.com',
  'JANE.DOE%40EXAMPLE.COM',
];
const PHONE_VARIANTS = [
  '6125550100',
  '612-555-0100',
  '612.555.0100',
  '(612) 555-0100',
  '612%20555%200100',
  '612%2D555%2D0100',
  '612%252D555%252D0100',
  '+1+612+555+0100',
  '%2B16125550100',
  '６１２５５５０１００',
  '612_555_0100',
  '612/555/0100',
];
const SECRETS = ['jane', 'doe', '6125550100', '555', '0100'];

function noSecrets(value) {
  const text = JSON.stringify(value).toLowerCase();
  for (const secret of ['jane', '612', '0100', 'example.com']) {
    assert.equal(text.includes(secret), false, `${secret} leaked in ${text}`);
  }
}

test('deepDecode is bounded and normalizes full-width characters', () => {
  assert.equal(deepDecode('a%252540b'), 'a@b');
  assert.equal(deepDecode('＠１'), '@1');
  assert.equal(deepDecode('%E0%A4%A'), deepDecode('%E0%A4%A'));
});

test('every encoded email and phone variant is detected', () => {
  for (const v of [...EMAIL_VARIANTS, ...PHONE_VARIANTS]) assert.equal(looksPersonal(v), true, v);
  for (const v of ['google', 'cpc', 'gbp', 'samsung-frame', '75-inch', '2026-fall']) assert.equal(looksPersonal(v), false, v);
});

test('landing paths become slug route templates', () => {
  assert.equal(normalizeLandingPath('/samsung-frame-tv-mounting/'), '/samsung-frame-tv-mounting/');
  assert.equal(normalizeLandingPath('/regions/twin-cities/pricing/?email=a@b.com#x'), '/regions/twin-cities/pricing/');
  assert.equal(normalizeLandingPath('/install/75-inch-frame-eden-prairie/'), '/install/75-inch-frame-eden-prairie/');
  for (const v of [...EMAIL_VARIANTS, ...PHONE_VARIANTS]) {
    const path = normalizeLandingPath(`/thank/${v}/`);
    assert.ok(path === null || path.startsWith('/thank/:'), `${v} -> ${path}`);
    noSecrets(path);
  }
  assert.equal(normalizeLandingPath('/a/AbCdEfGhIjKlMnOpQrStUvWxYz0123/'), '/a/:x/');
  assert.equal(normalizeLandingPath('/a/abcdefghijklmnopqrstuvwxyz/'), '/a/:x/');
  assert.equal(normalizeLandingPath('/job/12345/'), '/job/:n/');
  assert.equal(normalizeLandingPath('/a%2Fjane%40example.com/'), '/a/:x/');
  assert.equal(normalizeLandingPath('relative'), null);
});

test('referrer is a validated host only', () => {
  assert.equal(normalizeReferrerHost('www.google.com'), 'www.google.com');
  assert.equal(normalizeReferrerHost('https://chatgpt.com/c/abc?x=1'), 'chatgpt.com');
  assert.equal(normalizeReferrerHost('self'), 'self');
  for (const v of [
    'https://jane%40example.com@evil.com/', 'jane@example.com', 'jane%2540example.com',
    '612-555-0100.example.com', '6125550100.com', 'exa mple.com', 'localhost', 'a'.repeat(300) + '.com',
    'xn--ls8h.la/path', 'ｅｘａｍｐｌｅ＠ｇｍａｉｌ．ｃｏｍ',
  ]) {
    const host = normalizeReferrerHost(v);
    assert.ok(host === null || /^[a-z0-9.-]+$/.test(host), `${v} -> ${host}`);
    if (host) noSecrets(host);
  }
  assert.equal(normalizeReferrerHost('https://u:p@evil.com/'), null);
});

test('UTM classes drop encoded emails and phones', () => {
  assert.equal(normalizeClass('google'), 'google');
  for (const v of [...EMAIL_VARIANTS, ...PHONE_VARIANTS]) assert.equal(normalizeClass(v), null, v);
});

test('server ignores client sanitization: raw bypass payloads are normalized', () => {
  for (const email of EMAIL_VARIANTS) {
    for (const phone of PHONE_VARIANTS.slice(0, 6)) {
      const acq = normalizeCapturedAcquisition({
        sourceClass: email, mediumClass: phone, campaignClass: `${email}-${phone}`,
        referrerHost: `https://${email}/`, landingPath: `/x/${email}/${phone}/?q=${email}`,
      });
      noSecrets(acq);
    }
  }
});

const source = fs.readFileSync(new URL('../public/tmm-attribution-v1.js', import.meta.url), 'utf8');
function runLanding(url, referrer) {
  const parsed = new URL(url);
  const store = {};
  vm.runInNewContext(source, {
    window: { location: { pathname: parsed.pathname, search: parsed.search, hostname: parsed.hostname }, dataLayer: [] },
    document: { referrer },
    URLSearchParams, URL, Promise, setTimeout, clearTimeout, JSON, AbortController,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  });
  return JSON.parse(store.tmm_paid_attribution_v1);
}

test('client script stores only templates, hosts and clean classes for bypass payloads', () => {
  for (const email of EMAIL_VARIANTS) {
    for (const phone of ['612-555-0100', '612%2520555%25200100', '６１２５５５０１００']) {
      const enc = encodeURIComponent(email);
      const rec = runLanding(
        `https://www.themountingman.com/x/${enc}/${encodeURIComponent(phone)}/?utm_source=${enc}&utm_medium=${encodeURIComponent(phone)}&utm_campaign=${enc}`,
        `https://${enc}@m.yelp.com/biz/${enc}?p=${phone}`,
      );
      noSecrets(rec);
      assert.equal(rec.referrerHost === null || rec.referrerHost === 'm.yelp.com', true, rec.referrerHost);
      assert.equal(rec.landingPath, '/x/:x/:x/');
    }
  }
  const ok = runLanding('https://www.themountingman.com/samsung-frame/?utm_source=gbp', 'https://www.google.com/');
  assert.equal(ok.landingPath, '/samsung-frame/');
  assert.equal(ok.referrerHost, 'www.google.com');
  assert.equal(ok.sourceClass, 'gbp');
});

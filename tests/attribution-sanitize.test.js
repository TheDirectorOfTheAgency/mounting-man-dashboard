import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {
  looksPersonal, normalizeLandingPath, normalizeReferrerHost, normalizeClass,
} from '../lib/attribution-sanitize.js';
import { normalizeCapturedAcquisition } from '../pages/api/attribution/booking.js';
import { classifyChannel } from '../lib/acquisition-channel.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/attribution-pii-vectors.json', import.meta.url), 'utf8'));
const clientSource = fs.readFileSync(new URL('../public/tmm-attribution-v1.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../lib/attribution-sanitize.js', import.meta.url), 'utf8');
const core = (src) => src.slice(src.indexOf('/* PII-CORE-BEGIN'), src.indexOf('/* PII-CORE-END */'));
const PERSONAL = [...V.emails, ...V.phones];

function noSecrets(value, label) {
  const text = JSON.stringify(value).toLowerCase();
  for (const s of V.secrets) assert.equal(text.includes(s), false, `${s} leaked (${label}): ${text}`);
}

test('browser and server PII cores are byte-identical', () => {
  assert.ok(core(clientSource).length > 1000);
  assert.equal(core(clientSource), core(serverSource));
});

test('server: every shared personal vector is detected, safe vectors pass', () => {
  for (const v of PERSONAL) assert.equal(looksPersonal(v), true, v);
  for (const v of PERSONAL) assert.equal(normalizeClass(v), null, v);
  for (const v of V.safe) assert.equal(looksPersonal(v), false, v);
  for (const v of V.safe) assert.equal(normalizeClass(v), v);
});

test('server: paths and hosts follow the shared expectations', () => {
  for (const [input, out] of Object.entries(V.paths)) assert.equal(normalizeLandingPath(input), out, input);
  for (const [input, out] of Object.entries(V.hosts)) assert.equal(normalizeReferrerHost(input), out, input);
  for (const v of PERSONAL) {
    noSecrets(normalizeLandingPath(`/thank/${v}/`), v);
    noSecrets(normalizeLandingPath(`/${encodeURIComponent(v)}/x/`), v);
    noSecrets(normalizeReferrerHost(`https://${encodeURIComponent(v)}@m.yelp.com/`), v);
    noSecrets(normalizeReferrerHost(v), v);
  }
  assert.equal(normalizeLandingPath('/612/555/0100/'), '/:n/:n/:n/');
});

test('server ignores client sanitization: raw bypass payloads are normalized', () => {
  for (const e of V.emails) for (const p of V.phones) {
    noSecrets(normalizeCapturedAcquisition({
      sourceClass: e, mediumClass: p, campaignClass: `${e}${p}`,
      referrerHost: `https://${e}/`, landingPath: `/x/${e}/${p}/?q=${e}`,
    }), `${e} ${p}`);
  }
});

test('Google Maps short links classify as GBP', () => {
  assert.equal(classifyChannel({ referrerHost: 'maps.app.goo.gl' }), 'gbp');
  assert.equal(classifyChannel({ referrerHost: 'g.page' }), 'gbp');
});

// The client stamps firstSeenAt from the clock. With the real clock the ISO string can contain a
// phone fragment (e.g. ".612Z") and trip the leak check, so the client runs against a fixed instant.
const FIXED_NOW = Date.parse('2026-10-13T15:00:00.000Z');
const FIXED_ISO = new Date(FIXED_NOW).toISOString();
class FixedDate extends Date {
  constructor(...args) { if (args.length === 0) super(FIXED_NOW); else super(...args); }
  static now() { return FIXED_NOW; }
}

test('fixed clock timestamp contains no leak-check secret fragment', () => {
  for (const s of V.secrets) assert.equal(FIXED_ISO.toLowerCase().includes(s), false, s);
});

function runClient(url, { referrer = '', storage = {}, fetchImpl } = {}) {
  const u = new URL(url); const store = { ...storage }; const calls = [];
  vm.runInNewContext(clientSource, {
    window: { location: { pathname: u.pathname, search: u.search, hostname: u.hostname }, dataLayer: [] },
    document: { referrer }, Date: FixedDate, URLSearchParams, URL, Promise, setTimeout, clearTimeout, JSON, AbortController,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: (r, o) => { calls.push({ url: r, body: o.body }); return (fetchImpl || (() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))(r, o); },
  });
  return { store, calls };
}

test('client: shared vectors never reach localStorage via path, referrer or UTMs', () => {
  for (const v of PERSONAL) {
    const E = encodeURIComponent(v);
    for (const url of [
      `https://www.themountingman.com/x/${E}/?utm_source=${E}&utm_medium=${E}&utm_campaign=${E}`,
      `https://www.themountingman.com/${E}/?utm_campaign=ok`,
    ]) {
      const { store } = runClient(url, { referrer: `https://${E}@m.yelp.com/biz/${E}?p=${E}` });
      noSecrets(store.tmm_paid_attribution_v1, v);
    }
  }
  const { store } = runClient('https://www.themountingman.com/samsung-frame/?utm_source=gbp', { referrer: 'https://www.google.com/' });
  const rec = JSON.parse(store.tmm_paid_attribution_v1);
  assert.equal(rec.landingPath, '/samsung-frame/'); assert.equal(rec.referrerHost, 'www.google.com'); assert.equal(rec.sourceClass, 'gbp');
});

test('client: stale or legacy stored records are re-sanitized before POST', async () => {
  const dirty = JSON.stringify({ paidMarker: null, landingPath: '/x/jane.doe%40example.com/', referrerHost: 'jane@example.com', campaignClass: '612:555:0100', firstSeenAt: FIXED_ISO });
  const { calls } = runClient('https://www.themountingman.com/thank-you?customer_id=c&booking_session=s', { storage: { tmm_paid_attribution_v1: dirty } });
  await new Promise((r) => setTimeout(r, 20));
  const post = calls.find((c) => c.url.endsWith('/booking'));
  noSecrets(post.body, 'stored');
});

test('client: expired record is replaced even by a same-site navigation; legacy paid kept', () => {
  const old = JSON.stringify({ paidMarker: null, landingPath: '/old/', firstSeenAt: '2026-01-01T00:00:00Z' });
  const a = runClient('https://www.themountingman.com/pricing/', { referrer: 'https://www.themountingman.com/', storage: { tmm_paid_attribution_v1: old } });
  assert.equal(JSON.parse(a.store.tmm_paid_attribution_v1).landingPath, '/pricing/');
  const legacy = JSON.stringify({ paidMarker: 'gclid', gclid: 'abc', sourceClass: 'google' });
  const b = runClient('https://www.themountingman.com/pricing/', { referrer: 'https://www.bing.com/', storage: { tmm_paid_attribution_v1: legacy } });
  const kept = JSON.parse(b.store.tmm_paid_attribution_v1);
  assert.equal(kept.paidMarker, 'gclid'); assert.equal(kept.gclid, 'abc'); assert.ok(kept.firstSeenAt);
});

test('client: every posted booking session is remembered (bounded), not just the last', async () => {
  let storage = {};
  const post = async (s) => {
    const r = runClient(`https://www.themountingman.com/thank-you?customer_id=c&booking_session=${s}`, { storage });
    await new Promise((res) => setTimeout(res, 20));
    storage = r.store;
    return r.calls.filter((c) => c.url.endsWith('/booking')).length;
  };
  assert.equal(await post('A'), 1);
  assert.equal(await post('B'), 1);
  assert.equal(await post('A'), 0);
  for (let i = 0; i < 40; i += 1) await post(`S${i}`);
  assert.ok(JSON.parse(storage.tmm_attribution_sent_v1).length <= 25);
});

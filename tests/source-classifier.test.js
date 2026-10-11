import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTouch, classifyVisit, sanitizeTouch } from '../lib/source-classifier.js';

const cases = [
  {
    name: 'google ads gclid',
    touch: { gclid: 'abc', referrerHost: 'www.google.com', referrerPath: '/search' },
    bucket: 'google_ads',
  },
  {
    name: 'google ads gbraid',
    touch: { gbraid: 'braid-1' },
    bucket: 'google_ads',
  },
  {
    name: 'google ads wbraid',
    touch: { wbraid: 'web-1' },
    bucket: 'google_ads',
  },
  {
    name: 'google ads utm medium cpc',
    touch: { utmMedium: 'cpc', utmSource: 'google' },
    bucket: 'google_ads',
  },
  {
    name: 'google organic referrer',
    touch: { referrerHost: 'www.google.com', referrerPath: '/search' },
    bucket: 'google_organic',
  },
  {
    name: 'google business profile utm',
    touch: { utmSource: 'google', utmMedium: 'organic', utmCampaign: 'gbp' },
    bucket: 'google_business_profile',
  },
  {
    name: 'google maps referrer',
    touch: { referrerHost: 'maps.google.com', referrerPath: '/maps' },
    bucket: 'google_business_profile',
  },
  {
    name: 'google maps path',
    touch: { referrerHost: 'www.google.com', referrerPath: '/maps/place/x' },
    bucket: 'google_business_profile',
  },
  {
    name: 'bing',
    touch: { referrerHost: 'www.bing.com', referrerPath: '/search' },
    bucket: 'bing_other_search',
  },
  {
    name: 'duckduckgo',
    touch: { referrerHost: 'duckduckgo.com' },
    bucket: 'bing_other_search',
  },
  {
    name: 'chatgpt referrer',
    touch: { referrerHost: 'chatgpt.com', referrerPath: '/' },
    bucket: 'ai_assistant',
  },
  {
    name: 'chatgpt utm source',
    touch: { utmSource: 'chatgpt.com' },
    bucket: 'ai_assistant',
  },
  {
    name: 'perplexity',
    touch: { referrerHost: 'www.perplexity.ai' },
    bucket: 'ai_assistant',
  },
  {
    name: 'gemini',
    touch: { referrerHost: 'gemini.google.com' },
    bucket: 'ai_assistant',
  },
  {
    name: 'copilot',
    touch: { utmSource: 'copilot' },
    bucket: 'ai_assistant',
  },
  {
    name: 'claude',
    touch: { referrerHost: 'claude.ai' },
    bucket: 'ai_assistant',
  },
  {
    name: 'grok',
    touch: { referrerHost: 'grok.x.ai' },
    bucket: 'ai_assistant',
  },
  {
    name: 'yelp',
    touch: { referrerHost: 'www.yelp.com' },
    bucket: 'yelp',
  },
  {
    name: 'angi',
    touch: { utmSource: 'angi' },
    bucket: 'angi',
  },
  {
    name: 'thumbtack',
    touch: { referrerHost: 'www.thumbtack.com' },
    bucket: 'thumbtack',
  },
  {
    name: 'facebook',
    touch: { referrerHost: 'l.facebook.com' },
    bucket: 'facebook_instagram',
  },
  {
    name: 'instagram',
    touch: { utmSource: 'instagram' },
    bucket: 'facebook_instagram',
  },
  {
    name: 'email',
    touch: { utmMedium: 'email', utmSource: 'newsletter' },
    bucket: 'email',
  },
  {
    name: 'direct',
    touch: {},
    bucket: 'direct',
  },
  {
    name: 'other referral keeps host',
    touch: { referrerHost: 'news.example.com', referrerPath: '/story' },
    bucket: 'other_referral',
    detail: 'news.example.com',
  },
];

for (const item of cases) {
  test(item.name, () => {
    const result = classifyTouch(item.touch);
    assert.equal(result.bucket, item.bucket);
    assert.equal(result.detail, item.detail || null);
  });
}

test('paid medium follows the source instead of defaulting to google ads', () => {
  assert.equal(classifyTouch({ utmSource: 'facebook', utmMedium: 'cpc' }).bucket, 'facebook_instagram');
  assert.equal(classifyTouch({ utmSource: 'instagram', utmMedium: 'ppc' }).bucket, 'facebook_instagram');
  assert.equal(classifyTouch({ utmSource: 'meta', utmMedium: 'paid' }).bucket, 'facebook_instagram');
  assert.equal(classifyTouch({ utmSource: 'bing', utmMedium: 'ppc' }).bucket, 'bing_other_search');
  assert.equal(classifyTouch({ utmSource: 'microsoft', utmMedium: 'cpc' }).bucket, 'bing_other_search');
  assert.equal(classifyTouch({ utmSource: 'google', utmMedium: 'cpc' }).bucket, 'google_ads');
  assert.equal(classifyTouch({ utmSource: 'facebook', utmMedium: 'cpc', gclid: 'click-1' }).bucket, 'google_ads');
});

test('first touch stays put when the latest visit is a new source', () => {
  const visit = classifyVisit({
    first: { referrerHost: 'chatgpt.com' },
    last: { utmSource: 'google', utmMedium: 'organic', utmCampaign: 'gbp' },
  });
  assert.equal(visit.firstTouch.bucket, 'ai_assistant');
  assert.equal(visit.lastTouch.bucket, 'google_business_profile');
});

test('sanitized touches drop contact fields and self referrals', () => {
  const touch = sanitizeTouch({
    email: 'person@example.com',
    phone: '6125550100',
    name: 'Marshall',
    referrerHost: 'www.themountingman.com',
    landingPath: '/book?email=person@example.com',
    gclid: 'ok-click',
  });
  const rendered = JSON.stringify(touch);
  assert.equal(rendered.includes('person@example.com'), false);
  assert.equal(rendered.includes('6125550100'), false);
  assert.equal(rendered.includes('Marshall'), false);
  assert.equal(touch.referrerHost, '');
  assert.equal(touch.landingPath, '');
  assert.equal(touch.gclid, 'ok-click');
  assert.equal(classifyTouch(touch).bucket, 'google_ads');
});

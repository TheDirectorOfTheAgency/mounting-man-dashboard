import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GET_ADS_SUMMARY,
  buildAdsSpoken,
  getAdsSummary,
  rankWasteSearchTerms,
  resolveAdsDateRange,
} from '../lib/car-tools-ads.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const SECRET = 'test-mcp-secret';
const FAKE_TOKEN = 'ya29.fake-access-token-should-never-appear';

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

function authorized(body) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, accept: 'application/json' },
    body,
  };
}

function mockQueryGoogleAds(fixtures) {
  return async (gaql) => {
    const query = String(gaql);
    if (query.includes('FROM customer WHERE') && query.includes('conversion_action_name')) {
      return fixtures.conversionRows || [];
    }
    if (query.includes('FROM customer WHERE')) {
      return fixtures.overallRows || [];
    }
    if (query.includes('search_term_view')) {
      return fixtures.searchTermRows || [];
    }
    if (query.includes('primary_status')) {
      return fixtures.statusRows || [];
    }
    if (query.includes('FROM campaign WHERE') && query.includes('segments.date')) {
      return fixtures.campaignRows || [];
    }
    throw new Error(`Unexpected GAQL in test: ${query}`);
  };
}

test('resolveAdsDateRange maps America/Chicago ranges', () => {
  assert.deepEqual(resolveAdsDateRange('today', NOW), {
    range: 'today',
    start: '2026-10-07',
    end: '2026-10-07',
  });
  assert.deepEqual(resolveAdsDateRange('yesterday', NOW), {
    range: 'yesterday',
    start: '2026-10-06',
    end: '2026-10-06',
  });
  assert.deepEqual(resolveAdsDateRange('last_7_days', NOW), {
    range: 'last_7_days',
    start: '2026-10-01',
    end: '2026-10-07',
  });
});

test('rankWasteSearchTerms keeps top spenders with zero conversions', () => {
  const ranked = rankWasteSearchTerms([
    { search_term: 'cheap tv mount', spend: 12.5, clicks: 4, conversions: 0 },
    { search_term: 'samsung frame install', spend: 45.2, clicks: 9, conversions: 0 },
    { search_term: 'tv mounting near me', spend: 30, clicks: 6, conversions: 1 },
    { search_term: 'handyman tv', spend: 40, clicks: 8, conversions: 0 },
    { search_term: 'free install', spend: 5, clicks: 2, conversions: 0 },
    { search_term: 'mantel mount pro', spend: 38, clicks: 7, conversions: 0 },
  ], 3);
  assert.deepEqual(ranked.map((row) => row.search_term), [
    'samsung frame install',
    'handyman tv',
    'mantel mount pro',
  ]);
  assert.equal(ranked[0].spend, 45.2);
  assert.equal(ranked.every((row) => row.conversions === 0), true);
});

test('getAdsSummary reports zero spend with spoken text', async () => {
  const feed = await getAdsSummary({ range: 'today' }, {
    now: NOW,
    queryGoogleAds: mockQueryGoogleAds({
      overallRows: [{ metrics: { costMicros: 0, clicks: 0, impressions: 0, conversions: 0, phoneCalls: 0 } }],
      campaignRows: [],
      conversionRows: [],
      searchTermRows: [],
      statusRows: [],
    }),
  });
  assert.equal(feed.tool, GET_ADS_SUMMARY);
  assert.equal(feed.overall.spend, 0);
  assert.equal(feed.overall.clicks, 0);
  assert.equal(feed.overall.impressions, 0);
  assert.equal(feed.overall.conversions, 0);
  assert.match(feed.spoken, /zero dollars today/i);
  assert.match(feed.spoken, /no clicks or impressions/i);
  assert.equal(/[#*`|]/.test(feed.spoken), false);
  assert.equal(feed.spoken.includes('http'), false);
});

test('getAdsSummary degrades on API error without leaking tokens', async () => {
  const feed = await getAdsSummary({ range: 'today' }, {
    now: NOW,
    logger: { error() {} },
    queryGoogleAds: async () => {
      throw new Error(`Google Ads API 401: Request had invalid authentication credentials. Bearer ${FAKE_TOKEN}`);
    },
  });
  assert.equal(feed.error, true);
  assert.match(feed.spoken, /not available right now/i);
  const serialized = JSON.stringify(feed);
  assert.equal(serialized.includes(FAKE_TOKEN), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('ya29'), false);
});

test('getAdsSummary surfaces possible waste and conversion actions in spoken output', async () => {
  const feed = await getAdsSummary({ range: 'last_7_days' }, {
    now: NOW,
    queryGoogleAds: mockQueryGoogleAds({
      overallRows: [{
        metrics: {
          costMicros: 12_500_000,
          clicks: 20,
          impressions: 400,
          conversions: 2,
          phoneCalls: 1,
        },
      }],
      campaignRows: [{
        campaign: { name: 'MSP - General TV Mounting', status: 'ENABLED' },
        metrics: {
          costMicros: 12_500_000,
          clicks: 20,
          impressions: 400,
          conversions: 2,
          phoneCalls: 1,
        },
      }],
      conversionRows: [{
        segments: { conversionActionName: 'Booked Appointment', conversionActionCategory: 'BOOK_APPOINTMENT' },
        metrics: { conversions: 1, phoneCalls: 0 },
      }, {
        segments: { conversionActionName: 'Phone Call from Ad Extension', conversionActionCategory: 'PHONE_CALL' },
        metrics: { conversions: 1, phoneCalls: 1 },
      }],
      searchTermRows: [
        {
          searchTermView: { searchTerm: 'samsung frame installer' },
          metrics: { costMicros: 4_500_000, clicks: 8, conversions: 0 },
        },
        {
          searchTermView: { searchTerm: 'tv mounting minneapolis' },
          metrics: { costMicros: 3_000_000, clicks: 5, conversions: 1 },
        },
        {
          searchTermView: { searchTerm: 'cheap tv mount' },
          metrics: { costMicros: 2_000_000, clicks: 4, conversions: 0 },
        },
      ],
      statusRows: [
        { campaign: { name: 'DC - General TV Mounting', status: 'PAUSED', primaryStatus: 'PAUSED', primaryStatusReasons: ['CAMPAIGN_PAUSED'] } },
        { campaign: { name: 'MSP - Samsung Frame', status: 'ENABLED', primaryStatus: 'LIMITED', primaryStatusReasons: ['BUDGET_CONSTRAINED'] } },
      ],
    }),
  });
  assert.equal(feed.overall.spend, 12.5);
  assert.equal(feed.overall.conversions, 2);
  assert.equal(feed.calls.phone_call_conversions, 1);
  assert.deepEqual(
    [...feed.calls.conversion_actions_counted].sort(),
    ['Booked Appointment', 'Phone Call from Ad Extension'].sort(),
  );
  assert.deepEqual(feed.possible_waste.map((row) => row.search_term), [
    'samsung frame installer',
    'cheap tv mount',
  ]);
  assert.match(feed.spoken, /12 dollars and 50 cents/);
  assert.match(feed.spoken, /Booked Appointment/);
  assert.match(feed.spoken, /Phone call conversions totaled 1/);
  assert.match(feed.spoken, /samsung frame installer/);
  assert.match(feed.spoken, /could block these later/i);
  assert.match(feed.spoken, /Paused campaigns right now: DC - General TV Mounting/);
  assert.match(feed.spoken, /Budget-limited campaigns right now: MSP - Samsung Frame/);
});

test('MCP handler returns spoken text for get_ads_summary', async () => {
  const handler = createMountingManZenbookerHandler({
    env: { MCP_SQUARE_PAYROLL_SECRET: SECRET },
    client: null,
    now: NOW,
    logger: { error() {} },
    queryGoogleAds: mockQueryGoogleAds({
      overallRows: [{ metrics: { costMicros: 5_000_000, clicks: 3, impressions: 50, conversions: 0, phoneCalls: 0 } }],
      campaignRows: [],
      conversionRows: [],
      searchTermRows: [],
      statusRows: [],
    }),
  });
  const res = response();
  await handler(authorized({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: GET_ADS_SUMMARY, arguments: { range: 'today' } },
  }), res);
  assert.equal(res.statusCode, 200);
  const feed = res.body.result.structuredContent;
  assert.equal(res.body.result.content[0].text, feed.spoken);
  assert.equal(feed.overall.spend, 5);
  assert.match(feed.spoken, /5 dollars today/);
});

test('buildAdsSpoken handles empty campaigns and waste gracefully', () => {
  const spoken = buildAdsSpoken({
    range: 'yesterday',
    overall: { spend: 0, clicks: 0, impressions: 0, conversions: 0, phone_calls: 0, cost_per_conversion: null },
    campaigns: [],
    conversion_actions: [],
    possible_waste: [],
    campaign_status: { paused: [], budget_limited: [] },
  });
  assert.match(spoken, /zero dollars yesterday/i);
});

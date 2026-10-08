import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GET_MISSED_CALLS,
  GET_NEW_LEADS,
  GET_NEW_REVIEWS,
  SOURCES_NOT_CONNECTED,
  createCallRailClient,
  createGooglePlacesClient,
  getMissedCalls,
  getNewLeads,
  getNewReviews,
  isCallRailConfigured,
  isGooglePlacesConfigured,
  maskPhone,
  resolveSince,
  suggestReviewReply,
} from '../lib/car-tools-inbound.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const SECRET = 'test-mcp-secret';
const CALLRAIL_KEY = 'callrail-secret-key-12345';
const PLACES_KEY = 'places-secret-key-67890';

function logger() {
  const entries = [];
  return {
    entries,
    error(tag, meta) {
      entries.push({ tag, meta });
    },
  };
}

function zenbookerJob(overrides = {}) {
  return {
    id: '1710000000000x730395',
    job_number: '730395',
    start_date: '2026-10-08T14:00:00.000Z',
    created_at: '2026-10-07T12:00:00.000Z',
    created_by: 'customer',
    status: 'scheduled',
    canceled: false,
    service_name: 'TV Mounting',
    customer: { name: 'Pat Waconia', phone: '6125550101' },
    service_address: { line1: '100 Main St', city: 'Waconia', state: 'MN', postal_code: '55387' },
    ...overrides,
  };
}

test('credential helpers reflect env presence', () => {
  assert.equal(isCallRailConfigured({}), false);
  assert.equal(isCallRailConfigured({ CALLRAIL_API_KEY: 'x', CALLRAIL_ACCOUNT_ID: '1' }), true);
  assert.equal(isGooglePlacesConfigured({}), false);
  assert.equal(isGooglePlacesConfigured({
    GOOGLE_PLACES_API_KEY: 'x',
    GOOGLE_PLACE_ID: 'ChIJ',
  }), true);
});

test('resolveSince defaults to start of today and supports seven-day lookback', () => {
  const today = resolveSince({}, NOW);
  assert.equal(today.since_date, '2026-10-07');
  const week = resolveSince({}, NOW, { defaultDaysBack: 7 });
  assert.equal(week.since_date, '2026-09-30');
  const explicit = resolveSince({ since: '2026-10-05' }, NOW);
  assert.equal(explicit.since_date, '2026-10-05');
});

test('get_missed_calls without CallRail says not connected', async () => {
  const log = logger();
  const result = await getMissedCalls({}, { now: NOW, env: {}, logger: log });
  assert.equal(result.connected, false);
  assert.equal(result.calls.length, 0);
  assert.match(result.spoken, /not connected yet/i);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('get_missed_calls happy path returns unanswered calls and voicemails', async () => {
  const calls = [
    {
      id: 'CAL1',
      direction: 'inbound',
      answered: false,
      voicemail: false,
      customer_name: 'Sam Lake',
      customer_phone_number: '6125550199',
      start_time: '2026-10-07T16:00:00.000Z',
      source_name: 'Google Ads',
    },
    {
      id: 'CAL2',
      direction: 'inbound',
      answered: false,
      voicemail: true,
      customer_name: 'Voicemail Pat',
      customer_phone_number: '6125550200',
      start_time: '2026-10-07T17:30:00.000Z',
      formatted_tracking_source: 'Website',
      transcription: 'Hi, I need a Frame mount.',
    },
    {
      id: 'CAL3',
      direction: 'inbound',
      answered: true,
      voicemail: false,
      customer_name: 'Answered',
      customer_phone_number: '6125550300',
      start_time: '2026-10-07T18:00:00.000Z',
    },
    {
      id: 'CAL4',
      direction: 'inbound',
      answered: false,
      voicemail: false,
      customer_name: 'Too Early',
      customer_phone_number: '6125550400',
      start_time: '2026-10-06T18:00:00.000Z',
    },
  ];
  const client = {
    async listCalls() { return calls; },
    async listFormSubmissions() { return []; },
  };
  const result = await getMissedCalls({}, { now: NOW, callRailClient: client });
  assert.equal(result.connected, true);
  assert.deepEqual(result.calls.map((call) => call.id), ['CAL2', 'CAL1']);
  assert.equal(result.calls[0].tel_link, 'tel:+16125550200');
  assert.equal(result.calls[0].voicemail, true);
  assert.match(result.calls[0].transcription, /Frame mount/);
  assert.match(result.spoken, /voicemail/i);
  assert.match(result.spoken, /Sam Lake/);
  assert.equal(result.spoken.includes('http'), false);
});

test('get_missed_calls empty result speaks clearly', async () => {
  const client = { async listCalls() { return []; } };
  const result = await getMissedCalls({}, { now: NOW, callRailClient: client });
  assert.equal(result.calls.length, 0);
  assert.match(result.spoken, /no missed calls/i);
});

test('get_missed_calls API error degrades without leaking the key', async () => {
  const log = logger();
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async text() { return JSON.stringify({ error: `bad token ${CALLRAIL_KEY}` }); },
  });
  const client = createCallRailClient({
    apiKey: CALLRAIL_KEY,
    accountId: 'ACC123',
    fetchImpl,
  });
  const result = await getMissedCalls({}, { now: NOW, callRailClient: client, logger: log });
  assert.equal(result.degraded, true);
  assert.equal(result.calls.length, 0);
  assert.match(result.spoken, /could not load missed calls/i);
  assert.equal(JSON.stringify(result).includes(CALLRAIL_KEY), false);
  assert.equal(JSON.stringify(log.entries).includes(CALLRAIL_KEY), false);
});

test('get_new_leads without connected sources still lists unavailable marketplaces', async () => {
  const result = await getNewLeads({}, { now: NOW, client: null, callRailClient: null });
  assert.deepEqual(result.sources_not_connected, SOURCES_NOT_CONNECTED);
  assert.equal(result.leads.length, 0);
  assert.match(result.spoken, /no new leads/i);
});

test('get_new_leads merges ZenBooker online bookings and CallRail leads', async () => {
  const zenbookerClient = {
    async listJobs() {
      return [
        zenbookerJob(),
        zenbookerJob({
          id: '1710000000000x2',
          job_number: '730396',
          created_at: '2026-10-07T13:00:00.000Z',
          created_by: 'staff',
          customer: { name: 'Staff Booked', phone: '6125550999' },
        }),
        zenbookerJob({
          id: '1710000000000x3',
          job_number: '730397',
          created_at: '2026-10-08T08:00:00.000Z',
          created_by: 'customer',
          customer: { name: 'Future Pat', phone: '6125550101' },
        }),
      ];
    },
  };
  const callRailClient = {
    async listFormSubmissions() {
      return [{
        id: 'FOR1',
        submitted_at: '2026-10-07T14:30:00.000Z',
        source_name: 'Organic Search',
        form_name: 'Contact',
        form_data: {
          Name: 'Form Lead',
          Phone: '6125550101',
        },
      }];
    },
    async listCalls() {
      return [{
        id: 'CAL9',
        direction: 'inbound',
        customer_name: 'First Timer',
        customer_phone_number: '6125550606',
        start_time: '2026-10-07T15:30:00.000Z',
        source: 'Google Organic',
      }];
    },
  };
  const result = await getNewLeads({}, {
    now: NOW,
    client: zenbookerClient,
    callRailClient,
  });
  const kinds = result.leads.map((lead) => `${lead.source}:${lead.kind}`);
  assert.equal(kinds.includes('ZenBooker:online_booking'), true);
  assert.equal(kinds.includes('CallRail:form_submission'), true);
  assert.equal(kinds.includes('CallRail:first_time_caller'), true);
  assert.equal(result.leads.find((lead) => lead.name === 'Staff Booked'), undefined);
  const bookedLead = result.leads.find((lead) => lead.name === 'Form Lead');
  assert.equal(bookedLead.has_booked_job, true);
  const callerLead = result.leads.find((lead) => lead.name === 'First Timer');
  assert.equal(callerLead.has_booked_job, false);
  assert.match(result.spoken, /no booked job yet/i);
});

test('get_new_leads CallRail API error degrades without leaking key', async () => {
  const log = logger();
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    async text() { return `server error for ${CALLRAIL_KEY}`; },
  });
  const callRailClient = createCallRailClient({
    apiKey: CALLRAIL_KEY,
    accountId: 'ACC123',
    fetchImpl,
  });
  const result = await getNewLeads({}, {
    now: NOW,
    client: null,
    callRailClient,
    logger: log,
  });
  assert.equal(result.degraded, true);
  assert.equal(JSON.stringify(result).includes(CALLRAIL_KEY), false);
});

test('get_new_reviews without Google Places says not connected', async () => {
  const result = await getNewReviews({}, { now: NOW, placesClient: null });
  assert.equal(result.connected, false);
  assert.equal(result.reviews.length, 0);
  assert.match(result.spoken, /not connected yet/i);
  assert.match(result.review_limit_note, /up to five recent reviews/i);
});

test('get_new_reviews happy path filters by since and suggests owner-voice replies', async () => {
  const placesClient = {
    async getPlaceReviews() {
      return {
        displayName: { text: 'The Mounting Man' },
        reviews: [
          {
            rating: 5,
            publishTime: '2026-10-06T12:00:00.000Z',
            text: { text: 'Marshall did an amazing Frame install.' },
            authorAttribution: { displayName: 'Alex Johnson' },
          },
          {
            rating: 2,
            publishTime: '2026-09-01T12:00:00.000Z',
            text: { text: 'Late arrival.' },
            authorAttribution: { displayName: 'Chris Lee' },
          },
        ],
      };
    },
  };
  const result = await getNewReviews({}, { now: NOW, placesClient });
  assert.equal(result.connected, true);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].reviewer_first_name, 'Alex');
  assert.equal(result.reviews[0].stars, 5);
  assert.match(result.reviews[0].suggested_reply, /thank you/i);
  assert.match(result.spoken, /Alex/);
  assert.equal(result.spoken.includes('http'), false);
});

test('get_new_reviews API error degrades without leaking key', async () => {
  const log = logger();
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    async text() { return JSON.stringify({ error: PLACES_KEY }); },
  });
  const placesClient = createGooglePlacesClient({
    apiKey: PLACES_KEY,
    placeId: 'ChIJtest',
    fetchImpl,
  });
  const result = await getNewReviews({}, { now: NOW, placesClient, logger: log });
  assert.equal(result.degraded, true);
  assert.equal(JSON.stringify(result).includes(PLACES_KEY), false);
  assert.match(result.spoken, /could not load Google reviews/i);
});

test('suggestReviewReply stays friendly for low and high ratings', () => {
  const great = suggestReviewReply({ rating: 5, text: 'Perfect mount', reviewerFirstName: 'Amy' });
  assert.match(great, /thank you/i);
  const low = suggestReviewReply({ rating: 2, text: 'Issue', reviewerFirstName: 'Bob' });
  assert.match(low, /sorry/i);
  assert.match(low, /Marshall/i);
});

test('maskPhone hides digits except last four', () => {
  assert.equal(maskPhone('6125550101'), '***0101');
});

test('CallRail client only performs GET requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ calls: [], total_pages: 1 });
      },
    };
  };
  const client = createCallRailClient({
    apiKey: 'key',
    accountId: 'ACC',
    fetchImpl,
  });
  await client.listCalls({ startDate: '2026-10-07', endDate: '2026-10-07' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/calls\.json/);
  assert.equal(calls[0].url.includes('key'), false);
});

test('handler exposes car tools and returns spoken text for voice', async () => {
  const handler = createMountingManZenbookerHandler({
    env: { MCP_SQUARE_PAYROLL_SECRET: SECRET },
    client: null,
    callRailClient: null,
    placesClient: null,
    now: NOW,
    logger: { error() {} },
  });
  const listed = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  }, listed);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.equal(names.includes(GET_MISSED_CALLS), true);
  assert.equal(names.includes(GET_NEW_LEADS), true);
  assert.equal(names.includes(GET_NEW_REVIEWS), true);

  const called = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: GET_MISSED_CALLS, arguments: {} },
    },
  }, called);
  assert.equal(called.body.result.content[0].text, called.body.result.structuredContent.spoken);
  assert.match(called.body.result.content[0].text, /not connected yet/i);
});

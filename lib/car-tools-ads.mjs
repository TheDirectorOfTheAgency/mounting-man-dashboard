// Read-only Google Ads summary for voice (Tesla / Grok). No mutations.

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';
import { chicagoDateString } from './square-reporting-feed.mjs';

export const GET_ADS_SUMMARY = 'get_ads_summary';
export const ADS_TIMEZONE = 'America/Chicago';

const GOOGLE_ADS_API_VERSION = 'v20';
const CUSTOMER_ID = '1287907452';
const VALID_RANGES = new Set(['today', 'yesterday', 'last_7_days']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const SOURCE = {
  business: 'The Mounting Man',
  source: 'Google Ads',
  timezone: ADS_TIMEZONE,
};

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainSpeech(text) {
  return String(text || '')
    .replace(/[\n\r]+/g, '. ')
    .replace(/[#*`|_]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function speakMoney(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'an unknown amount';
  const rounded = Math.round(value * 100) / 100;
  const dollars = Math.trunc(rounded);
  const cents = Math.abs(Math.round((rounded - dollars) * 100));
  if (cents === 0) return `${dollars} dollars`;
  return `${dollars} dollars and ${cents} cents`;
}

function subtractCalendarDays(dateStr, days) {
  const match = DATE_RE.exec(String(dateStr || '').trim());
  if (!match) return null;
  const utc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) - Number(days),
  ));
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveAdsDateRange(range, now = new Date()) {
  const key = range == null || range === '' ? 'today' : String(range).trim().toLowerCase();
  if (!VALID_RANGES.has(key)) {
    throw codedError('invalid_range', 'range must be today, yesterday, or last_7_days');
  }
  const end = chicagoDateString(now);
  if (!end) throw codedError('invalid_range', 'range must be today, yesterday, or last_7_days');
  let start = end;
  if (key === 'yesterday') {
    start = subtractCalendarDays(end, 1);
    return { range: key, start, end: start };
  }
  if (key === 'last_7_days') {
    start = subtractCalendarDays(end, 6);
  }
  return { range: key, start, end };
}

export function microsToDollars(micros) {
  return Math.round((Number(micros || 0) / 1_000_000) * 100) / 100;
}

export function roundMetric(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export function rankWasteSearchTerms(rows, limit = 5) {
  const waste = rows
    .map((row) => ({
      search_term: row.search_term,
      spend: roundMetric(row.spend),
      clicks: Number(row.clicks || 0),
      conversions: Number(row.conversions || 0),
    }))
    .filter((row) => row.search_term && row.spend > 0 && row.conversions <= 0)
    .sort((a, b) => b.spend - a.spend);
  return waste.slice(0, limit);
}

function speakRangeLabel(range) {
  if (range === 'today') return 'today';
  if (range === 'yesterday') return 'yesterday';
  return 'over the last 7 days';
}

function loginCustomerId(env) {
  return env?.GOOGLE_ADS_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3167428631';
}

export function createGoogleAdsQueryClient(env = process.env, deps = {}) {
  if (typeof deps.queryGoogleAds === 'function') {
    return { query: deps.queryGoogleAds };
  }
  const fetchImpl = deps.fetchImpl;
  return {
    async query(gaql) {
      const developerToken = getDeveloperToken();
      const accessToken = await getAccessToken();
      const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${CUSTOMER_ID}/googleAds:searchStream`;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': loginCustomerId(env),
      };
      let response;
      if (typeof fetchImpl === 'function') {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: gaql }),
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 200)}`);
        }
        response = { data: JSON.parse(text) };
      } else {
        response = await axios.post(url, { query: gaql }, { headers });
      }
      const results = [];
      if (Array.isArray(response.data)) {
        for (const batch of response.data) {
          if (batch.results) results.push(...batch.results);
        }
      }
      return results;
    },
  };
}

function aggregateMetrics(rows, prefix = 'metrics') {
  let spendMicros = 0;
  let clicks = 0;
  let impressions = 0;
  let conversions = 0;
  let phoneCalls = 0;
  for (const row of rows) {
    const metrics = row[prefix] || row.metrics || {};
    spendMicros += Number(metrics.costMicros || 0);
    clicks += Number(metrics.clicks || 0);
    impressions += Number(metrics.impressions || 0);
    conversions += Number(metrics.conversions || 0);
    phoneCalls += Number(metrics.phoneCalls || 0);
  }
  const spend = microsToDollars(spendMicros);
  const costPerConversion = conversions > 0 ? roundMetric(spend / conversions) : null;
  return {
    spend,
    clicks,
    impressions,
    conversions: roundMetric(conversions),
    phone_calls: phoneCalls,
    cost_per_conversion: costPerConversion,
  };
}

function mapCampaignRows(rows) {
  const byName = new Map();
  for (const row of rows) {
    const name = row.campaign?.name || 'Unknown';
    const existing = byName.get(name) || {
      name,
      status: row.campaign?.status || 'UNKNOWN',
      spend: 0,
      clicks: 0,
      impressions: 0,
      conversions: 0,
      phone_calls: 0,
    };
    const metrics = row.metrics || {};
    existing.spend += microsToDollars(metrics.costMicros);
    existing.clicks += Number(metrics.clicks || 0);
    existing.impressions += Number(metrics.impressions || 0);
    existing.conversions += Number(metrics.conversions || 0);
    existing.phone_calls += Number(metrics.phoneCalls || 0);
    byName.set(name, existing);
  }
  return [...byName.values()]
    .map((campaign) => ({
      ...campaign,
      spend: roundMetric(campaign.spend),
      conversions: roundMetric(campaign.conversions),
      cost_per_conversion: campaign.conversions > 0
        ? roundMetric(campaign.spend / campaign.conversions)
        : null,
    }))
    .sort((a, b) => b.spend - a.spend);
}

function mapConversionActions(rows) {
  const byName = new Map();
  for (const row of rows) {
    const name = row.segments?.conversionActionName || 'Unknown conversion';
    const category = row.segments?.conversionActionCategory || null;
    const metrics = row.metrics || {};
    const existing = byName.get(name) || {
      name,
      category,
      conversions: 0,
      phone_calls: 0,
    };
    existing.conversions += Number(metrics.conversions || 0);
    existing.phone_calls += Number(metrics.phoneCalls || 0);
    byName.set(name, existing);
  }
  return [...byName.values()]
    .map((action) => ({
      ...action,
      conversions: roundMetric(action.conversions),
    }))
    .filter((action) => action.conversions > 0 || action.phone_calls > 0)
    .sort((a, b) => b.conversions - a.conversions || b.phone_calls - a.phone_calls);
}

function mapSearchTermRows(rows) {
  const byTerm = new Map();
  for (const row of rows) {
    const term = row.searchTermView?.searchTerm || row.search_term_view?.searchTerm;
    if (!term) continue;
    const metrics = row.metrics || {};
    const existing = byTerm.get(term) || { search_term: term, spend: 0, clicks: 0, conversions: 0 };
    existing.spend += microsToDollars(metrics.costMicros);
    existing.clicks += Number(metrics.clicks || 0);
    existing.conversions += Number(metrics.conversions || 0);
    byTerm.set(term, existing);
  }
  return [...byTerm.values()];
}

function mapCampaignStatusRows(rows) {
  const paused = [];
  const budgetLimited = [];
  for (const row of rows) {
    const name = row.campaign?.name;
    if (!name) continue;
    const status = row.campaign?.status;
    const reasons = row.campaign?.primaryStatusReasons || [];
    if (status === 'PAUSED') paused.push(name);
    const limited = row.campaign?.primaryStatus === 'LIMITED'
      || reasons.includes('BUDGET_CONSTRAINED')
      || reasons.includes('BUDGET_LIMITED');
    if (limited && status === 'ENABLED') budgetLimited.push(name);
  }
  return {
    paused: [...new Set(paused)],
    budget_limited: [...new Set(budgetLimited)],
  };
}

export function buildAdsSpoken({
  range,
  overall,
  campaigns,
  conversion_actions,
  possible_waste,
  campaign_status,
}) {
  const when = speakRangeLabel(range);
  const parts = [];
  if (overall.spend <= 0 && overall.clicks === 0 && overall.impressions === 0) {
    parts.push(`Google Ads spent zero dollars ${when} with no clicks or impressions.`);
  } else {
    parts.push(
      `Google Ads spent ${speakMoney(overall.spend)} ${when} on ${overall.clicks} clicks and ${overall.impressions} impressions.`,
    );
    if (overall.conversions > 0) {
      const cpc = overall.cost_per_conversion != null ? speakMoney(overall.cost_per_conversion) : 'an unknown amount';
      parts.push(`There were ${overall.conversions} conversions at about ${cpc} each.`);
    } else {
      parts.push('There were no conversions in this range.');
    }
  }
  if (overall.phone_calls > 0) {
    parts.push(`Phone call conversions totaled ${overall.phone_calls}.`);
  }
  if (conversion_actions.length) {
    const names = conversion_actions.map((action) => action.name).join(', ');
    parts.push(`Conversions counted these actions: ${names}.`);
  } else if (overall.conversions > 0) {
    parts.push('Conversions were recorded but no conversion action names were returned.');
  }
  if (campaigns.length) {
    const top = campaigns.slice(0, 3).map((campaign) => {
      const conv = campaign.conversions > 0 ? `${campaign.conversions} conversions` : 'no conversions';
      return `${campaign.name} at ${speakMoney(campaign.spend)} with ${conv}`;
    });
    parts.push(`Top campaigns: ${top.join('; ')}.`);
  }
  if (campaign_status.paused.length) {
    parts.push(`Paused campaigns right now: ${campaign_status.paused.join(', ')}.`);
  }
  if (campaign_status.budget_limited.length) {
    parts.push(`Budget-limited campaigns right now: ${campaign_status.budget_limited.join(', ')}.`);
  }
  if (possible_waste.length) {
    const terms = possible_waste.map((row) => `${row.search_term} at ${speakMoney(row.spend)}`).join(', ');
    parts.push(
      `Possible waste search terms with spend but no conversions: ${terms}. You could block these later, but this tool cannot change anything.`,
    );
  }
  return plainSpeech(parts.join(' '));
}

async function fetchAdsSummaryData(client, start, end) {
  const between = `segments.date BETWEEN '${start}' AND '${end}'`;
  const [
    overallRows,
    campaignRows,
    conversionRows,
    searchTermRows,
    statusRows,
  ] = await Promise.all([
    client.query(
      `SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.phone_calls FROM customer WHERE ${between}`,
    ),
    client.query(
      `SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.phone_calls FROM campaign WHERE ${between} AND campaign.status != 'REMOVED'`,
    ),
    client.query(
      `SELECT segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.phone_calls FROM customer WHERE ${between} AND metrics.conversions > 0`,
    ),
    client.query(
      `SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE ${between} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 200`,
    ),
    client.query(
      `SELECT campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED')`,
    ),
  ]);
  return {
    overall: aggregateMetrics(overallRows),
    campaigns: mapCampaignRows(campaignRows),
    conversion_actions: mapConversionActions(conversionRows),
    possible_waste: rankWasteSearchTerms(mapSearchTermRows(searchTermRows)),
    campaign_status: mapCampaignStatusRows(statusRows),
  };
}

export async function getAdsSummary(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const env = deps.env || process.env;
  const { range, start, end } = resolveAdsDateRange(args.range, now);
  const client = createGoogleAdsQueryClient(env, deps);
  try {
    const data = await fetchAdsSummaryData(client, start, end);
    const spoken = buildAdsSpoken({ range, ...data });
    return {
      ...SOURCE,
      tool: GET_ADS_SUMMARY,
      range,
      start_date: start,
      end_date: end,
      as_of: now.toISOString(),
      overall: data.overall,
      campaigns: data.campaigns,
      conversion_actions: data.conversion_actions,
      calls: {
        phone_call_conversions: data.overall.phone_calls,
        conversion_actions_counted: data.conversion_actions.map((action) => action.name),
      },
      possible_waste: data.possible_waste,
      campaign_status: data.campaign_status,
      spoken,
      source: 'google-ads-api',
    };
  } catch (error) {
    deps.logger?.error?.('car_ads_summary_failed', { message: error.message });
    const spoken = plainSpeech(
      'Google Ads numbers are not available right now. Try again in a few minutes.',
    );
    return {
      ...SOURCE,
      tool: GET_ADS_SUMMARY,
      range,
      start_date: start,
      end_date: end,
      as_of: now.toISOString(),
      error: true,
      message: 'Google Ads summary unavailable',
      spoken,
      source: 'error',
    };
  }
}

export const GET_ADS_SUMMARY_TOOL = {
  name: GET_ADS_SUMMARY,
  description:
    "How are the ads doing. Use this when Marshall asks how are the ads doing, what did I spend on ads today, how Google Ads performed yesterday, or ad spend over the last week. Read-only Google Ads summary for The Mounting Man in America/Chicago. Returns spend, clicks, impressions, conversions, cost per conversion, phone call conversions when available, which conversion actions were counted, per-campaign breakdown, paused or budget-limited campaigns, and the top 5 search terms with spend but zero conversions as possible waste. Includes a spoken field with plain sentences and no URLs. Does not change bids, budgets, keywords, or campaigns.",
  inputSchema: {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: ['today', 'yesterday', 'last_7_days'],
        description: 'Date range in America/Chicago. Defaults to today.',
      },
    },
  },
};

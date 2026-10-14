// Tracking fix #6: per-campaign booked jobs, paid jobs and spend.
//
// Google does the click→campaign join: Booked Appointment (thank-you tag,
// keyed by booking_session) and Offline Job Completed (Square net revenue
// uploaded with the click ID) are both attributed to the campaign of the
// click. We read them per campaign with all_conversions so secondary actions
// (Offline Job Completed stays secondary for now) are included.
//
// Caveat shown on the dashboard: offline conversions are dated by the ad click
// (Google's conversion-time attribution uses the click date), and data before
// 2026-10-10 is weak, so the default window starts there.

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';

const CUSTOMER_ID = '1287907452';
export const BOOKED_ACTION_ID = '6491204814';
export const PAID_ACTION_ID = '7509313857';
export const RELIABLE_SINCE = '2026-10-10';

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round2 = (value) => Math.round(value * 100) / 100;

export function reportWindow({ from, to } = {}, today = new Date()) {
  const end = isDate(to) ? to : today.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const start = isDate(from) ? from : RELIABLE_SINCE;
  return start <= end ? { from: start, to: end } : { from: end, to: end };
}

export function buildCampaignRows({ spendRows = [], conversionRows = [], bookedActionId = BOOKED_ACTION_ID, paidActionId = PAID_ACTION_ID }) {
  const byId = new Map();
  const row = (campaign) => {
    const id = String(campaign?.id || '');
    if (!byId.has(id)) {
      byId.set(id, { campaignId: id, name: campaign?.name || id, status: campaign?.status || null, spend: 0, clicks: 0, bookedJobs: 0, paidJobs: 0, paidRevenue: 0 });
    }
    return byId.get(id);
  };
  for (const r of spendRows) {
    const target = row(r.campaign);
    target.spend += num(r.metrics?.costMicros) / 1e6;
    target.clicks += num(r.metrics?.clicks);
  }
  for (const r of conversionRows) {
    const action = String(r.segments?.conversionAction || '').split('/').pop();
    const target = row(r.campaign);
    if (action === bookedActionId) target.bookedJobs += num(r.metrics?.allConversions);
    if (action === paidActionId) {
      target.paidJobs += num(r.metrics?.allConversions);
      target.paidRevenue += num(r.metrics?.allConversionsValue);
    }
  }
  const rows = [...byId.values()]
    .map((r) => ({
      ...r,
      spend: round2(r.spend),
      bookedJobs: round2(r.bookedJobs),
      paidJobs: round2(r.paidJobs),
      paidRevenue: round2(r.paidRevenue),
      costPerPaidJob: r.paidJobs > 0 ? round2(r.spend / r.paidJobs) : null,
      paidRoas: r.spend > 0 ? round2(r.paidRevenue / r.spend) : null,
    }))
    .filter((r) => r.spend > 0 || r.bookedJobs > 0 || r.paidJobs > 0)
    .sort((a, b) => b.spend - a.spend);
  const totals = rows.reduce((t, r) => ({
    spend: round2(t.spend + r.spend),
    bookedJobs: round2(t.bookedJobs + r.bookedJobs),
    paidJobs: round2(t.paidJobs + r.paidJobs),
    paidRevenue: round2(t.paidRevenue + r.paidRevenue),
  }), { spend: 0, bookedJobs: 0, paidJobs: 0, paidRevenue: 0 });
  return { rows, totals };
}

export async function fetchCampaignJobsReport({
  from,
  to,
  env = process.env,
  httpClient = axios,
  getToken = getAccessToken,
  getDevToken = getDeveloperToken,
} = {}) {
  const window = reportWindow({ from, to });
  const apiVersion = env.GOOGLE_ADS_API_VERSION || 'v24';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getToken()}`,
    'developer-token': getDevToken(),
    'login-customer-id': env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3167428631',
  };
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${CUSTOMER_ID}/googleAds:searchStream`;
  const run = async (query) => {
    const response = await httpClient.post(url, { query }, { headers, timeout: 20000 });
    return (Array.isArray(response.data) ? response.data : []).flatMap((batch) => batch.results || []);
  };
  const during = `segments.date BETWEEN '${window.from}' AND '${window.to}'`;
  const [spendRows, conversionRows] = await Promise.all([
    run(`SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks FROM campaign WHERE ${during}`),
    run(`SELECT campaign.id, campaign.name, campaign.status, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ${during} AND segments.conversion_action IN ('customers/${CUSTOMER_ID}/conversionActions/${BOOKED_ACTION_ID}', 'customers/${CUSTOMER_ID}/conversionActions/${PAID_ACTION_ID}')`),
  ]);
  return {
    window,
    reliableSince: RELIABLE_SINCE,
    note: 'Booked = Booked Appointment; Paid = Offline Job Completed (Square net revenue, secondary). Dated by ad click.',
    ...buildCampaignRows({ spendRows, conversionRows }),
    generatedAt: new Date().toISOString(),
  };
}

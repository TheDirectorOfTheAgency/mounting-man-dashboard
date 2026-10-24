// Daily Booked Appointment zero-check. Schedule 14:40 UTC (9:40 AM CDT / 8:40 AM CST).
// Read-only on Google Ads (searchStream). Dry run: Bearer $CRON_SECRET and ?dryRun=1.
import axios from 'axios';
import { deliverQAlert } from '../../../lib/q-alert.js';
import { hasBearer } from '../../../lib/safe-compare.js';
import { getAccessToken, getDeveloperToken } from '../../../lib/google-ads-auth.js';
import { createZenbookerReadClientFromEnv } from '../../../lib/zenbooker-jobs-feed.mjs';
import { ADS_CUSTOMER_ID, runBookedAppointmentMonitor } from '../../../lib/booked-appointment-monitor.js';

const API_VERSION = 'v20';
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3167428631';

async function queryAds(query) {
  const accessToken = await getAccessToken();
  const developerToken = getDeveloperToken();
  if (!accessToken || !developerToken) { const e = new Error('ads_unconfigured'); e.code = 'ads_unconfigured'; throw e; }
  const res = await axios.post(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${ADS_CUSTOMER_ID}/googleAds:searchStream`,
    { query },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': LOGIN_CUSTOMER_ID }, timeout: 15000 },
  );
  const rows = [];
  for (const batch of Array.isArray(res.data) ? res.data : []) if (batch.results) rows.push(...batch.results);
  return rows;
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!hasBearer(req, process.env.CRON_SECRET || '')) return res.status(401).json({ error: 'Unauthorized' });
    const flag = String(req.query?.dryRun || req.query?.validateOnly || '').toLowerCase();
    const dryRun = flag === '1' || flag === 'true' || flag === 'yes';
    const zb = deps.listJobs ? null : createZenbookerReadClientFromEnv();
    const summary = await runBookedAppointmentMonitor({
      queryAds: deps.queryAds || queryAds,
      listJobs: deps.listJobs || (async (a) => { if (!zb) { const e = new Error('zb'); e.code = 'zenbooker_unconfigured'; throw e; } return zb.listJobs({ ...a, maxPages: 10 }); }),
      alert: deps.alert || ((p) => deliverQAlert(p)),
      dryRun,
    });
    console.log('booked_appointment_monitor', JSON.stringify({ ...summary }));
    return res.status(200).json(summary);
  };
}

export default createHandler();

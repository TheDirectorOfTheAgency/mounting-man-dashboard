// GET /api/ads/campaign-jobs?from=YYYY-MM-DD&to=YYYY-MM-DD
// Per-campaign booked jobs, paid jobs (Square net) and spend. Tracking fix #6.
import { fetchCampaignJobsReport } from '../../../lib/campaign-jobs-report.js';
import { sourceReportAuthorized } from '../attribution/sources.js';

let cache = null;
const CACHE_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Same gate as the JOBS BY SOURCE report: dashboard same-origin fetch or operator bearer.
  if (!sourceReportAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const key = `${req.query?.from || ''}|${req.query?.to || ''}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return res.status(200).json(cache.data);
  try {
    const data = await fetchCampaignJobsReport({ from: req.query?.from, to: req.query?.to });
    cache = { key, at: Date.now(), data };
    return res.status(200).json(data);
  } catch (error) {
    console.error('campaign_jobs_report_failed', error?.response?.status || error?.name || 'Error');
    return res.status(502).json({ error: 'Google Ads report unavailable' });
  }
}

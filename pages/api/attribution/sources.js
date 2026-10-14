import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { buildSourceReport, uniqueSourceJobs } from '../../../lib/job-source.js';
import { SOURCE_LABELS } from '../../../lib/source-classifier.js';
import { headerValue, isAuthorizedMcpRequest } from '../../../lib/mcp-http.mjs';

// Callers: the dashboard panel "JOBS BY SOURCE" (same-origin browser fetch from
// components/Dashboard.js) and operator tools with
// Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET|CRON_SECRET>.
// Cross-site and header-less (curl/scraper) requests get 401.
// The dashboard page itself has no login, so the same-origin path is a gate
// against cross-site reads and casual scraping, not user authentication.
function hostOf(value) {
  try { return new URL(String(value)).host.toLowerCase(); } catch { return ''; }
}

export function isSameOriginDashboardRequest(req) {
  const host = String(headerValue(req?.headers, 'x-forwarded-host') || headerValue(req?.headers, 'host') || '').toLowerCase();
  if (!host) return false;
  const site = String(headerValue(req?.headers, 'sec-fetch-site') || '').toLowerCase();
  if (site !== 'same-origin') return false;
  const origin = headerValue(req?.headers, 'origin');
  const referer = headerValue(req?.headers, 'referer');
  if (!origin && !referer) return true;
  const claimed = origin ? hostOf(origin) : hostOf(referer);
  return claimed === host;
}

export function sourceReportAuthorized(req, env = process.env) {
  return isAuthorizedMcpRequest(req, env) || isSameOriginDashboardRequest(req);
}

let cachedKV;
async function getDefaultKV() {
  if (cachedKV !== undefined) return cachedKV;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    cachedKV = null;
    return cachedKV;
  }
  const { kv } = await import('@vercel/kv');
  cachedKV = kv;
  return cachedKV;
}

export function createSourceReportHandler({ attributionStore, kvClient, env = process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    if (!sourceReportAuthorized(req, env)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      let store = attributionStore;
      if (!store) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (!activeKV) {
          return res.status(200).json({ months: [], storage: 'unavailable', labels: SOURCE_LABELS });
        }
        store = createAttributionStore(activeKV);
      }
      const months = await store.listSourceMonths();
      const records = [];
      for (const month of months) {
        const rows = await store.listJobSources(month);
        records.push(...rows);
      }
      const report = buildSourceReport(uniqueSourceJobs(records));
      return res.status(200).json({ ...report, labels: SOURCE_LABELS });
    } catch {
      return res.status(200).json({ months: [], storage: 'unavailable', labels: SOURCE_LABELS });
    }
  };
}

export default createSourceReportHandler();

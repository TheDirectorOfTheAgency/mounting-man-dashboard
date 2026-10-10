import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { buildSourceReport } from '../../../lib/job-source.js';
import { SOURCE_LABELS } from '../../../lib/source-classifier.js';

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

export function createSourceReportHandler({ attributionStore, kvClient } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
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
      const report = buildSourceReport(records);
      return res.status(200).json({ ...report, labels: SOURCE_LABELS });
    } catch {
      return res.status(200).json({ months: [], storage: 'unavailable', labels: SOURCE_LABELS });
    }
  };
}

export default createSourceReportHandler();

// One-shot keys-only dump of conversion_summary on the 3 newest Zenbooker jobs.
// Authorization matches the other crons. The JSON body is paths, types, and
// emptiness only — never click IDs, URLs, or other values.

import {
  loadAndLogRecent,
  publicProbeResponse,
} from '../../../lib/conversion-summary-keys.js';

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = req.headers?.authorization || '';
  const authorizedByBearer = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;
  const authorizedByVercelCron = Boolean(req.headers?.['x-vercel-cron']);
  return authorizedByBearer || authorizedByVercelCron;
}

export function createConversionSummaryKeysHandler({
  probe = loadAndLogRecent,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ logged: false, error: 'Method not allowed' });
    }
    if (!authorized(req)) return res.status(401).json({ logged: false, error: 'Unauthorized' });
    try {
      const probes = await probe();
      return res.status(200).json(publicProbeResponse(probes));
    } catch (error) {
      console.error('ZB_CONV_SUMMARY_KEYS_FETCH_FAILED', {
        errorType: error?.name || 'Error',
        errorCode: error?.code || null,
        status: error?.status || null,
      });
      return res.status(200).json({
        logged: false,
        reason: error?.code || 'upstream_error',
      });
    }
  };
}

export default createConversionSummaryKeysHandler();

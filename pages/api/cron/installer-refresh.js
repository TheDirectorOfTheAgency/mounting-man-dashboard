// Re-read unassigned ZenBooker jobs and store the current installer.
// Schedule: */30 12-23,0-3 * * * UTC. That span covers 7:00 AM–9:00 PM
// America/Chicago in both CDT and CST. Runs outside 7:00–21:00 Chicago
// return immediately. ?force=1 runs the refresh anyway (manual check).
// Does not create Square customers, orders, or invoices.
//
// The project already deploys a */5 cron, so this 30-minute job is inside
// the Pro per-minute cron allowance (100 jobs per project).

import { deliverQAlert } from '../../../lib/q-alert.js';
import { fetchZenbookerJob } from '../../../lib/zenbooker-assignment.js';
import {
  INSTALLER_AUDIT_TTL_SECONDS,
  isInstallerRefreshHours,
  listStoredAudits,
  refreshUnassignedInstallers,
} from '../../../lib/installer-refresh.js';
import { resolveTechAssignment } from '../webhooks/zenbooker-to-square.js';

export const config = { maxDuration: 60 };

function authorized(req, env = process.env) {
  const cronSecret = env.CRON_SECRET || '';
  return Boolean(cronSecret) && req.headers?.authorization === `Bearer ${cronSecret}`;
}

function publicRow(row) {
  return {
    jobNumber: row.jobNumber || null,
    providerName: row.providerName || null,
    assignmentMode: row.assignmentMode || null,
    status: row.status,
  };
}

export function createInstallerRefreshHandler({
  env = process.env,
  now = () => Date.now(),
  loadKv,
  loadJob = (jobId) => fetchZenbookerJob(jobId, { env }),
  resolveTech = resolveTechAssignment,
  alert = deliverQAlert,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!authorized(req, env)) return res.status(401).json({ error: 'Unauthorized' });

    const forced = req.query?.force === '1';
    const at = new Date(now());
    if (!forced && !isInstallerRefreshHours(at)) {
      return res.status(200).json({ skipped: true, reason: 'outside_chicago_window' });
    }

    const kv = typeof loadKv === 'function'
      ? await loadKv()
      : (await import('@vercel/kv')).kv;
    if (!kv) return res.status(500).json({ error: 'KV not available' });

    const audits = await listStoredAudits(kv);
    const rows = await refreshUnassignedInstallers({
      audits,
      loadJob,
      resolveTech,
      alert,
      now: at.getTime(),
    });

    for (const row of rows) {
      if (!row.audit) continue;
      await kv.set(`zb2sq:${row.jobId}`, row.audit, { ex: INSTALLER_AUDIT_TTL_SECONDS });
    }

    return res.status(200).json({
      ok: true,
      forced,
      scanned: audits.length,
      checked: rows.filter((row) => row.status === 'checked').length,
      updated: rows.filter((row) => row.updated).map(publicRow),
      alerted: rows.filter((row) => row.alerted).map(publicRow),
      unavailable: rows.filter((row) => row.status === 'zenbooker_unavailable').length,
    });
  };
}

export default createInstallerRefreshHandler();

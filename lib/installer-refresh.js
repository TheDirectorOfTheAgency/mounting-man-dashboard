// Re-read unassigned ZenBooker jobs and store the current installer.
// Does not create Square customers, orders, or invoices.

import {
  UNASSIGNED_ALERT_GRACE_MS,
  applyAssignment,
  assignmentChanged,
  isUnassignedProviderName,
  planUnassignedAlert,
  providersFromJobLike,
} from './zenbooker-assignment.js';

export const INSTALLER_REFRESH_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
export const INSTALLER_AUDIT_TTL_SECONDS = 7776000;
const AUDIT_PREFIX = 'zb2sq:';
const SKIP_KEYS = new Set(['zb2sq:review-index', 'zb2sq:failure-index']);

export function chicagoMinutes(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return hour * 60 + Number(parts.minute);
}

// 7:00 AM through 9:00 PM America/Chicago, inclusive of the 9:00 PM tick.
export function isInstallerRefreshHours(now = new Date()) {
  const minutes = chicagoMinutes(now);
  return minutes >= 7 * 60 && minutes <= 21 * 60;
}

export function jobInInstallerRefreshWindow(scheduledAt, now = Date.now()) {
  const time = Date.parse(scheduledAt || '');
  if (Number.isNaN(time)) return false;
  const delta = time - now;
  return delta <= INSTALLER_REFRESH_LOOKAHEAD_MS && delta >= -UNASSIGNED_ALERT_GRACE_MS;
}

function scanPage(result) {
  if (Array.isArray(result)) return { cursor: result[0], keys: result[1] || [] };
  return { cursor: result?.cursor, keys: result?.keys || [] };
}

export async function listStoredAudits(kv, { limit = 2000 } = {}) {
  const audits = [];
  let cursor = '0';
  do {
    const page = scanPage(await kv.scan(cursor, { match: `${AUDIT_PREFIX}*`, count: 100 }));
    cursor = String(page.cursor ?? '0');
    for (const key of page.keys) {
      if (!key || SKIP_KEYS.has(key) || !key.startsWith(AUDIT_PREFIX)) continue;
      const value = await kv.get(key);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const jobId = value.jobId || key.slice(AUDIT_PREFIX.length);
      if (!jobId) continue;
      audits.push({ ...value, jobId });
      if (audits.length >= limit) return audits;
    }
  } while (cursor !== '0');
  return audits;
}

function startFromJob(job, fallback) {
  const value = job?.start_date || job?.start || job?.scheduled_at || job?.appointment?.start || null;
  return value || fallback || null;
}

export async function refreshUnassignedInstallers({
  audits = [],
  loadJob,
  resolveTech,
  alert,
  now = Date.now(),
} = {}) {
  const rows = [];
  for (const audit of audits) {
    if (!isUnassignedProviderName(audit?.providerName)) continue;
    const storedStart = audit.scheduledAt || null;
    if (storedStart && !jobInInstallerRefreshWindow(storedStart, now)) continue;

    const job = typeof loadJob === 'function' ? await loadJob(audit.jobId) : null;
    if (!job) {
      rows.push({
        jobId: audit.jobId,
        jobNumber: audit.jobNumber || null,
        status: 'zenbooker_unavailable',
        updated: false,
        alerted: false,
      });
      continue;
    }

    const scheduledAt = startFromJob(job, storedStart);
    if (!jobInInstallerRefreshWindow(scheduledAt, now)) {
      rows.push({
        jobId: audit.jobId,
        jobNumber: audit.jobNumber || null,
        status: 'outside_window',
        updated: false,
        alerted: false,
      });
      continue;
    }

    const provider = providersFromJobLike(job)[0] || { name: null, email: null };
    const lookedUp = resolveTech(provider.name);
    let assignment = applyAssignment(audit, {
      providerName: provider.name,
      providerEmail: provider.email || null,
      assignmentMode: lookedUp.assignmentMode,
      techSquareId: lookedUp.techSquareId,
      resolvedProviderName: lookedUp.resolvedProviderName,
      scheduledAt,
      assignmentSource: 'zenbooker_api',
      confirmed: true,
    });

    let alerted = false;
    if (planUnassignedAlert({
      providerName: assignment.providerName,
      scheduledAt: assignment.scheduledAt,
      alreadyAlerted: Boolean(assignment.unassignedAlertedAt),
      now,
    })) {
      try {
        await alert({
          kind: 'unassigned_job_soon',
          subject: `Unassigned job ${audit.jobNumber || audit.jobId} starts within 2h`,
          body: [
            `Job ${audit.jobNumber || audit.jobId} is still unassigned after a ZenBooker check.`,
            assignment.scheduledAt ? `Starts: ${assignment.scheduledAt}` : null,
          ].filter(Boolean).join('\n'),
        });
        assignment = { ...assignment, unassignedAlertedAt: new Date(now).toISOString() };
        alerted = true;
      } catch (error) {
        console.error('[q-alert] unassigned job alert failed', error.message);
      }
    }

    const next = { ...audit, ...assignment };
    const updated = assignmentChanged(audit, assignment)
      || (audit.scheduledAt || null) !== (assignment.scheduledAt || null);
    rows.push({
      jobId: audit.jobId,
      jobNumber: audit.jobNumber || null,
      providerName: assignment.providerName,
      assignmentMode: assignment.assignmentMode,
      status: 'checked',
      updated,
      alerted,
      audit: updated || alerted ? next : null,
    });
  }
  return rows;
}

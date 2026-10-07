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

export async function listUpcomingZenbookerJobs({
  env = process.env,
  now = Date.now(),
  fetchImpl = fetch,
  timeoutMs = 8000,
  maxPages = 5,
} = {}) {
  const apiKey = String(env?.ZENBOOKER_API_KEY || '').trim();
  if (!apiKey) return [];
  const base = String(env?.ZENBOOKER_BASE_URL || 'https://api.zenbooker.com/v1').replace(/\/$/, '');
  const min = new Date(now - UNASSIGNED_ALERT_GRACE_MS).toISOString();
  const max = new Date(now + INSTALLER_REFRESH_LOOKAHEAD_MS).toISOString();
  const jobs = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      start_date_min: min,
      start_date_max: max,
      start: min.slice(0, 10),
      end: max.slice(0, 10),
      limit: '100',
    });
    if (cursor != null && cursor !== '') params.set('cursor', String(cursor));
    const response = await fetchImpl(`${base}/jobs?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return jobs;
    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    jobs.push(...results);
    if (!data?.has_more) break;
    cursor = data.cursor ?? data.next_cursor ?? null;
    if (cursor == null) break;
  }
  return jobs.filter((job) => job && !job.canceled && jobInInstallerRefreshWindow(job.start_date, now));
}

export async function loadStoredAuditsForJobs(kv, jobs = []) {
  const pairs = [];
  for (const job of jobs) {
    const jobId = job?.id;
    if (!jobId) continue;
    const value = await kv.get(`${AUDIT_PREFIX}${jobId}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    pairs.push({
      audit: { ...value, jobId: value.jobId || jobId },
      job,
    });
  }
  return pairs;
}

function startFromJob(job, fallback) {
  const value = job?.start_date || job?.start || job?.scheduled_at || job?.appointment?.start || null;
  return value || fallback || null;
}

export async function refreshUnassignedInstallers({
  audits = [],
  pairs = null,
  loadJob,
  resolveTech,
  alert,
  now = Date.now(),
} = {}) {
  const rows = [];
  const items = pairs || audits.map((audit) => ({ audit, job: null }));
  for (const item of items) {
    const audit = item.audit;
    if (!isUnassignedProviderName(audit?.providerName)) continue;
    const storedStart = audit.scheduledAt || null;
    if (!item.job && storedStart && !jobInInstallerRefreshWindow(storedStart, now)) continue;

    const job = item.job || (typeof loadJob === 'function' ? await loadJob(audit.jobId) : null);
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

// Installer assignment from a ZenBooker webhook, refreshed from GET /jobs/{id}
// when the payload has no provider. job.service_providers.assigned is the
// event ZenBooker sends after creation; it needs its own webhook subscription.

const DEFAULT_BASE_URL = 'https://api.zenbooker.com/v1';
const ASSIGNMENT_EVENTS = new Set([
  'job.service_providers.assigned',
  'job.updated',
  'provider.assigned',
  'job.provider.assigned',
]);
const UNASSIGNED_LABELS = new Set(['unassigned', 'not assigned', 'none', 'n/a', 'null']);

export const UNASSIGNED_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UNASSIGNED_ALERT_GRACE_MS = 2 * 60 * 60 * 1000;

function zenbookerId(value) {
  return /^\d{8,}x\d+/.test(String(value || '').trim());
}

export function providerRecord(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const name = entry.trim();
    if (!name || zenbookerId(name)) return null;
    return { name, email: null };
  }
  const name = entry.name || entry.full_name || entry.display_name || null;
  if (!name || !String(name).trim() || zenbookerId(name)) return null;
  return { name: String(name).trim(), email: entry.email || null };
}

export function providersFromJobLike(source) {
  if (!source || typeof source !== 'object') return [];
  for (const list of [source.assigned_providers, source.service_providers, source.providers]) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const records = list.map(providerRecord).filter(Boolean);
    if (records.length > 0) return records;
  }
  return [];
}

export function extractWebhookProvider(payload) {
  const candidates = [payload?.data?.job, payload?.data, payload?.job, payload].filter(Boolean);
  for (const source of candidates) {
    const providers = providersFromJobLike(source);
    if (providers.length > 0) return providers[0];
    const name = source.assigned_provider?.name || source.provider?.name || source.provider_name;
    if (name && String(name).trim()) {
      return {
        name: String(name).trim(),
        email: source.assigned_provider?.email || source.provider?.email || null,
      };
    }
  }
  return { name: null, email: null };
}

export function isAssignmentEvent(eventType) {
  return ASSIGNMENT_EVENTS.has(String(eventType || '').trim().toLowerCase());
}

export function isUnassignedProviderName(providerName) {
  if (!providerName) return true;
  return UNASSIGNED_LABELS.has(String(providerName).toLowerCase().trim());
}

export function startsWithinHours(scheduledAt, now = Date.now(), hours = 24) {
  const time = Date.parse(scheduledAt || '');
  if (Number.isNaN(time)) return false;
  const delta = time - now;
  return delta <= hours * 60 * 60 * 1000 && delta >= -UNASSIGNED_ALERT_GRACE_MS;
}

export function planUnassignedAlert({
  providerName,
  scheduledAt,
  alreadyAlerted = false,
  dryRun = false,
  now = Date.now(),
} = {}) {
  if (dryRun || alreadyAlerted || !isUnassignedProviderName(providerName)) return false;
  return startsWithinHours(scheduledAt, now);
}

export async function fetchZenbookerJob(jobId, {
  env = process.env,
  httpClient,
  timeoutMs = 4000,
} = {}) {
  const apiKey = String(env?.ZENBOOKER_API_KEY || '').trim();
  if (!apiKey || !jobId) return null;
  const base = String(env?.ZENBOOKER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${base}/jobs/${encodeURIComponent(jobId)}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };
  try {
    if (httpClient?.get) {
      const response = await httpClient.get(url, { headers, timeout: timeoutMs });
      return response?.data || null;
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('zenbooker_job_refresh_failed', error.message);
    return null;
  }
}

export async function resolveInstaller(payload, jobId, loadJob) {
  const fromWebhook = extractWebhookProvider(payload);
  if (!isUnassignedProviderName(fromWebhook.name)) {
    return { ...fromWebhook, source: 'webhook', confirmed: true };
  }
  if (!jobId || typeof loadJob !== 'function') {
    return { name: null, email: null, source: 'webhook', confirmed: false };
  }
  const job = await loadJob(jobId);
  if (!job) return { name: null, email: null, source: 'webhook', confirmed: false };
  const fromApi = providersFromJobLike(job)[0];
  if (fromApi?.name) {
    return { name: fromApi.name, email: fromApi.email || null, source: 'zenbooker_api', confirmed: true };
  }
  return { name: null, email: null, source: 'zenbooker_api', confirmed: true };
}

export function applyAssignment(existing, incoming) {
  const keepPrevious = incoming.confirmed === false && existing?.providerName;
  if (keepPrevious) {
    return {
      providerName: existing.providerName,
      providerEmail: existing.providerEmail || null,
      assignmentMode: existing.assignmentMode || incoming.assignmentMode,
      techSquareId: existing.techSquareId || incoming.techSquareId,
      resolvedProviderName: existing.resolvedProviderName || incoming.resolvedProviderName,
      scheduledAt: incoming.scheduledAt || existing.scheduledAt || null,
      assignmentSource: existing.assignmentSource || incoming.assignmentSource || null,
      unassignedAlertedAt: existing.unassignedAlertedAt || null,
    };
  }
  const providerName = isUnassignedProviderName(incoming.providerName) ? null : incoming.providerName;
  return {
    providerName,
    providerEmail: incoming.providerEmail || null,
    assignmentMode: incoming.assignmentMode,
    techSquareId: incoming.techSquareId,
    resolvedProviderName: incoming.resolvedProviderName,
    scheduledAt: incoming.scheduledAt || existing?.scheduledAt || null,
    assignmentSource: incoming.assignmentSource || null,
    unassignedAlertedAt: providerName ? null : (existing?.unassignedAlertedAt || null),
  };
}

export function assignmentChanged(previous, next) {
  if (!previous) return true;
  return previous.providerName !== next.providerName
    || previous.assignmentMode !== next.assignmentMode
    || (previous.providerEmail || null) !== (next.providerEmail || null)
    || (previous.unassignedAlertedAt || null) !== (next.unassignedAlertedAt || null);
}

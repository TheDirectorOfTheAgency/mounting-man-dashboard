// Keys-only view of Zenbooker data.conversion_summary.
// Logs path, type, and emptiness. Values never enter the log line or the
// public HTTP body.

const MARKER_KEY = 'zb:conv-summary-keys:v1';
const MAX_DEPTH = 8;
const MAX_ROWS = 150;
const DEFAULT_BASE_URL = 'https://api.zenbooker.com/v1/';

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

export function publicKeyRow(row) {
  return {
    path: typeof row?.path === 'string' ? row.path : '',
    type: typeof row?.type === 'string' ? row.type : '',
    empty: Boolean(row?.empty),
  };
}

export function describeConversionSummaryKeys(summary, prefix = 'conversion_summary') {
  const rows = [];
  let truncated = false;

  function walk(value, path, depth) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      return;
    }
    rows.push(publicKeyRow({ path, type: valueType(value), empty: isEmpty(value) }));
    if (depth >= MAX_DEPTH || !value || typeof value !== 'object') return;
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.keys(value).map((key) => [key, value[key]]);
    for (const [key, child] of entries) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      walk(child, `${path}.${key}`, depth + 1);
    }
  }

  walk(summary, prefix, 0);
  if (truncated && rows.length < MAX_ROWS) {
    rows.push(publicKeyRow({
      path: `${prefix}.__truncated__`,
      type: 'truncated',
      empty: false,
    }));
  }
  return rows.map(publicKeyRow);
}

export function conversionSummaryProbeFromPayload(payload) {
  const nodes = [payload?.data, payload?.data?.job, payload?.job, payload];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(node, 'conversion_summary')) continue;
    const jobId = node.id || node.job_id || node.jobId || payload?.data?.id || payload?.id || null;
    return {
      jobId: jobId == null ? null : String(jobId),
      summary: node.conversion_summary,
    };
  }
  return null;
}

export function logConversionSummaryKeys({ jobId = null, summary } = {}) {
  const present = summary !== undefined;
  const keys = present ? describeConversionSummaryKeys(summary) : [];
  console.log('ZB_CONV_SUMMARY_KEYS', JSON.stringify({
    jobId: jobId == null ? null : String(jobId),
    present,
    keys,
  }));
  return { present, keys };
}

export function logPayloadConversionSummary(payload) {
  const probe = conversionSummaryProbeFromPayload(payload);
  if (!probe) return null;
  return logConversionSummaryKeys(probe);
}

function sanitizeBareEmpties(text) {
  return text
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (match) => match.replace(',', 'null,'))
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*\}/g, (match) => match.replace('}', 'null}'));
}

function parseZenbookerBody(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return null;
  try {
    let parsed = JSON.parse(data);
    if (typeof parsed === 'string') parsed = JSON.parse(sanitizeBareEmpties(parsed));
    return parsed;
  } catch {
    try {
      return JSON.parse(sanitizeBareEmpties(data));
    } catch {
      return null;
    }
  }
}

function codedError(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

export async function loadRecentJobProbes({
  apiKey = process.env.ZENBOOKER_API_KEY,
  baseUrl = process.env.ZENBOOKER_BASE_URL || DEFAULT_BASE_URL,
  limit = 3,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw codedError('not_configured');
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const params = new URLSearchParams({
    limit: String(limit),
    sort_by: 'creation_date',
    sort_order: 'descending',
  });
  let response;
  try {
    response = await fetchImpl(`${root}/jobs?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
  } catch {
    throw codedError('upstream_error');
  }
  let text = '';
  try {
    text = typeof response?.text === 'function' ? await response.text() : '';
  } catch {
    throw codedError('upstream_error', response?.status);
  }
  if (!response?.ok) throw codedError('upstream_error', response?.status);
  const body = parseZenbookerBody(text);
  const jobs = Array.isArray(body?.results) ? body.results.slice(0, limit) : null;
  if (!jobs) throw codedError('upstream_error', response?.status);
  return jobs.map((job) => ({
    jobId: job?.id == null ? null : String(job.id),
    summary: job && Object.prototype.hasOwnProperty.call(job, 'conversion_summary')
      ? job.conversion_summary
      : undefined,
  }));
}

export async function loadAndLogRecent(options) {
  const jobs = await loadRecentJobProbes(options);
  return jobs.map((job) => logConversionSummaryKeys(job));
}

export function publicProbeResponse(probes) {
  const list = Array.isArray(probes) ? probes : [];
  return {
    logged: true,
    jobCount: list.length,
    probes: list.map((probe) => ({
      present: Boolean(probe?.present),
      keys: (Array.isArray(probe?.keys) ? probe.keys : []).map(publicKeyRow),
    })),
  };
}

async function defaultKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { kv } = await import('@vercel/kv');
  return kv;
}

export async function runConversionSummaryKeyProbeOnce({
  kv,
  probe = loadAndLogRecent,
  markerKey = MARKER_KEY,
  maxAttempts = 3,
} = {}) {
  const store = kv === undefined ? await defaultKv() : kv;
  if (!store?.get || !store?.set) return { skipped: true, reason: 'no_kv' };
  const state = (await store.get(markerKey)) || {};
  if (state.done) return { skipped: true, reason: 'already_ran' };
  const attempts = Number(state.attempts) || 0;
  if (attempts >= maxAttempts) return { skipped: true, reason: 'attempt_cap' };
  await store.set(markerKey, { attempts: attempts + 1, done: false }, { ex: 90 * 24 * 60 * 60 });
  try {
    const probes = await probe();
    await store.set(markerKey, { attempts: attempts + 1, done: true }, { ex: 90 * 24 * 60 * 60 });
    return { skipped: false, probes };
  } catch (error) {
    console.error('ZB_CONV_SUMMARY_KEYS_FETCH_FAILED', {
      errorType: error?.name || 'Error',
      errorCode: error?.code || null,
      status: error?.status || null,
    });
    return { skipped: false, failed: true, errorCode: error?.code || 'upstream_error' };
  }
}

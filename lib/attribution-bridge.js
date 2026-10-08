import { opaqueRef, sanitizeClickToken } from './offline-conversion-eligibility.js';

export const DEFAULT_BRIDGE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ZENBOOKER_BASE_URL = 'https://api.zenbooker.com/v1';
const LIST_TIMEOUT_MS = 1500;
const CLICK_KEYS = {
  gclid: 'gclid',
  google_click_id: 'gclid',
  googleClickId: 'gclid',
  gbraid: 'gbraid',
  google_braid: 'gbraid',
  wbraid: 'wbraid',
  web_braid: 'wbraid',
};

export function bridgeMode(env = process.env) {
  return env?.ATTRIBUTION_BRIDGE_MODE === 'live' ? 'live' : 'shadow';
}

export function bridgeWindowMs(env = process.env) {
  const parsed = Number(env?.ATTRIBUTION_BRIDGE_WINDOW_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_WINDOW_MS;
}

function present(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function timeMs(value) {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
}

function blankDecision(jobId, reason) {
  return {
    jobId: jobId || null,
    decision: 'no_bridge',
    reason,
    hasGclid: false,
    hasGbraid: false,
    hasWbraid: false,
    gclid: null,
    gbraid: null,
    wbraid: null,
    acquisition: null,
  };
}

function bridgeDecision(jobId, reason, clicks = {}, acquisition = null) {
  const gclid = clicks.gclid || null;
  const gbraid = clicks.gbraid || null;
  const wbraid = clicks.wbraid || null;
  return {
    jobId: jobId || null,
    decision: 'bridge',
    reason,
    hasGclid: Boolean(gclid),
    hasGbraid: Boolean(gbraid),
    hasWbraid: Boolean(wbraid),
    gclid,
    gbraid,
    wbraid,
    acquisition: acquisition || acquisitionFromClicks({ gclid, gbraid, wbraid }),
  };
}

function acquisitionFromClicks({ gclid = null, gbraid = null, wbraid = null } = {}) {
  if (!gclid && !gbraid && !wbraid) return null;
  return {
    paidEvidence: true,
    paidMarker: gclid ? 'gclid' : gbraid ? 'gbraid' : 'wbraid',
    sourceClass: null,
    mediumClass: null,
    hasCampaign: false,
    hasLandingContext: false,
    hasGclid: Boolean(gclid),
    hasGbraid: Boolean(gbraid),
    hasWbraid: Boolean(wbraid),
  };
}

function clicksOf(record) {
  return {
    gclid: record?.gclid || null,
    gbraid: record?.gbraid || null,
    wbraid: record?.wbraid || null,
  };
}

function reasonForSource(source) {
  if (source === 'exact_session') return 'exact_session';
  if (source === 'conversion_summary') return 'summary_click_ids';
  if (source === 'window') return 'single_match';
  return 'error';
}

function fromStored(jobId, record) {
  if (!record?.source || !reasonForSource(record.source) || reasonForSource(record.source) === 'error') {
    return blankDecision(jobId, 'error');
  }
  return bridgeDecision(jobId, reasonForSource(record.source), clicksOf(record), record.acquisition);
}

export function logBridgeDecision(decision = {}) {
  console.log('ZB_BRIDGE_DECISION', JSON.stringify({
    jobId: decision.jobId || null,
    decision: decision.decision === 'bridge' ? 'bridge' : 'no_bridge',
    reason: decision.reason || 'error',
    hasGclid: Boolean(decision.hasGclid),
    hasGbraid: Boolean(decision.hasGbraid),
    hasWbraid: Boolean(decision.hasWbraid),
  }));
}

function walkClickIds(node, found, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return found;
  for (const [key, value] of Object.entries(node)) {
    const slot = CLICK_KEYS[key];
    if (slot && !found[slot]) {
      const token = sanitizeClickToken(value);
      if (token) found[slot] = token;
    } else if (value && typeof value === 'object') {
      walkClickIds(value, found, depth + 1);
    }
  }
  return found;
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function readJobFacts(payload) {
  const data = objectRecord(payload?.data) || {};
  const nested = objectRecord(data.job) || objectRecord(payload?.job);
  const job = nested
    ? { ...data, ...nested, customer: nested.customer || data.customer }
    : (Object.keys(data).length > 0 ? data : (payload || {}));
  const customer = job.customer || data.customer || {};
  const summary = present(job.conversion_summary, data.conversion_summary, payload?.conversion_summary);
  return {
    jobId: present(job.id, job.job_id, job.jobId, payload?.id) || null,
    zenCustomerId: present(
      customer.id,
      customer.customer_id,
      customer.customerId,
      job.customer_id,
      job.customerId,
      data.customer_id
    ) || null,
    createdAt: present(job.created, job.created_at, job.createdAt, data.created, data.created_at) || null,
    bookingSession: present(
      job.booking_session,
      job.booking_session_id,
      job.bookingSession,
      job.bookingSessionId,
      payload?.booking_session,
      payload?.bookingSession
    ) || null,
    summaryClicks: walkClickIds(summary, { gclid: null, gbraid: null, wbraid: null }, 0),
  };
}

export function selectBridge({ captures = [], jobs = [], anchorCreatedAt, windowMs }) {
  const anchor = timeMs(anchorCreatedAt);
  if (anchor === null) return { decision: 'no_bridge', reason: 'missing_created_at' };
  const matchedCaptures = captures.filter((capture) => {
    const captured = timeMs(capture?.capturedAt);
    return captured !== null && Math.abs(captured - anchor) <= windowMs;
  });
  const matchedJobs = jobs.filter((job) => {
    const created = timeMs(job?.createdAt);
    return created !== null && Math.abs(created - anchor) <= windowMs;
  });
  if (matchedCaptures.length === 0) return { decision: 'no_bridge', reason: 'no_capture' };
  if (matchedCaptures.length > 1) return { decision: 'no_bridge', reason: 'multiple_captures' };
  if (matchedJobs.length === 0) return { decision: 'no_bridge', reason: 'no_job' };
  if (matchedJobs.length > 1) return { decision: 'no_bridge', reason: 'multiple_jobs' };
  return {
    decision: 'bridge',
    reason: 'single_match',
    capture: matchedCaptures[0],
    job: matchedJobs[0],
  };
}

function mergeJobs(lists) {
  const byId = new Map();
  for (const job of lists.flat()) {
    if (!job?.jobId) continue;
    const id = String(job.jobId);
    const prev = byId.get(id);
    byId.set(id, { jobId: id, createdAt: job.createdAt || prev?.createdAt || null });
  }
  return [...byId.values()];
}

function jobsNear(jobs, anchor, windowMs) {
  return jobs.filter((job) => {
    const created = timeMs(job.createdAt);
    return created !== null && Math.abs(created - anchor) <= windowMs;
  });
}

async function clearWindowJobs(store, jobs) {
  for (const job of jobs) {
    if (typeof store.clearWindowBridge === 'function') await store.clearWindowBridge(job.jobId);
  }
}

function parseJobsBody(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return null;
  try {
    let parsed = JSON.parse(data);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function defaultListJobs({
  zenCustomerId,
  createdAfter,
  createdBefore,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = LIST_TIMEOUT_MS,
} = {}) {
  if (!env?.ZENBOOKER_API_KEY) return { error: true };
  const base = (env.ZENBOOKER_BASE_URL || DEFAULT_ZENBOOKER_BASE_URL).replace(/\/$/, '');
  const params = new URLSearchParams({
    customer: String(zenCustomerId),
    created_after: createdAfter,
    created_before: createdBefore,
    limit: '100',
  });
  try {
    const response = await fetchImpl(`${base}/jobs?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${env.ZENBOOKER_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return { error: true };
    const body = parseJobsBody(typeof response.text === 'function' ? await response.text() : response.data);
    const results = Array.isArray(body?.results) ? body.results : null;
    if (!results) return { error: true };
    return results
      .map((job) => ({
        jobId: present(job?.id, job?.job_id, job?.jobId),
        createdAt: present(job?.created, job?.created_at, job?.createdAt),
      }))
      .filter((job) => job.jobId);
  } catch {
    return { error: true };
  }
}

async function evaluateWindow({
  store,
  jobId,
  zenCustomerId,
  createdAt,
  windowMs,
  listJobs,
}) {
  const anchor = timeMs(createdAt);
  if (anchor === null) return blankDecision(jobId, 'missing_created_at');
  const padMs = 60 * 1000;
  const listed = await listJobs({
    zenCustomerId,
    createdAfter: new Date(anchor - windowMs - padMs).toISOString(),
    createdBefore: new Date(anchor + windowMs + padMs).toISOString(),
  });
  if (!Array.isArray(listed)) return blankDecision(jobId, 'job_count_unavailable');

  const observed = typeof store.listObservedJobs === 'function'
    ? await store.listObservedJobs(zenCustomerId)
    : [];
  const jobs = mergeJobs([
    listed,
    observed,
    [{ jobId, createdAt }],
  ]);
  const captures = typeof store.listCaptures === 'function'
    ? await store.listCaptures(zenCustomerId)
    : [];
  const selected = selectBridge({ captures, jobs, anchorCreatedAt: createdAt, windowMs });
  if (selected.decision !== 'bridge') {
    await clearWindowJobs(store, jobsNear(jobs, anchor, windowMs));
    return blankDecision(jobId, selected.reason);
  }
  const saved = await store.saveJobBridge({
    jobId: selected.job.jobId,
    sessionRef: selected.capture.sessionRef || null,
    source: 'window',
    acquisition: selected.capture.acquisition,
    ...clicksOf(selected.capture),
  });
  return bridgeDecision(selected.job.jobId, 'single_match', clicksOf(saved), saved.acquisition);
}

export async function decideJobBridge({
  store,
  jobId,
  zenCustomerId = null,
  createdAt = null,
  bookingSession = null,
  summaryClicks = null,
  windowMs = DEFAULT_BRIDGE_WINDOW_MS,
  listJobs = null,
  record = true,
}) {
  if (!jobId || !store?.saveJobBridge || !store?.getJobBridge) return blankDecision(jobId, 'error');
  if (record && zenCustomerId && typeof store.recordObservedJob === 'function') {
    await store.recordObservedJob({ zenCustomerId, jobId, createdAt });
  }

  let sessionMissing = false;
  if (bookingSession) {
    const stored = typeof store.getBookingAttribution === 'function'
      ? await store.getBookingAttribution({ bookingSession })
      : null;
    if (stored) {
      let sessionRef = stored.sessionRef || null;
      try {
        sessionRef = sessionRef || opaqueRef(bookingSession);
      } catch {
        sessionRef = null;
      }
      const saved = await store.saveJobBridge({
        jobId,
        sessionRef,
        source: 'exact_session',
        acquisition: stored.acquisition,
        ...clicksOf(stored),
      });
      return bridgeDecision(jobId, 'exact_session', clicksOf(saved), saved.acquisition);
    }
    sessionMissing = true;
    if (typeof store.clearWindowBridge === 'function') await store.clearWindowBridge(jobId);
  }

  if (summaryClicks?.gclid || summaryClicks?.gbraid || summaryClicks?.wbraid) {
    const acquisition = acquisitionFromClicks(summaryClicks);
    const saved = await store.saveJobBridge({
      jobId,
      sessionRef: null,
      source: 'conversion_summary',
      acquisition,
      ...clicksOf(summaryClicks),
    });
    return bridgeDecision(jobId, 'summary_click_ids', clicksOf(saved), saved.acquisition);
  }

  const existing = await store.getJobBridge(jobId);
  if (existing?.source && existing.source !== 'window') return fromStored(jobId, existing);
  if (sessionMissing) return blankDecision(jobId, 'session_not_found');

  if (!zenCustomerId) return blankDecision(jobId, 'missing_customer');
  if (timeMs(createdAt) === null) {
    if (existing?.source === 'window') return fromStored(jobId, existing);
    return blankDecision(jobId, 'missing_created_at');
  }

  return evaluateWindow({
    store,
    jobId,
    zenCustomerId,
    createdAt,
    windowMs,
    listJobs: listJobs || defaultListJobs,
  });
}

export async function considerIncomingJob({
  payload,
  store,
  windowMs = bridgeWindowMs(),
  listJobs,
} = {}) {
  const facts = readJobFacts(payload);
  try {
    if (!facts.jobId) return null;
    if (!store?.saveJobBridge) {
      const decision = blankDecision(facts.jobId, 'error');
      logBridgeDecision(decision);
      return decision;
    }
    const decision = await decideJobBridge({
      store,
      jobId: facts.jobId,
      zenCustomerId: facts.zenCustomerId,
      createdAt: facts.createdAt,
      bookingSession: facts.bookingSession,
      summaryClicks: facts.summaryClicks,
      windowMs,
      listJobs,
    });
    logBridgeDecision(decision);
    return decision;
  } catch {
    const decision = blankDecision(facts.jobId, 'error');
    logBridgeDecision(decision);
    return decision;
  }
}

export async function considerCapture({
  store,
  zenCustomerId,
  capturedAt,
  windowMs = bridgeWindowMs(),
  listJobs,
} = {}) {
  if (!store?.listObservedJobs || !zenCustomerId) return [];
  const jobs = await store.listObservedJobs(zenCustomerId);
  const anchor = timeMs(capturedAt);
  const decisions = [];
  for (const job of jobs) {
    const created = timeMs(job?.createdAt);
    if (anchor === null || created === null || Math.abs(created - anchor) > windowMs) continue;
    const existing = typeof store.getJobBridge === 'function' ? await store.getJobBridge(job.jobId) : null;
    if (existing?.source && existing.source !== 'window') continue;
    const decision = await decideJobBridge({
      store,
      jobId: job.jobId,
      zenCustomerId,
      createdAt: job.createdAt,
      windowMs,
      listJobs,
    });
    logBridgeDecision(decision);
    decisions.push(decision);
  }
  return decisions;
}

export async function resolveCompletedBridge({
  store,
  candidate,
  payload,
  windowMs = bridgeWindowMs(),
  listJobs,
} = {}) {
  const facts = readJobFacts(payload);
  return decideJobBridge({
    store,
    jobId: candidate?.jobId || facts.jobId,
    zenCustomerId: candidate?.zenCustomerId || facts.zenCustomerId,
    createdAt: facts.createdAt,
    bookingSession: candidate?.bookingSession || facts.bookingSession,
    summaryClicks: facts.summaryClicks,
    windowMs,
    listJobs,
  });
}

export function applyBridgeToCandidate(candidate, decision) {
  if (!candidate || decision?.decision !== 'bridge') return candidate;
  const next = { ...candidate };
  if (!next.gclid && decision.gclid) next.gclid = decision.gclid;
  if (!next.gbraid && decision.gbraid) next.gbraid = decision.gbraid;
  if (!next.wbraid && decision.wbraid) next.wbraid = decision.wbraid;
  if (!next.acquisition?.paidEvidence && decision.acquisition?.paidEvidence) {
    next.acquisition = decision.acquisition;
  }
  return next;
}

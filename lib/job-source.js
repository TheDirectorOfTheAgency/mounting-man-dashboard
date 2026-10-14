import crypto from 'node:crypto';
import { hashEmail, normalizePhoneE164 } from './hash-pii.js';
import { customFieldAnswerByLabel, opaqueRef } from './offline-conversion-eligibility.js';
import { decideJobBridge, bridgeWindowMs } from './attribution-bridge.js';
import { classifyVisit, SOURCE_BUCKETS } from './source-classifier.js';

function chicagoMonth(value) {
  if (value == null || value === '') return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
  }).format(time).slice(0, 7);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function jobNode(payload) {
  const data = asObject(payload?.data) || {};
  const nested = asObject(data.job) || asObject(payload?.job);
  if (nested) return { ...data, ...nested, customer: nested.customer || data.customer };
  return Object.keys(data).length > 0 ? data : (asObject(payload) || {});
}

function dollars(value) {
  if (value == null || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

export const MANUAL_SOURCE_LABEL = /^(lead source|booking source|source|how did (you|they) hear( about us)?\??)$/i;

const MANUAL_SOURCE_RULES = [
  [/google\s*ads?|adwords|ppc|paid search/i, 'google_ads'],
  [/business profile|gbp|google maps|maps/i, 'google_business_profile'],
  [/google/i, 'google_organic'],
  [/bing|yahoo|duckduckgo/i, 'bing_other_search'],
  [/chatgpt|ai\b|perplexity|gemini|claude/i, 'ai_assistant'],
  [/yelp/i, 'yelp'],
  [/angi|angie|homeadvisor/i, 'angi'],
  [/thumbtack/i, 'thumbtack'],
  [/facebook|instagram|meta/i, 'facebook_instagram'],
  [/email|newsletter/i, 'email'],
];

// Map a free-text or option answer to a report bucket. Unmatched answers are
// "other_referral" with a short, non-identifying detail (repeat / referral /
// friend etc.). Never stores more than 40 characters of the answer.
export function manualSourceBucket(answer) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return null;
  const detail = `manual: ${text.toLowerCase().replace(/[^a-z0-9 /&-]/g, '').slice(0, 40)}`;
  for (const [pattern, bucket] of MANUAL_SOURCE_RULES) {
    if (pattern.test(text)) return { bucket, detail };
  }
  return { bucket: 'other_referral', detail };
}

export function revenueOf(payload) {
  const job = jobNode(payload);
  const invoice = asObject(job.invoice) || {};
  const billing = asObject(job.billing) || {};
  return dollars(invoice.total ?? invoice.total_price ?? billing.total ?? billing.total_price ?? null);
}

function identityTokens({ zenCustomerId, email, phone }) {
  const tokens = [];
  if (zenCustomerId) {
    try { tokens.push(`c:${opaqueRef(zenCustomerId)}`); } catch { /* skip */ }
  }
  const emailHash = hashEmail(email);
  if (emailHash) tokens.push(`e:${emailHash}`);
  const normalizedPhone = normalizePhoneE164(phone);
  if (normalizedPhone) {
    tokens.push(`p:${crypto.createHash('sha256').update(normalizedPhone).digest('hex')}`);
  }
  return tokens;
}

function adsBuckets(bridge) {
  const paid = Boolean(
    bridge?.gclid
    || bridge?.gbraid
    || bridge?.wbraid
    || bridge?.acquisition?.paidEvidence
  );
  if (!paid) return null;
  return {
    firstTouch: { bucket: 'google_ads', detail: null },
    lastTouch: { bucket: 'google_ads', detail: null },
  };
}

export async function recordJobSource({
  store,
  payload = null,
  candidate = null,
  jobId = null,
  createdAt = null,
  bookingSession = null,
  zenCustomerId = null,
  email = null,
  phone = null,
  revenue = null,
} = {}) {
  if (!store?.saveJobSource || !store?.getJobBridge) return null;
  const job = payload ? jobNode(payload) : {};
  const customer = asObject(job.customer) || {};
  const id = jobId || candidate?.jobId || job.id || job.job_id || job.jobId || null;
  if (!id) return null;
  const existing = typeof store.getJobSource === 'function' ? await store.getJobSource(id) : null;
  const when = createdAt
    || candidate?.createdAt
    || job.created
    || job.created_at
    || job.createdAt
    || null;
  const storedMonth = typeof existing?.month === 'string' && /^\d{4}-\d{2}$/.test(existing.month)
    ? existing.month
    : null;
  const stableStamp = candidate?.completedAt
    || job.completed_at
    || job.completedAt
    || job.completion_time
    || job.completionTime
    || null;
  const month = chicagoMonth(when) || storedMonth || chicagoMonth(stableStamp);
  const session = bookingSession || candidate?.bookingSession || null;
  const customerId = zenCustomerId
    || candidate?.zenCustomerId
    || customer.id
    || customer.customer_id
    || job.customer_id
    || null;
  const contactEmail = email || candidate?.email || customer.email || null;
  const contactPhone = phone || candidate?.phone || customer.phone || customer.phone_number || null;
  let amount = revenue != null ? revenue : (payload ? revenueOf(payload) : null);
  // A later payload without totals (or a rematch) must not erase known revenue.
  if (amount == null && Number.isFinite(existing?.revenue)) {
    amount = existing.revenue;
  }

  const bridge = await store.getJobBridge(id);
  let touch = null;
  if (typeof store.getSessionTouch === 'function') {
    touch = session
      ? await store.getSessionTouch({ bookingSession: session })
      : null;
    if (!touch && bridge?.sessionRef) {
      touch = await store.getSessionTouch({ sessionRef: bridge.sessionRef });
    }
  }
  const classified = touch?.first || touch?.last
    ? classifyVisit({ first: touch.first, last: touch.last })
    : (adsBuckets(bridge) || {
      firstTouch: { bucket: 'unknown', detail: null },
      lastTouch: { bucket: 'unknown', detail: null },
    });
  // Tracking fix #4: a manual/admin booking has no web visit. If ZenBooker
  // carries a "Lead source" answer, use it as the source (web evidence wins).
  let sourceEntry = classified.lastTouch.bucket !== 'unknown' ? 'web' : null;
  const manual = manualSourceBucket(payload ? customFieldAnswerByLabel(payload, MANUAL_SOURCE_LABEL) : null);
  if (!sourceEntry && manual) {
    classified.firstTouch = { ...manual };
    classified.lastTouch = { ...manual };
    sourceEntry = 'manual';
  }
  const matched = classified.lastTouch.bucket !== 'unknown';
  let repeat = false;
  if (typeof store.flagRepeatIdentity === 'function') {
    repeat = await store.flagRepeatIdentity({
      jobId: id,
      createdAt: when,
      tokens: identityTokens({
        zenCustomerId: customerId,
        email: contactEmail,
        phone: contactPhone,
      }),
    });
  }
  return store.saveJobSource({
    jobId: id,
    month,
    firstBucket: classified.firstTouch.bucket,
    lastBucket: classified.lastTouch.bucket,
    firstDetail: classified.firstTouch.detail,
    lastDetail: classified.lastTouch.detail,
    repeat,
    revenue: amount,
    matched,
    sourceEntry,
  });
}

export async function rematchVisit({
  store,
  zenCustomerId,
  capturedAt,
  windowMs = bridgeWindowMs(),
  listJobs,
} = {}) {
  if (!store?.listObservedJobs || !zenCustomerId) return [];
  const jobs = await store.listObservedJobs(zenCustomerId);
  const anchor = Date.parse(capturedAt || '');
  const saved = [];
  for (const job of jobs) {
    const created = Date.parse(job?.createdAt || '');
    if (Number.isNaN(anchor) || Number.isNaN(created) || Math.abs(created - anchor) > windowMs) continue;
    const existing = typeof store.getJobBridge === 'function' ? await store.getJobBridge(job.jobId) : null;
    if (existing?.source && existing.source !== 'window') continue;
    await decideJobBridge({
      store,
      jobId: job.jobId,
      zenCustomerId,
      createdAt: job.createdAt,
      windowMs,
      listJobs,
    });
    const row = await recordJobSource({
      store,
      jobId: job.jobId,
      createdAt: job.createdAt,
      zenCustomerId,
    });
    if (row) saved.push(row);
  }
  return saved;
}

export function uniqueSourceJobs(records = []) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const id = record?.jobId || record?.jobRef || null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    unique.push(record);
  }
  return unique;
}

export function buildSourceReport(records = []) {
  const byMonth = new Map();
  for (const record of uniqueSourceJobs(records)) {
    if (!record?.month) continue;
    if (!byMonth.has(record.month)) byMonth.set(record.month, []);
    byMonth.get(record.month).push(record);
  }
  const months = [...byMonth.keys()].sort().reverse().map((month) => summarizeMonth(month, byMonth.get(month)));
  return { months };
}

function groupKey(bucket, detail) {
  return detail ? `${bucket}:${detail}` : bucket;
}

function summarizeSide(records, bucketField, detailField) {
  const totalJobs = records.length;
  const totalRevenue = roundMoney(records.reduce((sum, row) => sum + (row.revenue || 0), 0));
  const groups = new Map();
  for (const row of records) {
    const bucket = SOURCE_BUCKETS.includes(row[bucketField]) ? row[bucketField] : 'unknown';
    const detail = bucket === 'other_referral' ? (row[detailField] || null) : null;
    const key = groupKey(bucket, detail);
    if (!groups.has(key)) {
      groups.set(key, { bucket, detail, jobs: 0, revenue: 0, repeatJobs: 0, repeatRevenue: 0 });
    }
    const group = groups.get(key);
    group.jobs += 1;
    group.revenue = roundMoney(group.revenue + (row.revenue || 0));
    if (row.repeat) {
      group.repeatJobs += 1;
      group.repeatRevenue = roundMoney(group.repeatRevenue + (row.revenue || 0));
    }
  }
  if (!groups.has('unknown')) {
    groups.set('unknown', { bucket: 'unknown', detail: null, jobs: 0, revenue: 0, repeatJobs: 0, repeatRevenue: 0 });
  }
  return [...groups.values()]
    .sort((a, b) => b.jobs - a.jobs || a.bucket.localeCompare(b.bucket))
    .map((group) => ({
      ...group,
      share: totalJobs > 0 ? Math.round((group.jobs / totalJobs) * 10000) / 10000 : 0,
      revenueShare: totalRevenue > 0 ? Math.round((group.revenue / totalRevenue) * 10000) / 10000 : 0,
    }));
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function summarizeMonth(month, records) {
  const revenue = roundMoney(records.reduce((sum, row) => sum + (row.revenue || 0), 0));
  const repeatRecords = records.filter((row) => row.repeat);
  const unknownRecords = records.filter((row) => row.lastBucket === 'unknown' || !row.matched);
  return {
    month,
    jobs: records.length,
    revenue,
    unknownJobs: unknownRecords.length,
    unknownRevenue: roundMoney(unknownRecords.reduce((sum, row) => sum + (row.revenue || 0), 0)),
    manualSourceJobs: records.filter((row) => row.sourceEntry === 'manual').length,
    repeatJobs: repeatRecords.length,
    repeatRevenue: roundMoney(repeatRecords.reduce((sum, row) => sum + (row.revenue || 0), 0)),
    byLastTouch: summarizeSide(records, 'lastBucket', 'lastDetail'),
    byFirstTouch: summarizeSide(records, 'firstBucket', 'firstDetail'),
  };
}

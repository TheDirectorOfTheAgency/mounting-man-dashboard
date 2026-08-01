#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hasPaidClickEvidence } from '../lib/offline-conversion-eligibility.js';

const ZENBOOKER_BASE_URL = process.env.ZENBOOKER_BASE_URL || 'https://api.zenbooker.com/v1/';
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-01-18';
const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const KV_AUDIT_UNAVAILABLE = {
  available: false,
  status: 'unavailable',
  blocker: 'Local KV/Upstash attribution store credentials unavailable.',
};

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
  }
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(name);
}

function hashRef(value, length = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function opaqueRef(value) {
  return hashRef(value, 24);
}

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  if (!email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return email;
}

function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits || null;
}

function normalizeName(value) {
  if (!value) return null;
  return String(value).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

function centsFromMoney(value) {
  if (!value || typeof value.amount !== 'number') return 0;
  return value.amount;
}

export function paymentNetCents(payment = {}) {
  return centsFromMoney(payment.amount_money || payment.total_money)
    - centsFromMoney(payment.refunded_money);
}

function sanitizeZenBookerJson(text) {
  return text
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (match) => match.replace(',', 'null,'))
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*}/g, (match) => match.replace('}', 'null}'));
}

async function fetchJson(url, { token, square = false, method = 'GET', body = null }) {
  const headers = square
    ? { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, Accept: 'application/json', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(square ? text : sanitizeZenBookerJson(text));
    if (typeof parsed === 'string') parsed = JSON.parse(square ? parsed : sanitizeZenBookerJson(parsed));
  } catch (error) {
    throw new Error(`JSON parse failed for ${url}: ${error.message}`);
  }
  if (!response.ok) {
    const details = parsed?.errors || parsed?.error || parsed;
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(details).slice(0, 500)}`);
  }
  return parsed;
}

export async function fetchZenBookerJobs({
  apiKey,
  beginTime,
  endTime,
  maxPages = 200,
  fetcher = fetchJson,
}) {
  const all = [];
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      limit: '100',
      sort_by: 'start_time',
      sort_order: 'ascending',
    });
    if (beginTime) params.set('start_date_min', beginTime.toISOString());
    if (endTime) params.set('start_date_max', endTime.toISOString());
    if (cursor) params.set('cursor', cursor);
    const url = `${ZENBOOKER_BASE_URL.replace(/\/$/, '')}/jobs?${params}`;
    const data = await fetcher(url, { token: apiKey });
    const jobs = data.results || [];
    all.push(...jobs);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all;
}

async function fetchSquarePayments({ token, beginTime, endTime, locationId }) {
  const all = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({
      begin_time: beginTime.toISOString(),
      end_time: endTime.toISOString(),
      limit: '100',
    });
    if (locationId) params.set('location_id', locationId);
    if (cursor) params.set('cursor', cursor);
    const data = await fetchJson(`${SQUARE_BASE_URL}/v2/payments?${params}`, { token, square: true });
    all.push(...(data.payments || []));
    cursor = data.cursor || null;
  } while (cursor);
  return all;
}

async function fetchSquareCustomers({ token, customerIds }) {
  const uniqueIds = [...new Set(customerIds.filter(Boolean))];
  const customers = new Map();
  for (const customerId of uniqueIds) {
    const data = await fetchJson(`${SQUARE_BASE_URL}/v2/customers/${encodeURIComponent(customerId)}`, { token, square: true });
    customers.set(customerId, data.customer || null);
  }
  return customers;
}

export function createUpstashKvClient({ url, token }) {
  if (!url || !token) return null;
  const baseUrl = url.replace(/\/$/, '');
  async function command(...parts) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(`KV audit parse failed: ${error.message}`);
    }
    if (!response.ok || parsed?.error) {
      throw new Error(`KV audit command failed: ${parsed?.error || response.status}`);
    }
    return parsed.result;
  }
  return {
    async get(key) {
      return command('GET', key);
    },
    async smembers(key) {
      return command('SMEMBERS', key);
    },
  };
}

function createKvAuditClientFromEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;
  return createUpstashKvClient({ url, token });
}

function normalizeKvRecord(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function safeKvGet(kv, key) {
  try {
    return normalizeKvRecord(await kv.get(key));
  } catch {
    return null;
  }
}

async function safeKvSetHas(kv, key, member) {
  try {
    const values = await kv.smembers(key);
    return Array.isArray(values) && values.includes(member);
  } catch {
    return false;
  }
}

export async function auditCandidateAttributionStore({ kv, job, payment, squareCustomer }) {
  if (!kv || !job?.id || !payment?.id || !squareCustomer?.id) return { ...KV_AUDIT_UNAVAILABLE };

  const jobRef = opaqueRef(job.id);
  const paymentRef = opaqueRef(payment.id);
  const customerRef = opaqueRef(squareCustomer.id);
  const [mapping, pendingJobRecord, trustedPaymentRecord, legacyPaymentRecord, successRecord, pendingIndexHasJob, paymentIndexHasPayment] = await Promise.all([
    safeKvGet(kv, `attrib:job-map:${jobRef}`),
    safeKvGet(kv, `attrib:pending-job:${customerRef}:${jobRef}`),
    safeKvGet(kv, `attrib:trusted-payment:${customerRef}:${paymentRef}`),
    safeKvGet(kv, `attrib:payment:${customerRef}:${paymentRef}`),
    safeKvGet(kv, `conv:success:${jobRef}`),
    safeKvSetHas(kv, `attrib:pending-jobs:${customerRef}`, jobRef),
    safeKvSetHas(kv, `attrib:payments:${customerRef}`, paymentRef),
  ]);
  const paymentRecord = trustedPaymentRecord || legacyPaymentRecord;

  const pendingJobPresent = Boolean(pendingJobRecord) && pendingIndexHasJob;
  const storedPaymentPresent = Boolean(paymentRecord) && paymentIndexHasPayment;
  const mappingMatchesCustomer =
    Boolean(mapping?.squareCustomerId)
    && String(mapping.squareCustomerId) === String(squareCustomer.id);
  const paidEvidencePresent = hasPaidClickEvidence(pendingJobRecord?.acquisition);
  const livePaymentStatus = String(payment.status || '').toUpperCase();
  const livePaymentCurrency = String(
    payment.amount_money?.currency || payment.total_money?.currency || ''
  ).toUpperCase();
  const livePaymentAmount = centsFromMoney(payment.amount_money || payment.total_money);
  const livePaymentRefundedAmount = centsFromMoney(payment.refunded_money);
  const livePaymentCompleted = Boolean(
    livePaymentStatus === 'COMPLETED'
    && livePaymentCurrency === 'USD'
    && livePaymentAmount - livePaymentRefundedAmount > 0
  );
  const storedPaymentMatchesLive = Boolean(
    storedPaymentPresent
    && paymentRecord.paymentRef === paymentRef
    && String(paymentRecord.status || '').toUpperCase() === livePaymentStatus
    && String(paymentRecord.currency || '').toUpperCase() === livePaymentCurrency
    && Number(paymentRecord.amount) === livePaymentAmount
    && Number(paymentRecord.refundedAmount) === livePaymentRefundedAmount
  );
  const storedPaymentCompleted = Boolean(
    storedPaymentMatchesLive
    && livePaymentCompleted
    && String(paymentRecord.status).toUpperCase() === 'COMPLETED'
    && String(paymentRecord.currency).toUpperCase() === 'USD'
    && Number(paymentRecord.amount || 0) - Number(paymentRecord.refundedAmount || 0) > 0
    && paymentRecord.completedAt
    && pendingJobRecord?.completedAt
    && !Number.isNaN(Date.parse(paymentRecord.completedAt))
    && !Number.isNaN(Date.parse(pendingJobRecord.completedAt))
    && Math.abs(Date.parse(paymentRecord.completedAt) - Date.parse(pendingJobRecord.completedAt)) <= MATCH_WINDOW_MS
  );
  const storedPaymentTrusted = Boolean(
    storedPaymentPresent
    && paymentRecord.trustedWebhook === true
    && paymentRecord.webhookSignatureKeyConfigured === true
    && paymentRecord.webhookSignatureVerified === true
  );
  const successAlreadyRecorded = Boolean(successRecord);
  const consentStatus = pendingJobRecord?.consentStatus || null;
  const evidence = [];
  if (mappingMatchesCustomer) evidence.push('job_mapping');
  if (pendingJobPresent) evidence.push('pending_job');
  if (storedPaymentCompleted) evidence.push('stored_payment');
  if (storedPaymentTrusted) evidence.push('verified_square_webhook');
  if (paidEvidencePresent) evidence.push(`paid_${pendingJobRecord.acquisition?.paidMarker || 'evidence'}`);
  if (successAlreadyRecorded) evidence.push('already_uploaded');

  let status = 'blocked';
  let blocker = null;
  if (!mapping?.squareCustomerId) blocker = 'No local ZenBooker→Square mapping record found.';
  else if (!mappingMatchesCustomer) blocker = 'Local job mapping does not match the candidate Square customer.';
  else if (!pendingJobPresent) blocker = 'No local pending completed-job record found.';
  else if (!paidEvidencePresent) blocker = 'No local paid-acquisition evidence found for the job.';
  else if (!storedPaymentPresent) blocker = 'No local completed-payment record found for the mapped Square customer.';
  else if (!livePaymentCompleted) blocker = 'Live Square payment is not a completed positive USD payment.';
  else if (!storedPaymentMatchesLive) blocker = 'Stored payment evidence does not exactly match the live Square payment.';
  else if (!storedPaymentCompleted) blocker = 'Stored payment evidence is not within the completed job window.';
  else if (successAlreadyRecorded) {
    status = 'already_uploaded';
    blocker = 'Success record already exists; do not upload again.';
  } else if (!storedPaymentTrusted) blocker = 'Stored payment lacks verified Square webhook provenance.';
  else if (!pendingJobRecord?.disclosureVersion) blocker = 'Stored job privacy disclosure evidence is missing.';
  else if (String(consentStatus).toUpperCase() === 'DENIED') blocker = 'Customer consent is denied.';
  else {
    status = 'ready_for_validate';
  }

  return {
    available: true,
    status,
    blocker,
    evidence,
    paymentRef,
    mappingPresent: mappingMatchesCustomer,
    pendingJobPresent,
    storedPaymentPresent,
    livePaymentCompleted,
    storedPaymentMatchesLive,
    storedPaymentCompleted,
    storedPaymentTrusted,
    paidEvidencePresent,
    paidMarker: pendingJobRecord?.acquisition?.paidMarker || null,
    consentStatus,
    successAlreadyRecorded,
  };
}

function jobContact(job) {
  const customer = job.customer || {};
  return {
    email: normalizeEmail(customer.email),
    phone: normalizePhone(customer.phone),
    name: normalizeName(customer.name),
  };
}

function squareContact(customer = {}) {
  return {
    email: normalizeEmail(customer.email_address),
    phone: normalizePhone(customer.phone_number),
    name: normalizeName(`${customer.given_name || ''} ${customer.family_name || ''}`),
  };
}

function matchEvidence(job, payment, squareCustomer) {
  const j = jobContact(job);
  const s = squareContact(squareCustomer);
  const evidence = [];
  if (j.email && s.email && j.email === s.email) evidence.push('email');
  if (j.phone && s.phone && j.phone === s.phone) evidence.push('phone');
  if (j.name && s.name && j.name === s.name) evidence.push('name');
  const completedAt = Date.parse(job.completed_at || job.end_date || job.start_date || '');
  const paidAt = Date.parse(payment.created_at || payment.updated_at || '');
  if (!Number.isNaN(completedAt) && !Number.isNaN(paidAt) && Math.abs(completedAt - paidAt) <= MATCH_WINDOW_MS) {
    evidence.push('time_window');
  }
  return evidence;
}

function summarizeCandidate(job, payment, squareCustomer, evidence, attributionAudit = KV_AUDIT_UNAVAILABLE) {
  const invoice = job.invoice || {};
  const amount = paymentNetCents(payment);
  const readyForValidate = attributionAudit.status === 'ready_for_validate';
  return {
    jobRef: opaqueRef(job.id),
    jobNumber: job.job_number || null,
    paymentRef: opaqueRef(payment.id),
    squareCustomerRef: squareCustomer?.id ? hashRef(squareCustomer.id) : null,
    serviceName: job.service_name || null,
    jobStatus: job.status || null,
    completedAt: job.completed_at || null,
    paymentCreatedAt: payment.created_at || null,
    paymentStatus: payment.status || null,
    invoiceStatus: invoice.status || null,
    invoiceAmountPaid: invoice.amount_paid || null,
    paymentNetUsd: Number((amount / 100).toFixed(2)),
    matchEvidence: evidence,
    attributionAudit,
    safeForUpload: false,
    readyForValidate,
    uploadBlocker: readyForValidate
      ? 'Local evidence supports selected dry-run/validation only; apply still requires an explicitly approved job ref paired with this payment ref and expected live net value.'
      : attributionAudit.blocker || 'KV/log attribution evidence unavailable; candidate is only a Square↔ZenBooker paid-completion match.',
  };
}

export async function main() {
  loadLocalEnv();
  const days = Number(argValue('--days', '14'));
  const jsonOutput = flag('--json');
  const zbKey = process.env.ZENBOOKER_API_KEY;
  const squareToken = process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
  const squareLocationId = process.env.SQUARE_LOCATION_ID || process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;
  if (!zbKey) throw new Error('ZENBOOKER_API_KEY is required');
  if (!squareToken) throw new Error('SQUARE_ACCESS_TOKEN is required');

  const endTime = new Date();
  const beginTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const [jobs, payments] = await Promise.all([
    fetchZenBookerJobs({ apiKey: zbKey, beginTime, endTime }),
    fetchSquarePayments({ token: squareToken, beginTime, endTime, locationId: squareLocationId }),
  ]);

  const completedJobs = jobs.filter((job) => {
    const completedAt = Date.parse(job.completed_at || '');
    return String(job.status || '').toLowerCase() === 'complete'
      && !Number.isNaN(completedAt)
      && completedAt >= beginTime.getTime()
      && completedAt <= endTime.getTime();
  });
  const jobDates = jobs
    .map((job) => job.completed_at || job.start_date || job.created)
    .filter(Boolean)
    .sort();
  const latestZenBookerJobAt = jobDates.at(-1) || null;
  const zenBookerLooksStale = Boolean(
    latestZenBookerJobAt
      && Date.parse(latestZenBookerJobAt) < beginTime.getTime()
      && payments.length > 0
  );
  const completedPayments = payments.filter((payment) => payment.status === 'COMPLETED');
  const customers = await fetchSquareCustomers({ token: squareToken, customerIds: completedPayments.map((payment) => payment.customer_id) });
  const kvAuditClient = flag('--skip-kv') ? null : createKvAuditClientFromEnv();

  const candidates = [];
  for (const job of completedJobs) {
    for (const payment of completedPayments) {
      const customer = customers.get(payment.customer_id);
      const evidence = matchEvidence(job, payment, customer);
      if (evidence.includes('time_window') && (evidence.includes('email') || evidence.includes('phone') || evidence.includes('name'))) {
        const attributionAudit = await auditCandidateAttributionStore({
          kv: kvAuditClient,
          job,
          payment,
          squareCustomer: customer,
        });
        candidates.push(summarizeCandidate(job, payment, customer, evidence, attributionAudit));
      }
    }
  }

  const candidatesWithLocalEvidence = candidates.filter((candidate) => candidate.attributionAudit?.available).length;
  const candidatesReadyForValidate = candidates.filter((candidate) => candidate.readyForValidate).length;
  const candidatesAlreadyUploaded = candidates.filter((candidate) => candidate.attributionAudit?.status === 'already_uploaded').length;

  const result = {
    window: { begin: beginTime.toISOString(), end: endTime.toISOString(), days },
    sourceCounts: {
      zenbookerJobsFetched: jobs.length,
      completedZenbookerJobsInWindow: completedJobs.length,
      squarePaymentsInWindow: payments.length,
      completedSquarePaymentsInWindow: completedPayments.length,
      squareCustomersFetched: customers.size,
      localAttributionStoreAvailable: Boolean(kvAuditClient),
      candidatesWithLocalEvidence,
      candidatesReadyForValidate,
      candidatesAlreadyUploaded,
    },
    zenbookerFeed: {
      earliestJobAt: jobDates[0] || null,
      latestJobAt: latestZenBookerJobAt,
      looksStaleForWindow: zenBookerLooksStale,
    },
    candidates: candidates.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || ''))),
    blocker: zenBookerLooksStale
      ? 'ZenBooker /v1/jobs read feed appears stale for this token/window; local KV audit is now available but cannot compensate for a stale job feed.'
      : candidatesReadyForValidate > 0
        ? 'One or more candidates have local mapping, paid-click, completed-payment, and no-success evidence; use only selected replay operations.'
        : kvAuditClient
          ? 'Local KV audit ran, but no Square↔ZenBooker candidate has a complete attribution evidence chain yet.'
          : 'This audit cannot prove Google-click attribution because local KV/log access is unavailable.',
    nextMove: zenBookerLooksStale
      ? 'Repair ZenBooker read scope/feed access or use production webhook evidence, then rerun this audit with local KV enabled.'
      : candidatesReadyForValidate > 0
        ? 'Dry-run selected jobRef/paymentRef/live-net tuples, then validate them; apply requires each same tuple to be explicitly approved.'
        : kvAuditClient
          ? 'Use the attributionAudit blocker on the top candidate(s) to repair missing mapping, paid-acquisition capture, or completed-payment persistence.'
          : 'Configure KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_URL/UPSTASH_REDIS_TOKEN locally, then rerun this audit.',
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Offline conversion candidate audit (${days}d)`);
  console.log(`ZenBooker jobs fetched: ${result.sourceCounts.zenbookerJobsFetched}`);
  console.log(`ZenBooker feed range: ${result.zenbookerFeed.earliestJobAt || 'n/a'} → ${result.zenbookerFeed.latestJobAt || 'n/a'}${result.zenbookerFeed.looksStaleForWindow ? ' (STALE_FOR_WINDOW)' : ''}`);
  console.log(`Completed ZenBooker jobs in window: ${result.sourceCounts.completedZenbookerJobsInWindow}`);
  console.log(`Completed Square payments in window: ${result.sourceCounts.completedSquarePaymentsInWindow}`);
  console.log(`Local attribution store: ${result.sourceCounts.localAttributionStoreAvailable ? 'available' : 'unavailable'} (${result.sourceCounts.candidatesReadyForValidate} ready_for_validate, ${result.sourceCounts.candidatesAlreadyUploaded} already_uploaded)`);
  console.log(`Candidate paid-completion matches: ${result.candidates.length}`);
  for (const candidate of result.candidates.slice(0, 10)) {
    const audit = candidate.attributionAudit?.status || 'unavailable';
    const auditEvidence = candidate.attributionAudit?.evidence?.length ? ` audit=${candidate.attributionAudit.evidence.join('+')}` : '';
    console.log(`- jobRef=${candidate.jobRef} jobNumber=${candidate.jobNumber || 'n/a'} paymentRef=${candidate.paymentRef} $${candidate.paymentNetUsd} evidence=${candidate.matchEvidence.join('+')} local=${audit}${auditEvidence} completed=${candidate.completedAt}`);
  }
  console.log(`Blocker: ${result.blocker}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`audit-offline-conversion-candidates failed: ${error.message}`);
    process.exit(1);
  });
}

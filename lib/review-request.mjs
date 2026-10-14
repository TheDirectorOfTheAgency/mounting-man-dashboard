// Staged review requests after Square payments — email only, never SMS.

import {
  normalizeEmailForEnhancedConversions,
  normalizePhoneForEnhancedConversions,
} from './booking-identity.js';
import { customerLocation } from './install-post-seeds.mjs';
import {
  chicagoDateString,
  REPORTING_TIMEZONE,
} from './square-reporting-feed.mjs';
import {
  createZenbookerReadClientFromEnv,
  isCancelledJob,
  shiftCalendarDate,
  toPublicJob,
} from './zenbooker-jobs-feed.mjs';

export const REVIEW_REQUEST_STATUSES = new Set(['staged', 'approved', 'sent', 'skipped']);

const NAME_SEARCH_DAYS_BACK = 21;

function plainSpeech(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function jobContact(job) {
  const customer = job?.customer && typeof job.customer === 'object' ? job.customer : {};
  const pub = toPublicJob(job);
  return {
    email: normalizeEmailForEnhancedConversions(customer.email || job.customer_email),
    phone: normalizePhoneForEnhancedConversions(customer.phone || customer.phone_number || job.customer_phone),
    name: normalizeName(pub.customer_name || ''),
  };
}

function contactMatchesJob(job, { email, phone, firstName, lastName }) {
  const contact = jobContact(job);
  const squareEmail = normalizeEmailForEnhancedConversions(email);
  const squarePhone = normalizePhoneForEnhancedConversions(phone);
  const squareName = normalizeName(`${firstName || ''} ${lastName || ''}`);
  if (contact.email && squareEmail && contact.email === squareEmail) return true;
  if (contact.phone && squarePhone && contact.phone === squarePhone) return true;
  if (contact.name && squareName && contact.name === squareName) return true;
  if (contact.name && firstName && contact.name.includes(normalizeName(firstName))) return true;
  return false;
}

export function buildReviewRequestEmailBody({
  firstName,
  city,
  serviceLabel,
  reviewUrl,
}) {
  const who = plainSpeech(firstName || 'there');
  const place = city ? ` in ${city}` : '';
  const service = serviceLabel ? ` your ${plainSpeech(serviceLabel)}` : ' your TV mount';
  const link = String(reviewUrl || '').trim();
  return plainSpeech(
    `Hi ${who},

Thanks again for trusting The Mounting Man${place}. I hope you're happy with${service}.

If you have a minute, a Google review helps other homeowners find us. Here's the link:
${link}

Thank you,
Marshall, The Mounting Man`,
  );
}

export function reviewRequestEnvReady(env = process.env) {
  const reviewUrl = String(env.GOOGLE_REVIEW_URL || '').trim();
  return Boolean(reviewUrl);
}

export function isReviewRequestSendEnabled(env = process.env) {
  const raw = String(env.REVIEW_REQUEST_SEND_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export async function matchZenbookerJobForCustomer(deps = {}) {
  const client = deps.client ?? createZenbookerReadClientFromEnv(deps.env || process.env);
  if (!client) return null;
  const now = deps.now || new Date();
  const today = chicagoDateString(now);
  const start = shiftCalendarDate(today, -NAME_SEARCH_DAYS_BACK);
  const boundsStart = new Date(`${start}T00:00:00-06:00`);
  const boundsEnd = new Date(`${today}T23:59:59-06:00`);
  const jobs = await client.listJobs({
    startDateMin: boundsStart.toISOString(),
    startDateMax: boundsEnd.toISOString(),
    includeCancelled: false,
    maxPages: 8,
  });
  const contact = {
    email: deps.email,
    phone: deps.phone,
    firstName: deps.firstName,
    lastName: deps.lastName,
  };
  const matches = jobs
    .filter((job) => job && !isCancelledJob(job))
    .filter((job) => contactMatchesJob(job, contact))
    .sort((a, b) => Date.parse(b.completed_at || b.end_date || b.start_date || 0)
      - Date.parse(a.completed_at || a.end_date || a.start_date || 0));
  return matches[0] || null;
}

export function jobContextFromZenbooker(job) {
  if (!job) return { jobId: null, jobNumber: null, jobDate: null, serviceLabel: null };
  const pub = toPublicJob(job);
  const services = Array.isArray(pub.services) ? pub.services : [];
  const serviceLabel = services.length ? services.join(', ') : (pub.service_name || job.service_name || null);
  const jobDate = chicagoDateString(job.completed_at || job.end_date || job.start_date);
  return {
    jobId: pub.job_id || String(job.id || ''),
    jobNumber: pub.job_number || String(job.job_number || '').replace(/^#/, ''),
    jobDate,
    serviceLabel,
  };
}

export async function stageReviewRequestForPayment(input, deps = {}) {
  const env = deps.env || process.env;
  const reviewUrl = String(env.GOOGLE_REVIEW_URL || '').trim();
  if (!reviewUrl) {
    return { status: 'refused', reason: 'missing_google_review_url' };
  }
  const store = deps.store;
  if (!store) {
    return { status: 'store_unavailable' };
  }
  const paymentId = String(input.paymentId || '').trim();
  if (!paymentId || paymentId === 'unknown') {
    return { status: 'refused', reason: 'missing_payment_id' };
  }
  const email = String(input.email || '').trim();
  if (!email) {
    return { status: 'refused', reason: 'missing_email' };
  }

  const location = customerLocation(input.customer || {});
  const city = input.city || location.city || '';
  const firstName = input.firstName || 'there';

  let zenJob = null;
  try {
    zenJob = await matchZenbookerJobForCustomer({
      env,
      now: deps.now,
      client: deps.zenbookerClient,
      email,
      phone: input.phone,
      firstName: input.firstName,
      lastName: input.lastName,
    });
  } catch (error) {
    deps.logger?.warn?.('review_request_zenbooker_match_failed', { message: error.message });
  }
  const jobCtx = jobContextFromZenbooker(zenJob);
  const emailBody = buildReviewRequestEmailBody({
    firstName,
    city,
    serviceLabel: jobCtx.serviceLabel,
    reviewUrl,
  });

  const record = {
    paymentId,
    squareCustomerId: input.squareCustomerId || null,
    status: 'staged',
    firstName,
    email,
    city: city || null,
    amount: input.amount || null,
    jobId: jobCtx.jobId,
    jobNumber: jobCtx.jobNumber,
    jobDate: jobCtx.jobDate,
    serviceLabel: jobCtx.serviceLabel,
    reviewUrl,
    emailSubject: 'Thanks from The Mounting Man',
    emailBody,
    channel: 'email',
    sms: false,
    createdAt: new Date().toISOString(),
  };

  const result = await store.saveReviewRequest(record);
  if (result.duplicate) {
    return { status: 'duplicate', record: result.record };
  }
  return { status: 'staged', record: result.record };
}

export async function sendReviewRequestEmail(record, deps = {}) {
  const env = deps.env || process.env;
  if (!isReviewRequestSendEnabled(env)) {
    return { sent: false, reason: 'send_disabled' };
  }
  if (record?.status !== 'approved') {
    return { sent: false, reason: 'not_approved' };
  }
  if (record?.status === 'sent' || record?.status === 'skipped') {
    return { sent: false, reason: 'terminal_status' };
  }
  // Hard guarantee: never SMS
  if (record?.sms === true || record?.channel === 'sms') {
    return { sent: false, reason: 'sms_forbidden' };
  }

  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.REVIEW_REQUEST_FROM_EMAIL || env.RESEND_FROM_EMAIL || '').trim();
  const to = String(record.email || '').trim();
  if (!apiKey || !from || !to) {
    return { sent: false, reason: 'email_channel_unconfigured' };
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { sent: false, reason: 'fetch_unavailable' };
  }

  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: record.emailSubject || 'Thanks from The Mounting Man',
      text: record.emailBody,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    deps.logger?.error?.('review_request_send_failed', { status: response.status, body: body.slice(0, 200) });
    return { sent: false, reason: 'provider_error', status: response.status };
  }
  return { sent: true, provider: 'resend' };
}

export async function approveReviewRequest(paymentId, deps = {}) {
  const store = deps.store;
  if (!store) return { ok: false, error: 'store_unavailable' };
  const existing = await store.getReviewRequest(paymentId);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.status === 'sent' || existing.status === 'skipped') {
    return { ok: false, error: 'terminal_status', record: existing };
  }

  let record = await store.updateReviewRequest(paymentId, {
    status: 'approved',
    approvedAt: new Date().toISOString(),
  });

  const sendResult = await sendReviewRequestEmail(record, deps);
  if (sendResult.sent) {
    record = await store.updateReviewRequest(paymentId, {
      status: 'sent',
      sentAt: new Date().toISOString(),
      sendProvider: sendResult.provider || null,
    });
  }

  return { ok: true, record, send: sendResult };
}

export async function skipReviewRequest(paymentId, deps = {}) {
  const store = deps.store;
  if (!store) return { ok: false, error: 'store_unavailable' };
  const existing = await store.getReviewRequest(paymentId);
  if (!existing) return { ok: false, error: 'not_found' };
  const record = await store.updateReviewRequest(paymentId, {
    status: 'skipped',
    skippedAt: new Date().toISOString(),
  });
  return { ok: true, record };
}

export const REVIEW_LOOP_TIMEZONE = REPORTING_TIMEZONE;

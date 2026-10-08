// Read-only car voice tools: Square collected payments, job payment status, supplies.
// America/Chicago. No writes. Voice responses include a plain spoken field.

import axios from 'axios';
import {
  normalizeEmailForEnhancedConversions,
  normalizePhoneForEnhancedConversions,
} from './booking-identity.js';
import {
  addCalendarDay,
  chicagoDateString,
  chicagoDayBounds,
  createSquareReportingClient,
  REPORTING_TIMEZONE,
  SQUARE_LOCATION_ID,
} from './square-reporting-feed.mjs';
import { amountToCents, buildZenbookerInvoiceModel } from './zenbooker-square-invoice.mjs';
import { buildSquareAppointmentModel, TV_BRACKET_MAP } from './zenbooker-square-mapper.mjs';
import {
  createZenbookerReadClientFromEnv,
  getJob,
  isCancelledJob,
  isCompletedJob,
  shiftCalendarDate,
  toPublicJob,
  ZENBOOKER_TIMEZONE,
} from './zenbooker-jobs-feed.mjs';

export const GET_PAYMENTS = 'get_payments';
export const GET_JOB_PAYMENT_STATUS = 'get_job_payment_status';
export const GET_SUPPLIES_FOR_DAY = 'get_supplies_for_day';

export const SQUARE_COLLECTED_LABEL = 'Square collected payments, not ZenBooker booked amounts';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAYMENT_LOOKUP_DAYS_BEFORE = 1;
const PAYMENT_LOOKUP_DAYS_AFTER = 21;
const NAME_SEARCH_DAYS_BACK = 90;
const NAME_SEARCH_DAYS_FORWARD = 14;
const LAST_JOB_DAYS_BACK = 60;

const SOURCE = {
  business: 'The Mounting Man',
  timezone: REPORTING_TIMEZONE,
};

const BRACKET_SUPPLY = {
  'Fixed Bracket': 'fixed_mount',
  Fixed: 'fixed_mount',
  'Flush Mounting Bracket': 'fixed_mount',
  'Standard Tilt Mount (For Up to 86" TVs)': 'tilt_mount',
  Tilting: 'tilt_mount',
  'Buy Tilt TV Mounting Bracket': 'tilt_mount',
  '98" -  100" TV Tilt Bracket': 'tilt_mount',
  'Premium 4D Tilt Mount': 'tilt_mount',
  'Premium Tilt Mounting Bracket': 'tilt_mount',
  'Standard Full Motion Mount (For up to 86" TVs)': 'full_motion_mount',
  'Full Motion': 'full_motion_mount',
  'Buy Full Motion (Articulating) TV Mounting Bracket': 'full_motion_mount',
  'Corner Mounting Bracket': 'full_motion_mount',
  'Premium Full Motion Mounting Bracket': 'full_motion_mount',
  'Premium Full Motion Mounting Bracket (Special)': 'full_motion_mount',
};

const MAPPED_SERVICE_NAMES = new Set([
  'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
  'Mount 1 Or More TVs (Normal TV(s) Onto Any Surface.)',
  'Picture Frame (Gallery) Style TVs (Samsung Frame, LG G Series, Hisense Canvas, TCL NXTFRAME...)',
  'The Mantel Mount Installation',
  'Unmount TVs (Minimum Booking $150)',
  'Outdoor TV Mounting',
  'Special TV Mounting Situation',
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainSpeech(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

function speakMoney(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'an unknown amount';
  const dollars = Math.trunc(value);
  const cents = Math.abs(Math.round((value - dollars) * 100));
  if (cents === 0) return `${dollars} dollars`;
  return `${dollars} dollars and ${cents} cents`;
}

function speakDayLabel(dayKey, now) {
  const today = chicagoDateString(now);
  if (dayKey === 'today' || dayKey === today) return 'today';
  if (dayKey === 'yesterday') {
    const y = today ? addCalendarDay(today, -1) : null;
    return y === addCalendarDay(today, -1) ? 'yesterday' : dayKey;
  }
  if (dayKey === 'this_week') return 'this week';
  if (dayKey === 'tomorrow') {
    const t = today ? addCalendarDay(today, 1) : null;
    return t ? 'tomorrow' : dayKey;
  }
  const match = DATE_RE.exec(String(dayKey || ''));
  if (!match) return String(dayKey || 'that day');
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 18));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTING_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instant);
}

function chicagoWeekBounds(now) {
  const today = chicagoDateString(now);
  const match = DATE_RE.exec(today || '');
  if (!match) throw new Error(`Unexpected America/Chicago date: ${today}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTING_TIMEZONE,
    weekday: 'short',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const index = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
  if (index == null) throw new Error(`Unexpected America/Chicago weekday: ${weekday}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const formatUtcYmd = (utcMs) => {
    const date = new Date(utcMs);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  };
  return {
    weekStart: formatUtcYmd(Date.UTC(year, month - 1, day - index)),
    weekEnd: formatUtcYmd(Date.UTC(year, month - 1, day - index + 6)),
  };
}

function centsToDollars(cents) {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount) / 100;
}

function paymentNetCents(payment) {
  const total = payment?.total_money?.amount ?? payment?.amount_money?.amount ?? 0;
  const refunded = payment?.refunded_money?.amount ?? 0;
  return Number(total) - Number(refunded);
}

function formatChicagoTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTING_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function resolvePaymentsDay(raw, now) {
  const value = String(raw?.day ?? raw?.date ?? 'today').trim().toLowerCase();
  const today = chicagoDateString(now);
  if (!today) throw codedError('invalid_day', 'day must be today, yesterday, or this_week');
  if (value === 'today') {
    const bounds = chicagoDayBounds(today);
    return { day: 'today', startDate: today, endDate: today, ...bounds };
  }
  if (value === 'yesterday') {
    const date = addCalendarDay(today, -1);
    const bounds = chicagoDayBounds(date);
    return { day: 'yesterday', startDate: date, endDate: date, ...bounds };
  }
  if (value === 'this_week') {
    const { weekStart, weekEnd } = chicagoWeekBounds(now);
    const startBounds = chicagoDayBounds(weekStart);
    const endBounds = chicagoDayBounds(weekEnd);
    return {
      day: 'this_week',
      startDate: weekStart,
      endDate: weekEnd,
      beginTime: startBounds.beginTime,
      endTime: endBounds.endTime,
    };
  }
  throw codedError('invalid_day', 'day must be today, yesterday, or this_week');
}

function resolveSuppliesDay(raw, now) {
  const today = chicagoDateString(now);
  if (!today) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  let value = raw?.day ?? raw?.date;
  if (value == null || value === '') value = 'tomorrow';
  const normalized = String(value).trim().toLowerCase();
  let date = today;
  if (normalized === 'tomorrow') date = addCalendarDay(today, 1);
  else if (normalized === 'today') date = today;
  else if (DATE_RE.test(String(value).trim())) date = String(value).trim();
  else throw codedError('invalid_date', 'day must be today, tomorrow, or YYYY-MM-DD in America/Chicago');
  if (!DATE_RE.test(date)) throw codedError('invalid_date', 'day must be today, tomorrow, or YYYY-MM-DD in America/Chicago');
  return { date, day: normalized === 'today' || normalized === 'tomorrow' ? normalized : date };
}

export function createCarToolsSquareClient(env = process.env) {
  const token = env.SQUARE_ACCESS_TOKEN || env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || env.NEXT_PUBLIC_SQUARE_LOCATION_ID || SQUARE_LOCATION_ID;
  if (!token) return null;
  const base = createSquareReportingClient({
    token,
    locationId,
    httpClient: axios,
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Square-Version': '2024-01-18',
    'Content-Type': 'application/json',
  };
  return {
    ...base,
    async batchCustomers(customerIds) {
      const ids = [...new Set((customerIds || []).filter(Boolean))];
      const customers = {};
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const response = await axios.post(
          'https://connect.squareup.com/v2/customers/batch-retrieve',
          { customer_ids: chunk },
          { headers },
        );
        for (const customer of response.data?.customers || []) {
          if (customer?.id) customers[customer.id] = customer;
        }
      }
      return customers;
    },
    async searchOrders({ locationId: loc, beginTime, endTime }) {
      const orders = [];
      let cursor;
      do {
        const body = {
          location_ids: [loc || locationId],
          query: {
            filter: {
              date_time_filter: {
                created_at: {
                  start_at: beginTime,
                  end_at: endTime,
                },
              },
              state_filter: { states: ['COMPLETED', 'OPEN'] },
            },
            sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
          },
          limit: 100,
        };
        if (cursor) body.cursor = cursor;
        const response = await axios.post(
          'https://connect.squareup.com/v2/orders/search',
          body,
          { headers },
        );
        orders.push(...(response.data?.orders || []));
        cursor = response.data?.cursor || null;
      } while (cursor);
      return orders;
    },
  };
}

function customerDisplayName(customer) {
  if (!customer || typeof customer !== 'object') return null;
  const given = String(customer.given_name || '').trim();
  const family = String(customer.family_name || '').trim();
  const combined = [given, family].filter(Boolean).join(' ');
  if (combined) return combined;
  const company = String(customer.company_name || '').trim();
  return company || null;
}

function isCompletedAtLocation(payment, locationId) {
  if (!payment || payment.status !== 'COMPLETED') return false;
  if (payment.location_id && payment.location_id !== locationId) return false;
  return true;
}

function sanitizePaymentRow(payment, customerName) {
  const amount = centsToDollars(paymentNetCents(payment));
  const tip = centsToDollars(payment.tip_money?.amount ?? 0);
  const refunded = centsToDollars(payment.refunded_money?.amount ?? 0);
  return {
    payment_id: payment.id || null,
    customer_name: customerName || null,
    amount: { value: amount, currency: 'USD' },
    tip: tip > 0 ? { value: tip, currency: 'USD' } : null,
    refund: refunded > 0 ? { value: refunded, currency: 'USD' } : null,
    paid_at: payment.created_at || null,
    time_label: formatChicagoTime(payment.created_at),
  };
}

function speakPayments(range, rows, errorMessage) {
  const when = speakDayLabel(range.day, new Date(range.beginTime));
  const basis = `These are ${SQUARE_COLLECTED_LABEL}.`;
  if (errorMessage) {
    return plainSpeech(`Square payments could not be loaded ${when}. ${errorMessage} ${basis}`);
  }
  if (!rows.length) {
    return plainSpeech(`Square shows no completed payments ${when}. ${basis}`);
  }
  const total = rows.reduce((sum, row) => sum + row.amount.value, 0);
  const countWord = rows.length === 1 ? 'payment' : 'payments';
  let text = `Square collected ${speakMoney(total)} ${when} from ${rows.length} ${countWord}.`;
  const lines = rows.map((row) => {
    const who = row.customer_name || 'A customer';
    const time = row.time_label ? ` at ${row.time_label}` : '';
    const tip = row.tip ? ` including a ${speakMoney(row.tip.value)} tip` : '';
    const refund = row.refund ? ` with ${speakMoney(row.refund.value)} refunded` : '';
    return `${who} paid ${speakMoney(row.amount.value)}${time}${tip}${refund}.`;
  });
  text += ` ${lines.join(' ')} ${basis}`;
  return plainSpeech(text);
}

export async function getPayments(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const range = resolvePaymentsDay(args, now);
  const squareClient = deps.squareClient;
  if (!squareClient) {
    const spoken = speakPayments(range, [], 'Square is not configured.');
    return {
      ...SOURCE,
      tool: GET_PAYMENTS,
      source: 'Square',
      revenue_basis: SQUARE_COLLECTED_LABEL,
      day: range.day,
      date_range: { start: range.startDate, end: range.endDate },
      timezone: REPORTING_TIMEZONE,
      total_collected: null,
      payment_count: 0,
      payments: [],
      error: 'square_unconfigured',
      spoken,
    };
  }

  try {
    const listed = await squareClient.listPayments({
      beginTime: range.beginTime,
      endTime: range.endTime,
    });
    const payments = listed.filter((payment) => (
      isCompletedAtLocation(payment, squareClient.locationId)
      && chicagoDateString(payment.created_at) >= range.startDate
      && chicagoDateString(payment.created_at) <= range.endDate
    ));
    const customerIds = payments.map((payment) => payment.customer_id).filter(Boolean);
    const customers = customerIds.length
      ? await squareClient.batchCustomers(customerIds)
      : {};
    const rows = payments
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
      .map((payment) => sanitizePaymentRow(
        payment,
        customerDisplayName(customers[payment.customer_id]),
      ));
    const total = rows.reduce((sum, row) => sum + row.amount.value, 0);
    return {
      ...SOURCE,
      tool: GET_PAYMENTS,
      source: 'Square',
      revenue_basis: SQUARE_COLLECTED_LABEL,
      day: range.day,
      date_range: { start: range.startDate, end: range.endDate },
      timezone: REPORTING_TIMEZONE,
      total_collected: { amount: Math.round(total * 100) / 100, currency: 'USD' },
      payment_count: rows.length,
      payments: rows,
      spoken: speakPayments(range, rows, null),
    };
  } catch (error) {
    deps.logger?.error?.('car_tools_get_payments_failed', { message: error.message });
    const spoken = speakPayments(range, [], 'Square returned an error, so the collected total is unavailable.');
    return {
      ...SOURCE,
      tool: GET_PAYMENTS,
      source: 'Square',
      revenue_basis: SQUARE_COLLECTED_LABEL,
      day: range.day,
      date_range: { start: range.startDate, end: range.endDate },
      timezone: REPORTING_TIMEZONE,
      total_collected: null,
      payment_count: 0,
      payments: [],
      error: 'square_unavailable',
      spoken,
    };
  }
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function customerNameFromJob(job) {
  const pub = toPublicJob(job);
  return pub.customer_name || null;
}

function jobContact(job) {
  const customer = job?.customer && typeof job.customer === 'object' ? job.customer : {};
  return {
    email: normalizeEmailForEnhancedConversions(customer.email || job.customer_email),
    phone: normalizePhoneForEnhancedConversions(customer.phone || customer.phone_number || job.customer_phone),
    name: normalizeName(customerNameFromJob(job)),
  };
}

function orderMatchesJob(order, job) {
  if (!order || !job) return false;
  const meta = order.metadata || {};
  const jobId = String(job.id || '');
  const jobNumber = String(job.job_number || '').replace(/^#/, '');
  if (meta.zenbooker_job_id && String(meta.zenbooker_job_id) === jobId) return true;
  if (meta.zenbooker_job_number && String(meta.zenbooker_job_number).replace(/^#/, '') === jobNumber) return true;
  const ref = String(order.reference_id || '');
  if (jobNumber && ref.includes(jobNumber)) return true;
  if (jobId && ref.includes(jobId)) return true;
  return false;
}

function expectedJobTotalCents(job) {
  const invoice = job.invoice && typeof job.invoice === 'object' ? job.invoice : {};
  const services = Array.isArray(job.services) ? job.services : [];
  const model = buildZenbookerInvoiceModel({
    rawServices: services,
    fallbackServiceName: job.service_name || '',
    totalAmount: invoice.total ?? invoice.amount ?? null,
  });
  if (model.expectedTotalCents > 0) return model.expectedTotalCents;
  if (model.subtotalCents > 0) return model.subtotalCents;
  const price = toPublicJob(job).price;
  return price ? amountToCents(price.amount) : 0;
}

function zenbookerInvoicePaidCents(job) {
  const invoice = job.invoice && typeof job.invoice === 'object' ? job.invoice : {};
  const paid = invoice.amount_paid ?? invoice.paid ?? invoice.amountPaid;
  return amountToCents(paid);
}

function paymentContactMatches(payment, customer, jobContactInfo) {
  if (!customer) return false;
  const squareEmail = normalizeEmailForEnhancedConversions(customer.email_address);
  const squarePhone = normalizePhoneForEnhancedConversions(customer.phone_number);
  const squareName = normalizeName(`${customer.given_name || ''} ${customer.family_name || ''}`);
  if (jobContactInfo.email && squareEmail && jobContactInfo.email === squareEmail) return true;
  if (jobContactInfo.phone && squarePhone && jobContactInfo.phone === squarePhone) return true;
  if (jobContactInfo.name && squareName && jobContactInfo.name === squareName) return true;
  return false;
}

function classifyPaymentStatus({ expectedCents, paidCents, matches }) {
  if (!matches.length && paidCents <= 0) return 'unpaid';
  if (!matches.length) return 'unknown';
  const best = matches[0];
  const net = paymentNetCents(best.payment);
  if (expectedCents > 0) {
    if (net >= expectedCents - 100) return 'paid';
    if (net > 0) return 'partial';
    return 'unpaid';
  }
  if (net > 0) return 'paid';
  return 'unknown';
}

function speakPaymentStatus(result) {
  if (result.ambiguous_matches?.length) {
    const names = result.ambiguous_matches
      .map((job) => `${job.customer_name || 'A customer'} job ${job.job_number || job.job_id}`)
      .join('; ');
    return plainSpeech(`More than one job matched that name: ${names}. Say the job number instead of guessing.`);
  }
  if (!result.found || !result.job) {
    return plainSpeech('I could not find that ZenBooker job, so payment status is unknown.');
  }
  const who = result.job.customer_name || 'That customer';
  const basis = 'This compares ZenBooker to Square collected payments.';
  if (result.status === 'paid') {
    const when = result.paid_at_label ? ` on ${result.paid_at_label}` : '';
    const amount = result.amount ? speakMoney(result.amount.value) : 'the expected amount';
    return plainSpeech(`${who} is paid. Square collected ${amount}${when}. ${basis}`);
  }
  if (result.status === 'partial') {
    const paid = result.amount ? speakMoney(result.amount.value) : 'a partial amount';
    const expected = result.expected_amount ? speakMoney(result.expected_amount.value) : 'the booked total';
    return plainSpeech(`${who} is only partially paid. Square shows ${paid} against about ${expected}. ${basis}`);
  }
  if (result.status === 'unpaid') {
    return plainSpeech(`${who} looks unpaid in Square so far. ${basis}`);
  }
  return plainSpeech(`Payment status for ${who} is unknown. ${basis}`);
}

async function listJobsWindow(client, startDate, endDate, includeCancelled = true) {
  const start = chicagoDayBounds(startDate);
  const end = chicagoDayBounds(endDate);
  return client.listJobs({
    startDateMin: start.beginTime,
    startDateMax: end.endTime,
    includeCancelled,
    maxPages: 10,
  });
}

async function listJobsForDate(client, date) {
  const bounds = chicagoDayBounds(date);
  const jobs = await client.listJobs({
    startDateMin: bounds.beginTime,
    startDateMax: bounds.endTime,
    includeCancelled: false,
    maxPages: 5,
  });
  return jobs
    .filter((job) => job && job.start_date && chicagoDateString(job.start_date) === date)
    .filter((job) => !isCancelledJob(job));
}

async function resolveTargetJob(args, deps) {
  const client = deps.client;
  if (!client) throw codedError('zenbooker_unconfigured', 'ZenBooker is not configured');
  const now = deps.now || new Date();
  const today = chicagoDateString(now);
  const query = String(args.query || args.customer_name || args.customer || '').trim();
  const jobId = String(args.job_id || args.jobId || '').trim();
  const jobNumber = String(args.job_number || args.jobNumber || '').trim();

  if (jobId || jobNumber) {
    const found = await getJob({ job_id: jobId, job_number: jobNumber }, deps);
    if (!found.found || !found.job) return { kind: 'missing', query: { job_id: jobId, job_number: jobNumber } };
    const raw = await client.getJob(found.job.job_id);
    return { kind: 'single', job: raw || null, public: found.job };
  }

  if (normalizeName(query) === 'last') {
    const start = shiftCalendarDate(today, -LAST_JOB_DAYS_BACK);
    const jobs = await listJobsWindow(client, start, today, true);
    const completed = jobs
      .filter((job) => isCompletedJob(job))
      .sort((left, right) => Date.parse(right.completed_at || right.end_date || right.start_date)
        - Date.parse(left.completed_at || left.end_date || left.start_date));
    const job = completed[0] || null;
    if (!job) return { kind: 'missing', query: { query: 'last' } };
    return { kind: 'single', job, public: toPublicJob(job) };
  }

  if (!query) throw codedError('invalid_job', 'customer name, job id, job number, or query last is required');

  const start = shiftCalendarDate(today, -NAME_SEARCH_DAYS_BACK);
  const end = shiftCalendarDate(today, NAME_SEARCH_DAYS_FORWARD);
  const jobs = await listJobsWindow(client, start, end, true);
  const needle = normalizeName(query);
  const matches = jobs.filter((job) => normalizeName(customerNameFromJob(job)).includes(needle));
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      matches: matches.map((job) => ({
        job_id: String(job.id),
        job_number: String(job.job_number || '').replace(/^#/, ''),
        customer_name: customerNameFromJob(job),
        date: chicagoDateString(job.start_date),
      })),
    };
  }
  if (matches.length === 1) {
    return { kind: 'single', job: matches[0], public: toPublicJob(matches[0]) };
  }
  return { kind: 'missing', query: { customer_name: query } };
}

export async function getJobPaymentStatus(args = {}, deps = {}) {
  const target = await resolveTargetJob(args, deps);
  if (target.kind === 'ambiguous') {
    const result = {
      ...SOURCE,
      tool: GET_JOB_PAYMENT_STATUS,
      source: 'ZenBooker + Square',
      found: false,
      status: 'unknown',
      ambiguous_matches: target.matches,
      job: null,
      spoken: speakPaymentStatus({ ambiguous_matches: target.matches }),
    };
    return result;
  }
  if (target.kind === 'missing' || !target.job) {
    return {
      ...SOURCE,
      tool: GET_JOB_PAYMENT_STATUS,
      source: 'ZenBooker + Square',
      found: false,
      status: 'unknown',
      query: target.query,
      job: null,
      spoken: speakPaymentStatus({ found: false }),
    };
  }

  const job = target.job;
  const publicJob = target.public || toPublicJob(job);
  const expectedCents = expectedJobTotalCents(job);
  const invoicePaidCents = zenbookerInvoicePaidCents(job);
  const contact = jobContact(job);
  const jobDate = chicagoDateString(job.completed_at || job.end_date || job.start_date);
  const squareClient = deps.squareClient;
  let matches = [];
  let paidAt = null;

  if (squareClient && jobDate) {
    try {
      const beginDate = shiftCalendarDate(jobDate, -PAYMENT_LOOKUP_DAYS_BEFORE);
      const endDate = shiftCalendarDate(jobDate, PAYMENT_LOOKUP_DAYS_AFTER);
      const begin = chicagoDayBounds(beginDate);
      const end = chicagoDayBounds(endDate);
      const payments = (await squareClient.listPayments({
        beginTime: begin.beginTime,
        endTime: end.endTime,
      })).filter((payment) => isCompletedAtLocation(payment, squareClient.locationId));
      const orderIds = payments.map((payment) => payment.order_id).filter(Boolean);
      const orders = orderIds.length ? await squareClient.batchOrders(orderIds) : {};
      const customerIds = payments.map((payment) => payment.customer_id).filter(Boolean);
      const customers = customerIds.length ? await squareClient.batchCustomers(customerIds) : {};
      const scored = [];
      for (const payment of payments) {
        const order = payment.order_id ? orders[payment.order_id] : null;
        let score = 0;
        if (order && orderMatchesJob(order, job)) score += 100;
        const customer = payment.customer_id ? customers[payment.customer_id] : null;
        if (paymentContactMatches(payment, customer, contact)) score += 40;
        const paidTime = Date.parse(payment.created_at || '');
        const jobTime = Date.parse(job.completed_at || job.end_date || job.start_date || '');
        if (!Number.isNaN(paidTime) && !Number.isNaN(jobTime) && Math.abs(paidTime - jobTime) <= MATCH_WINDOW_MS) {
          score += 20;
        }
        const net = paymentNetCents(payment);
        if (expectedCents > 0 && Math.abs(net - expectedCents) <= 500) score += 30;
        if (score > 0) scored.push({ payment, score, net });
      }
      scored.sort((left, right) => right.score - left.score);
      const best = scored.filter((entry) => entry.score >= 60);
      matches = best.length ? [best[0]] : (scored[0]?.score >= 100 ? [scored[0]] : []);
      if (matches[0]) paidAt = matches[0].payment.created_at;
    } catch (error) {
      deps.logger?.error?.('car_tools_job_payment_square_failed', { message: error.message });
    }
  }

  let status = classifyPaymentStatus({
    expectedCents,
    paidCents: matches[0]?.net || invoicePaidCents,
    matches: matches.map((entry) => entry.payment),
  });
  if (status === 'unknown' && invoicePaidCents > 0) {
    status = expectedCents > 0 && invoicePaidCents < expectedCents - 100 ? 'partial' : 'paid';
  }
  if (status === 'unpaid' && invoicePaidCents > 0) {
    status = expectedCents > 0 && invoicePaidCents < expectedCents - 100 ? 'partial' : 'paid';
  }

  const amountCents = matches[0]?.net || invoicePaidCents || 0;
  const result = {
    ...SOURCE,
    tool: GET_JOB_PAYMENT_STATUS,
    source: 'ZenBooker + Square',
    found: true,
    status,
    job: {
      job_id: publicJob.job_id,
      job_number: publicJob.job_number,
      customer_name: publicJob.customer_name,
      date: publicJob.date,
      expected_amount: expectedCents > 0
        ? { value: centsToDollars(expectedCents), currency: 'USD' }
        : null,
    },
    amount: amountCents > 0 ? { value: centsToDollars(amountCents), currency: 'USD' } : null,
    paid_at: paidAt,
    paid_at_label: formatChicagoTime(paidAt),
    square_payment_id: matches[0]?.payment?.id || null,
    match_basis: matches.length ? 'square_order_or_customer_match' : (invoicePaidCents > 0 ? 'zenbooker_invoice' : 'none'),
    spoken: '',
  };
  result.spoken = speakPaymentStatus(result);
  return result;
}

function normalizeLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

function isNoSelection(label) {
  const lower = normalizeLabel(label).toLowerCase();
  return (
    lower === 'no' ||
    lower === 'none' ||
    lower.startsWith('no ') ||
    lower.includes('not needed') ||
    lower.includes('no soundbar') ||
    lower.includes('no sound bar')
  );
}

function fieldSelectionsFromJobFields(fields) {
  const out = [];
  for (const field of fields || []) {
    const fieldName = field?.field_name || field?.name || '';
    const selections = [];
    for (const option of field?.selected_options || []) {
      const label = normalizeLabel(option?.display_label || option?.text || option?.label);
      if (!label || isNoSelection(label)) continue;
      selections.push({
        label,
        quantity: Math.max(1, Number(option?.quantity) || 1),
      });
    }
    if (field?.text_value && String(field.text_value).trim()) {
      selections.push({ label: String(field.text_value).trim(), quantity: 1 });
    }
    if (selections.length) out.push({ fieldName, selections });
  }
  return out;
}

function optionSelectionsFromPricing(pricingSummary) {
  const out = [];
  for (const entry of pricingSummary || []) {
    const label = normalizeLabel(entry?.description || entry?.name);
    if (!label) continue;
    const quantityMatch = label.match(/^(\d+)\s*x\s+(.+)$/i);
    out.push({
      fieldName: 'Pricing summary',
      label: quantityMatch ? quantityMatch[2] : label,
      quantity: quantityMatch ? Math.max(1, Number(quantityMatch[1]) || 1) : 1,
    });
  }
  return out;
}

function extractServiceGroups(job) {
  const groups = [];
  const services = Array.isArray(job.services) ? job.services : [];
  if (services.length) {
    for (const service of services) {
      const fields = [
        ...(Array.isArray(service.service_fields) ? service.service_fields : []),
        ...(Array.isArray(service.service_selections) ? service.service_selections : []),
      ];
      const fieldSelections = fieldSelectionsFromJobFields(fields);
      const optionSelections = [
        ...fieldSelections.flatMap((field) => field.selections.map((selection) => ({
          fieldName: field.fieldName,
          label: selection.label,
          quantity: selection.quantity,
        }))),
        ...optionSelectionsFromPricing(service.pricing_summary),
      ];
      groups.push({
        serviceName: service.service_name || service.name || job.service_name || '',
        fieldSelections,
        optionSelections,
      });
    }
    return groups;
  }
  if (job.service_name) {
    groups.push({
      serviceName: job.service_name,
      fieldSelections: fieldSelectionsFromJobFields(job.service_fields || []),
      optionSelections: [],
    });
  }
  return groups;
}

function emptySupplyTally() {
  return {
    tilt_mount: 0,
    full_motion_mount: 0,
    fixed_mount: 0,
    mantel_mount: 0,
    hdmi_cable: 0,
    soundbar_bracket: 0,
    in_wall_kit: 0,
  };
}

function addSupply(tally, key, quantity = 1) {
  if (!key || !Object.prototype.hasOwnProperty.call(tally, key)) return;
  tally[key] += Math.max(1, Number(quantity) || 1);
}

function labelSupplyHints(label) {
  const lower = normalizeLabel(label).toLowerCase();
  const hints = [];
  if (/\bhdmi\b/.test(lower)) hints.push('hdmi_cable');
  if (/\bsound\s*bar\b|\bsoundbar\b/.test(lower) && !/no sound/.test(lower)) hints.push('soundbar_bracket');
  if (
    /\bin-?wall\b/.test(lower) ||
    /\bcord conceal/.test(lower) ||
    /\bpower kit\b/.test(lower) ||
    /\boutlet behind\b/.test(lower)
  ) hints.push('in_wall_kit');
  return hints;
}

function tallySuppliesForJob(job) {
  const perJob = emptySupplyTally();
  const notes = [];
  const unmappedServices = [];
  const groups = extractServiceGroups(job);
  if (!groups.length) {
    return { perJob, notes, unmappedServices: job.service_name ? [job.service_name] : [] };
  }
  const model = buildSquareAppointmentModel({
    serviceGroups: groups,
    rawNotes: typeof job.job_notes === 'string' ? job.job_notes : '',
  });
  for (const item of model.segmentItems || []) {
    if (item.segmentType === 'bracket') {
      const label = normalizeLabel(item.label.replace(/^Bracket:\s*/i, ''));
      const key = BRACKET_SUPPLY[label] || BRACKET_SUPPLY[Object.keys(TV_BRACKET_MAP).find((name) => TV_BRACKET_MAP[name] === item.catalog_object_id)];
      if (key) addSupply(perJob, key, 1);
    }
  }
  for (const group of groups) {
    const serviceName = normalizeLabel(group.serviceName);
    if (/mantel/i.test(serviceName)) addSupply(perJob, 'mantel_mount', 1);
    else if (serviceName && !MAPPED_SERVICE_NAMES.has(serviceName)) {
      unmappedServices.push(serviceName);
    }
    for (const field of group.fieldSelections || []) {
      for (const selection of field.selections || []) {
        for (const hint of labelSupplyHints(selection.label)) {
          addSupply(perJob, hint, selection.quantity);
        }
      }
    }
    for (const selection of group.optionSelections || []) {
      for (const hint of labelSupplyHints(selection.label)) {
        addSupply(perJob, hint, selection.quantity);
      }
    }
  }
  if (model.note) notes.push(model.note);
  if (model.unknownOptions?.length) {
    for (const label of model.unknownOptions) unmappedServices.push(label);
  }
  return { perJob, notes, unmappedServices: [...new Set(unmappedServices)] };
}

function mergeSupplyTotals(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] || 0;
  }
  return target;
}

function supplyLines(tally) {
  const labels = {
    tilt_mount: 'tilt TV mount',
    full_motion_mount: 'full motion TV mount',
    fixed_mount: 'fixed TV mount',
    mantel_mount: 'MantelMount bracket',
    hdmi_cable: 'HDMI cable',
    soundbar_bracket: 'soundbar bracket',
    in_wall_kit: 'in-wall cord or power kit',
  };
  return Object.entries(tally)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${labels[key]}${count === 1 ? '' : 's'}`);
}

function speakSupplies(date, now, jobs, perJobRows, totals, unmapped) {
  const when = speakDayLabel(date, now);
  if (!jobs.length) {
    return plainSpeech(`You have no jobs ${when}, so there is nothing to bring.`);
  }
  const jobWord = jobs.length === 1 ? 'job' : 'jobs';
  let text = `For ${when}, you have ${jobs.length} ${jobWord}.`;
  for (const row of perJobRows) {
    const who = row.customer_name || 'A customer';
    const items = supplyLines(row.supplies);
    if (!items.length && !row.unmapped_services.length) {
      text += ` ${who}: no mapped supplies; check the job notes.`;
    } else if (items.length) {
      text += ` ${who}: bring ${items.join(', ')}.`;
    }
    if (row.unmapped_services.length) {
      text += ` Unmapped service for ${who}: ${row.unmapped_services.join(', ')}.`;
    }
    if (row.notes?.length) {
      text += ` Notes for ${who}: ${plainSpeech(row.notes.join(' '))}.`;
    }
  }
  const totalItems = supplyLines(totals);
  if (totalItems.length) text += ` In total, bring ${totalItems.join(', ')}.`;
  if (unmapped.length) {
    text += ` Unmapped services overall: ${[...new Set(unmapped)].join(', ')}.`;
  }
  return plainSpeech(text);
}

export async function getSuppliesForDay(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const { date } = resolveSuppliesDay(args, now);
  const client = deps.client;
  if (!client) throw codedError('zenbooker_unconfigured', 'ZenBooker is not configured');
  const rawJobs = await listJobsForDate(client, date);
  const totals = emptySupplyTally();
  const unmapped = [];
  const perJobRows = [];
  for (const job of rawJobs) {
    const pub = toPublicJob(job);
    const { perJob, notes, unmappedServices } = tallySuppliesForJob(job);
    mergeSupplyTotals(totals, perJob);
    unmapped.push(...unmappedServices);
    perJobRows.push({
      job_id: pub.job_id,
      job_number: pub.job_number,
      customer_name: pub.customer_name,
      time_window: pub.time_window,
      supplies: perJob,
      unmapped_services: unmappedServices,
      notes,
    });
  }
  return {
    ...SOURCE,
    tool: GET_SUPPLIES_FOR_DAY,
    source: 'ZenBooker',
    date,
    timezone: ZENBOOKER_TIMEZONE,
    job_count: rawJobs.length,
    totals,
    jobs: perJobRows,
    unmapped_services: [...new Set(unmapped)],
    spoken: speakSupplies(date, now, rawJobs, perJobRows, totals, unmapped),
  };
}

export { createZenbookerReadClientFromEnv };

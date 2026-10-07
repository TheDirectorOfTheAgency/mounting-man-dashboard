// Read-only ZenBooker schedule for The Mounting Man.
// GET /jobs and GET /jobs/{id} only. No creates, updates, or cancels.

import {
  addCalendarDay,
  chicagoDateString,
  chicagoDayBounds,
} from './square-reporting-feed.mjs';

export const ZENBOOKER_TIMEZONE = 'America/Chicago';
export const DEFAULT_ZENBOOKER_BASE_URL = 'https://api.zenbooker.com/v1';
export const UPCOMING_DAYS_DEFAULT = 7;
export const UPCOMING_DAYS_MAX = 31;
export const JOB_LOOKUP_PAST_DAYS = 120;
export const JOB_LOOKUP_FUTURE_DAYS = 180;

export const GET_JOBS_FOR_DAY = 'get_jobs_for_day';
export const GET_UPCOMING_JOBS = 'get_upcoming_jobs';
export const GET_JOB = 'get_job';
export const GET_ROUTE_FOR_DAY = 'get_route_for_day';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUBBLE_ID_RE = /^\d{8,}x\d+/;
const INSTRUCTION_FIELD_RE = /note|instruction/i;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeBareEmpties(text) {
  return String(text)
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (match) => match.replace(',', 'null,'))
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*\}/g, (match) => match.replace('}', 'null}'));
}

export function parseZenbookerBody(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string' || !data.trim()) return null;
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

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function resolveChicagoDate(input, now = new Date()) {
  if (input == null || String(input).trim() === '') {
    const today = chicagoDateString(now);
    if (!today) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
    return today;
  }
  const date = String(input).trim();
  if (!DATE_RE.test(date)) {
    throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  }
  const noon = chicagoDayBounds(date);
  if (!noon || chicagoDateString(noon.beginTime) !== date) {
    throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  }
  return date;
}

export function parseUpcomingDays(value) {
  if (value == null || value === '') return UPCOMING_DAYS_DEFAULT;
  if (typeof value === 'boolean') {
    throw codedError('invalid_days', 'days must be an integer from 1 to 31');
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > UPCOMING_DAYS_MAX) {
    throw codedError('invalid_days', 'days must be an integer from 1 to 31');
  }
  return parsed;
}

export function includeCancelled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function addDays(dateStr, days) {
  let cursor = dateStr;
  for (let i = 0; i < days; i += 1) {
    cursor = addCalendarDay(cursor);
    if (!cursor) return null;
  }
  return cursor;
}

function chicagoTimeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZENBOOKER_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function isCancelledJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.canceled === true || job.cancelled === true) return true;
  const status = String(job.status || '').toLowerCase();
  return status === 'canceled' || status === 'cancelled';
}

function noteTexts(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => noteTexts(item?.text ?? item)).filter(Boolean);
  }
  if (typeof value === 'object') return noteTexts(value.text);
  return [];
}

function instructionFields(job) {
  const services = Array.isArray(job?.services) ? job.services : [];
  return [
    ...(Array.isArray(job?.job_fields) ? job.job_fields : []),
    ...(Array.isArray(job?.service_fields) ? job.service_fields : []),
    ...services.flatMap((service) => [
      ...(Array.isArray(service?.service_fields) ? service.service_fields : []),
      ...(Array.isArray(service?.job_fields) ? service.job_fields : []),
    ]),
  ];
}

function specialInstructionTexts(job) {
  const texts = [];
  for (const field of instructionFields(job)) {
    const name = String(field?.field_name || field?.name || '');
    if (!INSTRUCTION_FIELD_RE.test(name)) continue;
    if (field?.text_value) texts.push(String(field.text_value).trim());
    const options = Array.isArray(field?.selected_options) ? field.selected_options : [];
    for (const option of options) {
      const bit = [option?.text, option?.comments].map((part) => compact(part)).filter(Boolean).join(' — ');
      if (bit) texts.push(bit);
    }
  }
  return texts.filter(Boolean);
}

export function jobNotes(job) {
  const parts = [
    ...noteTexts(job?.job_notes),
    ...noteTexts(job?.notes),
    ...noteTexts(job?.special_instructions),
    ...specialInstructionTexts(job),
    ...noteTexts(job?.customer?.notes),
  ].map((part) => String(part).trim()).filter(Boolean);
  return [...new Set(parts)].join('\n');
}

export function serviceNames(job) {
  const names = [];
  const push = (value) => {
    const name = compact(value);
    if (name && !names.includes(name)) names.push(name);
  };
  push(job?.service_name);
  const services = Array.isArray(job?.services) ? job.services : [];
  for (const service of services) {
    push(service?.service_name || service?.name || service?.title || service?.service?.name);
  }
  return names;
}

export function installerNames(job) {
  const lists = [job?.assigned_providers, job?.service_providers, job?.providers];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const names = list.map((entry) => {
      if (!entry) return '';
      if (typeof entry === 'string') {
        const name = entry.trim();
        return BUBBLE_ID_RE.test(name) ? '' : name;
      }
      return compact(entry.name || entry.full_name || entry.display_name);
    }).filter(Boolean);
    if (names.length > 0) return [...new Set(names)];
  }
  return [];
}

export function serviceAddressLine(job) {
  const address = job?.service_address || job?.location || {};
  const formatted = compact(address.formatted || address.address);
  if (formatted) return formatted;
  const cityState = [address.city, address.state].map((part) => compact(part)).filter(Boolean).join(', ');
  const cityStateZip = [cityState, compact(address.postal_code)].filter(Boolean).join(' ');
  const parts = [address.line1, address.line2 || address.unit, cityStateZip]
    .map((part) => compact(part))
    .filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `${lat},${lng}`;
  return '';
}

export function jobPrice(job) {
  const invoice = job?.invoice;
  if (!invoice || typeof invoice !== 'object') return null;
  const raw = invoice.total ?? invoice.total_price ?? null;
  if (raw == null || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

export function timeWindow(job) {
  const slotName = compact(job?.time_slot?.name);
  if (slotName) return slotName;
  const start = chicagoTimeLabel(job?.start_date);
  const end = chicagoTimeLabel(job?.end_date);
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || null;
}

export function normalizeJobNumber(value) {
  const text = compact(value).replace(/^#/, '');
  return text || '';
}

function customerName(job) {
  const customer = job?.customer || {};
  const combined = compact(customer.name);
  if (combined) return combined;
  return compact([customer.first_name, customer.last_name].filter(Boolean).join(' '));
}

export function summarizeJob(job) {
  const start = job?.start_date || null;
  return {
    job_id: job?.id == null ? null : String(job.id),
    job_number: normalizeJobNumber(job?.job_number) || null,
    date: start ? chicagoDateString(start) : null,
    time_window: timeWindow(job),
    start,
    status: job?.status == null ? null : String(job.status),
    services: serviceNames(job),
    customer_name: customerName(job) || null,
    customer_phone: compact(job?.customer?.phone || job?.customer?.phone_number || job?.customer_phone) || null,
    service_address: serviceAddressLine(job) || null,
    installers: installerNames(job),
    notes: jobNotes(job) || null,
    price: jobPrice(job),
  };
}

export function jobDetail(job) {
  const summary = summarizeJob(job);
  const territory = job?.territory;
  const invoice = job?.invoice && typeof job.invoice === 'object' ? job.invoice : null;
  return {
    ...summary,
    end: job?.end_date || null,
    timezone: job?.timezone || ZENBOOKER_TIMEZONE,
    territory: territory && typeof territory === 'object'
      ? (compact(territory.name) || null)
      : (compact(territory) || null),
    canceled: isCancelledJob(job),
    created_by: job?.created_by == null ? null : String(job.created_by),
    invoice: invoice ? {
      status: invoice.status == null ? null : String(invoice.status),
      total: jobPrice(job),
      amount_due: invoice.amount_due == null ? null : invoice.amount_due,
      amount_paid: invoice.amount_paid == null ? null : invoice.amount_paid,
    } : null,
  };
}

function startMillis(job) {
  const time = Date.parse(job?.start_date || '');
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

export function sortJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const delta = startMillis(left) - startMillis(right);
    if (delta !== 0) return delta;
    return normalizeJobNumber(left?.job_number).localeCompare(normalizeJobNumber(right?.job_number));
  });
}

function onChicagoDate(job, date) {
  if (!job?.start_date) return false;
  return chicagoDateString(job.start_date) === date;
}

export function selectDayJobs(jobs, date, { includeCancelled: cancelled = false } = {}) {
  return sortJobs(jobs).filter((job) => {
    if (!onChicagoDate(job, date)) return false;
    if (!cancelled && isCancelledJob(job)) return false;
    return true;
  });
}

export function googleMapsDirectionsUrl(addresses) {
  const stops = addresses.map((address) => compact(address)).filter(Boolean);
  if (stops.length === 0) return null;
  return `https://www.google.com/maps/dir/${stops.map((address) => encodeURIComponent(address)).join('/')}`;
}

export function appleMapsFirstStopUrl(address) {
  const stop = compact(address);
  if (!stop) return null;
  return `https://maps.apple.com/?daddr=${encodeURIComponent(stop)}`;
}

function unwrapJob(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.results)) return body.results[0] || null;
  if (body.job && typeof body.job === 'object') return body.job;
  if (body.data && typeof body.data === 'object' && (body.data.id || body.data.job_number)) return body.data;
  if (body.id || body.job_number) return body;
  return null;
}

export function createZenbookerReadClient({
  apiKey,
  baseUrl = DEFAULT_ZENBOOKER_BASE_URL,
  fetchImpl = fetch,
  maxPages = 20,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  const root = String(baseUrl || DEFAULT_ZENBOOKER_BASE_URL).replace(/\/$/, '');

  async function getJson(pathAndQuery) {
    const url = `${root}${pathAndQuery}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });
    } catch {
      throw codedError('zenbooker_upstream', 'ZenBooker request failed');
    }
    if (response?.status === 404) return null;
    let text = '';
    try {
      text = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      throw codedError('zenbooker_upstream', 'ZenBooker request failed');
    }
    if (!response?.ok) throw codedError('zenbooker_upstream', 'ZenBooker request failed');
    const body = parseZenbookerBody(text);
    if (!body) throw codedError('zenbooker_upstream', 'ZenBooker request failed');
    return body;
  }

  return {
    async listJobs({ startDateMin, startDateMax, pageCap = maxPages } = {}) {
      const jobs = [];
      let cursor = null;
      const cap = Math.max(1, Number(pageCap) || maxPages);
      for (let page = 0; page < cap; page += 1) {
        const params = new URLSearchParams({
          limit: '100',
          sort_by: 'start_time',
          sort_order: 'ascending',
        });
        if (startDateMin) {
          params.set('start_date_min', startDateMin);
          params.set('start', String(startDateMin).slice(0, 10));
        }
        if (startDateMax) {
          params.set('start_date_max', startDateMax);
          params.set('end', String(startDateMax).slice(0, 10));
        }
        if (cursor != null && cursor !== '') params.set('cursor', String(cursor));
        const data = await getJson(`/jobs?${params}`);
        const results = Array.isArray(data?.results) ? data.results : [];
        jobs.push(...results);
        if (!data?.has_more || data.next_cursor == null || data.next_cursor === '') break;
        if (String(data.next_cursor) === String(cursor)) break;
        cursor = data.next_cursor;
      }
      return jobs;
    },
    async getJob(id) {
      const jobId = String(id || '').trim();
      if (!jobId) return null;
      const body = await getJson(`/jobs/${encodeURIComponent(jobId)}`);
      return unwrapJob(body);
    },
  };
}

function requireClient(client) {
  if (!client) throw codedError('zenbooker_unconfigured', 'ZenBooker is not configured');
  return client;
}

export async function getJobsForDay(args = {}, { client, now = new Date() } = {}) {
  const date = resolveChicagoDate(args.date, now);
  const bounds = chicagoDayBounds(date);
  const jobs = await requireClient(client).listJobs({
    startDateMin: bounds.beginTime,
    startDateMax: bounds.endTime,
  });
  const selected = selectDayJobs(jobs, date, { includeCancelled: includeCancelled(args.include_cancelled) });
  return {
    business: 'The Mounting Man',
    source: 'zenbooker',
    timezone: ZENBOOKER_TIMEZONE,
    date,
    jobs: selected.map(summarizeJob),
  };
}

export async function getUpcomingJobs(args = {}, { client, now = new Date() } = {}) {
  const days = parseUpcomingDays(args.days);
  const startDate = resolveChicagoDate(null, now);
  const endDate = addDays(startDate, days);
  const startBounds = chicagoDayBounds(startDate);
  const endBounds = endDate ? chicagoDayBounds(endDate) : null;
  const jobs = await requireClient(client).listJobs({
    startDateMin: startBounds.beginTime,
    startDateMax: endBounds?.beginTime || startBounds.endTime,
    pageCap: 40,
  });
  const cancelled = includeCancelled(args.include_cancelled);
  const grouped = [];
  let cursor = startDate;
  for (let i = 0; i < days; i += 1) {
    const dayJobs = selectDayJobs(jobs, cursor, { includeCancelled: cancelled }).map(summarizeJob);
    grouped.push({ date: cursor, jobs: dayJobs });
    cursor = addCalendarDay(cursor);
  }
  return {
    business: 'The Mounting Man',
    source: 'zenbooker',
    timezone: ZENBOOKER_TIMEZONE,
    days_requested: days,
    days: grouped,
  };
}

function addCalendarDayBack(dateStr, days) {
  const match = DATE_RE.exec(dateStr);
  if (!match) return dateStr;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - days);
  const previous = new Date(utc);
  const yyyy = previous.getUTCFullYear();
  const mm = String(previous.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(previous.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function jobMatchesNumber(job, jobNumber) {
  return normalizeJobNumber(job?.job_number) === jobNumber;
}

function foundJob(job) {
  return {
    business: 'The Mounting Man',
    source: 'zenbooker',
    found: true,
    job: jobDetail(job),
  };
}

export async function getJob(args = {}, { client, now = new Date() } = {}) {
  const reader = requireClient(client);
  const jobId = compact(args.job_id || args.id);
  const explicitNumber = normalizeJobNumber(args.job_number);
  const jobNumber = explicitNumber || (jobId && !BUBBLE_ID_RE.test(jobId) ? normalizeJobNumber(jobId) : '');
  if (!jobId && !jobNumber) {
    throw codedError('invalid_job', 'job_id or job_number is required');
  }

  if (jobId) {
    const direct = await reader.getJob(jobId);
    const directMatches = direct && (
      BUBBLE_ID_RE.test(jobId) || !jobNumber || jobMatchesNumber(direct, jobNumber)
    );
    if (directMatches) return foundJob(direct);
  }

  if (!jobNumber) {
    return {
      business: 'The Mounting Man',
      source: 'zenbooker',
      found: false,
      job_id: jobId || null,
      job_number: null,
    };
  }

  const today = resolveChicagoDate(null, now);
  const min = chicagoDayBounds(addCalendarDayBack(today, JOB_LOOKUP_PAST_DAYS));
  const max = chicagoDayBounds(addDays(today, JOB_LOOKUP_FUTURE_DAYS));
  const jobs = await reader.listJobs({
    startDateMin: min?.beginTime,
    startDateMax: max?.beginTime,
    pageCap: 40,
  });
  const match = jobs.find((job) => jobMatchesNumber(job, jobNumber));
  if (!match) {
    return {
      business: 'The Mounting Man',
      source: 'zenbooker',
      found: false,
      job_id: jobId || null,
      job_number: jobNumber,
    };
  }
  const full = match.id ? await reader.getJob(match.id) : null;
  return foundJob(full || match);
}

export async function getRouteForDay(args = {}, deps = {}) {
  const day = await getJobsForDay({ date: args.date, include_cancelled: false }, deps);
  const stops = day.jobs;
  const addresses = stops.map((job) => job.service_address).filter(Boolean);
  return {
    business: 'The Mounting Man',
    source: 'zenbooker',
    timezone: ZENBOOKER_TIMEZONE,
    date: day.date,
    stops,
    stops_missing_address: stops.filter((job) => !job.service_address).map((job) => job.job_number),
    google_maps_url: googleMapsDirectionsUrl(addresses),
    apple_maps_url: appleMapsFirstStopUrl(addresses[0]),
  };
}

export async function runZenbookerTool(name, args, deps) {
  if (name === GET_JOBS_FOR_DAY) return getJobsForDay(args, deps);
  if (name === GET_UPCOMING_JOBS) return getUpcomingJobs(args, deps);
  if (name === GET_JOB) return getJob(args, deps);
  if (name === GET_ROUTE_FOR_DAY) return getRouteForDay(args, deps);
  throw codedError('unknown_tool', `Unknown tool: ${name || ''}`);
}

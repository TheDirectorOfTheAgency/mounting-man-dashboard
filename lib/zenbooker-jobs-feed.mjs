// Read-only ZenBooker job feed for The Mounting Man.
// GET /jobs and GET /jobs/{id} only. No creates, updates, or cancels.

import {
  addCalendarDay,
  chicagoDateString,
  chicagoDayBounds,
} from './square-reporting-feed.mjs';

export const ZENBOOKER_TIMEZONE = 'America/Chicago';
export const ZENBOOKER_API_BASE = 'https://api.zenbooker.com/v1';
export const MCP_ZENBOOKER_CLIENT_ID = 'mounting-man-zenbooker';

export const GET_JOBS_FOR_DAY = 'get_jobs_for_day';
export const GET_UPCOMING_JOBS = 'get_upcoming_jobs';
export const GET_JOB = 'get_job';
export const GET_ROUTE_FOR_DAY = 'get_route_for_day';
export const GET_NEXT_JOB = 'get_next_job';
export const GET_DAY_SUMMARY = 'get_day_summary';
export const GET_MORNING_BRIEF = 'get_morning_brief';
export const GET_TOMORROW = 'get_tomorrow';
export const ZENBOOKER_BOOKED_LABEL = 'ZenBooker booked amounts, not Square collected payments';

const ROUGH_DRIVE_MPH = 35;
const NEXT_JOB_HORIZON_DAYS = 14;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'MountingManZenbooker/1.0 (mntvmounting@gmail.com)';
const COMPLETE_STATUSES = new Set(['complete', 'completed', 'done', 'finished']);
const PROGRESS_STATUSES = new Set(['started', 'in-progress', 'en-route', 'enroute']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZENBOOKER_ID_RE = /^\d{8,}x\d+$/;
const SOURCE = {
  business: 'The Mounting Man',
  source: 'ZenBooker',
  kind: 'tv_mounting_jobs',
  timezone: ZENBOOKER_TIMEZONE,
};

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeBareEmpties(text) {
  return text
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (match) => match.replace(',', 'null,'))
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*\}/g, (match) => match.replace('}', 'null}'));
}

function parseBody(data) {
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

export function shiftCalendarDate(dateStr, days) {
  const match = DATE_RE.exec(String(dateStr || '').trim());
  if (!match) return null;
  const utc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Number(days),
  ));
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function isValidCalendarDate(dateStr) {
  const match = DATE_RE.exec(String(dateStr || '').trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
}

function resolveDate(value, now) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    const today = chicagoDateString(now);
    if (!today) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
    return today;
  }
  if (!isValidCalendarDate(raw)) {
    throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  }
  return raw;
}

function parseDays(value) {
  if (value == null || value === '') return 7;
  const days = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw codedError('invalid_days', 'days must be an integer from 1 to 31');
  }
  return days;
}

function flag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string' && /^(true|1|yes)$/i.test(value.trim())) return true;
  return false;
}

function requireClient(client) {
  if (!client || typeof client.listJobs !== 'function' || typeof client.getJob !== 'function') {
    throw codedError('zenbooker_unconfigured', 'ZenBooker is not configured');
  }
  return client;
}

export function isCancelledJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.canceled === true || job.cancelled === true) return true;
  const status = String(job.status || '').toLowerCase();
  return status === 'canceled' || status === 'cancelled';
}

function startMs(job) {
  const time = Date.parse(job?.start_date || '');
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function byStart(left, right) {
  return startMs(left) - startMs(right);
}

function formatChicagoTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZENBOOKER_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function timeWindow(job) {
  const start = job.start_date || null;
  const end = job.end_date || null;
  const slot = job.time_slot && typeof job.time_slot === 'object' ? job.time_slot : null;
  let label = slot?.name ? String(slot.name).trim() : '';
  if (!label && start) {
    const startLabel = formatChicagoTime(start);
    const endLabel = end ? formatChicagoTime(end) : null;
    label = startLabel && endLabel ? `${startLabel} – ${endLabel}` : startLabel;
  }
  return {
    start,
    end,
    label: label || null,
    timezone: ZENBOOKER_TIMEZONE,
  };
}

function pushText(lines, value) {
  if (typeof value === 'string' && value.trim()) {
    lines.push(value.trim());
    return;
  }
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) lines.push(entry.trim());
    else if (entry?.text && String(entry.text).trim()) lines.push(String(entry.text).trim());
  }
}

function instructionFields(job) {
  const nested = Array.isArray(job.services)
    ? job.services.flatMap((service) => [
      ...(Array.isArray(service?.service_fields) ? service.service_fields : []),
      ...(Array.isArray(service?.service_selections) ? service.service_selections : []),
    ])
    : [];
  return [
    ...(Array.isArray(job.service_fields) ? job.service_fields : []),
    ...(Array.isArray(job.job_fields) ? job.job_fields : []),
    ...nested,
  ];
}

function collectNotes(job) {
  const lines = [];
  pushText(lines, job.job_notes);
  pushText(lines, job.notes);
  for (const field of instructionFields(job)) {
    const label = String(field?.field_name || field?.name || '').trim();
    if (!/note|instruction|request|special|access|gate|parking|comment/i.test(label)) continue;
    if (field.text_value && String(field.text_value).trim()) {
      lines.push(`${label}: ${String(field.text_value).trim()}`);
    }
    const options = Array.isArray(field.selected_options) ? field.selected_options : [];
    for (const option of options) {
      const text = option?.comments || option?.text;
      if (text && String(text).trim()) lines.push(`${label}: ${String(text).trim()}`);
    }
  }
  pushText(lines, job.customer?.notes);
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
  }
  return unique.length ? unique.join('\n') : null;
}

function optionLabels(fields) {
  const labels = [];
  for (const field of fields) {
    if (field?.field_type === 'intake') continue;
    const options = Array.isArray(field?.selected_options) ? field.selected_options : [];
    for (const option of options) {
      const text = option?.display_label || option?.text;
      if (text && String(text).trim()) labels.push(String(text).trim());
    }
  }
  return [...new Set(labels)];
}

function serviceNames(job) {
  const names = [];
  if (job.service_name && String(job.service_name).trim()) names.push(String(job.service_name).trim());
  if (Array.isArray(job.services)) {
    for (const service of job.services) {
      const name = service?.service_name || service?.name;
      if (name && String(name).trim()) names.push(String(name).trim());
    }
  }
  return [...new Set(names)];
}

function detailsForService(service, fallbackName) {
  const fields = [
    ...(Array.isArray(service?.service_fields) ? service.service_fields : []),
    ...(Array.isArray(service?.service_selections) ? service.service_selections : []),
  ];
  const pricing = Array.isArray(service?.pricing_summary) ? service.pricing_summary : [];
  const options = optionLabels(fields);
  for (const line of pricing) {
    const text = line?.description || line?.name;
    if (text && String(text).trim()) options.push(String(text).trim());
  }
  return {
    name: service?.service_name || service?.name || fallbackName || null,
    options: [...new Set(options)],
  };
}

function buildServiceDetails(job) {
  if (Array.isArray(job.services) && job.services.length) {
    return job.services
      .map((service) => detailsForService(service, job.service_name))
      .filter((service) => service.name || service.options.length);
  }
  const fields = [
    ...(Array.isArray(job.service_fields) ? job.service_fields : []),
    ...(Array.isArray(job.job_fields) ? job.job_fields : []),
  ];
  if (!job.service_name && fields.length === 0) return [];
  return [{
    name: job.service_name || null,
    options: optionLabels(fields),
  }];
}

function customerName(job) {
  const customer = job.customer && typeof job.customer === 'object' ? job.customer : {};
  if (customer.name && String(customer.name).trim()) return String(customer.name).trim();
  const joined = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  if (joined) return joined;
  if (job.customer_name && String(job.customer_name).trim()) return String(job.customer_name).trim();
  return null;
}

function customerPhone(job) {
  const customer = job.customer && typeof job.customer === 'object' ? job.customer : {};
  const phone = customer.phone || customer.phone_number || job.customer_phone || null;
  if (phone == null || String(phone).trim() === '') return null;
  return String(phone).trim();
}

export function serviceAddressLine(job) {
  const addr = job?.service_address || job?.location;
  if (!addr || typeof addr !== 'object') return null;
  const formatted = String(addr.formatted || '').trim();
  const line2 = String(addr.line2 || addr.unit || '').trim();
  if (formatted) {
    if (line2 && !formatted.toLowerCase().includes(line2.toLowerCase())) {
      const comma = formatted.indexOf(',');
      if (comma > 0) return `${formatted.slice(0, comma)}, ${line2}${formatted.slice(comma)}`;
      return `${formatted}, ${line2}`;
    }
    return formatted;
  }
  const street = String(addr.address || addr.line1 || '').trim();
  const cityState = [addr.city, addr.state].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  const postal = String(addr.postal_code || addr.zip || '').trim();
  const locality = [cityState, postal].filter(Boolean).join(' ');
  const parts = [street, line2, locality].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function installerNames(job) {
  const lists = [job.assigned_providers, job.service_providers, job.providers];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const names = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.name || entry.full_name || entry.display_name;
      if (name && String(name).trim()) names.push(String(name).trim());
    }
    if (names.length) return [...new Set(names)];
  }
  return [];
}

function priceOf(job) {
  const invoice = job.invoice && typeof job.invoice === 'object' ? job.invoice : {};
  const raw = invoice.total ?? invoice.total_price ?? null;
  if (raw == null || raw === '') return null;
  const amount = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  return { amount: Math.round(amount * 100) / 100, currency: 'USD' };
}

export function toPublicJob(job) {
  const start = job.start_date || null;
  return {
    job_id: job.id == null ? null : String(job.id),
    job_number: job.job_number == null ? null : String(job.job_number).replace(/^#/, ''),
    date: start ? chicagoDateString(start) : null,
    time_window: timeWindow(job),
    status: job.status || (isCancelledJob(job) ? 'canceled' : null),
    canceled: isCancelledJob(job),
    services: serviceNames(job),
    customer_name: customerName(job),
    customer_phone: customerPhone(job),
    service_address: serviceAddressLine(job),
    installers: installerNames(job),
    notes: collectNotes(job),
    price: priceOf(job),
  };
}

export function toPublicJobDetail(job) {
  const territory = job.territory && typeof job.territory === 'object' ? job.territory.name : null;
  return {
    ...toPublicJob(job),
    service_details: buildServiceDetails(job),
    territory: territory ? String(territory) : null,
  };
}

export function googleMapsDirectionsUrl(addresses) {
  const stops = (Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address || '').trim())
    .filter(Boolean);
  if (!stops.length) return null;
  return `https://www.google.com/maps/dir/${stops.map((address) => encodeURIComponent(address)).join('/')}`;
}

export function appleMapsDirectionsUrl(address) {
  const stop = String(address || '').trim();
  if (!stop) return null;
  return `https://maps.apple.com/?daddr=${encodeURIComponent(stop)}&dirflg=d`;
}

function visibleJobs(jobs, { date, startDate, endDate, includeCancelled }) {
  return jobs
    .filter((job) => job && typeof job === 'object' && job.start_date)
    .filter((job) => {
      const jobDate = chicagoDateString(job.start_date);
      if (!jobDate) return false;
      if (date) return jobDate === date;
      return jobDate >= startDate && jobDate <= endDate;
    })
    .filter((job) => includeCancelled || !isCancelledJob(job))
    .sort(byStart);
}

export async function getJobsForDay(args = {}, { client, now = new Date() } = {}) {
  const date = resolveDate(args.date, now);
  const includeCancelled = flag(args.include_cancelled ?? args.includeCancelled);
  const bounds = chicagoDayBounds(date);
  if (!bounds) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  const jobs = await requireClient(client).listJobs({
    startDateMin: bounds.beginTime,
    startDateMax: bounds.endTime,
    includeCancelled,
    maxPages: 5,
  });
  return {
    ...SOURCE,
    tool: GET_JOBS_FOR_DAY,
    date,
    include_cancelled: includeCancelled,
    jobs: visibleJobs(jobs, { date, includeCancelled }).map(toPublicJob),
  };
}

export async function getUpcomingJobs(args = {}, { client, now = new Date() } = {}) {
  const days = parseDays(args.days);
  const includeCancelled = flag(args.include_cancelled ?? args.includeCancelled);
  const startDate = chicagoDateString(now);
  if (!startDate) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  let endDate = startDate;
  for (let i = 1; i < days; i += 1) endDate = addCalendarDay(endDate);
  const begin = chicagoDayBounds(startDate);
  const end = chicagoDayBounds(endDate);
  const jobs = await requireClient(client).listJobs({
    startDateMin: begin.beginTime,
    startDateMax: end.endTime,
    includeCancelled,
    maxPages: 10,
  });
  const grouped = new Map();
  for (const job of visibleJobs(jobs, { startDate, endDate, includeCancelled })) {
    const date = chicagoDateString(job.start_date);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(toPublicJob(job));
  }
  return {
    ...SOURCE,
    tool: GET_UPCOMING_JOBS,
    start_date: startDate,
    end_date: endDate,
    days,
    include_cancelled: includeCancelled,
    by_day: [...grouped.entries()].map(([date, dayJobs]) => ({ date, jobs: dayJobs })),
  };
}

function normalizeJobNumber(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function foundJob(job) {
  return {
    ...SOURCE,
    tool: GET_JOB,
    found: true,
    job: toPublicJobDetail(job),
  };
}

function missingJob(query) {
  return {
    ...SOURCE,
    tool: GET_JOB,
    found: false,
    query,
    job: null,
  };
}

function pickJob(matches, today) {
  const active = matches.filter((job) => !isCancelledJob(job));
  const pool = active.length ? active : matches;
  const upcoming = pool
    .filter((job) => {
      const date = chicagoDateString(job.start_date);
      return date && date >= today;
    })
    .sort(byStart);
  if (upcoming.length) return upcoming[0];
  return [...pool].sort(byStart).at(-1) || pool[0];
}

export async function getJob(args = {}, { client, now = new Date() } = {}) {
  const jobId = String(args.job_id || args.jobId || '').trim();
  let jobNumber = String(args.job_number || args.jobNumber || '').trim();
  if (!jobId && !jobNumber) {
    throw codedError('invalid_job', 'job_id or job_number is required');
  }
  const read = requireClient(client);
  if (jobId && ZENBOOKER_ID_RE.test(jobId)) {
    const job = await read.getJob(jobId);
    if (!job || typeof job !== 'object') return missingJob({ job_id: jobId });
    return foundJob(job);
  }
  if (!jobNumber) jobNumber = jobId;
  const wanted = normalizeJobNumber(jobNumber);
  if (!wanted) throw codedError('invalid_job', 'job_id or job_number is required');
  const today = chicagoDateString(now);
  const windows = [
    { start: shiftCalendarDate(today, -21), end: shiftCalendarDate(today, 21), maxPages: 4 },
    { start: shiftCalendarDate(today, -400), end: shiftCalendarDate(today, 120), maxPages: 12 },
  ];
  for (const window of windows) {
    const boundsStart = chicagoDayBounds(window.start);
    const boundsEnd = chicagoDayBounds(window.end);
    const jobs = await read.listJobs({
      startDateMin: boundsStart.beginTime,
      startDateMax: boundsEnd.endTime,
      includeCancelled: true,
      maxPages: window.maxPages,
    });
    const matches = jobs.filter((job) => normalizeJobNumber(job?.job_number) === wanted);
    if (matches.length) return foundJob(pickJob(matches, today));
  }
  return missingJob({ job_number: wanted });
}

export async function getRouteForDay(args = {}, deps = {}) {
  const day = await getJobsForDay({ date: args.date }, deps);
  const addresses = day.jobs.map((job) => job.service_address).filter(Boolean);
  return {
    ...SOURCE,
    tool: GET_ROUTE_FOR_DAY,
    date: day.date,
    jobs: day.jobs,
    google_maps_url: googleMapsDirectionsUrl(addresses),
    apple_maps_url: appleMapsDirectionsUrl(addresses[0] || null),
  };
}

function unwrapJob(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.id || body.job_number) return body;
  if (body.job && typeof body.job === 'object') return body.job;
  if (body.data && typeof body.data === 'object' && (body.data.id || body.data.job_number)) return body.data;
  return null;
}

export function createZenbookerReadClient({
  apiKey,
  baseUrl = ZENBOOKER_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const root = String(baseUrl || ZENBOOKER_API_BASE).replace(/\/$/, '');
  const key = String(apiKey || '').trim();

  async function getJson(url) {
    if (!key) throw codedError('zenbooker_unconfigured', 'ZenBooker is not configured');
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
    }
    let text = '';
    try {
      text = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
    }
    if (response?.status === 404) return null;
    if (!response?.ok) throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
    const body = parseBody(text);
    if (!body || typeof body !== 'object') throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
    return body;
  }

  return {
    async listJobs({
      startDateMin,
      startDateMax,
      includeCancelled = false,
      maxPages = 10,
    } = {}) {
      const jobs = [];
      let cursor = null;
      const seenCursors = new Set();
      const pages = Math.max(1, Number(maxPages) || 1);
      for (let page = 0; page < pages; page += 1) {
        const params = new URLSearchParams({
          limit: '100',
          sort_by: 'start_time',
          sort_order: 'ascending',
        });
        if (startDateMin) params.set('start_date_min', startDateMin);
        if (startDateMax) params.set('start_date_max', startDateMax);
        if (!includeCancelled) params.set('canceled', 'false');
        if (cursor != null && cursor !== '') params.set('cursor', String(cursor));
        const body = await getJson(`${root}/jobs?${params}`);
        if (!body) throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
        const results = Array.isArray(body.results) ? body.results : null;
        if (!results) throw codedError('zenbooker_unavailable', 'ZenBooker request failed');
        jobs.push(...results);
        if (!body.has_more || body.next_cursor == null || body.next_cursor === '') break;
        const next = String(body.next_cursor);
        if (seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
      return jobs;
    },
    async getJob(jobId) {
      if (!jobId) return null;
      const body = await getJson(`${root}/jobs/${encodeURIComponent(String(jobId))}`);
      return unwrapJob(body);
    },
  };
}

export function createZenbookerReadClientFromEnv(env = process.env) {
  const apiKey = String(env?.ZENBOOKER_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = env.ZENBOOKER_BASE_URL || ZENBOOKER_API_BASE;
  return createZenbookerReadClient({ apiKey, baseUrl });
}

function addDays(dateStr, days) {
  return shiftCalendarDate(dateStr, days);
}

function statusCompact(job) {
  return String(job?.status || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function isCompletedJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.completed === true) return true;
  if (job.date_time_completed || job.completed_at) return true;
  return COMPLETE_STATUSES.has(statusCompact(job));
}

function windowEndMs(job) {
  const start = Date.parse(job?.start_date || '');
  const end = Date.parse(job?.end_date || '');
  if (Number.isNaN(end)) return null;
  if (!Number.isNaN(start) && end <= start) return null;
  return end;
}

export function isInProgressJob(job, now = new Date()) {
  if (!job || isCancelledJob(job) || isCompletedJob(job)) return false;
  if (PROGRESS_STATUSES.has(statusCompact(job))) return true;
  const start = Date.parse(job.start_date || '');
  const end = windowEndMs(job);
  const instant = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(start) || Number.isNaN(instant) || end == null) return false;
  return instant >= start && instant < end;
}

function normalizeUsE164(phone) {
  if (phone == null) return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (!hasPlus && digits.length === 10) digits = `1${digits}`;
  const e164 = `+${digits}`;
  if (!/^\+1\d{10}$/.test(e164)) return null;
  return e164;
}

function phoneLinks(raw) {
  const e164 = normalizeUsE164(raw);
  return {
    phone_e164: e164,
    tel_link: e164 ? `tel:${e164}` : null,
    sms_link: e164 ? `sms:${e164}` : null,
  };
}

function installerLabel(names) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list.at(-1)}`;
}

export function cityFromAddressLine(line) {
  const parts = String(line || '').split(',').map((part) => part.trim()).filter(Boolean);
  const stateIndex = parts.findIndex((part, index) => (
    index > 0 && /^[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(part)
  ));
  if (stateIndex > 0) return parts[stateIndex - 1];
  return null;
}

function jobCity(job) {
  const addr = job?.service_address || job?.location;
  if (addr && typeof addr === 'object') {
    const city = String(addr.city || '').trim();
    if (city) return city;
  }
  return cityFromAddressLine(serviceAddressLine(job));
}

function readCoord(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return null;
  return number;
}

function coordsFromJob(job) {
  const addr = job?.service_address || job?.location || {};
  const pairs = [
    [addr.lat, addr.lng],
    [addr.latitude, addr.longitude],
    [job?.lat, job?.lng],
    [job?.latitude, job?.longitude],
  ];
  for (const [latRaw, lngRaw] of pairs) {
    const lat = readCoord(latRaw);
    const lng = readCoord(lngRaw);
    if (lat == null || lng == null) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (lat === 0 && lng === 0) continue;
    return { lat, lng };
  }
  return null;
}

function haversineMiles(from, to) {
  const earth = 3958.8;
  const phi1 = (from.lat * Math.PI) / 180;
  const phi2 = (to.lat * Math.PI) / 180;
  const dphi = ((to.lat - from.lat) * Math.PI) / 180;
  const dlambda = ((to.lng - from.lng) * Math.PI) / 180;
  const a = Math.sin(dphi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return earth * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function straightLineDriveMinutes(from, to, mph = ROUGH_DRIVE_MPH) {
  if (!from || !to || !mph) return null;
  const miles = haversineMiles(from, to);
  if (!Number.isFinite(miles)) return null;
  return Math.max(1, Math.round((miles / mph) * 60));
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createNominatimGeocoder({
  fetchImpl = globalThis.fetch,
  minIntervalMs = 1100,
  sleep = defaultSleep,
  timeoutMs = 5000,
} = {}) {
  const cache = new Map();
  let nextAt = 0;
  return async function geocode(address) {
    const key = String(address || '').trim().toLowerCase();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    const nowMs = Date.now();
    const wait = Math.max(0, nextAt - nowMs);
    nextAt = nowMs + wait + minIntervalMs;
    if (wait > 0) await sleep(wait);
    let coords = null;
    try {
      const params = new URLSearchParams({ format: 'jsonv2', limit: '1', q: String(address).trim() });
      const response = await fetchImpl(`${NOMINATIM_URL}?${params}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': NOMINATIM_UA,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response?.ok) {
        const body = typeof response.json === 'function' ? await response.json() : null;
        const hit = Array.isArray(body) ? body[0] : null;
        const lat = readCoord(hit?.lat);
        const lng = readCoord(hit?.lon ?? hit?.lng);
        if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
          coords = { lat, lng };
        }
      }
    } catch {
      coords = null;
    }
    cache.set(key, coords);
    return coords;
  };
}

async function listRange(startDate, endDate, { client, includeCancelled = false, maxPages = 5 } = {}) {
  const begin = chicagoDayBounds(startDate);
  const end = chicagoDayBounds(endDate);
  if (!begin || !end) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  const jobs = await requireClient(client).listJobs({
    startDateMin: begin.beginTime,
    startDateMax: end.endTime,
    includeCancelled,
    maxPages,
  });
  return visibleJobs(jobs, { startDate, endDate, includeCancelled });
}

function toNextStop(job, now) {
  const pub = toPublicJob(job);
  return {
    ...pub,
    ...phoneLinks(pub.customer_phone),
    in_progress: isInProgressJob(job, now),
    installer: installerLabel(pub.installers),
    google_maps_url: googleMapsDirectionsUrl(pub.service_address ? [pub.service_address] : []),
    apple_maps_url: appleMapsDirectionsUrl(pub.service_address),
  };
}

function plainSpeech(text) {
  return String(text || '')
    .replace(/[\n\r]+/g, '. ')
    .replace(/[#*`|_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function speakTime(label) {
  const text = plainSpeech(label || '').replace(/\s+(?:-|–|—)\s+/g, ' to ');
  return text || 'an unset time';
}

function speakStart(label) {
  return speakTime(label).split(' to ')[0];
}

function durationPhrase(minutes) {
  const n = Math.max(0, Math.round(Number(minutes)));
  if (!Number.isFinite(n) || n <= 1) return 'about 1 minute';
  if (n < 60) return `about ${n} minutes`;
  const hours = Math.floor(n / 60);
  const mins = n % 60;
  const hourText = hours === 1 ? '1 hour' : `${hours} hours`;
  if (!mins) return `about ${hourText}`;
  const minText = mins === 1 ? '1 minute' : `${mins} minutes`;
  return `about ${hourText} and ${minText}`;
}

function speakDay(date, now) {
  const today = chicagoDateString(now);
  if (date === today) return 'today';
  const tomorrow = today ? addCalendarDay(today) : null;
  if (date === tomorrow) return 'tomorrow';
  const match = DATE_RE.exec(String(date || ''));
  if (!match) return String(date || 'that day');
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 18));
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: ZENBOOKER_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instant);
  return `on ${label}`;
}

function speakMoney(amount) {
  const dollars = Math.trunc(amount);
  const cents = Math.abs(Math.round((amount - dollars) * 100));
  if (cents === 0) return `${dollars} dollars`;
  return `${dollars} dollars and ${cents} cents`;
}

function speakNext(result) {
  if (!result.found || !result.job) return 'You have no upcoming jobs.';
  const job = result.job;
  const who = job.customer_name || 'The customer';
  const city = cityFromAddressLine(job.service_address);
  const place = city ? ` in ${city}` : '';
  const service = job.services?.length ? job.services.join(' and ') : 'the booked service';
  const opener = job.in_progress
    ? `You are with ${who}${place} now.`
    : `Your next customer is ${who}${place}.`;
  const phone = job.phone_e164
    ? ` The phone number is ${job.phone_e164}.`
    : ' ZenBooker has no callable phone number on this job.';
  let text = `${opener} The window is ${speakTime(job.time_window?.label)}. ${service}.${phone}`;
  const notes = plainSpeech(job.notes || '');
  if (notes) text += ` Notes say ${notes.endsWith('.') ? notes : `${notes}.`}`;
  if (job.installer) text += ` Installer is ${job.installer}.`;
  if (result.following_job) {
    const next = result.following_job;
    const nextCity = cityFromAddressLine(next.service_address);
    const nextPlace = nextCity ? ` in ${nextCity}` : '';
    text += ` After this is ${next.customer_name || 'another customer'}${nextPlace} at ${speakTime(next.time_window?.label)}.`;
  }
  return plainSpeech(text);
}

export async function getNextJob(args = {}, deps = {}) {
  void args;
  const now = deps.now || new Date();
  const today = chicagoDateString(now);
  if (!today) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  const endDate = addDays(today, NEXT_JOB_HORIZON_DAYS - 1);
  const jobs = await listRange(today, endDate, {
    client: deps.client,
    includeCancelled: false,
    maxPages: 8,
  });
  const open = jobs.filter((job) => !isCompletedJob(job));
  const current = open.find((job) => isInProgressJob(job, now)) || null;
  const upcoming = current
    ? null
    : open.find((job) => startMs(job) >= now.getTime()) || null;
  const primary = current || upcoming;
  if (!primary) {
    const empty = {
      ...SOURCE,
      tool: GET_NEXT_JOB,
      as_of: now.toISOString(),
      found: false,
      in_progress: false,
      job: null,
      following_job: null,
      spoken: 'You have no upcoming jobs.',
    };
    return empty;
  }
  const index = open.indexOf(primary);
  const following = current ? open[index + 1] || null : null;
  const result = {
    ...SOURCE,
    tool: GET_NEXT_JOB,
    as_of: now.toISOString(),
    found: true,
    in_progress: Boolean(current),
    job: toNextStop(primary, now),
    following_job: following ? toNextStop(following, now) : null,
  };
  result.spoken = speakNext(result);
  return result;
}

function summaryRow(job) {
  const pub = toPublicJob(job);
  const completed = isCompletedJob(job);
  const price = pub.price;
  return {
    job_id: pub.job_id,
    job_number: pub.job_number,
    customer_name: pub.customer_name,
    time_window: pub.time_window,
    services: pub.services,
    status: pub.status,
    state: completed ? 'completed' : 'remaining',
    price,
    price_note: price ? null : 'ZenBooker gave no price for this job',
  };
}

function speakSummary(date, now, rows) {
  const when = speakDay(date, now);
  const basis = `These are ${ZENBOOKER_BOOKED_LABEL}.`;
  if (!rows.length) {
    return `You have no jobs ${when}. There is no ZenBooker booked amount to total. ${basis}`;
  }
  const completed = rows.filter((row) => row.state === 'completed').length;
  const remaining = rows.length - completed;
  const priced = rows.filter((row) => row.price);
  const missing = rows.length - priced.length;
  const jobWord = rows.length === 1 ? 'job' : 'jobs';
  let text = `You have ${rows.length} ${jobWord} ${when}. ${completed} completed and ${remaining} remaining.`;
  if (!priced.length) {
    text += ' ZenBooker gave no price for these jobs, so the booked total is not guessed.';
  } else {
    const total = priced.reduce((sum, row) => sum + Math.round(row.price.amount * 100), 0) / 100;
    text += ` ZenBooker booked ${speakMoney(total)} ${when}.`;
    if (missing) {
      const missingWord = missing === 1 ? 'job' : 'jobs';
      text += ` ZenBooker gave no price for ${missing} ${missingWord}, and that amount is not guessed.`;
    }
  }
  const lines = rows.map((row) => {
    const who = row.customer_name || 'A customer';
    const state = row.state === 'completed' ? 'complete' : (row.status || 'remaining');
    if (!row.price) return `${who} is ${state}. ZenBooker gave no price for this job.`;
    return `${who} is ${state} at ${speakMoney(row.price.amount)}.`;
  });
  text += ` ${lines.join(' ')} ${basis}`;
  return plainSpeech(text);
}

export async function getDaySummary(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const date = resolveDate(args.date, now);
  const jobs = await listRange(date, date, {
    client: deps.client,
    includeCancelled: false,
    maxPages: 5,
  });
  const rows = jobs.map(summaryRow);
  const completed = rows.filter((row) => row.state === 'completed').length;
  const priced = rows.filter((row) => row.price);
  const total = priced.length
    ? priced.reduce((sum, row) => sum + Math.round(row.price.amount * 100), 0) / 100
    : null;
  return {
    ...SOURCE,
    tool: GET_DAY_SUMMARY,
    date,
    revenue_basis: ZENBOOKER_BOOKED_LABEL,
    job_count: rows.length,
    completed_count: completed,
    remaining_count: rows.length - completed,
    booked_revenue: {
      label: ZENBOOKER_BOOKED_LABEL,
      amount: total,
      currency: total == null ? null : 'USD',
      priced_job_count: priced.length,
      unpriced_job_count: rows.length - priced.length,
    },
    jobs: rows,
    spoken: speakSummary(date, now, rows),
  };
}

async function lookupCoords(job, geocode, cache) {
  const known = coordsFromJob(job);
  if (known) return known;
  const address = serviceAddressLine(job);
  if (!address || typeof geocode !== 'function') return null;
  const key = address.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let coords = null;
  try {
    const found = await geocode(address);
    const lat = readCoord(found?.lat);
    const lng = readCoord(found?.lng ?? found?.lon);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
      coords = { lat, lng };
    }
  } catch {
    coords = null;
  }
  cache.set(key, coords);
  return coords;
}

function geocoderFor(deps) {
  if (typeof deps?.geocode === 'function') return deps.geocode;
  return createNominatimGeocoder({ fetchImpl: deps?.fetchImpl || globalThis.fetch });
}

function jobSpeech(job, index, count) {
  const pub = toPublicJob(job);
  const time = speakTime(pub.time_window?.label);
  const city = jobCity(job) || 'an unlisted city';
  const who = plainSpeech(pub.customer_name || '');
  const service = pub.services?.length ? plainSpeech(pub.services.join(' and ')) : 'the booked service';
  let lead = 'Next';
  if (index === 0) lead = 'First';
  else if (index === count - 1) lead = 'Last';
  let sentence = who
    ? `${lead}, ${time} in ${city}, ${who}, ${service}.`
    : `${lead}, ${time} in ${city}, ${service}.`;
  if (isCompletedJob(job)) sentence += ' That one is already complete.';
  const notes = plainSpeech(pub.notes || '');
  if (notes) {
    const clipped = notes.length > 400 ? `${notes.slice(0, 400).trim()} and more in the job notes` : notes;
    sentence += ` Notes say ${clipped.endsWith('.') ? clipped : `${clipped}.`}`;
  }
  return sentence;
}

export function buildMorningBriefText({ date, now, jobs, legs, endToEndMinutes, mapsUrl }) {
  const when = speakDay(date, now);
  if (!jobs.length) return `You have no jobs ${when}.`;
  const sentences = [];
  const count = jobs.length;
  sentences.push(count === 1 ? `You have 1 job ${when}.` : `You have ${count} jobs ${when}.`);
  sentences.push(`The first one starts at ${speakStart(timeWindow(jobs[0]).label)}.`);
  jobs.forEach((job, index) => {
    sentences.push(jobSpeech(job, index, count));
    if (index >= count - 1) return;
    const leg = legs[index];
    const from = leg?.from || jobCity(job) || 'that stop';
    const to = leg?.to || 'the next stop';
    if (leg && leg.minutes != null) {
      sentences.push(`${durationPhrase(leg.minutes)} from ${from} to ${to}, a rough estimate.`.replace(/^about/, 'About'));
    } else {
      sentences.push(`The drive time from ${from} to ${to} was left out because the location lookup failed.`);
    }
  });
  if (count === 1) {
    sentences.push('There is one stop, so there is no drive between stops.');
  } else if (endToEndMinutes != null) {
    sentences.push(`From the first stop to the last is ${durationPhrase(endToEndMinutes)}, a rough estimate.`);
  } else {
    sentences.push('The drive from the first stop to the last was left out because a location lookup failed.');
  }
  if (count > 1 && (endToEndMinutes != null || legs.some((leg) => leg?.minutes != null))) {
    sentences.push('These drive times are rough estimates from straight-line distance at 35 miles per hour.');
  }
  if (mapsUrl) sentences.push(`The full route is ${mapsUrl}`);
  else if (count) sentences.push('There is no map link because the jobs have no address.');
  return plainSpeech(sentences.join(' '));
}

export async function getMorningBrief(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const date = resolveDate(args.date, now);
  const jobs = await listRange(date, date, {
    client: deps.client,
    includeCancelled: false,
    maxPages: 5,
  });
  const geocode = geocoderFor(deps);
  const cache = new Map();
  const located = [];
  for (const job of jobs) {
    located.push({ job, coords: await lookupCoords(job, geocode, cache) });
  }
  const legs = [];
  for (let index = 1; index < located.length; index += 1) {
    const from = located[index - 1];
    const to = located[index];
    const minutes = from.coords && to.coords
      ? straightLineDriveMinutes(from.coords, to.coords)
      : null;
    legs.push({
      from: jobCity(from.job),
      to: jobCity(to.job),
      minutes,
    });
  }
  const first = located[0]?.coords || null;
  const last = located.length > 1 ? located[located.length - 1].coords : null;
  const endToEndMinutes = first && last ? straightLineDriveMinutes(first, last) : null;
  const mapsUrl = googleMapsDirectionsUrl(jobs.map((job) => serviceAddressLine(job)));
  const brief = buildMorningBriefText({
    date,
    now,
    jobs,
    legs,
    endToEndMinutes,
    mapsUrl,
  });
  const estimated = endToEndMinutes != null || legs.some((leg) => leg.minutes != null);
  return {
    ...SOURCE,
    tool: GET_MORNING_BRIEF,
    date,
    job_count: jobs.length,
    brief,
    google_maps_url: mapsUrl,
    drive_times: {
      basis: estimated ? 'rough_straight_line_35_mph' : 'unavailable',
      label: estimated
        ? 'Rough estimates from straight-line distance at about 35 miles per hour.'
        : 'Drive times were left out because a location lookup failed.',
      legs,
      first_to_last_minutes: endToEndMinutes,
    },
  };
}

export async function getTomorrow(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const today = chicagoDateString(now);
  if (!today) throw codedError('invalid_date', 'date must be YYYY-MM-DD in America/Chicago');
  const tomorrow = addCalendarDay(today);
  const day = await getJobsForDay({
    date: tomorrow,
    include_cancelled: args.include_cancelled ?? args.includeCancelled,
  }, deps);
  return {
    ...day,
    tool: GET_TOMORROW,
  };
}

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

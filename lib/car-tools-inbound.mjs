// Read-only inbound voice tools for The Mounting Man car MCP.
// CallRail missed calls + leads, Google Places reviews, ZenBooker online bookings.

import {
  chicagoDateString,
  chicagoDayBounds,
} from './square-reporting-feed.mjs';
import {
  isCancelledJob,
  toPublicJob,
  ZENBOOKER_TIMEZONE,
} from './zenbooker-jobs-feed.mjs';

export const GET_MISSED_CALLS = 'get_missed_calls';
export const GET_NEW_LEADS = 'get_new_leads';
export const GET_NEW_REVIEWS = 'get_new_reviews';

export const CALLRAIL_API_BASE = 'https://api.callrail.com/v3';
export const GOOGLE_PLACES_API_BASE = 'https://places.googleapis.com/v1';

export const SOURCES_NOT_CONNECTED = ['Thumbtack', 'Angi', 'Yelp'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE = {
  business: 'The Mounting Man',
  timezone: ZENBOOKER_TIMEZONE,
};

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainSpeech(text) {
  return String(text || '')
    .replace(/[\n\r]+/g, '. ')
    .replace(/[#*`|_]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeUsE164(phone) {
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
  };
}

export function maskPhone(phone) {
  const e164 = normalizeUsE164(phone);
  if (!e164) return '[phone]';
  return `***${e164.slice(-4)}`;
}

function isValidCalendarDate(dateStr) {
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

function addCalendarDays(dateStr, days) {
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

export function resolveSince(args = {}, now = new Date(), { defaultDaysBack = 0 } = {}) {
  const raw = args.since == null ? '' : String(args.since).trim();
  if (raw) {
    if (isValidCalendarDate(raw)) {
      const bounds = chicagoDayBounds(raw);
      if (!bounds) throw codedError('invalid_since', 'since must be an ISO timestamp or YYYY-MM-DD in America/Chicago');
      return {
        since_iso: bounds.beginTime,
        since_ms: Date.parse(bounds.beginTime),
        since_date: raw,
      };
    }
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      throw codedError('invalid_since', 'since must be an ISO timestamp or YYYY-MM-DD in America/Chicago');
    }
    const date = chicagoDateString(new Date(parsed));
    return {
      since_iso: new Date(parsed).toISOString(),
      since_ms: parsed,
      since_date: date,
    };
  }
  const today = chicagoDateString(now);
  if (!today) throw codedError('invalid_since', 'since must be YYYY-MM-DD in America/Chicago');
  const startDate = defaultDaysBack > 0 ? addCalendarDays(today, -defaultDaysBack) : today;
  const bounds = chicagoDayBounds(startDate);
  if (!bounds) throw codedError('invalid_since', 'since must be YYYY-MM-DD in America/Chicago');
  return {
    since_iso: bounds.beginTime,
    since_ms: Date.parse(bounds.beginTime),
    since_date: startDate,
  };
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

function formatChicagoDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: ZENBOOKER_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const time = formatChicagoTime(iso);
  return time ? `${day} at ${time}` : day;
}

function chicagoDateForApi(isoOrMs) {
  const date = new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return null;
  return chicagoDateString(date);
}

export function isCallRailConfigured(env = process.env) {
  return Boolean(String(env?.CALLRAIL_API_KEY || '').trim()
    && String(env?.CALLRAIL_ACCOUNT_ID || '').trim());
}

export function isGooglePlacesConfigured(env = process.env) {
  return Boolean(String(env?.GOOGLE_PLACES_API_KEY || '').trim()
    && String(env?.GOOGLE_PLACE_ID || '').trim());
}

function callRailAuth(apiKey) {
  return `Token token="${String(apiKey).trim()}"`;
}

export function createCallRailClient({
  apiKey,
  accountId,
  companyId,
  baseUrl = CALLRAIL_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const key = String(apiKey || '').trim();
  const account = String(accountId || '').trim();
  const company = String(companyId || '').trim();
  const root = String(baseUrl || CALLRAIL_API_BASE).replace(/\/$/, '');

  async function getJson(path, params = {}) {
    if (!key || !account) throw codedError('callrail_unconfigured', 'CallRail is not configured');
    const search = new URLSearchParams(params);
    const url = `${root}/a/${encodeURIComponent(account)}${path}?${search}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: callRailAuth(key),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw codedError('callrail_unavailable', 'CallRail request failed');
    }
    let text = '';
    try {
      text = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      throw codedError('callrail_unavailable', 'CallRail request failed');
    }
    if (!response?.ok) {
      throw codedError('callrail_unavailable', 'CallRail request failed');
    }
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw codedError('callrail_unavailable', 'CallRail request failed');
    }
    return body;
  }

  async function paginate(path, params, collectionKey, maxPages = 5) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await getJson(path, { ...params, page: String(page), per_page: '100' });
      const chunk = Array.isArray(body?.[collectionKey]) ? body[collectionKey] : [];
      items.push(...chunk);
      const totalPages = Number(body?.total_pages) || 1;
      if (page >= totalPages || !chunk.length) break;
    }
    return items;
  }

  return {
    async listCalls({ startDate, endDate, direction = 'inbound', firstTimeCallers, fields }) {
      const params = {
        start_date: startDate,
        end_date: endDate,
        direction,
        sorting: 'start_time',
        order: 'desc',
      };
      if (company) params.company_id = company;
      if (firstTimeCallers === true) params.first_time_callers = 'true';
      if (fields) params.fields = fields;
      return paginate('/calls.json', params, 'calls', 6);
    },
    async listFormSubmissions({ startDate, endDate, fields }) {
      const params = {
        start_date: startDate,
        end_date: endDate,
        sorting: 'submitted_at',
        order: 'desc',
      };
      if (company) params.company_id = company;
      if (fields) params.fields = fields;
      return paginate('/form_submissions.json', params, 'form_submissions', 4);
    },
  };
}

export function createCallRailClientFromEnv(env = process.env, overrides = {}) {
  if (!isCallRailConfigured(env)) return null;
  return createCallRailClient({
    apiKey: env.CALLRAIL_API_KEY,
    accountId: env.CALLRAIL_ACCOUNT_ID,
    companyId: env.CALLRAIL_COMPANY_ID,
    fetchImpl: overrides.fetchImpl,
  });
}

export function createGooglePlacesClient({
  apiKey,
  placeId,
  baseUrl = GOOGLE_PLACES_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const key = String(apiKey || '').trim();
  const place = String(placeId || '').trim();
  const root = String(baseUrl || GOOGLE_PLACES_API_BASE).replace(/\/$/, '');

  return {
    async getPlaceReviews() {
      if (!key || !place) throw codedError('google_places_unconfigured', 'Google Places is not configured');
      const url = `${root}/places/${encodeURIComponent(place)}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'displayName,reviews',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw codedError('google_places_unavailable', 'Google Places request failed');
      }
      let text = '';
      try {
        text = typeof response?.text === 'function' ? await response.text() : '';
      } catch {
        throw codedError('google_places_unavailable', 'Google Places request failed');
      }
      if (!response?.ok) {
        throw codedError('google_places_unavailable', 'Google Places request failed');
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw codedError('google_places_unavailable', 'Google Places request failed');
      }
    },
  };
}

export function createGooglePlacesClientFromEnv(env = process.env, overrides = {}) {
  if (!isGooglePlacesConfigured(env)) return null;
  return createGooglePlacesClient({
    apiKey: env.GOOGLE_PLACES_API_KEY,
    placeId: env.GOOGLE_PLACE_ID,
    fetchImpl: overrides.fetchImpl,
  });
}

function trackingSource(call) {
  return firstPresent(
    call?.formatted_tracking_source,
    call?.source_name,
    call?.source,
    call?.campaign,
    call?.medium,
  ) || null;
}

function isMissedCall(call) {
  if (!call || call.direction === 'outbound') return false;
  if (call.voicemail === true) return true;
  if (call.answered === false) return true;
  const status = normalizedString(call.call_type || call.call_status);
  return status === 'missed' || status === 'voicemail' || status === 'voicemail_transcription';
}

function publicMissedCall(call) {
  const phone = call.customer_phone_number || call.customer_phone || null;
  const links = phoneLinks(phone);
  return {
    id: call.id == null ? null : String(call.id),
    caller_name: call.customer_name ? String(call.customer_name).trim() : null,
    phone_e164: links.phone_e164,
    tel_link: links.tel_link,
    time: call.start_time || null,
    time_label: call.start_time ? formatChicagoDateTime(call.start_time) : null,
    tracking_source: trackingSource(call),
    voicemail: call.voicemail === true,
    transcription: call.transcription ? plainSpeech(call.transcription) : null,
  };
}

function speakMissedCalls(calls, sinceDate) {
  if (!calls.length) {
    return `No missed calls or voicemails since ${sinceDate} in Chicago time.`;
  }
  const parts = calls.map((call) => {
    const who = call.caller_name || 'Someone';
    const when = call.time_label || 'recently';
    const source = call.tracking_source ? ` from ${call.tracking_source}` : '';
    const kind = call.voicemail ? 'left a voicemail' : 'called and was not answered';
    let line = `${who} ${kind} ${when}${source}.`;
    if (call.phone_e164) line += ` Their number is ${call.phone_e164}.`;
    if (call.transcription) {
      const snippet = call.transcription.length > 120
        ? `${call.transcription.slice(0, 120).trim()} and more`
        : call.transcription;
      line += ` Voicemail says ${snippet.endsWith('.') ? snippet : `${snippet}.`}`;
    }
    return line;
  });
  const opener = calls.length === 1
    ? 'You have 1 missed call or voicemail.'
    : `You have ${calls.length} missed calls or voicemails.`;
  return plainSpeech(`${opener} ${parts.join(' ')}`);
}

export async function getMissedCalls(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const since = resolveSince(args, now);
  const env = deps.env || process.env;
  const client = deps.callRailClient !== undefined
    ? deps.callRailClient
    : createCallRailClientFromEnv(env, deps);

  if (!client) {
    return {
      ...SOURCE,
      tool: GET_MISSED_CALLS,
      connected: false,
      since: since.since_iso,
      calls: [],
      spoken: 'Call tracking is not connected yet. Add CallRail credentials to see missed calls.',
    };
  }

  const endDate = chicagoDateForApi(now) || since.since_date;
  try {
    const rawCalls = await client.listCalls({
      startDate: since.since_date,
      endDate,
      fields: 'transcription,source,source_name,formatted_tracking_source',
    });
    const calls = rawCalls
      .filter((call) => {
        const time = Date.parse(call.start_time || '');
        return !Number.isNaN(time) && time >= since.since_ms && isMissedCall(call);
      })
      .map(publicMissedCall)
      .sort((left, right) => Date.parse(right.time || 0) - Date.parse(left.time || 0));

    return {
      ...SOURCE,
      tool: GET_MISSED_CALLS,
      connected: true,
      since: since.since_iso,
      calls,
      spoken: speakMissedCalls(calls, since.since_date),
    };
  } catch (error) {
    deps.logger?.error?.('car_missed_calls_failed', {
      message: error.message,
      code: error.code,
    });
    return {
      ...SOURCE,
      tool: GET_MISSED_CALLS,
      connected: true,
      degraded: true,
      since: since.since_iso,
      calls: [],
      spoken: 'I could not load missed calls right now. Try again in a moment.',
    };
  }
}

function jobCreatedAt(job) {
  const value = firstPresent(job?.created, job?.created_at, job?.createdAt);
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
}

function isOnlineBooking(job) {
  const creator = normalizedString(firstPresent(
    job?.created_by,
    job?.createdBy,
    job?.creator_type,
    job?.creatorType,
  ));
  if (creator && ['customer', 'client', 'online', 'website'].includes(creator)) return true;
  const source = normalizedString(firstPresent(
    job?.booking_source,
    job?.bookingSource,
    job?.source,
    job?.channel,
  ));
  if (source && /online|website|web|booking|widget|embed|self/.test(source)) return true;
  if (job?.online_booking === true || job?.is_online_booking === true) return true;
  return false;
}

function extractFormContact(form) {
  const data = form?.form_data && typeof form.form_data === 'object' ? form.form_data : {};
  const entries = Object.entries(data);
  let name = null;
  let phone = null;
  let email = null;
  for (const [key, value] of entries) {
    const label = normalizedString(key);
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;
    if (!name && /name/.test(label)) name = text;
    if (!phone && /phone|mobile|cell/.test(label)) phone = text;
    if (!email && /email|e-mail/.test(label)) email = text;
  }
  return {
    name: name || (form?.customer_name ? String(form.customer_name).trim() : null),
    phone: phone || form?.customer_phone_number || null,
    email: email || form?.customer_email || null,
  };
}

function buildBookedPhoneSet(jobs) {
  const phones = new Set();
  for (const job of jobs) {
    const phone = normalizeUsE164(toPublicJob(job).customer_phone);
    if (phone) phones.add(phone);
  }
  return phones;
}

function hasBookedJob(phone, bookedPhones) {
  const e164 = normalizeUsE164(phone);
  if (!e164) return null;
  return bookedPhones.has(e164);
}

function publicZenbookerLead(job) {
  const pub = toPublicJob(job);
  const links = phoneLinks(pub.customer_phone);
  return {
    source: 'ZenBooker',
    kind: 'online_booking',
    id: pub.job_id,
    job_number: pub.job_number,
    name: pub.customer_name,
    phone_e164: links.phone_e164,
    tel_link: links.tel_link,
    created_at: new Date(jobCreatedAt(job)).toISOString(),
    created_label: formatChicagoDateTime(new Date(jobCreatedAt(job)).toISOString()),
    services: pub.services,
    scheduled_date: pub.date,
    has_booked_job: true,
    booking_status: isCancelledJob(job) ? 'cancelled' : (pub.status || 'booked'),
  };
}

function publicFormLead(form, bookedPhones) {
  const contact = extractFormContact(form);
  const links = phoneLinks(contact.phone);
  const booked = hasBookedJob(contact.phone, bookedPhones);
  return {
    source: 'CallRail',
    kind: 'form_submission',
    id: form.id == null ? null : String(form.id),
    name: contact.name,
    phone_e164: links.phone_e164,
    tel_link: links.tel_link,
    email: contact.email,
    submitted_at: form.submitted_at || form.created_at || null,
    submitted_label: form.submitted_at ? formatChicagoDateTime(form.submitted_at) : null,
    tracking_source: firstPresent(form.source_name, form.source, form.campaign) || null,
    form_name: form.form_name || form.form_url || null,
    has_booked_job: booked,
    booking_status: booked ? 'booked' : 'not_booked_yet',
  };
}

function publicCallerLead(call, bookedPhones) {
  const links = phoneLinks(call.customer_phone_number);
  const booked = hasBookedJob(call.customer_phone_number, bookedPhones);
  return {
    source: 'CallRail',
    kind: 'first_time_caller',
    id: call.id == null ? null : String(call.id),
    name: call.customer_name ? String(call.customer_name).trim() : null,
    phone_e164: links.phone_e164,
    tel_link: links.tel_link,
    called_at: call.start_time || null,
    called_label: call.start_time ? formatChicagoDateTime(call.start_time) : null,
    tracking_source: trackingSource(call),
    has_booked_job: booked,
    booking_status: booked ? 'booked' : 'not_booked_yet',
  };
}

function speakLeads(leads, sinceDate, extras = {}) {
  const bits = [];
  if (extras.zenbooker_connected === false) {
    bits.push('ZenBooker is not connected, so online bookings may be missing.');
  }
  if (extras.callrail_connected === false) {
    bits.push('CallRail is not connected, so web forms and first-time callers may be missing.');
  }
  if (extras.degraded) {
    bits.push('Some lead sources could not be loaded right now.');
  }
  if (!leads.length) {
    bits.push(`No new leads since ${sinceDate} in Chicago time.`);
    return plainSpeech(bits.join(' '));
  }
  const unbooked = leads.filter((lead) => lead.has_booked_job === false);
  const opener = leads.length === 1
    ? 'You have 1 new lead.'
    : `You have ${leads.length} new leads.`;
  const lines = leads.map((lead) => {
    const who = lead.name || 'Someone';
    const when = lead.submitted_label || lead.called_label || lead.created_label || 'recently';
    const source = lead.source === 'ZenBooker'
      ? `booked ${lead.services?.join(' and ') || 'a service'} on ZenBooker`
      : lead.kind === 'form_submission'
        ? `submitted a web form${lead.tracking_source ? ` from ${lead.tracking_source}` : ''}`
        : `called for the first time${lead.tracking_source ? ` from ${lead.tracking_source}` : ''}`;
    let line = `${who} ${source} ${when}.`;
    if (lead.has_booked_job === false) line += ' No booked job yet.';
    if (lead.phone_e164) line += ` Phone ${lead.phone_e164}.`;
    return line;
  });
  let text = `${opener} ${lines.join(' ')}`;
  if (unbooked.length) {
    text += unbooked.length === 1
      ? ' One lead does not have a booked job yet.'
      : ` ${unbooked.length} leads do not have booked jobs yet.`;
  }
  bits.push(text);
  return plainSpeech(bits.join(' '));
}

async function listZenbookerJobsForLeads(client, sinceDate, now) {
  if (!client || typeof client.listJobs !== 'function') return [];
  const endDate = addCalendarDays(chicagoDateString(now), 120);
  const begin = chicagoDayBounds(sinceDate);
  const end = endDate ? chicagoDayBounds(endDate) : null;
  if (!begin || !end) return [];
  return client.listJobs({
    startDateMin: begin.beginTime,
    startDateMax: end.endTime,
    includeCancelled: true,
    maxPages: 8,
  });
}

export async function getNewLeads(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const since = resolveSince(args, now);
  const env = deps.env || process.env;
  const zenbookerClient = deps.client;
  const callRailClient = deps.callRailClient !== undefined
    ? deps.callRailClient
    : createCallRailClientFromEnv(env, deps);

  const leads = [];
  let degraded = false;
  const zenbookerConnected = Boolean(zenbookerClient);
  const callrailConnected = Boolean(callRailClient);

  let bookedPhones = new Set();
  let zenbookerJobs = [];

  if (zenbookerClient) {
    try {
      zenbookerJobs = await listZenbookerJobsForLeads(zenbookerClient, since.since_date, now);
      bookedPhones = buildBookedPhoneSet(zenbookerJobs);
      for (const job of zenbookerJobs) {
        const created = jobCreatedAt(job);
        if (created == null || created < since.since_ms) continue;
        if (!isOnlineBooking(job)) continue;
        leads.push(publicZenbookerLead(job));
      }
    } catch (error) {
      degraded = true;
      deps.logger?.error?.('car_new_leads_zenbooker_failed', { message: error.message });
    }
  }

  if (callRailClient) {
    const endDate = chicagoDateForApi(now) || since.since_date;
    try {
      const forms = await callRailClient.listFormSubmissions({
        startDate: since.since_date,
        endDate,
        fields: 'form_data,source,source_name,campaign,form_name,form_url',
      });
      for (const form of forms) {
        const time = Date.parse(form.submitted_at || form.created_at || '');
        if (Number.isNaN(time) || time < since.since_ms) continue;
        leads.push(publicFormLead(form, bookedPhones));
      }
    } catch (error) {
      degraded = true;
      deps.logger?.error?.('car_new_leads_callrail_forms_failed', { message: error.message });
    }
    try {
      const callers = await callRailClient.listCalls({
        startDate: since.since_date,
        endDate,
        firstTimeCallers: true,
        fields: 'source,source_name,formatted_tracking_source',
      });
      for (const call of callers) {
        const time = Date.parse(call.start_time || '');
        if (Number.isNaN(time) || time < since.since_ms) continue;
        if (call.direction === 'outbound') continue;
        leads.push(publicCallerLead(call, bookedPhones));
      }
    } catch (error) {
      degraded = true;
      deps.logger?.error?.('car_new_leads_callrail_callers_failed', { message: error.message });
    }
  }

  leads.sort((left, right) => {
    const leftTime = Date.parse(left.submitted_at || left.called_at || left.created_at || 0);
    const rightTime = Date.parse(right.submitted_at || right.called_at || right.created_at || 0);
    return rightTime - leftTime;
  });

  return {
    ...SOURCE,
    tool: GET_NEW_LEADS,
    since: since.since_iso,
    zenbooker_connected: zenbookerConnected,
    callrail_connected: callrailConnected,
    sources_not_connected: SOURCES_NOT_CONNECTED,
    degraded,
    leads,
    spoken: speakLeads(leads, since.since_date, {
      zenbooker_connected: zenbookerConnected,
      callrail_connected: callrailConnected,
      degraded,
    }),
  };
}

function reviewerFirstName(review) {
  const display = review?.authorAttribution?.displayName
    || review?.author_attribution?.displayName
    || review?.author_name
    || '';
  const trimmed = String(display).trim();
  if (!trimmed) return 'A customer';
  return trimmed.split(/\s+/)[0];
}

export function suggestReviewReply({ rating, text, reviewerFirstName: name }) {
  const stars = Number(rating);
  const who = name || 'there';
  const snippet = plainSpeech(text || '').slice(0, 80);
  if (stars >= 5) {
    return plainSpeech(`Hi ${who}, thank you so much for the five-star review${snippet ? ` and for mentioning ${snippet}` : ''}. It means a lot to me and the team. We really appreciate you trusting The Mounting Man.`);
  }
  if (stars >= 4) {
    return plainSpeech(`Hi ${who}, thank you for the kind review and for choosing The Mounting Man. I'm glad we could help, and we appreciate you taking a moment to share your experience.`);
  }
  if (stars >= 3) {
    return plainSpeech(`Hi ${who}, thanks for your feedback. I'm Marshall with The Mounting Man, and I'd love to hear how we can make your next visit even better. Please reach out anytime.`);
  }
  return plainSpeech(`Hi ${who}, I'm Marshall, owner of The Mounting Man. I'm sorry we missed the mark. I'd like to understand what happened and make it right. Please call or text me directly so we can fix this.`);
}

function publicReview(review) {
  const rating = Number(review?.rating);
  const text = plainSpeech(review?.text?.text || review?.text || review?.originalText?.text || '');
  const firstName = reviewerFirstName(review);
  const publishTime = review?.publishTime || review?.publish_time || null;
  return {
    reviewer_first_name: firstName,
    stars: Number.isFinite(rating) ? rating : null,
    time: publishTime,
    time_label: publishTime ? formatChicagoDateTime(publishTime) : null,
    text,
    suggested_reply: suggestReviewReply({ rating, text, reviewerFirstName: firstName }),
  };
}

function speakReviews(reviews, sinceDate, note) {
  if (note) return plainSpeech(note);
  if (!reviews.length) {
    return `No new Google reviews since ${sinceDate} in Chicago time.`;
  }
  const opener = reviews.length === 1
    ? 'You have 1 new review.'
    : `You have ${reviews.length} new reviews.`;
  const lines = reviews.map((review) => {
    const stars = review.stars == null ? 'unrated' : `${review.stars} stars`;
    const when = review.time_label || 'recently';
    const snippet = review.text
      ? (review.text.length > 100 ? `${review.text.slice(0, 100).trim()} and more` : review.text)
      : 'no written comment';
    return `${review.reviewer_first_name} left ${stars} ${when}. They said ${snippet.endsWith('.') ? snippet : `${snippet}.`}`;
  });
  return plainSpeech(`${opener} ${lines.join(' ')} Google only returns the latest few reviews here.`);
}

export async function getNewReviews(args = {}, deps = {}) {
  const now = deps.now || new Date();
  const since = resolveSince(args, now, { defaultDaysBack: 7 });
  const env = deps.env || process.env;
  const client = deps.placesClient !== undefined
    ? deps.placesClient
    : createGooglePlacesClientFromEnv(env, deps);

  if (!client) {
    return {
      ...SOURCE,
      tool: GET_NEW_REVIEWS,
      connected: false,
      since: since.since_iso,
      reviews: [],
      review_limit_note: 'Google Places only returns up to five recent reviews. Full Business Profile reviews need OAuth that is not set up yet.',
      spoken: 'Google reviews are not connected yet. Add Google Places credentials to hear new reviews.',
    };
  }

  try {
    const body = await client.getPlaceReviews();
    const rawReviews = Array.isArray(body?.reviews) ? body.reviews : [];
    const reviews = rawReviews
      .filter((review) => {
        const time = Date.parse(review.publishTime || review.publish_time || '');
        return !Number.isNaN(time) && time >= since.since_ms;
      })
      .map(publicReview)
      .sort((left, right) => Date.parse(right.time || 0) - Date.parse(left.time || 0));

    return {
      ...SOURCE,
      tool: GET_NEW_REVIEWS,
      connected: true,
      since: since.since_iso,
      place_name: body?.displayName?.text || null,
      reviews,
      review_limit_note: 'Google Places only returns up to five recent reviews. Full Business Profile reviews need OAuth that is not set up yet.',
      spoken: speakReviews(reviews, since.since_date),
    };
  } catch (error) {
    deps.logger?.error?.('car_new_reviews_failed', { message: error.message, code: error.code });
    return {
      ...SOURCE,
      tool: GET_NEW_REVIEWS,
      connected: true,
      degraded: true,
      since: since.since_iso,
      reviews: [],
      review_limit_note: 'Google Places only returns up to five recent reviews. Full Business Profile reviews need OAuth that is not set up yet.',
      spoken: 'I could not load Google reviews right now. Try again in a moment.',
    };
  }
}

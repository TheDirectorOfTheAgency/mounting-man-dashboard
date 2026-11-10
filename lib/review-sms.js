// Review-request SMS. Off unless REVIEW_SMS_ENABLED is exactly "true".
// The A2P 10DLC campaign was approved Oct 16, 2026 and is still VERIFIED.
// The customer body is the Nov 9, 2026 message. The pause stays: Square
// payments do not carry a ZenBooker text opt-in, stored ad-measurement
// consent is not that opt-in, and invoice.payment_made returns before SMS.
// Do not enable the flag here.

import axios from 'axios';
import crypto from 'crypto';

export const REVIEW_SMS_PAUSED = 'paused';
export const REVIEW_SMS_SKIP_TEST_MODE = 'skipped_test_mode';
export const REVIEW_SMS_SKIP_NO_CONSENT = 'skipped_no_consent';
export const REVIEW_SMS_SKIP_CONSENT_UNKNOWN = 'skipped_consent_unknown';
export const REVIEW_SMS_SKIP_ALREADY_ASKED = 'skipped_already_asked';

export const REVIEW_LINK = 'https://g.page/themountingman/review?id';
export const DEFAULT_REVIEW_SMS_STATUS_CALLBACK_URL =
  'https://mounting-man-dashboard.vercel.app/api/webhooks/twilio-status';

const SMS_CHECKBOX_LABEL = 'notifications about this appointment';
const DELIVERY_ALERT_CODES = new Set(['30034', '30007', '21610']);
const SKIP_REASONS = new Set([
  REVIEW_SMS_SKIP_TEST_MODE,
  REVIEW_SMS_SKIP_NO_CONSENT,
  REVIEW_SMS_SKIP_CONSENT_UNKNOWN,
  REVIEW_SMS_SKIP_ALREADY_ASKED,
]);
const DIRECT_CONSENT_KEYS = [
  'sms_consent',
  'smsConsent',
  'sms_opt_in',
  'smsOptIn',
  'sms_notifications',
  'send_sms_notifications',
  'text_message_notifications',
  'text_notifications',
  'notification_sms',
  'receive_sms',
];
const NESTED_CONSENT_KEYS = [
  'customer',
  'notifications',
  'notification_preferences',
  'preferences',
  'communication_preferences',
];
const CUSTOM_FIELD_LISTS = [
  'custom_fields',
  'job_fields',
  'service_fields',
  'fields',
  'booking_fields',
];
const ASKED_KEYS = [
  'alreadyAskedForReview',
  'duringJobReviewAsked',
  'reviewAskedDuringJob',
];

export function reviewSmsBody() {
  return `Thank you so much for the business. If you could write a nice review on Google about me at the link here, and upload a photo of the work, that would help out a ton! ${REVIEW_LINK} Reply STOP to opt out.`;
}

export function reviewSmsStatusCallbackUrl(env = process.env) {
  const override = String(env?.REVIEW_SMS_STATUS_CALLBACK_URL || '').trim();
  if (!override) return DEFAULT_REVIEW_SMS_STATUS_CALLBACK_URL;
  try {
    const parsed = new URL(override);
    if (parsed.protocol !== 'https:') return DEFAULT_REVIEW_SMS_STATUS_CALLBACK_URL;
    return override;
  } catch {
    return DEFAULT_REVIEW_SMS_STATUS_CALLBACK_URL;
  }
}

function normalizeUsE164(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (!hasPlus && digits.length === 10) digits = `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

export function parseReviewSmsAllowlist(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const keys = new Set();
  for (const part of text.split(/[,;\s]+/)) {
    const key = normalizeUsE164(part);
    if (key) keys.add(key);
  }
  return keys;
}

function interpretConsentValue(value) {
  if (value === true) return 'granted';
  if (value === false) return 'denied';
  if (typeof value === 'number') {
    if (value === 1) return 'granted';
    if (value === 0) return 'denied';
    return 'unknown';
  }
  if (value == null) return 'unknown';
  const text = String(value).trim().toLowerCase();
  if (!text) return 'unknown';
  if (['true', 'yes', 'y', '1', 'on', 'checked', 'ticked'].includes(text)) return 'granted';
  if (['false', 'no', 'n', '0', 'off', 'unchecked', 'unticked'].includes(text)) return 'denied';
  return 'unknown';
}

function isSmsCheckboxLabel(label) {
  const text = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return text.includes(SMS_CHECKBOX_LABEL) && text.includes('text');
}

function customFieldState(field) {
  if (!field || typeof field !== 'object') return null;
  const label = field.field_name || field.name || field.label || field.key || field.title || '';
  if (!isSmsCheckboxLabel(label)) return null;
  const valueKeys = ['text_value', 'value', 'answer', 'boolean_value', 'checked', 'selected', 'field_value'];
  for (const key of valueKeys) {
    if (Object.prototype.hasOwnProperty.call(field, key) && field[key] != null && field[key] !== '') {
      return interpretConsentValue(field[key]);
    }
  }
  return 'unknown';
}

function statesFromFieldLists(source) {
  const states = [];
  if (!source || typeof source !== 'object') return states;
  const containers = [source];
  if (source.customer && typeof source.customer === 'object') containers.push(source.customer);
  for (const container of containers) {
    for (const listName of CUSTOM_FIELD_LISTS) {
      const list = container[listName];
      if (!Array.isArray(list)) continue;
      for (const field of list) {
        const state = customFieldState(field);
        if (state) states.push(state);
      }
    }
  }
  return states;
}

function statesFromDirectKeys(source) {
  const states = [];
  if (!source || typeof source !== 'object') return states;
  const objects = [source];
  for (const key of NESTED_CONSENT_KEYS) {
    const nested = source[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) objects.push(nested);
  }
  for (const object of objects) {
    for (const key of DIRECT_CONSENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      states.push(interpretConsentValue(object[key]));
    }
  }
  return states;
}

function combineConsent(states) {
  if (states.includes('denied')) return 'denied';
  if (states.includes('granted')) return 'granted';
  if (states.includes('unknown')) return 'unknown';
  return 'absent';
}

function consentLayers(source) {
  if (!source || typeof source !== 'object') return [];
  const layers = [];
  for (const key of ['booking', 'zenbookerBooking', 'zenbooker_booking']) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) layers.push(value);
  }
  layers.push(source);
  return layers;
}

// Square payment payloads do not carry the ZenBooker SMS checkbox. This reads
// it when a booking is attached (direct keys or the booking-form label). A
// missing field is "unknown", which the sender logs as skipped_consent_unknown.
// No ZenBooker login is attempted.
export function readZenbookerSmsConsent(source) {
  try {
    const states = consentLayers(source).flatMap((layer) => [
      ...statesFromDirectKeys(layer),
      ...statesFromFieldLists(layer),
    ]);
    const combined = combineConsent(states);
    if (combined === 'absent') return 'unknown';
    return combined;
  } catch (error) {
    console.error('[twilio-skip] consent reader failed', error?.name || 'Error');
    return 'unknown';
  }
}

export function attachedReviewSmsBooking({ payment, customer, invoice } = {}) {
  for (const source of [payment, customer, invoice]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['booking', 'zenbookerBooking', 'zenbooker_booking']) {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
  }
  return null;
}

// During-job review asks are not in this repo. Mr. Wayne said Frame customers
// already get one during the visit; the channel (ZenBooker, his phone, or
// something else) is still unknown, so this does not guess. It skips only when
// alreadyAskedForReview, duringJobReviewAsked, or reviewAskedDuringJob is
// boolean true on the job or its booking, or when wasAskedDuringJob says so.
export function readDuringJobReviewAsk(job) {
  const layers = [job, job?.booking, job?.zenbookerBooking, job?.zenbooker_booking];
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const key of ASKED_KEYS) {
      if (layer[key] === true) return true;
    }
  }
  return false;
}

export function classifyReviewSmsOutcome(outcome) {
  if (outcome === true) return 'sent';
  if (outcome === REVIEW_SMS_PAUSED) return 'paused';
  if (SKIP_REASONS.has(outcome)) return outcome;
  return 'failed';
}

function consentSkip(consent) {
  switch (consent) {
    case 'granted':
      return null;
    case 'denied':
      return REVIEW_SMS_SKIP_NO_CONSENT;
    case 'unknown':
      return REVIEW_SMS_SKIP_CONSENT_UNKNOWN;
    default: {
      const unhandled = consent;
      throw new Error(`Unhandled review SMS consent state: ${unhandled}`);
    }
  }
}

// Returns true when Twilio accepted the request, REVIEW_SMS_PAUSED when the
// flag is off, a skipped_* reason when a safety gate declines, and false for
// a real send failure. Never posts a raw sender number.
export async function sendReviewSms(job = {}, options = {}) {
  const env = options.env || process.env;
  const paymentId = job?.paymentId || '';

  if (env.REVIEW_SMS_ENABLED !== 'true') {
    console.log(`[twilio-paused] Review SMS disabled (REVIEW_SMS_ENABLED not true) for payment ${paymentId}`);
    return REVIEW_SMS_PAUSED;
  }

  const phone = normalizeUsE164(job?.phone);
  const allowlist = parseReviewSmsAllowlist(env.REVIEW_SMS_TEST_TO);
  if (allowlist && !allowlist.has(phone)) {
    console.log(`[twilio-skip] skipped_test_mode for payment ${paymentId}`);
    return REVIEW_SMS_SKIP_TEST_MODE;
  }

  const consentReason = consentSkip(readZenbookerSmsConsent(job));
  if (consentReason) {
    console.log(`[twilio-skip] ${consentReason} for payment ${paymentId}`);
    return consentReason;
  }

  let alreadyAsked = false;
  try {
    alreadyAsked = typeof options.wasAskedDuringJob === 'function'
      ? Boolean(await options.wasAskedDuringJob(job))
      : readDuringJobReviewAsk(job);
  } catch (error) {
    console.error('[twilio-skip] skipped_already_asked suppression reader failed', error?.name || 'Error');
    return REVIEW_SMS_SKIP_ALREADY_ASKED;
  }
  if (alreadyAsked) {
    console.log(`[twilio-skip] skipped_already_asked for payment ${paymentId}`);
    return REVIEW_SMS_SKIP_ALREADY_ASKED;
  }

  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  if (!accountSid || !authToken) {
    console.error('[twilio-skip] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    console.error(`[twilio-skip] Review SMS not sent for payment ${paymentId}`);
    return false;
  }

  const serviceSid = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  if (!/^MG[0-9a-fA-F]{32}$/.test(serviceSid)) {
    console.error('[twilio-skip] Missing or invalid TWILIO_MESSAGING_SERVICE_SID');
    console.error(`[twilio-skip] Review SMS not sent for payment ${paymentId}`);
    return false;
  }

  if (!phone) {
    console.error(`[twilio-skip] Review SMS not sent for payment ${paymentId}`);
    return false;
  }

  const httpClient = options.httpClient || axios;
  const statusCallback = options.statusCallbackUrl || reviewSmsStatusCallbackUrl(env);
  try {
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    await httpClient.post(
      twilioUrl,
      new URLSearchParams({
        MessagingServiceSid: serviceSid,
        To: phone,
        Body: reviewSmsBody(),
        StatusCallback: statusCallback,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    console.log(`[twilio] Review SMS submitted for payment ${paymentId}`);
    return true;
  } catch (err) {
    console.error('[twilio-error]', err?.response?.status || err?.message || 'send_failed');
    return false;
  }
}

export function expectedTwilioSignature(authToken, url, params) {
  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function validateTwilioSignature({ authToken, signature, url, params }) {
  if (!authToken || !signature || !url) return false;
  const expected = expectedTwilioSignature(authToken, url, params || {});
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(String(signature));
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export function parseTwilioForm(raw) {
  const params = {};
  const search = new URLSearchParams(String(raw ?? ''));
  for (const [key, value] of search.entries()) params[key] = value;
  return params;
}

export function requestTwilioSignatureUrl(req) {
  const headers = req?.headers || {};
  const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const rawUrl = String(req?.url || '');
  const queryIndex = rawUrl.indexOf('?');
  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
  return `${proto}://${host}/api/webhooks/twilio-status${query}`;
}

function headerValue(req, name) {
  const headers = req?.headers || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return '';
}

export function readRequestBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function shouldAlertReviewSmsDelivery(messageStatus, errorCode) {
  const code = String(errorCode || '').trim();
  if (DELIVERY_ALERT_CODES.has(code)) return true;
  return messageStatus === 'undelivered' || messageStatus === 'failed';
}

function signatureCandidates(req, env, signatureUrl) {
  if (signatureUrl) {
    const url = typeof signatureUrl === 'function' ? signatureUrl(req) : signatureUrl;
    return url ? [url] : [];
  }
  return [reviewSmsStatusCallbackUrl(env), requestTwilioSignatureUrl(req)].filter(Boolean);
}

export function createTwilioStatusHandler({
  readRawBody = readRequestBody,
  authToken = () => process.env.TWILIO_AUTH_TOKEN,
  env = process.env,
  signatureUrl,
  alert = async () => {},
  record = async (entry) => {
    console.log('[review-sms-status]', {
      messageSid: entry.messageSid,
      messageStatus: entry.messageStatus,
      errorCode: entry.errorCode,
    });
  },
  claimAlert = async () => true,
  logger = console,
} = {}) {
  return async function twilioStatusHandler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const token = String((typeof authToken === 'function' ? authToken() : authToken) || '').trim();
    if (!token) return res.status(401).json({ error: 'webhook_not_configured' });

    let raw = '';
    try {
      raw = await readRawBody(req);
    } catch (error) {
      logger.warn?.('review_sms_status_body_failed', { errorType: error?.name || 'Error' });
      return res.status(400).json({ error: 'invalid_body' });
    }

    const params = parseTwilioForm(raw);
    const signature = headerValue(req, 'x-twilio-signature');
    const urls = signatureCandidates(req, env, signatureUrl);
    const valid = urls.some((url) => validateTwilioSignature({
      authToken: token,
      signature,
      url,
      params,
    }));
    if (!valid) return res.status(403).json({ error: 'invalid_signature' });

    const messageSid = String(params.MessageSid || params.SmsSid || '').trim();
    const messageStatus = String(params.MessageStatus || params.SmsStatus || '').trim().toLowerCase();
    const errorCode = String(params.ErrorCode || '').trim();
    if (!messageSid || !messageStatus) {
      return res.status(200).json({ status: 'ignored', reason: 'missing_status' });
    }

    const entry = {
      messageSid,
      messageStatus,
      errorCode: errorCode || null,
      recordedAt: new Date().toISOString(),
    };
    try {
      await record(entry);
    } catch (error) {
      logger.warn?.('review_sms_status_record_failed', { errorType: error?.name || 'Error' });
      return res.status(500).json({ error: 'record_failed' });
    }

    if (shouldAlertReviewSmsDelivery(messageStatus, errorCode)) {
      const alertKey = `${messageSid}:${messageStatus}:${errorCode}`;
      let claimed = true;
      try {
        claimed = await claimAlert(alertKey) !== false;
      } catch (error) {
        logger.warn?.('review_sms_status_claim_failed', { errorType: error?.name || 'Error' });
        claimed = true;
      }
      if (claimed) {
        try {
          await alert({
            kind: 'review_sms_delivery_failed',
            subject: `Review SMS ${messageStatus} ${errorCode}`.trim(),
            body: `Review SMS ${messageSid} status ${messageStatus} error ${errorCode || 'none'}`,
          });
        } catch (error) {
          logger.warn?.('review_sms_alert_failed', { errorType: error?.name || 'Error' });
          return res.status(500).json({ error: 'alert_failed' });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      messageStatus,
      errorCode: errorCode || null,
    });
  };
}

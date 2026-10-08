// Confirm-gated "I'm N minutes out" text for the car voice assistant.
// Step 1 previews. Step 2 sends only with a matching, unexpired preview token.
// Off unless CAR_TEXT_ENABLED is exactly "true".

import crypto from 'crypto';
import axios from 'axios';

import { normalizePhoneE164 } from './hash-pii.js';
import { timingSafeEqualString } from './mcp-http.mjs';
import { signingSecret } from './mcp-oauth.mjs';
import { cityFromAddressLine, getNextJob } from './zenbooker-jobs-feed.mjs';

export const TEXT_NEXT_CUSTOMER_ETA = 'text_next_customer_eta';

const TOKEN_VERSION = 'etap1';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_SECONDS = 10 * 60;
const RATE_LIMIT_PREFIX = 'car-eta-text:';
const OFF_SPOKEN = 'Customer texting is turned off right now';
const PREVIEW_AGAIN = "I didn't send it. Ask me to preview the text again.";
// Same From default as the Square review SMS. Nothing in the repo records
// whether this number is registered for US A2P 10DLC.
const TWILIO_DEFAULT_FROM = '+19526496388';

export const textNextCustomerEtaTool = {
  name: TEXT_NEXT_CUSTOMER_ETA,
  description:
    "Text the in-progress or next ZenBooker customer that Marshall is on the way. Always call step 1 first with confirm false (or omit confirm). Read the returned text aloud, then ask if he wants it sent. Call step 2 with confirm true and that same preview_token only after Mr. Wayne clearly says yes in this conversation. Never confirm from a guess, a nod you did not hear, or a yes from an earlier conversation. The recipient comes only from the in-progress or next ZenBooker job, never from a phone number you supply. minutes is an integer from 1 to 120. note is optional and at most 120 characters. Nothing is sent on step 1. The tool is off unless CAR_TEXT_ENABLED is exactly true.",
  inputSchema: {
    type: 'object',
    properties: {
      minutes: {
        type: 'integer',
        description: 'How many minutes away. Integer from 1 to 120.',
      },
      note: {
        type: 'string',
        description: 'Optional extra line, at most 120 characters.',
      },
      confirm: {
        type: 'boolean',
        description: 'Defaults to false. Step 1 leaves this false. Step 2 sets it true only after Mr. Wayne clearly says yes in this conversation.',
      },
      preview_token: {
        type: 'string',
        description: 'The preview_token from step 1. Required when confirm is true.',
      },
    },
    required: ['minutes'],
  },
};

function refused(reason, spoken) {
  return { tool: TEXT_NEXT_CUSTOMER_ETA, sent: false, reason, spoken };
}

function parseMinutes(value) {
  let minutes = null;
  if (typeof value === 'number' && Number.isInteger(value)) minutes = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) minutes = Number(value.trim());
  if (minutes == null || minutes < 1 || minutes > 120) return null;
  return minutes;
}

function parseNote(value) {
  if (value == null || value === '') return { ok: true, note: '' };
  if (typeof value !== 'string') return { ok: false };
  const note = value.replace(/[\r\n]+/g, ' ').trim();
  if (note.length > 120) return { ok: false };
  return { ok: true, note };
}

export function buildEtaText({ firstName, minutes, note }) {
  const base = `Hi ${firstName}, this is Marshall with The Mounting Man. I'm about ${minutes} minutes away. See you soon!`;
  return note ? `${base} ${note}` : base;
}

function customerFirstName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/)[0];
}

function phoneLast4(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function mintPreviewToken({ jobId, phone, text, exp, secret }) {
  const payload = Buffer.from(JSON.stringify({
    job_id: jobId,
    phone,
    text,
    exp,
  })).toString('base64url');
  const signature = sign(secret, `${TOKEN_VERSION}.${payload}`);
  return `${TOKEN_VERSION}.${payload}.${signature}`;
}

function openPreviewToken(token, secret) {
  if (!secret || typeof token !== 'string' || token.length < 10 || token.length > 4000) {
    return { ok: false, reason: 'bad_token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'bad_token' };
  }
  const [, payload, signature] = parts;
  if (!timingSafeEqualString(signature, sign(secret, `${TOKEN_VERSION}.${payload}`))) {
    return { ok: false, reason: 'bad_token' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
  if (
    !claims
    || typeof claims.job_id !== 'string'
    || typeof claims.phone !== 'string'
    || typeof claims.text !== 'string'
    || !Number.isFinite(claims.exp)
  ) {
    return { ok: false, reason: 'bad_token' };
  }
  return { ok: true, claims };
}

function textingEnabled(env) {
  return env.CAR_TEXT_ENABLED === 'true';
}

async function resolveRecipient(deps) {
  const next = await getNextJob({}, deps);
  if (!next?.found || !next.job?.job_id) return { ok: false, reason: 'no_job' };
  const job = next.job;
  const phone = normalizePhoneE164(job.phone_e164 || '');
  if (!phone) return { ok: false, reason: 'bad_phone' };
  const firstName = customerFirstName(job.customer_name);
  if (!firstName) return { ok: false, reason: 'no_name' };
  return {
    ok: true,
    jobId: String(job.job_id),
    phone,
    firstName,
    jobTime: job.time_window?.label || null,
    city: cityFromAddressLine(job.service_address),
  };
}

async function loadKv(deps, env) {
  if (deps.kv) return deps.kv;
  const url = String(env.KV_REST_API_URL || '').trim();
  const token = String(env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) return null;
  try {
    const mod = await import('@vercel/kv');
    return mod.kv || null;
  } catch {
    return null;
  }
}

async function claimSendSlot(kv, jobId) {
  if (!kv || typeof kv.set !== 'function') return { ok: false, reason: 'kv_unavailable' };
  const key = `${RATE_LIMIT_PREFIX}${jobId}`;
  try {
    const result = await kv.set(key, '1', { nx: true, ex: RATE_LIMIT_SECONDS });
    if (result === 'OK' || result === true) return { ok: true, key };
    return { ok: false, reason: 'rate_limited' };
  } catch {
    return { ok: false, reason: 'kv_unavailable' };
  }
}

async function releaseSendSlot(kv, key) {
  if (!kv || !key || typeof kv.del !== 'function') return;
  try {
    await kv.del(key);
  } catch {
    // Leave the lock. A retry inside 10 minutes is safer than a double text.
  }
}

export async function sendTwilioSms({ to, body, env = process.env, httpClient = axios } = {}) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(env.TWILIO_FROM_NUMBER || TWILIO_DEFAULT_FROM).trim();
  if (!accountSid || !authToken || !from || !to || !body) {
    throw Object.assign(new Error('twilio_unconfigured'), { code: 'twilio_unconfigured' });
  }
  const response = await httpClient.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 8000,
    },
  );
  const sid = response?.data?.sid;
  if (typeof sid !== 'string' || !/^[A-Za-z0-9_]{2,64}$/.test(sid)) {
    throw Object.assign(new Error('twilio_no_sid'), { code: 'twilio_no_sid' });
  }
  return sid;
}

function audit(logger, line) {
  try {
    logger?.info?.(line);
  } catch {
    // The send already happened. A log failure must not look like a failed text.
  }
}

export async function textNextCustomerEta(args = {}, deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  if (!textingEnabled(env)) return refused('disabled', OFF_SPOKEN);

  const minutes = parseMinutes(args.minutes);
  if (minutes == null) {
    return refused('invalid_minutes', 'Tell me how many minutes, from 1 to 120. I didn\'t send a text.');
  }
  const note = parseNote(args.note);
  if (!note.ok) {
    return refused('invalid_note', 'Keep the note to 120 characters. I didn\'t send a text.');
  }

  const recipient = await resolveRecipient(deps);
  if (!recipient.ok) {
    if (recipient.reason === 'bad_phone') {
      return refused('bad_phone', "That customer's phone number can't be texted. I didn't send it.");
    }
    if (recipient.reason === 'no_name') {
      return refused('no_name', "ZenBooker has no customer name on the next job. I didn't send a text.");
    }
    return refused('no_job', "You have no upcoming jobs. I didn't send a text.");
  }

  const text = buildEtaText({ firstName: recipient.firstName, minutes, note: note.note });
  const now = deps.now instanceof Date ? deps.now : new Date();
  const nowMs = now.getTime();
  const confirm = args.confirm === true;

  if (!confirm) {
    const secret = signingSecret(env);
    if (!secret) return refused('unconfigured', "I can't prepare that text right now. I didn't send it.");
    const previewToken = mintPreviewToken({
      jobId: recipient.jobId,
      phone: recipient.phone,
      text,
      exp: nowMs + TOKEN_TTL_MS,
      secret,
    });
    return {
      tool: TEXT_NEXT_CUSTOMER_ETA,
      sent: false,
      reason: 'preview',
      text,
      first_name: recipient.firstName,
      job_time: recipient.jobTime,
      city: recipient.city,
      phone_last4: phoneLast4(recipient.phone),
      preview_token: previewToken,
      minutes,
      spoken: `${text} Want me to send it?`,
    };
  }

  const opened = openPreviewToken(args.preview_token, signingSecret(env));
  if (!opened.ok) return refused('bad_token', PREVIEW_AGAIN);
  const { claims } = opened;
  if (nowMs >= claims.exp) return refused('expired', PREVIEW_AGAIN);
  if (claims.job_id !== recipient.jobId || claims.phone !== recipient.phone || claims.text !== text) {
    return refused('mismatch', PREVIEW_AGAIN);
  }

  const kv = await loadKv(deps, env);
  const claim = await claimSendSlot(kv, recipient.jobId);
  if (!claim.ok) {
    if (claim.reason === 'rate_limited') {
      return refused('rate_limited', "I already texted this job in the last 10 minutes. I didn't send another.");
    }
    return refused('kv_unavailable', "I couldn't check the send limit, so I didn't text them.");
  }

  let sid;
  try {
    if (typeof deps.sendSms === 'function') {
      sid = await deps.sendSms({ to: recipient.phone, body: text });
    } else {
      sid = await sendTwilioSms({
        to: recipient.phone,
        body: text,
        env,
        httpClient: deps.httpClient,
      });
    }
  } catch {
    await releaseSendSlot(kv, claim.key);
    audit(logger, `[car-eta-text] failed job=${recipient.jobId} last4=${phoneLast4(recipient.phone)} minutes=${minutes}`);
    return refused('twilio_failed', "The text didn't go through. I didn't send it.");
  }

  if (typeof sid !== 'string' || !/^[A-Za-z0-9_]{2,64}$/.test(sid)) {
    await releaseSendSlot(kv, claim.key);
    audit(logger, `[car-eta-text] failed job=${recipient.jobId} last4=${phoneLast4(recipient.phone)} minutes=${minutes}`);
    return refused('twilio_failed', "The text didn't go through. I didn't send it.");
  }

  audit(
    logger,
    `[car-eta-text] sent job=${recipient.jobId} last4=${phoneLast4(recipient.phone)} minutes=${minutes} sid=${sid}`,
  );
  return {
    tool: TEXT_NEXT_CUSTOMER_ETA,
    sent: true,
    reason: 'sent',
    text,
    first_name: recipient.firstName,
    job_time: recipient.jobTime,
    city: recipient.city,
    phone_last4: phoneLast4(recipient.phone),
    minutes,
    twilio_sid: sid,
    spoken: `Sent. I texted ${recipient.firstName} that I'm about ${minutes} minutes away.`,
  };
}

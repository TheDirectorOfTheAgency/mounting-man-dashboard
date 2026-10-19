// Urgent alerts for Q. Routine events stay in the logs.
// AgentMail is used when an API key and inbox id are present. Otherwise POST
// Q_ALERT_WEBHOOK_URL (Authorization from Q_ALERT_WEBHOOK_AUTH). Unset is a no-op.

export const Q_ALERT_EMAIL = 'agency-q@agentmail.to';
export const Q_ALERT_SUBJECT_PREFIX = '[Dashboard alert]';

const URGENT_KINDS = new Set([
  'unassigned_job_soon',
  'square_payment_failed',
  'offline_conversions_failed',
  'webhook_unhandled_error',
]);

const AGENTMAIL_KEY_ENVS = ['AGENTMAIL_API_KEY', 'AGENTMAIL_API_TOKEN', 'AGENTMAIL_TOKEN'];
const AGENTMAIL_INBOX_ENVS = ['AGENTMAIL_INBOX_ID', 'AGENTMAIL_INBOX'];

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

// Square customer IDs are opaque and often 26 characters, under the generic
// 32-character secret rule. Location ids stay when the message names the location.
export function redactSquareCustomerIds(value) {
  return String(value ?? '')
    .replace(/\/v2\/customers\/[A-Za-z0-9_-]+/gi, '/v2/customers/[customer]')
    .replace(/(?<!location )\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,31}\b/g, '[customer]')
    .replace(/(?<!location )\b[A-Za-z0-9]{26}\b/g, '[customer]');
}

// Alert bodies leave the system (email/webhook). Error messages from upstream
// libraries can echo request data, so redact anything shaped like contact data
// or a secret and cap the length.
export function redactAlertText(value) {
  let text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return '';
  text = text
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[number]' : m))
    .replace(/([?&](?:secret|token|key|auth|password|sig)[^=]*=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]');
  return redactSquareCustomerIds(text);
}

export function sanitizeAlertText(value, fallback = 'Unhandled error') {
  const text = redactAlertText(value);
  if (!text) return fallback;
  return text.slice(0, 300);
}

export function alertBodyForError(error, fallback = 'Unhandled error') {
  const name = String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'Error';
  const message = sanitizeAlertText(error?.message, '');
  return message ? `${name}: ${message}` : `${name}: ${fallback}`;
}

export function isUrgentAlert(kind) {
  return URGENT_KINDS.has(kind);
}

export function alertSubject(subject) {
  const text = String(subject || 'Dashboard alert').trim();
  if (text.startsWith(Q_ALERT_SUBJECT_PREFIX)) return text;
  return `${Q_ALERT_SUBJECT_PREFIX} ${text}`;
}

export function offlineConversionFailureAlert(summary, { validateOnly = false, thrown = null } = {}) {
  if (validateOnly) return null;
  if (thrown) {
    return {
      kind: 'offline_conversions_failed',
      subject: 'Offline conversions cron failed',
      body: sanitizeAlertText(thrown.message || thrown, 'Offline conversions cron failed'),
    };
  }
  const errors = Array.isArray(summary?.errors) ? summary.errors : [];
  const locationErrors = Array.isArray(summary?.locationErrors) ? summary.locationErrors : [];
  if (errors.length === 0 && locationErrors.length === 0 && !summary?.stoppedEarly) return null;
  const lines = [];
  for (const failure of locationErrors) {
    const text = String(failure?.error || '').trim();
    lines.push(text || `Square payments fetch failed for location ${failure?.locationId || 'unknown'}`);
  }
  for (const error of errors) {
    const text = String(error?.error || '').trim();
    const order = error?.orderId ? ` for order ${error.orderId}` : '';
    if (text.startsWith('Google Ads upload failed')) lines.push(text);
    else if (text.startsWith('Square customer fetch failed')) lines.push(`${text}${order}`);
    else lines.push(`Google Ads upload failed${order}: ${text || 'upload_failed'}`);
  }
  if (lines.length === 0) lines.push('Google Ads upload failed');
  return {
    kind: 'offline_conversions_failed',
    subject: 'Offline conversions cron failed',
    body: lines.map((line) => sanitizeAlertText(line, 'Offline conversions upload failed')).join(' '),
  };
}

async function postJson(fetchImpl, url, { headers, body }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return response;
}

async function sendAgentMail({ env, fetchImpl, subject, text }) {
  const apiKey = firstEnv(env, AGENTMAIL_KEY_ENVS);
  if (!apiKey) return null;
  const inboxId = firstEnv(env, AGENTMAIL_INBOX_ENVS);
  if (!inboxId) {
    console.warn('[q-alert] AgentMail key is set without AGENTMAIL_INBOX_ID');
    return { delivered: false, urgent: true, channel: 'agentmail', reason: 'agentmail_inbox_missing' };
  }
  const url = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages`;
  const response = await postJson(fetchImpl, url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      to: [Q_ALERT_EMAIL],
      subject,
      text,
    },
  });
  if (!response?.ok) {
    console.error('[q-alert] AgentMail delivery failed', response?.status || 0);
    return { delivered: false, urgent: true, channel: 'agentmail', reason: 'delivery_failed', status: response?.status || null };
  }
  return { delivered: true, urgent: true, channel: 'agentmail', reason: null };
}

export async function deliverQAlert({
  kind,
  subject,
  body,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fullSubject = alertSubject(subject);
  const text = redactAlertText(body).slice(0, 4000);
  if (!isUrgentAlert(kind)) {
    console.log('[q-alert] routine', { kind: kind || null, subject: fullSubject });
    return { delivered: false, urgent: false, channel: null, reason: 'routine' };
  }

  let agentMail = null;
  try {
    agentMail = await sendAgentMail({ env, fetchImpl, subject: fullSubject, text });
  } catch (error) {
    console.error('[q-alert] AgentMail delivery error', error.message);
    agentMail = { delivered: false, urgent: true, channel: 'agentmail', reason: 'delivery_failed' };
  }
  if (agentMail?.delivered) return agentMail;

  const url = String(env?.Q_ALERT_WEBHOOK_URL || '').trim();
  if (!url) {
    console.log('[q-alert] no delivery configured', { kind, subject: fullSubject });
    return {
      delivered: false,
      urgent: true,
      channel: null,
      reason: agentMail?.reason || 'not_configured',
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  const auth = String(env?.Q_ALERT_WEBHOOK_AUTH || '').trim();
  if (auth) headers.Authorization = auth;
  try {
    const response = await postJson(fetchImpl, url, {
      headers,
      body: { subject: fullSubject, text, kind, urgent: true },
    });
    if (!response?.ok) {
      console.error('[q-alert] webhook delivery failed', response?.status || 0);
      return { delivered: false, urgent: true, channel: 'webhook', reason: 'delivery_failed', status: response?.status || null };
    }
    return { delivered: true, urgent: true, channel: 'webhook', reason: null };
  } catch (error) {
    console.error('[q-alert] webhook delivery error', error.message);
    return { delivered: false, urgent: true, channel: 'webhook', reason: 'delivery_error' };
  }
}

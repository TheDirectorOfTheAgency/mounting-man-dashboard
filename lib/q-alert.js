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
      body: String(thrown.message || thrown),
    };
  }
  const errors = Array.isArray(summary?.errors) ? summary.errors : [];
  if (errors.length === 0 && !summary?.stoppedEarly) return null;
  return {
    kind: 'offline_conversions_failed',
    subject: 'Offline conversions cron failed',
    body: `Offline conversions cron failed (${errors.length} error${errors.length === 1 ? '' : 's'}).`,
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
  const text = String(body || '').slice(0, 4000);
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

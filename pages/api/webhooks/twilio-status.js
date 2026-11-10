// Twilio status callback for review-request SMS.
// Validates X-Twilio-Signature, records delivered/undelivered, and alerts on
// delivery failures (including 30034, 30007, and 21610). Does not send SMS.

import { kv } from '@vercel/kv';
import { deliverQAlert } from '../../../lib/q-alert.js';
import { createTwilioStatusHandler } from '../../../lib/review-sms.js';

const STATUS_TTL_SECONDS = 60 * 60 * 24 * 30;
const ALERT_TTL_SECONDS = 60 * 60 * 24 * 14;

function kvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function recordStatus(entry) {
  console.log('[review-sms-status]', {
    messageSid: entry.messageSid,
    messageStatus: entry.messageStatus,
    errorCode: entry.errorCode,
  });
  if (!kvConfigured()) return;
  try {
    await kv.set(`review-sms:status:${entry.messageSid}`, {
      messageSid: entry.messageSid,
      messageStatus: entry.messageStatus,
      errorCode: entry.errorCode,
      recordedAt: entry.recordedAt,
    }, { ex: STATUS_TTL_SECONDS });
  } catch (error) {
    console.warn('[review-sms-status] kv_record_failed', error?.name || 'Error');
  }
}

async function claimAlert(key) {
  if (!kvConfigured()) return true;
  const result = await kv.set(`review-sms:alert:${key}`, '1', { nx: true, ex: ALERT_TTL_SECONDS });
  return result === 'OK' || result === true;
}

const handler = createTwilioStatusHandler({
  alert: deliverQAlert,
  record: recordStatus,
  claimAlert,
});

export default handler;

export const config = {
  api: {
    bodyParser: false,
  },
};

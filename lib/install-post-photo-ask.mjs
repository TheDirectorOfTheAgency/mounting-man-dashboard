// Deterministic "add the install photo" ask to the operator.
//
// Payment time usually has no photo yet. Instead of waking the Woodward desk,
// send the signed operator upload link(s) straight to the operator over plain
// channels: a webhook (Pushcut / iOS Shortcut / ntfy relay / Zapier → SMS) and/or
// a Twilio SMS. No LLM on this path. The caller wakes Woodward only when no
// channel delivers.
//
// Link URLs carry the job capability in the fragment. They go to the operator
// channel only — never into logs or the returned status.

export const PHOTO_ASK_KIND = 'install_post_photo_ask';
export const PHOTO_ASK_DESK_ACTION = 'add_photo';
export const PHOTO_ASK_TITLE = 'Add install photo';

const TWILIO_DEFAULT_FROM = '+19526496388';
const SENDER_HEADER = 'x-webhook-secret';

let loggedMissingChannel = false;

export function resetPhotoAskMissingChannelLog() {
  loggedMissingChannel = false;
}

function safeLinks(links) {
  return (Array.isArray(links) ? links : [])
    .filter((link) => link && typeof link.url === 'string' && link.url.trim())
    .map((link) => ({ label: String(link.label || 'TV installation'), url: link.url.trim() }));
}

export function buildPhotoAskText(links = []) {
  const usable = safeLinks(links);
  if (!usable.length) return '';
  const heading = usable.length > 1
    ? `${PHOTO_ASK_TITLE} & publish — ${usable.length} TVs, one link each`
    : `${PHOTO_ASK_TITLE} & publish`;
  return [heading, ...usable.map((link) => `${link.label} → ${link.url}`)].join('\n');
}

/** `defaultAction.url` lets a Pushcut notification open the card on tap. */
export function buildPhotoAskWebhookPayload(links = []) {
  const usable = safeLinks(links);
  return {
    kind: PHOTO_ASK_KIND,
    deskAction: PHOTO_ASK_DESK_ACTION,
    title: PHOTO_ASK_TITLE,
    text: buildPhotoAskText(usable),
    url: usable[0]?.url || '',
    links: usable,
    defaultAction: { url: usable[0]?.url || '' },
  };
}

export function readPhotoAskConfig(env = process.env) {
  return {
    webhookUrl: String(env.INSTALL_POST_PHOTO_ASK_URL || '').trim(),
    webhookKey: String(env.INSTALL_POST_PHOTO_ASK_KEY || '').trim(),
    smsTo: String(env.INSTALL_POST_PHOTO_ASK_SMS_TO || '').trim(),
    twilioSid: String(env.TWILIO_ACCOUNT_SID || '').trim(),
    twilioToken: String(env.TWILIO_AUTH_TOKEN || '').trim(),
    twilioFrom: String(env.TWILIO_FROM_NUMBER || TWILIO_DEFAULT_FROM).trim(),
  };
}

export function photoAskChannelsConfigured(config = {}) {
  return {
    webhook: Boolean(config.webhookUrl),
    sms: Boolean(config.smsTo && config.twilioSid && config.twilioToken),
  };
}

export async function sendPhotoAskWebhook({ payload, url, key, httpClient, logger = console } = {}) {
  if (!url) return { skipped: 'missing_url' };
  const headers = { 'Content-Type': 'application/json' };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers[SENDER_HEADER] = key;
  }
  try {
    await httpClient.post(url, payload, { headers, timeout: 8000 });
    return { forwarded: true };
  } catch (err) {
    logger.warn?.('[install-post-photo-ask] webhook failed', {
      errorType: err?.name || 'Error',
      status: err?.response?.status,
    });
    return { forwarded: false, error: true };
  }
}

export async function sendPhotoAskSms({
  body,
  to,
  sid,
  token,
  from = TWILIO_DEFAULT_FROM,
  httpClient,
  logger = console,
} = {}) {
  if (!to) return { skipped: 'missing_to' };
  if (!sid || !token) return { skipped: 'missing_twilio' };
  try {
    await httpClient.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 8000,
      },
    );
    return { forwarded: true };
  } catch (err) {
    logger.warn?.('[install-post-photo-ask] sms failed', {
      errorType: err?.name || 'Error',
      status: err?.response?.status,
    });
    return { forwarded: false, error: true };
  }
}

/**
 * Send the photo ask over every configured channel. `delivered` is true when
 * at least one channel accepted it. Never throws.
 */
export async function deliverPhotoAsk({
  links = [],
  httpClient,
  config = readPhotoAskConfig(),
  logger = console,
} = {}) {
  const usable = safeLinks(links);
  if (!usable.length) {
    return { delivered: false, skipped: 'no_operator_links', linkCount: 0, channels: {} };
  }

  const configured = photoAskChannelsConfigured(config);
  if (!configured.webhook && !configured.sms) {
    if (!loggedMissingChannel) {
      loggedMissingChannel = true;
      logger.warn?.('[install-post-photo-ask] no channel configured (INSTALL_POST_PHOTO_ASK_URL or INSTALL_POST_PHOTO_ASK_SMS_TO + Twilio)');
    }
    return { delivered: false, skipped: 'no_channel', linkCount: usable.length, channels: {} };
  }

  if (!httpClient || typeof httpClient.post !== 'function') {
    return { delivered: false, skipped: 'missing_client', linkCount: usable.length, channels: {} };
  }

  const channels = {};
  if (configured.webhook) {
    channels.webhook = await sendPhotoAskWebhook({
      payload: buildPhotoAskWebhookPayload(usable),
      url: config.webhookUrl,
      key: config.webhookKey,
      httpClient,
      logger,
    });
  }
  if (configured.sms) {
    channels.sms = await sendPhotoAskSms({
      body: `Mounting Man — ${buildPhotoAskText(usable)}`,
      to: config.smsTo,
      sid: config.twilioSid,
      token: config.twilioToken,
      from: config.twilioFrom,
      httpClient,
      logger,
    });
  }

  const delivered = Object.values(channels).some((result) => result?.forwarded === true);
  if (delivered) {
    logger.info?.('[install-post-photo-ask] delivered', {
      linkCount: usable.length,
      channels: Object.keys(channels).filter((name) => channels[name]?.forwarded),
    });
  }
  return { delivered, linkCount: usable.length, channels };
}

import axios from 'axios';

import { runConversionSummaryKeyProbeOnce } from '../../../lib/conversion-summary-keys.js';
import { notifyQInstallPost } from '../../../lib/notify-install-post.mjs';

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VER = '2024-01-18';
const SQUARE_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

const squareHeaders = () => ({
  Authorization: `Bearer ${SQUARE_TOKEN}`,
  'Square-Version': SQUARE_VER,
  'Content-Type': 'application/json',
});

export const PAGE_LIMIT = 100;
export const MAX_PAGES = 10;

const errStatus = (error) => error?.response?.status || null;
const errName = (error) => error?.code || error?.name || 'Error';

/**
 * Discover every Square location. On any failure (scope, 429, 5xx, network) or an
 * empty result, fall back to the one configured location. Logs IDs/status only.
 */
export async function fetchLocationIds({ get = axios.get, configuredId = SQUARE_LOCATION_ID } = {}) {
  const fallback = [configuredId].filter(Boolean);
  try {
    const response = await get(`${SQUARE_BASE}/locations`, { headers: squareHeaders() });
    const ids = (response?.data?.locations || []).map((loc) => loc?.id).filter(Boolean);
    return ids.length ? ids : fallback;
  } catch (error) {
    console.error('SQUARE_LOCATIONS_DISCOVERY_FAILED', {
      status: errStatus(error),
      errorType: errName(error),
      fallbackLocationId: configuredId || null,
    });
    return fallback;
  }
}

export class NoSquareLocationsError extends Error {
  constructor() {
    super('No Square locations available');
    this.name = 'NoSquareLocationsError';
  }
}

export class SquarePaymentsUnavailableError extends Error {
  constructor() {
    super('Square payments unavailable');
    this.name = 'SquarePaymentsUnavailableError';
  }
}

/** Every location (active or not), every page, every tender type. */
export async function fetchRecentCompletedPayments({
  get = axios.get,
  locationIds,
  configuredId = SQUARE_LOCATION_ID,
} = {}) {
  const begin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ids = locationIds || (await fetchLocationIds({ get, configuredId }));
  if (!ids.length) throw new NoSquareLocationsError();
  const out = [];
  let locationsAttempted = 0;
  let locationsSucceeded = 0;
  for (const locationId of ids) {
    locationsAttempted += 1;
    try {
      let cursor = '';
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({ location_id: locationId, begin_time: begin, sort_order: 'DESC', limit: String(PAGE_LIMIT) });
        if (cursor) params.set('cursor', cursor);
        const response = await get(`${SQUARE_BASE}/payments?${params.toString()}`, { headers: squareHeaders() });
        out.push(...(response?.data?.payments || []));
        cursor = response?.data?.cursor || '';
        if (!cursor) break;
      }
      if (cursor) {
        console.warn('SQUARE_PAYMENTS_PAGE_CAP_HIT', { locationId, maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT });
      }
      locationsSucceeded += 1;
    } catch (error) {
      console.error('SQUARE_LOCATION_PAYMENTS_FAILED', {
        locationId,
        status: errStatus(error),
        errorType: errName(error),
      });
    }
  }
  if (locationsAttempted > 0 && locationsSucceeded === 0) {
    throw new SquarePaymentsUnavailableError();
  }
  return out.filter((payment) => payment?.status === 'COMPLETED');
}

/** Handler-level helper: never throws for "no locations" / total payments failure; returns an explicit error instead. */
export async function collectCronPayments(opts = {}) {
  try {
    return { ok: true, payments: await fetchRecentCompletedPayments(opts) };
  } catch (error) {
    if (error instanceof NoSquareLocationsError) {
      console.error('SQUARE_NO_LOCATIONS_AVAILABLE', {});
      return { ok: false, status: 503, error: error.message };
    }
    if (error instanceof SquarePaymentsUnavailableError) {
      console.error('SQUARE_PAYMENTS_TOTAL_FAILURE', {});
      return { ok: false, status: 503, error: error.message };
    }
    throw error;
  }
}

async function fetchCustomer(customerId) {
  const response = await axios.get(`${SQUARE_BASE}/customers/${customerId}`, {
    headers: squareHeaders(),
  });
  return response.data?.customer || {};
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const vercelCronHeader = req.headers['x-vercel-cron'];
  const cronSecret = process.env.CRON_SECRET || '';
  const authorizedByBearer = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const authorizedByVercelCron = Boolean(vercelCronHeader);

  if (!authorizedByBearer && !authorizedByVercelCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await runConversionSummaryKeyProbeOnce();
  } catch (error) {
    console.error('ZB_CONV_SUMMARY_KEYS_FETCH_FAILED', {
      errorType: error?.name || 'Error',
    });
  }

  if (!SQUARE_TOKEN) {
    return res.status(400).json({ error: 'Missing Square credentials' });
  }

  try {
    const collected = await collectCronPayments();
    if (!collected.ok) {
      return res.status(collected.status).json({ ok: false, error: collected.error });
    }
    const payments = collected.payments;
    const results = [];

    for (const payment of payments) {
      if (!payment?.id || !payment?.customer_id) continue;
      try {
        const customer = await fetchCustomer(payment.customer_id);
        const amountCents = payment.amount_money?.amount || payment.total_money?.amount || 0;
        const result = await notifyQInstallPost({
          orderId: payment.order_id || '',
          payment,
          invoice: {},
          isInvoiceEvent: false,
          eventType: 'cron.square.completed',
          firstName: customer.given_name || 'there',
          lastName: customer.family_name || '',
          customer,
          amount: (amountCents / 100).toFixed(2),
          amountCents,
          triggerStatus: 'Square webhook failed; Vercel fallback succeeded',
          triggerSourceCode: 'vercel-cron-fallback',
        });
        results.push({
          skipped: result?.skipped || null,
          key: result?.key || '',
          paymentId: payment.id,
          orderId: payment.order_id || '',
          photoAsk: result?.photoAsk || null,
          woodward: result?.woodward || null,
        });
      } catch (err) {
        results.push({
          posted: false,
          paymentId: payment.id,
          error: err.response?.data || err.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: payments.length,
      results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[square-install-post-seed] Unhandled error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

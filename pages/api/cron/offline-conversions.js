// Daily upload of paid, completed US jobs to Google Ads conversion action
// 7509313857. Schedule: 14:20 UTC (9:20 AM CT during daylight time).
// LEDGER-2026-10-04-CONVERSION-TRACKING
//
// Dry run: Authorization: Bearer $CRON_SECRET and ?validateOnly=1
// The Zenbooker job.completed hook is unchanged.

import axios from 'axios';

import { postDiscordOperationsMessage } from '../../../lib/discord-ops.js';
import {
  CHANGE_RECORD,
  LOOKBACK_MS,
  conversionIdentifierCounts,
  createDailyGoogleUpload,
  createDailyUploadLedger,
  debugOrderIdFromQuery,
  fetchCompletedSquarePayments,
  fetchSquareCustomers,
  formatDiscordSummary,
  runDailyOfflineConversions,
  squareCredentials,
} from '../../../lib/daily-offline-conversions.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  return Boolean(cronSecret) && req.headers.authorization === `Bearer ${cronSecret}`;
}

function validateOnlyRequested(req) {
  const value = String(req.query?.validateOnly || req.query?.dryRun || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function loadLedgerAndStore() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { kv } = await import('@vercel/kv');
  return {
    ledger: createDailyUploadLedger(kv),
    store: createAttributionStore(kv),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const validateOnly = validateOnlyRequested(req);
  const debugOrderId = debugOrderIdFromQuery(req.query || {});
  const { token, locationId } = squareCredentials();
  if (!token || !locationId) {
    return res.status(500).json({ error: 'Missing Square credentials' });
  }

  let kvBindings = null;
  try {
    kvBindings = await loadLedgerAndStore();
  } catch (error) {
    console.error('daily_offline_conversion_ledger_error', { message: error.message });
  }
  if (!validateOnly && !kvBindings?.ledger) {
    return res.status(500).json({
      error: 'Upload ledger is required',
      changeRecord: CHANGE_RECORD,
    });
  }

  try {
    const beginTime = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const payments = await fetchCompletedSquarePayments({
      token,
      locationId,
      beginTime,
      httpClient: axios,
    });
    const customerIds = [...new Set(payments.map((payment) => payment.customer_id).filter(Boolean))];
    const customersById = await fetchSquareCustomers(customerIds, { token, httpClient: axios });
    const summary = await runDailyOfflineConversions({
      payments,
      customersById,
      store: kvBindings?.store || null,
      ledger: kvBindings?.ledger || null,
      validateOnly,
      debugOrderId,
      uploadConversion: createDailyGoogleUpload(process.env, axios),
    });
    const counts = conversionIdentifierCounts(summary.orders);
    const compactSummary = {
      changeRecord: summary.changeRecord,
      conversionActionId: summary.conversionActionId,
      validateOnly: summary.validateOnly,
      uploadedCount: summary.uploadedCount,
      totalValue: summary.totalValue,
      gclidCount: summary.gclidCount ?? counts.gclidCount,
      gbraidCount: summary.gbraidCount ?? counts.gbraidCount,
      piiOnlyCount: summary.piiOnlyCount ?? counts.piiOnlyCount,
      skippedCount: summary.skipped.length,
      rejectedCount: summary.rejected.length,
      errors: summary.errors,
      stoppedEarly: Boolean(summary.stoppedEarly),
    };
    const publicSummary = {
      ...compactSummary,
      currency: summary.currency,
      orders: summary.orders,
    };
    console.log('daily_offline_conversion_summary', compactSummary);
    console.log('daily_offline_conversion_orders', summary.orders);
    const discord = await postDiscordOperationsMessage(formatDiscordSummary(publicSummary));
    if (!discord.ok && !discord.skipped) {
      console.error('[discord-error]', discord.envName, discord.error);
    }
    return res.status(200).json({ ...publicSummary, discordNotified: discord.ok === true });
  } catch (error) {
    console.error('daily_offline_conversion_failed', { message: error.message });
    return res.status(500).json({
      error: error.message || 'Daily offline conversion upload failed',
      changeRecord: CHANGE_RECORD,
    });
  }
}

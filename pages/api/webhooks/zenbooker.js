// pages/api/webhooks/zenbooker.js
// Receives Zenbooker job.completed webhooks and uploads offline conversions to Google Ads
//
// Flow: Zenbooker job.completed → this endpoint → hash PII → Google Ads Enhanced Conversions
// Deduplication via Vercel KV (Upstash Redis)
//
// Zenbooker webhook docs are sparse — field names below are best-guess based on common patterns.
// The handler logs the FULL raw payload on every request so we can verify/adjust field paths.
// If field names don't match, update the FIELD_MAP config below.

import { uploadOfflineConversion } from '../../../lib/google-ads-conversions.js';

// Lazy KV import — returns null if Vercel KV is not configured
let _kv = null;
async function getKV() {
  if (_kv !== null) return _kv;
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      console.warn('Vercel KV not configured (missing KV_REST_API_URL or KV_REST_API_TOKEN)');
      _kv = false;
      return false;
    }
    const mod = await import('@vercel/kv');
    _kv = mod.kv;
    return _kv;
  } catch (err) {
    console.warn('Failed to load @vercel/kv:', err.message);
    _kv = false;
    return false;
  }
}

// ============================================================================
// FIELD MAPPING CONFIG
// Adjust these paths if the actual Zenbooker payload uses different field names.
// Supports dot notation for nested fields (e.g., "data.customer.email").
// ============================================================================
const FIELD_MAP = {
  // The webhook event type field
  eventType: 'type',

  // Unique job identifier (for deduplication)
  jobId: ['data.job.id', 'data.id', 'data.job_id'],

  // Customer contact info
  customerEmail: ['data.customer.email', 'data.job.customer.email', 'data.customer_email'],
  customerPhone: ['data.customer.phone', 'data.job.customer.phone', 'data.customer_phone'],
  customerName: ['data.customer.name', 'data.job.customer.name', 'data.customer_name'],
  customerFirstName: ['data.customer.first_name', 'data.job.customer.first_name'],
  customerLastName: ['data.customer.last_name', 'data.job.customer.last_name'],

  // Job/invoice amount
  invoiceAmount: [
    'data.invoice.total',
    'data.job.invoice.total',
    'data.total_amount',
    'data.job.total',
    'data.amount',
  ],

  // Completion timestamp
  completedAt: ['data.completed_at', 'data.job.completed_at', 'data.job.end_time', 'created_at'],
};

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Safely get a nested value from an object using dot notation.
 * e.g., getNestedValue(obj, "data.customer.email")
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Try multiple field paths, return the first non-null/undefined value.
 */
function resolveField(payload, fieldPaths) {
  if (typeof fieldPaths === 'string') {
    return getNestedValue(payload, fieldPaths);
  }
  for (const path of fieldPaths) {
    const value = getNestedValue(payload, path);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * Split a full name into first and last name.
 * "John Doe" → { firstName: "John", lastName: "Doe" }
 * "John" → { firstName: "John", lastName: null }
 */
function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

/**
 * Parse an amount that might be a string, number, or cents value.
 */
function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]/g, '')) : Number(value);
  if (isNaN(num)) return null;
  // If the number is very large (>10000), assume it's in cents
  return num > 10000 ? num / 100 : num;
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate webhook secret
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  const expectedSecret = process.env.ZENBOOKER_WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error('ZENBOOKER_WEBHOOK_SECRET env var not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (secret !== expectedSecret) {
    console.warn('Webhook auth failed — invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;

  // ALWAYS log the full raw payload for debugging and field discovery
  console.log('=== ZENBOOKER WEBHOOK RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Payload:', JSON.stringify(payload, null, 2));

  try {
    // Check event type
    const eventType = resolveField(payload, FIELD_MAP.eventType);
    if (eventType && eventType !== 'job.completed') {
      console.log(`Skipping event type: ${eventType}`);
      return res.status(200).json({ skipped: true, reason: `Event type "${eventType}" is not job.completed` });
    }

    // Extract job ID for deduplication
    const jobId = resolveField(payload, FIELD_MAP.jobId);
    if (!jobId) {
      console.warn('No job ID found in payload — processing anyway but cannot deduplicate');
    }

    // Check deduplication via Vercel KV
    const kvClient = await getKV();
    if (jobId && kvClient) {
      const kvKey = `conv:${jobId}`;
      try {
        const existing = await kvClient.get(kvKey);
        if (existing) {
          console.log(`Job ${jobId} already processed — skipping (dedup)`);
          return res.status(200).json({ skipped: true, reason: 'Already processed', jobId });
        }
      } catch (kvErr) {
        console.warn('Vercel KV check failed:', kvErr.message);
      }
    }

    // Extract customer info
    const email = resolveField(payload, FIELD_MAP.customerEmail);
    const phone = resolveField(payload, FIELD_MAP.customerPhone);
    let firstName = resolveField(payload, FIELD_MAP.customerFirstName);
    let lastName = resolveField(payload, FIELD_MAP.customerLastName);

    // If no first/last name but we have a full name, split it
    if (!firstName && !lastName) {
      const fullName = resolveField(payload, FIELD_MAP.customerName);
      const split = splitName(fullName);
      firstName = split.firstName;
      lastName = split.lastName;
    }

    // Extract amount and timestamp
    const rawAmount = resolveField(payload, FIELD_MAP.invoiceAmount);
    const conversionValue = parseAmount(rawAmount);
    const completedAt = resolveField(payload, FIELD_MAP.completedAt) || new Date().toISOString();

    console.log('Extracted fields:', {
      jobId,
      email: email ? `${email.substring(0, 3)}***` : null,
      phone: phone ? `***${phone.slice(-4)}` : null,
      firstName: firstName ? `${firstName.charAt(0)}***` : null,
      lastName: lastName ? `${lastName.charAt(0)}***` : null,
      conversionValue,
      completedAt,
    });

    // Verify we have at least one identifier
    if (!email && !phone) {
      console.warn('No email or phone found — cannot upload conversion (need at least one identifier)');
      return res.status(200).json({
        skipped: true,
        reason: 'No customer email or phone in payload',
        jobId,
      });
    }

    // Upload to Google Ads
    const result = await uploadOfflineConversion({
      email,
      phone,
      firstName,
      lastName,
      conversionValue: conversionValue || 300,
      conversionDateTime: completedAt,
      orderId: jobId ? `zen_${jobId}` : `zen_${Date.now()}`,
    });

    console.log('Google Ads upload result:', JSON.stringify(result));

    // Store result in Vercel KV for deduplication and audit
    if (jobId && kvClient) {
      try {
        const kvKey = `conv:${jobId}`;
        await kvClient.set(
          kvKey,
          {
            jobId,
            uploadedAt: new Date().toISOString(),
            success: result.success,
            conversionValue: conversionValue || 300,
            error: result.error || null,
          },
          { ex: 7776000 } // 90 days TTL
        );

        // Update monthly stats
        const now = new Date();
        const statsKey = `conv:stats:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        try {
          const stats = (await kvClient.get(statsKey)) || { total: 0, success: 0, failed: 0 };
          stats.total += 1;
          if (result.success) stats.success += 1;
          else stats.failed += 1;
          await kvClient.set(statsKey, stats, { ex: 31536000 }); // 365 days TTL
        } catch (statsErr) {
          console.warn('Failed to update stats:', statsErr.message);
        }
      } catch (kvErr) {
        console.warn('Failed to store in KV:', kvErr.message);
      }
    }

    // Always return 200 to Zenbooker (even on upload failure)
    // This prevents retry storms for permanent errors
    return res.status(200).json({
      processed: true,
      jobId,
      uploadSuccess: result.success,
      error: result.error || null,
    });
  } catch (error) {
    console.error('Webhook processing error:', error.message, error.stack);

    // Still return 200 to prevent Zenbooker retries
    return res.status(200).json({
      processed: false,
      error: error.message,
    });
  }
}

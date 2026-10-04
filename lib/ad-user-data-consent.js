/**
 * LEDGER-2026-10-04-CONVERSION-TRACKING
 * Approved by Mr. Wayne on Oct 4, 2026, 3:16 PM CT.
 *
 * Paid jobs in the United States upload with ad_user_data = GRANTED.
 * The basis is the themountingman.com privacy policy line that booking and
 * payment information may be shared with advertising platforms such as Google
 * to measure ad performance.
 *
 * ad_personalization is intentionally unset. uploadClickConversions does not
 * require it, and this record does not grant personalization.
 *
 * An explicit DENIED answer still blocks the upload. The Zenbooker
 * job.completed hook stays in place and still records the consent it captured;
 * this function is the only place the approved US paid-job grant is decided.
 */

const US_COUNTRY_CODES = new Set(['US', 'USA', 'UNITED STATES']);

function normalizedCountry(countryCode) {
  if (countryCode === undefined || countryCode === null) return 'US';
  const normalized = String(countryCode).trim().toUpperCase();
  return normalized || 'US';
}

export function resolveAdUserDataConsent({
  countryCode = 'US',
  paid = false,
  explicitStatus = null,
} = {}) {
  const explicit = String(explicitStatus || '').trim().toUpperCase();
  if (explicit === 'DENIED') return 'DENIED';
  if (paid && US_COUNTRY_CODES.has(normalizedCountry(countryCode))) return 'GRANTED';
  if (explicit === 'GRANTED') return 'GRANTED';
  return null;
}

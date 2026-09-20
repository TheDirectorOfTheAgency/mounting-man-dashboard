// Deterministic install-post auto-publish confidence gate.
//
// Square+photo still uses the existing cloud dispatcher. This module only
// answers: is the staged city/street/size safe to auto-publish without a
// human? HOLD reason codes are for the desk — never customer PII.

import { isMetroFillerCity } from './install-post-seeds.mjs';

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_CONFIDENCE_MIN = 0.7;
export const JEV_NOUL_QUESTION = 'safe to auto-publish without human';

export const HOLD_REASONS = Object.freeze({
  BLANK_CITY: 'blank_city',
  METRO_PLACEHOLDER_CITY: 'metro_placeholder_city',
  GOOGLE_BLOB_STREET: 'google_blob_street',
  SEED_COUNT: 'seed_count',
  JEV_HOLD: 'jev_hold',
});

const METRO_PLACEHOLDER_RE = /^(?:the\s+)?(?:metro\s+)?twin\s*cities(?:\s+metro)?$|^metro(?:\s+(?:area|twin\s*cities))?$|^msp$|^minneapolis[\s–—-]+(?:st\.?\s*paul|saint\s+paul)$/i;

function trimText(value) {
  return value == null ? '' : String(value).trim();
}

export function isMetroPlaceholderCity(city) {
  const value = trimText(city);
  if (!value) return false;
  if (isMetroFillerCity(value)) return true;
  return METRO_PLACEHOLDER_RE.test(value.replace(/[–—]/g, '-'));
}

/** Google-style leftover: comma+ZIP, `, USA`, or the city repeated in street. */
export function isGoogleBlobStreet(streetName, city) {
  const street = trimText(streetName);
  if (!street) return false;
  const hasComma = street.includes(',');
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(street);
  if (hasComma && hasZip) return true;
  if (/,\s*USA\b/i.test(street) || /,\s*United States\b/i.test(street)) return true;
  const cityValue = trimText(city);
  if (cityValue && street.toLowerCase().includes(cityValue.toLowerCase())) return true;
  return false;
}

export function confidenceFactsFromSeed(seed = {}) {
  return {
    city: trimText(seed.city),
    streetName: trimText(seed['street-name'] || seed.streetName),
    seedCount: Number(seed['seed-count'] ?? seed.seedCount ?? 1) || 1,
    tvSize: trimText(seed['tv-size'] || seed.tvSize),
  };
}

export function confidenceFactsFromRecord(record = {}) {
  return confidenceFactsFromSeed(record.seed || {});
}

/**
 * Pure pass/hold from staged facts. No I/O, no PII in reasons.
 *
 * @param {{ city?: string, streetName?: string, seedCount?: number }} facts
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function evaluateInstallPostConfidence({ city, streetName, seedCount, ...rest } = {}) {
  void rest;
  const reasons = [];
  const cityValue = trimText(city);
  if (!cityValue) reasons.push(HOLD_REASONS.BLANK_CITY);
  else if (isMetroPlaceholderCity(cityValue)) reasons.push(HOLD_REASONS.METRO_PLACEHOLDER_CITY);
  if (isGoogleBlobStreet(streetName, cityValue)) reasons.push(HOLD_REASONS.GOOGLE_BLOB_STREET);
  if (Number(seedCount) > 1) reasons.push(HOLD_REASONS.SEED_COUNT);
  return { pass: reasons.length === 0, reasons };
}

function noulIsFalse(noul) {
  return noul === false || noul === 0 || noul === 'false';
}

function noulPasses(noul) {
  if (noul === true) return true;
  if (typeof noul === 'number') return noul >= JEV_CONFIDENCE_MIN;
  return false;
}

/**
 * Optional TypeSafe Jev gate. Fail open on any API/parse error so a Jev
 * outage never blocks a deterministic PASS. Never log the API key.
 */
export async function evaluateJevInstallPostConfidence({
  city,
  streetName,
  tvSize,
  apiKey,
  httpClient,
  logger = console,
} = {}) {
  const key = trimText(apiKey);
  if (!key) return { pass: true, skipped: 'missing_key', reasons: [] };
  if (!httpClient || typeof httpClient.post !== 'function') {
    return { pass: true, skipped: 'missing_client', reasons: [] };
  }

  try {
    const response = await httpClient.post(
      TYPESAFE_SYSTEM_ONE_URL,
      {
        model: JEV_MODEL,
        state: {
          city: trimText(city),
          streetName: trimText(streetName),
          tvSize: trimText(tvSize),
        },
        questions: {
          safe_to_auto_publish: {
            type: 'noul',
            instructions: JEV_NOUL_QUESTION,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      },
    );

    const answer = response?.data?.answers?.safe_to_auto_publish
      || response?.data?.safe_to_auto_publish
      || {};
    const noul = answer.noul;
    const confidence = answer.confidence;
    const confidenceHold = typeof confidence === 'number' && confidence < JEV_CONFIDENCE_MIN;
    if (noulIsFalse(noul) || !noulPasses(noul) || confidenceHold) {
      return { pass: false, reasons: [HOLD_REASONS.JEV_HOLD] };
    }
    return { pass: true, reasons: [] };
  } catch (err) {
    logger.warn?.('[install-post-confidence] TypeSafe Jev failed open', {
      errorType: err?.name || 'Error',
      status: err?.response?.status,
    });
    return { pass: true, skipped: 'api_error', reasons: [] };
  }
}

/** Deterministic rules first; optional Jev only after PASS. */
export async function resolveInstallPostConfidence(facts = {}, options = {}) {
  const deterministic = evaluateInstallPostConfidence(facts);
  if (!deterministic.pass) return deterministic;
  const jev = await evaluateJevInstallPostConfidence({ ...facts, ...options });
  if (!jev.pass) {
    return { pass: false, reasons: [...deterministic.reasons, ...jev.reasons] };
  }
  return { ...deterministic, jevSkipped: jev.skipped || null };
}

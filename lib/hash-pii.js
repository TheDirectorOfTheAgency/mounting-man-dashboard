// lib/hash-pii.js
// PII normalization and SHA-256 hashing for Google Ads Enhanced Conversions for Leads
// See: https://developers.google.com/google-ads/api/docs/conversions/upload-identifiers

import crypto from 'crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
/**
 * Normalize and hash an email address per Google's requirements:
 * 1. Trim whitespace
 * 2. Lowercase
 * 3. For Gmail/Googlemail: remove dots from local part
 * 4. Remove +suffix from local part
 */
export function hashEmail(email) {
  if (!email) return null;

  let normalized = email.trim().toLowerCase();

  const [localPart, domain] = normalized.split('@');
  if (!localPart || !domain) return null;

  let cleanLocal = localPart;

  // Remove +suffix (e.g., user+tag@gmail.com → user@gmail.com)
  const plusIndex = cleanLocal.indexOf('+');
  if (plusIndex > -1) {
    cleanLocal = cleanLocal.substring(0, plusIndex);
  }

  // For Gmail/Googlemail: remove dots from local part
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    cleanLocal = cleanLocal.replace(/\./g, '');
  }

  normalized = `${cleanLocal}@${domain}`;
  return sha256(normalized);
}

/**
 * Normalize and hash a phone number per Google's requirements:
 * 1. Strip non-digit characters (except leading +)
 * 2. Ensure E.164 format (+1XXXXXXXXXX for US)
 */
/**
 * US E.164 (+1 and 10 digits). Returns null when the value cannot be normalized.
 */
export function normalizePhoneE164(phone) {
  if (!phone) return null;

  let normalized = String(phone).trim();
  const hasPlus = normalized.startsWith('+');
  normalized = normalized.replace(/[^\d]/g, '');

  if (!hasPlus && normalized.length === 10) {
    normalized = `1${normalized}`;
  }

  normalized = `+${normalized}`;
  if (!/^\+1\d{10}$/.test(normalized)) return null;
  return normalized;
}

export function hashPhone(phone) {
  const normalized = normalizePhoneE164(phone);
  if (!normalized) {
    if (phone) console.warn('Phone number could not be normalized to a standard US E.164 value');
    return null;
  }
  return sha256(normalized);
}

/**
 * Normalize and hash a name (first or last) per Google's requirements:
 * 1. Trim whitespace
 * 2. Lowercase
 */
export function hashName(name) {
  if (!name) return null;

  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  return sha256(normalized);
}

/**
 * Build the userIdentifiers array for Google Ads Enhanced Conversions.
 * ConversionUploadService accepts hashed email and hashed phone only.
 */
export function buildUserIdentifiers({ email, phone }) {
  const identifiers = [];

  const hashedEmail = hashEmail(email);
  if (hashedEmail) {
    identifiers.push({
      userIdentifierSource: 'FIRST_PARTY',
      hashedEmail: hashedEmail,
    });
  }

  const hashedPhone = hashPhone(phone);
  if (hashedPhone) {
    identifiers.push({
      userIdentifierSource: 'FIRST_PARTY',
      hashedPhoneNumber: hashedPhone,
    });
  }

  return identifiers;
}

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
export function hashPhone(phone) {
  if (!phone) return null;

  let normalized = phone.trim();

  // Preserve leading +, strip everything else that's not a digit
  const hasPlus = normalized.startsWith('+');
  normalized = normalized.replace(/[^\d]/g, '');

  // If no country code was provided, assume US (+1)
  if (!hasPlus && normalized.length === 10) {
    normalized = '1' + normalized;
  } else if (!hasPlus && normalized.length === 11 && normalized.startsWith('1')) {
    // Already has US country code without +
  }

  // Add + prefix for E.164
  normalized = '+' + normalized;

  // Validate: should be +1 followed by 10 digits for US
  if (!/^\+1\d{10}$/.test(normalized)) {
    console.warn(`Phone number "${phone}" doesn't look like a valid US E.164 number: ${normalized}`);
    // Still hash it — Google will attempt matching
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
 * Includes as many identifiers as available — more = higher match rate.
 */
export function buildUserIdentifiers({ email, phone, firstName, lastName }) {
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
      hashedPhoneNumber: hashedPhone,
    });
  }

  const hashedFirst = hashName(firstName);
  const hashedLast = hashName(lastName);
  if (hashedFirst || hashedLast) {
    const addressInfo = {};
    if (hashedFirst) addressInfo.hashedFirstName = hashedFirst;
    if (hashedLast) addressInfo.hashedLastName = hashedLast;
    identifiers.push({ addressInfo });
  }

  return identifiers;
}

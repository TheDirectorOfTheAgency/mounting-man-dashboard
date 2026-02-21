// lib/google-ads-conversions.js
// Upload offline conversions to Google Ads via Enhanced Conversions for Leads
// See: https://developers.google.com/google-ads/api/docs/conversions/upload-offline

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';
import { buildUserIdentifiers } from './hash-pii.js';

const GOOGLE_ADS_API_VERSION = 'v20';
const CUSTOMER_ID = '1287907452';

/**
 * Upload a single offline conversion to Google Ads.
 *
 * CRITICAL: For WRITE operations, DO NOT include the login-customer-id header.
 * mntvmounting@gmail.com is the direct owner of account 1287907452 and has
 * full write access without going through the MCC.
 *
 * @param {Object} params
 * @param {string} params.email - Customer email (will be hashed)
 * @param {string} params.phone - Customer phone (will be hashed)
 * @param {string} params.firstName - Customer first name (will be hashed)
 * @param {string} params.lastName - Customer last name (will be hashed)
 * @param {number} params.conversionValue - Dollar amount of the job
 * @param {string} params.conversionDateTime - ISO timestamp of job completion
 * @param {string} params.orderId - Unique ID for deduplication (Zenbooker job ID)
 * @returns {Object} { success, response, error }
 */
export async function uploadOfflineConversion({
  email,
  phone,
  firstName,
  lastName,
  conversionValue,
  conversionDateTime,
  orderId,
}) {
  const conversionActionId = process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID;
  if (!conversionActionId) {
    throw new Error('Missing GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID env var');
  }

  const accessToken = await getAccessToken();
  const developerToken = getDeveloperToken();

  // Build hashed user identifiers
  const userIdentifiers = buildUserIdentifiers({ email, phone, firstName, lastName });

  if (userIdentifiers.length === 0) {
    throw new Error('No user identifiers available (need at least email or phone)');
  }

  // Format datetime for Google Ads: "yyyy-mm-dd HH:mm:ss+|-HH:mm"
  const dt = new Date(conversionDateTime);
  const tzOffset = -dt.getTimezoneOffset();
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const formattedDateTime = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}${tzSign}${tzHours}:${tzMins}`;

  const conversionPayload = {
    conversions: [
      {
        conversionAction: `customers/${CUSTOMER_ID}/conversionActions/${conversionActionId}`,
        conversionDateTime: formattedDateTime,
        conversionValue: conversionValue || 300, // Default $300 if no amount
        currencyCode: 'USD',
        orderId: orderId,
        consent: {
          adUserData: 'GRANTED',
        },
        userIdentifiers: userIdentifiers,
      },
    ],
    partialFailure: true,
  };

  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${CUSTOMER_ID}:uploadClickConversions`;

  try {
    const response = await axios.post(url, conversionPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'developer-token': developerToken,
        // NO login-customer-id header — direct owner write access
      },
    });

    // Check for partial failures
    const partialErrors = response.data?.partialFailureError;
    if (partialErrors) {
      console.warn('Partial failure in conversion upload:', JSON.stringify(partialErrors));
      return {
        success: false,
        response: response.data,
        error: partialErrors.message || 'Partial failure',
      };
    }

    return {
      success: true,
      response: response.data,
      error: null,
    };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    console.error('Google Ads conversion upload failed:', JSON.stringify(errorDetail));
    return {
      success: false,
      response: null,
      error: typeof errorDetail === 'string' ? errorDetail : JSON.stringify(errorDetail),
    };
  }
}

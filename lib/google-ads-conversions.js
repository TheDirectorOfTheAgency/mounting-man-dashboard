// Upload offline conversions to Google Ads via Enhanced Conversions for Leads.

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';
import { buildUserIdentifiers } from './hash-pii.js';

const DEFAULT_GOOGLE_ADS_API_VERSION = 'v24';
const CUSTOMER_ID = '1287907452';
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_GOOGLE_STATUSES = new Set([
  'DEADLINE_EXCEEDED',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
]);

export function formatConversionDateTime(value) {
  if (typeof value !== 'string') throw new Error('Conversion datetime must be an ISO string');
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || Number.isNaN(Date.parse(value))) throw new Error('Conversion datetime is invalid');
  return `${match[1]} ${match[2]}${match[3] === 'Z' ? '+00:00' : match[3]}`;
}
function extractGoogleStatus(value) {
  return value?.error?.status || value?.status || null;
}

function isRetryableFailure({ httpStatus, googleStatus, partialFailureError }) {
  if (RETRYABLE_HTTP_STATUSES.has(httpStatus) || RETRYABLE_GOOGLE_STATUSES.has(googleStatus)) return true;
  const serialized = JSON.stringify(partialFailureError || {});
  return [...RETRYABLE_GOOGLE_STATUSES].some((status) => serialized.includes(status));
}

function getGoogleRequestId(headers = {}) {
  return headers['request-id'] || headers['x-google-request-id'] || null;
}

export async function uploadOfflineConversion(
  {
    email,
    phone,
    firstName,
    lastName,
    conversionValue,
    conversionDateTime,
    orderId,
    consentStatus,
    validateOnly = false,
  },
  dependencies = {}
) {
  const conversionActionId = process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID;
  if (!conversionActionId) throw new Error('Missing GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID env var');
  if (!Number.isFinite(conversionValue) || conversionValue <= 0) {
    throw new Error('Conversion value must be a positive number');
  }

  const apiVersion = process.env.GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION;
  if (!/^v\d+(?:\.\d+)?$/.test(apiVersion)) throw new Error('Invalid Google Ads API version');

  const accessToken = await (dependencies.getAccessToken || getAccessToken)();
  const developerToken = (dependencies.getDeveloperToken || getDeveloperToken)();
  const httpClient = dependencies.httpClient || axios;
  const userIdentifiers = buildUserIdentifiers({ email, phone, firstName, lastName });
  if (userIdentifiers.length === 0) throw new Error('No user identifiers available');

  const conversion = {
    conversionAction: `customers/${CUSTOMER_ID}/conversionActions/${conversionActionId}`,
    conversionDateTime: formatConversionDateTime(conversionDateTime),
    conversionValue,
    currencyCode: 'USD',
    orderId,
    userIdentifiers,
  };
  if (consentStatus === 'GRANTED' || consentStatus === 'DENIED') {
    conversion.consent = { adUserData: consentStatus };
  }

  const conversionPayload = {
    conversions: [conversion],
    partialFailure: true,
    validateOnly: Boolean(validateOnly),
  };
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${CUSTOMER_ID}:uploadClickConversions`;

  try {
    const response = await httpClient.post(url, conversionPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'developer-token': developerToken,
      },
    });
    const partialFailureError = response.data?.partialFailureError || null;
    const googleRequestId = getGoogleRequestId(response.headers);
    if (partialFailureError) {
      const googleStatus = extractGoogleStatus(partialFailureError);
      return {
        success: false,
        retryable: isRetryableFailure({ googleStatus, partialFailureError }),
        errorCode: 'GOOGLE_PARTIAL_FAILURE',
        partialFailureError,
        googleRequestId,
        googleJobId: response.data?.jobId || null,
      };
    }
    return {
      success: true,
      validated: Boolean(validateOnly),
      retryable: false,
      errorCode: null,
      googleRequestId,
      googleJobId: response.data?.jobId || null,
    };
  } catch (error) {
    const httpStatus = error.response?.status || null;
    const googleStatus = extractGoogleStatus(error.response?.data);
    return {
      success: false,
      retryable: isRetryableFailure({ httpStatus, googleStatus }),
      errorCode: isRetryableFailure({ httpStatus, googleStatus })
        ? 'GOOGLE_TRANSIENT_FAILURE'
        : 'GOOGLE_REQUEST_FAILURE',
      httpStatus,
      googleStatus,
      googleRequestId: getGoogleRequestId(error.response?.headers),
    };
  }
}

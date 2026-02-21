// lib/google-ads-auth.js
// Shared Google Ads OAuth2 token refresh — used by both dashboard API route and conversion uploads

import axios from 'axios';

/**
 * Exchange the stored refresh token for a fresh access token.
 * Requires env vars: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
 */
export async function getAccessToken() {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth credentials (GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN)');
  }

  const response = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
  });

  return response.data.access_token;
}

/**
 * Get the developer token from env vars.
 */
export function getDeveloperToken() {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) {
    throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');
  }
  return token;
}

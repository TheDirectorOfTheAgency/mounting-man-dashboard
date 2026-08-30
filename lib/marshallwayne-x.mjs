// @MarshallWayne X recap tools. User tokens from X_MARSHALLWAYNE_* only.
// Never fall back to Mounting Man / other Twitter env vars.
import axios from 'axios';
import { signOAuth1HmacSha1 } from './x-oauth1.mjs';

export const VERIFY_MARSHALLWAYNE = 'verify_marshallwayne';
export const POST_MARSHALLWAYNE_RECAP = 'post_marshallwayne_recap';

export const MARSHALLWAYNE_SCREEN_NAME = 'MarshallWayne';
export const MARSHALLWAYNE_USER_ID = '1395241563509252099';

export const VERIFY_CREDENTIALS_URL = 'https://api.twitter.com/1.1/account/verify_credentials.json';
export const CREATE_TWEET_URL = 'https://api.twitter.com/2/tweets';

export const MARSHALLWAYNE_X_ENV_KEYS = [
  'X_MARSHALLWAYNE_API_KEY',
  'X_MARSHALLWAYNE_API_SECRET',
  'X_MARSHALLWAYNE_ACCESS_TOKEN',
  'X_MARSHALLWAYNE_ACCESS_TOKEN_SECRET',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readMarshallWayneXCredentials(env = process.env) {
  const missing = MARSHALLWAYNE_X_ENV_KEYS.filter((key) => !String(env?.[key] || '').trim());
  if (missing.length) {
    throw codedError(
      'x_unconfigured',
      `MarshallWayne X credentials missing: ${missing.join(', ')}. Set X_MARSHALLWAYNE_* only — do not use Mounting Man Twitter tokens.`,
    );
  }
  return {
    apiKey: String(env.X_MARSHALLWAYNE_API_KEY).trim(),
    apiSecret: String(env.X_MARSHALLWAYNE_API_SECRET).trim(),
    accessToken: String(env.X_MARSHALLWAYNE_ACCESS_TOKEN).trim(),
    accessTokenSecret: String(env.X_MARSHALLWAYNE_ACCESS_TOKEN_SECRET).trim(),
  };
}

export function twitterUserId(user) {
  if (user?.id_str != null && String(user.id_str).trim()) {
    return String(user.id_str).trim();
  }
  if (typeof user?.id === 'string' && user.id.trim()) {
    return user.id.trim();
  }
  if (typeof user?.id === 'number' && Number.isSafeInteger(user.id)) {
    return String(user.id);
  }
  return '';
}

export function assertMarshallWayneAccount(user) {
  const screenName = String(user?.screen_name || '').trim();
  const id = twitterUserId(user);
  if (screenName !== MARSHALLWAYNE_SCREEN_NAME || id !== MARSHALLWAYNE_USER_ID) {
    throw codedError(
      'wrong_account',
      `Refusing X action: verified account is @${screenName || 'unknown'} (id ${id || 'unknown'}), expected @${MARSHALLWAYNE_SCREEN_NAME} (id ${MARSHALLWAYNE_USER_ID}).`,
    );
  }
  return { screen_name: screenName, id };
}

export function recapTextOrThrow(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw codedError('empty_text', 'text is required and must not be empty or whitespace-only');
  }
  return text;
}

function xHttpError(error) {
  const status = error.response?.status;
  const data = error.response?.data;
  const detail = data?.detail
    || data?.title
    || data?.errors?.[0]?.message
    || data?.errors?.[0]?.detail
    || error.message;
  return codedError(
    'x_api_error',
    `X API request failed${status ? ` (${status})` : ''}: ${detail}`,
  );
}

export function createMarshallWayneXClient({
  env = process.env,
  httpClient = axios,
  oauth = {},
} = {}) {
  async function signedRequest({ method, url, data }) {
    const credentials = readMarshallWayneXCredentials(env);
    const { header } = signOAuth1HmacSha1({
      method,
      url,
      consumerKey: credentials.apiKey,
      consumerSecret: credentials.apiSecret,
      token: credentials.accessToken,
      tokenSecret: credentials.accessTokenSecret,
      nonce: oauth.nonce,
      timestamp: oauth.timestamp,
    });
    const headers = { Authorization: header };
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      return await httpClient.request({
        method,
        url,
        headers,
        ...(data !== undefined ? { data } : {}),
      });
    } catch (error) {
      throw xHttpError(error);
    }
  }

  async function verifyMarshallWayne() {
    const response = await signedRequest({
      method: 'GET',
      url: VERIFY_CREDENTIALS_URL,
    });
    const user = response?.data;
    return assertMarshallWayneAccount(user);
  }

  async function postMarshallWayneRecap(text) {
    const verbatim = recapTextOrThrow(text);
    await verifyMarshallWayne();
    const response = await signedRequest({
      method: 'POST',
      url: CREATE_TWEET_URL,
      data: { text: verbatim },
    });
    const id = String(response?.data?.data?.id || '').trim();
    if (!id) {
      throw codedError('x_api_error', 'X API request failed: tweet id missing from response');
    }
    return {
      permalink: `https://x.com/${MARSHALLWAYNE_SCREEN_NAME}/status/${id}`,
      id,
    };
  }

  return { verifyMarshallWayne, postMarshallWayneRecap };
}

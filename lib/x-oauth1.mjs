// OAuth 1.0a HMAC-SHA1 for X / Twitter user-context requests.
// JSON bodies are not signed — only the Authorization header params
// (plus any URL query / form params the caller passes in extraParams).
import crypto from 'crypto';

export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function collectParams(url, extraParams, oauthParams) {
  const urlObj = new URL(url);
  const params = { ...oauthParams };
  urlObj.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  Object.entries(extraParams || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params[key] = String(value);
  });
  return params;
}

function parameterString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

export function oauth1BaseUrl(url) {
  const urlObj = new URL(url);
  return `${urlObj.origin}${urlObj.pathname}`;
}

export function oauth1SignatureBaseString(method, url, params) {
  return [
    String(method || 'GET').toUpperCase(),
    percentEncode(oauth1BaseUrl(url)),
    percentEncode(parameterString(params)),
  ].join('&');
}

export function signOAuth1HmacSha1({
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  extraParams = {},
  nonce,
  timestamp,
}) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const params = collectParams(url, extraParams, oauthParams);
  const baseString = oauth1SignatureBaseString(method, url, params);
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;
  const header = `OAuth ${Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ')}`;
  return { header, signature, oauthParams, baseString };
}

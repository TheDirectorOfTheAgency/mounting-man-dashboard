// Minimal single-tenant OAuth 2.1 + PKCE (S256) for Grok Custom Connectors.
// Authorization codes are HMAC-signed blobs — no durable store on Vercel.
// access_token is the existing operator secret so ads-apply auth is unchanged.

import crypto from 'crypto';

import {
  MCP_ADS_APPLY_RESOURCE,
  MCP_PUBLIC_ORIGIN,
  acceptedOperatorSecrets,
  headerValue,
  timingSafeEqualString,
} from './mcp-http.mjs';

export const MCP_OAUTH_CLIENT_ID = 'mounting-man-ads-apply';
export const MCP_OAUTH_SCOPE = 'mcp';
export const MCP_OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN = 31536000;
export const MCP_OAUTH_AUTHORIZE_PATH = '/api/mcp/auth/authorize';
export const MCP_OAUTH_TOKEN_PATH = '/api/mcp/auth/token';
export const MCP_OAUTH_REGISTER_PATH = '/api/mcp/auth/register';

const ALLOWED_REDIRECT_HOSTS = new Set(['grok.com', 'grok.x.ai', 'x.ai', 'localhost', '127.0.0.1', '[::1]']);
const CODE_VERSION = 'mmoac1';

export function signingSecret(env = process.env) {
  return acceptedOperatorSecrets(env)[0] || '';
}

export function issuedAccessToken(env = process.env) {
  return signingSecret(env);
}

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function pkceS256Challenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
}

export function isAllowedRedirectUri(uri) {
  let url;
  try {
    url = new URL(String(uri || ''));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const allowed = [...ALLOWED_REDIRECT_HOSTS].some((domain) => (
    host === domain || host.endsWith(`.${domain}`)
  ));
  if (!allowed) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  return url.protocol === 'https:';
}

function prefersAutoRedirect(redirectUri) {
  try {
    const host = new URL(redirectUri).hostname.toLowerCase();
    return host === 'grok.com' || host.endsWith('.grok.com')
      || host === 'grok.x.ai' || host.endsWith('.grok.x.ai')
      || host === 'x.ai' || host.endsWith('.x.ai')
      || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function mintAuthorizationCode({
  clientId,
  redirectUri,
  codeChallenge,
  scope = MCP_OAUTH_SCOPE,
  now = Date.now(),
  env = process.env,
}) {
  const secret = signingSecret(env);
  if (!secret) return '';
  const claims = {
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    code_challenge: String(codeChallenge),
    scope: String(scope || MCP_OAUTH_SCOPE),
    exp: now + MCP_OAUTH_CODE_TTL_MS,
    n: crypto.randomBytes(16).toString('hex'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${CODE_VERSION}.${payload}.${sign(secret, `${CODE_VERSION}.${payload}`)}`;
}

export function openAuthorizationCode(code, { env = process.env, now = Date.now() } = {}) {
  const secret = signingSecret(env);
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const parts = String(code || '').split('.');
  if (parts.length !== 3 || parts[0] !== CODE_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, payload, signature] = parts;
  if (!timingSafeEqualString(signature, sign(secret, `${CODE_VERSION}.${payload}`))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims?.client_id || !claims.redirect_uri || !claims.code_challenge) {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isFinite(claims.exp) || now >= claims.exp) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}

export function protectedResourceMetadata(origin = MCP_PUBLIC_ORIGIN) {
  return {
    resource: `${origin}/api/mcp/mounting-man-ads-apply`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_OAUTH_SCOPE],
  };
}

export function authorizationServerMetadata(origin = MCP_PUBLIC_ORIGIN) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${MCP_OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${MCP_OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${origin}${MCP_OAUTH_REGISTER_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_OAUTH_SCOPE],
  };
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version',
  );
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  applyCors(res);
  Object.entries({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    ...extraHeaders,
  }).forEach(([key, value]) => res.setHeader(key, value));
  return res.status(statusCode).json(body);
}

function sendHtml(res, statusCode, html) {
  applyCors(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.status(statusCode);
  if (typeof res.send === 'function') return res.send(html);
  if (typeof res.end === 'function') return res.end(html);
  return res;
}

function redirectTo(res, url) {
  applyCors(res);
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  if (typeof res.redirect === 'function') return res.redirect(302, url);
  return res.status(302).end();
}

function readParams(req) {
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  const body = readBody(req);
  return { ...query, ...body };
}

function readBody(req) {
  const raw = req?.body;
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const contentType = String(headerValue(req.headers, 'content-type') || '');
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return {};
}

function firstString(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  if (value == null) return '';
  return String(value).trim();
}

function redirectWithParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function authorizeErrorRedirect(redirectUri, state, error, description) {
  if (!isAllowedRedirectUri(redirectUri)) return null;
  return redirectWithParams(redirectUri, {
    error,
    error_description: description,
    state,
  });
}

function connectHtml({ query }) {
  const fields = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'state',
    'scope',
  ];
  const inputs = fields
    .filter((name) => query[name])
    .map((name) => (
      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(query[name])}" />`
    ))
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect Mounting Man Ads APPLY</title>
</head>
<body>
  <p>Connect this Grok connector to Mounting Man Ads APPLY.</p>
  <form method="GET" action="${escapeHtml(MCP_OAUTH_AUTHORIZE_PATH)}">
    ${inputs}
    <input type="hidden" name="approve" value="1" />
    <button type="submit">Connect Mounting Man Ads APPLY</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function oauthErrorHtml(message) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Authorization error</title></head>
<body><p>${escapeHtml(message)}</p></body>
</html>`;
}

export function createProtectedResourceMetadataHandler() {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      applyCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 200, protectedResourceMetadata());
  };
}

export function createAuthorizationServerMetadataHandler() {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      applyCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 200, authorizationServerMetadata());
  };
}

export function createAuthorizeHandler(overrides = {}) {
  return async function handler(req, res) {
    const env = overrides.env || process.env;
    if (req.method === 'OPTIONS') {
      applyCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const params = readParams(req);
    const responseType = firstString(params.response_type);
    const clientId = firstString(params.client_id);
    const redirectUri = firstString(params.redirect_uri);
    const codeChallenge = firstString(params.code_challenge);
    const challengeMethod = firstString(params.code_challenge_method);
    const state = firstString(params.state);
    const scope = firstString(params.scope) || MCP_OAUTH_SCOPE;
    const approve = firstString(params.approve);
    const prompt = firstString(params.prompt);

    const fail = (error, description) => {
      const target = authorizeErrorRedirect(redirectUri, state, error, description);
      if (target) return redirectTo(res, target);
      return sendHtml(res, 400, oauthErrorHtml(description));
    };

    if (!signingSecret(env)) {
      return sendHtml(res, 503, oauthErrorHtml('Authorization server is not configured.'));
    }
    if (responseType !== 'code') {
      return fail('unsupported_response_type', 'response_type must be code');
    }
    if (!clientId) {
      return fail('invalid_request', 'client_id is required');
    }
    if (!isAllowedRedirectUri(redirectUri)) {
      return sendHtml(res, 400, oauthErrorHtml('redirect_uri is not allowed'));
    }
    if (challengeMethod !== 'S256') {
      return fail('invalid_request', 'code_challenge_method must be S256');
    }
    if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
      return fail('invalid_request', 'code_challenge is required');
    }

    const shouldConsent = prompt === 'consent' && approve !== '1';
    if (shouldConsent && !prefersAutoRedirect(redirectUri)) {
      return sendHtml(res, 200, connectHtml({
        query: {
          response_type: responseType,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: challengeMethod,
          state,
          scope,
        },
      }));
    }

    const code = mintAuthorizationCode({
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      env,
    });
    return redirectTo(res, redirectWithParams(redirectUri, { code, state }));
  };
}

export function createTokenHandler(overrides = {}) {
  return async function handler(req, res) {
    const env = overrides.env || process.env;
    if (req.method === 'OPTIONS') {
      applyCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const params = readParams(req);
    const grantType = firstString(params.grant_type);
    const code = firstString(params.code);
    const redirectUri = firstString(params.redirect_uri);
    const clientId = firstString(params.client_id);
    const codeVerifier = firstString(params.code_verifier);

    if (grantType !== 'authorization_code') {
      return sendJson(res, 400, { error: 'unsupported_grant_type' });
    }

    const opened = openAuthorizationCode(code, { env });
    if (!opened.ok) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }

    const { claims } = opened;
    if (claims.client_id !== clientId || claims.redirect_uri !== redirectUri) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }
    if (!codeVerifier) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }
    const expected = claims.code_challenge;
    const actual = pkceS256Challenge(codeVerifier);
    if (!timingSafeEqualString(expected, actual)) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }

    const accessToken = issuedAccessToken(env);
    if (!accessToken) {
      return sendJson(res, 503, { error: 'temporarily_unavailable' });
    }

    return sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN,
      scope: claims.scope || MCP_OAUTH_SCOPE,
    });
  };
}

export function createRegisterHandler() {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      applyCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const body = readBody(req);
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.map((value) => String(value))
      : firstString(body.redirect_uris)
        ? [firstString(body.redirect_uris)]
        : [];

    return sendJson(res, 201, {
      client_id: MCP_OAUTH_CLIENT_ID,
      token_endpoint_auth_method: 'none',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: MCP_OAUTH_SCOPE,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  };
}

export { MCP_ADS_APPLY_RESOURCE, MCP_PUBLIC_ORIGIN };

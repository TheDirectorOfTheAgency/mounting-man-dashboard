import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MCP_ADS_APPLY_RESOURCE,
  MCP_OAUTH_RESOURCE_METADATA_URL,
  MCP_PUBLIC_ORIGIN,
  isAuthorizedMcpRequest,
  mcpWwwAuthenticateHeader,
} from '../lib/mcp-http.mjs';
import {
  MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN,
  MCP_OAUTH_CLIENT_ID,
  authorizationServerMetadata,
  createAuthorizationServerMetadataHandler,
  createAuthorizeHandler,
  createProtectedResourceMetadataHandler,
  createRegisterHandler,
  createTokenHandler,
  mintAuthorizationCode,
  pkceS256Challenge,
  protectedResourceMetadata,
} from '../lib/mcp-oauth.mjs';
import { createMountingManAdsApplyHandler } from '../pages/api/mcp/mounting-man-ads-apply.js';

const require = createRequire(import.meta.url);
const AUTH_ENV = {
  MCP_SQUARE_PAYROLL_SECRET: 'test-mcp-oauth-secret',
};

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.headers.location = url;
      this.ended = true;
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(value) {
      if (value !== undefined) this.body = value;
      this.ended = true;
      return this;
    },
  };
}

function request({ method = 'GET', headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query };
}

function pkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  return { codeVerifier, codeChallenge: pkceS256Challenge(codeVerifier) };
}

function authorizeQuery(overrides = {}) {
  const { codeVerifier, codeChallenge } = overrides.codeVerifier
    ? { codeVerifier: overrides.codeVerifier, codeChallenge: pkceS256Challenge(overrides.codeVerifier) }
    : pkcePair();
  const query = {
    response_type: 'code',
    client_id: MCP_OAUTH_CLIENT_ID,
    redirect_uri: 'https://grok.com/auth/callback',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    scope: 'mcp',
    ...overrides.query,
  };
  return { codeVerifier, query };
}

async function authorizeCode(env = AUTH_ENV, overrides = {}) {
  const { codeVerifier, query } = authorizeQuery(overrides);
  const handler = createAuthorizeHandler({ env });
  const res = response();
  await handler(request({ query }), res);
  const location = new URL(res.headers.location);
  return {
    codeVerifier,
    query,
    res,
    code: location.searchParams.get('code'),
    state: location.searchParams.get('state'),
  };
}

test('protected resource metadata matches RFC 9728 shape for ads-apply', async () => {
  const expected = {
    resource: MCP_ADS_APPLY_RESOURCE,
    authorization_servers: [MCP_PUBLIC_ORIGIN],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
  assert.deepEqual(protectedResourceMetadata(), expected);

  const handler = createProtectedResourceMetadataHandler();
  const root = response();
  await handler(request({ method: 'GET' }), root);
  assert.equal(root.statusCode, 200);
  assert.deepEqual(root.body, expected);

  const nested = response();
  await handler(request({
    method: 'GET',
    query: { path: ['api', 'mcp', 'mounting-man-ads-apply'] },
  }), nested);
  assert.deepEqual(nested.body, expected);
  assert.equal(nested.body.resource, 'https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-ads-apply');
});

test('authorization server metadata matches RFC 8414 shape', async () => {
  const expected = authorizationServerMetadata();
  assert.equal(expected.issuer, MCP_PUBLIC_ORIGIN);
  assert.equal(expected.authorization_endpoint, `${MCP_PUBLIC_ORIGIN}/api/mcp/auth/authorize`);
  assert.equal(expected.token_endpoint, `${MCP_PUBLIC_ORIGIN}/api/mcp/auth/token`);
  assert.equal(expected.registration_endpoint, `${MCP_PUBLIC_ORIGIN}/api/mcp/auth/register`);
  assert.deepEqual(expected.response_types_supported, ['code']);
  assert.deepEqual(expected.grant_types_supported, ['authorization_code']);
  assert.deepEqual(expected.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(expected.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(expected.scopes_supported, ['mcp']);

  const handler = createAuthorizationServerMetadataHandler();
  const res = response();
  await handler(request({ method: 'GET' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, expected);
});

test('next.config rewrites well-known URLs to /api, not /api/.well-known', async () => {
  const config = require('../next.config.js');
  const rewrites = await config.rewrites();
  assert.deepEqual(rewrites, [
    {
      source: '/.well-known/oauth-authorization-server',
      destination: '/api/well-known/oauth-authorization-server',
    },
    {
      source: '/.well-known/oauth-protected-resource',
      destination: '/api/well-known/oauth-protected-resource',
    },
    {
      source: '/.well-known/oauth-protected-resource/:path*',
      destination: '/api/well-known/oauth-protected-resource/:path*',
    },
  ]);
});

test('authorize issues a code and redirects with state', async () => {
  const issued = await authorizeCode();
  assert.equal(issued.res.statusCode, 302);
  assert.match(issued.res.headers.location, /^https:\/\/grok\.com\/auth\/callback\?/);
  assert.ok(issued.code);
  assert.equal(issued.state, 'state-1');
  assert.equal(issued.res.headers.location.includes(AUTH_ENV.MCP_SQUARE_PAYROLL_SECRET), false);
});

test('authorize also redirects localhost test callbacks', async () => {
  const issued = await authorizeCode(AUTH_ENV, {
    query: { redirect_uri: 'http://localhost:4378/callback' },
  });
  assert.equal(issued.res.statusCode, 302);
  assert.match(issued.res.headers.location, /^http:\/\/localhost:4378\/callback\?/);
  assert.ok(issued.code);
});

test('token rejects a bad PKCE verifier', async () => {
  const issued = await authorizeCode();
  const handler = createTokenHandler({ env: AUTH_ENV });
  const res = response();
  await handler(request({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: issued.code,
      redirect_uri: issued.query.redirect_uri,
      client_id: issued.query.client_id,
      code_verifier: 'a'.repeat(43),
    }).toString(),
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_grant');
  assert.equal(Object.hasOwn(res.body, 'access_token'), false);
});

test('token with matching PKCE returns an access_token isAuthorizedMcpRequest accepts', async () => {
  const issued = await authorizeCode();
  const handler = createTokenHandler({ env: AUTH_ENV });
  const res = response();
  await handler(request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      grant_type: 'authorization_code',
      code: issued.code,
      redirect_uri: issued.query.redirect_uri,
      client_id: issued.query.client_id,
      code_verifier: issued.codeVerifier,
      client_secret: 'unused-and-ignored',
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(res.body.expires_in, MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN);
  assert.equal(res.body.scope, 'mcp');
  assert.equal(typeof res.body.access_token, 'string');
  assert.ok(res.body.access_token.length > 0);
  assert.equal(
    isAuthorizedMcpRequest({
      headers: { authorization: `Bearer ${res.body.access_token}` },
    }, AUTH_ENV),
    true,
  );
});

test('token accepts application/x-www-form-urlencoded bodies', async () => {
  const issued = await authorizeCode();
  const handler = createTokenHandler({ env: AUTH_ENV });
  const res = response();
  await handler(request({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: issued.code,
      redirect_uri: issued.query.redirect_uri,
      client_id: issued.query.client_id,
      code_verifier: issued.codeVerifier,
    }).toString(),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(
    isAuthorizedMcpRequest({
      headers: { authorization: `Bearer ${res.body.access_token}` },
    }, AUTH_ENV),
    true,
  );
});

test('DCR returns client_id mounting-man-ads-apply and auth method none', async () => {
  const handler = createRegisterHandler();
  const res = response();
  await handler(request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      client_name: 'Grok',
      redirect_uris: ['https://grok.com/auth/callback', 'https://grok.x.ai/oauth'],
      token_endpoint_auth_method: 'none',
    },
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.client_id, 'mounting-man-ads-apply');
  assert.equal(res.body.token_endpoint_auth_method, 'none');
  assert.deepEqual(res.body.redirect_uris, [
    'https://grok.com/auth/callback',
    'https://grok.x.ai/oauth',
  ]);
  assert.equal(Object.hasOwn(res.body, 'client_secret'), false);
});

test('ads-apply 401 includes WWW-Authenticate resource_metadata', async () => {
  const handler = createMountingManAdsApplyHandler({
    env: AUTH_ENV,
    adsClient: null,
    logger: { error() {}, warn() {} },
  });
  const res = response();
  await handler(request({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), res);

  assert.equal(res.statusCode, 401);
  const wwwAuthenticate = String(res.headers['www-authenticate'] || '');
  const resourceParam = ['resource', 'metadata'].join('_');
  assert.equal(wwwAuthenticate, mcpWwwAuthenticateHeader());
  assert.equal(
    wwwAuthenticate,
    `Bearer realm="mcp", ${resourceParam}="${MCP_OAUTH_RESOURCE_METADATA_URL}", scope="mcp"`,
  );
  assert.equal(wwwAuthenticate.includes(`${resourceParam}=`), true);
  assert.equal(wwwAuthenticate.includes(AUTH_ENV.MCP_SQUARE_PAYROLL_SECRET), false);
});

test('authorize and token never echo operator secrets into HTML', async () => {
  const handler = createAuthorizeHandler({ env: AUTH_ENV });
  const denied = response();
  await handler(request({
    query: {
      response_type: 'code',
      client_id: MCP_OAUTH_CLIENT_ID,
      redirect_uri: 'https://evil.example/callback',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    },
  }), denied);
  assert.equal(denied.statusCode, 400);
  assert.equal(String(denied.body).includes(AUTH_ENV.MCP_SQUARE_PAYROLL_SECRET), false);

  const expired = mintAuthorizationCode({
    clientId: MCP_OAUTH_CLIENT_ID,
    redirectUri: 'https://grok.com/auth/callback',
    codeChallenge: 'a'.repeat(43),
    now: Date.now() - 20 * 60 * 1000,
    env: AUTH_ENV,
  });
  const tokenHandler = createTokenHandler({ env: AUTH_ENV });
  const tokenRes = response();
  await tokenHandler(request({
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: expired,
      redirect_uri: 'https://grok.com/auth/callback',
      client_id: MCP_OAUTH_CLIENT_ID,
      code_verifier: 'b'.repeat(43),
    },
  }), tokenRes);
  assert.equal(tokenRes.statusCode, 400);
  assert.equal(JSON.stringify(tokenRes.body).includes(AUTH_ENV.MCP_SQUARE_PAYROLL_SECRET), false);
});

test('OAuth routes do not call Google Ads mutate', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const oauth = readFileSync(path.join(root, 'lib/mcp-oauth.mjs'), 'utf8');
  assert.equal(oauth.includes('googleads.googleapis.com'), false);
  assert.equal(oauth.includes('adGroupCriteria:mutate'), false);
  assert.equal(oauth.includes('campaignCriteria:mutate'), false);
  assert.equal(oauth.includes('pause_ad_group_criterion'), false);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  CREATE_TWEET_URL,
  MARSHALLWAYNE_SCREEN_NAME,
  MARSHALLWAYNE_USER_ID,
  POST_MARSHALLWAYNE_RECAP,
  UPLOAD_MEDIA_URL,
  VERIFY_CREDENTIALS_URL,
  VERIFY_MARSHALLWAYNE,
  createMarshallWayneXClient,
} from '../lib/marshallwayne-x.mjs';
import { percentEncode, signOAuth1HmacSha1 } from '../lib/x-oauth1.mjs';
import { createMarshallWayneXHandler } from '../pages/api/mcp/marshallwayne-x.js';

const require = createRequire(import.meta.url);

const X_ENV = {
  X_MARSHALLWAYNE_API_KEY: 'mw-api-key',
  X_MARSHALLWAYNE_API_SECRET: 'mw-api-secret',
  X_MARSHALLWAYNE_ACCESS_TOKEN: 'mw-access-token',
  X_MARSHALLWAYNE_ACCESS_TOKEN_SECRET: 'mw-access-token-secret',
};

const AUTH_ENV = {
  MCP_SQUARE_PAYROLL_SECRET: 'test-mcp-secret',
  ...X_ENV,
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
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request({ method = 'POST', headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query };
}

function authorized(overrides = {}) {
  return request({
    headers: { authorization: 'Bearer test-mcp-secret', accept: 'application/json' },
    ...overrides,
  });
}

function marshallWayneUser() {
  return {
    id_str: MARSHALLWAYNE_USER_ID,
    screen_name: MARSHALLWAYNE_SCREEN_NAME,
  };
}

function parseOAuthHeader(header) {
  assert.match(header, /^OAuth /);
  const params = {};
  for (const part of header.slice(6).split(', ')) {
    const match = part.match(/^([^=]+)="([^"]*)"$/);
    assert.ok(match, `oauth header part ${part}`);
    params[decodeURIComponent(match[1])] = decodeURIComponent(match[2]);
  }
  return params;
}

function independentHmacSha1(method, url, oauthParams, consumerSecret, tokenSecret) {
  const encoded = Object.keys(oauthParams)
    .filter((key) => key !== 'oauth_signature')
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
    .join('&');
  const base = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(encoded),
  ].join('&');
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function recordingHttp(handler) {
  const calls = [];
  return {
    calls,
    async request(config) {
      calls.push(config);
      return handler(config);
    },
  };
}

function handlerWithClient(xClient, env = AUTH_ENV) {
  return createMarshallWayneXHandler({
    env,
    xClient,
    logger: { error() {}, warn() {} },
  });
}

function handlerWithHttp(httpClient, env = AUTH_ENV, oauth = {
  nonce: 'fixed-nonce',
  timestamp: '1710000000',
}) {
  return createMarshallWayneXHandler({
    env,
    xClient: createMarshallWayneXClient({ env, httpClient, oauth }),
    logger: { error() {}, warn() {} },
  });
}

test('OAuth 1.0a HMAC-SHA1 matches Twitter creating-a-signature fixture', () => {
  // Published pairing from Twitter's creating-a-signature walkthrough
  // (oauth_token GmHxMAgYyLb…, not the IyLvxlZj… copy that appears in some mirrors).
  const signed = signOAuth1HmacSha1({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    extraParams: {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    },
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: '1318622958',
  });
  assert.equal(signed.signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

test('MCP route rejects missing or wrong Bearer secrets', async () => {
  const handler = handlerWithClient(null);
  const missing = response();
  await handler(request({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = response();
  await handler(request({
    headers: { authorization: 'Bearer nope' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), wrong);
  assert.equal(wrong.statusCode, 401);
});

test('GET returns server info and OPTIONS CORS matches reporting', async () => {
  const handler = handlerWithClient(null);
  const get = response();
  await handler(authorized({ method: 'GET' }), get);
  assert.equal(get.statusCode, 200);
  assert.equal(get.body.protocol, 'mcp');
  assert.equal(get.body.server.name, 'marshallwayne-x');
  assert.equal(get.body.server.title, 'MarshallWayne X recap');
  assert.deepEqual(
    get.body.tools.map((tool) => tool.name),
    [VERIFY_MARSHALLWAYNE, POST_MARSHALLWAYNE_RECAP],
  );

  const options = response();
  await handler(request({ method: 'OPTIONS' }), options);
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers['access-control-allow-origin'], '*');
  assert.match(options.headers['access-control-allow-methods'], /GET/);
  assert.match(options.headers['access-control-allow-headers'], /x-mcp-secret/);
});

test('initialize and tools/list accept MCP_SQUARE_PAYROLL_SECRET and CRON_SECRET', async () => {
  const mcpHandler = handlerWithClient(null);
  const mcpRes = response();
  await mcpHandler(authorized({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  }), mcpRes);
  assert.equal(mcpRes.statusCode, 200);
  assert.equal(mcpRes.body.result.serverInfo.name, 'marshallwayne-x');
  assert.equal(mcpRes.body.result.protocolVersion, '2025-03-26');

  const cronHandler = handlerWithClient(null, { CRON_SECRET: 'existing-cron' });
  const cronRes = response();
  await cronHandler(request({
    headers: { authorization: 'Bearer existing-cron' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), cronRes);
  assert.equal(cronRes.statusCode, 200);
  const names = cronRes.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [VERIFY_MARSHALLWAYNE, POST_MARSHALLWAYNE_RECAP]);
});

test('verify_marshallwayne returns screen_name and id for the expected account', async () => {
  const http = recordingHttp(() => ({ data: marshallWayneUser() }));
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: VERIFY_MARSHALLWAYNE, arguments: {} },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.deepEqual(res.body.result.structuredContent, {
    screen_name: 'MarshallWayne',
    id: '1395241563509252099',
  });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].method, 'GET');
  assert.equal(http.calls[0].url, VERIFY_CREDENTIALS_URL);
  assert.equal(http.calls[0].data, undefined);
  const oauth = parseOAuthHeader(http.calls[0].headers.Authorization);
  assert.equal(oauth.oauth_consumer_key, X_ENV.X_MARSHALLWAYNE_API_KEY);
  assert.equal(oauth.oauth_token, X_ENV.X_MARSHALLWAYNE_ACCESS_TOKEN);
  assert.equal(oauth.oauth_signature_method, 'HMAC-SHA1');
  assert.equal(oauth.oauth_version, '1.0');
  assert.ok(oauth.oauth_signature);
});

test('verify_marshallwayne refuses the wrong user id even when screen_name matches', async () => {
  const http = recordingHttp(() => ({
    data: { id_str: '1', screen_name: MARSHALLWAYNE_SCREEN_NAME },
  }));
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: VERIFY_MARSHALLWAYNE, arguments: {} },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /id 1/);
  assert.match(res.body.result.content[0].text, /1395241563509252099/);
  assert.equal(http.calls.some((call) => call.url === CREATE_TWEET_URL), false);
});

test('verify_marshallwayne refuses the wrong screen_name and never posts', async () => {
  const http = recordingHttp(() => ({
    data: { id_str: MARSHALLWAYNE_USER_ID, screen_name: 'MountingManTV' },
  }));
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: VERIFY_MARSHALLWAYNE, arguments: {} },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /MountingManTV/);
  assert.match(res.body.result.content[0].text, /MarshallWayne/);
  assert.equal(http.calls.some((call) => call.url === CREATE_TWEET_URL), false);
});

test('post_marshallwayne_recap refuses empty or whitespace-only text without hitting X', async () => {
  const http = recordingHttp(() => {
    throw new Error('X API must not be called for empty text');
  });
  const handler = handlerWithHttp(http);

  for (const text of ['', '   ', '\n\t', undefined]) {
    const res = response();
    await handler(authorized({
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: POST_MARSHALLWAYNE_RECAP, arguments: text === undefined ? {} : { text } },
      },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /empty/i);
  }
  assert.equal(http.calls.length, 0);
});

test('post_marshallwayne_recap refuses the wrong account and does not POST /2/tweets', async () => {
  const http = recordingHttp(() => ({
    data: { id_str: '1', screen_name: 'SomeoneElse' },
  }));
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: POST_MARSHALLWAYNE_RECAP, arguments: { text: 'Friday recap' } },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /SomeoneElse/);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, VERIFY_CREDENTIALS_URL);
  assert.equal(http.calls.some((call) => call.url === CREATE_TWEET_URL), false);
});

test('post_marshallwayne_recap posts text verbatim and returns the permalink', async () => {
  const recap = 'Week recap: two Frames in Edina.\nNo hashtag added here.';
  const mediaId = '1980000000000000001';
  const http = recordingHttp((config) => {
    if (config.method === 'GET' && config.url === VERIFY_CREDENTIALS_URL) {
      return { data: marshallWayneUser() };
    }
    if (config.method === 'POST' && config.url === UPLOAD_MEDIA_URL) {
      return { data: { media_id_string: mediaId } };
    }
    if (config.method === 'POST' && config.url === CREATE_TWEET_URL) {
      return { data: { data: { id: '1987654321098765432', text: config.data.text } } };
    }
    throw new Error(`unexpected X call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: POST_MARSHALLWAYNE_RECAP, arguments: { text: recap } },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.result.structuredContent, {
    permalink: 'https://x.com/MarshallWayne/status/1987654321098765432',
    id: '1987654321098765432',
    media_id: mediaId,
  });
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls[0].url, VERIFY_CREDENTIALS_URL);
  assert.equal(http.calls[1].url, UPLOAD_MEDIA_URL);
  assert.equal(http.calls[2].url, CREATE_TWEET_URL);
  assert.deepEqual(http.calls[2].data, {
    text: recap,
    media: { media_ids: [mediaId] },
  });
  assert.equal(http.calls[2].headers['Content-Type'], 'application/json');
  assert.equal(JSON.stringify(http.calls[2].data).includes('#'), false);

  const oauth = parseOAuthHeader(http.calls[2].headers.Authorization);
  const expected = independentHmacSha1(
    'POST',
    CREATE_TWEET_URL,
    oauth,
    X_ENV.X_MARSHALLWAYNE_API_SECRET,
    X_ENV.X_MARSHALLWAYNE_ACCESS_TOKEN_SECRET,
  );
  assert.equal(oauth.oauth_signature, expected);
});

test('post_marshallwayne_recap attach_image=false posts text only and skips media upload', async () => {
  const recap = 'Week recap: two Frames in Edina.\nNo hashtag added here.';
  const http = recordingHttp((config) => {
    if (config.method === 'GET' && config.url === VERIFY_CREDENTIALS_URL) {
      return { data: marshallWayneUser() };
    }
    if (config.method === 'POST' && config.url === CREATE_TWEET_URL) {
      return { data: { data: { id: '1987654321098765432', text: config.data.text } } };
    }
    throw new Error(`unexpected X call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: POST_MARSHALLWAYNE_RECAP,
        arguments: { text: recap, attach_image: false },
      },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.result.structuredContent, {
    permalink: 'https://x.com/MarshallWayne/status/1987654321098765432',
    id: '1987654321098765432',
  });
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, VERIFY_CREDENTIALS_URL);
  assert.equal(http.calls[1].url, CREATE_TWEET_URL);
  assert.deepEqual(http.calls[1].data, { text: recap });
  assert.equal(http.calls[1].headers['Content-Type'], 'application/json');
  assert.equal(http.calls.some((call) => call.url === UPLOAD_MEDIA_URL), false);
});

test('POST /2/tweets JSON body is not part of the OAuth signature', async () => {
  const tweetSignatures = [];
  const http = recordingHttp((config) => {
    if (config.url === VERIFY_CREDENTIALS_URL) {
      return { data: marshallWayneUser() };
    }
    if (config.url === CREATE_TWEET_URL) {
      tweetSignatures.push(parseOAuthHeader(config.headers.Authorization).oauth_signature);
      return { data: { data: { id: `id-${tweetSignatures.length}` } } };
    }
    throw new Error(`unexpected X call ${config.method} ${config.url}`);
  });
  const oauth = { nonce: 'same-nonce', timestamp: '1710000000' };
  const client = createMarshallWayneXClient({ env: X_ENV, httpClient: http, oauth });
  // Text-only so this test proves tweet JSON is unsigned without depending
  // on media-upload form/OAuth (separate request, extraParams signed).
  await client.postMarshallWayneRecap('first recap text', { attach_image: false });
  await client.postMarshallWayneRecap('a totally different recap body', { attach_image: false });
  assert.equal(tweetSignatures.length, 2);
  assert.equal(tweetSignatures[0], tweetSignatures[1]);
  assert.equal(http.calls.some((call) => call.url === UPLOAD_MEDIA_URL), false);
});

test('next.config traces recap-plate.png into the marshallwayne-x serverless bundle', () => {
  const nextConfig = require('../next.config.js');
  const includes = nextConfig.experimental?.outputFileTracingIncludes
    || nextConfig.outputFileTracingIncludes
    || {};
  const globs = includes['/api/mcp/marshallwayne-x'] || [];
  assert.ok(
    globs.some((glob) => String(glob).includes('lib/assets/recap-plate.png')),
    'outputFileTracingIncludes must ship lib/assets/recap-plate.png with /api/mcp/marshallwayne-x',
  );
});

test('missing X_MARSHALLWAYNE_* env fails closed and ignores other Twitter vars', async () => {
  const http = recordingHttp(() => {
    throw new Error('X API must not be called without MarshallWayne env');
  });
  const env = {
    MCP_SQUARE_PAYROLL_SECRET: 'test-mcp-secret',
    TWITTER_API_KEY: 'mounting-man-key',
    TWITTER_API_SECRET: 'mounting-man-secret',
    TWITTER_ACCESS_TOKEN: 'mounting-man-token',
    TWITTER_ACCESS_TOKEN_SECRET: 'mounting-man-token-secret',
    X_API_KEY: 'other-x-key',
  };
  const handler = handlerWithHttp(http, env);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: VERIFY_MARSHALLWAYNE, arguments: {} },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /X_MARSHALLWAYNE_API_KEY/);
  assert.match(res.body.result.content[0].text, /X_MARSHALLWAYNE_ACCESS_TOKEN_SECRET/);
  assert.equal(http.calls.length, 0);
});

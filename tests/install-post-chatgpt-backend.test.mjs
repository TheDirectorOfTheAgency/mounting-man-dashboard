import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstallationPostBackendClient } from '../cloud/install-post-mcp/backend-client.mjs';
import chatgptToolsModule from '../pages/api/install-post/chatgpt-tools.js';

const { createChatgptToolsHandler } = chatgptToolsModule;

function invoke(handler, options) {
  return new Promise((resolve) => {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const req = { method: 'POST', headers, body: JSON.parse(options.body) };
    const res = {
      status(status) {
        return {
          json(body) {
            resolve({ ok: status >= 200 && status < 300, status, async json() { return body; } });
          },
        };
      },
    };
    handler(req, res);
  });
}

test('OAuth actor reaches the backend only through a fresh HMAC-authenticated envelope', async () => {
  let receivedContext;
  let signedRequest;
  const handler = createChatgptToolsHandler({
    backendToken: 'backend-shared-secret',
    ownerSubject: 'oauth-owner-subject',
    async claimRequest() { return true; },
    service: {
      async list_pending_installations(_args, context) {
        receivedContext = context;
        return { installations: [] };
      },
    },
  });
  const backend = createInstallationPostBackendClient({
    endpoint: 'https://backend.example.test/api/install-post/chatgpt-tools',
    token: 'backend-shared-secret',
    async httpClient(_url, options) {
      signedRequest = structuredClone(options);
      return invoke(handler, options);
    },
  });
  await backend.call('list_pending_installations', {}, {
    verifiedActor: { sub: 'oauth-owner-subject' },
  });
  assert.equal(receivedContext.verifiedActor.sub, 'oauth-owner-subject');
  assert.match(receivedContext.verifiedActor.requestId, /^[0-9a-f-]{36}$/);

  const tampered = structuredClone(signedRequest);
  const body = JSON.parse(tampered.body);
  body.actor.sub = 'forged-subject';
  tampered.body = JSON.stringify(body);
  const response = await invoke(handler, tampered);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('a captured valid backend envelope can be claimed only once', async () => {
  const claimed = new Set();
  const handler = createChatgptToolsHandler({
    backendToken: 'backend-shared-secret',
    ownerSubject: 'oauth-owner-subject',
    async claimRequest(requestId) {
      if (claimed.has(requestId)) return false;
      claimed.add(requestId);
      return true;
    },
    service: { async list_pending_installations() { return { installations: [] }; } },
  });
  let signedRequest;
  const backend = createInstallationPostBackendClient({
    endpoint: 'https://backend.example.test/api/install-post/chatgpt-tools',
    token: 'backend-shared-secret',
    async httpClient(_url, options) {
      signedRequest = structuredClone(options);
      return invoke(handler, options);
    },
  });
  await backend.call('list_pending_installations', {}, {
    verifiedActor: { sub: 'oauth-owner-subject' },
  });
  const replay = await invoke(handler, signedRequest);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: 'replayed_request' });
});

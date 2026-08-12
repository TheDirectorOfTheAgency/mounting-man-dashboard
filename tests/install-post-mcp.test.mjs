import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createInstallationPostBackendClient } from '../cloud/install-post-mcp/backend-client.mjs';
import {
  createInstallationPostMcpServer,
  createRemoteMcpApp,
} from '../cloud/install-post-mcp/server.mjs';

async function connectedFixture() {
  const calls = [];
  const server = createInstallationPostMcpServer({
    actor: {
      sub: 'owner-subject',
      scopes: ['installation-posts:read', 'installation-posts:write', 'installation-posts:publish'],
    },
    backend: {
      async call(name, args) {
        calls.push({ name, args });
        return { tool: name, received: args };
      },
    },
  });
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, calls };
}

test('MCP initializes and lists the exact eight narrow tools with safety annotations', async (t) => {
  const { server, client } = await connectedFixture();
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_pending_installations',
    'get_installation_job',
    'resolve_installation_reference',
    'attach_installation_photo',
    'preview_installation_post',
    'publish_installation_everywhere',
    'get_installation_publish_status',
    'retry_failed_destinations',
  ]);
  assert.equal(tools.find((tool) => tool.name === 'list_pending_installations').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'publish_installation_everywhere').annotations.destructiveHint, true);
  const publishSchema = tools.find((tool) => tool.name === 'publish_installation_everywhere').inputSchema;
  assert.deepEqual(Object.keys(publishSchema.properties).sort(), ['approval_nonce', 'job_id', 'manifest_id']);
  assert.equal(publishSchema.additionalProperties, false);
  const attach = tools.find((tool) => tool.name === 'attach_installation_photo');
  assert.deepEqual(attach._meta['openai/fileParams'], ['photo']);
});

test('all eight representative calls forward only schema-approved arguments', async (t) => {
  const { server, client, calls } = await connectedFixture();
  t.after(async () => { await client.close(); await server.close(); });
  const revision = 'a'.repeat(64);
  const manifest = `manifest_${'b'.repeat(64)}`;
  const nonce = 'approval-nonce-12345678901234567890';
  const cases = [
    ['list_pending_installations', {}],
    ['get_installation_job', { job_id: 'job_1' }],
    ['resolve_installation_reference', { reference: 'Susan Drive' }],
    ['attach_installation_photo', {
      job_id: 'job_1', expected_revision: revision,
      photo: {
        download_url: 'https://files.openai.example/opaque',
        file_id: 'file_1',
        mime_type: 'image/jpeg',
      },
    }],
    ['preview_installation_post', { job_id: 'job_1', expected_revision: revision }],
    ['publish_installation_everywhere', { job_id: 'job_1', manifest_id: manifest, approval_nonce: nonce }],
    ['get_installation_publish_status', { job_id: 'job_1' }],
    ['retry_failed_destinations', {
      job_id: 'job_1', manifest_id: manifest, approval_nonce: nonce, destination_ids: ['linkedin'],
    }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.tool, name);
  }
  assert.deepEqual(calls, cases.map(([name, args]) => ({ name, args })));
});

test('publish rejects freeform captions and destination lists at the MCP boundary', async (t) => {
  const { server, client, calls } = await connectedFixture();
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({
    name: 'publish_installation_everywhere',
    arguments: {
      job_id: 'job_1',
      manifest_id: `manifest_${'b'.repeat(64)}`,
      approval_nonce: 'approval-nonce-12345678901234567890',
      caption: 'replace the reviewed copy',
      destinations: ['website'],
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('backend client sends bearer token only in the header and never returns it', async () => {
  let request;
  const backend = createInstallationPostBackendClient({
    endpoint: 'https://backend.example.test/api/install-post/chatgpt-tools',
    token: 'top-secret-backend-token',
    async httpClient(url, options) {
      request = { url, options };
      return { ok: true, async json() { return { result: { jobs: [] } }; } };
    },
  });
  const result = await backend.call('list_pending_installations', {}, {
    verifiedActor: { sub: 'owner-subject' },
  });
  assert.deepEqual(result, { jobs: [] });
  assert.equal(request.options.headers.Authorization, 'Bearer top-secret-backend-token');
  assert.match(request.options.headers['X-Install-Post-Signature'], /^[0-9a-f]{64}$/);
  assert.match(request.options.headers['X-Install-Post-Issued-At'], /^\d+$/);
  assert.doesNotMatch(request.url, /top-secret/);
  assert.doesNotMatch(request.options.body, /top-secret/);
  assert.equal(JSON.parse(request.options.body).actor.sub, 'owner-subject');
  assert.doesNotMatch(JSON.stringify(result), /top-secret/);
});

test('MCP enforces read, write, and publish scopes before reaching the backend', async (t) => {
  const calls = [];
  const server = createInstallationPostMcpServer({
    actor: { sub: 'owner-subject', scopes: ['installation-posts:read'] },
    backend: { async call(name) { calls.push(name); return {}; } },
  });
  const client = new Client({ name: 'scope-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const denied = await client.callTool({
    name: 'preview_installation_post',
    arguments: { job_id: 'job_1', expected_revision: 'a'.repeat(64) },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error, 'insufficient_scope');
  assert.deepEqual(calls, []);
});

test('backend failures are reduced to safe error codes', async () => {
  const backend = createInstallationPostBackendClient({
    endpoint: 'https://backend.example.test/api/install-post/chatgpt-tools',
    token: 'top-secret-backend-token',
    async httpClient() {
      return {
        ok: false,
        async json() { return { error: 'bad error containing Bearer top-secret-backend-token' }; },
      };
    },
  });
  await assert.rejects(backend.call('list_pending_installations', {}), (error) => {
    assert.equal(error.code, 'backend_request_failed');
    assert.doesNotMatch(error.message, /top-secret/);
    return true;
  });
});

test('remote transport publishes OAuth metadata and enforces the configured owner subject', async (t) => {
  const env = {
    INSTALL_POST_MCP_OAUTH_ISSUER: 'https://auth.example.test',
    INSTALL_POST_MCP_OAUTH_JWKS_URL: 'https://auth.example.test/.well-known/jwks.json',
    INSTALL_POST_MCP_OAUTH_AUDIENCE: 'https://mcp.example.test/mcp',
    INSTALL_POST_MCP_OWNER_SUBJECT: 'owner-subject',
    INSTALL_POST_MCP_RESOURCE_URL: 'https://mcp.example.test/mcp',
    INSTALL_POST_MCP_ALLOWED_HOST: '127.0.0.1',
    PORT: '3000',
  };
  const { app } = createRemoteMcpApp({
    env,
    backend: { async call() { return {}; } },
    async verifyBearer(header) {
      if (!header) throw new Error('missing');
      return { sub: 'other-subject', scopes: ['installation-posts:read'] };
    },
  });
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const { port } = listener.address();
  const base = `http://127.0.0.1:${port}`;

  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).scopes_supported, [
    'installation-posts:read', 'installation-posts:write', 'installation-posts:publish',
  ]);

  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/);

  const forbidden = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
});

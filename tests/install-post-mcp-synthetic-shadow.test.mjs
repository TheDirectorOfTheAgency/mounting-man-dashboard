import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createInstallationPostMcpServer } from '../cloud/install-post-mcp/server.mjs';
import { createSyntheticShadowBackend } from '../cloud/install-post-mcp/synthetic-shadow.mjs';

async function fixture() {
  const server = createInstallationPostMcpServer({
    backend: createSyntheticShadowBackend(),
    actor: {
      sub: 'synthetic-shadow-owner',
      scopes: ['installation-posts:read', 'installation-posts:write', 'installation-posts:publish'],
    },
    authentication: 'none',
  });
  const client = new Client({ name: 'synthetic-shadow-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('synthetic shadow advertises the eight tools as no-auth and never dispatches', async (t) => {
  const { server, client } = await fixture();
  t.after(async () => { await client.close(); await server.close(); });

  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 8);
  assert.deepEqual(tools.map((tool) => tool._meta.securitySchemes), Array(8).fill([{ type: 'noauth' }]));

  const pending = await client.callTool({ name: 'list_pending_installations', arguments: {} });
  assert.equal(pending.structuredContent.production_effects, false);
  assert.equal(pending.structuredContent.jobs.length, 2);

  const ambiguous = await client.callTool({
    name: 'resolve_installation_reference', arguments: { reference: 'Susan Drive' },
  });
  assert.equal(ambiguous.structuredContent.status, 'ambiguous');

  const attachment = await client.callTool({
    name: 'attach_installation_photo',
    arguments: {
      job_id: 'synthetic_job_susan_living',
      expected_revision: 'a'.repeat(64),
      photo: {
        download_url: 'https://127.0.0.1:1/intentionally-unreachable',
        file_id: 'synthetic_file_envelope',
        mime_type: 'image/png',
        name: 'synthetic.png',
      },
    },
  });
  assert.equal(attachment.structuredContent.status, 'FILE_ENVELOPE_RECEIVED_NO_FETCH');
  assert.equal(attachment.structuredContent.file_id, 'synthetic_file_envelope');
  assert.equal(attachment.structuredContent.production_effects, false);

  const blocked = await client.callTool({
    name: 'publish_installation_everywhere',
    arguments: {
      job_id: 'synthetic_job_susan_living',
      manifest_id: `manifest_${'b'.repeat(64)}`,
      approval_nonce: 'synthetic-approval-nonce-1234567890',
    },
  });
  assert.equal(blocked.structuredContent.status, 'BLOCKED');
  assert.equal(blocked.structuredContent.reason, 'SYNTHETIC_SHADOW_PRODUCTION_DISABLED');
});

test('synthetic shadow refuses to start without the explicit safety gate', async () => {
  const { main } = await import('../cloud/install-post-mcp/synthetic-shadow.mjs');
  await assert.rejects(main({}), /INSTALL_POST_MCP_SYNTHETIC_ONLY=1/);
});

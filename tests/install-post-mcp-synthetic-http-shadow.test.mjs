import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startSyntheticHttpShadow } from '../cloud/install-post-mcp/synthetic-http-shadow.mjs';

test('loopback HTTP shadow is healthy, reachable over MCP, and production-disabled', async (t) => {
  const shadow = await startSyntheticHttpShadow({
    env: { INSTALL_POST_MCP_SYNTHETIC_ONLY: '1' },
    port: 0,
  });
  t.after(() => new Promise((resolve) => shadow.listener.close(resolve)));

  const health = await fetch(`${shadow.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok', mode: 'SYNTHETIC_SHADOW', production_effects: false,
  });

  const client = new Client({ name: 'synthetic-http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${shadow.url}/mcp`)));
  t.after(() => client.close());
  const pending = await client.callTool({ name: 'list_pending_installations', arguments: {} });
  assert.equal(pending.structuredContent.production_effects, false);
  assert.equal(pending.structuredContent.jobs.length, 2);
  assert.match(pending.content[0].text, /ready for photos/);
});

test('HTTP shadow refuses a non-loopback bind or a missing synthetic gate', async () => {
  await assert.rejects(startSyntheticHttpShadow({ env: {}, port: 0 }), /SYNTHETIC_ONLY=1/);
  await assert.rejects(startSyntheticHttpShadow({
    env: { INSTALL_POST_MCP_SYNTHETIC_ONLY: '1' }, host: '0.0.0.0', port: 0,
  }), /must bind to loopback/);
});

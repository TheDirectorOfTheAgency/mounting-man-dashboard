#!/usr/bin/env node

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createInstallationPostMcpServer } from './server.mjs';
import { createSyntheticShadowBackend } from './synthetic-shadow.mjs';

const SYNTHETIC_ACTOR = Object.freeze({
  sub: 'synthetic-shadow-owner',
  scopes: ['installation-posts:read', 'installation-posts:write', 'installation-posts:publish'],
});

export async function startSyntheticHttpShadow({
  env = process.env,
  host = String(env.HOST || '127.0.0.1'),
  port = Number(env.PORT || 3137),
} = {}) {
  if (env.INSTALL_POST_MCP_SYNTHETIC_ONLY !== '1') {
    throw new Error('synthetic HTTP shadow requires INSTALL_POST_MCP_SYNTHETIC_ONLY=1');
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('synthetic HTTP shadow must bind to loopback');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('synthetic HTTP shadow port is invalid');
  }

  const app = createMcpExpressApp({ host, allowedHosts: [host, 'localhost'] });
  app.get('/healthz', (_req, res) => res.json({
    status: 'ok', mode: 'SYNTHETIC_SHADOW', production_effects: false,
  }));
  app.post('/mcp', async (req, res) => {
    const server = createInstallationPostMcpServer({
      backend: createSyntheticShadowBackend(),
      actor: SYNTHETIC_ACTOR,
      authentication: 'none',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

  const listener = http.createServer(app);
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, resolve);
  });
  const address = listener.address();
  return {
    listener,
    url: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
  };
}

export async function main(env = process.env) {
  const { url } = await startSyntheticHttpShadow({ env });
  process.stderr.write(`Synthetic installation-post MCP listening at ${url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

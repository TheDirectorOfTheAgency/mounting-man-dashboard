#!/usr/bin/env node

import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createInstallationPostMcpServer } from './server.mjs';
import { createInstallationPostBackendClient } from './backend-client.mjs';

const SCOPES = [
  'installation-posts:read',
  'installation-posts:write',
  'installation-posts:publish',
];

function envRequired(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bearerMatches(header, expected) {
  return String(header || '').replace(/^Bearer\s+/i, '') === expected;
}

function runPublisher({ env, action, body }) {
  const script = env.INSTALL_POST_VPS_PUBLISHER_SCRIPT || '/opt/mounting-man-install-post-vps/publisher_service.py';
  const python = env.INSTALL_POST_VPS_PUBLISHER_PYTHON || '/opt/mounting-man-install-post-vps/venv/bin/python';
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, action], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`publisher_${action}_failed`));
      try {
        resolve(JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}'));
      } catch {
        reject(new Error('publisher_invalid_response'));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export async function startLiveHttp({ env = process.env } = {}) {
  const host = String(env.HOST || '127.0.0.1');
  const port = Number(env.PORT || 3137);
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('live MCP must bind to loopback');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('live MCP port is invalid');
  const backendToken = envRequired(env, 'INSTALL_POST_MCP_BACKEND_TOKEN');
  const backendEndpoint = envRequired(env, 'INSTALL_POST_MCP_BACKEND_URL');
  const ownerSubject = envRequired(env, 'INSTALL_POST_MCP_OWNER_SUBJECT');
  const publisherToken = envRequired(env, 'INSTALL_POST_VPS_PUBLISHER_TOKEN');
  const backend = createInstallationPostBackendClient({ endpoint: backendEndpoint, token: backendToken });
  const actor = Object.freeze({ sub: ownerSubject, scopes: SCOPES });
  const app = createMcpExpressApp({ host, allowedHosts: [host, 'localhost'] });

  app.get('/healthz', (_req, res) => res.json({
    status: 'ok',
    mode: 'LIVE_QUEUE',
    production_effects: env.INSTALL_POST_MCP_PUBLISH_ENABLED === '1',
    publisher: 'VPS_CANONICAL_COPY',
  }));

  app.post('/mcp', async (req, res) => {
    const server = createInstallationPostMcpServer({
      backend,
      actor,
      authentication: 'none',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  const publisherRequest = (action) => async (req, res) => {
    if (!bearerMatches(req.headers.authorization, publisherToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await runPublisher({ env, action, body: req.body || {} });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(502).json({ error: String(error?.message || 'publisher_failed') });
    }
  };
  app.post('/publisher/preview', publisherRequest('preview'));
  app.post('/publisher/publish', publisherRequest('publish'));
  app.post('/publisher/retry', publisherRequest('retry'));
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

  const listener = http.createServer(app);
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, resolve);
  });
  return { listener, url: `http://${host === '::1' ? '[::1]' : host}:${port}` };
}

export async function main(env = process.env) {
  const { url } = await startLiveHttp({ env });
  process.stderr.write(`Live installation-post MCP listening at ${url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

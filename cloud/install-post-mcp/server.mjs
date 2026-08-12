#!/usr/bin/env node

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod/v4';

import { createInstallationPostBackendClient } from './backend-client.mjs';

const JOB_ID = z.string().min(1).max(100);
const REVISION = z.string().regex(/^[0-9a-f]{64}$/);
const MANIFEST_ID = z.string().regex(/^manifest_[0-9a-f]{64}$/);
const NONCE = z.string().min(32).max(200);
const READ_SCOPE = 'installation-posts:read';
const WRITE_SCOPE = 'installation-posts:write';
const PUBLISH_SCOPE = 'installation-posts:publish';

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_pending_installations',
    title: 'List pending installations',
    description: 'List safe pending installation candidates from the authoritative queue.',
    schema: z.object({}).strict(),
    requiredScope: READ_SCOPE,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'get_installation_job',
    title: 'Get installation job',
    description: 'Read one safe installation record by its opaque job ID.',
    schema: z.object({ job_id: JOB_ID }).strict(),
    requiredScope: READ_SCOPE,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'resolve_installation_reference',
    title: 'Resolve installation reference',
    description: 'Return candidates for a natural-language installation reference without guessing.',
    schema: z.object({ reference: z.string().min(1).max(400) }).strict(),
    requiredScope: READ_SCOPE,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'attach_installation_photo',
    title: 'Attach installation photo',
    description: 'Normalize and bind one ChatGPT-provided file to a confirmed job and revision.',
    schema: z.object({
      job_id: JOB_ID,
      expected_revision: REVISION,
      photo: z.object({
        download_url: z.string().url().max(4096),
        file_id: z.string().min(1).max(256),
        mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        name: z.string().max(256).optional(),
      }).strict(),
    }).strict(),
    requiredScope: WRITE_SCOPE,
    meta: { 'openai/fileParams': ['photo'] },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'preview_installation_post',
    title: 'Preview installation post',
    description: 'Create and store exact website and destination copy for operator review.',
    schema: z.object({ job_id: JOB_ID, expected_revision: REVISION }).strict(),
    requiredScope: WRITE_SCOPE,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'publish_installation_everywhere',
    title: 'Publish installation everywhere',
    description: 'Publish only the stored immutable manifest identified by its approval nonce.',
    schema: z.object({ job_id: JOB_ID, manifest_id: MANIFEST_ID, approval_nonce: NONCE }).strict(),
    requiredScope: PUBLISH_SCOPE,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'get_installation_publish_status',
    title: 'Get installation publish status',
    description: 'Read the explicit per-destination status matrix for one job.',
    schema: z.object({ job_id: JOB_ID }).strict(),
    requiredScope: READ_SCOPE,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'retry_failed_destinations',
    title: 'Retry failed destinations',
    description: 'Create a destination-bound reapproval challenge, then retry only those transient failures.',
    schema: z.object({
      job_id: JOB_ID,
      manifest_id: MANIFEST_ID,
      approval_nonce: NONCE.optional(),
      destination_ids: z.array(z.string().min(1).max(80)).min(1).max(8),
    }).strict(),
    requiredScope: PUBLISH_SCOPE,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  },
]);

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolSecuritySchemes(definition, authentication = 'oauth') {
  if (authentication === 'none') return [{ type: 'noauth' }];
  return [{ type: 'oauth2', scopes: [definition.requiredScope] }];
}

function advertisedTool(definition, authentication) {
  const securitySchemes = toolSecuritySchemes(definition, authentication);
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema),
    annotations: definition.annotations,
    execution: { taskSupport: 'forbidden' },
    securitySchemes,
    _meta: { ...definition.meta, securitySchemes },
  };
}

export function createInstallationPostMcpServer({
  backend,
  actor,
  resourceMetadataUrl,
  authentication = 'oauth',
}) {
  if (!backend?.call) throw new Error('installation-post backend client is required');
  if (!actor?.sub) throw new Error('authenticated actor is required');
  if (!['oauth', 'none'].includes(authentication)) throw new Error('unsupported MCP authentication mode');
  const scopes = new Set(actor.scopes || []);
  const server = new McpServer({
    name: 'mounting-man-installation-posts',
    version: '0.1.0',
  }, {
    instructions: 'Use the immutable list, resolve, attach, preview, approve, publish, and status workflow. Never guess a job or treat website-only success as complete.',
  });
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema,
      annotations: definition.annotations,
      _meta: {
        ...definition.meta,
        securitySchemes: toolSecuritySchemes(definition, authentication),
      },
    }, async (args) => {
      if (!scopes.has(definition.requiredScope)) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'insufficient_scope' }) }],
          structuredContent: { error: 'insufficient_scope' },
          ...(resourceMetadataUrl ? {
            _meta: {
              'mcp/www_authenticate': [
                `Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope", error_description="The requested installation-post action requires an additional OAuth scope"`,
              ],
            },
          } : {}),
        };
      }
      return toolResult(await backend.call(definition.name, args, { verifiedActor: actor }));
    });
  }
  // MCP SDK 1.30.0 retains extension fields only under `_meta`. OpenAI's
  // authorization contract also requires `securitySchemes` at the top level,
  // so replace only tools/list with an explicit wire representation while
  // preserving the compatibility mirror and the SDK's validated call handler.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((definition) => advertisedTool(definition, authentication)),
  }));
  return server;
}

export function createOAuthVerifier({ issuer, jwksUrl, audience }) {
  if (!issuer || !jwksUrl || !audience) {
    throw new Error('remote MCP OAuth verifier is not fully configured');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async function verifyBearer(header) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
    if (!match) throw new Error('missing_bearer_token');
    const { payload } = await jwtVerify(match[1], jwks, { issuer, audience });
    const scopes = new Set(String(payload.scope || '').split(/\s+/).filter(Boolean));
    if (!payload.sub) throw new Error('missing_subject');
    return { sub: String(payload.sub), scopes: [...scopes] };
  };
}

function remoteConfiguration(env) {
  const config = {
    issuer: String(env.INSTALL_POST_MCP_OAUTH_ISSUER || '').replace(/\/+$/, ''),
    jwksUrl: String(env.INSTALL_POST_MCP_OAUTH_JWKS_URL || ''),
    audience: String(env.INSTALL_POST_MCP_OAUTH_AUDIENCE || ''),
    ownerSubject: String(env.INSTALL_POST_MCP_OWNER_SUBJECT || ''),
    resource: String(env.INSTALL_POST_MCP_RESOURCE_URL || '').replace(/\/+$/, ''),
    allowedHost: String(env.INSTALL_POST_MCP_ALLOWED_HOST || ''),
    port: Number(env.PORT || 3000),
  };
  if (!config.issuer || !config.jwksUrl || !config.audience || !config.ownerSubject || !config.resource
    || !config.allowedHost || !Number.isInteger(config.port) || config.port < 1) {
    throw new Error('remote MCP configuration is incomplete');
  }
  return config;
}

export function createRemoteMcpApp({ backend, env = process.env, verifyBearer } = {}) {
  const config = remoteConfiguration(env);
  const verify = verifyBearer || createOAuthVerifier(config);
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: [config.allowedHost] });
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.resource).toString();

  const protectedResourceMetadata = (_req, res) => res.json({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE, PUBLISH_SCOPE],
    bearer_methods_supported: ['header'],
  });
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

  app.post('/mcp', async (req, res) => {
    let actor;
    try {
      actor = await verify(req.headers.authorization);
    } catch {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      );
      return res.status(401).json({
        jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null,
      });
    }
    if (actor.sub !== config.ownerSubject) {
      return res.status(403).json({
        jsonrpc: '2.0', error: { code: -32003, message: 'Forbidden' }, id: null,
      });
    }
    const server = createInstallationPostMcpServer({ backend, actor, resourceMetadataUrl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
    return undefined;
  });
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
  return { app, config };
}

function backendFromEnvironment(env) {
  return createInstallationPostBackendClient({
    endpoint: String(env.INSTALL_POST_MCP_BACKEND_URL || ''),
    token: String(env.INSTALL_POST_MCP_BACKEND_TOKEN || ''),
  });
}

export async function main(env = process.env) {
  const backend = backendFromEnvironment(env);
  const { app, config } = createRemoteMcpApp({ backend, env });
  const listener = http.createServer(app);
  listener.listen(config.port, '0.0.0.0', () => {
    process.stderr.write(`Mounting Man installation-post MCP listening on ${config.port}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

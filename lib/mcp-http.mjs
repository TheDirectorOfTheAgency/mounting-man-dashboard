// Minimal Streamable HTTP / JSON-RPC MCP helpers for Grok custom connectors.
import crypto from 'crypto';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_MCP_PROTOCOL_VERSION = '2025-03-26';

export function headerValue(headers, name) {
  if (!headers) return undefined;
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return value;
  }
  return undefined;
}

export function timingSafeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) {
    return false;
  }
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractProvidedSecret(req) {
  const auth = headerValue(req?.headers, 'authorization');
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(\S+)/i);
    if (match) return match[1].trim();
  }
  const headerSecret = headerValue(req?.headers, 'x-mcp-secret');
  if (headerSecret) return String(headerSecret).trim();
  if (req?.query?.secret) return String(req.query.secret).trim();
  return '';
}

export function acceptedOperatorSecrets(env = process.env) {
  return [env.MCP_SQUARE_PAYROLL_SECRET, env.CRON_SECRET]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

export function isAuthorizedMcpRequest(req, env = process.env) {
  const provided = extractProvidedSecret(req);
  const accepted = acceptedOperatorSecrets(env);
  if (!provided || accepted.length === 0) return false;
  return accepted.some((secret) => timingSafeEqualString(provided, secret));
}

export function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function isJsonRpcRequest(body) {
  return Boolean(body && typeof body === 'object' && body.jsonrpc === '2.0' && body.method);
}

export function wantsEventStream(req) {
  const accept = String(headerValue(req?.headers, 'accept') || '');
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

export function negotiateProtocolVersion(requested) {
  if (MCP_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_MCP_PROTOCOL_VERSION;
}

export function parseToolArguments(params) {
  const raw = params?.arguments ?? params?.args ?? {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

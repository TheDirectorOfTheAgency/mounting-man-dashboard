import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  createCanonicalPreviewClient,
  createCompletePublisherClient,
} from '../../../lib/install-post-chatgpt-clients.mjs';
import { createWebflowPhotoStore } from '../../../lib/install-post-chatgpt-photo.mjs';
import {
  INSTALLATION_POST_TOOL_NAMES,
  createInstallationPostToolService,
} from '../../../lib/install-post-chatgpt-service.mjs';
import { getInstallPostStore } from '../../../lib/install-post-store.mjs';

const TOOL_NAMES = new Set(INSTALLATION_POST_TOOL_NAMES);

function authorized(header, expectedToken) {
  if (!expectedToken) return false;
  const supplied = String(header || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(String(expectedToken));
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifiedBackendActor(req, expectedToken, now = Date.now()) {
  if (!authorized(req.headers?.authorization, expectedToken)) return null;
  const issuedAt = Number(req.headers?.['x-install-post-issued-at']);
  const supplied = String(req.headers?.['x-install-post-signature'] || '');
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > 60_000 || !/^[0-9a-f]{64}$/.test(supplied)) {
    return null;
  }
  const body = JSON.stringify(req.body || {});
  const expected = createHmac('sha256', expectedToken).update(`${issuedAt}.${body}`).digest('hex');
  const left = Buffer.from(supplied, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const actor = req.body?.actor;
  const requestId = String(req.body?.requestId || '');
  if (!actor || typeof actor !== 'object' || typeof actor.sub !== 'string'
    || !actor.sub || actor.sub.length > 256 || !/^[0-9a-f-]{36}$/.test(requestId)) return null;
  return { sub: actor.sub, requestId };
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (/unavailable|failed/.test(String(error?.code || ''))) return 503;
  return 400;
}

export function createChatgptToolsHandler({
  service, backendToken, ownerSubject, claimRequest,
} = {}) {
  return async function chatgptToolsHandler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const verifiedActor = verifiedBackendActor(req, backendToken);
    if (!verifiedActor) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!ownerSubject) return res.status(503).json({ error: 'owner_subject_unavailable' });
    if (verifiedActor.sub !== ownerSubject) return res.status(403).json({ error: 'forbidden' });
    if (!claimRequest) return res.status(503).json({ error: 'request_replay_store_unavailable' });
    if (!await claimRequest(verifiedActor.requestId)) {
      return res.status(409).json({ error: 'replayed_request' });
    }
    if (!service) return res.status(503).json({ error: 'store_unavailable' });
    const tool = String(req.body?.tool || '');
    if (!TOOL_NAMES.has(tool) || typeof service[tool] !== 'function') {
      return res.status(400).json({ error: 'unsupported_tool' });
    }
    try {
      const result = await service[tool](req.body?.arguments || {}, { verifiedActor });
      return res.status(200).json({ result });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: String(error?.code || 'backend_operation_failed') });
    }
  };
}

export default async function handler(req, res) {
  const store = await getInstallPostStore();
  const service = store ? createInstallationPostToolService({
    store,
    photoStore: createWebflowPhotoStore({
      siteId: (process.env.WEBFLOW_SITE_ID || process.env.NEXT_PUBLIC_WEBFLOW_SITE_ID || '').trim(),
      token: (process.env.WEBFLOW_TOKEN || process.env.NEXT_PUBLIC_WEBFLOW_TOKEN || '').trim(),
    }),
    previewer: createCanonicalPreviewClient({
      endpoint: (process.env.INSTALL_POST_CANONICAL_PREVIEW_URL || '').trim(),
      token: (process.env.INSTALL_POST_CANONICAL_PREVIEW_TOKEN || '').trim(),
    }),
    dispatcher: createCompletePublisherClient({
      endpoint: (process.env.INSTALL_POST_COMPLETE_PUBLISHER_URL || '').trim(),
      token: (process.env.INSTALL_POST_COMPLETE_PUBLISHER_TOKEN || '').trim(),
    }),
    allowedFileHosts: String(process.env.INSTALL_POST_MCP_FILE_HOSTS || '')
      .split(',').map((entry) => entry.trim()).filter(Boolean),
    audit: { record: (entry) => store.saveChatgptAudit(entry) },
    // Hard-disabled in THE-144. A reviewed code change is required after OAuth,
    // durable audit storage, and complete-publisher parity are all proven.
    publishEnabled: false,
  }) : null;
  return createChatgptToolsHandler({
    service,
    backendToken: (process.env.INSTALL_POST_MCP_BACKEND_TOKEN || '').trim(),
    ownerSubject: (process.env.INSTALL_POST_MCP_OWNER_SUBJECT || '').trim(),
    claimRequest: (requestId) => store?.claimChatgptBackendRequest(requestId),
  })(req, res);
}

#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createInstallationPostMcpServer } from './server.mjs';

const REVISION = 'a'.repeat(64);
const MANIFEST_ID = `manifest_${'b'.repeat(64)}`;
const DESTINATIONS = Object.freeze([
  'website',
  'instagram',
  'linkedin',
  'facebook',
  'x',
  'reddit_primary',
  'reddit_samsung_frame_mounting',
  'google_business_profile',
]);

const JOBS = Object.freeze([
  {
    job_id: 'synthetic_job_susan_living',
    label: 'Susan Drive · Austin · 65-inch Samsung · fixed mount · $249 · synthetic · ref A1B2',
    revision: REVISION,
    state: 'AWAITING_PHOTO',
    seed: {
      'street-name': 'Susan Drive',
      city: 'Austin',
      'tv-brand': 'Samsung',
      'tv-size': '65-inch',
      'mount-type': 'fixed',
      subtotal: 249,
      synthetic: true,
    },
  },
  {
    job_id: 'synthetic_job_susan_bedroom',
    label: 'Susan Drive · Austin · 55-inch Samsung · tilt mount · $219 · synthetic · ref C3D4',
    revision: REVISION,
    state: 'AWAITING_PHOTO',
    seed: {
      'street-name': 'Susan Drive',
      city: 'Austin',
      'tv-brand': 'Samsung',
      'tv-size': '55-inch',
      'mount-type': 'tilt',
      subtotal: 219,
      synthetic: true,
    },
  },
]);

function shadowResult(result) {
  return { mode: 'SYNTHETIC_SHADOW', production_effects: false, ...result };
}

export function createSyntheticShadowBackend() {
  return {
    async call(name, args = {}) {
      if (name === 'list_pending_installations') return shadowResult({ jobs: JOBS });
      if (name === 'get_installation_job') {
        return shadowResult({ job: JOBS.find((job) => job.job_id === args.job_id) || null });
      }
      if (name === 'resolve_installation_reference') {
        const reference = String(args.reference || '').toLowerCase();
        const candidates = reference.includes('susan') ? JOBS : [];
        return shadowResult({
          status: candidates.length > 1 ? 'ambiguous' : candidates.length === 1 ? 'matched' : 'not_found',
          candidates,
        });
      }
      if (name === 'attach_installation_photo') {
        return shadowResult({
          status: 'FILE_ENVELOPE_RECEIVED_NO_FETCH',
          job_id: args.job_id,
          expected_revision: args.expected_revision,
          file_id: args.photo?.file_id,
        });
      }
      if (name === 'preview_installation_post') {
        return shadowResult({
          status: 'PREVIEW_ONLY',
          job_id: args.job_id,
          manifest_id: MANIFEST_ID,
          destinations: DESTINATIONS.map((id) => ({ id, status: 'PREVIEWED' })),
        });
      }
      if (name === 'get_installation_publish_status') {
        return shadowResult({
          job_id: args.job_id,
          overall: 'NOT_DISPATCHED',
          destinations: DESTINATIONS.map((id) => ({ id, status: 'NOT_DISPATCHED' })),
        });
      }
      if (name === 'publish_installation_everywhere' || name === 'retry_failed_destinations') {
        return shadowResult({ status: 'BLOCKED', reason: 'SYNTHETIC_SHADOW_PRODUCTION_DISABLED' });
      }
      throw new Error('unsupported_synthetic_tool');
    },
  };
}

export async function main(env = process.env) {
  if (env.INSTALL_POST_MCP_SYNTHETIC_ONLY !== '1') {
    throw new Error('synthetic shadow requires INSTALL_POST_MCP_SYNTHETIC_ONLY=1');
  }
  const server = createInstallationPostMcpServer({
    backend: createSyntheticShadowBackend(),
    actor: {
      sub: 'synthetic-shadow-owner',
      scopes: ['installation-posts:read', 'installation-posts:write', 'installation-posts:publish'],
    },
    authentication: 'none',
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

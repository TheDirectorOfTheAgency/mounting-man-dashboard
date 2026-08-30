#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://mounting-man-dashboard.vercel.app';
const DEFAULT_REPOSITORY = 'TheDirectorOfTheAgency/mounting-man-dashboard';
const WORKFLOW_FILE = 'publish-install-post.yml';
const SAFE_METADATA_RE = /^[A-Za-z0-9._-]{1,64}$/;

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function validateOptions(options) {
  const baseUrl = requiredText(options.baseUrl, 'base URL').replace(/\/$/, '');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('base URL must be a credential-free HTTPS origin');
  }

  const expectedCommit = requiredText(options.expectedCommit, 'expected commit');
  if (!/^[0-9a-f]{7,40}$/i.test(expectedCommit)) {
    throw new Error('expected commit must be a 7-40 character Git SHA');
  }

  const workerSecret = requiredText(options.workerSecret, 'worker secret');
  const workerId = requiredText(options.workerId, 'worker ID');
  const workerVersion = requiredText(options.workerVersion, 'worker version');
  if (!SAFE_METADATA_RE.test(workerId) || !SAFE_METADATA_RE.test(workerVersion)) {
    throw new Error('worker ID and version must contain only safe metadata characters');
  }

  const repository = requiredText(options.repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be owner/name');
  }

  return {
    baseUrl,
    expectedCommit,
    workerSecret,
    workerId,
    workerVersion,
    repository,
    githubToken: String(options.githubToken || '').trim(),
  };
}

async function safeJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

async function expectStatus(fetchImpl, url, options, expectedStatus, label) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', ...options });
  } catch (error) {
    throw new Error(`${label} request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${response.status}`);
  }
  return response;
}

export async function verifyInstallPostRelease(options = {}) {
  const config = validateOptions(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const healthResponse = await expectStatus(
    fetchImpl,
    `${config.baseUrl}/api/health`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    200,
    'health',
  );
  const health = await safeJson(healthResponse, 'health');
  const deployedCommit = String(health?.gitCommit || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(deployedCommit)) {
    throw new Error('deployment commit identity is missing or malformed');
  }
  if (deployedCommit !== config.expectedCommit.slice(0, deployedCommit.length)) {
    throw new Error('deployment commit mismatch');
  }
  if (String(health?.environment || '') !== 'production') {
    throw new Error('deployment is not production');
  }

  const githubHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'the-mounting-man-install-post-release-verifier',
  };
  if (config.githubToken) githubHeaders.Authorization = `Bearer ${config.githubToken}`;
  const workflowResponse = await expectStatus(
    fetchImpl,
    `https://api.github.com/repos/${config.repository}/actions/workflows/${WORKFLOW_FILE}`,
    { method: 'GET', headers: githubHeaders },
    200,
    'GitHub workflow',
  );
  const workflow = await safeJson(workflowResponse, 'GitHub workflow');
  if (workflow?.state !== 'active') throw new Error('publish workflow is not active');

  await expectStatus(
    fetchImpl,
    `${config.baseUrl}/api/install-post/gbp`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    401,
    'unauthenticated GBP pull',
  );

  const authHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.workerSecret}`,
  };
  const pullResponse = await expectStatus(
    fetchImpl,
    `${config.baseUrl}/api/install-post/gbp`,
    { method: 'GET', headers: authHeaders },
    200,
    'authenticated GBP pull',
  );
  const pull = await safeJson(pullResponse, 'authenticated GBP pull');
  if (!Array.isArray(pull?.pending) || !Number.isInteger(pull?.count)) {
    throw new Error('authenticated GBP pull returned an invalid queue envelope');
  }

  const heartbeatResponse = await expectStatus(
    fetchImpl,
    `${config.baseUrl}/api/install-post/gbp`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'heartbeat',
        workerId: config.workerId,
        version: config.workerVersion,
      }),
    },
    200,
    'GBP heartbeat',
  );
  const heartbeat = await safeJson(heartbeatResponse, 'GBP heartbeat');
  if (
    heartbeat?.ok !== true
    || heartbeat?.heartbeat?.workerId !== config.workerId
    || heartbeat?.heartbeat?.version !== config.workerVersion
    || !heartbeat?.heartbeat?.seenAt
  ) {
    throw new Error('GBP heartbeat returned an invalid receipt');
  }

  return {
    deployedCommit,
    environment: String(health.environment),
    workflowState: String(workflow.state),
    unauthenticatedGbpStatus: 401,
    authenticatedPull: true,
    heartbeat: true,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyInstallPostRelease({
    baseUrl: args['base-url'] || process.env.INSTALL_POST_API_BASE || DEFAULT_BASE_URL,
    expectedCommit: args['expected-commit'] || process.env.EXPECTED_DEPLOYMENT_COMMIT,
    workerSecret: process.env.INSTALL_POST_GBP_WORKER_SECRET,
    workerId: args['worker-id'] || process.env.INSTALL_POST_GBP_WORKER_ID || 'm1-gbp-01',
    workerVersion: args['worker-version'] || process.env.INSTALL_POST_GBP_WORKER_VERSION || 'unknown',
    repository: args.repository || process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    githubToken: process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`release verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

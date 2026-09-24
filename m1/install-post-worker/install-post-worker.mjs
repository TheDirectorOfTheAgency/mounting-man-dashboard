#!/usr/bin/env node
// M1 install-post publish worker (launchd com.themountingman.install-post-worker).
//
// One pass: claim the oldest READY_FOR_M1 job from the dashboard, verify the
// approved photo, run the canonical jewel-way-run publisher wrapper
//
//   run_fast_install_post.sh --seed-json <seed.json> --image <photo> --art-mode never
//
// read the live install page back, and report through the signed runner
// callback. It never forks fast_install_post.py, never dispatches GitHub
// Actions, never touches the GBP queue, and never posts to Reddit. GBP stays a
// paste pack the dashboard sends after PUBLISHED.
//
// Self-contained (Node builtins only) so the installer can copy it out of the
// repo. Nothing it logs carries the seed, the photo, or publisher output.

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAIM_PATH = '/api/install-post/m1/claim';
export const CALLBACK_PATH = '/api/install-post/runner/callback';
export const DEFAULT_API_BASE = 'https://mounting-man-dashboard.vercel.app';
export const DEFAULT_WRAPPER = '/Users/thedirector/jewel-way-run/bin/run_fast_install_post.sh';
// Under the dashboard's 15 minute stale-publish window, so a hung publisher is
// killed and reported before the card ages the job out on its own.
export const DEFAULT_PUBLISH_TIMEOUT_MS = 12 * 60 * 1000;

const STATUS = Object.freeze({
  PUBLISHED: 'PUBLISHED',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  BLOCKED: 'BLOCKED',
  INDETERMINATE: 'INDETERMINATE',
});
const LIVE_INSTALL_URL_RE = /https:\/\/(?:www\.)?themountingman\.com\/installations\/[a-z0-9-]+/gi;
const OUTPUT_TAIL_BYTES = 256 * 1024;
const IMAGE_EXTENSIONS = Object.freeze({
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function loadConfig(env = process.env) {
  const home = env.HOME || homedir();
  const stateDir = env.INSTALL_POST_M1_STATE_DIR
    || path.join(home, '.local/state/themountingman/install-post-worker');
  const timeout = Number(env.INSTALL_POST_M1_PUBLISH_TIMEOUT_MS);
  return {
    apiBase: String(env.INSTALL_POST_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, ''),
    secret: String(env.INSTALL_POST_RUNNER_SECRET || '').trim(),
    secretFile: env.INSTALL_POST_RUNNER_SECRET_FILE
      || path.join(home, '.config/themountingman/install-post-worker/runner-secret'),
    workerId: String(env.INSTALL_POST_M1_WORKER_ID || 'm1-publish-01').trim(),
    wrapper: env.INSTALL_POST_M1_PUBLISH_WRAPPER || DEFAULT_WRAPPER,
    stateDir,
    publishTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_PUBLISH_TIMEOUT_MS,
  };
}

async function resolveSecret(config) {
  if (config.secret) return config.secret;
  try {
    return (await readFile(config.secretFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Signed dashboard calls (same scheme as lib/install-post-dispatch.mjs)
// ---------------------------------------------------------------------------

export function signRequest({ secret, method, path: requestPath, body, timestamp }) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  const digest = createHash('sha256').update(payload).digest('hex');
  const canonical = [String(timestamp), String(method).toUpperCase(), String(requestPath), digest].join('.');
  return `v1=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

async function signedPost({ fetchImpl, apiBase, requestPath, body, secret, now }) {
  const timestamp = Math.floor(now() / 1000);
  const response = await fetchImpl(`${apiBase}${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-install-post-signature': signRequest({ secret, method: 'POST', path: requestPath, body, timestamp }),
      'x-install-post-timestamp': String(timestamp),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Publisher outcome
// ---------------------------------------------------------------------------

/** Last install-page URL the publisher printed, or ''. */
export function extractLiveUrl(output = '') {
  const matches = String(output).match(LIVE_INSTALL_URL_RE);
  return matches ? matches[matches.length - 1] : '';
}

export function slugFromLiveUrl(liveUrl = '') {
  const match = String(liveUrl).match(/\/installations\/([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function result(status, { message = '', liveUrl = '', publicStatus = 0, slug = '' } = {}) {
  const payload = { status };
  if (message) payload.message = message;
  if (liveUrl) payload.liveUrl = liveUrl;
  if (publicStatus) payload.publicStatus = publicStatus;
  if (slug) payload.slug = slug;
  payload.destinations = [{ name: 'website', status, detail: liveUrl || message }];
  return payload;
}

/**
 * Map one publisher run to a queue result.
 *
 * A page that reads back 200 is PUBLISHED no matter how the process exited,
 * because a retry would post the same Square job twice. Anything that might
 * have created a page without proving it is INDETERMINATE. Only a run that
 * failed with no page in sight is RETRYABLE_FAILURE.
 */
export function classifyPublisherOutcome({
  exitCode = null,
  timedOut = false,
  spawnError = '',
  liveUrl = '',
  publicStatus = 0,
} = {}) {
  const slug = slugFromLiveUrl(liveUrl);
  if (liveUrl && publicStatus === 200) {
    return result(STATUS.PUBLISHED, {
      liveUrl,
      publicStatus,
      slug,
      message: exitCode === 0 ? '' : `Publisher exited ${exitCode ?? 'abnormally'} after the page went live`,
    });
  }
  if (spawnError) {
    return result(STATUS.RETRYABLE_FAILURE, { message: `Publisher could not start (${spawnError})` });
  }
  if (timedOut) {
    return result(STATUS.INDETERMINATE, { message: 'Publisher timed out; the page may exist', slug });
  }
  if (liveUrl) {
    return result(STATUS.INDETERMINATE, {
      message: `Install page did not read back 200 (HTTP ${publicStatus || 0})`,
      slug,
    });
  }
  if (exitCode === 0) {
    return result(STATUS.INDETERMINATE, { message: 'Publisher exited 0 without a verifiable install URL' });
  }
  return result(STATUS.RETRYABLE_FAILURE, {
    message: `Publisher exited ${exitCode ?? 'abnormally'} before the page went live`,
  });
}

export function publisherArgs({ seedPath, imagePath }) {
  return ['--seed-json', seedPath, '--image', imagePath, '--art-mode', 'never'];
}

function publisherEnv(source = process.env) {
  const env = { ...source };
  delete env.INSTALL_POST_RUNNER_SECRET;
  return env;
}

function appendTail(buffer, chunk) {
  const next = Buffer.concat([buffer, chunk]);
  return next.length > OUTPUT_TAIL_BYTES ? next.subarray(next.length - OUTPUT_TAIL_BYTES) : next;
}

/** Run the wrapper, keep only a bounded output tail for URL extraction. */
export function spawnPublisher({ command, args, timeoutMs, env = publisherEnv() }) {
  return new Promise((resolve) => {
    let output = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ ...value, timedOut, output: output.toString('utf8') });
    };
    let killer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { output = appendTail(output, chunk); });
    child.stderr.on('data', (chunk) => { output = appendTail(output, chunk); });
    child.on('error', (error) => finish({ exitCode: null, spawnError: error.code || 'spawn_failed' }));
    child.on('close', (code) => finish({ exitCode: code, spawnError: '' }));
  });
}

async function verifyLivePage(liveUrl, { fetchImpl, sleep, attempts = 4, delayMs = 5_000 }) {
  let status = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(liveUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      status = response.status;
      if (status === 200) return 200;
    } catch {
      status = 0;
    }
    if (attempt < attempts - 1) await sleep(delayMs * (attempt + 1));
  }
  return status;
}

// ---------------------------------------------------------------------------
// One claimed job
// ---------------------------------------------------------------------------

function envelopeProblem(job) {
  if (!job?.jobId || !job?.revision || !job?.dispatchId) return 'Claim is missing jobId, revision, or dispatchId';
  if (job.artMode !== 'never') return 'Claim does not pin art mode never';
  if (!job.image?.hostedUrl || !/^[a-f0-9]{64}$/i.test(job.image?.sha256 || '')) {
    return 'Claim has no bound photo';
  }
  if (!job.seed || typeof job.seed !== 'object') return 'Claim has no seed';
  return '';
}

export async function publishClaimedJob(job, {
  config,
  fetchImpl,
  runPublisher,
  sleep,
}) {
  const problem = envelopeProblem(job);
  if (problem) return result(STATUS.BLOCKED, { message: problem });

  let photo;
  try {
    const response = await fetchImpl(job.image.hostedUrl, { signal: AbortSignal.timeout(60_000) });
    if (response.status !== 200) {
      return result(STATUS.RETRYABLE_FAILURE, { message: `Could not read the approved photo (HTTP ${response.status})` });
    }
    photo = Buffer.from(await response.arrayBuffer());
  } catch {
    return result(STATUS.RETRYABLE_FAILURE, { message: 'Could not read the approved photo' });
  }
  if (createHash('sha256').update(photo).digest('hex') !== job.image.sha256.toLowerCase()) {
    return result(STATUS.BLOCKED, { message: 'Approved photo digest does not match the stored asset' });
  }

  const workDir = path.join(config.stateDir, 'jobs', `${job.jobId}-${job.dispatchId}`);
  const extension = IMAGE_EXTENSIONS[String(job.image.contentType || '').toLowerCase()] || '.webp';
  const seedPath = path.join(workDir, 'seed.json');
  const imagePath = path.join(workDir, `photo${extension}`);
  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await writeFile(seedPath, `${JSON.stringify(job.seed, null, 2)}\n`, { mode: 0o600 });
    await writeFile(imagePath, photo, { mode: 0o600 });

    const run = await runPublisher({
      command: config.wrapper,
      args: publisherArgs({ seedPath, imagePath }),
      timeoutMs: config.publishTimeoutMs,
    });
    const liveUrl = extractLiveUrl(run.output);
    const publicStatus = liveUrl ? await verifyLivePage(liveUrl, { fetchImpl, sleep }) : 0;
    return classifyPublisherOutcome({
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      spawnError: run.spawnError,
      liveUrl,
      publicStatus,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Callback delivery (durable across runs)
// ---------------------------------------------------------------------------

function pendingDir(config) {
  return path.join(config.stateDir, 'pending-callbacks');
}

// A 409/404 means the dashboard already moved on (newer approval, other lease,
// job gone); resending can never succeed.
function callbackSettled(status) {
  return (status >= 200 && status < 300) || status === 404 || status === 409;
}

async function sendCallback(body, { config, secret, fetchImpl, now }) {
  try {
    const response = await signedPost({
      fetchImpl, apiBase: config.apiBase, requestPath: CALLBACK_PATH, body, secret, now,
    });
    return response.status;
  } catch {
    return 0;
  }
}

async function deliverCallback(body, deps) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    status = await sendCallback(body, deps);
    if (callbackSettled(status)) return { delivered: status >= 200 && status < 300, status };
    if (attempt < 2) await deps.sleep(2_000 * (attempt + 1));
  }
  const file = path.join(pendingDir(deps.config), `${body.jobId}-${body.dispatchId}.json`);
  await mkdir(pendingDir(deps.config), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(body), { mode: 0o600 });
  await rename(temp, file);
  return { delivered: false, status, parked: true };
}

async function flushPendingCallbacks(deps) {
  let names = [];
  try {
    names = (await readdir(pendingDir(deps.config))).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  let flushed = 0;
  for (const name of names) {
    const file = path.join(pendingDir(deps.config), name);
    let body;
    try {
      body = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      await rm(file, { force: true });
      continue;
    }
    if (callbackSettled(await sendCallback(body, deps))) {
      await rm(file, { force: true });
      flushed += 1;
    }
  }
  return flushed;
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      let alive = false;
      try {
        if (Number.isInteger(holder) && holder > 0) {
          process.kill(holder, 0);
          alive = true;
        }
      } catch (probe) {
        alive = probe.code === 'EPERM';
      }
      if (alive) return null;
      await rm(lockPath, { force: true });
    }
  }
  return null;
}

export async function runOnce({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  runPublisher = spawnPublisher,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  rescan = false,
  checkOnly = false,
} = {}) {
  const secret = await resolveSecret(config);
  if (!secret) return { status: 'misconfigured', reason: 'runner_secret_missing' };
  try {
    await access(config.wrapper, fsConstants.X_OK);
  } catch {
    return { status: 'misconfigured', reason: 'publisher_wrapper_not_executable' };
  }
  if (checkOnly) return { status: 'ok', reason: 'preflight_passed' };

  const release = await acquireLock(path.join(config.stateDir, 'worker.lock'));
  if (!release) return { status: 'skipped', reason: 'already_running' };

  const deps = { config, secret, fetchImpl, now, sleep };
  // Jobs parked before the dashboard's ready index existed only show up after
  // one rescan, so the first successful pass on a machine asks for it.
  const rescanMarker = path.join(config.stateDir, 'ready-index-rescanned');
  const firstPass = !(await access(rescanMarker).then(() => true, () => false));
  try {
    const flushed = await flushPendingCallbacks(deps);

    let claim;
    try {
      claim = await signedPost({
        fetchImpl,
        apiBase: config.apiBase,
        requestPath: CLAIM_PATH,
        body: { workerId: config.workerId, ...(rescan || firstPass ? { rescan: true } : {}) },
        secret,
        now,
      });
    } catch {
      return { status: 'claim_failed', httpStatus: 0, flushed };
    }
    if (claim.status !== 200) return { status: 'claim_failed', httpStatus: claim.status, flushed };
    if (firstPass) await writeFile(rescanMarker, `${new Date(now()).toISOString()}\n`, { mode: 0o600 });
    const job = claim.body?.job;
    if (!job) return { status: 'idle', flushed };

    let outcome;
    try {
      outcome = await publishClaimedJob(job, { config, fetchImpl, runPublisher, sleep });
    } catch (error) {
      outcome = result(STATUS.RETRYABLE_FAILURE, {
        message: `Worker failed before the publisher finished (${error?.code || error?.name || 'Error'})`,
      });
    }
    const delivery = await deliverCallback({
      jobId: job.jobId,
      revision: job.revision,
      dispatchId: job.dispatchId,
      result: outcome,
    }, deps);
    return {
      status: 'reported',
      jobId: job.jobId,
      state: outcome.status,
      delivered: delivery.delivered,
      ...(delivery.parked ? { parked: true } : {}),
      flushed,
    };
  } finally {
    await release();
  }
}

function formatStatus(summary) {
  return Object.entries(summary)
    .map(([key, value]) => `${key === 'status' ? 'worker_status' : key}=${value}`)
    .join(' ');
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  const args = new Set(process.argv.slice(2));
  runOnce({ rescan: args.has('--rescan'), checkOnly: args.has('--check') })
    .then((summary) => {
      console.log(formatStatus(summary));
      if (['misconfigured', 'claim_failed'].includes(summary.status)) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`worker_status=error type=${error?.name || 'Error'}`);
      process.exitCode = 1;
    });
}

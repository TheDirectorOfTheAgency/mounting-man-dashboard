// lib/install-post-dispatch.mjs
//
// Cloud handoff for an approved installation post.
//
// The workflow dispatch carries only an opaque job id, the approved revision,
// and a dispatch id. Everything else — seed, photo, credentials — is fetched by
// the runner from a signed internal endpoint, so no installation facts and no
// secrets appear in GitHub Actions inputs or logs.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'v1=';
const DEFAULT_TOLERANCE_SECONDS = 300;

function canonicalString({ method, path, body, timestamp }) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  const digest = createHash('sha256').update(payload).digest('hex');
  return [String(timestamp), String(method || '').toUpperCase(), String(path || ''), digest].join('.');
}

/** HMAC signature for a server↔runner request. */
export function signRunnerRequest({ secret, method, path, body, timestamp }) {
  if (!secret) throw new Error('install-post runner secret is not configured');
  const mac = createHmac('sha256', secret).update(canonicalString({ method, path, body, timestamp }));
  return `${SIGNATURE_PREFIX}${mac.digest('hex')}`;
}

/** Verify a runner request. Fails closed on bad signature, replay, or junk. */
export function verifyRunnerRequest({
  secret,
  signature,
  method,
  path,
  body,
  timestamp,
  now = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}) {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'malformed' };

  let expected;
  try {
    expected = signRunnerRequest({ secret, method, path, body, timestamp: seconds });
  } catch {
    return { ok: false, reason: 'unconfigured' };
  }
  const provided = String(signature || '');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (Math.abs(Math.floor(now / 1000) - seconds) > toleranceSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  return { ok: true };
}

/** Trigger the pinned publish workflow for one approved job revision. */
export function createGithubDispatcher({
  token,
  owner,
  repo,
  workflowFile = 'publish-install-post.yml',
  ref = 'main',
  sourceCommit,
  httpClient,
} = {}) {
  return {
    async dispatch({ jobId, revision, dispatchId }) {
      if (!token || !owner || !repo) {
        throw new Error('install-post cloud dispatch is not configured');
      }
      // The callback is authenticated against this id, so a run without one
      // could never report its outcome back.
      if (!jobId || !revision || !dispatchId) {
        throw new Error('install-post dispatch requires jobId, revision, and dispatchId');
      }
      const pinnedCommit = String(sourceCommit || '').trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(pinnedCommit)) {
        throw new Error('install-post source commit must be a full 40-character Git SHA');
      }
      const client = httpClient || (await import('axios')).default;
      await client.post(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
        {
          ref,
          inputs: {
            job_id: String(jobId),
            revision: String(revision),
            dispatch_id: String(dispatchId),
            source_commit: pinnedCommit,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          timeout: 20000,
        },
      );
      return { dispatchId };
    },
  };
}

/**
 * Current tip of GitHub `main` for this publisher repo.
 *
 * This is the only SHA the runner may check out. The last commit that touched
 * the workflow file can lag (Instagram JPEG lived in runner code while
 * publish-install-post.yml was unchanged). Vercel deployment SHAs can lag
 * further and must never be used as the checkout pin.
 */
export async function resolveGithubMainCommit({
  token,
  owner,
  repo,
  httpClient,
} = {}) {
  if (!token || !owner || !repo) {
    throw new Error('install-post cloud dispatch is not configured');
  }
  const client = httpClient || (await import('axios')).default;
  const response = await client.get(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 20000,
    },
  );
  const sha = String(response?.data?.object?.sha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('install-post source commit must be a full 40-character Git SHA');
  }
  return sha;
}

/** Production dispatcher: runner checkout is GitHub main, never a Vercel SHA. */
export function createConfiguredDispatcher({ httpClient } = {}) {
  const token = (process.env.INSTALL_POST_DISPATCH_TOKEN || '').trim();
  const owner = (process.env.INSTALL_POST_DISPATCH_OWNER || '').trim();
  const repo = (process.env.INSTALL_POST_DISPATCH_REPO || '').trim();
  const workflowFile = (process.env.INSTALL_POST_DISPATCH_WORKFLOW || 'publish-install-post.yml').trim();
  const ref = (process.env.INSTALL_POST_DISPATCH_REF || 'main').trim();

  return {
    async dispatch(payload) {
      const sourceCommit = await resolveGithubMainCommit({
        token,
        owner,
        repo,
        httpClient,
      });
      return createGithubDispatcher({
        token,
        owner,
        repo,
        workflowFile,
        ref,
        sourceCommit,
        httpClient,
      }).dispatch(payload);
    },
  };
}

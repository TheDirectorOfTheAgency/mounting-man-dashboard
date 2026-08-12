// Deployment-surface hardening for the cloud installation-post queue.
//
// The capability arrives in a URL fragment and is exchanged once for a session
// cookie, so no route path may be capability-shaped and nothing may carry the
// fragment off-origin. The cloud runner publishes to the live site, so its
// supply chain has to be immutable rather than tag-shaped.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = new URL('..', import.meta.url).pathname;

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function headerMap(entry) {
  return Object.fromEntries(entry.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

function routePaths(relativeDir) {
  const dir = new URL(`../${relativeDir}/`, import.meta.url);
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath || entry.path}/${entry.name}`.slice(dir.pathname.length));
}

// ---------------------------------------------------------------------------
// B3 — the capability must never appear in a path, a query, or a log
// ---------------------------------------------------------------------------

test('no installation-post route is parameterized by a capability', () => {
  for (const relativeDir of ['pages/install-posts', 'pages/api/install-post']) {
    for (const route of routePaths(relativeDir)) {
      assert.doesNotMatch(
        route,
        /\[/,
        `${relativeDir}/${route} puts a value in the URL path; the capability must ride in the fragment`,
      );
    }
  }
});

test('the card and its API send no referrer and are never cached or indexed', async () => {
  const nextConfig = require(`${repoRoot}next.config.js`);
  const entries = await nextConfig.headers();

  for (const source of ['/install-posts/:path*', '/api/install-post/:path*']) {
    const entry = entries.find((candidate) => candidate.source === source);
    assert.ok(entry, `no header rule for ${source}`);

    const headers = headerMap(entry);
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.match(headers['x-robots-tag'], /noindex/);
    assert.match(headers['cache-control'], /no-store/);
  }
});

test('the card markup itself suppresses referrers on navigations and images', () => {
  const page = read('pages/install-posts/open.js');

  assert.match(
    page,
    /<meta\s+name="referrer"\s+content="no-referrer"/,
    'the page needs a no-referrer meta as defence in depth',
  );
  assert.match(
    page,
    /<img[^>]*referrerPolicy="no-referrer"/s,
    'the installation photo is third-party hosted and would leak the page URL',
  );

  for (const match of page.matchAll(/<a\b[^>]*>/gs)) {
    assert.match(match[0], /rel="noreferrer noopener"/, `link leaks a referrer: ${match[0]}`);
  }
});

test('the card exchanges the fragment through a POST body and scrubs it at once', () => {
  const page = read('pages/install-posts/open.js');

  assert.match(page, /location\.hash/, 'the capability arrives in the fragment');
  assert.match(
    page,
    /history\.replaceState/,
    'the fragment must be scrubbed so a screenshot or a back button cannot resurface it',
  );
  assert.match(
    page,
    /postJson\(\s*'session',\s*\{\s*capability\s*\}\s*\)/,
    'the capability must be exchanged in a POST body, never in a URL',
  );
  assert.doesNotMatch(
    page,
    /\$\{capability\}/,
    'the capability must never be interpolated into a URL or any other string',
  );
  assert.match(
    page,
    /credentials:\s*'same-origin'/,
    'the session cookie must be the credential every API call carries',
  );
});

// ---------------------------------------------------------------------------
// B6 — the card must follow the job through to a terminal state
// ---------------------------------------------------------------------------

test('the card polls in-flight jobs and renders the verified URL', () => {
  const page = read('pages/install-posts/open.js');

  assert.match(page, /installPostPollDelayMs/, 'the card must reuse the shared poll policy');
  assert.match(page, /setTimeout|setInterval/, 'the card must schedule a refresh while in flight');
  assert.match(page, /result\.liveUrl/, 'the card must show the verified live URL');
  assert.match(page, /reconcile/, 'the card must offer the reconcile path for an unresolved run');
});

// ---------------------------------------------------------------------------
// B7 — the runner's supply chain must be immutable
// ---------------------------------------------------------------------------

test('every workflow action is pinned to an immutable commit SHA', () => {
  const workflow = read('.github/workflows/publish-install-post.yml');
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);

  assert.ok(uses.length > 0, 'expected the workflow to use actions');
  for (const ref of uses) {
    assert.match(ref, /^[^@]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit SHA`);
  }
});

test('runner dependencies are hash-pinned and installed in hash-checking mode', () => {
  const workflow = read('.github/workflows/publish-install-post.yml');
  assert.match(workflow, /pip install[^\n]*--require-hashes/, 'pip must run in hash-checking mode');
  assert.doesNotMatch(
    workflow,
    /--require-hashes=/,
    '--require-hashes is a flag; giving it a value makes pip fail',
  );

  const requirements = read('cloud/install-post-runner/requirements.txt');
  const pinned = [...requirements.matchAll(/^([A-Za-z0-9._-]+)==([^\s\\]+)/gm)].map((m) => m[1].toLowerCase());

  // Hash-checking mode fails unless *every* transitive dependency is pinned.
  for (const name of ['requests', 'certifi', 'charset-normalizer', 'idna', 'urllib3']) {
    assert.ok(pinned.includes(name), `${name} must be pinned for hash-checking mode`);
  }
  for (const name of pinned) {
    const block = requirements.slice(requirements.indexOf(`${name}==`));
    assert.match(block.split(/\n(?=[A-Za-z0-9])/)[0], /--hash=sha256:[0-9a-f]{64}/, `${name} has no hash`);
  }
});

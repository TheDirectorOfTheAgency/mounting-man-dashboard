import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

function source(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('zero-tap intake and cloud runner have no local shell publisher fallback', () => {
  const files = [
    'lib/install-post-auto-publish.mjs',
    'pages/api/install-post/upload.js',
    'pages/api/install-post/runner/callback.js',
    'cloud/install-post-runner/runner.py',
    '.github/workflows/publish-install-post.yml',
  ];
  const forbiddenExecutablePatterns = [
    /from\s+['"](?:node:)?child_process['"]/i,
    /require\(\s*['"](?:node:)?child_process['"]\s*\)/i,
    /\b(?:execFile|execSync|spawn|spawnSync)\s*\(/,
    /^\s*(?:import|from)\s+subprocess\b/m,
    /\bsubprocess\s*\./,
    /\bos\.system\s*\(/,
    /^\s*run:\s*.*(?:publish_one\.py|\bgo\.py)\b/im,
  ];
  for (const file of files) {
    const text = source(file);
    for (const pattern of forbiddenExecutablePatterns) {
      assert.doesNotMatch(text, pattern, `${file} contains an executable shell fallback`);
    }
  }
});

test('installation-post publishers contain no Reddit endpoint or client', () => {
  const files = [
    'cloud/install-post-runner/runner.py',
    'cloud/install-post-runner/publisher/social.py',
    '.github/workflows/publish-install-post.yml',
    'pages/api/install-post/runner/callback.js',
  ];
  const forbidden = [
    /https?:\/\/(?:www\.|oauth\.|old\.)?reddit\.com/i,
    /reddit\.com\/api\//i,
    /\bimport\s+praw\b/i,
    /\bReddit\s*\(/,
  ];
  for (const file of files) {
    const text = source(file);
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} contains Reddit publishing code`);
  }
});

test('release CI covers Node, build, cloud runner, and M1 worker with immutable actions', () => {
  const ciPath = join(ROOT, '.github/workflows/ci.yml');
  assert.equal(existsSync(ciPath), true, 'missing .github/workflows/ci.yml');
  const ci = readFileSync(ciPath, 'utf8');
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /pytest[^\n]*cloud\/install-post-runner\/tests|cloud\/install-post-runner\/tests/);
  assert.match(ci, /m1\/gbp-worker\/tests/);
  const actions = [...ci.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actions.length >= 3);
  for (const action of actions) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/i, `${action} is not pinned to a commit SHA`);
  }
});

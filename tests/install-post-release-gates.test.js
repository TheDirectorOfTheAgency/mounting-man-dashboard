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
  assert.match(ci, /--require-hashes --no-deps -r ci\/python-test-requirements\.txt/);
  assert.doesNotMatch(ci, /pip install pytest==/);
  const actions = [...ci.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actions.length >= 3);
  for (const action of actions) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/i, `${action} is not pinned to a commit SHA`);
  }
});

test('publisher workflow checks out the immutable cloud deployment commit', () => {
  const workflow = source('.github/workflows/publish-install-post.yml');
  assert.match(workflow, /source_commit:/);
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.source_commit\s*\}\}/);
  assert.match(workflow, /SOURCE_COMMIT:\s*\$\{\{\s*inputs\.source_commit\s*\}\}/);
  assert.doesNotMatch(workflow, /ref:\s*(?:main|master)\s*$/m);
});

test('M1 installer stamps the immutable build SHA into launchd', () => {
  const installer = source('scripts/install-gbp-worker-m1.sh');
  const plist = source('m1/gbp-worker/com.themountingman.gbp-worker.plist');
  assert.match(plist, /<key>INSTALL_POST_GBP_BUILD_SHA<\/key>/);
  assert.match(plist, /__INSTALL_POST_GBP_BUILD_SHA__/);
  assert.match(installer, /git[^\n]*rev-parse HEAD/);
  assert.match(installer, /INSTALL_POST_GBP_BUILD_SHA/);
  assert.match(installer, /PlistBuddy[^\n]*EnvironmentVariables:INSTALL_POST_GBP_BUILD_SHA/);
  assert.match(installer, /releases\/\$build_sha/);
  assert.match(installer, /restore_backup/);
  assert.match(installer, /bootstrap[^\n]*PLIST_DEST/);
  assert.match(installer, /Print :EnvironmentVariables:\$key/);
  assert.match(plist, /<key>INSTALL_POST_GBP_BUILD_SHA<\/key>\s*<string>__INSTALL_POST_GBP_BUILD_SHA__<\/string>/);
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(path.join(root, 'pages/accent-wall-visualizer.js'), 'utf8');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

function sourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      sourceFiles(full, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

test('accent-wall visualizer is a 410 page with no form and no provider call', () => {
  assert.match(pageSource, /res\.statusCode = 410/);
  assert.match(pageSource, /This tool has been retired/);
  assert.match(pageSource, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(pageSource, /<form[\s>]/i);
  assert.doesNotMatch(pageSource, /\bfetch\s*\(/);
  assert.doesNotMatch(pageSource, /\/api\/gemini/);
  assert.doesNotMatch(pageSource, /@google\/genai|generativelanguage|gemini-2\.5/i);
  assert.doesNotMatch(pageSource, /tmm-nationwide|ai-preview/i);
  assert.doesNotMatch(pageSource, /<button[\s>]/i);
  assert.doesNotMatch(pageSource, /<input[\s>]/i);
  assert.doesNotMatch(pageSource, /<textarea[\s>]/i);
});

test('no dashboard source calls or links the retired visualizer', () => {
  const geminiHits = [];
  const linkHits = [];
  const roots = ['pages', 'components', 'public', 'lib'].map((dir) => path.join(root, dir));

  for (const dir of roots) {
    for (const file of sourceFiles(dir)) {
      const rel = path.relative(root, file);
      if (rel === 'pages/api/gemini.js') continue;
      const text = readFileSync(file, 'utf8');
      if (/['"`]\/api\/gemini['"`]/.test(text)) geminiHits.push(rel);
      if (/href\s*=\s*['"][^'"]*accent-wall-visualizer/.test(text)) linkHits.push(rel);
    }
  }

  assert.deepEqual(geminiHits, []);
  assert.deepEqual(linkHits, []);
});

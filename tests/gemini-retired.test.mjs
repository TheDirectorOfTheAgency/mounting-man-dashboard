import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../pages/api/gemini.js';
test('legacy /api/gemini is retired with 410 and no provider call', async () => {
  let status, body; const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; }, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await handler({ method: 'POST', body: { action: 'generate-image', prompt: 'x', imageData: 'x', mimeType: 'image/png' } }, res);
  assert.equal(status, 410); assert.match(body.error, /retired/); assert.equal(headers['Cache-Control'], 'no-store');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOLD_REASONS,
  JEV_MODEL,
  JEV_NOUL_QUESTION,
  TYPESAFE_SYSTEM_ONE_URL,
  evaluateInstallPostConfidence,
  evaluateJevInstallPostConfidence,
  resolveInstallPostConfidence,
} from '../lib/install-post-confidence.mjs';

const WOODBURY_GABLE = {
  city: 'Woodbury',
  streetName: 'Gable Ln',
  seedCount: 1,
  tvSize: '65"',
};

test('clean Woodbury / Gable Ln PASSes the install-post confidence gate', () => {
  const result = evaluateInstallPostConfidence(WOODBURY_GABLE);
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Google blob street HOLDs', () => {
  const result = evaluateInstallPostConfidence({
    city: 'Woodbury',
    streetName: '4225 Gable Ln, Woodbury, MN 55129, USA',
    seedCount: 1,
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes(HOLD_REASONS.GOOGLE_BLOB_STREET));
  assert.equal(JSON.stringify(result.reasons).includes('4225'), false);
  assert.equal(JSON.stringify(result.reasons).includes('Woodbury'), false);
});

test('blank city HOLDs', () => {
  const missing = evaluateInstallPostConfidence({
    city: '',
    streetName: 'Gable Ln',
    seedCount: 1,
  });
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.reasons, [HOLD_REASONS.BLANK_CITY]);

  const absent = evaluateInstallPostConfidence({
    streetName: 'Gable Ln',
    seedCount: 1,
  });
  assert.equal(absent.pass, false);
  assert.ok(absent.reasons.includes(HOLD_REASONS.BLANK_CITY));
});

test('Twin Cities and metro placeholder cities HOLD', () => {
  for (const city of ['Twin Cities', 'twin cities', 'Metro Twin Cities', 'Metro', 'MSP']) {
    const result = evaluateInstallPostConfidence({
      city,
      streetName: 'Gable Ln',
      seedCount: 1,
    });
    assert.equal(result.pass, false, city);
    assert.deepEqual(result.reasons, [HOLD_REASONS.METRO_PLACEHOLDER_CITY], city);
  }
});

test('seedCount 2 HOLDs', () => {
  const result = evaluateInstallPostConfidence({
    ...WOODBURY_GABLE,
    seedCount: 2,
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, [HOLD_REASONS.SEED_COUNT]);
});

test('TypeSafe Jev is skipped when the API key is unset', async () => {
  const posts = [];
  const result = await evaluateJevInstallPostConfidence({
    ...WOODBURY_GABLE,
    apiKey: '',
    httpClient: {
      async post(url, body) {
        posts.push({ url, body });
        return { data: {} };
      },
    },
  });
  assert.equal(result.pass, true);
  assert.equal(result.skipped, 'missing_key');
  assert.equal(posts.length, 0);
});

test('TypeSafe Jev HOLDs when noul is false or confidence is below 0.7', async () => {
  const falseNoul = await evaluateJevInstallPostConfidence({
    ...WOODBURY_GABLE,
    apiKey: 'test-typesafe-key',
    httpClient: {
      async post() {
        return { data: { answers: { safe_to_auto_publish: { noul: false } } } };
      },
    },
  });
  assert.equal(falseNoul.pass, false);
  assert.deepEqual(falseNoul.reasons, [HOLD_REASONS.JEV_HOLD]);

  const lowConfidence = await evaluateJevInstallPostConfidence({
    ...WOODBURY_GABLE,
    apiKey: 'test-typesafe-key',
    httpClient: {
      async post() {
        return { data: { answers: { safe_to_auto_publish: { noul: 0.91, confidence: 0.4 } } } };
      },
    },
  });
  assert.equal(lowConfidence.pass, false);
  assert.deepEqual(lowConfidence.reasons, [HOLD_REASONS.JEV_HOLD]);
});

test('TypeSafe Jev fail-open on API error does not block a deterministic PASS', async () => {
  const jev = await evaluateJevInstallPostConfidence({
    ...WOODBURY_GABLE,
    apiKey: 'test-typesafe-key',
    httpClient: {
      async post() {
        const err = new Error('socket hang up');
        err.response = { status: 503 };
        throw err;
      },
    },
  });
  assert.equal(jev.pass, true);
  assert.equal(jev.skipped, 'api_error');

  const resolved = await resolveInstallPostConfidence(WOODBURY_GABLE, {
    apiKey: 'test-typesafe-key',
    httpClient: {
      async post() {
        throw new Error('offline');
      },
    },
  });
  assert.equal(resolved.pass, true);
  assert.deepEqual(resolved.reasons, []);
});

test('TypeSafe Jev request sends city/street/size only and never logs the key', async () => {
  const posts = [];
  const logs = [];
  await evaluateJevInstallPostConfidence({
    ...WOODBURY_GABLE,
    apiKey: 'super-secret-typesafe-key',
    logger: {
      warn(...args) { logs.push(args); },
    },
    httpClient: {
      async post(url, body, config) {
        posts.push({ url, body, headers: config?.headers || {} });
        return { data: { answers: { safe_to_auto_publish: { noul: 0.95 } } } };
      },
    },
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, TYPESAFE_SYSTEM_ONE_URL);
  assert.equal(posts[0].body.model, JEV_MODEL);
  assert.deepEqual(posts[0].body.state, {
    city: 'Woodbury',
    streetName: 'Gable Ln',
    tvSize: '65"',
  });
  assert.equal(posts[0].body.questions.safe_to_auto_publish.instructions, JEV_NOUL_QUESTION);
  assert.equal(JSON.stringify(posts[0].body).includes('super-secret-typesafe-key'), false);
  assert.equal(JSON.stringify(logs).includes('super-secret-typesafe-key'), false);
});

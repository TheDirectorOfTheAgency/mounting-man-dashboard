import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../pages/api/health.js';

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('health endpoint reports only safe deployment identity and pipeline mode', () => {
  const previous = {
    commit: process.env.VERCEL_GIT_COMMIT_SHA,
    environment: process.env.VERCEL_ENV,
    mode: process.env.OFFLINE_CONVERSION_MODE,
  };
  process.env.VERCEL_GIT_COMMIT_SHA = '988ac2366196cf0e7634eb90f8605017618f3746';
  process.env.VERCEL_ENV = 'production';
  process.env.OFFLINE_CONVERSION_MODE = 'observe';
  try {
    const res = response();
    handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      status: 'ok',
      gitCommit: '988ac2366196',
      environment: 'production',
      offlineConversionMode: 'observe',
    });
    assert.deepEqual(Object.keys(res.body).sort(), [
      'environment',
      'gitCommit',
      'offlineConversionMode',
      'status',
    ]);
  } finally {
    for (const [key, value] of Object.entries({
      VERCEL_GIT_COMMIT_SHA: previous.commit,
      VERCEL_ENV: previous.environment,
      OFFLINE_CONVERSION_MODE: previous.mode,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('health endpoint defaults safely and rejects non-GET methods', () => {
  const previous = {
    commit: process.env.VERCEL_GIT_COMMIT_SHA,
    environment: process.env.VERCEL_ENV,
    mode: process.env.OFFLINE_CONVERSION_MODE,
  };
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.VERCEL_ENV;
  delete process.env.OFFLINE_CONVERSION_MODE;
  try {
    const getRes = response();
    handler({ method: 'GET' }, getRes);
    assert.deepEqual(getRes.body, {
      status: 'ok',
      gitCommit: 'unknown',
      environment: 'local',
      offlineConversionMode: 'observe',
    });

    const postRes = response();
    handler({ method: 'POST' }, postRes);
    assert.equal(postRes.statusCode, 405);
    assert.deepEqual(postRes.body, { error: 'Method not allowed' });
  } finally {
    for (const [key, value] of Object.entries({
      VERCEL_GIT_COMMIT_SHA: previous.commit,
      VERCEL_ENV: previous.environment,
      OFFLINE_CONVERSION_MODE: previous.mode,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

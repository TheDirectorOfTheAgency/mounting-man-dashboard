import assert from 'node:assert/strict';
import test from 'node:test';

import axios from 'axios';
import handler from '../pages/api/webflow-posts.js';

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

test('webflow counts are cached in memory for a warm instance', async () => {
  const original = axios.get;
  const previousToken = process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;
  const previousCollection = process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID;
  let calls = 0;
  process.env.NEXT_PUBLIC_WEBFLOW_TOKEN = 'test-token';
  process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID = 'collection';
  axios.get = async () => {
    calls += 1;
    return {
      data: {
        items: [
          { isDraft: false, isArchived: false },
          { isDraft: true, isArchived: false },
        ],
      },
    };
  };

  try {
    const first = response();
    await handler({ method: 'GET' }, first);
    const second = response();
    await handler({ method: 'GET' }, second);

    assert.equal(calls, 1);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.published, 1);
    assert.equal(first.body.draft, 1);
    assert.equal(first.body.archived, 0);
    assert.equal(first.body.total, 2);
    assert.deepEqual(second.body, first.body);
  } finally {
    axios.get = original;
    if (previousToken === undefined) delete process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;
    else process.env.NEXT_PUBLIC_WEBFLOW_TOKEN = previousToken;
    if (previousCollection === undefined) delete process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID;
    else process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID = previousCollection;
  }
});

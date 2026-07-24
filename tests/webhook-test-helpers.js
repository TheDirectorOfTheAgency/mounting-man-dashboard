export function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

export function completedPayload(overrides = {}) {
  return {
    event: 'job.completed',
    data: {
      id: 'test-job-123',
      status: 'completed',
      created_by: 'customer',
      completed_at: '2026-07-09T18:30:00-05:00',
      invoice: { total: 499.5 },
      customer: {
        id: 'test-customer-123',
        email: 'test.person@example.com',
        phone: '6125550100',
        first_name: 'Test',
        last_name: 'Person',
      },
      tracking: { utm_source: 'google', utm_medium: 'cpc' },
      service_address: {
        line1: '100 Test Ave',
        city: 'Minneapolis',
        state: 'MN',
        postal_code: '55401',
      },
      ...overrides,
    },
  };
}

export function createRequest(payload, overrides = {}) {
  return {
    method: 'POST',
    query: { secret: 'test-webhook-secret' },
    headers: { event: 'job.completed' },
    body: payload,
    ...overrides,
  };
}

export function installTestEnvironment() {
  const previous = { ...process.env };
  Object.assign(process.env, {
    ZENBOOKER_WEBHOOK_SECRET: 'test-webhook-secret',
    GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID: '7509313857',
    GOOGLE_ADS_CLIENT_ID: 'test-client',
    GOOGLE_ADS_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'test-refresh',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'test-developer-token',
  });
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  };
}

export function mockGoogleAxios(t, axios, behavior) {
  const uploads = [];
  let uploadCalls = 0;
  t.mock.method(axios, 'post', async (url, payload) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { data: { access_token: 'test-access-token' } };
    }
    uploads.push({ url, payload });
    uploadCalls += 1;
    return behavior({ url, payload, uploadCalls });
  });
  return { uploads, get uploadCalls() { return uploadCalls; } };
}

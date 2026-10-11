import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/tmm-source-v1.js', import.meta.url), 'utf8');

function element(tag, attrs) {
  const node = {
    tagName: tag,
    attrs: { ...attrs },
    getAttribute(name) { return this.attrs[name] || null; },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
  return node;
}

function runSnippet({ url, nodes = [] }) {
  const parsed = new URL(url);
  const store = {};
  const fetchCalls = [];
  const list = nodes.map((node) => element(node.tag, node.attrs));
  const document = {
    referrer: '',
    cookie: '',
    documentElement: {},
    querySelectorAll() { return list; },
  };
  const window = {
    location: {
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      href: parsed.href,
    },
    document,
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
  };
  window.window = window;
  vm.runInNewContext(source, {
    window,
    document,
    location: window.location,
    URL,
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    fetch: (requestUrl, options) => {
      fetchCalls.push({ url: requestUrl, options });
      return Promise.resolve({ ok: true, json: async () => ({ captured: true }) });
    },
    MutationObserver: undefined,
    Uint8Array,
    Date,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
  });
  return { fetchCalls, store, nodes: list, cookie: document.cookie };
}

test('pages.dev does nothing and www.themountingman.com still records the visit', () => {
  const booking = 'https://widget.zenbooker.com/book/1680240992578x344708259820302200?embed=true';
  const blocked = runSnippet({
    url: 'https://preview.pages.dev/?utm_source=google&utm_medium=cpc',
    nodes: [{ tag: 'A', attrs: { href: booking } }],
  });
  assert.deepEqual(blocked.store, {});
  assert.equal(blocked.cookie, '');
  assert.equal(blocked.nodes[0].getAttribute('href'), booking);
  assert.equal(blocked.fetchCalls.length, 0);

  const live = runSnippet({
    url: 'https://www.themountingman.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp',
    nodes: [{ tag: 'A', attrs: { href: booking } }],
  });
  assert.equal(typeof live.store.tmm_source_v1, 'string');
  assert.match(live.nodes[0].getAttribute('href'), /booking_session=tmm_[a-f0-9]{32}/);
  assert.equal(live.fetchCalls.length, 1);
});

test('the snippet decorates ZenBooker links with booking_session and posts the touch', () => {
  const { fetchCalls, nodes } = runSnippet({
    url: 'https://www.themountingman.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp',
    nodes: [
      { tag: 'A', attrs: { href: 'https://widget.zenbooker.com/book/1680240992578x344708259820302200?embed=true' } },
      { tag: 'IFRAME', attrs: { src: 'https://widget.zenbooker.com/book/1680240992578x344708259820302200?embed=true' } },
      { tag: 'A', attrs: { href: 'https://www.themountingman.com/about' } },
    ],
  });
  assert.match(nodes[0].getAttribute('href'), /booking_session=tmm_[a-f0-9]{32}/);
  assert.match(nodes[1].getAttribute('src'), /booking_session=tmm_[a-f0-9]{32}/);
  assert.equal(nodes[2].getAttribute('href'), 'https://www.themountingman.com/about');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/attribution\/visit$/);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.last.utmSource, 'google');
  assert.equal(body.last.utmMedium, 'organic');
  assert.equal(body.last.utmCampaign, 'gbp');
  assert.equal(body.customer_id, undefined);
  assert.equal(JSON.stringify(body).includes('email'), false);
  assert.equal(fetchCalls[0].options.credentials, 'omit');
});

test('thank-you posts ZenBooker booking_session and customer id, not a contact field', () => {
  const { fetchCalls } = runSnippet({
    url: 'https://www.themountingman.com/thank-you?customer_id=cust-1&booking_session=zb-session-1',
    nodes: [{ tag: 'SCRIPT', attrs: { src: 'https://cdn.zenbooker.com/widget/latest/zenbooker.js' } }],
  });
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.booking_session, 'zb-session-1');
  assert.equal(body.customer_id, 'cust-1');
  assert.equal(Object.hasOwn(body, 'email'), false);
  assert.equal(Object.hasOwn(body, 'phone'), false);
});

test('a page with no booking surface does not post', () => {
  const { fetchCalls } = runSnippet({
    url: 'https://www.themountingman.com/about',
  });
  assert.equal(fetchCalls.length, 0);
});

test('source text does not read contact fields or log them', () => {
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /customer_email|customer_phone|localStorage\.getItem\('email'/);
  assert.match(source, /booking_session/);
  assert.match(source, /\/api\/attribution\/visit/);
});

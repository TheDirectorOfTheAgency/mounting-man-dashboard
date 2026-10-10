(function () {
  'use strict';

  if (window.__tmmSourceV1) return;
  window.__tmmSourceV1 = true;

  var STORAGE_KEY = 'tmm_source_v1';
  var COOKIE = 'tmm_source_v1';
  var MAX_AGE = 90 * 24 * 60 * 60;
  var VISIT_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/visit';
  var SELF = {
    'themountingman.com': 1,
    'www.themountingman.com': 1,
    'themountingmanusa.com': 1,
    'www.themountingmanusa.com': 1,
    'themountingman.webflow.io': 1,
    'mounting-man-dashboard.vercel.app': 1
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function clip(value, max) {
    return String(value || '').trim().slice(0, max);
  }

  function cleanClass(value) {
    return clip(value, 80).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64);
  }

  function cleanClick(value) {
    var text = clip(value, 512);
    if (!text || /\s/.test(text) || text.indexOf('@') >= 0) return '';
    return text;
  }

  function cleanPath(value) {
    var text = clip(value, 200);
    if (!text || text.indexOf('@') >= 0 || text.indexOf('://') >= 0) return '';
    return text;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function pathOf(url) {
    try {
      return new URL(url).pathname || '';
    } catch (_) {
      return '';
    }
  }

  function isSelfHost(host) {
    if (!host) return false;
    if (SELF[host]) return true;
    return host.endsWith('.themountingman.com')
      || host.endsWith('.themountingmanusa.com')
      || host.endsWith('.zenbooker.com')
      || host === 'zenbooker.com';
  }

  function readCookie() {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (part.indexOf(COOKIE + '=') === 0) {
        try {
          return JSON.parse(decodeURIComponent(part.slice(COOKIE.length + 1)));
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  function writeCookie(state) {
    var body = encodeURIComponent(JSON.stringify({
      sessionId: state.sessionId,
      first: state.first,
      last: state.last,
      savedAt: state.savedAt
    }));
    if (body.length > 3500) {
      body = encodeURIComponent(JSON.stringify({ sessionId: state.sessionId, savedAt: state.savedAt }));
    }
    document.cookie = COOKIE + '=' + body + '; Max-Age=' + MAX_AGE + '; Path=/; SameSite=Lax; Secure';
  }

  function loadState() {
    var fromStore = null;
    try { fromStore = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
    var fromCookie = null;
    try { fromCookie = readCookie(); } catch (_) {}
    var state = fromStore && fromStore.sessionId ? fromStore : fromCookie;
    if (!state || !state.sessionId) return null;
    if (state.savedAt && Date.now() - Date.parse(state.savedAt) > MAX_AGE * 1000) return null;
    return state;
  }

  function saveState(state) {
    state.savedAt = nowIso();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    try { writeCookie(state); } catch (_) {}
  }

  function newSessionId() {
    var bytes = new Uint8Array(16);
    var cryptoApi = window.crypto;
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    var hex = '';
    for (var j = 0; j < bytes.length; j += 1) hex += bytes[j].toString(16).padStart(2, '0');
    return 'tmm_' + hex;
  }

  function currentTouch() {
    var params = new URLSearchParams(window.location.search);
    var referrer = '';
    try { referrer = document.referrer || ''; } catch (_) {}
    var referrerHost = hostOf(referrer);
    if (isSelfHost(referrerHost)) referrerHost = '';
    return {
      landingPath: cleanPath(window.location.pathname || '/'),
      referrerHost: referrerHost,
      referrerPath: referrerHost ? cleanPath(pathOf(referrer)) : '',
      utmSource: cleanClass(params.get('utm_source')),
      utmMedium: cleanClass(params.get('utm_medium')),
      utmCampaign: cleanClass(params.get('utm_campaign')),
      gclid: cleanClick(params.get('gclid')),
      gbraid: cleanClick(params.get('gbraid')),
      wbraid: cleanClick(params.get('wbraid')),
      at: nowIso()
    };
  }

  function meaningful(touch) {
    return Boolean(
      touch.gclid || touch.gbraid || touch.wbraid
      || touch.utmSource || touch.utmMedium || touch.utmCampaign
      || touch.referrerHost
    );
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,200}$/.test(value);
  }

  function isBookingUrl(raw) {
    try {
      var url = new URL(raw, window.location.href);
      var host = url.hostname.toLowerCase();
      if (host === 'zenbooker.com' || host.endsWith('.zenbooker.com')) return true;
      if ((host === 'themountingman.com' || host.endsWith('.themountingman.com')
        || host === 'themountingmanusa.com' || host.endsWith('.themountingmanusa.com'))
        && /\/book\/?$/.test(url.pathname)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function withSession(raw, sessionId) {
    try {
      var url = new URL(raw, window.location.href);
      if (!isBookingUrl(url.href)) return raw;
      if (validId(url.searchParams.get('booking_session'))) return raw;
      url.searchParams.set('booking_session', sessionId);
      return url.toString();
    } catch (_) {
      return raw;
    }
  }

  function decorate(sessionId) {
    var nodes = document.querySelectorAll('a[href], iframe[src]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.tagName === 'A') {
        var href = node.getAttribute('href');
        if (!href) continue;
        var next = withSession(href, sessionId);
        if (next !== href) node.setAttribute('href', next);
      }
      if (node.tagName === 'IFRAME') {
        var src = node.getAttribute('src');
        if (!src) continue;
        var frame = withSession(src, sessionId);
        if (frame !== src) node.setAttribute('src', frame);
      }
    }
  }

  function bookingSurface() {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/book' || path === '/thank-you') return true;
    var nodes = document.querySelectorAll('a[href], iframe[src], script[src]');
    for (var i = 0; i < nodes.length; i += 1) {
      var value = nodes[i].getAttribute('href') || nodes[i].getAttribute('src') || '';
      if (isBookingUrl(value) || value.indexOf('zenbooker') >= 0) return true;
    }
    return false;
  }

  function postVisit(sessionId, state, customerId) {
    if (!sessionId || typeof fetch !== 'function') return;
    var body = {
      booking_session: sessionId,
      first: state.first,
      last: state.last
    };
    if (customerId) body.customer_id = customerId;
    fetch(VISIT_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () {});
  }

  try {
    var params = new URLSearchParams(window.location.search);
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    var thankYou = path === '/thank-you';
    var state = loadState() || { sessionId: newSessionId(), first: null, last: null };
    var touch = currentTouch();
    if (!state.first) {
      state.first = touch;
      state.last = touch;
    } else if (meaningful(touch)) {
      state.last = touch;
    }
    if (!thankYou) {
      var fromLink = params.get('booking_session');
      if (validId(fromLink)) state.sessionId = fromLink;
    }
    saveState(state);
    decorate(state.sessionId);
    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () { decorate(state.sessionId); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (bookingSurface()) {
      var zbSession = thankYou ? params.get('booking_session') : '';
      var sessionForPost = validId(zbSession) ? zbSession : state.sessionId;
      var customerId = thankYou && validId(params.get('customer_id')) ? params.get('customer_id') : '';
      postVisit(sessionForPost, state, customerId);
      if (thankYou && validId(zbSession)) {
        state.sessionId = newSessionId();
        saveState(state);
      }
    }
  } catch (_) {}
})();

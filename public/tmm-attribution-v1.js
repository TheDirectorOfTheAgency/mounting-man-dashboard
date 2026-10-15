(function () {
  'use strict';

  var STORAGE_KEY = 'tmm_paid_attribution_v1';
  var CAPTURE_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/booking';
  var IDENTITY_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/booking-identity';
  var IDENTITY_TIMEOUT_MS = 3700;
  var PAGE_CONFIRM_MS = 4500;
  var CAPTURE_WAIT_MS = 800;
  var SENT_KEY = 'tmm_attribution_sent_v1';
  var RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var params = new URLSearchParams(window.location.search);

  /* PII-CORE-BEGIN (keep byte-identical in public/tmm-attribution-v1.js and lib/attribution-sanitize.js) */
  var PII_MAX_ROUNDS = 6;
  var PII_ENTITIES = { commat: '@', period: '.', plus: '+', percnt: '%', lowbar: '_', hyphen: '-', dash: '-', colon: ':', verbar: '|', vert: '|', num: '#', sol: '/', amp: '&', nbsp: ' ', quot: '"', apos: "'", lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', semi: ';', comma: ',', excl: '!', quest: '?', equals: '=', dollar: '$', ast: '*', midast: '*', tilde: '~' };

  function piiNfkc(text) {
    return typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
  }

  function piiCodePoint(code) {
    if (!(code >= 0 && code <= 0x10ffff)) return '';
    try { return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code); } catch (_) { return ''; }
  }

  // One decoding pass over every encoding we know: NFKC (full-width %, @,
  // digits), HTML entities, JS/CSS unicode escapes, plus-as-space and
  // percent-encoding (tolerant of malformed sequences).
  function piiDecodeOnce(text) {
    var out = piiNfkc(text);
    out = out.replace(/&#x([0-9a-f]{1,6});?/gi, function (m, hex) { return piiCodePoint(parseInt(hex, 16)); });
    out = out.replace(/&#([0-9]{1,7});?/g, function (m, dec) { return piiCodePoint(parseInt(dec, 10)); });
    out = out.replace(/&([a-z]{2,8});/gi, function (m, name) {
      var key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(PII_ENTITIES, key) ? PII_ENTITIES[key] : m;
    });
    out = out.replace(/\\u\{([0-9a-f]{1,6})\}/gi, function (m, hex) { return piiCodePoint(parseInt(hex, 16)); });
    out = out.replace(/\\u([0-9a-f]{4})/gi, function (m, hex) { return piiCodePoint(parseInt(hex, 16)); });
    out = out.replace(/\\x([0-9a-f]{2})/gi, function (m, hex) { return piiCodePoint(parseInt(hex, 16)); });
    out = out.replace(/\\([0-9a-f]{2,6}) ?/gi, function (m, hex) { return piiCodePoint(parseInt(hex, 16)); });
    out = out.replace(/\+/g, ' ');
    try {
      out = decodeURIComponent(out);
    } catch (_) {
      out = out.replace(/%([0-9a-f]{2})/gi, function (m, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    }
    return piiNfkc(out);
  }

  // Bounded repeated decoding to a fixed point, then lower-case and fold
  // look-alike at-signs ("(at)", "[at]", "{at}", "﹫", "＠") to "@".
  function piiCanonical(value) {
    var text = String(value == null ? '' : value);
    for (var round = 0; round < PII_MAX_ROUNDS; round += 1) {
      var next = piiDecodeOnce(text);
      if (next === text) break;
      text = next;
    }
    text = piiNfkc(text).toLowerCase();
    text = text.replace(/[\uFE6B\uFF20\u0040]/g, '@');
    text = text.replace(/\s*[\(\[\{<]\s*(?:at|@)\s*[\)\]\}>]\s*/g, '@');
    text = text.replace(/[\s_-]+at[\s_-]+(?=[a-z0-9-]+\s*(?:\.|[\(\[\{]\s*dot\s*[\)\]\}]|[\s_-]+dot[\s_-]+)\s*[a-z]{2,})/g, '@');
    return text;
  }

  function piiHasEmailShape(text) {
    return text.indexOf('@') >= 0;
  }

  function piiHasPhoneShape(text) {
    // Strip ALL non-alphanumerics (: | ; ~ . - space, etc.) before counting digits.
    return /[0-9]{7,}/.test(text.replace(/[^a-z0-9]/g, ''));
  }

  // True when a value could carry an email address or phone number, or still
  // contains an encoding we could not resolve within the decode budget.
  function piiLooksPersonal(value) {
    var raw = String(value == null ? '' : value);
    var text = piiCanonical(raw);
    if (piiHasEmailShape(text) || piiHasPhoneShape(text)) return true;
    if (/%[0-9a-f]{2}|&#|\\u|\\x/i.test(text)) return true;
    return /[^\x20-\x7e]/.test(text);
  }

  function piiCleanClass(value) {
    if (value == null || value === '' || piiLooksPersonal(value)) return null;
    var cleaned = piiCanonical(value).replace(/^\s+|\s+$/g, '').replace(/[^a-z0-9_.-]/g, '').slice(0, 64);
    if (!cleaned || piiLooksPersonal(cleaned)) return null;
    return cleaned;
  }

  // Route template: no query/fragment; non-slug, personal-looking or
  // long-token segments become ":x"; digit-heavy segments ":n".
  function piiLandingTemplate(pathname) {
    if (typeof pathname !== 'string' || !pathname) return null;
    var decoded = piiCanonical(pathname.split(/[?#]/)[0]).split(/[?#]/)[0];
    if (decoded.charAt(0) !== '/') return null;
    var segments = decoded.split('/').filter(Boolean);
    if (segments.length > 6) return null;
    var out = segments.map(function (segment) {
      if (piiLooksPersonal(segment)) return ':x';
      if (segment.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return ':x';
      if (segment.split('-').some(function (part) { return part.length > 24; })) return ':x';
      if ((segment.match(/[0-9]/g) || []).length >= 5) return ':n';
      return segment;
    });
    if (piiLooksPersonal('/' + out.join('/'))) {
      for (var i = 0; i < out.length; i += 1) if (/[0-9]/.test(out[i])) out[i] = ':n';
      if (piiLooksPersonal('/' + out.join('/'))) return null;
    }
    return ('/' + out.join('/') + (out.length && /\/$/.test(decoded) ? '/' : '')).slice(0, 200);
  }

  // Host only, validated hostname, nothing personal-looking.
  function piiReferrerHost(value) {
    if (typeof value !== 'string' || !value.replace(/\s/g, '')) return null;
    var raw = value.replace(/^\s+|\s+$/g, '');
    if (raw === 'self') return 'self';
    var host = raw.toLowerCase();
    var scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(host);
    if (scheme) {
      var rest = host.slice(scheme[0].length);
      var authority = rest.split(/[\/?#]/)[0];
      if (authority.indexOf('@') >= 0 || piiCanonical(authority).indexOf('@') >= 0) return null;
      host = authority.split(':')[0];
    }
    host = host.replace(/\.$/, '');
    if (piiLooksPersonal(host)) return null;
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
  }
  /* PII-CORE-END */

  function cleanClass(value) {
    return piiCleanClass(value) || '';
  }

  function landingTemplate(pathname) {
    return piiLandingTemplate(String(pathname || '/'));
  }

  function clickValue(name) {
    if (!params.has(name)) return '';
    return String(params.get(name) || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 512);
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function readPaidAcquisition() {
    var marker = params.has('gclid')
      ? 'gclid'
      : params.has('gbraid')
        ? 'gbraid'
        : params.has('wbraid')
          ? 'wbraid'
          : null;
    var medium = cleanClass(params.get('utm_medium'));
    if (!marker && ['cpc', 'paid', 'paid_search', 'paidsearch', 'ppc', 'sem'].indexOf(medium) >= 0) {
      marker = 'paid_medium';
    }
    if (!marker) return null;

    return {
      paidMarker: marker,
      sourceClass: cleanClass(params.get('utm_source')) || (marker === 'gclid' ? 'google' : null),
      mediumClass: medium || (marker === 'gclid' ? 'cpc' : null),
      hasCampaign: params.has('utm_campaign'),
      hasLandingContext: true,
      gclid: marker === 'gclid' ? clickValue('gclid') : '',
      gbraid: marker === 'gbraid' ? clickValue('gbraid') : '',
      wbraid: marker === 'wbraid' ? clickValue('wbraid') : '',
    };
  }

  // Non-personal landing context only: host of the referrer, the landing path
  // (no query string), UTM classes and click ids. Never names, emails or phones.
  function referrerHost() {
    try {
      var ref = typeof document !== 'undefined' ? document.referrer : '';
      if (!ref) return '';
      var host = new URL(ref).hostname.toLowerCase();
      var own = String((window.location && window.location.hostname) || '').toLowerCase().replace(/^www\./, '');
      var bare = host.replace(/^www\./, '');
      if (own && (bare === own || bare.slice(-own.length - 1) === '.' + own)) return 'self';
      return piiReferrerHost(host) || '';
    } catch (_) {
      return '';
    }
  }

  function readLandingAcquisition() {
    var paid = readPaidAcquisition();
    var acquisition = paid || {
      paidMarker: null,
      sourceClass: cleanClass(params.get('utm_source')) || null,
      mediumClass: cleanClass(params.get('utm_medium')) || null,
      hasCampaign: params.has('utm_campaign'),
      hasLandingContext: true,
      gclid: '',
      gbraid: '',
      wbraid: '',
    };
    acquisition.campaignClass = cleanClass(params.get('utm_campaign')) || null;
    acquisition.referrerHost = referrerHost() || null;
    acquisition.landingPath = landingTemplate(window.location && window.location.pathname);
    acquisition.firstSeenAt = new Date().toISOString();
    return acquisition;
  }

  // Re-sanitize whatever is in storage (older script versions included) so
  // nothing un-normalized is ever posted.
  function sanitizeRecord(value) {
    if (!value || typeof value !== 'object') return null;
    var marker = ['gclid', 'gbraid', 'wbraid', 'paid_medium'].indexOf(value.paidMarker) >= 0 ? value.paidMarker : null;
    var token = function (v) { return String(v || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 512); };
    var seen = Date.parse(value.firstSeenAt || '');
    return {
      paidMarker: marker,
      sourceClass: piiCleanClass(value.sourceClass),
      mediumClass: piiCleanClass(value.mediumClass),
      campaignClass: piiCleanClass(value.campaignClass),
      hasCampaign: Boolean(value.hasCampaign),
      hasLandingContext: Boolean(value.hasLandingContext),
      referrerHost: value.referrerHost === 'self' ? 'self' : piiReferrerHost(value.referrerHost),
      landingPath: piiLandingTemplate(value.landingPath),
      firstSeenAt: isNaN(seen) ? null : new Date(seen).toISOString(),
      gclid: marker === 'gclid' ? token(value.gclid) : '',
      gbraid: marker === 'gbraid' ? token(value.gbraid) : '',
      wbraid: marker === 'wbraid' ? token(value.wbraid) : '',
    };
  }

  function readStored() {
    try {
      return sanitizeRecord(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
    } catch (_) {
      return null;
    }
  }

  // A stored record is valid for 30 days. Legacy paid records written before
  // firstSeenAt existed are kept and stamped now, so a paid click is not lost.
  function validStored() {
    var existing = readStored();
    if (!existing) return null;
    if (!existing.firstSeenAt) {
      if (!existing.paidMarker) return null;
      existing.firstSeenAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
      return existing;
    }
    return Date.now() - Date.parse(existing.firstSeenAt) > RECORD_MAX_AGE_MS ? null : existing;
  }

  // One record per browser session: a paid landing always replaces it; an
  // unpaid landing (including a same-site referral) only fills an empty or
  // expired slot.
  function rememberLanding() {
    var landing = readLandingAcquisition();
    var existing = validStored();
    if (existing && !landing.paidMarker) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(landing));
  }

  // Remember a bounded set of posted booking sessions (not just the last one).
  var SENT_MAX = 25;
  function sentSessions() {
    var raw = localStorage.getItem(SENT_KEY);
    if (!raw) return [];
    try {
      var list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter(function (v) { return typeof v === 'string'; }).slice(-SENT_MAX);
    } catch (_) {}
    return [raw];
  }
  function markSent(session, sent) {
    var list = sentSessions().filter(function (v) { return v !== session; });
    if (sent) list.push(session);
    localStorage.setItem(SENT_KEY, JSON.stringify(list.slice(-SENT_MAX)));
  }

  function captureBooking(customerId, bookingSession) {
    if (!customerId || !bookingSession) return Promise.resolve();
    // POST once per booking session: reloads of the thank-you page do not resend.
    if (sentSessions().indexOf(bookingSession) >= 0) return Promise.resolve();
    var storedAcquisition = validStored() || {
      paidMarker: null,
      sourceClass: null,
      mediumClass: null,
      hasCampaign: false,
      hasLandingContext: false,
      referrerHost: null,
      landingPath: null,
    };
    markSent(bookingSession, true);
    return fetch(CAPTURE_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId,
        booking_session: bookingSession,
        acquisition: storedAcquisition,
        gclid: storedAcquisition.gclid || '',
        gbraid: storedAcquisition.gbraid || '',
        wbraid: storedAcquisition.wbraid || '',
      }),
    }).then(function (response) {
      if (response.ok) localStorage.removeItem(STORAGE_KEY);
      else if (response.status >= 500) markSent(bookingSession, false);
    }).catch(function () { markSent(bookingSession, false); });
  }

  function pushBookingConfirmed(bookingSession, userData) {
    var event = { event: 'booking_confirmed' };
    if (bookingSession) {
      event.booking_session = bookingSession;
      // Order id for the Booked Appointment tag; the server-side enhancement
      // fallback adjusts the conversion by this id (never creates a second one).
      event.transaction_id = bookingSession;
    }
    if (userData) event.user_data = userData;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(event);
  }

  function cleanHash(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
  }

  function resolveUserData(customerId, bookingSession, timeoutMs) {
    if (!customerId || !bookingSession || typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    var budget = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.min(timeoutMs, IDENTITY_TIMEOUT_MS)
      : IDENTITY_TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var request = fetch(IDENTITY_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({ customer_id: customerId, booking_session: bookingSession }),
    }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      var raw = data && data.user_data;
      if (!raw) return null;
      var userData = {};
      var email = cleanHash(raw.sha256_email_address);
      var phone = cleanHash(raw.sha256_phone_number);
      if (email) userData.sha256_email_address = email;
      // Policy (Oct 15, 2026): phone hashes are never used.
      void phone;
      return email ? userData : null;
    }).catch(function () { return null; });

    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        if (controller) controller.abort();
        resolve(null);
      }, budget);
    });
    return Promise.race([request, timeout]);
  }

  var isThankYou = false;
  var customerId = '';
  var bookingSession = '';
  var capturePromise = Promise.resolve();
  try {
    isThankYou = window.location.pathname.replace(/\/+$/, '') === '/thank-you';
    if (!isThankYou) rememberLanding();
    if (isThankYou) {
      customerId = params.get('customer_id') || '';
      bookingSession = params.get('booking_session') || '';
      capturePromise = captureBooking(customerId, bookingSession);
    }
  } catch (_) {}

  if (isThankYou) {
    var pushed = false;
    var pageDeadline = Date.now() + PAGE_CONFIRM_MS;
    var pushOnce = function (userData) {
      if (pushed) return;
      pushed = true;
      try { pushBookingConfirmed(bookingSession, userData); } catch (_) {}
    };
    setTimeout(function () { pushOnce(null); }, PAGE_CONFIRM_MS);
    try {
      Promise.race([capturePromise, wait(CAPTURE_WAIT_MS)])
        .then(function () {
          var remaining = pageDeadline - Date.now();
          return resolveUserData(customerId, bookingSession, remaining);
        })
        .then(pushOnce, function () { pushOnce(null); });
    } catch (_) {
      pushOnce(null);
    }
  }
})();

(function () {
  'use strict';

  var STORAGE_KEY = 'tmm_paid_attribution_v1';
  var CAPTURE_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/booking';
  var IDENTITY_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/booking-identity';
  var IDENTITY_TIMEOUT_MS = 3000;
  var PAGE_CONFIRM_MS = 3000;
  var CAPTURE_WAIT_MS = 800;
  var params = new URLSearchParams(window.location.search);

  function cleanClass(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 64);
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

  function captureBooking(customerId, bookingSession) {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (!customerId || !bookingSession || !stored) return Promise.resolve();

    var storedAcquisition = JSON.parse(stored);
    if (!storedAcquisition || !storedAcquisition.paidMarker) return Promise.resolve();
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
    }).catch(function () {});
  }

  function pushBookingConfirmed(bookingSession, userData) {
    var event = { event: 'booking_confirmed' };
    if (bookingSession) event.booking_session = bookingSession;
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
      if (phone) userData.sha256_phone_number = phone;
      return email || phone ? userData : null;
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
    var acquisition = readPaidAcquisition();
    if (acquisition) localStorage.setItem(STORAGE_KEY, JSON.stringify(acquisition));

    isThankYou = window.location.pathname.replace(/\/+$/, '') === '/thank-you';
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

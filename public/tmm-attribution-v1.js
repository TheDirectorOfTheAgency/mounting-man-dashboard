(function () {
  'use strict';

  var STORAGE_KEY = 'tmm_paid_attribution_v1';
  var CAPTURE_URL = 'https://mounting-man-dashboard.vercel.app/api/attribution/booking';
  var params = new URLSearchParams(window.location.search);

  function cleanClass(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 64);
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
    };
  }

  try {
    var acquisition = readPaidAcquisition();
    if (acquisition) localStorage.setItem(STORAGE_KEY, JSON.stringify(acquisition));

    if (window.location.pathname.replace(/\/+$/, '') !== '/thank-you') return;
    var customerId = params.get('customer_id');
    var bookingSession = params.get('booking_session');
    var stored = localStorage.getItem(STORAGE_KEY);
    if (!customerId || !bookingSession || !stored) return;

    var storedAcquisition = JSON.parse(stored);
    if (!storedAcquisition || !storedAcquisition.paidMarker) return;
    fetch(CAPTURE_URL, {
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
      }),
    }).then(function (response) {
      if (response.ok) localStorage.removeItem(STORAGE_KEY);
    }).catch(function () {});
  } catch (_) {}
})();

// Server-side normalization of client-supplied attribution context. The server
// never trusts the browser. The PII core below is byte-identical to the block in
// public/tmm-attribution-v1.js (tests/attribution-sanitize.test.js enforces it).
/* eslint-disable no-var, prefer-template, func-names */
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

export const deepDecode = piiCanonical;
export const looksPersonal = piiLooksPersonal;
export const normalizeClass = piiCleanClass;
export const normalizeLandingPath = piiLandingTemplate;
export const normalizeReferrerHost = piiReferrerHost;

// OpenAI click id (oppref). Opaque and case-sensitive, so it is NOT lower-cased or
// run through normalizeClass. Reject (never strip) anything that is not a plain
// token: wrong charset, over 512 chars, whitespace, anything that decodes to an
// email, or a short all-digit value (a phone number).
const OPPREF_PATTERN = /^[A-Za-z0-9._~=-]+$/;
export function normalizeOppref(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || !OPPREF_PATTERN.test(trimmed)) return '';
  if (piiLooksPersonalEmail(trimmed)) return '';
  const alnum = trimmed.replace(/[^A-Za-z0-9]/g, '');
  if (!alnum || (alnum.length < 24 && /^[0-9]+$/.test(alnum))) return '';
  return trimmed;
}

function piiLooksPersonalEmail(text) {
  return piiCanonical(text).includes('@');
}

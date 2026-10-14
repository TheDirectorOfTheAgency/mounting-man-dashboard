// First-touch and last-touch source buckets for booking sessions.
// Input is landing params and referrer host/path only. No contact fields.
// Every field goes through the shared PII core in attribution-sanitize.js.

import { looksPersonal, deepDecode, normalizeClass, normalizeLandingPath, normalizeReferrerHost } from './attribution-sanitize.js';

export const SOURCE_BUCKETS = [
  'google_ads',
  'google_organic',
  'google_business_profile',
  'bing_other_search',
  'ai_assistant',
  'yelp',
  'angi',
  'thumbtack',
  'facebook_instagram',
  'email',
  'direct',
  'other_referral',
  'unknown',
];

export const SOURCE_LABELS = {
  google_ads: 'Google Ads',
  google_organic: 'Google organic',
  google_business_profile: 'Google Business Profile',
  bing_other_search: 'Bing / other search',
  ai_assistant: 'AI assistants',
  yelp: 'Yelp',
  angi: 'Angi',
  thumbtack: 'Thumbtack',
  facebook_instagram: 'Facebook / Instagram',
  email: 'Email',
  direct: 'Direct',
  other_referral: 'Other referral',
  unknown: 'Unknown',
};

const PAID_MEDIUMS = new Set(['cpc', 'paid', 'paid_search', 'paidsearch', 'ppc', 'sem']);
const EMAIL_MEDIUMS = new Set(['email', 'e-mail']);

const AI_SOURCES = new Set([
  'chatgpt',
  'chatgpt.com',
  'openai',
  'chat.openai.com',
  'perplexity',
  'perplexity.ai',
  'gemini',
  'gemini.google.com',
  'copilot',
  'copilot.microsoft.com',
  'claude',
  'claude.ai',
  'grok',
  'grok.com',
  'x.ai',
  'xai',
]);

const SEARCH_HOSTS = [
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'ecosia.org',
  'brave.com',
  'startpage.com',
  'baidu.com',
  'aol.com',
  'ask.com',
  'kagi.com',
];

function cleanToken(value, max = 64) {
  if (typeof value !== 'string') return '';
  // Reject (not strip) anything that could carry an email or phone.
  const cleaned = normalizeClass(value);
  return cleaned ? cleaned.slice(0, max) : '';
}

function cleanClick(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /\s/.test(trimmed) || trimmed.includes('@')) return '';
  if (deepDecode(trimmed).includes('@')) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return '';
  // Real click ids are long opaque tokens; a short all-digit value is a phone number.
  if (trimmed.length < 24 && /^[0-9]+$/.test(trimmed)) return '';
  return trimmed;
}

function cleanPath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('://')) return '';
  // Decodes, drops query/fragment, and templates personal-looking segments.
  return normalizeLandingPath(trimmed) || '';
}

function cleanTime(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function cleanHost(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (!host || host.includes('@') || !/^[a-z0-9.-]+$/.test(host)) return '';
  if (looksPersonal(host)) return '';
  return normalizeReferrerHost(host) || '';
}

function hostIs(host, root) {
  return host === root || host.endsWith(`.${root}`);
}

export function isSelfHost(host) {
  const value = cleanHost(host);
  if (!value) return false;
  return (
    hostIs(value, 'themountingman.com')
    || hostIs(value, 'themountingmanusa.com')
    || hostIs(value, 'webflow.io')
    || hostIs(value, 'zenbooker.com')
    || value === 'mounting-man-dashboard.vercel.app'
  );
}

function bucket(name, detail = null) {
  return { bucket: name, detail: detail || null };
}

function partnerFromToken(token) {
  const value = cleanToken(token, 80);
  if (!value) return null;
  if (AI_SOURCES.has(value)) return bucket('ai_assistant');
  if (value === 'yelp' || value === 'yelp.com') return bucket('yelp');
  if (['angi', 'angi.com', 'angieslist', 'angieslist.com', 'homeadvisor', 'homeadvisor.com'].includes(value)) {
    return bucket('angi');
  }
  if (value === 'thumbtack' || value === 'thumbtack.com') return bucket('thumbtack');
  if (['facebook', 'facebook.com', 'instagram', 'instagram.com', 'fb', 'ig', 'meta'].includes(value)) {
    return bucket('facebook_instagram');
  }
  if (['bing', 'bing.com', 'microsoft', 'microsoft.com', 'duckduckgo', 'yahoo'].includes(value)) {
    return bucket('bing_other_search');
  }
  return null;
}

function partnerFromHost(host) {
  if (!host || isSelfHost(host)) return null;
  if (
    hostIs(host, 'chatgpt.com')
    || hostIs(host, 'openai.com')
    || hostIs(host, 'perplexity.ai')
    || host === 'gemini.google.com'
    || host === 'copilot.microsoft.com'
    || hostIs(host, 'claude.ai')
    || hostIs(host, 'grok.com')
    || host === 'grok.x.ai'
    || host === 'x.ai'
  ) {
    return bucket('ai_assistant');
  }
  if (hostIs(host, 'yelp.com')) return bucket('yelp');
  if (hostIs(host, 'angi.com') || hostIs(host, 'angieslist.com') || hostIs(host, 'homeadvisor.com')) {
    return bucket('angi');
  }
  if (hostIs(host, 'thumbtack.com')) return bucket('thumbtack');
  if (hostIs(host, 'facebook.com') || hostIs(host, 'fb.com') || hostIs(host, 'instagram.com')) {
    return bucket('facebook_instagram');
  }
  if (SEARCH_HOSTS.some((root) => hostIs(host, root))) return bucket('bing_other_search');
  return null;
}

function isGoogleHost(host) {
  return /(^|\.)google\.[a-z.]+$/.test(host);
}

function isMaps(host, path) {
  if (!host) return false;
  if (host === 'maps.app.goo.gl' || host === 'g.page' || host.startsWith('maps.google.')) return true;
  if (host === 'goo.gl' && (path === '/maps' || path.startsWith('/maps/'))) return true;
  if (isGoogleHost(host) && (path === '/maps' || path.startsWith('/maps/') || path.startsWith('/maps?'))) {
    return true;
  }
  return false;
}

export function sanitizeTouch(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const referrerHost = cleanHost(source.referrerHost || source.referrer_host || '');
  return {
    landingPath: cleanPath(source.landingPath || source.landing_path || ''),
    referrerHost: isSelfHost(referrerHost) ? '' : referrerHost,
    referrerPath: cleanPath(source.referrerPath || source.referrer_path || ''),
    utmSource: cleanToken(source.utmSource || source.utm_source || ''),
    utmMedium: cleanToken(source.utmMedium || source.utm_medium || ''),
    utmCampaign: cleanToken(source.utmCampaign || source.utm_campaign || ''),
    gclid: cleanClick(source.gclid || ''),
    gbraid: cleanClick(source.gbraid || ''),
    wbraid: cleanClick(source.wbraid || ''),
    at: cleanTime(source.at),
  };
}

// True when a sanitized touch carries no attribution signal at all.
export function isEmptyTouch(touch) {
  if (!touch || typeof touch !== 'object') return true;
  return !['landingPath', 'referrerHost', 'referrerPath', 'utmSource', 'utmMedium', 'utmCampaign', 'gclid', 'gbraid', 'wbraid']
    .some((key) => touch[key]);
}

export function classifyTouch(input = {}) {
  const touch = sanitizeTouch(input);
  if (touch.gclid || touch.gbraid || touch.wbraid) return bucket('google_ads');
  if (EMAIL_MEDIUMS.has(touch.utmMedium)) return bucket('email');
  const gbpUtm = touch.utmSource === 'google'
    && touch.utmMedium === 'organic'
    && touch.utmCampaign === 'gbp';
  if (gbpUtm || isMaps(touch.referrerHost, touch.referrerPath)) {
    return bucket('google_business_profile');
  }
  const fromUtm = partnerFromToken(touch.utmSource);
  if (fromUtm) return fromUtm;
  if (PAID_MEDIUMS.has(touch.utmMedium) && touch.utmSource === 'google') {
    return bucket('google_ads');
  }
  if (touch.utmSource === 'google' && touch.utmMedium === 'organic') return bucket('google_organic');
  const fromHost = partnerFromHost(touch.referrerHost);
  if (fromHost) return fromHost;
  if (touch.referrerHost && isGoogleHost(touch.referrerHost)) return bucket('google_organic');
  if (touch.referrerHost) return bucket('other_referral', touch.referrerHost);
  return bucket('direct');
}

export function classifyVisit({ first, last } = {}) {
  const firstTouch = classifyTouch(first || {});
  const lastTouch = classifyTouch(last || first || {});
  return { firstTouch, lastTouch };
}

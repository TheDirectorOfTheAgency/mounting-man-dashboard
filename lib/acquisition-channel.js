// Classifies a website booking session into one channel from non-personal
// landing context: paid, gbp, organic, referral or direct.
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|search\.brave\.com|yandex\.[a-z.]+|baidu\.com)$/;
const GBP_HINT = /(^|[^a-z])(gbp|gmb|google[_.-]?business|google[_.-]?my[_.-]?business|business[_.-]?profile|maps)([^a-z]|$)/;
const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai|grok\.com|x\.ai)$/;
export const CHANNELS = ['paid', 'gbp', 'organic', 'referral', 'direct'];

export function cleanHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (host === 'self') return 'self';
  return /^[a-z0-9.-]{1,100}$/.test(host) && host.includes('.') ? host : null;
}

export function classifyChannel({ paidMarker, sourceClass, mediumClass, campaignClass, referrerHost } = {}) {
  if (paidMarker) return 'paid';
  const utm = [sourceClass, mediumClass, campaignClass].filter(Boolean).join(' ');
  if (GBP_HINT.test(utm)) return 'gbp';
  if (mediumClass === 'organic') return 'organic';
  if (mediumClass && ['referral', 'social', 'email', 'affiliate'].includes(mediumClass)) return 'referral';
  if (sourceClass && !referrerHost) return 'referral';
  const host = cleanHost(referrerHost);
  if (!host || host === 'self') return 'direct';
  if (host === 'maps.google.com' || host.startsWith('maps.google.')) return 'gbp';
  if (AI_HOSTS.test(host)) return 'referral';
  if (SEARCH_HOSTS.test(host)) return 'organic';
  return 'referral';
}

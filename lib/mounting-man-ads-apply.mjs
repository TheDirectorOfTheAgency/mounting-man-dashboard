// Tightly scoped Google Ads WRITE tools for The Mounting Man.
// Pause allowlisted ad-group keywords and add campaign-level PHRASE negatives.
// Never touches budgets, bids, campaigns, or ad groups.
import axios from 'axios';
import { getAccessToken as liveGetAccessToken, getDeveloperToken as liveGetDeveloperToken } from './google-ads-auth.js';

export const PAUSE_AD_GROUP_CRITERION = 'pause_ad_group_criterion';
export const ADD_CAMPAIGN_PHRASE_NEGATIVES = 'add_campaign_phrase_negatives';
export const GET_CRITERION_STATUS = 'get_criterion_status';

export const ADS_APPLY_TOOLS = [
  PAUSE_AD_GROUP_CRITERION,
  ADD_CAMPAIGN_PHRASE_NEGATIVES,
  GET_CRITERION_STATUS,
];

export const DEFAULT_CUSTOMER_ID = '1287907452';
export const READ_LOGIN_CUSTOMER_ID = '3167428631';
export const DEFAULT_ADS_API_VERSION = 'v24';
export const GOOGLE_ADS_API_HOST = 'https://googleads.googleapis.com';

export function resolveAdsApiVersion(env = process.env) {
  const raw = env?.GOOGLE_ADS_API_VERSION;
  if (raw == null || String(raw).trim() === '') {
    return DEFAULT_ADS_API_VERSION;
  }
  return String(raw).trim();
}

export const ADS_API_VERSION = resolveAdsApiVersion();

export const ALLOWLISTED_CAMPAIGNS = {
  20867488270: { name: 'MSP - General TV Mounting', negativesOnly: false },
  23038170184: { name: 'MSP- Samsung Frame', negativesOnly: true },
  23067449455: { name: 'Austin - General TV Mounting', negativesOnly: false },
  23246942122: { name: 'Houston - General TV Mounting', negativesOnly: false },
};

export const ALLOWLISTED_CAMPAIGN_IDS = Object.keys(ALLOWLISTED_CAMPAIGNS);

export const KEEP_EXACT_KEYWORDS = [
  'tv mounting near me',
  'tv installation near me',
  'tv installer near me',
  'tv mounting service',
];

const FORBIDDEN_MUTATE_KEYS = [
  'budget',
  'budgets',
  'daily_budget',
  'amount_micros',
  'bid',
  'bids',
  'cpc_bid',
  'cpc_bid_micros',
  'bid_strategy',
  'bidding_strategy',
  'target_cpa',
  'target_roas',
];

const KEEP_PATTERNS = [
  /\bfireplace\b/,
  /\bmantel/,
  /\bmasonry\b/,
  /\bframe\b.*\binstaller\b/,
  /\bthe mounting man reviews?\b/,
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function normalizeKeywordText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/^[\[("'“‘]+/, '')
    .replace(/[\])"'”’]+$/, '')
    .replace(/[^\w\s'+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isKeepKeyword(text) {
  const normalized = normalizeKeywordText(text);
  if (!normalized) return false;
  if (KEEP_EXACT_KEYWORDS.includes(normalized)) return true;
  return KEEP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isAllowlistedCampaignId(campaignId) {
  return Boolean(ALLOWLISTED_CAMPAIGNS[digitsOnly(campaignId)]);
}

export function isNegativesOnlyCampaign(campaignId) {
  return ALLOWLISTED_CAMPAIGNS[digitsOnly(campaignId)]?.negativesOnly === true;
}

export function isHtsaOrAgencyName(name) {
  return /\b(htsa|agency)\b/i.test(String(name || ''));
}

export function confirmIsTrue(value) {
  return value === true;
}

export function googleAdsSearchUrl(customerId, apiVersion = resolveAdsApiVersion()) {
  return `${GOOGLE_ADS_API_HOST}/${apiVersion}/customers/${customerId}/googleAds:searchStream`;
}

export function googleAdsAdGroupCriteriaMutateUrl(customerId, apiVersion = resolveAdsApiVersion()) {
  return `${GOOGLE_ADS_API_HOST}/${apiVersion}/customers/${customerId}/adGroupCriteria:mutate`;
}

export function googleAdsCampaignCriteriaMutateUrl(customerId, apiVersion = resolveAdsApiVersion()) {
  return `${GOOGLE_ADS_API_HOST}/${apiVersion}/customers/${customerId}/campaignCriteria:mutate`;
}

export function resolveCustomerId(value) {
  const customerId = digitsOnly(value || DEFAULT_CUSTOMER_ID);
  if (!customerId) {
    throw codedError('invalid_customer', 'customer_id is required');
  }
  if (customerId !== DEFAULT_CUSTOMER_ID) {
    throw codedError(
      'unknown_customer',
      `Refusing customer ${customerId}. This server only writes The Mounting Man (${DEFAULT_CUSTOMER_ID}).`,
    );
  }
  return customerId;
}

export function assertConfirm(args) {
  if (!confirmIsTrue(args?.confirm)) {
    throw codedError(
      'confirm_required',
      'confirm must be true. Refusing mutate without an explicit confirm:true gate.',
    );
  }
}

export function assertNoForbiddenMutate(args = {}) {
  const keys = Object.keys(args).map((key) => key.toLowerCase());
  const hit = FORBIDDEN_MUTATE_KEYS.find((key) => keys.includes(key));
  if (hit) {
    throw codedError(
      'forbidden_mutate',
      `Refusing ${hit}. This server does not change budgets, bids, or bid strategies.`,
    );
  }
}

export function parseAdGroupCriterionResourceName(resourceName) {
  const value = String(resourceName || '').trim();
  const match = value.match(/^customers\/(\d+)\/adGroupCriteria\/(\d+)~(\d+)$/);
  if (!match) return null;
  return {
    customerId: match[1],
    adGroupId: match[2],
    criterionId: match[3],
    resourceName: value,
  };
}

export function summarizeAdGroupCriterionMatch(row = {}) {
  return {
    campaign_id: row.campaign_id || '',
    ad_group_id: row.ad_group_id || '',
    status: row.status || null,
    resource_name: row.resource_name || '',
  };
}

export function formatAdGroupCriterionMatches(matches = []) {
  return matches.map((row) => {
    const item = summarizeAdGroupCriterionMatch(row);
    return `campaign_id=${item.campaign_id} ad_group_id=${item.ad_group_id} status=${item.status} resource_name=${item.resource_name}`;
  }).join('; ');
}

function throwAmbiguousCriterion(criterionId, matches) {
  const listed = formatAdGroupCriterionMatches(matches);
  const error = codedError(
    'ambiguous_criterion',
    `ambiguous_criterion: criterion_id ${criterionId} is reused across multiple ad groups. Pass ad_group_id or resource_name to disambiguate. Matches: ${listed}`,
  );
  error.matches = matches.map(summarizeAdGroupCriterionMatch);
  throw error;
}

function throwUnknownCampaignMatches(criterionId, matches) {
  const listed = formatAdGroupCriterionMatches(matches);
  const error = codedError(
    'unknown_campaign',
    `Refusing unknown campaign. criterion_id ${criterionId} is not on an allowlisted campaign. Matches: ${listed}. Allowlisted: ${ALLOWLISTED_CAMPAIGN_IDS.join(', ')}.`,
  );
  error.matches = matches.map(summarizeAdGroupCriterionMatch);
  throw error;
}

export function resolveAdGroupCriterionMatch(matches, selectors = {}) {
  const rows = Array.isArray(matches) ? matches : [];
  const parsed = parseAdGroupCriterionResourceName(selectors.resourceName ?? selectors.resource_name);
  const adGroupId = digitsOnly(selectors.adGroupId ?? selectors.ad_group_id) || parsed?.adGroupId || '';
  const resourceName = parsed?.resourceName || '';
  const criterionId = digitsOnly(selectors.criterionId ?? selectors.criterion_id)
    || parsed?.criterionId
    || rows[0]?.criterion_id
    || '';

  if (resourceName) {
    const exact = rows.filter((row) => row.resource_name === resourceName);
    if (exact.length === 1) return exact[0];
    if (exact.length === 0) return null;
    throwAmbiguousCriterion(criterionId, exact);
  }

  if (adGroupId) {
    const exact = rows.filter((row) => row.ad_group_id === adGroupId);
    if (exact.length === 1) return exact[0];
    if (exact.length === 0) return null;
    throwAmbiguousCriterion(criterionId, exact);
  }

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const allowlisted = rows.filter((row) => isAllowlistedCampaignId(row.campaign_id));
  if (allowlisted.length === 1) return allowlisted[0];
  if (allowlisted.length > 1) {
    throwAmbiguousCriterion(criterionId, rows);
  }
  throwUnknownCampaignMatches(criterionId, rows);
}

export function assertAdGroupCriterionPauseTarget(args = {}) {
  const resourceName = String(args.resource_name || args.resourceName || '');
  if (resourceName && /\/campaigns\/\d+$/.test(resourceName)) {
    throw codedError('refuse_campaign_pause', 'Refusing campaign pause. pause_ad_group_criterion only PAUSES keyword criteria.');
  }
  if (resourceName && /\/adGroups\/\d+$/.test(resourceName)) {
    throw codedError('refuse_ad_group_pause', 'Refusing ad group pause. pause_ad_group_criterion only PAUSES keyword criteria.');
  }

  const parsed = parseAdGroupCriterionResourceName(resourceName);
  const criterionId = digitsOnly(args.criterion_id ?? args.criterionId) || parsed?.criterionId || '';
  const campaignId = digitsOnly(args.campaign_id ?? args.campaignId);
  const adGroupId = digitsOnly(args.ad_group_id ?? args.adGroupId) || parsed?.adGroupId || '';

  if (parsed?.criterionId && criterionId && parsed.criterionId !== criterionId) {
    throw codedError('invalid_criterion', `criterion_id ${criterionId} does not match resource_name ${resourceName}.`);
  }
  if (parsed?.adGroupId && adGroupId && parsed.adGroupId !== adGroupId) {
    throw codedError('invalid_criterion', `ad_group_id ${adGroupId} does not match resource_name ${resourceName}.`);
  }

  if (!criterionId && campaignId) {
    throw codedError('refuse_campaign_pause', 'Refusing campaign pause. Pass criterion_id for a keyword, not a campaign.');
  }
  if (!criterionId && adGroupId) {
    throw codedError('refuse_ad_group_pause', 'Refusing ad group pause. Pass criterion_id for a keyword, not an ad group.');
  }
  if (!criterionId) {
    throw codedError('invalid_criterion', 'criterion_id is required');
  }
  if (ALLOWLISTED_CAMPAIGNS[criterionId]) {
    throw codedError('refuse_campaign_pause', `Refusing campaign pause. ${criterionId} is a campaign id, not a keyword criterion.`);
  }
  return criterionId;
}

export function assertAllowlistedCampaign(campaignId, { forPause = false } = {}) {
  const id = digitsOnly(campaignId);
  const entry = ALLOWLISTED_CAMPAIGNS[id];
  if (!entry) {
    throw codedError(
      'unknown_campaign',
      `Refusing unknown campaign ${id || '(missing)'}. Allowlisted: ${ALLOWLISTED_CAMPAIGN_IDS.join(', ')}.`,
    );
  }
  if (isHtsaOrAgencyName(entry.name)) {
    throw codedError('refuse_htsa_agency', `Refusing HTSA / Agency campaign ${id}.`);
  }
  if (forPause && entry.negativesOnly) {
    throw codedError(
      'negatives_only_campaign',
      `Refusing keyword pause on ${id} (${entry.name}). Negatives only; KEEP Frame keywords.`,
    );
  }
  return { id, ...entry };
}

export function assertNotKeepKeyword(text) {
  if (isKeepKeyword(text)) {
    throw codedError(
      'keep_keyword',
      `Refusing KEEP keyword "${normalizeKeywordText(text)}". Frame installer / fireplace / mantel / masonry, brand reviews, and the locked near-me exacts stay ENABLED.`,
    );
  }
  return normalizeKeywordText(text);
}

export function normalizePhraseList(phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) {
    throw codedError('invalid_phrases', 'phrases must be a non-empty array of campaign-level PHRASE negatives');
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of phrases) {
    const text = normalizeKeywordText(raw);
    if (!text) {
      throw codedError('invalid_phrases', 'phrases must not contain empty values');
    }
    assertNotKeepKeyword(text);
    if (!seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  return normalized;
}

export function parseSearchStream(data) {
  const batches = Array.isArray(data) ? data : data ? [data] : [];
  const results = [];
  for (const batch of batches) {
    if (Array.isArray(batch?.results)) results.push(...batch.results);
  }
  return results;
}

function escapeGaqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function adsHttpError(error, kind) {
  const status = error.response?.status;
  const data = error.response?.data;
  const detail = data?.error?.message
    || data?.error?.status
    || data?.message
    || error.message;
  return codedError(
    'ads_api_error',
    `Google Ads ${kind} failed${status ? ` (${status})` : ''}: ${detail}`,
  );
}

function rowCampaign(row) {
  return {
    id: digitsOnly(row?.campaign?.id),
    name: String(row?.campaign?.name || ''),
    status: row?.campaign?.status || null,
  };
}

function rowAdGroup(row) {
  return {
    id: digitsOnly(row?.adGroup?.id),
    name: String(row?.adGroup?.name || ''),
    status: row?.adGroup?.status || null,
  };
}

function rowAdGroupCriterion(row) {
  const criterion = row?.adGroupCriterion || {};
  const campaign = rowCampaign(row);
  const adGroup = rowAdGroup(row);
  return {
    kind: 'ad_group_criterion',
    customer_id: DEFAULT_CUSTOMER_ID,
    criterion_id: digitsOnly(criterion.criterionId),
    resource_name: String(criterion.resourceName || ''),
    status: criterion.status || null,
    negative: Boolean(criterion.negative),
    keyword_text: criterion.keyword?.text || '',
    match_type: criterion.keyword?.matchType || null,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    ad_group_id: adGroup.id,
    ad_group_name: adGroup.name,
  };
}

function rowCampaignCriterion(row) {
  const criterion = row?.campaignCriterion || {};
  const campaign = rowCampaign(row);
  return {
    kind: 'campaign_criterion',
    customer_id: DEFAULT_CUSTOMER_ID,
    criterion_id: digitsOnly(criterion.criterionId),
    resource_name: String(criterion.resourceName || ''),
    status: criterion.status || null,
    negative: Boolean(criterion.negative),
    keyword_text: criterion.keyword?.text || '',
    match_type: criterion.keyword?.matchType || null,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
  };
}

export function createMountingManAdsApplyClient({
  env = process.env,
  httpClient = axios,
  getAccessToken = () => liveGetAccessToken(),
  getDeveloperToken = () => liveGetDeveloperToken(),
} = {}) {
  async function adsHeaders({ write = false } = {}) {
    const accessToken = await getAccessToken();
    const developerToken = getDeveloperToken();
    if (!accessToken || !developerToken) {
      throw codedError('ads_unconfigured', 'Google Ads credentials missing');
    }
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'developer-token': developerToken,
    };
    if (!write) {
      headers['login-customer-id'] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
        ? digitsOnly(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
        : READ_LOGIN_CUSTOMER_ID;
    }
    return headers;
  }

  async function adsRequest({ method, url, data, write = false }) {
    try {
      return await httpClient.request({
        method,
        url,
        headers: await adsHeaders({ write }),
        ...(data !== undefined ? { data } : {}),
      });
    } catch (error) {
      throw adsHttpError(error, write ? 'mutate' : 'read');
    }
  }

  function adsApiVersion() {
    return resolveAdsApiVersion(env);
  }

  async function search(customerId, query) {
    const response = await adsRequest({
      method: 'POST',
      url: googleAdsSearchUrl(customerId, adsApiVersion()),
      data: { query },
      write: false,
    });
    return parseSearchStream(response?.data);
  }

  async function lookupAdGroupCriterion(customerId, criterionId, selectors = {}) {
    const parsed = parseAdGroupCriterionResourceName(selectors.resourceName ?? selectors.resource_name);
    const adGroupId = digitsOnly(selectors.adGroupId ?? selectors.ad_group_id) || parsed?.adGroupId || '';
    const resourceName = parsed?.resourceName || '';
    const clauses = [`ad_group_criterion.criterion_id = ${criterionId}`];
    if (resourceName) {
      clauses.push(`ad_group_criterion.resource_name = '${escapeGaqlString(resourceName)}'`);
    } else if (adGroupId) {
      clauses.push(`ad_group.id = ${adGroupId}`);
    }
    const rows = await search(
      customerId,
      `SELECT ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, campaign.id, campaign.name, ad_group.id, ad_group.name FROM ad_group_criterion WHERE ${clauses.join(' AND ')}`,
    );
    return resolveAdGroupCriterionMatch(rows.map(rowAdGroupCriterion), {
      criterionId,
      adGroupId,
      resourceName,
    });
  }

  async function lookupCampaignCriterion(customerId, criterionId) {
    const rows = await search(
      customerId,
      `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign.id, campaign.name FROM campaign_criterion WHERE campaign_criterion.criterion_id = ${criterionId}`,
    );
    return rows[0] ? rowCampaignCriterion(rows[0]) : null;
  }

  async function lookupCampaign(customerId, campaignId) {
    const rows = await search(
      customerId,
      `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId}`,
    );
    return rows[0] ? { ...rowCampaign(rows[0]) } : null;
  }

  async function lookupAdGroup(customerId, adGroupId) {
    const rows = await search(
      customerId,
      `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group WHERE ad_group.id = ${adGroupId}`,
    );
    if (!rows[0]) return null;
    return { ...rowAdGroup(rows[0]), campaign_id: rowCampaign(rows[0]).id, campaign_name: rowCampaign(rows[0]).name };
  }

  async function lookupCampaignPhraseNegative(customerId, campaignId, phrase) {
    const rows = await search(
      customerId,
      `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign.id, campaign.name FROM campaign_criterion WHERE campaign.id = ${campaignId} AND campaign_criterion.negative = TRUE AND campaign_criterion.keyword.match_type = PHRASE AND campaign_criterion.keyword.text = '${escapeGaqlString(phrase)}'`,
    );
    return rows[0] ? rowCampaignCriterion(rows[0]) : null;
  }

  async function getCriterionStatus(args = {}) {
    const customerId = resolveCustomerId(args.customer_id ?? args.customerId);
    const rawResourceName = String(args.resource_name || args.resourceName || '');
    const parsed = parseAdGroupCriterionResourceName(rawResourceName);
    const criterionId = digitsOnly(args.criterion_id ?? args.criterionId)
      || parsed?.criterionId
      || digitsOnly(rawResourceName.split('~').pop());
    const adGroupId = digitsOnly(args.ad_group_id ?? args.adGroupId) || parsed?.adGroupId || '';
    if (!criterionId) {
      throw codedError('invalid_criterion', 'criterion_id is required');
    }
    const adGroupCriterion = await lookupAdGroupCriterion(customerId, criterionId, {
      adGroupId,
      resourceName: parsed?.resourceName || '',
    });
    if (adGroupCriterion) return adGroupCriterion;
    if (adGroupId || parsed) {
      throw codedError(
        'criterion_not_found',
        `No ad group criterion ${criterionId}${adGroupId ? ` in ad group ${adGroupId}` : ''} on customer ${customerId}`,
      );
    }
    const campaignCriterion = await lookupCampaignCriterion(customerId, criterionId);
    if (campaignCriterion) return campaignCriterion;
    throw codedError('criterion_not_found', `No criterion ${criterionId} on customer ${customerId}`);
  }

  async function pauseAdGroupCriterion(args = {}) {
    assertConfirm(args);
    assertNoForbiddenMutate(args);
    const customerId = resolveCustomerId(args.customer_id ?? args.customerId);
    const criterionId = assertAdGroupCriterionPauseTarget(args);
    const parsed = parseAdGroupCriterionResourceName(args.resource_name || args.resourceName);
    const adGroupId = digitsOnly(args.ad_group_id ?? args.adGroupId) || parsed?.adGroupId || '';
    const resourceName = parsed?.resourceName || '';

    let before = await lookupAdGroupCriterion(customerId, criterionId, { adGroupId, resourceName });
    if (!before) {
      const campaign = await lookupCampaign(customerId, criterionId);
      if (campaign) {
        throw codedError('refuse_campaign_pause', `Refusing campaign pause. ${criterionId} is campaign ${campaign.name || campaign.id}.`);
      }
      const adGroup = await lookupAdGroup(customerId, criterionId);
      if (adGroup) {
        throw codedError('refuse_ad_group_pause', `Refusing ad group pause. ${criterionId} is ad group ${adGroup.name || adGroup.id}.`);
      }
      throw codedError(
        'criterion_not_found',
        `No ad group criterion ${criterionId}${adGroupId ? ` in ad group ${adGroupId}` : ''} on customer ${customerId}`,
      );
    }

    if (before.negative) {
      throw codedError('refuse_negative_pause', 'Refusing to pause a negative criterion. Use add_campaign_phrase_negatives for campaign negatives.');
    }
    assertAllowlistedCampaign(before.campaign_id, { forPause: true });
    if (isHtsaOrAgencyName(before.campaign_name) || isHtsaOrAgencyName(before.ad_group_name)) {
      throw codedError('refuse_htsa_agency', `Refusing HTSA / Agency entity ${before.campaign_name || before.ad_group_name}.`);
    }
    assertNotKeepKeyword(before.keyword_text);

    const mutate = await adsRequest({
      method: 'POST',
      url: googleAdsAdGroupCriteriaMutateUrl(customerId, adsApiVersion()),
      write: true,
      data: {
        operations: [{
          update: {
            resourceName: before.resource_name,
            status: 'PAUSED',
          },
          updateMask: 'status',
        }],
      },
    });

    const after = await lookupAdGroupCriterion(customerId, criterionId, {
      adGroupId: before.ad_group_id,
      resourceName: before.resource_name,
    });
    return {
      action: PAUSE_AD_GROUP_CRITERION,
      customer_id: customerId,
      criterion_id: criterionId,
      resource_name: after?.resource_name || mutate?.data?.results?.[0]?.resourceName || before.resource_name,
      campaign_id: before.campaign_id,
      campaign_name: before.campaign_name,
      ad_group_id: before.ad_group_id,
      ad_group_name: before.ad_group_name,
      keyword_text: before.keyword_text,
      match_type: before.match_type,
      before_status: before.status,
      after_status: after?.status || 'PAUSED',
    };
  }

  async function addCampaignPhraseNegatives(args = {}) {
    assertConfirm(args);
    assertNoForbiddenMutate(args);
    const customerId = resolveCustomerId(args.customer_id ?? args.customerId);
    const campaign = assertAllowlistedCampaign(args.campaign_id ?? args.campaignId);
    if (isHtsaOrAgencyName(campaign.name)) {
      throw codedError('refuse_htsa_agency', `Refusing HTSA / Agency campaign ${campaign.id}.`);
    }
    const phrases = normalizePhraseList(args.phrases);

    const before = [];
    const toCreate = [];
    for (const phrase of phrases) {
      const existing = await lookupCampaignPhraseNegative(customerId, campaign.id, phrase);
      if (existing) {
        before.push({
          phrase,
          status: existing.status || 'ENABLED',
          resource_name: existing.resource_name,
          criterion_id: existing.criterion_id,
        });
      } else {
        before.push({ phrase, status: 'ABSENT' });
        toCreate.push(phrase);
      }
    }

    let created = [];
    if (toCreate.length) {
      const mutate = await adsRequest({
        method: 'POST',
        url: googleAdsCampaignCriteriaMutateUrl(customerId, adsApiVersion()),
        write: true,
        data: {
          operations: toCreate.map((text) => ({
            create: {
              campaign: `customers/${customerId}/campaigns/${campaign.id}`,
              negative: true,
              keyword: { text, matchType: 'PHRASE' },
            },
          })),
        },
      });
      created = Array.isArray(mutate?.data?.results) ? mutate.data.results : [];
    }

    const after = [];
    let createIndex = 0;
    for (const item of before) {
      if (item.status !== 'ABSENT') {
        after.push({
          phrase: item.phrase,
          status: item.status,
          resource_name: item.resource_name,
          criterion_id: item.criterion_id,
        });
        continue;
      }
      const resourceName = created[createIndex]?.resourceName || '';
      createIndex += 1;
      const criterionId = digitsOnly(resourceName.split('~').pop());
      const readBack = criterionId
        ? await lookupCampaignCriterion(customerId, criterionId)
        : await lookupCampaignPhraseNegative(customerId, campaign.id, item.phrase);
      after.push({
        phrase: item.phrase,
        status: readBack?.status || 'ENABLED',
        resource_name: readBack?.resource_name || resourceName,
        criterion_id: readBack?.criterion_id || criterionId,
      });
    }

    return {
      action: ADD_CAMPAIGN_PHRASE_NEGATIVES,
      customer_id: customerId,
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      match_type: 'PHRASE',
      phrases,
      before_status: before,
      after_status: after,
      resource_names: after.map((item) => item.resource_name).filter(Boolean),
    };
  }

  return {
    pauseAdGroupCriterion,
    addCampaignPhraseNegatives,
    getCriterionStatus,
  };
}

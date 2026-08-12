// Pure ChatGPT installation-post protocol. No I/O and no credentials.

import { createHash } from 'node:crypto';

import {
  INSTALL_POST_STATES,
  cardLabel,
  canonicalRevision,
  publicJobView,
  safeSeed,
} from './install-post-queue.mjs';

export const DESTINATION_MANIFEST_VERSION = 'installation-post-destinations-v1';

export const DESTINATION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'website', label: 'Website', required: true }),
  Object.freeze({ id: 'facebook', label: 'Facebook', required: true }),
  Object.freeze({ id: 'instagram', label: 'Instagram', required: true }),
  Object.freeze({ id: 'linkedin', label: 'LinkedIn', required: true }),
  Object.freeze({ id: 'x', label: 'X', required: true }),
  Object.freeze({ id: 'google_business_profile', label: 'Google Business Profile', required: true }),
  Object.freeze({ id: 'reddit_mountingman', label: 'Reddit / TheMountingMan', required: true }),
  Object.freeze({
    id: 'reddit_samsung_frame_mounting',
    label: 'Reddit / SamsungFrameMounting',
    required: true,
    conditional: 'gallery-style',
  }),
]);

export const DESTINATION_STATUSES = Object.freeze([
  'NOT_STARTED',
  'POSTED',
  'VERIFIED',
  'ALREADY_POSTED',
  'QUEUED',
  'SKIPPED',
  'BLOCKED',
  'TRANSIENT_FAILURE',
  'PERMANENT_FAILURE',
  'INDETERMINATE',
]);

const SUCCESS_STATUSES = new Set(['POSTED', 'VERIFIED', 'ALREADY_POSTED']);
const PENDING_STATES = new Set([
  INSTALL_POST_STATES.AWAITING_PHOTO,
  INSTALL_POST_STATES.READY,
  INSTALL_POST_STATES.RETRYABLE_FAILURE,
  INSTALL_POST_STATES.BLOCKED,
  INSTALL_POST_STATES.INDETERMINATE,
]);

const MATCH_FIELDS = Object.freeze([
  'city',
  'state',
  'tv-size',
  'tv-brand',
  'wall-surface',
  'gallery-style',
  'fireplace-type',
  'mantelmount',
  'price',
  'street-name',
  'mount-type',
  'room-type',
  'bracket-type',
  'soundbar-mounting',
  'local-reference',
]);

const REFERENCE_FILLER = new Set([
  'a', 'an', 'and', 'did', 'do', 'for', 'i', 'installation', 'job', 'just',
  'last', 'mount', 'mounted', 'my', 'of', 'on', 'post', 'recent', 'the', 'this',
  'today', 'tv', 'was', 'with',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function hashApprovalNonce(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function shortReference(jobId) {
  const value = String(jobId || '');
  return value.length > 6 ? value.slice(-6) : value;
}

function relativeCompletionTime(record, now) {
  const at = Date.parse(record.updatedAt || record.createdAt || '');
  const current = Number(now instanceof Date ? now.getTime() : now);
  if (!Number.isFinite(at) || !Number.isFinite(current)) return null;
  const minutes = Math.max(0, Math.floor((current - at) / 60000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function pendingInstallationView(record, now = Date.now()) {
  const view = publicJobView(record);
  return {
    jobId: view.jobId,
    reference: shortReference(view.jobId),
    label: view.label,
    state: view.state,
    seed: view.seed,
    revision: view.revision,
    image: view.image,
    completed: relativeCompletionTime(record, now),
    updatedAt: view.updatedAt,
  };
}

export function isPendingInstallation(record) {
  return PENDING_STATES.has(record?.state);
}

function referenceTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !REFERENCE_FILLER.has(token));
}

function searchableTokens(record) {
  const seed = safeSeed(record?.seed || {});
  return new Set(referenceTokens([
    record?.jobId,
    shortReference(record?.jobId),
    ...MATCH_FIELDS.flatMap((key) => Array.isArray(seed[key]) ? seed[key] : [seed[key]]),
  ].filter(Boolean).join(' ')));
}

function recentLanguage(reference) {
  return /\b(just|recent|latest|last|today)\b/i.test(String(reference || ''));
}

/**
 * Resolve a conversational reference conservatively. The function returns
 * candidates only; a mutating call must still carry the chosen job id and the
 * current exact revision.
 */
export function resolveInstallationReference(reference, records = [], now = Date.now()) {
  const pending = records.filter(isPendingInstallation);
  if (!pending.length) return { status: 'no_match', candidates: [] };

  const raw = String(reference || '').trim().toLowerCase();
  const exact = pending.filter((record) => {
    const jobId = String(record.jobId || '').toLowerCase();
    const suffix = shortReference(jobId).toLowerCase();
    return raw === jobId || raw === suffix || raw === `#${suffix}`;
  });
  if (exact.length === 1) {
    return { status: 'single_candidate', candidate: pendingInstallationView(exact[0], now) };
  }

  const tokens = referenceTokens(reference);
  if (!tokens.length && recentLanguage(reference)) {
    if (pending.length === 1) {
      return { status: 'single_candidate', candidate: pendingInstallationView(pending[0], now) };
    }
    return {
      status: 'ambiguous',
      candidates: pending
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
        .slice(0, 5)
        .map((record) => pendingInstallationView(record, now)),
    };
  }

  const scored = pending.map((record) => {
    const haystack = searchableTokens(record);
    const matched = tokens.filter((token) => haystack.has(token));
    return { record, matched: matched.length, all: tokens.length > 0 && matched.length === tokens.length };
  }).filter((entry) => entry.matched > 0);

  const allMatches = scored.filter((entry) => entry.all);
  if (allMatches.length === 1) {
    return {
      status: 'single_candidate',
      candidate: pendingInstallationView(allMatches[0].record, now),
    };
  }

  const candidates = (allMatches.length ? allMatches : scored)
    .sort((a, b) => b.matched - a.matched
      || Date.parse(b.record.updatedAt || 0) - Date.parse(a.record.updatedAt || 0))
    .slice(0, 5)
    .map((entry) => pendingInstallationView(entry.record, now));
  return candidates.length
    ? { status: 'ambiguous', candidates }
    : { status: 'no_match', candidates: [] };
}

function normalizedCopy(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return canonicalize(value);
}

function expectedDestination(definition, seed) {
  return !definition.conditional || Boolean(seed?.[definition.conditional]);
}

export function buildInstallationPreview(record, canonicalPreview, {
  approvalNonce,
  createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString(),
} = {}) {
  if (!record?.jobId || !record?.revision || !record?.image?.sha256) {
    throw new Error('preview requires a revision-bound installation photo');
  }
  if (!approvalNonce) throw new Error('preview requires an approval nonce');

  const websiteCopy = normalizedCopy(canonicalPreview?.website);
  if (!websiteCopy || (typeof websiteCopy === 'object' && !Object.keys(websiteCopy).length)) {
    throw new Error('canonical preview is missing website copy');
  }
  const destinationCopies = {};
  const destinationManifest = [];
  const seed = safeSeed(record.seed || {});
  for (const definition of DESTINATION_DEFINITIONS) {
    const expected = expectedDestination(definition, seed);
    const copy = definition.id === 'website'
      ? websiteCopy
      : normalizedCopy(canonicalPreview?.destinations?.[definition.id]);
    if (expected && (!copy || (typeof copy === 'object' && !Object.keys(copy).length))) {
      throw new Error(`canonical preview is missing ${definition.id} copy`);
    }
    destinationCopies[definition.id] = copy;
    destinationManifest.push({
      id: definition.id,
      label: definition.label,
      required: definition.required && expected,
      expected,
      initialStatus: expected ? 'NOT_STARTED' : 'SKIPPED',
      copyRevision: hashJson(copy),
    });
  }

  const binding = {
    version: 1,
    jobId: String(record.jobId),
    recordRevision: String(record.revision),
    factsRevision: hashJson(safeSeed(record.seed || {})),
    photoSha256: String(record.image.sha256),
    websiteCopy,
    websiteCopyRevision: hashJson(websiteCopy),
    destinationCopies,
    destinationManifestVersion: DESTINATION_MANIFEST_VERSION,
    destinationManifest,
  };
  const manifestId = `manifest_${hashJson(binding)}`;
  return {
    manifestId,
    approvalNonceHash: hashApprovalNonce(approvalNonce),
    approvalExpiresAt: expiresAt,
    createdAt,
    binding,
  };
}

export function verifyInstallationApproval(record, manifestId, approvalNonce, now = Date.now()) {
  const preview = record?.chatgptPreview;
  if (!preview || !record?.image) return { ok: false, reason: 'preview_required' };
  if (String(manifestId || '') !== preview.manifestId
    || hashApprovalNonce(approvalNonce) !== preview.approvalNonceHash) {
    return { ok: false, reason: 'approval_mismatch' };
  }
  if (preview.approvalConsumedAt) return { ok: false, reason: 'approval_consumed' };
  if (!Number.isFinite(Date.parse(preview.approvalExpiresAt || ''))
    || Date.parse(preview.approvalExpiresAt) <= Number(now instanceof Date ? now.getTime() : now)) {
    return { ok: false, reason: 'approval_expired' };
  }
  const binding = preview.binding || {};
  if (binding.jobId !== record.jobId
    || binding.recordRevision !== record.revision
    || binding.photoSha256 !== record.image.sha256
    || binding.destinationManifestVersion !== DESTINATION_MANIFEST_VERSION) {
    return { ok: false, reason: 'stale_preview' };
  }
  const expectedManifestId = `manifest_${hashJson(binding)}`;
  if (expectedManifestId !== preview.manifestId) {
    return { ok: false, reason: 'stale_preview' };
  }
  const currentRevision = canonicalRevision({ seed: record.seed, image: record.image });
  if (currentRevision !== record.revision) return { ok: false, reason: 'stale_preview' };
  return { ok: true, preview };
}

export function aggregateDestinationStatus(destinations = [], manifest = []) {
  const byId = new Map(
    (Array.isArray(destinations) ? destinations : []).map((entry) => [entry?.id, entry]),
  );
  const manifestById = new Map(
    (Array.isArray(manifest) ? manifest : []).map((entry) => [entry?.id, entry]),
  );
  const normalized = DESTINATION_DEFINITIONS.map((definition) => {
    const entry = byId.get(definition.id) || {};
    const manifestEntry = manifestById.get(definition.id) || {};
    const status = DESTINATION_STATUSES.includes(String(entry.status || '').toUpperCase())
      ? String(entry.status).toUpperCase()
      : 'INDETERMINATE';
    const expected = typeof manifestEntry.expected === 'boolean'
      ? manifestEntry.expected
      : (!definition.conditional || status !== 'SKIPPED');
    return {
      id: definition.id,
      label: definition.label,
      expected,
      // Requiredness is server-owned manifest policy. A publisher receipt can
      // report status, but it cannot downgrade a required destination.
      required: Boolean(definition.required && expected),
      status,
      receiptId: entry.receiptId ? String(entry.receiptId) : undefined,
      receiptUrl: entry.receiptUrl ? String(entry.receiptUrl) : undefined,
      detail: entry.detail ? String(entry.detail) : undefined,
    };
  });
  const website = normalized.find((entry) => entry.id === 'website');
  const required = normalized.filter((entry) => entry.required);
  const published = website?.status === 'VERIFIED'
    && required.every((entry) => SUCCESS_STATUSES.has(entry.status));
  return {
    overall: published ? 'PUBLISHED' : 'PARTIAL',
    destinations: normalized,
    retryableDestinationIds: normalized
      .filter((entry) => entry.expected && entry.status === 'TRANSIENT_FAILURE')
      .map((entry) => entry.id),
  };
}

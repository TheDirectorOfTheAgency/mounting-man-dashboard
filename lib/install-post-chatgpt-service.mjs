import { createHash, randomBytes } from 'node:crypto';

import {
  aggregateDestinationStatus,
  buildInstallationPreview,
  hashApprovalNonce,
  isPendingInstallation,
  pendingInstallationView,
  resolveInstallationReference,
  verifyInstallationApproval,
} from './install-post-chatgpt.mjs';
import { downloadChatGptPhoto } from './install-post-chatgpt-photo.mjs';
import { INSTALL_POST_STATES, publicJobView, transitionRecord } from './install-post-queue.mjs';

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function actorDigest(actor) {
  if (!actor?.sub) throw serviceError('unauthorized');
  return createHash('sha256').update(String(actor.sub)).digest('hex');
}

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  if (!match) throw serviceError('invalid_cursor');
  return Number(match[1]);
}

function previewSummary(record) {
  const preview = record?.chatgptPreview;
  if (!preview) return null;
  return {
    manifestId: preview.manifestId,
    createdAt: preview.createdAt,
    approvalExpiresAt: preview.approvalExpiresAt,
    binding: preview.binding,
  };
}

function destinationStatus(record) {
  const receipts = Array.isArray(record?.result?.destinations)
    ? record.result.destinations
    : (record?.chatgptPreview?.binding?.destinationManifest || []).map((entry) => ({
      id: entry.id,
      required: entry.required,
      status: entry.initialStatus,
    }));
  return aggregateDestinationStatus(
    receipts,
    record?.chatgptPreview?.binding?.destinationManifest || [],
  );
}

export function createChatGptInstallationService({
  store,
  photoStore,
  previewer,
  publisher,
  audit,
  allowedFileHosts = [],
  fetchImpl,
  lookupImpl,
  publishEnabled = false,
  now = Date.now,
  nonceFactory = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (!store) throw new Error('store is required');

  async function assertAudit({ actor, tool, jobId, beforeRevision }) {
    if (!audit?.record) throw serviceError('audit_unavailable');
    if (audit.assertAvailable) await audit.assertAvailable();
    await recordAudit({
      actor,
      tool,
      jobId,
      beforeRevision,
      afterRevision: beforeRevision,
      result: 'attempt',
    });
  }

  async function recordAudit({ actor, tool, jobId, beforeRevision, afterRevision, result }) {
    await audit.record({
      actorHash: actorDigest(actor),
      tool,
      jobId,
      beforeRevision: beforeRevision || null,
      afterRevision: afterRevision || null,
      result,
      requestId: actor?.requestId || null,
      at: new Date(now()).toISOString(),
    });
  }

  async function recordAuditCompletion(entry) {
    try {
      await recordAudit(entry);
    } catch {
      // The mandatory pre-action receipt already exists. Never turn a completed
      // local mutation into a caller-visible failure that encourages replay.
    }
  }

  async function loadRequired(jobId) {
    const record = await store.loadRecord(String(jobId || ''));
    if (!record) throw serviceError('not_found');
    return record;
  }

  async function allRecords() {
    const ids = await store.listJobIds();
    return (await Promise.all(ids.map((id) => store.loadRecord(id)))).filter(Boolean);
  }

  async function allPending() {
    const records = await allRecords();
    return records.filter(isPendingInstallation).sort((a, b) => (
      Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0)
      || String(a.jobId).localeCompare(String(b.jobId))
    ));
  }

  async function findManifest(manifestId) {
    const matches = (await allRecords()).filter(
      (record) => record.chatgptPreview?.manifestId === String(manifestId || ''),
    );
    if (matches.length !== 1) throw serviceError('manifest_not_found');
    return matches[0];
  }

  return {
    async listPendingInstallations({ cursor, limit = 10 } = {}) {
      const boundedLimit = Math.min(25, Math.max(1, Number(limit) || 10));
      const offset = decodeCursor(cursor);
      const records = await allPending();
      const page = records.slice(offset, offset + boundedLimit);
      const nextOffset = offset + page.length;
      return {
        installations: page.map((record) => pendingInstallationView(record, now())),
        nextCursor: nextOffset < records.length ? encodeCursor(nextOffset) : null,
      };
    },

    async getInstallationJob({ jobId } = {}) {
      const record = await loadRequired(jobId);
      return {
        job: publicJobView(record),
        preview: previewSummary(record),
        publishStatus: destinationStatus(record),
      };
    },

    async resolveInstallationReference({ reference } = {}) {
      return resolveInstallationReference(reference, await allPending(), now());
    },

    async attachInstallationPhoto({
      jobId,
      revision,
      photo,
      actor,
    } = {}) {
      const current = await loadRequired(jobId);
      if (revision !== current.revision) throw serviceError('stale_revision');
      await assertAudit({
        actor, tool: 'attach_installation_photo', jobId: current.jobId, beforeRevision: current.revision,
      });
      if (!photoStore?.normalize || !photoStore?.store) throw serviceError('photo_store_unavailable');
      const downloaded = await downloadChatGptPhoto(photo, {
        allowedHosts: allowedFileHosts, fetchImpl, lookupImpl,
      });
      const normalized = await photoStore.normalize(downloaded);
      const storedPhoto = await photoStore.store({ record: current, normalized });
      const outcome = await store.withRecordLock(current.jobId, async (locked) => {
        if (locked.revision !== revision) return null;
        const transition = transitionRecord(locked, { type: 'photo', image: storedPhoto, at: new Date(now()).toISOString() });
        return transition.ok ? transition.record : null;
      });
      if (!outcome.ok) throw serviceError(outcome.reason === 'aborted' ? 'stale_revision' : outcome.reason);
      await recordAuditCompletion({
        actor,
        tool: 'attach_installation_photo',
        jobId: current.jobId,
        beforeRevision: current.revision,
        afterRevision: outcome.record.revision,
        result: 'attached',
      });
      return { job: publicJobView(outcome.record), fileId: downloaded.fileId };
    },

    async previewInstallationPost({ jobId, revision, actor } = {}) {
      const current = await loadRequired(jobId);
      if (revision !== current.revision) throw serviceError('stale_revision');
      await assertAudit({
        actor, tool: 'preview_installation_post', jobId: current.jobId, beforeRevision: current.revision,
      });
      if (!current.image) throw serviceError('photo_required');
      if (!previewer?.preview) throw serviceError('canonical_preview_unavailable');
      const canonicalPreview = await previewer.preview({
        jobId: current.jobId,
        revision: current.revision,
        seed: current.seed,
        image: current.image,
        noNetwork: true,
      });
      const approvalNonce = nonceFactory();
      const createdAt = new Date(now()).toISOString();
      const preview = buildInstallationPreview(current, canonicalPreview, { approvalNonce, createdAt });
      const outcome = await store.withRecordLock(current.jobId, async (locked) => {
        if (locked.revision !== revision) return null;
        const transition = transitionRecord(locked, {
          type: 'preview', revision, preview, at: createdAt,
        });
        return transition.ok ? transition.record : null;
      });
      if (!outcome.ok) throw serviceError(outcome.reason === 'aborted' ? 'stale_revision' : outcome.reason);
      await recordAuditCompletion({
        actor,
        tool: 'preview_installation_post',
        jobId: current.jobId,
        beforeRevision: current.revision,
        afterRevision: outcome.record.revision,
        result: 'previewed',
      });
      return { preview: previewSummary(outcome.record), approvalNonce };
    },

    async publishInstallationEverywhere({ jobId, manifestId, approvalNonce, actor } = {}) {
      if (!publishEnabled) throw serviceError('production_publish_disabled');
      if (!publisher?.dispatch) throw serviceError('canonical_publisher_unavailable');
      const current = await findManifest(manifestId);
      if (jobId !== current.jobId) throw serviceError('manifest_not_found');
      await assertAudit({
        actor, tool: 'publish_installation_everywhere', jobId: current.jobId, beforeRevision: current.revision,
      });
      if (current.chatgptPreview?.approvalConsumedAt) {
        return {
          status: current.state === INSTALL_POST_STATES.INDETERMINATE
            ? 'DISPATCH_INDETERMINATE' : 'ALREADY_DISPATCHED',
          jobId: current.jobId,
          manifestId,
          ...destinationStatus(current),
        };
      }
      const verified = verifyInstallationApproval(current, manifestId, approvalNonce, now());
      if (!verified.ok) throw serviceError(verified.reason);
      const dispatchId = randomBytes(12).toString('hex');
      let claimed = false;
      let duplicate = false;
      const outcome = await store.withRecordLock(current.jobId, async (locked) => {
        if (locked.chatgptPreview?.approvalConsumedAt) {
          duplicate = true;
          return locked;
        }
        const valid = verifyInstallationApproval(locked, manifestId, approvalNonce, now());
        if (!valid.ok) return null;
        if (locked.approval?.manifestId === manifestId
          && [INSTALL_POST_STATES.PUBLISHING, INSTALL_POST_STATES.VERIFYING,
            INSTALL_POST_STATES.PUBLISHED, INSTALL_POST_STATES.INDETERMINATE].includes(locked.state)) {
          duplicate = true;
          return locked;
        }
        const claim = await store.claimPublishLease({
          jobId: locked.jobId, revision: locked.revision, dispatchId,
        });
        if (claim !== 'claimed') return null;
        claimed = true;
        const transition = transitionRecord(locked, {
          type: 'approve',
          revision: locked.revision,
          manifestId,
          approvalNonce,
          dispatchId,
          at: new Date(now()).toISOString(),
        });
        return transition.ok ? transition.record : null;
      });
      if (!outcome.ok) {
        if (claimed) await store.releasePublishLease({ jobId: current.jobId, revision: current.revision });
        throw serviceError(outcome.reason === 'aborted' ? 'approval_mismatch' : outcome.reason);
      }
      if (duplicate) {
        return {
          status: 'ALREADY_DISPATCHED',
          jobId: current.jobId,
          manifestId,
          ...destinationStatus(outcome.record),
        };
      }
      try {
        await recordAudit({
          actor,
          tool: 'publish_installation_everywhere',
          jobId: current.jobId,
          beforeRevision: current.revision,
          afterRevision: outcome.record.revision,
          result: 'dispatch_claimed',
        });
      } catch {
        await store.withRecordLock(current.jobId, async (locked) => ({
          ...locked,
          state: INSTALL_POST_STATES.BLOCKED,
          result: {
            status: INSTALL_POST_STATES.BLOCKED,
            message: 'Dispatch was not attempted because its audit receipt could not be stored',
          },
          updatedAt: new Date(now()).toISOString(),
        }));
        throw serviceError('audit_unavailable');
      }
      try {
        await publisher.dispatch({
          jobId: current.jobId,
          revision: current.revision,
          manifestId,
          dispatchId,
        });
      } catch {
        await store.withRecordLock(current.jobId, async (locked) => transitionRecord(locked, {
          type: 'result',
          result: {
            status: INSTALL_POST_STATES.INDETERMINATE,
            message: 'Publisher dispatch outcome is unknown; reconcile before any retry',
          },
          at: new Date(now()).toISOString(),
        }).record);
        await recordAuditCompletion({
          actor,
          tool: 'publish_installation_everywhere',
          jobId: current.jobId,
          beforeRevision: current.revision,
          afterRevision: current.revision,
          result: 'dispatch_indeterminate',
        });
        throw serviceError('canonical_dispatch_indeterminate');
      }
      await recordAuditCompletion({
        actor,
        tool: 'publish_installation_everywhere',
        jobId: current.jobId,
        beforeRevision: current.revision,
        afterRevision: current.revision,
        result: 'dispatch_submitted',
      });
      return {
        status: 'DISPATCHED',
        jobId: current.jobId,
        manifestId,
        dispatchId,
      };
    },

    async getInstallationPublishStatus({ jobId, manifestId } = {}) {
      const record = await loadRequired(jobId);
      if (manifestId && manifestId !== record.chatgptPreview?.manifestId) {
        throw serviceError('manifest_not_found');
      }
      return {
        jobId: record.jobId,
        state: record.state,
        manifestId: record.chatgptPreview?.manifestId || null,
        ...destinationStatus(record),
      };
    },

    async retryFailedDestinations({
      jobId, manifestId, approvalNonce, destinationIds: requestedIds, actor,
    } = {}) {
      if (!publishEnabled) throw serviceError('production_publish_disabled');
      if (!publisher?.retry) throw serviceError('canonical_retry_unavailable');
      const record = await findManifest(manifestId);
      if (jobId !== record.jobId) throw serviceError('manifest_not_found');
      await assertAudit({
        actor, tool: 'retry_failed_destinations', jobId: record.jobId, beforeRevision: record.revision,
      });
      const retryableDestinationIds = destinationStatus(record).retryableDestinationIds;
      const requested = [...new Set((requestedIds || []).map(String))];
      if (requested.some((destination) => !retryableDestinationIds.includes(destination))) {
        throw serviceError('destination_not_retryable');
      }
      const destinationIds = (requested.length ? requested : retryableDestinationIds).sort();
      if (!destinationIds.length) {
        return { status: 'NO_RETRYABLE_DESTINATIONS', manifestId, destinationIds: [] };
      }
      const existingRetry = record.chatgptRetry;
      if (existingRetry?.manifestId === manifestId
        && JSON.stringify(existingRetry.destinationIds) === JSON.stringify(destinationIds)
        && ['DISPATCHING', 'SUBMITTED', 'INDETERMINATE'].includes(existingRetry.status)) {
        return {
          status: existingRetry.status === 'INDETERMINATE'
            ? 'RETRY_INDETERMINATE' : 'ALREADY_DISPATCHED',
          manifestId,
          dispatchId: existingRetry.dispatchId,
          destinationIds,
        };
      }
      if (!approvalNonce) {
        const retryNonce = nonceFactory();
        const createdAt = new Date(now()).toISOString();
        const expiresAt = new Date(now() + 15 * 60 * 1000).toISOString();
        const challenge = await store.withRecordLock(record.jobId, async (current) => ({
          ...current,
          chatgptRetryApproval: {
            manifestId,
            destinationIds,
            approvalNonceHash: hashApprovalNonce(retryNonce),
            createdAt,
            expiresAt,
          },
        }));
        if (!challenge.ok) throw serviceError(challenge.reason);
        await recordAuditCompletion({
          actor,
          tool: 'retry_failed_destinations',
          jobId: record.jobId,
          beforeRevision: record.revision,
          afterRevision: record.revision,
          result: 'retry_reapproval_requested',
        });
        return {
          status: 'REAPPROVAL_REQUIRED',
          manifestId,
          destinationIds,
          approvalNonce: retryNonce,
          approvalExpiresAt: expiresAt,
        };
      }
      const dispatchId = randomBytes(12).toString('hex');
      let duplicate;
      let approvalFailure = 'retry_approval_mismatch';
      const locked = await store.withRecordLock(record.jobId, async (current) => {
        if (current.chatgptRetry?.manifestId === manifestId
          && ['DISPATCHING', 'SUBMITTED', 'INDETERMINATE'].includes(current.chatgptRetry.status)
          && JSON.stringify(current.chatgptRetry.destinationIds) === JSON.stringify(destinationIds)) {
          duplicate = current.chatgptRetry;
          return current;
        }
        const approval = current.chatgptRetryApproval;
        if (!approval
          || approval.manifestId !== manifestId
          || JSON.stringify(approval.destinationIds) !== JSON.stringify(destinationIds)
          || approval.approvalNonceHash !== hashApprovalNonce(approvalNonce)) return null;
        if (approval.consumedAt) {
          approvalFailure = 'retry_approval_consumed';
          return null;
        }
        if (!Number.isFinite(Date.parse(approval.expiresAt || ''))
          || Date.parse(approval.expiresAt) <= now()) {
          approvalFailure = 'retry_approval_expired';
          return null;
        }
        const currentRetryableIds = destinationStatus(current).retryableDestinationIds;
        if (destinationIds.some((destination) => !currentRetryableIds.includes(destination))) {
          approvalFailure = 'destination_not_retryable';
          return null;
        }
        const consumedAt = new Date(now()).toISOString();
        return {
          ...current,
          chatgptRetryApproval: { ...approval, consumedAt, dispatchId },
          chatgptRetry: {
            manifestId,
            destinationIds,
            dispatchId,
            status: 'DISPATCHING',
            createdAt: consumedAt,
          },
        };
      });
      if (!locked.ok) throw serviceError(locked.reason === 'aborted' ? approvalFailure : locked.reason);
      if (duplicate) {
        return {
          status: 'ALREADY_DISPATCHED',
          manifestId,
          dispatchId: duplicate.dispatchId,
          destinationIds,
        };
      }
      try {
        await recordAudit({
          actor,
          tool: 'retry_failed_destinations',
          jobId: record.jobId,
          beforeRevision: record.revision,
          afterRevision: record.revision,
          result: 'retry_dispatch_claimed',
        });
      } catch {
        await store.withRecordLock(record.jobId, async (current) => ({
          ...current,
          chatgptRetry: current.chatgptRetry?.dispatchId === dispatchId
            ? { ...current.chatgptRetry, status: 'BLOCKED' }
            : current.chatgptRetry,
        }));
        throw serviceError('audit_unavailable');
      }
      try {
        await publisher.retry({
          jobId: record.jobId,
          revision: record.revision,
          manifestId,
          dispatchId,
          destinationIds,
        });
      } catch {
        await store.withRecordLock(record.jobId, async (current) => ({
          ...current,
          chatgptRetry: current.chatgptRetry?.dispatchId === dispatchId
            ? { ...current.chatgptRetry, status: 'INDETERMINATE' }
            : current.chatgptRetry,
        }));
        throw serviceError('canonical_retry_indeterminate');
      }
      await store.withRecordLock(record.jobId, async (current) => ({
        ...current,
        chatgptRetry: current.chatgptRetry?.dispatchId === dispatchId
          ? { ...current.chatgptRetry, status: 'SUBMITTED' }
          : current.chatgptRetry,
      }));
      await recordAuditCompletion({
        actor,
        tool: 'retry_failed_destinations',
        jobId: record.jobId,
        beforeRevision: record.revision,
        afterRevision: record.revision,
        result: 'retry_submitted',
      });
      return { status: 'DISPATCHED', manifestId, dispatchId, destinationIds };
    },
  };
}

export { serviceError };

/** Persist bounded actor-hashed audit receipts with the authoritative record. */
export const INSTALLATION_POST_TOOL_NAMES = Object.freeze([
  'list_pending_installations',
  'get_installation_job',
  'resolve_installation_reference',
  'attach_installation_photo',
  'preview_installation_post',
  'publish_installation_everywhere',
  'get_installation_publish_status',
  'retry_failed_destinations',
]);

/** Convert the exact authenticated MCP wire contract to the service API. */
export function createInstallationPostToolService(options = {}) {
  const core = createChatGptInstallationService({
    ...options,
    publisher: options.publisher || options.dispatcher,
  });
  const actor = (context) => context?.verifiedActor || null;
  return {
    list_pending_installations: (args) => core.listPendingInstallations(args),
    get_installation_job: ({ job_id }) => core.getInstallationJob({ jobId: job_id }),
    async resolve_installation_reference({ reference }) {
      const result = await core.resolveInstallationReference({ reference });
      return result.status === 'single_candidate'
        ? { status: 'confirmation_required', candidate: result.candidate }
        : result;
    },
    attach_installation_photo: ({ job_id, expected_revision, photo }, context) => (
      core.attachInstallationPhoto({
        jobId: job_id,
        revision: expected_revision,
        photo,
        actor: actor(context),
      })
    ),
    preview_installation_post: ({ job_id, expected_revision }, context) => (
      core.previewInstallationPost({
        jobId: job_id, revision: expected_revision, actor: actor(context),
      })
    ),
    publish_installation_everywhere: ({ job_id, manifest_id, approval_nonce }, context) => (
      core.publishInstallationEverywhere({
        jobId: job_id,
        manifestId: manifest_id,
        approvalNonce: approval_nonce,
        actor: actor(context),
      })
    ),
    get_installation_publish_status: ({ job_id, manifest_id }) => (
      core.getInstallationPublishStatus({ jobId: job_id, manifestId: manifest_id })
    ),
    retry_failed_destinations: ({
      job_id, manifest_id, approval_nonce, destination_ids,
    }, context) => (
      core.retryFailedDestinations({
        jobId: job_id,
        manifestId: manifest_id,
        approvalNonce: approval_nonce,
        destinationIds: destination_ids,
        actor: actor(context),
      })
    ),
  };
}

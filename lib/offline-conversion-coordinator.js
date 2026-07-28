import crypto from 'node:crypto';

import { hasPaidClickEvidence } from './offline-conversion-eligibility.js';

const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_MODES = new Set(['observe', 'validate', 'one_shot', 'continuous', 'active']);
const ACTIVE_MODES = new Set(['continuous', 'active']);

function customerData(value = {}) {
  return {
    email: value.email || null,
    phone: value.phone || value.phoneNumber || null,
    firstName: value.firstName || value.first_name || null,
    lastName: value.lastName || value.last_name || null,
  };
}
function hasCustomerIdentifier(value) {
  return Boolean(value.email || value.phone);
}

function paymentNetAmount(payment) {
  return Number(payment.amount || 0) - Number(payment.refundedAmount || 0);
}

function paymentMatchesJob(payment, job) {
  if (String(payment.status).toUpperCase() !== 'COMPLETED') return false;
  if (String(payment.currency).toUpperCase() !== 'USD') return false;
  if (paymentNetAmount(payment) <= 0) return false;
  const paymentTime = Date.parse(payment.completedAt);
  const jobTime = Date.parse(job.completedAt);
  if (Number.isNaN(paymentTime) || Number.isNaN(jobTime)) return false;
  return Math.abs(paymentTime - jobTime) <= MATCH_WINDOW_MS;
}

function consentPredatesDisclosure(job) {
  const datedVersion = String(job.disclosureVersion || '').match(/^\d{4}-\d{2}-\d{2}$/);
  if (!datedVersion) return false;
  return Date.parse(job.consentCapturedAt) < Date.parse(`${datedVersion[0]}T00:00:00.000Z`);
}

function storedJobEvidenceStatus(job) {
  if (!job?.completedAt || Number.isNaN(Date.parse(job.completedAt))) {
    return 'missing_completion_time';
  }
  if (!job.disclosureVersion) return 'missing_privacy_disclosure';
  if (String(job.consentStatus).toUpperCase() === 'DENIED') return 'consent_denied';
  if (!hasPaidClickEvidence(job.acquisition)) return 'missing_paid_click_evidence';
  return null;
}

export function createOfflineConversionCoordinator({ store, uploadConversion, mode = 'observe' }) {
  if (!store) throw new Error('Attribution store is required');
  if (typeof uploadConversion !== 'function') throw new Error('Upload function is required');
  if (!ALLOWED_MODES.has(mode)) throw new Error(`Offline conversion mode is not enabled: ${mode}`);

  async function mappingMatchesJob(job, squareCustomerId) {
    const mapping = await store.getJobMapping(job.jobRef);
    if (!mapping?.squareCustomerId) return false;
    return String(mapping.squareCustomerId) === String(squareCustomerId);
  }

  async function resolveCustomer({
    squareCustomerId,
    userData = {},
    selectedJobRef = null,
    selectedPaymentRef = null,
    expectedPaymentNetAmount = null,
    inspectOnly = false,
  }) {
    const [jobs, payments] = await Promise.all([
      store.listPendingJobs(squareCustomerId),
      selectedPaymentRef
        ? store.getPayment(squareCustomerId, selectedPaymentRef).then((payment) =>
          payment ? [payment] : []
        )
        : store.listPayments(squareCustomerId),
    ]);
    const selectedJobs = selectedJobRef
      ? jobs.filter((job) => job.jobRef === selectedJobRef)
      : jobs;
    if (selectedJobs.length === 0) {
      return { status: selectedJobRef ? 'missing_pending_job' : 'pending_job', jobRef: selectedJobRef };
    }

    const unresolvedJobs = [];
    for (const pendingJob of selectedJobs) {
      if (await store.hasSuccess(pendingJob.jobRef)) continue;
      unresolvedJobs.push(pendingJob);
    }
    if (unresolvedJobs.length === 0) {
      return { status: 'already_uploaded', jobRef: selectedJobs[0].jobRef };
    }

    for (const pendingJob of unresolvedJobs) {
      if (!(await mappingMatchesJob(pendingJob, squareCustomerId))) {
        return { status: 'missing_or_mismatched_mapping', jobRef: pendingJob.jobRef };
      }
      const evidenceStatus = storedJobEvidenceStatus(pendingJob);
      if (
        evidenceStatus
        && (evidenceStatus === 'consent_denied' || mode !== 'observe' || inspectOnly)
      ) {
        return { status: evidenceStatus, jobRef: pendingJob.jobRef };
      }
    }

    if (selectedPaymentRef && payments.length === 0) {
      return {
        status: 'missing_or_mismatched_payment',
        jobRef: selectedJobRef || unresolvedJobs[0].jobRef,
        paymentRef: selectedPaymentRef,
      };
    }
    if (payments.length === 0) return { status: 'pending_payment' };

    const exactPaymentRequired = mode !== 'observe' || inspectOnly;
    const activeMode = ACTIVE_MODES.has(mode);
    const automaticActiveMatch = activeMode && !selectedPaymentRef && !inspectOnly;
    if (
      exactPaymentRequired
      && !automaticActiveMatch
      && (
        !selectedPaymentRef
        || !Number.isInteger(expectedPaymentNetAmount)
      )
    ) {
      return {
        status: 'payment_assertion_required',
        jobRef: selectedJobRef || unresolvedJobs[0].jobRef,
      };
    }
    const eligiblePayments = selectedPaymentRef
      ? payments.filter((payment) => payment.paymentRef === selectedPaymentRef)
      : payments;
    if (selectedPaymentRef && eligiblePayments.length === 0) {
      return {
        status: 'missing_or_mismatched_payment',
        jobRef: selectedJobRef || unresolvedJobs[0].jobRef,
        paymentRef: selectedPaymentRef,
      };
    }
    if (
      selectedPaymentRef
      && paymentNetAmount(eligiblePayments[0]) !== expectedPaymentNetAmount
    ) {
      return {
        status: 'payment_value_mismatch',
        jobRef: selectedJobRef || unresolvedJobs[0].jobRef,
        paymentRef: selectedPaymentRef,
      };
    }

    const matches = unresolvedJobs.map((pendingJob) => ({
      job: pendingJob,
      payments: eligiblePayments.filter((candidate) => paymentMatchesJob(candidate, pendingJob)),
    }));
    const ambiguous = matches.find((entry) => entry.payments.length > 1);
    if (ambiguous) return { status: 'ambiguous_payment', jobRef: ambiguous.job.jobRef };

    const resolved = matches.filter((entry) => entry.payments.length === 1);
    if (resolved.length === 0) return { status: 'pending_payment' };
    if (resolved.length > 1) return { status: 'ambiguous_job_payment' };

    const { job, payments: [payment] } = resolved[0];
    if (mode !== 'observe' && !inspectOnly && !payment.trustedWebhook) {
      return {
        status: 'untrusted_payment',
        jobRef: job.jobRef,
        paymentRef: payment.paymentRef,
      };
    }
    const identifiers = customerData(userData);
    if (!hasCustomerIdentifier(identifiers)) {
      return { status: 'missing_customer_identifier', jobRef: job.jobRef };
    }
    const evidenceSummary = {
      paymentRef: payment.paymentRef,
      paidMarker: job.acquisition.paidMarker,
      conversionValue: paymentNetAmount(payment) / 100,
      evidence: ['job_mapping', 'pending_job', 'stored_payment', `paid_${job.acquisition.paidMarker}`],
    };
    if (inspectOnly) {
      return {
        status: 'ready',
        jobRef: job.jobRef,
        ...evidenceSummary,
      };
    }
    if (mode === 'observe') {
      return {
        status: 'observed',
        jobRef: job.jobRef,
        paidEvidence: Boolean(job.acquisition?.paidEvidence),
      };
    }

    const uploadInput = {
      ...identifiers,
      conversionValue: paymentNetAmount(payment) / 100,
      conversionDateTime: job.completedAt,
      orderId: job.jobRef,
      consentStatus: job.consentStatus,
      validateOnly: mode === 'validate',
    };

    if (mode === 'validate') {
      const result = await uploadConversion(uploadInput);
      return {
        status: result.success ? 'validated' : 'validation_failed',
        jobRef: job.jobRef,
        retryable: Boolean(result.retryable),
        errorCode: result.errorCode || null,
        ...evidenceSummary,
      };
    }

    if (String(job.consentStatus).toUpperCase() !== 'GRANTED') {
      return { status: 'consent_not_granted', jobRef: job.jobRef };
    }
    if (!job.consentCapturedAt || Number.isNaN(Date.parse(job.consentCapturedAt))) {
      return { status: 'missing_consent_capture_time', jobRef: job.jobRef };
    }
    if (!job.disclosureVersion) {
      return { status: 'missing_privacy_disclosure', jobRef: job.jobRef };
    }
    if (consentPredatesDisclosure(job)) {
      return { status: 'consent_predates_disclosure', jobRef: job.jobRef };
    }

    if (!(await store.bindPaymentToJob(payment.paymentRef, job.jobRef))) {
      return {
        status: 'payment_already_bound',
        jobRef: job.jobRef,
        paymentRef: payment.paymentRef,
      };
    }
    const activeClaimOwner = activeMode ? crypto.randomUUID() : null;
    if (activeMode) {
      if (!(await store.claimActiveUpload(job.jobRef, activeClaimOwner))) {
        if (await store.hasSuccess(job.jobRef)) {
          return { status: 'already_uploaded', jobRef: job.jobRef };
        }
        return { status: 'upload_in_progress', jobRef: job.jobRef, retryable: true };
      }
    } else if (!(await store.claimOneShot(job.jobRef))) {
      return { status: 'one_shot_already_claimed', jobRef: job.jobRef };
    }

    let result;
    try {
      result = await uploadConversion(uploadInput);
      if (!result.success) {
        if (activeMode) await store.releaseActiveUpload(job.jobRef, activeClaimOwner);
        else await store.releaseOneShot(job.jobRef);
        return {
          status: 'upload_failed',
          jobRef: job.jobRef,
          retryable: Boolean(result.retryable),
          errorCode: result.errorCode || null,
          ...evidenceSummary,
        };
      }

      await store.markSuccess(job.jobRef, { googleRequestId: result.googleRequestId });
      if (activeMode) await store.releaseActiveUpload(job.jobRef, activeClaimOwner);
      return { status: 'uploaded', jobRef: job.jobRef, ...evidenceSummary };
    } catch (error) {
      if (activeMode) await store.releaseActiveUpload(job.jobRef, activeClaimOwner);
      else await store.releaseOneShot(job.jobRef);
      throw error;
    }
  }

  return {
    async registerJob(job) {
      await store.savePendingJob(job);
      return resolveCustomer({
        squareCustomerId: job.squareCustomerId,
        userData: customerData(job),
      });
    },

    async registerPayment(payment, { customer = {} } = {}) {
      const storedPayment = await store.savePayment(payment);
      return resolveCustomer({
        squareCustomerId: payment.squareCustomerId,
        userData: customerData(customer),
        selectedPaymentRef: storedPayment.paymentRef,
        expectedPaymentNetAmount: paymentNetAmount(storedPayment),
      });
    },

    async resolveJob(jobRef, {
      customer = {},
      paymentRef = null,
      expectedPaymentNetAmount = null,
    } = {}) {
      const mapping = await store.getJobMapping(jobRef);
      if (!mapping?.squareCustomerId) {
        return { status: 'missing_or_mismatched_mapping', jobRef };
      }
      return resolveCustomer({
        squareCustomerId: mapping.squareCustomerId,
        userData: customerData(customer),
        selectedJobRef: jobRef,
        selectedPaymentRef: paymentRef,
        expectedPaymentNetAmount,
      });
    },

    async inspectJob(jobRef, {
      customer = {},
      paymentRef = null,
      expectedPaymentNetAmount = null,
    } = {}) {
      const mapping = await store.getJobMapping(jobRef);
      if (!mapping?.squareCustomerId) {
        return { status: 'missing_or_mismatched_mapping', jobRef };
      }
      return resolveCustomer({
        squareCustomerId: mapping.squareCustomerId,
        userData: customerData(customer),
        selectedJobRef: jobRef,
        selectedPaymentRef: paymentRef,
        expectedPaymentNetAmount,
        inspectOnly: true,
      });
    },

    resolveCustomer,
  };
}

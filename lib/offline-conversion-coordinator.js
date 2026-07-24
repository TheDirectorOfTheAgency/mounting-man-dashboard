const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_MODES = new Set(['observe', 'validate', 'one_shot']);

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

export function createOfflineConversionCoordinator({ store, uploadConversion, mode = 'observe' }) {
  if (!store) throw new Error('Attribution store is required');
  if (typeof uploadConversion !== 'function') throw new Error('Upload function is required');
  if (!ALLOWED_MODES.has(mode)) throw new Error(`Offline conversion mode is not enabled: ${mode}`);

  async function resolveCustomer({ squareCustomerId, userData = {} }) {
    const [jobs, payments] = await Promise.all([
      store.listPendingJobs(squareCustomerId),
      store.listPayments(squareCustomerId),
    ]);
    if (jobs.length === 0) return { status: 'pending_job' };

    const unresolvedJobs = [];
    for (const pendingJob of jobs) {
      if (await store.hasSuccess(pendingJob.jobRef)) continue;
      unresolvedJobs.push(pendingJob);
    }
    if (unresolvedJobs.length === 0) {
      return { status: 'already_uploaded', jobRef: jobs[0].jobRef };
    }

    const matches = unresolvedJobs.map((pendingJob) => ({
      job: pendingJob,
      payments: payments.filter((candidate) => paymentMatchesJob(candidate, pendingJob)),
    }));
    const ambiguous = matches.find((entry) => entry.payments.length > 1);
    if (ambiguous) return { status: 'ambiguous_payment', jobRef: ambiguous.job.jobRef };

    const resolved = matches.filter((entry) => entry.payments.length === 1);
    if (resolved.length === 0) return { status: 'pending_payment' };
    if (resolved.length > 1) return { status: 'ambiguous_job_payment' };

    const { job, payments: [payment] } = resolved[0];
    const identifiers = customerData(userData);
    if (!hasCustomerIdentifier(identifiers)) {
      return { status: 'missing_customer_identifier', jobRef: job.jobRef };
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
      };
    }

    if (!(await store.claimOneShot(job.jobRef))) {
      return { status: 'one_shot_already_claimed', jobRef: job.jobRef };
    }

    const result = await uploadConversion(uploadInput);
    if (!result.success) {
      await store.releaseOneShot(job.jobRef);
      return {
        status: 'upload_failed',
        jobRef: job.jobRef,
        retryable: Boolean(result.retryable),
        errorCode: result.errorCode || null,
      };
    }

    await store.markSuccess(job.jobRef, { googleRequestId: result.googleRequestId });
    return { status: 'uploaded', jobRef: job.jobRef };
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
      await store.savePayment(payment);
      return resolveCustomer({
        squareCustomerId: payment.squareCustomerId,
        userData: customerData(customer),
      });
    },

    resolveCustomer,
  };
}

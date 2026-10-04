/**
 * Net conversion value for a completed Square payment.
 * Tips are excluded. Refunds are subtracted. Inputs are cents.
 * LEDGER-2026-10-04-CONVERSION-TRACKING
 */

export function roundCents(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[$,\s]/g, '');
    if (!cleaned) return 0;
    value = Number(cleaned);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount);
}

export function centsToDollars(cents) {
  return Number((roundCents(cents) / 100).toFixed(2));
}

/**
 * @param {object} input
 * @param {number|string} input.amountCents Service amount, or the total when amountIncludesTip is true.
 * @param {number|string} [input.tipCents]
 * @param {number|string} [input.refundCents]
 * @param {boolean} [input.amountIncludesTip] Square amount_money already excludes tip. total_money does not.
 */
export function netJobValueCents({
  amountCents = 0,
  tipCents = 0,
  refundCents = 0,
  amountIncludesTip = false,
} = {}) {
  const amount = roundCents(amountCents);
  const tip = Math.max(0, roundCents(tipCents));
  const refund = Math.max(0, roundCents(refundCents));
  const service = amountIncludesTip ? amount - tip : amount;
  return service - refund;
}

export function netCentsFromSquarePayment(payment = {}) {
  const amount = payment.amount_money?.amount;
  const total = payment.total_money?.amount;
  const tip = payment.tip_money?.amount ?? payment.tipAmount ?? 0;
  const refund = payment.refunded_money?.amount ?? payment.refundedAmount ?? 0;
  if (amount !== undefined && amount !== null && amount !== '') {
    return netJobValueCents({
      amountCents: amount,
      tipCents: tip,
      refundCents: refund,
      amountIncludesTip: false,
    });
  }
  return netJobValueCents({
    amountCents: total ?? payment.amount ?? 0,
    tipCents: tip,
    refundCents: refund,
    amountIncludesTip: true,
  });
}

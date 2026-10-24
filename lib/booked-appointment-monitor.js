// Booked Appointment health check (LEDGER-2026-10-24-BA-ZERO).
// Read-only: one GAQL searchStream query on Google Ads and one ZenBooker jobs
// list. Never writes to Google Ads. Alerts (urgent, kind
// booked_appointment_zero_48h) when Ads recorded 0 Booked Appointment
// conversions in the last 48h while ZenBooker created >= MIN_BOOKINGS jobs.

export const BOOKED_APPOINTMENT_ACTION_ID = '6491204814';
export const ADS_CUSTOMER_ID = '1287907452';
export const WINDOW_MS = 48 * 60 * 60 * 1000;
export const MIN_BOOKINGS = 2;
export const ALERT_KIND = 'booked_appointment_zero_48h';

const CREATED_FIELDS = ['created', 'created_at', 'createdAt', 'date_created', 'created_date', 'booked_at'];

function ctDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function jobCreatedMs(job) {
  for (const f of CREATED_FIELDS) {
    const v = job?.[f];
    if (v == null || v === '') continue;
    const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Counts jobs created inside [now - WINDOW_MS, now]. Returns null count when
// no job carries a usable creation timestamp (cannot judge, so never alert).
export function countRecentBookings(jobs, nowMs) {
  const since = nowMs - WINDOW_MS;
  let withCreated = 0;
  let count = 0;
  const seen = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const id = job?.id ?? job?.job_id;
    if (id != null) { if (seen.has(String(id))) continue; seen.add(String(id)); }
    const ms = jobCreatedMs(job);
    if (ms == null) continue;
    withCreated += 1;
    if (ms >= since && ms <= nowMs) count += 1;
  }
  return { count: withCreated ? count : null, jobsScanned: seen.size || (jobs || []).length, withCreated };
}

// Ads reports by day, so the 48h window is the three CT dates it touches
// (day-before-yesterday partial, yesterday, today). Conservative: any
// conversion in that span suppresses the alert.
export function bookedAppointmentQuery(nowMs) {
  const start = ctDate(nowMs - WINDOW_MS);
  const end = ctDate(nowMs);
  return {
    start,
    end,
    query: `SELECT segments.conversion_action, metrics.all_conversions_by_conversion_date FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}' AND segments.conversion_action = 'customers/${ADS_CUSTOMER_ID}/conversionActions/${BOOKED_APPOINTMENT_ACTION_ID}'`,
  };
}

export function sumConversions(rows) {
  let total = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = Number(r?.metrics?.allConversionsByConversionDate ?? r?.metrics?.all_conversions_by_conversion_date ?? 0);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

export function decideAlert({ adsConversions, bookings }) {
  if (adsConversions == null) return { alert: false, reason: 'ads_unavailable' };
  if (bookings == null) return { alert: false, reason: 'bookings_unavailable' };
  if (adsConversions > 0) return { alert: false, reason: 'ads_has_conversions' };
  if (bookings < MIN_BOOKINGS) return { alert: false, reason: 'too_few_bookings' };
  return { alert: true, reason: 'zero_conversions_with_bookings' };
}

export function buildAlert({ adsConversions, bookings, start, end }) {
  return {
    kind: ALERT_KIND,
    subject: 'Booked Appointment shows 0 conversions in 48h',
    body: `Google Ads Booked Appointment (${BOOKED_APPOINTMENT_ACTION_ID}) recorded ${adsConversions} conversions for ${start} to ${end} (CT, conversion date) while ZenBooker created ${bookings} bookings in the last 48h. Check /thank-you booking_confirmed, GTM-M7RR6GT3 and the ZenBooker redirect.`,
  };
}

export async function runBookedAppointmentMonitor({ now = Date.now(), queryAds, listJobs, alert, dryRun = false }) {
  const { start, end, query } = bookedAppointmentQuery(now);
  let adsConversions = null;
  let adsError = null;
  try { adsConversions = sumConversions(await queryAds(query)); } catch (e) { adsError = String(e?.code || e?.response?.status || 'ads_error'); }
  let bookings = null;
  let jobsScanned = 0;
  let bookingsError = null;
  try {
    const jobs = await listJobs({ startDateMin: ctDate(now - WINDOW_MS), startDateMax: ctDate(now + 120 * 86400000) });
    const c = countRecentBookings(jobs, now);
    bookings = c.count; jobsScanned = c.jobsScanned;
  } catch (e) { bookingsError = String(e?.code || 'zenbooker_error'); }
  const decision = decideAlert({ adsConversions, bookings });
  const summary = { window: { start, end }, adsConversions, bookings, jobsScanned, adsError, bookingsError, ...decision, dryRun, alertResult: null };
  if (decision.alert) {
    const payload = buildAlert({ adsConversions, bookings, start, end });
    summary.alertPreview = payload.subject;
    if (!dryRun) {
      try { const r = await alert(payload); summary.alertResult = r ? { delivered: !!r.delivered, channel: r.channel || null } : null; }
      catch { summary.alertResult = { delivered: false, channel: null }; }
    }
  }
  return summary;
}

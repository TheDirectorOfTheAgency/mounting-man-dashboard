# Enhanced-conversion user data on /thank-you

`public/tmm-attribution-v1.js` pushes one `booking_confirmed` event per
`/thank-you` page load, for every booking (paid or not):

```js
dataLayer.push({
  event: 'booking_confirmed',
  booking_session: '<id from the URL>',          // omitted if the URL has none
  user_data: {                                    // omitted if the lookup fails or takes >3s
    sha256_email_address: '<64 hex chars>',       // omitted if the booking has no usable email
    sha256_phone_number: '<64 hex chars>',        // omitted if the booking has no usable phone
  },
});
```

For paid bookings the script still sends the click-ID capture POST first, waits up
to 800 ms for that request to finish, then calls
`POST /api/attribution/booking-identity` with `{ customer_id, booking_session }`.
Organic/unpaid thank-you pages skip the capture wait and call identity
immediately. The event is pushed when identity returns or 3 seconds after page
load, whichever is first (exactly once).

## Endpoint: `POST /api/attribution/booking-identity`

- Origin-locked to `https://www.themountingman.com` (CORS preflight returns 204; other
  origins get 403).
- Fetches Zenbooker jobs for `customer_id` created in the last 48 hours
  (`GET /v1/jobs?customer=...&created_after=...`, 1200 ms timeout, one retry at
  900 ms on timeout/network/5xx/429 only).
- Identity resolution order (first match wins; `path` is logged server-side only):
  1. **exact_session** — job `booking_session` (or alias fields) equals the request session.
  2. **stored** — KV job-bridge mapping for this session.
  3. **window** — exactly one in-window capture and job. The capture's `sessionRef`
     must match the request `booking_session`, and its `customerId` must equal the
     request `customer_id` (writes a bridge mapping for attribution). New captures
     persist an opaque customer reference; the store exposes `customerId` in memory
     only after verifying that reference. Legacy captures without the reference
     cannot use the window path. Raw customer IDs remain absent from KV.
- Every path requires the job's customer ID to be present and equal the request
  `customer_id`; jobs with missing customer IDs cannot match.
- The **recent_customer_job** fallback was removed because a customer's recent job
  does not prove that the supplied `booking_session` belongs to that booking.
  Returning email/phone hashes through that fallback exposed identifiers to callers
  supplying an unrelated session. `BOOKING_IDENTITY_RECENT_MS` no longer applies.
- Returns `200 { found: true, user_data: { sha256_email_address?, sha256_phone_number? } }`
  or `404 { found: false, errorCode: 'BOOKING_NOT_FOUND' }`. `400` bad reference,
  `403` origin, `429` rate limit (20 requests/minute/client, per serverless instance),
  `503` lookup failure. Plain email/phone are never returned or logged; logs carry only
  an opaque 12-character booking ref, `path`, `durationMs`, `jobsSeen`, and
  `upstreamKind` when applicable.
- Normalization before SHA-256: email trimmed + lowercased, dots removed from the local
  part for gmail.com/googlemail.com; phone converted to E.164 (`+1` assumed for 10-digit
  numbers, a leading `+` keeps the given country code).

## Zenbooker job payloads (confirmed)

Production `job.completed` / `GET /v1/jobs` payloads do **not** include a booking
session field. Observed top-level keys include: `start_date`, `end_date`,
`time_slot`, `rescheduled`, `canceled`, `status`, `enroute_at`, `eta`,
`started_at`, `completed_at`, `created_by`, `conversion_summary`, `territory`,
`timezone`, `recurring`, `recurring_instance`, `service_address`, `customer`,
`estimated_duration_seconds`, `services`, `service_summary`, `job_notes`,
`job_number`, `recurring_booking`, `min_providers_required`,
`skill_tags_required`, `unable_to_auto_assign`, `job_offer`, `assigned_providers`,
`rating`, `billing`, `invoice`, `id`, `created`. Identity therefore relies on stored
bridges or a verified capture window when the job has no session field. Without
a verified session-to-job link, identity returns 404 and `booking_confirmed` still
fires without enhanced-conversion `user_data`.

## GTM (manual)

The Booked Appointment conversion tag must fire on the Custom Event
`booking_confirmed` (Page URL contains `thank-you`), **not** on the page view or
`gtm.js`—otherwise the tag runs before `user_data` exists. Add Data Layer
Variables for `user_data.sha256_email_address` and `user_data.sha256_phone_number`
(or use the "user-provided data" variable's manual configuration with the pre-hashed
fields), and turn enhanced conversions on for the conversion tag.

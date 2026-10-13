# Enhanced-conversion user data on /thank-you

`public/tmm-attribution-v1.js` pushes one `booking_confirmed` event per
`/thank-you` page load, for every booking (paid or not):

```js
dataLayer.push({
  event: 'booking_confirmed',
  booking_session: '<id from the URL>',          // omitted if the URL has none
  transaction_id: '<same booking session id>',    // order id for the Booked Appointment tag
  user_data: {                                    // omitted if the lookup fails or takes >4.5s
    sha256_email_address: '<64 hex chars>',       // omitted if the booking has no usable email
    sha256_phone_number: '<64 hex chars>',        // omitted if the booking has no usable phone
  },
});
```

For paid bookings the script still sends the click-ID capture POST first, waits up
to 800 ms for that request to finish, then calls
`POST /api/attribution/booking-identity` with `{ customer_id, booking_session }`.
Organic/unpaid thank-you pages skip the capture wait and call identity
immediately. The event is pushed when identity returns or 4.5 seconds after page
load, whichever is first (exactly once). Identity gets up to 3.7 s.

## Endpoint: `POST /api/attribution/booking-identity`

- Origin-locked to `https://www.themountingman.com` (CORS preflight returns 204; other
  origins get 403).
- Fetches Zenbooker jobs for `customer_id` created in the last 48 hours
  (`GET /v1/jobs?customer=...&created_after=...`). One 1500 ms attempt, then the
  job-not-created backoff (400 ms, 600 ms) re-queries while nothing is visible or the
  call timed out / hit network, 429 or 5xx, all inside a 3400 ms server deadline.
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

## Server-side fallback (deferred enhancement)

When the thank-you lookup cannot resolve in time, the endpoint parks the booking
(`ec:pending:<sessionRef>`: booking session id as the Google order id, an opaque
customer ref, timestamp; 26 h TTL). It is resolved later, once the ZenBooker job
exists **and** is linked to that exact session by the KV session→job bridge:

- immediately from `/api/webhooks/zenbooker-to-square` when the job event arrives, and
- every 15 minutes by `/api/cron/deferred-booking-identity` (CRON_SECRET; `?validateOnly=1`).

The job's customer ID must equal the one the thank-you page sent (compared by opaque
ref). Email/phone are normalized and SHA-256 hashed exactly as above and sent with
`uploadConversionAdjustments` as an **ENHANCEMENT** of the Booked Appointment WEBPAGE
action (6491204814, override `GOOGLE_ADS_BOOKED_APPOINTMENT_ACTION_ID`), keyed by
`order_id = booking_session`. Records older than 23 h are dropped (Google accepts
enhancements up to 24 h after the conversion).

No double counting: an enhancement never creates a conversion; it attaches identifiers
to the one the tag already recorded under that order id. In addition, a booking the
thank-you path resolved in time is marked `ec:thankyou:<sessionRef>` and never parked,
an accepted enhancement is marked `ec:enhanced:<sessionRef>`, and Google rejects any
second enhancement (`CONVERSION_ALREADY_ENHANCED`). Logs: `booking_identity_deferred`
with 12-char bookingRef/jobRef, outcome, hashed field names and Google error codes only.

**GTM requirement:** the Booked Appointment tag must set *Transaction ID* to the
`transaction_id` Data Layer Variable. Without it, deferred enhancements are rejected
with `CONVERSION_NOT_FOUND` (logged as `outcome: rejected`).

# Enhanced-conversion user data on /thank-you

`public/tmm-attribution-v1.js` pushes one `booking_confirmed` event per
`/thank-you` page load, for every booking (paid or not):

```js
dataLayer.push({
  event: 'booking_confirmed',
  booking_session: '<id from the URL>',          // omitted if the URL has none
  user_data: {                                    // omitted if the lookup fails or takes >2s
    sha256_email_address: '<64 hex chars>',       // omitted if the booking has no usable email
    sha256_phone_number: '<64 hex chars>',        // omitted if the booking has no usable phone
  },
});
```

The script first sends the existing paid click-ID capture POST (unchanged), then
calls `POST /api/attribution/booking-identity` with `{ customer_id, booking_session }`
and pushes the event when the call returns or after 2 seconds, whichever is first.

## Endpoint: `POST /api/attribution/booking-identity`

- Origin-locked to `https://www.themountingman.com` (CORS preflight returns 204; other
  origins get 403).
- Looks up Zenbooker jobs for `customer_id` created in the last 48 hours
  (`GET /v1/jobs?customer=...&created_after=...`) and requires a job whose
  `booking_session` exactly equals the request's session and whose customer id matches.
- Returns `200 { found: true, user_data: { sha256_email_address?, sha256_phone_number? } }`
  or `404 { found: false, errorCode: 'BOOKING_NOT_FOUND' }`. `400` bad reference,
  `403` origin, `429` rate limit (20 requests/minute/client, per serverless instance),
  `503` lookup failure. Plain email/phone are never returned or logged; logs carry only
  an opaque 12-character booking ref.
- Normalization before SHA-256: email trimmed + lowercased, dots removed from the local
  part for gmail.com/googlemail.com; phone converted to E.164 (`+1` assumed for 10-digit
  numbers, a leading `+` keeps the given country code).

## GTM (manual)

Move the Booked Appointment trigger to the Custom Event `booking_confirmed`, add Data
Layer Variables for `user_data.sha256_email_address` and `user_data.sha256_phone_number`
(or use the "user-provided data" variable's manual configuration with the pre-hashed
fields), and turn enhanced conversions on for the conversion tag.

## Assumption to verify

Zenbooker's documented jobs list does not list a booking-session field. The endpoint
reads `booking_session` (also `booking_session_id`, `bookingSession`, `bookingSessionId`)
from the job, the same fields the `job.completed` webhook reader uses. If the API does
not return one, every lookup yields `BOOKING_NOT_FOUND` and the page still pushes
`booking_confirmed` without `user_data`.

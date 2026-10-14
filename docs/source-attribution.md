# Source attribution

Every visitor who reaches a ZenBooker booking link or embed is recorded with a
first touch and a last touch. The session id is the same `booking_session` the
paid-click bridge already matches. Sessions store source, referrer host, UTM
parameters, click ids, landing path, and timestamps. They do not store a name,
email, or phone. Matching a session to a job happens on the server. The browser
only receives `{ captured: true }`.

Paid click capture on `/thank-you` is unchanged. `public/tmm-attribution-v1.js`
still posts gclid, gbraid, and wbraid to `/api/attribution/booking`, and that
route still rejects a capture that has no paid evidence.

## How the session reaches ZenBooker

ZenBooker generates `booking_session` and appends it to the thank-you redirect,
along with `customer_id`. The paid script reads those two values and posts them.
This snippet does the same join for every source:

1. On a page with a ZenBooker link or embed it mints (or reuses) a session id,
   stores the touch in a first-party cookie and localStorage for 90 days, and
   appends `booking_session` to ZenBooker links and iframes.
2. It POSTs that session to `/api/attribution/visit` with the touch and no
   customer id. If the job payload later carries that `booking_session`, the
   bridge matches it exactly.
3. On `/thank-you` it POSTs again using ZenBooker's `booking_session` and
   `customer_id`. That is the same handoff the paid path uses, so a job with no
   session field still matches inside the existing 15-minute bridge window.

An unpaid session is stored beside the paid session record. It never overwrites
a paid click id. The bridge checks the paid session first, then the unpaid
session, and only then the unpaid customer window when the paid window has no
capture.

## Install

One script tag, site-wide, in addition to the existing paid-click snippet if
that snippet is already in GTM. Do not edit the GTM container for this.

### Webflow (`www.themountingman.com`)

Project settings → Custom code → Footer code (site-wide):

```html
<script src="https://mounting-man-dashboard.vercel.app/tmm-source-v1.js" defer></script>
```

### Astro (`TheDirectorOfTheAgency/tmm-nationwide`, themountingmanusa.com)

Put the same tag in the site-wide layout `<head>` (the base layout, for example
`src/layouts/Base.astro`, once that layout exists). This repo does not edit
tmm-nationwide.

```html
<script src="https://mounting-man-dashboard.vercel.app/tmm-source-v1.js" defer></script>
```

`themountingmanusa.com` and `www.themountingmanusa.com` are already allowed to
call the visit endpoint. Add any other origin, such as a Cloudflare Pages
preview host, as a comma-separated `ATTRIBUTION_ALLOWED_ORIGINS` value in Vercel.
That variable is not set yet.

## Google Business Profile website link

Use this URL as the website link on the Google Business Profile:

```text
https://www.themountingman.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp
```

Those three parameters classify the visit as Google Business Profile. A Maps
referrer (`maps.google.*`, `google.*/maps`, `maps.app.goo.gl`, `g.page`) is
classified the same way when the UTM parameters are missing.

## Report

`GET /api/attribution/sources` returns jobs, revenue, and share by first touch
and last touch for each month. Unknown is its own bucket. Repeat bookings,
matched to an earlier job by customer id or a hash of email or phone, are
counted on the month and on each bucket. The dashboard panel "JOBS BY SOURCE"
reads this endpoint. The response has no job id and no contact data.
It answers only same-origin browser fetches from the dashboard (Sec-Fetch-Site:
same-origin) or `Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET|CRON_SECRET>`;
anything else gets 401. The dashboard page itself has no login, so this blocks
cross-site reads and casual scraping, not a determined client.

Job rows stay for 400 days. The visitor cookie and the session record expire
after 90 days.

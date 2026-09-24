# Frozen — not the canonical publisher

As of 2026-09-24 (THE-273), this cloud runner is **frozen and non-canonical**.

- The canonical install-post publisher is the M1 script in `jewel-way-run`.
  Do not fork it here, and do not port fixes from it into this directory.
- GitHub Actions dispatch (`.github/workflows/publish-install-post.yml`) is off:
  `INSTALL_POST_DISPATCH_TOKEN` stays empty, so the dashboard never dispatches
  and gate-passed jobs park as `READY_FOR_M1`. Re-enabling needs Mr. Wayne's
  explicit yes.
- GBP stays paste-pack only. No machine GBP posting, no Reddit.

What still matters here:

- `references/location-ids.md` and `references/location-slugs.json` are the
  source for the dashboard's `lib/install-post-locations.mjs`.
  `tests/install-post-locations.test.mjs` fails if they drift apart, so edit
  both together.
- The Python tests stay in CI so the frozen code keeps importing cleanly.
  Leave behavior changes out.

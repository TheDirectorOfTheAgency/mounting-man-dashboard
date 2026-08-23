// pages/install-posts/open.js
//
// The phone card, opened from the Discord notification.
//
// The link is `/install-posts/open#<capability>`. The capability sits in the
// fragment, which the browser never sends to a server, so it reaches no request
// line, referrer, or access log. On load the page trades it, once, through a
// POST body for an HttpOnly session cookie and scrubs the fragment out of the
// address bar and history in the same tick — after that the page URL is inert
// and a screenshot, a shared link, or the back button leaks nothing.
//
// Flow: read the safe facts → fix anything wrong → take/choose the photo (the
// browser converts it to bounded WebP and uploads it straight to Webflow) →
// tap Publish once. Any change to the facts or the photo invalidates the
// approval and requires another tap.

import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { prepareInstallPhoto } from '../../lib/install-post-photo-client.mjs';
import { installPostPollDelayMs } from '../../lib/install-post-states.mjs';
import styles from '../../styles/InstallPostQueue.module.css';

const FACT_LABELS = {
  'job-type': 'Job type',
  'tv-size': 'TV size',
  'tv-brand': 'TV brand',
  'wall-surface': 'Wall surface',
  'fireplace-type': 'Fireplace',
  'mount-type': 'Mount',
  'bracket-type': 'Bracket',
  'cable-management': 'Cables',
  'soundbar-mounting': 'Soundbar',
  'room-type': 'Room',
  'hardware-used': 'Hardware',
  'gallery-style': 'Gallery style',
  mantelmount: 'MantelMount',
  city: 'City',
  state: 'State',
  'street-name': 'Street',
  price: 'Price',
  'performed-by': 'Technician',
  'local-reference': 'Local reference',
};

// Kept short on purpose: these are the facts worth fixing at the door.
const EDITABLE_FIELDS = [
  'tv-size', 'tv-brand', 'wall-surface', 'fireplace-type', 'mount-type',
  'bracket-type', 'cable-management', 'room-type', 'city', 'street-name',
  'price', 'performed-by',
];

const TERMINAL_STATES = new Set(['PUBLISHED']);

function factRows(seed) {
  return Object.keys(FACT_LABELS)
    .filter((key) => seed?.[key] !== undefined && seed[key] !== '' && seed[key] !== false)
    .map((key) => [FACT_LABELS[key], String(seed[key] === true ? 'Yes' : seed[key])]);
}

const SESSION_ERRORS = {
  expired: 'This link has expired — ask for a fresh one.',
  no_session: 'This link has already been used up. Open it again from Discord.',
  bad_signature: 'This link is not valid.',
  malformed: 'This link is not valid.',
  unconfigured: 'The installation-post queue is not configured.',
};

/** Same-origin JSON call. The session cookie is the only credential sent. */
function apiFetch(suffix, init = {}) {
  return fetch(`/api/install-post/${suffix}`, { credentials: 'same-origin', ...init });
}

function postJson(suffix, payload) {
  return apiFetch(suffix, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export default function InstallPostCard() {
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [booting, setBooting] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [localPreview, setLocalPreview] = useState('');
  const exchanged = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('mobile');
      const data = await response.json();
      if (!response.ok) {
        setError(SESSION_ERRORS[data.reason] || data.reason || data.error || 'Could not load this job');
        return;
      }
      setJob(data.job);
      setError('');
    } catch {
      setError('Network error — check signal and pull to refresh');
    }
  }, []);

  // Trade the fragment for a session, exactly once, and scrub it immediately.
  // Reopening the page later has no fragment and simply reuses the cookie.
  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const capability = window.location.hash.slice(1);
    if (capability) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    (async () => {
      if (capability) {
        try {
          const response = await postJson('session', { capability });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            setError(SESSION_ERRORS[data.reason] || 'This link is not valid.');
            setBooting(false);
            return;
          }
        } catch {
          setError('Network error — check signal and open the link again');
          setBooting(false);
          return;
        }
      }
      setBooting(false);
    })();
  }, []);

  useEffect(() => { if (!booting) load(); }, [booting, load]);

  // A dispatched publish finishes in the cloud, so the card has to keep asking
  // until the job stops moving. This is also what ages out an abandoned run.
  useEffect(() => {
    const delay = installPostPollDelayMs(job?.state);
    if (!delay) return undefined;
    const timer = setTimeout(load, delay);
    return () => clearTimeout(timer);
  }, [job?.state, job?.updatedAt, load]);

  useEffect(() => () => {
    if (localPreview) URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const rows = useMemo(() => factRows(job?.seed), [job]);

  async function saveCorrections(event) {
    event.preventDefault();
    const patch = {};
    for (const [key, value] of Object.entries(draft)) {
      if (String(value) !== String(job.seed?.[key] ?? '')) patch[key] = value;
    }
    if (!Object.keys(patch).length) {
      setEditing(false);
      return;
    }

    setBusy('Saving corrections…');
    setError('');
    try {
      const response = await apiFetch('mobile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: job.revision, patch }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error === 'stale_revision'
          ? 'This card changed somewhere else — reloading'
          : `Could not save: ${data.error}`);
        await load();
        return;
      }
      setJob(data.job);
      setEditing(false);
    } finally {
      setBusy('');
    }
  }

  async function onPhotoSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !job) return;

    setError('');
    setBusy('Converting photo…');
    try {
      const photo = await prepareInstallPhoto(file);

      setBusy('Getting upload slot…');
      const initResponse = await postJson('upload', {
        action: 'init',
        revision: job.revision,
        contentType: photo.contentType,
        bytes: photo.bytes,
        sha256: photo.sha256,
        md5: photo.md5,
      });
      const init = await initResponse.json();
      if (!initResponse.ok) {
        setError(`Upload refused: ${init.error}`);
        await load();
        return;
      }

      setBusy('Uploading photo…');
      const form = new FormData();
      for (const [key, value] of Object.entries(init.uploadDetails || {})) form.append(key, value);
      form.append('file', photo.blob, 'installation.webp');
      const upload = await fetch(init.uploadUrl, { method: 'POST', body: form });
      if (!upload.ok) {
        setError('Photo upload failed — try again');
        return;
      }

      setBusy('Binding photo to this job…');
      const commitResponse = await postJson('upload', {
        action: 'commit',
        revision: job.revision,
        uploadId: init.uploadId,
        sha256: photo.sha256,
      });
      const commit = await commitResponse.json();
      if (!commitResponse.ok) {
        setError(`Could not bind photo: ${commit.error}`);
        await load();
        return;
      }

      if (localPreview) URL.revokeObjectURL(localPreview);
      setLocalPreview(URL.createObjectURL(photo.blob));
      setJob(commit.job);
    } catch (err) {
      setError(err.message || 'Could not prepare that photo');
    } finally {
      setBusy('');
    }
  }

  async function publish({ reconcile = false } = {}) {
    setBusy(reconcile ? 'Checking the site and finishing up…' : 'Publishing…');
    setError('');
    try {
      const response = await postJson('publish', {
        revision: job.revision,
        ...(reconcile ? { reconcile: true } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        setError({
          duplicate_publish: 'Already publishing this exact photo and facts.',
          stale_revision: 'The facts or photo changed — check the card and tap Publish again.',
          reconcile_required: 'The last attempt never finished. Tap “Check and finish” to sort it out.',
          not_reconcilable: 'Nothing to reconcile — this job has a clear result.',
          already_published: 'This job is already published.',
          photo_required: job?.seed?.['job-type'] === 'unmount'
            ? 'Add the before photo first — TV still on the wall.'
            : 'Add the installation photo first.',
          locked: 'Another change is in progress — try again in a moment.',
        }[data.error] || `Publish failed: ${data.error}`);
        if (data.job) setJob(data.job);
        return;
      }
      setJob(data.job);
    } finally {
      setBusy('');
    }
  }

  const preview = localPreview || job?.image?.previewUrl || '';
  const unresolved = job?.state === 'INDETERMINATE';
  const inFlight = Boolean(job && installPostPollDelayMs(job.state));
  const canPublish = Boolean(
    job && job.image && !busy && !inFlight && !unresolved && !TERMINAL_STATES.has(job.state),
  );

  return (
    <>
      <Head>
        <title>Installation post</title>
        <meta name="robots" content="noindex,nofollow" />
        {/* The URL is the credential — never hand it to another origin. */}
        <meta name="referrer" content="no-referrer" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>

      <main className={styles.shell}>
        <div className={styles.card}>
          <div className={styles.header}>
            <p className={styles.eyebrow}>Installation post</p>
            <h1 className={styles.label}>{job ? job.label : 'Loading…'}</h1>
            {job ? <span className={styles.stateBadge}>{job.state.replace(/_/g, ' ')}</span> : null}
          </div>

          {error ? <p className={`${styles.status} ${styles.statusError}`}>{error}</p> : null}
          {busy ? <p className={`${styles.status} ${styles.statusMuted}`}>{busy}</p> : null}

          {job ? (
            <>
              <section className={styles.section}>
                <p className={styles.sectionTitle}>Job facts</p>
                {editing ? (
                  <form onSubmit={saveCorrections}>
                    {EDITABLE_FIELDS.map((key) => (
                      <div className={styles.fieldRow} key={key}>
                        <label htmlFor={key}>{FACT_LABELS[key]}</label>
                        <input
                          id={key}
                          className={styles.input}
                          value={draft[key] ?? job.seed?.[key] ?? ''}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                    <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={Boolean(busy)}>
                      Save corrections
                    </button>
                    <button
                      className={`${styles.button} ${styles.secondary}`}
                      type="button"
                      onClick={() => { setEditing(false); setDraft({}); }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className={styles.facts}>
                      {rows.map(([key, value]) => (
                        <Fact key={key} name={key} value={value} />
                      ))}
                    </div>
                    <button
                      className={`${styles.button} ${styles.secondary}`}
                      type="button"
                      onClick={() => { setDraft({}); setEditing(true); }}
                      disabled={TERMINAL_STATES.has(job.state)}
                    >
                      Fix a detail
                    </button>
                  </>
                )}
              </section>

              <section className={styles.section}>
                <p className={styles.sectionTitle}>
                  {job.seed?.['job-type'] === 'unmount'
                    ? 'Before photo (TV still on the wall)'
                    : 'Installation photo'}
                </p>
                {preview ? (
                  <img
                    className={styles.preview}
                    src={preview}
                    alt="Installation"
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                {!TERMINAL_STATES.has(job.state) ? (
                  <input
                    className={styles.fileInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={onPhotoSelected}
                    disabled={Boolean(busy)}
                  />
                ) : null}
              </section>

              <section className={styles.section}>
                {unresolved ? (
                  // The post may or may not already be live. Reconciling re-runs
                  // the same approval, which reuses that post instead of making
                  // a second one.
                  <button
                    className={`${styles.button} ${styles.primary}`}
                    type="button"
                    onClick={() => publish({ reconcile: true })}
                    disabled={Boolean(busy)}
                  >
                    Check and finish
                  </button>
                ) : (
                  <button
                    className={`${styles.button} ${styles.primary}`}
                    type="button"
                    onClick={() => publish()}
                    disabled={!canPublish}
                  >
                    {inFlight ? 'Publishing…' : (job.image ? 'Publish' : 'Add a photo to publish')}
                  </button>
                )}
              </section>

              {job.result ? (
                <p className={`${styles.status} ${job.state === 'PUBLISHED' ? styles.statusOk : styles.statusError}`}>
                  {job.state === 'PUBLISHED' && job.result.liveUrl ? (
                    <>
                      Verified live:{' '}
                      <a
                        className={styles.link}
                        href={job.result.liveUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {job.result.liveUrl}
                      </a>
                    </>
                  ) : (
                    `${job.state.replace(/_/g, ' ')} — ${job.result.message || 'no detail reported'}`
                  )}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}

function Fact({ name, value }) {
  return (
    <>
      <p className={styles.factKey}>{name}</p>
      <p className={styles.factValue}>{value}</p>
    </>
  );
}

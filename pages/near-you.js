// pages/near-you.js
// Public-facing zip code lookup page.
// "How many jobs has The Mounting Man completed near you?"
// Standalone page — does not use the dashboard layout.

import { useState } from 'react';
import Head from 'next/head';

const BOOKING_URL = 'https://www.themountingman.com/book';

export default function NearYou() {
  const [zip, setZip] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = zip.trim();
    if (!/^\d{5}$/.test(trimmed)) {
      setError('Please enter a valid 5-digit zip code.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/jobs-near?zip=${trimmed}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head>
        <title>Jobs Near You — The Mounting Man</title>
        <meta name="description" content="See how many TV mounting jobs The Mounting Man has completed in your neighborhood." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <main style={styles.page}>
        <div style={styles.card}>

          {/* Header */}
          <div style={styles.header}>
            <div style={styles.badge}>THE MOUNTING MAN</div>
            <h1 style={styles.headline}>
              How many jobs have we done<br />near you?
            </h1>
            <p style={styles.subhead}>
              Enter your zip code to see our local track record.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={styles.form}>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{5}"
              maxLength={5}
              placeholder="Enter zip code"
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              style={styles.input}
              aria-label="Zip code"
              autoComplete="postal-code"
            />
            <button
              type="submit"
              disabled={loading || zip.length < 5}
              style={{
                ...styles.button,
                ...(loading || zip.length < 5 ? styles.buttonDisabled : {}),
              }}
            >
              {loading ? 'Looking up...' : 'Search'}
            </button>
          </form>

          {/* Error */}
          {error && (
            <div style={styles.errorBox}>
              {error}
            </div>
          )}

          {/* Result */}
          {result && !error && (
            <div style={styles.resultBox}>
              <div style={styles.count}>{result.count.toLocaleString()}</div>
              <div style={styles.countLabel}>
                job{result.count !== 1 ? 's' : ''} completed
              </div>
              <div style={styles.countSub}>
                within {result.radius} miles of {result.zip}
              </div>
              <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer" style={styles.cta}>
                Book your install →
              </a>
            </div>
          )}

          {/* Footer note */}
          <p style={styles.footnote}>
            Data updated weekly · Includes jobs since 2023
          </p>

        </div>
      </main>
    </>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f8f8f6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  card: {
    background: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 2px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
    padding: '40px 36px',
    maxWidth: '440px',
    width: '100%',
  },
  header: {
    marginBottom: '28px',
  },
  badge: {
    display: 'inline-block',
    background: '#111',
    color: '#fff',
    fontSize: '10px',
    fontWeight: '700',
    letterSpacing: '0.12em',
    padding: '4px 10px',
    borderRadius: '4px',
    marginBottom: '16px',
    textTransform: 'uppercase',
  },
  headline: {
    fontSize: '26px',
    fontWeight: '800',
    color: '#111',
    lineHeight: '1.2',
    margin: '0 0 10px 0',
  },
  subhead: {
    fontSize: '15px',
    color: '#666',
    margin: '0',
    lineHeight: '1.5',
  },
  form: {
    display: 'flex',
    gap: '10px',
    marginBottom: '16px',
    flexWrap: 'wrap',
  },
  input: {
    flex: '1',
    minWidth: '140px',
    padding: '13px 16px',
    fontSize: '16px',
    border: '1.5px solid #ddd',
    borderRadius: '8px',
    outline: 'none',
    color: '#111',
    background: '#fff',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  },
  button: {
    padding: '13px 22px',
    fontSize: '15px',
    fontWeight: '600',
    background: '#111',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    transition: 'opacity 0.15s',
  },
  buttonDisabled: {
    opacity: '0.4',
    cursor: 'not-allowed',
  },
  errorBox: {
    background: '#fff5f5',
    border: '1px solid #fcc',
    color: '#c33',
    borderRadius: '8px',
    padding: '12px 14px',
    fontSize: '14px',
    marginBottom: '16px',
  },
  resultBox: {
    background: '#f4fce7',
    border: '1.5px solid #c8e632',
    borderRadius: '12px',
    padding: '24px',
    textAlign: 'center',
    marginBottom: '16px',
  },
  count: {
    fontSize: '64px',
    fontWeight: '800',
    color: '#111',
    lineHeight: '1',
    marginBottom: '4px',
  },
  countLabel: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#333',
    marginBottom: '4px',
  },
  countSub: {
    fontSize: '14px',
    color: '#666',
    marginBottom: '20px',
  },
  cta: {
    display: 'inline-block',
    background: '#111',
    color: '#fff',
    textDecoration: 'none',
    padding: '12px 24px',
    borderRadius: '8px',
    fontWeight: '600',
    fontSize: '15px',
    transition: 'opacity 0.15s',
  },
  footnote: {
    fontSize: '12px',
    color: '#aaa',
    textAlign: 'center',
    margin: '0',
  },
};

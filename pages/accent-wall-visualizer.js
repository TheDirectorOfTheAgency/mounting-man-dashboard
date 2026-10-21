import Head from 'next/head';

// Retired with the legacy Gemini proxy. This page makes no provider calls.
export async function getServerSideProps({ res }) {
  res.statusCode = 410;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return { props: {} };
}

export default function AccentWallVisualizerRetired() {
  return (
    <>
      <Head>
        <title>This tool has been retired | The Mounting Man</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </Head>
      <main
        style={{
          minHeight: '100vh',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          backgroundColor: '#0a0a0a',
          color: '#ffffff',
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, letterSpacing: '0.02em' }}>
            This tool has been retired
          </h1>
          <p style={{ marginTop: '12px', lineHeight: 1.5, color: 'rgba(255,255,255,0.55)' }}>
            The accent wall visualizer is no longer available.
          </p>
        </div>
      </main>
    </>
  );
}

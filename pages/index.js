// pages/index.js
import Head from 'next/head';
import Dashboard from '../components/Dashboard';
import axios from 'axios';

export default function Home({ initialData = {} }) {
  return (
    <>
      <Head>
        <title>The Agency - Tactical Briefing</title>
        <meta name="description" content="The Mounting Man - Business Intelligence Dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='75' font-size='75' fill='%2300ff00'>Q</text></svg>" />
      </Head>
      <Dashboard initialData={initialData} />
    </>
  );
}

export async function getStaticProps() {
  try {
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

    // Fetch all 4 data endpoints in parallel
    const [squareRes, webflowRes, googleAdsRes, telemetryRes] = await Promise.allSettled([
      axios.get(`${baseUrl}/api/square-revenue`, { timeout: 5000 }),
      axios.get(`${baseUrl}/api/webflow-posts`, { timeout: 5000 }),
      axios.get(`${baseUrl}/api/google-ads`, { timeout: 5000 }),
      axios.get(`${baseUrl}/api/telemetry`, { timeout: 5000 })
    ]);

    // Extract data from successful requests
    const initialData = {
      square: squareRes.status === 'fulfilled' ? squareRes.value.data : null,
      webflow: webflowRes.status === 'fulfilled' ? webflowRes.value.data : null,
      googleAds: googleAdsRes.status === 'fulfilled' ? googleAdsRes.value.data : null,
      telemetry: telemetryRes.status === 'fulfilled' ? telemetryRes.value.data : null,
    };

    return {
      props: { initialData },
      revalidate: 86400 // Revalidate once per day (24 hours)
    };
  } catch (error) {
    console.error('getStaticProps error:', error);
    return {
      props: { initialData: {} },
      revalidate: 3600 // Fallback: retry after 1 hour on error
    };
  }
}

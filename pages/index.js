// pages/index.js
import Head from 'next/head';
import Dashboard from '../components/Dashboard';

export default function Home() {
  return (
    <>
      <Head>
        <title>The Agency - Tactical Briefing</title>
        <meta name="description" content="The Mounting Man - Business Intelligence Dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='75' font-size='75' fill='%2300ff00'>Q</text></svg>" />
      </Head>
      <Dashboard />
    </>
  );
}

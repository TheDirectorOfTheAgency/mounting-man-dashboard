// pages/_document.js
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
      </Head>
      <body className="bg-agency-black text-white">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

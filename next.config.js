/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  // recap-card.mjs reads lib/assets/recap-plate.png at runtime via
  // fileURLToPath(import.meta.url) + path.join. Next's file tracer cannot
  // follow that, so without this include the marshallwayne-x function
  // silently falls back to the slat card. Next 14 still nests this under
  // experimental (stable top-level in 15+). Prefer this over vercel.json
  // includeFiles — Vercel defers Next NFT for this framework.
  experimental: {
    outputFileTracingIncludes: {
      '/api/mcp/marshallwayne-x': ['./lib/assets/recap-plate.png'],
    },
  },
  async headers() {
    // The installation-post surface is operator-only. The capability itself now
    // rides in a URL fragment and is exchanged for an HttpOnly cookie, but the
    // surface still must not be cached by a shared proxy, indexed, or allowed
    // to name itself in a Referer to the third-party photo host or the
    // outbound live link.
    const capabilityHeaders = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
    ];

    return [
      { source: '/install-posts/:path*', headers: capabilityHeaders },
      { source: '/api/install-post/:path*', headers: capabilityHeaders },
      {
        source: '/near-you',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://www.themountingman.com https://themountingman.com https://themountingman.webflow.io",
          },
          {
            key: 'X-Frame-Options',
            value: 'ALLOWALL',
          },
        ],
      },
      {
        source: '/accent-wall-visualizer',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://www.themountingman.com https://themountingman.com https://themountingman.webflow.io",
          },
          {
            key: 'X-Frame-Options',
            value: 'ALLOWALL',
          },
        ],
      },
    ];
  },
}

module.exports = nextConfig

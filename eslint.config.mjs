import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Replaces `next lint` (removed in Next.js 16) and .eslintrc.json.
// Scope matches the directories Next linted: pages, components, lib.
const config = [
  ...nextCoreWebVitals,
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**'],
  },
  {
    rules: {
      // eslint-plugin-react-hooks 7 flags the existing mount fetches and the
      // latest-ref write. Those calls are the polling model; rewriting them
      // is outside this upgrade.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];

export default config;

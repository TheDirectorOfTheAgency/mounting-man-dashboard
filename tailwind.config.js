/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'agency-black': '#0a0a0a',
        'agency-dark': '#1a1a1a',
        'agency-green': '#00ff00',
        'agency-green-dark': '#00cc00',
        'agency-yellow': '#ffff00',
        'agency-gray': '#333333',
      },
      fontFamily: {
        'mono': ['Space Mono', 'monospace'],
        'terminal': ['IBM Plex Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}

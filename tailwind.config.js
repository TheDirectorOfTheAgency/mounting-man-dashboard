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
        'hud-black': '#0a0a0a',
        'hud-dark': '#0f1114',
        'hud-panel': '#131619',
        'hud-green': '#c8e632',
        'hud-green-dim': '#8fa623',
        'hud-green-glow': '#d4f23e',
        'hud-border': '#2a2d31',
        'hud-border-light': '#3a3d41',
        'hud-text': '#8a8d91',
        'hud-text-dim': '#4a4d51',
        'hud-red': '#e63232',
        'hud-white': '#e8eaed',
      },
      fontFamily: {
        'mono': ['Space Mono', 'monospace'],
        'terminal': ['IBM Plex Mono', 'monospace'],
      },
      animation: {
        'scan': 'scan 8s linear infinite',
        'pulse-green': 'pulse-green 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'data-flow': 'data-flow 3s linear infinite',
        'flicker': 'flicker 4s linear infinite',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'pulse-green': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        'data-flow': {
          '0%': { backgroundPosition: '0% 0%' },
          '100%': { backgroundPosition: '100% 0%' },
        },
        'flicker': {
          '0%, 100%': { opacity: '1' },
          '92%': { opacity: '1' },
          '93%': { opacity: '0.8' },
          '94%': { opacity: '1' },
          '96%': { opacity: '0.9' },
          '97%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        rule: 'var(--rule)',
        'rule-strong': 'var(--rule-strong)',
        moss: 'var(--moss)',
        fungal: 'var(--fungal)',
        ember: 'var(--ember)',
      },
      fontFamily: {
        serif: ['"EB Garamond"', '"Iowan Old Style"', 'Georgia', 'serif'],
        sans: [
          '"Schibsted Grotesk"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

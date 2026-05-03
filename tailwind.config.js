/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Inter"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      colors: {
        bg: '#08080a',
        panel: '#111114',
        panel2: '#16161a',
        border: '#23232a',
        borderHi: '#2e2e36',
        muted: '#6e6e78',
        text: '#e8e8eb',
        textHi: '#fafafa',
        amber: '#f59e0b',
        amberSoft: '#fbbf24',
        critical: '#ef4444',
        criticalSoft: '#f87171',
        warn: '#f59e0b',
        ok: '#10b981',
        info: '#60a5fa'
      },
      letterSpacing: {
        widest2: '0.18em',
        widest3: '0.22em'
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(245, 158, 11, 0.4), 0 4px 24px -8px rgba(245, 158, 11, 0.25)',
        glowCritical: '0 0 0 1px rgba(239, 68, 68, 0.5), 0 4px 24px -8px rgba(239, 68, 68, 0.35)',
        panel: '0 1px 0 rgba(255,255,255,0.02), 0 8px 32px -12px rgba(0,0,0,0.4)'
      }
    }
  },
  plugins: []
};

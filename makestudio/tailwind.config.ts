import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        primary: 'var(--color-primary)',
        'primary-soft': 'var(--color-primary-soft)',
        secondary: 'var(--color-secondary)',
        'secondary-soft': 'var(--color-secondary-soft)',
        tertiary: 'var(--color-tertiary)',
        accent: 'var(--color-accent)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
        dim: 'var(--color-dim)',
        'dim-soft': 'var(--color-dim-soft)',
        text: 'var(--color-text)',
        'text-soft': 'var(--color-text-soft)',
        'code-bg': 'var(--color-code-bg)',
        'code-fg': 'var(--color-code-fg)',
        'input-border': 'var(--color-input-border)',
        'surface-0': 'var(--color-surface-0)',
        'surface-1': 'var(--color-surface-1)',
        'surface-2': 'var(--color-surface-2)',
        'surface-3': 'var(--color-surface-3)',
        'border-subtle': 'var(--color-border-subtle)',
        'border-soft': 'var(--color-border-soft)',
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          'SF Pro Text',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        serif: [
          'Fraunces Variable',
          'Fraunces',
          'Charter',
          'Georgia',
          'serif',
        ],
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        elev: 'var(--shadow-elev)',
      },
      backgroundImage: {
        brand: 'var(--gradient-brand)',
        'brand-blue': 'var(--gradient-blue)',
        hero: 'var(--gradient-hero)',
      },
      animation: {
        'kitt-scan': 'kitt-scan 3s ease-in-out infinite',
        'pulse-fade': 'pulse-fade 1.4s ease-in-out infinite',
        'cursor-blink': 'cursor-blink 1s steps(2) infinite',
        'fade-in': 'routeIn 0.28s cubic-bezier(0.2, 0, 0, 1) both',
      },
      keyframes: {
        'kitt-scan': {
          '0%, 100%': { transform: 'translateX(0%)' },
          '50%': { transform: 'translateX(100%)' },
        },
        'pulse-fade': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'cursor-blink': {
          '0%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;

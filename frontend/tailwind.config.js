/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        'bg-primary': '#0a0a0f',
        'bg-secondary': '#111118',
        'bg-card': '#16161f',
        'bg-elevated': '#1c1c28',
        border: '#2a2a3a',
        'border-subtle': '#1e1e2a',
        'text-primary': '#e8e8f0',
        'text-secondary': '#8888a8',
        'text-muted': '#55556a',
        'accent-green': '#00c896',
        'accent-red': '#ff4466',
        'accent-yellow': '#f5a623',
        'accent-blue': '#4488ff',
        'accent-purple': '#8855ff',
        bull: '#00c896',
        bear: '#ff4466',
        neutral: '#8888a8',
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // 디자인 토큰: 브랜드 블루 한 가지 + 회색 계열. 상태 색은 components/ui/Badge.jsx의 팔레트를 쓴다.
      colors: {
        primary: {
          50: '#eff5ff',
          100: '#dbe8fe',
          200: '#bfd5fe',
          300: '#93b8fd',
          400: '#6090fa',
          500: '#3b6ef6',
          600: '#2554eb',
          700: '#1d42d8',
          800: '#1e37af',
          900: '#1e348a',
        },
      },
      fontFamily: {
        sans: ['Pretendard Variable', 'Pretendard', ...defaultTheme.fontFamily.sans],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.04)',
        'card-hover': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.04)',
        popover: '0 12px 32px -8px rgb(15 23 42 / 0.18), 0 2px 6px -2px rgb(15 23 42 / 0.06)',
      },
      letterSpacing: {
        tightish: '-0.01em',
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};

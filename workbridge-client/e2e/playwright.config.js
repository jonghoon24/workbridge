// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { BASE_URL } = require('./helpers/accounts'); // refuses non-local addresses

// Specs share one seeded database, so they run one at a time. Each spec builds the state it
// needs (fresh projects, applications, contracts) instead of mutating seed rows, which is what
// lets the suite run repeatedly against the same database.
module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: '../test-results/playwright',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

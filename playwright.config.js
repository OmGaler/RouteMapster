const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/playwright',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'node src/index.js',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 120_000
  }
});

import { defineConfig } from '@playwright/test';

// Loads dist/chrome as an unpacked extension into Chromium (headless works
// for extensions with the new headless mode). Run `npm run test:e2e`.
// First time: `npx playwright install chromium`.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
});

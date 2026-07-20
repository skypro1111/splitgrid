import { defineConfig } from '@playwright/test';

// E2E (Electron) config — kept separate from the Vitest unit suite. These launch
// the real app, so they're slow and need a display; run via `npm run test:e2e`,
// NOT the default `npm test`. CI would need xvfb on Linux to run them.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // the app uses a single-instance lock; never run two at once
  reporter: [['list']],
});

import { defineConfig } from 'vitest/config';

// Unit-test runner (Vitest). Kept separate from the three app Vite configs
// (main/preload/renderer) — tests import the project's PURE modules directly, so
// they need no Electron, no PTY, no bundling. Default env is `node`; renderer/DOM
// tests (when added) can opt into jsdom per-file via a `// @vitest-environment
// jsdom` docblock or an environmentMatchGlobs entry here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Pure-logic tests (.test.ts) run in node; React component tests (.test.tsx)
    // get a DOM via jsdom. jest-dom matchers are imported per-tsx-file.
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    // Surface slow/hanging tests early — pure units should be instant.
    testTimeout: 5_000,
  },
});

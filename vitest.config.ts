import { defineConfig } from 'vitest/config';

// Unit-test runner (Vitest). Kept separate from the three app Vite configs
// (main/preload/renderer) — tests import the project's PURE modules directly, so
// they need no Electron, no PTY, no bundling. Default env is `node`; renderer/DOM
// tests (when added) can opt into jsdom per-file via a `// @vitest-environment
// jsdom` docblock or an environmentMatchGlobs entry here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // *.live.test.ts spawn real CLIs (and cost tokens), so they stay out of the
    // default run. Execute them deliberately with:
    //   VITEST_LIVE=1 npx vitest run src/main/agent/claude-agent-session.live.test.ts
    exclude:
      process.env.VITEST_LIVE === '1'
        ? ['**/node_modules/**', '**/dist/**']
        : ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    // Pure-logic tests (.test.ts) run in node; React component tests (.test.tsx)
    // get a DOM via jsdom. jest-dom matchers are imported per-tsx-file.
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    // Surface slow/hanging tests early — pure units should be instant.
    testTimeout: 5_000,
  },
});

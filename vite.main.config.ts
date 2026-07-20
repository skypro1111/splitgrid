import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // Only NATIVE modules belong here — they can't be bundled and are copied
      // into the asar by forge.config.ts's packageAfterCopy hook (NATIVE_MODULES)
      // or unpacked. chokidar is pure JS, so it MUST be bundled (it isn't copied
      // anywhere), otherwise the packaged app throws "Cannot find module 'chokidar'".
      // fsevents stays external: it's chokidar's optional native backend and
      // chokidar degrades gracefully (try/catch → fs.watch) when it's absent.
      // bufferutil / utf-8-validate are `ws`'s OPTIONAL native speedups, each
      // wrapped in a try/catch require inside ws. They aren't installed, so they
      // must be external — otherwise the bundler emits a stub that throws
      // "Could not resolve 'bufferutil'" at load instead of letting ws fall back
      // to its pure-JS path.
      // better-sqlite3 is a NATIVE module — it must NOT be bundled; it's rebuilt
      // for Electron's ABI and copied into the asar (see forge.config.ts).
      // mysql2 and mssql/tedious are pure JS but ship large, dynamically-required
      // dependency trees that don't bundle cleanly, so they're externalized and
      // copied alongside (forge.config.ts NATIVE_MODULES copyModules hook).
      external: [
        'ssh2',
        'node-pty',
        'pg-native',
        'fsevents',
        'bufferutil',
        'utf-8-validate',
        'better-sqlite3',
        'mysql2',
        'mssql',
        // exceljs is pure JS but ships a large, dynamically-required dependency
        // tree (zip/stream libs) that doesn't bundle cleanly — externalize and
        // copy it alongside (forge.config.ts NATIVE_MODULES), like mysql2/mssql.
        'exceljs',
      ],
    },
  },
  server: {
    watch: {
      usePolling: true,
      interval: 1000,
    },
  },
});

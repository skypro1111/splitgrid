// ─── Extension bundler ───────────────────────────────────────────────────────
// esbuild (already present via vite) → extension/dist, which is what the user
// loads unpacked. Deliberately not wired into electron-forge: the extension has
// its own lifecycle and ships separately from the app.
//
//   node extension/build.mjs [--watch]

import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

// Copied verbatim: the manifest and the popup's static assets. `popup.html`
// references `popup.js`/`popup.css` by the names esbuild emits below.
const STATIC = [
  [join(root, 'manifest.json'), join(dist, 'manifest.json')],
  [join(src, 'popup.html'), join(dist, 'popup.html')],
  [join(src, 'popup.css'), join(dist, 'popup.css')],
  // The toolbar icon is the whole entry point — activating a tab starts with
  // clicking it — so an unbranded grey puzzle piece is a usability bug, not a
  // cosmetic one. Reuses the app's icon set (build/icons).
  ...[16, 32, 48, 128].map((s) => [join(root, 'icons', `${s}.png`), join(dist, 'icons', `${s}.png`)]),
];

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(src, 'background.ts'), join(src, 'popup.ts')],
  outdir: dist,
  bundle: true,
  // MV3 service workers are ES modules ("type": "module" in the manifest), and
  // the popup loads as `<script type="module">`.
  format: 'esm',
  // Chrome 120 is the manifest's minimum, so esbuild emits no downlevel
  // helpers — which matters for the functions handed to
  // chrome.scripting.executeScript: they are serialised with toString() and
  // must not reference helpers that don't exist in the page.
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: 'linked',
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  for (const [from, to] of STATIC) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

if (watch) {
  await copyStatic();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching → ${dist}`);
} else {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await esbuild.build(options);
  await copyStatic();
  console.log(`built → ${dist}`);
}

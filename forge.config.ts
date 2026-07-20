import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';

// Modules copied verbatim (with their dep trees) into the packaged node_modules
// by the packageAfterCopy hook, because the vite main bundle externalizes them.
// better-sqlite3 is a true native addon (.node, rebuilt for Electron's ABI);
// mysql2 and mssql are pure JS but have dynamically-required trees that don't
// bundle, so they're shipped here too.
const NATIVE_MODULES = ['ssh2', 'node-pty', 'cpu-features', 'better-sqlite3', 'mysql2', 'mssql', 'exceljs'];

function copyModules(buildPath: string) {
  const srcNodeModules = path.resolve(__dirname, 'node_modules');
  const destNodeModules = path.join(buildPath, 'node_modules');
  const copied = new Set<string>();  // top-level packages cpSync'd into dest
  const scanned = new Set<string>(); // package dirs whose deps were already walked

  // Top-level package name owning `dir` (the first segment under node_modules,
  // scope-aware) — what we cpSync so the whole nested tree comes along.
  const topLevelName = (dir: string): string | null => {
    const rel = path.relative(srcNodeModules, dir);
    if (!rel || rel.startsWith('..')) return null;
    const parts = rel.split(path.sep);
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  };

  // Node-style resolution: find `name` required from a package at `fromDir`,
  // checking its own nested node_modules first, then walking up each enclosing
  // node_modules layer (so hoisted deps resolve to the root copy).
  const resolveDep = (name: string, fromDir: string): string | null => {
    let dir = fromDir;
    for (;;) {
      const cand = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
      const idx = dir.lastIndexOf(`${path.sep}node_modules${path.sep}`);
      if (idx === -1) return null;
      dir = dir.slice(0, idx); // climb above this node_modules layer
    }
  };

  // Ensure the top-level owner of `srcDir` is copied (brings nested trees), then
  // walk THIS package's deps — including nested versions — so their hoisted
  // transitive deps (e.g. process-nextick-args under lazystream's readable-stream)
  // are pulled to the packaged root too.
  const visit = (srcDir: string) => {
    if (scanned.has(srcDir)) return;
    scanned.add(srcDir);

    const top = topLevelName(srcDir);
    if (top && !copied.has(top)) {
      const src = path.join(srcNodeModules, top);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(destNodeModules, top), { recursive: true });
        copied.add(top);
      }
    }

    const pkgPath = path.join(srcDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      const resolved = resolveDep(dep, srcDir);
      if (resolved) visit(resolved);
    }
  };

  for (const mod of NATIVE_MODULES) {
    const dir = path.join(srcNodeModules, mod);
    if (fs.existsSync(dir)) visit(dir);
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.splitgrid.app',
    executableName: 'SplitGrid',
    icon: path.resolve(__dirname, 'build/icon'),
    // macOS Tahoe (26+) Liquid Glass app icon: the compiled asset catalog
    // (build/Assets.car, from public/logos/icon_macos.icon via
    // `npm run icon:macos`) lands in Contents/Resources, and CFBundleIconName
    // points the system at it. Pre-Tahoe macOS falls back to build/icon.icns.
    extendInfo: {
      CFBundleIconName: 'icon_macos',
      // Required for the embedded browser pane to access audio/video input on
      // macOS. Without these usage strings the OS silently denies (or terminates
      // on) getUserMedia, so mic/camera never work in the browser (voice/video
      // calls, dictation, WebRTC). Text is shown in the system TCC prompt.
      NSMicrophoneUsageDescription:
        'SplitGrid needs microphone access so websites open in the browser pane can use audio input (e.g. calls and dictation).',
      NSCameraUsageDescription:
        'SplitGrid needs camera access so websites open in the browser pane can use video input (e.g. video calls).',
    },
    // Register the workos-auth:// custom scheme so the OS routes the WorkOS login
    // callback back to the app. On macOS this is what writes CFBundleURLTypes into
    // Info.plist (setAsDefaultProtocolClient alone is a no-op there); Windows/Linux
    // pick it up too. Keep the scheme in sync with PROTOCOL in src/main/workos-auth.ts.
    protocols: [{ name: 'SplitGrid Auth', schemes: ['workos-auth'] }],
    // Ships the agent lifecycle-hook helper scripts to process.resourcesPath,
    // plus the macOS Liquid Glass asset catalog.
    extraResource: ['resources', path.resolve(__dirname, 'build/Assets.car')],
    asar: {
      // better-sqlite3 carries a native .node binary that must live outside the
      // asar so dlopen can load it. AutoUnpackNativesPlugin also detects this,
      // but the explicit glob keeps it unpacked even after the copyModules hook.
      unpack: '**/node_modules/{ssh2,node-pty,cpu-features,better-sqlite3}/**',
    },
  },
  rebuildConfig: {},
  makers: [
    // Windows installer (.exe). setupIcon brands the installer + app shortcut;
    // the app/exe icon itself comes from packagerConfig.icon → build/icon.ico.
    new MakerSquirrel({
      setupIcon: path.resolve(__dirname, 'build/icon.ico'),
    }),
    // Portable zips: macOS (notarization-free distribution), a no-installer
    // Windows fallback, and Linux (a tarball-style zip that needs none of the
    // dpkg/rpmbuild/fakeroot tooling the .deb/.rpm makers require).
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    // Linux .rpm/.deb: the desktop-entry icon comes from a PNG (build/icon.png,
    // 512×512), not the .icns/.ico used by macOS/Windows.
    new MakerRpm({ options: { icon: path.resolve(__dirname, 'build/icon.png') } }),
    new MakerDeb({ options: { icon: path.resolve(__dirname, 'build/icon.png') } }),
  ],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      copyModules(buildPath);
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Verify app.asar's integrity at load and refuse to run code from outside
      // it, so local malware can't inject persistent code into the bundle.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;

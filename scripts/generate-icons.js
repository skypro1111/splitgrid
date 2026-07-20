// Regenerates the Windows/Linux app-icon and the logo assets from the SVGs.
//
//   build/icon.svg   -> Windows .ico, Linux PNG set (black squircle + white S)
//   public/logo.svg  -> public/logos/*.png  (the in-app / web logo mark)
//
// The macOS icon (.icns + Assets.car) is NOT produced here — it comes from the
// Icon Composer source via `npm run icon:macos` (scripts/compile-macos-icon.sh).
//
// Rendering goes through this project's Chromium (Electron) so the SVG masks
// rasterise exactly like the app sees them. PNG downscaling uses macOS sips and
// the .ico packing uses the png-to-ico CLI.
//
// Run:  npm run generate:icons      (== electron scripts/generate-icons.js)
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const LINUX_DIR = path.join(BUILD, 'icons');
const LOGO_DIR = path.join(ROOT, 'public', 'logos');

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LOGO_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const MASTER = 1024;

function sips(srcPng, size, outPng) {
  execFileSync('sips', ['-z', String(size), String(size), srcPng, '--out', outPng], { stdio: 'ignore' });
}

// One reusable offscreen window — destroying/recreating offscreen windows in a
// loop makes the second load fail with ERR_FAILED, so we keep a single one.
let win;
async function render(svgPath, out) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${MASTER}px;height:${MASTER}px;background:transparent}
    svg{display:block;width:${MASTER}px;height:${MASTER}px}</style></head><body>${svg}</body></html>`;
  const tmp = path.join(os.tmpdir(), `splitgrid-render-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage();
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(out, img.resize({ width: MASTER, height: MASTER }).toPNG());
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(LINUX_DIR, { recursive: true });
  fs.mkdirSync(LOGO_DIR, { recursive: true });

  // ── Rasterise BOTH masters first, with one shared offscreen window ─────
  win = new BrowserWindow({
    width: MASTER, height: MASTER, useContentSize: true, show: false, frame: false,
    backgroundColor: '#00000000', webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  const master = path.join(BUILD, 'icon-1024.png');     // black squircle + white S
  const logoMaster = path.join(LOGO_DIR, 'logo-1024.png');
  await render(path.join(BUILD, 'icon.svg'), master);
  await render(path.join(ROOT, 'public', 'logo.svg'), logoMaster);
  win.destroy();
  fs.copyFileSync(master, path.join(BUILD, 'icon.svg.png')); // legacy reference

  // ── Linux: PNG set + the single icon the deb/rpm makers use ────────────
  for (const px of LINUX_SIZES) sips(master, px, path.join(LINUX_DIR, `${px}.png`));
  fs.copyFileSync(path.join(LINUX_DIR, '512.png'), path.join(BUILD, 'icon.png'));

  // ── Windows: multi-size .ico (png-to-ico packs the PNGs) ───────────────
  const icoPngs = ICO_SIZES.map((px) => path.join(LINUX_DIR, `${px}.png`));
  const ico = execFileSync('npx', ['-y', 'png-to-ico', ...icoPngs]);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);

  // ── Logo mark PNG set (the in-app / web logo) ──────────────────────────
  for (const px of LOGO_SIZES) sips(logoMaster, px, path.join(LOGO_DIR, `logo-${px}.png`));

  console.log('Icons + logos regenerated.');
  app.quit();
});

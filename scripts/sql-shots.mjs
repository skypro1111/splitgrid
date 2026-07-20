#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SplitGrid SQL-panel screenshot harness — RE-RUNNABLE.
//
// Launches the dev Electron build (.vite/build/main.js, which loads the renderer
// from the vite dev server on http://localhost:5173) against a FRESH throwaway
// userData dir, drives the SQL panel into several visual states, and writes PNGs
// to /tmp/sql-shots/. Re-run freely while polishing CSS, then Read the PNGs.
//
//   node scripts/sql-shots.mjs
//
// REQUIREMENTS:
//  - The vite renderer dev server must be reachable on http://localhost:5173.
//    (The user's running `npm start` provides it; the built main.js hard-loads
//    that URL.) The harness checks this up front and aborts clearly if it's down.
//  - A demo Postgres at 127.0.0.1:55455 (postgres/postgres, db `shop`).
//
// HOW IT REACHES A CONNECTED SQL PANE:
//  Uses a tiny dev-only test seam exposed in src/renderer/App.tsx as
//  window.__sgTest.addSqlConnected(savedId, query). The seam only attaches when
//  localStorage 'SG_TEST'==='1', which this harness sets before reloading. The
//  seam creates a SQL container pre-wired to the saved connection so SqlWorkbench
//  auto-connects on mount. This is far more robust than racing Monaco/tree DOM.
//
// Exit code: 0 if it launched + connected (even if some optional shots failed —
// failures are printed loudly). Non-zero only if it couldn't launch/connect.
// ─────────────────────────────────────────────────────────────────────────────

import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = '/tmp/sql-shots';
const DEV_URL = 'http://localhost:5173';
const MAIN = path.join('.vite', 'build', 'main.js');

const CONN = {
  label: 'shop demo',
  dialect: 'postgres',
  host: '127.0.0.1',
  port: 55455,
  user: 'postgres',
  password: 'postgres',
  database: 'shop',
  ssl: false,
};
const QUERY =
  'select id, full_name, email, vip, balance, signup_at, notes from customers limit 100';

// Track per-shot results for the final summary.
const results = []; // { name, ok, file, reason }
function record(name, ok, file, reason) {
  results.push({ name, ok, file, reason: reason || '' });
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(`  [${tag}] ${name}${reason ? ' — ' + reason : ''}`);
}

function log(...a) { console.log('[sql-shots]', ...a); }

// Poll a predicate (async-or-sync) until truthy or timeout.
async function poll(fn, { timeout = 15000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e?.message; }
    if (Date.now() - start > timeout) {
      throw new Error(`timeout (${timeout}ms) waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

function checkDevServer() {
  return new Promise((resolve) => {
    const req = http.get(DEV_URL + '/', (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// Take a full-window PNG; record success/fail with file-size sanity check.
async function shot(win, name, file) {
  const full = path.join(OUT_DIR, file);
  try {
    await win.screenshot({ path: full });
    const sz = existsSync(full) ? statSync(full).size : 0;
    if (sz < 5 * 1024) {
      record(name, false, full, `png too small (${sz} bytes) — likely blank`);
      return false;
    }
    record(name, true, full);
    return true;
  } catch (e) {
    record(name, false, full, e.message);
    return false;
  }
}

// Aggregate visible tree text (no single .sql-tree wrapper exists).
async function treeText(win) {
  return win.evaluate(() =>
    Array.from(document.querySelectorAll('.sql-tree-node')).map((n) => n.textContent || '').join(' | ')
  ).catch(() => '');
}

// Click the first visible tree node whose label text matches (exact-ish).
// Returns true if it clicked something.
async function clickTreeNode(win, text, { timeout = 8000 } = {}) {
  const node = win.locator('.sql-tree-node', { hasText: text }).first();
  try {
    await node.waitFor({ state: 'visible', timeout });
    await node.click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Hard requirement: renderer dev server.
  if (!(await checkDevServer())) {
    console.error(
      `\nFATAL: renderer dev server not reachable at ${DEV_URL}.\n` +
      `The built main.js loads the renderer from there. Start the app (npm start)\n` +
      `so the vite dev server is up, then re-run.\n`
    );
    process.exit(2);
  }
  log(`dev server reachable at ${DEV_URL}`);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-sqlshots-'));
  let app;
  try {
    log('launching app, userData=', userDataDir);
    app = await electron.launch({
      cwd: REPO,
      args: [MAIN, `--user-data-dir=${userDataDir}`],
      timeout: 60000,
    });
    // Surface main-process logs for diagnostics (and prove the receiver bind
    // conflict on 19558 is non-fatal).
    app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
    app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d));

    const win = await app.firstWindow({ timeout: 60000 });
    await win.waitForLoadState('domcontentloaded');

    // Wait for React to mount.
    await poll(() => win.evaluate(() => document.body?.childElementCount ?? 0).then((n) => n > 0),
      { timeout: 20000, label: 'react mount' });
    log('renderer mounted');

    // Confirm the preload bridge is wired.
    const hasApi = await win.evaluate(() => typeof (window).electronAPI?.sqlSaveConnection === 'function');
    if (!hasApi) throw new Error('window.electronAPI.sqlSaveConnection missing — preload not wired');

    // 1) Initial launch screenshot (before SQL).
    await shot(win, '01-launch', '01-launch.png');

    // 2) Seed the saved connection through the app (encrypts password cleanly).
    const savedId = await win.evaluate(async (conn) => {
      const saved = await (window).electronAPI.sqlSaveConnection(conn);
      return saved?.id ?? saved?.savedId ?? saved ?? null;
    }, CONN);
    if (!savedId || typeof savedId !== 'string') {
      throw new Error('sqlSaveConnection did not return a saved id: ' + JSON.stringify(savedId));
    }
    log('saved connection id=', savedId);

    // 3) Enable the test seam, reload so App re-mounts and attaches window.__sgTest,
    //    then open a SQL pane pre-wired to the saved connection (auto-connects).
    await win.evaluate(() => window.localStorage.setItem('SG_TEST', '1'));
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await poll(() => win.evaluate(() => document.body?.childElementCount ?? 0).then((n) => n > 0),
      { timeout: 20000, label: 'react re-mount after reload' });

    const seamReady = await poll(
      () => win.evaluate(() => typeof (window).__sgTest?.addSqlConnected === 'function'),
      { timeout: 15000, label: 'window.__sgTest seam' }
    ).then(() => true).catch(() => false);
    if (!seamReady) {
      throw new Error('test seam window.__sgTest.addSqlConnected not present after reload (App.tsx seam missing or not built)');
    }

    await win.evaluate(({ id, query }) => (window).__sgTest.addSqlConnected(id, query),
      { id: savedId, query: QUERY });
    log('opened SQL pane via seam');

    // Wait for the SQL workbench to render (selector strip + tree).
    await poll(() => win.locator('.sql-selector-strip').count().then((n) => n > 0),
      { timeout: 20000, label: 'sql workbench render' });

    // Wait for live connection: the connection node turns into a live tree
    // (a database node appears) — poll for any database/schema tree content.
    // The selected connection select should reflect the saved id once connected.
    await poll(async () => {
      const v = await win.locator('.sql-selector-strip select').first().inputValue().catch(() => '');
      return v === savedId;
    }, { timeout: 20000, label: 'connection selected/connected' });
    // Give the schema/tree fetch a moment to populate.
    await poll(() => win.locator('.sql-tree-node').count().then((n) => n > 0),
      { timeout: 20000, label: 'tree populated' });
    log('SQL pane connected');

    // ── 02: expand the schema tree to show the 3 tables ──────────────────────
    try {
      // Expand connection -> database -> Schemas -> public -> Tables.
      await clickTreeNode(win, CONN.label);        // connection node
      await clickTreeNode(win, 'shop');            // database node
      await clickTreeNode(win, 'Schemas');         // schemas group
      await clickTreeNode(win, 'public');          // public schema
      await clickTreeNode(win, 'Tables');          // tables category
      // Wait for table names to appear.
      const sawTables = await poll(async () => {
        const txt = await treeText(win);
        return /customers/.test(txt) && /orders/.test(txt) && /products/.test(txt);
      }, { timeout: 15000, label: 'tables visible' }).then(() => true).catch(() => false);
      if (sawTables) {
        await shot(win, '02-tree-expanded', '02-tree-expanded.png');
      } else {
        await shot(win, '02-tree-expanded', '02-tree-expanded.png'); // capture what we have
        record('02-tree-expanded', false, path.join(OUT_DIR, '02-tree-expanded.png'),
          'did not confirm all 3 tables in tree (captured anyway)');
      }
    } catch (e) {
      record('02-tree-expanded', false, path.join(OUT_DIR, '02-tree-expanded.png'), e.message);
    }

    // ── 03: run the query and capture editor + results grid ──────────────────
    try {
      const runBtn = win.locator('button.sql-tb-run').first();
      await runBtn.waitFor({ state: 'visible', timeout: 10000 });
      // Editor is pre-seeded with QUERY via the seam; just run it.
      await runBtn.click({ timeout: 5000 });
      // Wait for results grid rows to appear (DataGrid renders rows).
      const gotRows = await poll(async () => {
        // The editable grid uses dg-* classes; scan body text for result evidence.
        const txt = await win.locator('body').innerText().catch(() => '');
        // customer emails contain '@'; or a "100 rows" style footer.
        return /@/.test(txt) && /\b(rows?|row)\b/i.test(txt);
      }, { timeout: 20000, label: 'query results' }).then(() => true).catch(() => false);
      await shot(win, '03-query-result', '03-query-result.png');
      if (!gotRows) {
        record('03-query-result', false, path.join(OUT_DIR, '03-query-result.png'),
          'results grid text not confirmed (captured anyway)');
      }
    } catch (e) {
      record('03-query-result', false, path.join(OUT_DIR, '03-query-result.png'), e.message);
    }

    // ── 04: open a table tab (editable grid) by clicking a table in the tree ──
    try {
      // Click the `orders` table object node to open its table tab.
      const opened = await clickTreeNode(win, 'orders', { timeout: 8000 });
      if (!opened) await clickTreeNode(win, 'customers', { timeout: 8000 });
      // Wait for a grid with data to render.
      await poll(async () => {
        const n = await win.locator('.dg-th').count().catch(() => 0);
        return n > 0;
      }, { timeout: 20000, label: 'table grid' }).catch(() => {});
      await shot(win, '04-table-tab', '04-table-tab.png');
    } catch (e) {
      record('04-table-tab', false, path.join(OUT_DIR, '04-table-tab.png'), e.message);
    }

    // ── 05: open the connection wizard dialog ────────────────────────────────
    try {
      const plus = win.locator('button.sql-btn.icon[title="New connection"]').first();
      await plus.waitFor({ state: 'visible', timeout: 8000 });
      await plus.click({ timeout: 5000 });
      // Wait for the dialog (multi-dialect form) to appear.
      await poll(async () => {
        const txt = await win.locator('body').innerText();
        return /dialect/i.test(txt) || /postgres/i.test(txt) && /sqlite/i.test(txt);
      }, { timeout: 8000, label: 'connection dialog' }).catch(() => {});
      await shot(win, '05-connection-wizard', '05-connection-wizard.png');
      // Close it so it doesn't block later shots (Escape).
      await win.keyboard.press('Escape').catch(() => {});
    } catch (e) {
      record('05-connection-wizard', false, path.join(OUT_DIR, '05-connection-wizard.png'), e.message);
    }

    // ── 06: expand a table node to show its Columns/Indexes/Keys children ─────
    try {
      // Re-expand to Tables if the dialog disrupted it, then click the disclosure
      // arrow on `customers` to load its column children.
      await clickTreeNode(win, 'Tables');
      // Click the disclosure arrow next to `customers` (the inner span toggles it).
      const custNode = win.locator('.sql-tree-node', { hasText: 'customers' }).first();
      await custNode.waitFor({ state: 'visible', timeout: 8000 });
      // The arrow is the first child span; click the node's leading arrow area.
      const arrow = custNode.locator('span').first();
      await arrow.click({ timeout: 3000 }).catch(async () => { await custNode.click({ timeout: 3000 }); });
      // Wait for column children (e.g. full_name / email) to render under it.
      const sawCols = await poll(async () => {
        const txt = await treeText(win);
        return /Columns/i.test(txt) || /full_name/.test(txt) || /Indexes/i.test(txt);
      }, { timeout: 12000, label: 'table column children' }).then(() => true).catch(() => false);
      await shot(win, '06-columns-or-objects', '06-columns-or-objects.png');
      if (!sawCols) {
        record('06-columns-or-objects', false, path.join(OUT_DIR, '06-columns-or-objects.png'),
          'columns/indexes children not confirmed (captured anyway)');
      }
    } catch (e) {
      record('06-columns-or-objects', false, path.join(OUT_DIR, '06-columns-or-objects.png'), e.message);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n=== SCREENSHOT SUMMARY ===');
    for (const r of results) {
      const tag = r.ok ? 'OK  ' : 'FAIL';
      console.log(`[${tag}] ${r.file}${r.reason ? '  (' + r.reason + ')' : ''}`);
    }
    const written = readdirSync(OUT_DIR).filter((f) => f.endsWith('.png'));
    console.log('\nFiles written to', OUT_DIR + ':');
    for (const f of written.sort()) {
      const sz = statSync(path.join(OUT_DIR, f)).size;
      console.log(`  ${f}  (${(sz / 1024).toFixed(1)} KB)`);
    }
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    if (failed.length) console.log('\nStates that FAILED or were not fully confirmed:', failed.join(', '));
    else console.log('\nAll states captured and confirmed.');

    return 0;
  } finally {
    await app?.close().catch(() => {});
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error('\nFATAL:', err?.stack || err?.message || err);
    process.exit(1);
  });

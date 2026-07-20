import { app } from 'electron';
import path from 'node:path';
import { watch, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { BROWSER_TOKEN, processBrowserCommand, flattenBridgeResult } from './agent-browser-bridge';
import { processTerminalCommand, flattenTerminalResult } from './agent-terminal-bridge';
import { processSqlCommand, flattenSqlResult } from './agent-sql-bridge';
import { handleHookEvent } from './agent-activity-receiver';
import { winPathToWsl } from './wsl-paths';

// ─── WSL file bridge ─────────────────────────────────────────────────────────
// A claude running inside WSL cannot reach splitgrid's localhost HTTP receiver: in
// default-NAT networking the only route to the host is the vEthernet gateway, and
// the Windows Firewall drops inbound on that adapter (and the IP churns across WSL
// restarts). Instead we exchange requests as FILES on the shared filesystem — the
// distro sees splitgrid's userData at /mnt/<drive>/…, so the helper drops a request
// file and (for browser commands) polls for a reply file. No network, no firewall,
// no IP churn.
//
// Protocol (under <userData>/wsl-bridge):
//   req/<id>.json   {kind:'hook'|'browser'|'terminal'|'sql', terminal, token?, event?, argv?}
//                   written atomically (…tmp → rename) so we never read a partial.
//   res/<id>.json   the JSON reply (browser only); the helper reads then deletes.
// We watch req/, dispatch, and for browser write res/<id>.json. Stale files are
// pruned so a timed-out helper can't leak them.

const SWEEP_MS = 250;          // safety poll in case an fs.watch event is missed
const STALE_MS = 120_000;      // prune req/res older than this

let started = false;
let reqDir = '';
let resDir = '';
const inFlight = new Set<string>();

export function bridgeDirPath(): string {
  return path.join(app.getPath('userData'), 'wsl-bridge');
}

// Bridge replies go to an agent inside the distro, so a host screenshot path
// must be expressed as the distro sees it (/mnt/…); non-drive paths pass through.
function winToWslPath(p: string): string {
  return winPathToWsl(p) ?? p;
}

function safeUnlink(file: string): void {
  try { rmSync(file, { force: true }); } catch { /* gone */ }
}

async function processReqFile(name: string): Promise<void> {
  if (!name.endsWith('.json') || name.startsWith('.')) return; // ignore temp/partials
  if (inFlight.has(name)) return;
  inFlight.add(name);
  const reqPath = path.join(reqDir, name);
  try {
    let raw: string;
    try {
      raw = readFileSync(reqPath, 'utf8');
    } catch {
      return; // already consumed / mid-rename
    }
    let msg: { kind?: string; terminal?: string; token?: string; event?: string; argv?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      safeUnlink(reqPath);
      return;
    }

    const terminal = typeof msg.terminal === 'string' ? msg.terminal : '';

    if (msg.kind === 'hook') {
      // Fire-and-forget, like the HTTP /hook path (no token, no reply).
      if (terminal && typeof msg.event === 'string') handleHookEvent(terminal, msg.event);
      safeUnlink(reqPath);
      return;
    }

    if (msg.kind === 'browser') {
      const id = name.slice(0, -'.json'.length);
      let body: Record<string, unknown>;
      if (msg.token !== BROWSER_TOKEN) {
        body = { ok: false, error: 'unauthorized' };
      } else {
        const argv = Array.isArray(msg.argv) ? msg.argv.filter((a): a is string => typeof a === 'string') : [];
        body = flattenBridgeResult(await processBrowserCommand(terminal, argv));
        // The agent is inside the distro — hand back a /mnt path it can actually
        // open, not the Windows path screenshots are written to.
        if (typeof body.screenshot === 'string') body.screenshot = winToWslPath(body.screenshot);
      }
      // Write the reply atomically, then remove the request so the helper, which
      // polls for res/<id>.json, only ever sees a complete file.
      const tmp = path.join(resDir, `.${id}.tmp`);
      const fin = path.join(resDir, `${id}.json`);
      try {
        writeFileSync(tmp, JSON.stringify(body), 'utf8');
        renameSync(tmp, fin);
      } catch (err) {
        safeUnlink(tmp);
        console.error('[file-bridge] reply write failed:', (err as Error).message);
      }
      safeUnlink(reqPath);
      return;
    }

    if (msg.kind === 'terminal') {
      const id = name.slice(0, -'.json'.length);
      let body: Record<string, unknown>;
      if (msg.token !== BROWSER_TOKEN) {
        body = { ok: false, error: 'unauthorized' };
      } else {
        const argv = Array.isArray(msg.argv) ? msg.argv.filter((a): a is string => typeof a === 'string') : [];
        body = flattenTerminalResult(await processTerminalCommand(terminal, argv));
      }
      const tmp = path.join(resDir, `.${id}.tmp`);
      const fin = path.join(resDir, `${id}.json`);
      try {
        writeFileSync(tmp, JSON.stringify(body), 'utf8');
        renameSync(tmp, fin);
      } catch (err) {
        safeUnlink(tmp);
        console.error('[file-bridge] reply write failed:', (err as Error).message);
      }
      safeUnlink(reqPath);
      return;
    }

    if (msg.kind === 'sql') {
      const id = name.slice(0, -'.json'.length);
      let body: Record<string, unknown>;
      if (msg.token !== BROWSER_TOKEN) {
        body = { ok: false, error: 'unauthorized' };
      } else {
        const argv = Array.isArray(msg.argv) ? msg.argv.filter((a): a is string => typeof a === 'string') : [];
        body = flattenSqlResult(await processSqlCommand(terminal, argv));
        // Note: SQL results need no path translation (no screenshots). Export-file
        // path translation, if any, is a Phase B/C concern once dispatch exists.
      }
      const tmp = path.join(resDir, `.${id}.tmp`);
      const fin = path.join(resDir, `${id}.json`);
      try {
        writeFileSync(tmp, JSON.stringify(body), 'utf8');
        renameSync(tmp, fin);
      } catch (err) {
        safeUnlink(tmp);
        console.error('[file-bridge] reply write failed:', (err as Error).message);
      }
      safeUnlink(reqPath);
      return;
    }

    // Unknown kind — drop it.
    safeUnlink(reqPath);
  } finally {
    inFlight.delete(name);
  }
}

function scanReqDir(): void {
  let names: string[];
  try { names = readdirSync(reqDir); } catch { return; }
  for (const n of names) void processReqFile(n);
}

function pruneStale(): void {
  const now = Date.now();
  for (const dir of [reqDir, resDir]) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (now - statSync(p).mtimeMs > STALE_MS) safeUnlink(p);
      } catch { /* gone */ }
    }
  }
}

/**
 * Start the WSL file bridge: ensure the req/res dirs exist, watch req/ for
 * incoming requests, and periodically sweep (missed-event safety + stale prune).
 * Idempotent. The dir is injected into WSL terminals as $SPLITGRID_BRIDGE_DIR.
 */
export function startFileBridge(): void {
  if (started) return;
  started = true;
  const base = bridgeDirPath();
  reqDir = path.join(base, 'req');
  resDir = path.join(base, 'res');
  for (const d of [base, reqDir, resDir]) {
    try { if (!existsSync(d)) mkdirSync(d, { recursive: true }); } catch (err) {
      console.error('[file-bridge] mkdir failed:', (err as Error).message);
    }
  }

  try {
    watch(reqDir, (_event, filename) => { if (filename) void processReqFile(String(filename)); });
  } catch (err) {
    console.error('[file-bridge] watch failed, relying on sweep:', (err as Error).message);
  }

  // Process anything already queued, then sweep on an interval.
  scanReqDir();
  setInterval(() => { scanReqDir(); pruneStale(); }, SWEEP_MS).unref?.();
  console.log(`[file-bridge] watching ${reqDir}`);
}

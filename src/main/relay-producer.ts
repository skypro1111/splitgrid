import { BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { getAccessToken } from './workos-auth';
import type { RelayShareMeta, RelayStatus } from '../shared/types';

// ─── Relay producer ──────────────────────────────────────────────────────────
//
// One WebSocket from this (main) process to the relay's /ws/producer, carrying
// the WorkOS access token in the Authorization header. It streams the output of
// ONLY the terminals the user explicitly shared from their pane header — never
// everything. Each shared terminal carries env→workspace routing metadata so the
// web viewer can group them. The connection is opened lazily (only while ≥1
// terminal is shared and the user is signed in) and torn down when none remain.
//
// It is bidirectional: keystrokes a web viewer types come back over the same
// socket as `input` messages and are written to the PTY via the injected
// inputHandler — but only for a terminal that is still being shared.

const RELAY_BASE = (process.env.SPLITGRID_RELAY_URL || 'wss://stream.splitgrid.dev')
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')
  .replace(/\/$/, '');
const PRODUCER_URL = `${RELAY_BASE}/ws/producer`;
const MAX_BACKOFF_MS = 30_000;

// Wire shape sent to the relay (matches its SessionMeta).
interface WireMeta {
  id: string;
  title: string;
  cols: number;
  rows: number;
  envName: string;
  workspaceName: string;
}

const shared = new Map<string, WireMeta>(); // sessionId → metadata
let ws: WebSocket | null = null;
// Guards the async gap inside connect() (the `await getAccessToken()`): without
// it, two near-simultaneous connect() calls (e.g. re-sharing several terminals
// at launch) both pass the `if (ws)` check while the token resolves and open TWO
// producer sockets. The orphaned one stays registered on the relay, so viewer
// input gets delivered to BOTH → every keystroke written to the PTY twice.
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1_000;

// Sink for keystrokes arriving from a web viewer. Wired by ipc-handlers (which
// owns the terminal manager) to terminalManager.sendData. Null until wired.
let inputHandler: ((sessionId: string, data: string) => void) | null = null;
export function relaySetInputHandler(fn: (sessionId: string, data: string) => void): void {
  inputHandler = fn;
}

// Provides a terminal's current scrollback so a freshly-shared session arrives
// on the web with its EXISTING screen, not blank until the next byte. Wired by
// ipc-handlers to terminalManager.getBuffer.
let bufferProvider: ((sessionId: string) => string | undefined) | null = null;
export function relaySetBufferProvider(fn: (sessionId: string) => string | undefined): void {
  bufferProvider = fn;
}

// Seed the relay with a session's current buffer as one `data` chunk. Called the
// instant we start streaming a session (synchronously, before any live byte can
// interleave) so there's no gap and no duplication with the live feed.
function seed(sessionId: string): void {
  const buf = bufferProvider?.(sessionId);
  if (buf) send({ t: 'data', id: sessionId, chunk: buf });
}

function isOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function send(msg: unknown): void {
  if (isOpen()) ws!.send(JSON.stringify(msg));
}

function broadcastStatus(): void {
  const status: RelayStatus = { connected: isOpen(), sharedCount: shared.size };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('relay:status', status);
    }
  }
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delay = backoff): void {
  if (reconnectTimer || shared.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

async function connect(): Promise<void> {
  if (ws || connecting || shared.size === 0) return;

  connecting = true;
  const token = await getAccessToken();
  connecting = false;
  // Re-check after the async gap: another path may have connected meanwhile, or
  // every terminal may have been un-shared while we waited.
  if (ws || shared.size === 0) return;
  if (!token) {
    // Signed out (or refresh failed) — retry slowly; a sign-in will make the
    // next attempt succeed. Don't hammer.
    scheduleReconnect(5_000);
    return;
  }

  const socket = new WebSocket(PRODUCER_URL, { headers: { Authorization: `Bearer ${token}` } });
  ws = socket;

  socket.on('open', () => {
    backoff = 1_000;
    // Announce every currently-shared terminal so a fresh/reconnected relay
    // rebuilds the room from scratch, then seed each with its current screen.
    send({ t: 'hello', sessions: [...shared.values()] });
    for (const id of shared.keys()) seed(id);
    broadcastStatus();
  });
  socket.on('message', (raw: WebSocket.RawData) => {
    let msg: { t?: string; id?: unknown; data?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Web viewer keystrokes. Gate: only write to a terminal the user is still
    // actively streaming (shared). Anything else is dropped — a closed/never-
    // shared terminal must never receive remote input.
    if (msg && msg.t === 'input' && typeof msg.id === 'string' && typeof msg.data === 'string') {
      if (!shared.has(msg.id)) return;
      inputHandler?.(msg.id, msg.data);
    }
  });
  socket.on('close', () => {
    if (ws === socket) ws = null;
    broadcastStatus();
    scheduleReconnect();
  });
  socket.on('error', () => {
    // 'close' fires next and handles reconnect; swallow so it can't crash main.
  });
}

function disconnect(): void {
  clearReconnect();
  backoff = 1_000;
  if (ws) {
    const socket = ws;
    ws = null;
    try { socket.close(); } catch { /* already closing */ }
  }
  broadcastStatus();
}

// ── Public API (called from ipc-handlers' terminal I/O hub) ──────────────────

// Enable/disable streaming for a terminal. `meta` is required when enabling.
export function relaySetShare(sessionId: string, enabled: boolean, meta?: RelayShareMeta): void {
  if (enabled) {
    if (!meta) return;
    // Re-sharing an existing session (e.g. a rename refreshing the title) must
    // NOT re-seed — that would append the whole buffer again. Only a brand-new
    // share gets seeded with its current screen.
    const isNew = !shared.has(sessionId);
    const wire: WireMeta = {
      id: sessionId,
      title: meta.title,
      cols: meta.cols,
      rows: meta.rows,
      envName: meta.envName,
      workspaceName: meta.workspaceName,
    };
    shared.set(sessionId, wire);
    if (isOpen()) {
      send({ t: 'open', session: wire });
      if (isNew) seed(sessionId);
    } else {
      void connect();
    }
  } else {
    if (!shared.delete(sessionId)) return;
    if (isOpen()) send({ t: 'close', id: sessionId });
    if (shared.size === 0) disconnect();
  }
  broadcastStatus();
}

// Every PTY byte passes through here (from the onData hub). Cheap no-op unless
// the session is shared and the socket is live.
export function relayFeed(sessionId: string, chunk: string): void {
  if (!isOpen() || !shared.has(sessionId)) return;
  send({ t: 'data', id: sessionId, chunk });
}

export function relayResize(sessionId: string, cols: number, rows: number): void {
  const m = shared.get(sessionId);
  if (!m) return;
  m.cols = cols;
  m.rows = rows;
  send({ t: 'resize', id: sessionId, cols, rows });
}

// A shared terminal closed — stop streaming it and tell the relay.
export function relayDropSession(sessionId: string): void {
  if (!shared.delete(sessionId)) return;
  if (isOpen()) send({ t: 'close', id: sessionId });
  if (shared.size === 0) disconnect();
  broadcastStatus();
}

// The relay:set-share IPC is registered in ipc-handlers (which owns the terminal
// I/O hub), so it can correct the shared terminal's cols/rows with the size main
// actually knows from resize events — the renderer-supplied size can be stale or
// a default, which would garble a TUI mirror.

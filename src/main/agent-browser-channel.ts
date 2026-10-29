import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { app } from 'electron';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { AppSettingsStore } from './app-settings-store';
import { writeFileAtomicSync } from './atomic-write';
import {
  EXT_COMMAND_TIMEOUT_MS, EXT_ERRORS, EXT_HEARTBEAT_MS, EXT_PAIRING_TTL_MS,
  EXT_PROTOCOL_VERSION, EXT_WS_PATH, formatExtSurface, isWriteOp, parseExtSurface,
  type DesktopToExt, type ExtCommand, type ExtIdentity, type ExtTab, type ExtToDesktop,
} from '../shared/ext-protocol';

// ─── Browser-extension channel (main side) ───────────────────────────────────
// Owns the connection to the companion browser extension and exposes the tabs
// the user has activated as agent-targetable surfaces (`tab:c1.842`). The agent
// browser bridge routes those surfaces here instead of to a renderer <webview>.
// The `c1` half names the paired BROWSER and is persisted with the pairing, so a
// surface an agent captured stays valid across service-worker evictions and app
// restarts; see the pairing store below.
//
// Transport: a WebSocket upgraded off the loopback activity receiver (:19558) on
// EXT_WS_PATH. That socket is reachable by ANY page in the user's browser — a
// loopback WebSocket is not subject to CORS and gets no preflight — so the gate
// is twofold and both halves matter:
//   1. Origin must be chrome-extension:// (or moz-extension://). Browsers set
//      Origin themselves and scripts cannot forge it, so this alone excludes
//      every http(s) page; only an installed extension can get past it.
//   2. A pairing token the user authorised out-of-band by typing a one-time
//      code shown in the SplitGrid UI into the extension. This excludes OTHER
//      extensions the user happens to have installed.
// On top of that, every command is re-checked against the user's settings gates
// (agentChromeControl / agentChromeWrite) before it leaves the desktop.

/** A user-activated browser tab, as an agent-targetable surface. */
export interface ExtSurfaceInfo {
  surface: string;
  clientId: string;
  tabId: number;
  title: string;
  url: string;
  origin: string;
  /** The extension-side interaction switch for this tab. */
  writable: boolean;
  /** Display name of the browser holding it ("Chrome 141"). */
  browser: string;
}

export interface ExtClientInfo {
  clientId: string;
  identity: ExtIdentity;
  connectedAt: number;
}

export interface ExtChannelResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Desktop-side refusal: agentChromeControl is off, so nothing may be sent. */
export const EXT_DISABLED = 'chrome_control_disabled';

/** Desktop-side refusal: a bare `tab:<id>` while several extensions are paired,
 *  so which browser was meant is genuinely unknowable. Not in EXT_ERRORS because
 *  the extension can never produce it. */
export const EXT_AMBIGUOUS_TAB = 'ambiguous_tab';

/** A 6-digit code is only 10^6 wide; without a cap a socket walks it in seconds.
 *  Attempts are counted per pairing WINDOW (not per socket) so reconnecting does
 *  not reset the budget, and blowing the budget burns the code. */
const MAX_PAIRING_ATTEMPTS = 5;

const PAIRINGS_FILE = 'browser-extension-pairings.json';

// ─── Timing ──────────────────────────────────────────────────────────────────

interface ChannelTiming {
  commandTimeoutMs: number;
  heartbeatMs: number;
  pairingTtlMs: number;
  /** How long a connected-but-unauthenticated socket may sit there. */
  authTimeoutMs: number;
}

const DEFAULT_TIMING: ChannelTiming = {
  commandTimeoutMs: EXT_COMMAND_TIMEOUT_MS,
  heartbeatMs: EXT_HEARTBEAT_MS,
  pairingTtlMs: EXT_PAIRING_TTL_MS,
  authTimeoutMs: 15_000,
};

let timing: ChannelTiming = { ...DEFAULT_TIMING };

// ─── Client state ────────────────────────────────────────────────────────────

/** The only thing the channel needs from a transport. Keeping it this small is
 *  what lets the message handling be driven from tests without a real browser,
 *  and what will let the relay transport reuse all of it unchanged. */
export interface ChannelSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Pending {
  resolve: (result: ExtChannelResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExtClientState {
  /** Agent-facing client id (`c1`), the first half of every `tab:<clientId>.<tabId>`
   *  surface. Empty until the socket authenticates: it is derived from the paired
   *  extension identity, and an unauthenticated socket owns no surfaces. */
  id: string;
  /** Log label. `s3` until authentication, the client id afterwards, so a line
   *  can always be tied to one socket even before it has an identity. */
  tag: string;
  socket: ChannelSocket;
  /** Host part of the WS Origin — the extension id the browser vouched for. */
  originHost: string;
  identity: ExtIdentity | null;
  authed: boolean;
  connectedAt: number;
  tabs: ExtTab[];
  pending: Map<string, Pending>;
  missedPongs: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  gone: boolean;
}

// A set, not a map keyed by id: a socket has no client id until it authenticates.
const clients = new Set<ExtClientState>();
let socketCounter = 0;
let reqCounter = 0;

let pairing: { code: string; expiresAt: number; attempts: number } | null = null;

// ─── Settings gates ──────────────────────────────────────────────────────────

// The persisted settings file is the single source of truth: AppSettingsStore.get()
// re-reads it on every call, so a toggle in Settings takes effect on the next
// command with no cached copy to keep in sync. Fails CLOSED on any read error.
let settingsStore: AppSettingsStore | null = null;
function chromeGates(): { control: boolean; write: boolean } {
  try {
    settingsStore ??= new AppSettingsStore();
    const s = settingsStore.get();
    return { control: !!s.agentChromeControl, write: !!s.agentChromeWrite };
  } catch {
    return { control: false, write: false };
  }
}

// ─── Pairing token store ─────────────────────────────────────────────────────

interface PairingRecord {
  extensionId: string;
  token: string;
  pairedAt: number;
  browser: string;
  /** The browser's stable agent-facing client id. Persisted with the pairing —
   *  NOT derived from the socket — because an MV3 service worker is evicted and
   *  reconnects routinely, and a surface an agent captured at the start of its
   *  run has to still name the same browser afterwards. */
  clientId: string;
}

let pairingCache: PairingRecord[] | null = null; // null = not loaded from disk yet

function pairingsFile(): string {
  return path.join(app.getPath('userData'), PAIRINGS_FILE);
}

/** Is this client id spoken for — persisted to a pairing, or held by a live
 *  connection? The surface id is the only thing telling two browsers' tabs
 *  apart (tab ids are per-browser and DO collide), so it may never be reused. */
function clientIdTaken(id: string): boolean {
  if (pairingCache?.some((r) => r.clientId === id)) return true;
  for (const c of clients) if (c.id === id) return true;
  return false;
}

/** The lowest free `c<n>`. Bounded: there are finitely many records and clients,
 *  so at most that many ids can be taken. */
function allocateClientId(): string {
  for (let n = 1; ; n++) {
    const id = `c${n}`;
    if (!clientIdTaken(id)) return id;
  }
}

function loadPairings(): PairingRecord[] {
  if (pairingCache) return pairingCache;
  const records: PairingRecord[] = [];
  try {
    const file = pairingsFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          const o = r as Record<string, unknown> | null;
          if (!o || typeof o.extensionId !== 'string') continue;
          if (typeof o.token !== 'string' || o.token.length === 0) continue;
          records.push({
            extensionId: o.extensionId,
            token: o.token,
            pairedAt: typeof o.pairedAt === 'number' ? o.pairedAt : Date.now(),
            browser: typeof o.browser === 'string' ? o.browser : 'browser',
            // Must keep matching the surface grammar; anything else is treated as absent.
            clientId: typeof o.clientId === 'string' && /^c\d+$/.test(o.clientId) ? o.clientId : '',
          });
        }
      }
    }
  } catch (err) {
    // A corrupt/unreadable file must not brick the channel — the user can pair again.
    console.error('[ext] failed to read pairings:', (err as Error).message);
    records.length = 0;
  }
  pairingCache = records; // set before adopting: allocation reads the cache

  // Migration: pairings written before client ids were persisted have none, and
  // a duplicate would make two browsers indistinguishable. Adopt them in place —
  // dropping the record would force the user to re-pair.
  const seen = new Set<string>();
  let adopted = false;
  for (const rec of records) {
    if (rec.clientId && !seen.has(rec.clientId)) {
      seen.add(rec.clientId);
      continue;
    }
    rec.clientId = ''; // clear first, so allocation does not count it as taken
    rec.clientId = allocateClientId();
    seen.add(rec.clientId);
    adopted = true;
    console.log(`[ext] adopted pairing ${rec.extensionId} as ${rec.clientId}`);
  }
  if (adopted) savePairings(records);
  return pairingCache;
}

function savePairings(records: PairingRecord[]): void {
  pairingCache = records;
  try {
    const file = pairingsFile();
    // 0o700 dir / 0o600 file: these tokens ARE the credential for driving the
    // user's browser, so no other account on the machine may read them.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(file, JSON.stringify(records, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[ext] failed to persist pairings:', (err as Error).message);
  }
}

function rememberPairing(record: Omit<PairingRecord, 'clientId'>): PairingRecord {
  // One live token per extension id: re-pairing replaces the old one rather than
  // leaving a second, still-valid credential behind. The client id is the one
  // thing carried over — it is the same browser, and agents may hold surfaces
  // naming it.
  const all = loadPairings();
  const prior = all.find((r) => r.extensionId === record.extensionId);
  const full: PairingRecord = { ...record, clientId: prior?.clientId || allocateClientId() };
  savePairings([...all.filter((r) => r.extensionId !== record.extensionId), full]);
  return full;
}

/**
 * Constant-time string compare. Length is compared first and NOT hidden: our
 * tokens are fixed-width hex and the pairing code fixed-width digits, so length
 * leaks nothing, while a plain `===` would leak the matching prefix through
 * timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

// Find the stored pairing for this token, bound to the extension id the BROWSER
// vouched for via Origin. A token leaked to another extension is therefore
// useless. Every candidate is compared (no early exit) to keep it timing-flat.
function findPairing(token: string, extensionId: string): PairingRecord | null {
  let found: PairingRecord | null = null;
  for (const rec of loadPairings()) {
    if (constantTimeEquals(rec.token, token) && rec.extensionId === extensionId) found = rec;
  }
  return found;
}

// ─── Origin gate ─────────────────────────────────────────────────────────────

// Only extension origins. A page cannot set Origin itself and cannot be served
// from an extension scheme, so this is the line that keeps every http(s) page in
// the browser off the socket. Deliberately lenient about the id ITSELF (Chrome
// uses 32 a–p chars, Firefox a UUID, and future browsers something else) — the
// id is not what is being trusted here, the SCHEME is; the pairing token is what
// distinguishes one extension from another.
const EXT_ORIGIN_RE = /^(chrome-extension|moz-extension):\/\/([a-z0-9._-]+)$/i;

/** The extension id an Origin header vouches for, or null if it isn't one. */
export function extensionOriginHost(origin: string | undefined | null): string | null {
  if (!origin) return null;
  const m = EXT_ORIGIN_RE.exec(origin.trim());
  return m ? m[2] : null;
}

export function isAllowedExtensionOrigin(origin: string | undefined | null): boolean {
  return extensionOriginHost(origin) !== null;
}

// ─── Connection lifecycle ────────────────────────────────────────────────────

function deviceName(): string {
  try {
    return os.hostname() || 'SplitGrid';
  } catch {
    return 'SplitGrid';
  }
}

function send(client: ExtClientState, msg: DesktopToExt): boolean {
  try {
    client.socket.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    console.error(`[ext] ${client.tag} send failed:`, (err as Error).message);
    return false;
  }
}

/** Register a freshly connected socket. Unauthenticated — and therefore without
 *  a client id — until it pairs or says hello; a socket that does neither in
 *  time is dropped. */
function attachSocket(socket: ChannelSocket, originHost: string): ExtClientState {
  const client: ExtClientState = {
    id: '',
    tag: `s${++socketCounter}`,
    socket,
    originHost,
    identity: null,
    authed: false,
    connectedAt: Date.now(),
    tabs: [],
    pending: new Map(),
    missedPongs: 0,
    heartbeat: null,
    authTimer: null,
    gone: false,
  };
  clients.add(client);
  client.authTimer = setTimeout(() => dropClient(client, 4008, 'auth timeout'), timing.authTimeoutMs);
  console.log(`[ext] ${client.tag} connected from ${originHost}`);
  return client;
}

/**
 * Settle the socket's agent-facing identity, at AUTHENTICATION time: this is the
 * first moment we know WHICH browser is on the other end.
 *
 * Two Chrome profiles running the same extension share one extension id, and
 * their tab ids are independent and collide — so a second LIVE connection cannot
 * be given the same client id, and must not be treated as a replacement that
 * closes the first: both profiles stay drivable. First one in keeps the stable,
 * persisted id; any concurrent sibling gets a distinct id for its lifetime only.
 */
function assignClientId(client: ExtClientState, record: PairingRecord): void {
  const stableIsLive = [...clients].some((c) => c !== client && !c.gone && c.id === record.clientId);
  if (!stableIsLive) {
    client.id = record.clientId;
  } else {
    client.id = allocateClientId();
    console.log(
      `[ext] ${client.tag}: ${record.extensionId} is already live as ${record.clientId} ` +
      `(second browser profile) — driving this connection as ${client.id} for its lifetime`,
    );
  }
  client.tag = client.id;
}

// Heartbeat starts only once authenticated. Besides detecting a dead socket it
// keeps the extension's MV3 service worker alive — WebSocket traffic resets the
// 30s eviction timer, which is why EXT_HEARTBEAT_MS sits below it.
function startHeartbeat(client: ExtClientState): void {
  if (client.heartbeat) return;
  client.missedPongs = 0;
  client.heartbeat = setInterval(() => {
    if (client.missedPongs >= 2) {
      dropClient(client, 4009, 'heartbeat lost');
      return;
    }
    client.missedPongs++;
    send(client, { t: 'ping' });
  }, timing.heartbeatMs);
}

/** Forget a client whose socket is already gone (close/error). Settles every
 *  pending request so no caller is left awaiting a promise that can't resolve. */
function detachClient(client: ExtClientState, why: string): void {
  if (client.gone) return;
  client.gone = true;
  clients.delete(client);
  if (client.heartbeat) clearInterval(client.heartbeat);
  if (client.authTimer) clearTimeout(client.authTimer);
  client.heartbeat = null;
  client.authTimer = null;
  for (const [, p] of client.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: EXT_ERRORS.noExtension });
  }
  client.pending.clear();
  console.log(`[ext] ${client.tag} disconnected (${why})`);
}

/** Close a client's socket and forget it. */
function dropClient(client: ExtClientState, code: number, reason: string): void {
  if (!client.gone) {
    try { client.socket.close(code, reason); } catch { /* already closing */ }
  }
  detachClient(client, reason);
}

// ─── Message handling ────────────────────────────────────────────────────────

function sanitizeIdentity(v: unknown): ExtIdentity | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.extensionId !== 'string' || !o.extensionId) return null;
  return {
    extensionId: o.extensionId,
    browser: typeof o.browser === 'string' ? o.browser : 'browser',
    version: typeof o.version === 'string' ? o.version : '0',
  };
}

// Tabs arrive from the extension, i.e. from outside the process — normalize the
// shape rather than trusting it into the registry the agent then targets.
function sanitizeTabs(v: unknown): ExtTab[] {
  if (!Array.isArray(v)) return [];
  const out: ExtTab[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.tabId !== 'number' || !Number.isInteger(t.tabId) || t.tabId < 0) continue;
    out.push({
      tabId: t.tabId,
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
      origin: typeof t.origin === 'string' ? t.origin : '',
      writable: t.writable === true,
      activatedAt: typeof t.activatedAt === 'number' ? t.activatedAt : Date.now(),
    });
  }
  return out;
}

function checkProtocol(client: ExtClientState, protocol: unknown): boolean {
  if (protocol === EXT_PROTOCOL_VERSION) return true;
  const reason = `protocol mismatch: desktop speaks v${EXT_PROTOCOL_VERSION}, extension sent v${String(protocol)}`;
  console.warn(`[ext] ${client.tag} ${reason}`);
  send(client, { t: 'pair-fail', reason });
  dropClient(client, 4002, `protocol mismatch (v${EXT_PROTOCOL_VERSION} expected)`);
  return false;
}

// The identity the extension claims must be the one the BROWSER vouched for in
// the Origin header, so a paired extension cannot masquerade as another.
function checkIdentity(client: ExtClientState, v: unknown): ExtIdentity | null {
  const identity = sanitizeIdentity(v);
  if (!identity || identity.extensionId !== client.originHost) {
    console.warn(`[ext] ${client.tag} identity does not match origin ${client.originHost}`);
    send(client, { t: 'pair-fail', reason: 'identity_mismatch' });
    dropClient(client, 4003, 'identity mismatch');
    return null;
  }
  return identity;
}

function failPair(client: ExtClientState, reason: string): void {
  console.warn(`[ext] ${client.tag} pairing rejected (${reason})`);
  send(client, { t: 'pair-fail', reason });
  dropClient(client, 4004, `pairing rejected: ${reason}`);
}

function handlePair(client: ExtClientState, msg: { protocol?: unknown; code?: unknown; identity?: unknown }): void {
  if (client.authed) return; // already authenticated on this socket
  if (!checkProtocol(client, msg.protocol)) return;
  const identity = checkIdentity(client, msg.identity);
  if (!identity) return;

  const now = Date.now();
  if (!pairing || now > pairing.expiresAt) {
    pairing = null;
    failPair(client, 'no_pairing_window');
    return;
  }
  if (++pairing.attempts > MAX_PAIRING_ATTEMPTS) {
    // Burn the window entirely: a fresh socket must not get a fresh budget.
    pairing = null;
    failPair(client, 'too_many_attempts');
    return;
  }
  if (typeof msg.code !== 'string' || !constantTimeEquals(msg.code, pairing.code)) {
    failPair(client, 'bad_code');
    return;
  }

  pairing = null; // single use
  const token = randomBytes(32).toString('hex');
  const record = rememberPairing({ extensionId: identity.extensionId, token, pairedAt: now, browser: identity.browser });

  client.identity = identity;
  assignClientId(client, record);
  client.authed = true;
  if (client.authTimer) clearTimeout(client.authTimer);
  client.authTimer = null;
  send(client, { t: 'pair-ok', token, device: deviceName() });
  console.log(`[ext] ${client.tag} paired with ${identity.browser} (${identity.extensionId})`);
  startHeartbeat(client);
}

function handleHello(client: ExtClientState, msg: { protocol?: unknown; token?: unknown; identity?: unknown }): void {
  if (client.authed) return;
  if (!checkProtocol(client, msg.protocol)) return;
  const identity = checkIdentity(client, msg.identity);
  if (!identity) return;

  const token = typeof msg.token === 'string' ? msg.token : '';
  const record = findPairing(token, identity.extensionId);
  if (!record) {
    console.warn(`[ext] ${client.tag} unknown token from ${identity.extensionId} — closing`);
    dropClient(client, 4001, 'not paired');
    return;
  }

  client.identity = identity;
  // The whole point of persisting the id: a service-worker eviction and reconnect
  // hands this browser back the SAME surface ids the agent already holds.
  assignClientId(client, record);
  client.authed = true;
  if (client.authTimer) clearTimeout(client.authTimer);
  client.authTimer = null;
  send(client, { t: 'ready', device: deviceName() });
  console.log(`[ext] ${client.tag} authenticated: ${identity.browser} (${identity.extensionId})`);
  startHeartbeat(client);
}

function settleResult(client: ExtClientState, msg: { reqId?: unknown; ok?: unknown; data?: unknown; error?: unknown }): void {
  const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
  const p = client.pending.get(reqId);
  if (!p) return; // already timed out, or a reqId we never issued
  clearTimeout(p.timer);
  client.pending.delete(reqId);
  p.resolve({
    ok: msg.ok === true,
    data: msg.data && typeof msg.data === 'object' ? (msg.data as Record<string, unknown>) : undefined,
    error: typeof msg.error === 'string' ? msg.error : undefined,
  });
}

/** Handle one frame from a client. Exported through the test seam below. */
function handleClientMessage(client: ExtClientState, raw: string): void {
  if (client.gone) return;
  let msg: ExtToDesktop | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { t?: unknown }).t === 'string') {
      msg = parsed as ExtToDesktop;
    }
  } catch {
    msg = null;
  }
  if (!msg) {
    dropClient(client, 1003, 'unparseable message');
    return;
  }

  // Everything except the two handshake messages requires an authenticated
  // socket — an unpaired extension must not be able to seed the tab registry or
  // spoof a result.
  if (msg.t !== 'pair' && msg.t !== 'hello' && !client.authed) {
    dropClient(client, 4001, 'not authenticated');
    return;
  }

  switch (msg.t) {
    case 'pair': handlePair(client, msg); return;
    case 'hello': handleHello(client, msg); return;
    case 'pong': client.missedPongs = 0; return;
    case 'tabs': client.tabs = sanitizeTabs(msg.tabs); return;
    case 'result': settleResult(client, msg); return;
    default: return; // forward-compat: ignore messages a newer extension invents
  }
}

// ─── WebSocket transport ─────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let attachedServer: Server | null = null;
let upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/** Attach the extension WebSocket endpoint to the loopback receiver's server. */
export function startExtensionChannel(server: Server): void {
  if (wss) return;
  // Screenshots come back as base64 in a result frame, so the payload cap has to
  // clear a full-page PNG.
  const server_ = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  wss = server_;

  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      return;
    }
    // Not our path: leave the socket completely alone. Another feature may own
    // its own upgrade path on this same server.
    if (pathname !== EXT_WS_PATH) return;

    const originHost = extensionOriginHost(req.headers.origin);
    if (!originHost) {
      console.warn(`[ext] upgrade refused, origin=${req.headers.origin ?? '(none)'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    server_.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const client = attachSocket(
        {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
        },
        originHost,
      );
      ws.on('message', (data: RawData) => handleClientMessage(client, rawToString(data)));
      ws.on('close', () => detachClient(client, 'socket closed'));
      ws.on('error', (err: Error) => {
        console.error(`[ext] ${client.tag} socket error:`, err.message);
        detachClient(client, 'socket error');
      });
    });
  };

  server.on('upgrade', listener);
  upgradeListener = listener;
  attachedServer = server;
  console.log(`[ext] extension channel listening on ${EXT_WS_PATH}`);
}

export function stopExtensionChannel(): void {
  if (attachedServer && upgradeListener) attachedServer.off('upgrade', upgradeListener);
  attachedServer = null;
  upgradeListener = null;
  for (const client of [...clients]) dropClient(client, 1001, 'app shutting down');
  wss?.close();
  wss = null;
  pairing = null;
}

// ─── Pairing (UI-facing) ─────────────────────────────────────────────────────

/** Mint a one-time pairing code for the user to type into the extension. */
export function beginPairing(): { code: string; expiresAt: number } {
  // randomInt, never Math.random: this code is the sole authorisation for handing
  // an agent the user's logged-in browser, and Math.random is predictable from a
  // few prior outputs.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = Date.now() + timing.pairingTtlMs;
  pairing = { code, expiresAt, attempts: 0 };
  console.log(`[ext] pairing window open for ${Math.round(timing.pairingTtlMs / 1000)}s`);
  return { code, expiresAt };
}

export function cancelPairing(): void {
  if (!pairing) return;
  pairing = null;
  console.log('[ext] pairing window cancelled');
}

// ─── Queries ─────────────────────────────────────────────────────────────────

function authedClients(): ExtClientState[] {
  return [...clients].filter((c) => c.authed && !c.gone);
}

export function isExtensionConnected(): boolean {
  return authedClients().length > 0;
}

export function listExtensionClients(): ExtClientInfo[] {
  return authedClients()
    .filter((c): c is ExtClientState & { identity: ExtIdentity } => c.identity !== null)
    .map((c) => ({ clientId: c.id, identity: c.identity, connectedAt: c.connectedAt }));
}

/** Every activated tab across every connected extension. */
export function listExtensionSurfaces(): ExtSurfaceInfo[] {
  const out: ExtSurfaceInfo[] = [];
  for (const client of authedClients()) {
    for (const tab of client.tabs) {
      out.push({
        surface: formatExtSurface(client.id, tab.tabId),
        clientId: client.id,
        tabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        origin: tab.origin,
        writable: tab.writable,
        browser: client.identity?.browser ?? 'browser',
      });
    }
  }
  return out;
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * A surface naming a client id nothing is connected as. Client ids are stable
 * now, so this should be rare — but a bare `no_extension` reads as "no browser
 * at all", which is exactly what made the old per-socket ids so confusing to
 * diagnose. Say what IS connected, and where the tab actually lives if it is
 * still reachable. Never retarget silently: the caller decides.
 */
function staleClientError(clientId: string, tabId: number, connected: ExtClientState[]): ExtChannelResult {
  const holder = connected.find((c) => c.tabs.some((t) => t.tabId === tabId));
  const data: Record<string, unknown> = { clientId, clients: connected.map((c) => c.id) };
  if (!holder) {
    data.message = `no browser is connected as ${clientId} (connected: ${connected.map((c) => c.id).join(', ')}) — list the browser surfaces again for a current one`;
    return { ok: false, error: EXT_ERRORS.noExtension, data };
  }
  const current = formatExtSurface(holder.id, tabId);
  data.surface = current;
  const bare = connected.length === 1 ? `, or the bare tab:${tabId} form` : '';
  data.message =
    `${clientId} is not connected — that surface belongs to a client that reconnected. `
    + `Tab ${tabId} is still activated on ${holder.id} (${holder.identity?.browser ?? 'browser'}): use ${current}${bare}.`;
  return { ok: false, error: EXT_ERRORS.noExtension, data };
}

/**
 * Run one command against a tab surface. Resolves the extension's reply, or an
 * error from EXT_ERRORS (no_extension / unknown_tab / write_denied / ext_timeout).
 * Enforces the write gate before the command leaves the desktop.
 */
export async function runExtensionCommand(surface: string, command: ExtCommand): Promise<ExtChannelResult> {
  // Both gates are checked here, in main, on EVERY command: the extension checks
  // its own per-tab switch too, but neither end trusts the other to have done it.
  const gates = chromeGates();
  if (!gates.control) {
    return { ok: false, error: EXT_DISABLED, data: { message: 'Enable "Let agents control your browser" in SplitGrid Settings.' } };
  }
  if (isWriteOp(command.op) && !gates.write) {
    return { ok: false, error: EXT_ERRORS.writeDenied, data: { message: `"${command.op}" needs "Allow agents to interact with pages" in SplitGrid Settings.` } };
  }

  const parsed = parseExtSurface(surface);
  if (!parsed) return { ok: false, error: EXT_ERRORS.unknownTab, data: { message: `not a browser tab surface: ${surface}` } };

  const connected = authedClients();
  if (connected.length === 0) return { ok: false, error: EXT_ERRORS.noExtension };

  let client: ExtClientState | undefined;
  if (parsed.clientId) {
    client = connected.find((c) => c.id === parsed.clientId);
    if (!client) return staleClientError(parsed.clientId, parsed.tabId, connected);
  } else if (connected.length > 1) {
    // Bare `tab:842` only resolves while exactly one browser is paired.
    return {
      ok: false,
      error: EXT_AMBIGUOUS_TAB,
      data: {
        message: `${connected.length} browsers are connected — qualify the tab, e.g. ${formatExtSurface(connected[0].id, parsed.tabId)}`,
        clients: connected.map((c) => c.id),
      },
    };
  } else {
    client = connected[0];
  }

  if (!client.tabs.some((t) => t.tabId === parsed.tabId)) {
    return { ok: false, error: EXT_ERRORS.unknownTab, data: { message: `tab ${parsed.tabId} is not activated for agent control` } };
  }

  const target = client;
  const reqId = `x${++reqCounter}`;
  return new Promise<ExtChannelResult>((resolve) => {
    const timer = setTimeout(() => {
      target.pending.delete(reqId);
      resolve({ ok: false, error: EXT_ERRORS.timeout });
    }, timing.commandTimeoutMs);
    target.pending.set(reqId, { resolve, timer });
    if (!send(target, { t: 'cmd', reqId, tabId: parsed.tabId, command })) {
      clearTimeout(timer);
      target.pending.delete(reqId);
      resolve({ ok: false, error: EXT_ERRORS.noExtension });
    }
  });
}

// ─── Test seam ───────────────────────────────────────────────────────────────

/**
 * Internals for agent-browser-channel.test.ts. The interesting logic is the
 * handshake, the gates and the command correlation — none of which need a real
 * browser — so tests drive them through a fake ChannelSocket. The real heartbeat
 * and timeout windows are tens of seconds, hence the timing override.
 */
export const __extChannelInternals = {
  attachSocket,
  handleClientMessage,
  detachClient,
  dropClient,
  setTiming(next: Partial<ChannelTiming>): void {
    timing = { ...timing, ...next };
  },
  /** Full teardown between tests: sockets, pairing window, timers, disk cache. */
  reset(): void {
    for (const client of [...clients]) detachClient(client, 'test reset');
    clients.clear();
    pairing = null;
    pairingCache = null;
    settingsStore = null;
    timing = { ...DEFAULT_TIMING };
  },
};

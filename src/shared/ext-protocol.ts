// ─── SplitGrid ⇄ browser-extension wire protocol ─────────────────────────────
//
// The desktop app can drive ONE user-activated tab in the user's real browser
// through a companion MV3 extension, as a second "surface" alongside the
// embedded <webview> panes. This file is the single contract shared by both
// ends: the main-process channel (src/main/agent-browser-channel.ts) and the
// extension service worker (extension/src/*).
//
// Transport (v1): a WebSocket to the already-running loopback receiver
// (127.0.0.1:19558, see agent-activity-receiver) upgraded on EXT_WS_PATH. The
// channel is deliberately transport-agnostic so the relay path (browser on a
// different machine, WorkOS-authenticated, end-to-end encrypted) can be added
// later without touching either side's command handling.
//
// Trust model: the loopback socket is reachable by any page in the browser, so
// the channel accepts ONLY chrome-extension:// origins and requires a pairing
// token minted from a one-time code the user reads out of the SplitGrid UI.

export const EXT_PROTOCOL_VERSION = 1;

/** WebSocket upgrade path on the loopback receiver. */
export const EXT_WS_PATH = '/ext';

/** Heartbeat period. Must stay under 30s: an MV3 service worker is evicted after
 *  30s of inactivity, and WebSocket traffic resets that timer. */
export const EXT_HEARTBEAT_MS = 20_000;

/** How long the desktop waits for a command result before giving up. Kept below
 *  the CLI's 35s budget so the agent gets our error, not a transport timeout. */
export const EXT_COMMAND_TIMEOUT_MS = 30_000;

/** Pairing codes are short-lived — the user types one out of the SplitGrid UI. */
export const EXT_PAIRING_TTL_MS = 3 * 60 * 1000;

/** Who is on the other end of the socket (shown in the SplitGrid UI). */
export interface ExtIdentity {
  /** The extension's own id — also the only accepted WS Origin host. */
  extensionId: string;
  /** "Chrome 141", "Edge 141", … for display. */
  browser: string;
  /** Extension version, for protocol-drift diagnostics. */
  version: string;
}

/** A tab the user has explicitly handed to the agent. Pushed by the extension
 *  whenever the set changes (activate, deactivate, navigate, close). */
export interface ExtTab {
  tabId: number;
  title: string;
  url: string;
  /** Origin the user granted at activation. A cross-origin navigation revokes
   *  control until the user re-activates — this is what stops an agent from
   *  wandering from localhost to the user's mail. */
  origin: string;
  /** Extension-side interaction switch (the user's half of the write gate). */
  writable: boolean;
  activatedAt: number;
}

// ─── Commands (desktop → extension) ──────────────────────────────────────────
// Phase 0 vocabulary. Phase 1 adds the DOM automation ops (snapshot/click/fill/
// find/wait/...) once browserAutomation.ts is ported to a content script; the
// message envelope does not change.

export type ExtCommand =
  | { op: 'info' }
  | { op: 'text' }
  | { op: 'html' }
  | { op: 'eval'; js: string }
  | { op: 'navigate'; url: string }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'reload' }
  | { op: 'screenshot'; fullPage?: boolean }
  | { op: 'release' };

export type ExtOp = ExtCommand['op'];

/**
 * Ops that can change the page, the browser, or act as the user. Allowed only
 * when BOTH gates are open: `agentChromeWrite` in SplitGrid settings and the
 * extension-side per-tab `writable` switch. Enforced on both ends on purpose —
 * neither side trusts the other to have checked.
 *
 * `eval` counts as a write: it is arbitrary JS in a page carrying the user's
 * real session, so it can click, submit and exfiltrate regardless of intent.
 * Read-only mode therefore keeps info/text/html/screenshot, which is enough to
 * inspect and verify, and nothing that acts.
 *
 * `release` is de-escalation (hand the tab back), so it is always allowed.
 */
export const EXT_WRITE_OPS: readonly ExtOp[] = ['eval', 'navigate', 'back', 'forward', 'reload'];

export function isWriteOp(op: ExtOp): boolean {
  return EXT_WRITE_OPS.includes(op);
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type DesktopToExt =
  | { t: 'pair-ok'; token: string; device: string }
  | { t: 'pair-fail'; reason: string }
  | { t: 'ready'; device: string }
  | { t: 'cmd'; reqId: string; tabId: number; command: ExtCommand }
  | { t: 'ping' };

export type ExtToDesktop =
  | { t: 'pair'; protocol: number; code: string; identity: ExtIdentity }
  | { t: 'hello'; protocol: number; token: string; identity: ExtIdentity }
  | { t: 'tabs'; tabs: ExtTab[] }
  | { t: 'result'; reqId: string; ok: boolean; data?: Record<string, unknown>; error?: string }
  | { t: 'pong' };

// ─── Result payload conventions ──────────────────────────────────────────────
// `screenshot` returns { pngBase64 }; the desktop spills it to a temp PNG and
// hands the agent a path, exactly like the <webview> surface does today. Every
// other op returns plain JSON-serializable fields (url/title/text/html/result).

/** Error codes the extension side may return, so both ends agree on spelling. */
export const EXT_ERRORS = {
  noExtension: 'no_extension',
  unknownTab: 'unknown_tab',
  notActivated: 'tab_not_activated',
  originRevoked: 'origin_revoked',
  writeDenied: 'write_denied',
  debuggerBusy: 'debugger_busy',
  restrictedUrl: 'restricted_url',
  timeout: 'ext_timeout',
} as const;

// ─── Surface ids ─────────────────────────────────────────────────────────────
// A browser surface an agent can target is either an existing <webview> pane
// (container id, unchanged) or a browser tab: `tab:<clientId>.<tabId>`, e.g.
// `tab:c1.842`. When exactly one extension is connected, the bare `tab:<tabId>`
// form is accepted too, so the common case stays typeable.

export const EXT_SURFACE_PREFIX = 'tab:';

export function formatExtSurface(clientId: string, tabId: number): string {
  return `${EXT_SURFACE_PREFIX}${clientId}.${tabId}`;
}

export function isExtSurface(surface: string): boolean {
  return surface.startsWith(EXT_SURFACE_PREFIX);
}

/**
 * Parse a tab surface id. Returns null when it isn't one, or when the tab part
 * isn't a positive integer. `clientId` is null for the bare `tab:<tabId>` form,
 * which the caller resolves against the single connected client (and rejects as
 * ambiguous when several are connected).
 */
export function parseExtSurface(surface: string): { clientId: string | null; tabId: number } | null {
  if (!isExtSurface(surface)) return null;
  const rest = surface.slice(EXT_SURFACE_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  const clientId = dot === -1 ? null : rest.slice(0, dot);
  const tabPart = dot === -1 ? rest : rest.slice(dot + 1);
  if (!/^\d+$/.test(tabPart)) return null;
  if (clientId !== null && !/^c\d+$/.test(clientId)) return null;
  return { clientId, tabId: Number(tabPart) };
}

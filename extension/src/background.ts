// ─── Service worker: the SplitGrid channel ───────────────────────────────────
// Holds the WebSocket to the desktop app, owns the activated-tab registry's
// listeners, and dispatches commands to the executor.
//
// MV3 lifetime is the constraint that shapes this file. The worker is torn down
// after ~30s idle and restarted by any event, so:
//   * no state lives only in memory — see state.ts;
//   * this module's top level IS the "on wake" hook, hence the bare boot() call
//     at the bottom;
//   * an open WebSocket keeps the worker alive (the desktop pings every
//     EXT_HEARTBEAT_MS = 20s, comfortably under the 30s budget), but once the
//     socket is gone nothing keeps us alive to reconnect — so a chrome.alarms
//     timer (30s is the platform minimum) is the only thing that can resurrect
//     the channel. setTimeout backoff handles the fast retries while we are
//     awake; the alarm is the floor under it.

import type { DesktopToExt, ExtCommand, ExtIdentity, ExtToDesktop } from '../../src/shared/ext-protocol';
import {
  EXT_ERRORS,
  EXT_PROTOCOL_VERSION,
  EXT_WS_PATH,
  isWriteOp,
} from '../../src/shared/ext-protocol';
import type { ActionReply, ConnectionState, PopupRequest, StatusReply } from './messages';
import { ExecError, detach, execute } from './executor';
import { pulseIndicator, removeIndicator, syncIndicators } from './indicator';
import {
  activate,
  clearPairing,
  deactivate,
  dropPermissionIfUnused,
  getActivated,
  getPairing,
  getPendingCode,
  listActivated,
  onRegistryChange,
  pruneUngranted,
  revokeIfOriginChanged,
  setPairing,
  setPendingCode,
  setWritable,
  updateMeta,
} from './state';
import { isControllableUrl, isRestrictedUrl, originOf } from './urls';

// The loopback agent-activity receiver (see src/main/agent-activity-receiver.ts,
// RECEIVER_PORT). Hardcoded rather than imported: that module pulls in Electron.
const RECEIVER_PORT = 19558;
const WS_URL = `ws://127.0.0.1:${RECEIVER_PORT}${EXT_WS_PATH}`;

const RECONNECT_ALARM = 'splitgrid-reconnect';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

let socket: WebSocket | null = null;
let connection: ConnectionState = 'disconnected';
let device: string | null = null;
let lastError: string | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let booted = false;

// ─── Identity ────────────────────────────────────────────────────────────────

/** Chromium forks all claim "Chrome/<v>"; the fork token wins when present. */
function detectBrowser(): string {
  const ua = navigator.userAgent;
  const brands: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Vivaldi\/(\d+)/, 'Vivaldi'],
    [/Chrome\/(\d+)/, 'Chrome'],
  ];
  for (const [re, name] of brands) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return 'Browser';
}

function identity(): ExtIdentity {
  return {
    extensionId: chrome.runtime.id,
    browser: detectBrowser(),
    version: chrome.runtime.getManifest().version,
  };
}

// ─── Socket ──────────────────────────────────────────────────────────────────

function send(msg: ExtToDesktop): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

  const { token } = await getPairing();
  const code = await getPendingCode();
  // Unpaired and no code in hand: there is nothing we could say on the socket,
  // and dialling anyway would just log a connection error every 30s.
  if (!token && !code) {
    connection = 'unpaired';
    return;
  }

  connection = 'connecting';
  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    lastError = messageOf(err);
    connection = 'disconnected';
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    attempt = 0;
    if (token) send({ t: 'hello', protocol: EXT_PROTOCOL_VERSION, token, identity: identity() });
    else if (code) send({ t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identity() });
  };

  ws.onmessage = (ev) => {
    void onFrame(ev.data);
  };

  ws.onerror = () => {
    // The event carries no detail by design; onclose follows and does the work.
    lastError = 'socket error';
  };

  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      connection = 'disconnected';
      device = null;
    }
    // A tab nobody can drive must not keep claiming it is under agent control.
    queueIndicatorSync();
    scheduleReconnect();
  };
}

/** Exponential backoff with ±30% jitter so a restarted desktop is not hit by
 *  every browser profile at the same instant. */
function scheduleReconnect(): void {
  if (retryTimer !== null) return;
  const flat = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(1.8, attempt));
  const delay = Math.round(flat * (0.7 + Math.random() * 0.6));
  attempt = Math.min(attempt + 1, 20);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

async function onFrame(raw: unknown): Promise<void> {
  if (typeof raw !== 'string') return;
  let msg: DesktopToExt;
  try {
    msg = JSON.parse(raw) as DesktopToExt;
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'ping':
      // Replying is also what keeps the worker alive: WS traffic resets the
      // MV3 idle timer.
      send({ t: 'pong' });
      break;

    case 'ready':
      connection = 'connected';
      device = msg.device;
      lastError = null;
      await pushTabs();
      queueIndicatorSync();
      break;

    case 'pair-ok':
      await setPairing(msg.token, msg.device);
      await setPendingCode(null);
      connection = 'connected';
      device = msg.device;
      lastError = null;
      await pushTabs();
      queueIndicatorSync();
      break;

    case 'pair-fail':
      // Drop the code so connect() stops dialling: with no token and no code it
      // returns early, and the popup is the only thing that can restart pairing.
      await setPendingCode(null);
      lastError = msg.reason || 'pairing rejected';
      connection = 'unpaired';
      socket?.close();
      break;

    case 'cmd':
      await handleCommand(msg.reqId, msg.tabId, msg.command);
      break;
  }
}

// ─── Tab registry → desktop ──────────────────────────────────────────────────

let pushQueued = false;

async function pushTabs(): Promise<void> {
  send({ t: 'tabs', tabs: await listActivated() });
}

// Several listeners can fire for one user action (activate → title → status);
// collapse them into a single frame.
function queuePush(): void {
  if (pushQueued) return;
  pushQueued = true;
  setTimeout(() => {
    pushQueued = false;
    void pushTabs();
  }, 0);
}

// ─── Tab registry → the in-page control frame ────────────────────────────────

let syncQueued = false;
const forcedRepaints = new Set<number>();

/**
 * The single entry point for the indicator. Anything that can change whether a
 * tab is really drivable — a registry mutation, the socket opening or dropping,
 * a navigation that wiped the frame — calls this and lets `syncIndicators` work
 * out what to add, remove or update.
 */
function queueIndicatorSync(repaintTabId?: number): void {
  if (repaintTabId !== undefined) forcedRepaints.add(repaintTabId);
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false;
    const force = [...forcedRepaints];
    forcedRepaints.clear();
    void listActivated().then((tabs) => syncIndicators(tabs, connection === 'connected', force));
  }, 0);
}

onRegistryChange(() => {
  queuePush();
  queueIndicatorSync();
});

// ─── Command dispatch ────────────────────────────────────────────────────────

async function handleCommand(reqId: string, tabId: number, command: ExtCommand): Promise<void> {
  try {
    const data = await runCommand(tabId, command);
    // Flash the frame so the user sees WHEN the agent acted, not only that it
    // could. `release` is exempt: the frame is on its way out.
    if (command.op !== 'release') pulseIndicator(tabId);
    send({ t: 'result', reqId, ok: true, data });
  } catch (err) {
    send({ t: 'result', reqId, ok: false, error: err instanceof ExecError ? err.code : messageOf(err) });
  }
}

/**
 * Re-check every gate on THIS side before touching the page. The desktop checks
 * its own copy of the rules first; neither end trusts the other to have done it,
 * because a compromised desktop process and a stale extension registry are
 * different failure modes and only one of them is ours to contain.
 */
async function runCommand(tabId: number, command: ExtCommand): Promise<Record<string, unknown>> {
  // `release` is de-escalation — always allowed, even for a tab whose origin
  // check would now fail, so the user/agent can always hand a tab back.
  if (command.op === 'release') return execute(tabId, command);

  const entry = await getActivated(tabId);
  if (!entry) throw new ExecError(EXT_ERRORS.notActivated);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await deactivate(tabId);
    throw new ExecError(EXT_ERRORS.unknownTab);
  }

  const url = tab.url ?? '';
  if (originOf(url) !== entry.origin) {
    await deactivate(tabId);
    throw new ExecError(EXT_ERRORS.originRevoked);
  }
  if (isRestrictedUrl(url)) {
    await deactivate(tabId);
    throw new ExecError(EXT_ERRORS.restrictedUrl);
  }
  // The user can revoke the host grant from chrome://extensions at any moment
  // without any event reaching us first, so ask the platform, not our cache.
  if (!(await chrome.permissions.contains({ origins: [patternFor(url)] }))) {
    await deactivate(tabId);
    throw new ExecError(EXT_ERRORS.originRevoked);
  }
  if (isWriteOp(command.op) && !entry.writable) throw new ExecError(EXT_ERRORS.writeDenied);

  return execute(tabId, command);
}

function patternFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

// ─── Browser events ──────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void (async () => {
    if (!(await getActivated(tabId))) return;
    // REVOCATION: a cross-origin navigation ends agent control until the user
    // re-activates. Checked on every update, not only on `changeInfo.url`, so a
    // redirect that only surfaces at `complete` is caught too.
    if (await revokeIfOriginChanged(tabId, tab.url ?? '')) return;
    if (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.status === 'complete') {
      await updateMeta(tabId, { title: tab.title, url: tab.url });
    }
    // A navigation, a reload and an SPA history entry all reach us here, and the
    // first two wipe the frame with the document — repaint on both `loading`
    // (mark it as early as possible) and `complete` (the document that stuck).
    if (changeInfo.status !== undefined || changeInfo.url !== undefined) queueIndicatorSync(tabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const entry = await getActivated(tabId);
    await detach(tabId);
    if (entry) await deactivate(tabId);
  })();
});

// A prerendered page taking over gives the tab a NEW id; the old grant does not
// follow it, so drop it and make the user re-activate.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void (async () => {
    await detach(removedTabId);
    await deactivate(removedTabId);
    await deactivate(addedTabId);
  })();
});

// The user pulled a host grant from chrome://extensions.
chrome.permissions.onRemoved.addListener(() => {
  void pruneUngranted();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  void connect();
});

chrome.runtime.onStartup.addListener(() => {
  void boot();
});

chrome.runtime.onInstalled.addListener(() => {
  void boot();
});

// ─── Popup bridge ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const req = raw as PopupRequest;
  if (!req || typeof req.k !== 'string') return false;
  void handlePopup(req).then(sendResponse);
  return true; // keep the channel open for the async reply
});

async function handlePopup(req: PopupRequest): Promise<StatusReply | ActionReply> {
  switch (req.k) {
    case 'status':
      // Opening the popup is also the user's implicit "try again".
      void connect();
      return { connection, device, lastError, tabs: await listActivated() };

    case 'pair': {
      const code = req.code.trim();
      if (!code) return { ok: false, error: 'empty code' };
      await setPendingCode(code);
      lastError = null;
      socket?.close();
      socket = null;
      attempt = 0;
      await connect();
      return { ok: true };
    }

    case 'unpair':
      await clearPairing();
      await setPendingCode(null);
      device = null;
      connection = 'unpaired';
      socket?.close();
      socket = null;
      queueIndicatorSync();
      return { ok: true };

    case 'activate': {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(req.tabId);
      } catch {
        return { ok: false, error: EXT_ERRORS.unknownTab };
      }
      const url = tab.url ?? '';
      if (!isControllableUrl(url)) return { ok: false, error: EXT_ERRORS.restrictedUrl };
      // The popup requested the grant under a user gesture; verify it landed
      // rather than trusting its word for it.
      if (!(await chrome.permissions.contains({ origins: [patternFor(url)] }))) {
        return { ok: false, error: EXT_ERRORS.originRevoked };
      }
      return { ok: (await activate(tab)) !== null };
    }

    case 'deactivate': {
      const entry = await getActivated(req.tabId);
      await detach(req.tabId);
      const ok = await deactivate(req.tabId);
      // Ahead of dropPermissionIfUnused: scripting the tab to remove the frame
      // needs the host permission we are about to give back.
      await removeIndicator(req.tabId);
      if (entry) await dropPermissionIfUnused(entry.url);
      return { ok };
    }

    case 'setWritable':
      return { ok: await setWritable(req.tabId, req.writable) };
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

/**
 * Runs on every worker wake, not just install. Re-derives the activated set from
 * the live browser before anyone can act on it: while we were evicted a tab may
 * have closed, navigated away, or had its permission revoked, and none of those
 * events reached us.
 */
async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  // 0.5 min is the platform minimum; anything shorter is silently clamped.
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  await reconcile();
  await connect();
}

async function reconcile(): Promise<void> {
  for (const entry of await listActivated()) {
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(entry.tabId);
    } catch {
      tab = null;
    }
    if (!tab) {
      await deactivate(entry.tabId);
      continue;
    }
    if (await revokeIfOriginChanged(entry.tabId, tab.url ?? '')) continue;
    await updateMeta(entry.tabId, { title: tab.title, url: tab.url });
  }
  await pruneUngranted();
  // Eviction froze the frames as they were: a tab may have lost its activation
  // while we were gone (stale frame), or kept it through a reload (no frame).
  // Repaint everything that survived and strip everything that did not.
  const survivors = await listActivated();
  await syncIndicators(
    survivors,
    connection === 'connected',
    survivors.map((t) => t.tabId),
  );
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

void boot();

// ─── Activated-tab registry + pairing store ──────────────────────────────────
// An MV3 service worker is evicted after ~30s idle and restarted from scratch,
// so NOTHING here may live only in memory: the activated set is persisted to
// `chrome.storage.session` (cleared when the browser closes — an activation is
// not meant to outlive the session) and the pairing token to
// `chrome.storage.local` (never `sync`: the token is per-machine and must never
// travel to the user's other browsers).
//
// The service worker is the only writer; the popup mutates through runtime
// messages. That keeps the module-level cache authoritative without locking.

import type { ExtTab } from '../../src/shared/ext-protocol';
import { originOf, permissionPatternFor } from './urls';

const SESSION_TABS_KEY = 'activatedTabs';
const LOCAL_TOKEN_KEY = 'pairToken';
const LOCAL_DEVICE_KEY = 'pairDevice';
const SESSION_CODE_KEY = 'pendingPairCode';

let cache: Map<number, ExtTab> | null = null;
const changeListeners = new Set<() => void>();

/** Fired after any mutation so the socket layer can push a fresh `tabs` frame. */
export function onRegistryChange(fn: () => void): void {
  changeListeners.add(fn);
}

function emitChange(): void {
  for (const fn of changeListeners) fn();
}

async function load(): Promise<Map<number, ExtTab>> {
  if (cache) return cache;
  const stored = await chrome.storage.session.get(SESSION_TABS_KEY);
  const raw = stored[SESSION_TABS_KEY] as ExtTab[] | undefined;
  cache = new Map((raw ?? []).map((t) => [t.tabId, t]));
  return cache;
}

async function persist(map: Map<number, ExtTab>): Promise<void> {
  await chrome.storage.session.set({ [SESSION_TABS_KEY]: [...map.values()] });
}

export async function listActivated(): Promise<ExtTab[]> {
  const map = await load();
  return [...map.values()].sort((a, b) => a.activatedAt - b.activatedAt);
}

export async function getActivated(tabId: number): Promise<ExtTab | undefined> {
  return (await load()).get(tabId);
}

/**
 * Record a tab the user just handed over. The caller (popup) has already
 * obtained the host permission through a user gesture — we only record what it
 * was granted for, so the revocation check has something to compare against.
 */
export async function activate(tab: chrome.tabs.Tab): Promise<ExtTab | null> {
  const url = tab.url ?? '';
  const origin = originOf(url);
  if (tab.id === undefined || !origin) return null;
  const map = await load();
  const entry: ExtTab = {
    tabId: tab.id,
    title: tab.title ?? '',
    url,
    origin,
    // Read-only is the default posture: the user opts into interaction per tab.
    writable: false,
    activatedAt: Date.now(),
  };
  map.set(tab.id, entry);
  await persist(map);
  emitChange();
  return entry;
}

export async function deactivate(tabId: number): Promise<boolean> {
  const map = await load();
  if (!map.delete(tabId)) return false;
  await persist(map);
  emitChange();
  return true;
}

export async function setWritable(tabId: number, writable: boolean): Promise<boolean> {
  const map = await load();
  const entry = map.get(tabId);
  if (!entry) return false;
  entry.writable = writable;
  await persist(map);
  emitChange();
  return true;
}

/** Keep the pushed tab list honest about title/URL without changing the grant. */
export async function updateMeta(tabId: number, patch: { title?: string; url?: string }): Promise<boolean> {
  const map = await load();
  const entry = map.get(tabId);
  if (!entry) return false;
  const nextTitle = patch.title ?? entry.title;
  const nextUrl = patch.url ?? entry.url;
  if (nextTitle === entry.title && nextUrl === entry.url) return false;
  entry.title = nextTitle;
  entry.url = nextUrl;
  await persist(map);
  emitChange();
  return true;
}

/**
 * THE revocation rule. A tab keeps agent control only while it is still on the
 * exact origin the user granted — a redirect or a click that lands on another
 * origin ends control until the user re-activates. This is what stops an agent
 * from following a link off localhost and into the user's mail.
 */
export async function revokeIfOriginChanged(tabId: number, url: string): Promise<boolean> {
  const entry = await getActivated(tabId);
  if (!entry) return false;
  if (originOf(url) === entry.origin) return false;
  await deactivate(tabId);
  return true;
}

/**
 * Drop every activated tab whose host permission is gone (the user revoked it
 * from chrome://extensions, or another tab's release removed the shared grant).
 */
export async function pruneUngranted(): Promise<number> {
  let dropped = 0;
  for (const entry of await listActivated()) {
    if (!(await hasPermissionFor(entry.url))) {
      await deactivate(entry.tabId);
      dropped++;
    }
  }
  return dropped;
}

export async function hasPermissionFor(url: string): Promise<boolean> {
  const pattern = permissionPatternFor(url);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

/**
 * Give back the host grant, but only once no other activated tab still needs
 * it — several tabs on the same host share a single match pattern.
 */
export async function dropPermissionIfUnused(url: string): Promise<void> {
  const pattern = permissionPatternFor(url);
  if (!pattern) return;
  const stillUsed = (await listActivated()).some((t) => permissionPatternFor(t.url) === pattern);
  if (stillUsed) return;
  await chrome.permissions.remove({ origins: [pattern] });
}

// ─── Pairing store ───────────────────────────────────────────────────────────

export interface Pairing {
  token: string | null;
  device: string | null;
}

export async function getPairing(): Promise<Pairing> {
  const stored = await chrome.storage.local.get([LOCAL_TOKEN_KEY, LOCAL_DEVICE_KEY]);
  return {
    token: (stored[LOCAL_TOKEN_KEY] as string | undefined) ?? null,
    device: (stored[LOCAL_DEVICE_KEY] as string | undefined) ?? null,
  };
}

export async function setPairing(token: string, device: string): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_TOKEN_KEY]: token, [LOCAL_DEVICE_KEY]: device });
}

export async function clearPairing(): Promise<void> {
  await chrome.storage.local.remove([LOCAL_TOKEN_KEY, LOCAL_DEVICE_KEY]);
}

/**
 * The one-time code the user typed sits in session storage, not memory: the
 * worker can be evicted between the popup click and the socket handshake.
 */
export async function getPendingCode(): Promise<string | null> {
  const stored = await chrome.storage.session.get(SESSION_CODE_KEY);
  return (stored[SESSION_CODE_KEY] as string | undefined) ?? null;
}

export async function setPendingCode(code: string | null): Promise<void> {
  if (code === null) await chrome.storage.session.remove(SESSION_CODE_KEY);
  else await chrome.storage.session.set({ [SESSION_CODE_KEY]: code });
}

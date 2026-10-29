// ─── Popup: the user's control surface ───────────────────────────────────────
// The only place an activation can start. Everything that changes state goes
// through the service worker EXCEPT chrome.permissions.request(), which Chrome
// only honours inside a user gesture — so it has to be called synchronously
// from the click handler, on a URL the popup already had in hand. Awaiting
// anything before it (a tabs.query, a status round-trip) loses the gesture and
// Chrome rejects the request.

import type { ExtTab } from '../../src/shared/ext-protocol';
import type { ActionReply, PopupRequest, StatusReply } from './messages';
import { hostLabel, isControllableUrl, permissionPatternFor } from './urls';

const POLL_MS = 1_000;

const el = {
  status: byId<HTMLSpanElement>('status'),
  error: byId<HTMLParagraphElement>('error'),
  pairing: byId<HTMLElement>('pairing'),
  pairForm: byId<HTMLFormElement>('pair-form'),
  pairCode: byId<HTMLInputElement>('pair-code'),
  paired: byId<HTMLElement>('paired'),
  device: byId<HTMLSpanElement>('device'),
  unpair: byId<HTMLButtonElement>('unpair'),
  activeSection: byId<HTMLElement>('active-section'),
  activeList: byId<HTMLUListElement>('active-list'),
  tabList: byId<HTMLUListElement>('tab-list'),
  tabEmpty: byId<HTMLParagraphElement>('tab-empty'),
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function ask<T extends ActionReply | StatusReply>(req: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>;
}

// ─── Render ──────────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<StatusReply['connection'], [string, string]> = {
  connected: ['paired', 'pill--on'],
  connecting: ['connecting', 'pill--wait'],
  disconnected: ['disconnected', 'pill--off'],
  unpaired: ['not paired', 'pill--off'],
};

let localError: string | null = null;

async function refresh(): Promise<void> {
  const status = await ask<StatusReply>({ k: 'status' });
  const [label, cls] = STATUS_TEXT[status.connection];
  el.status.textContent = label;
  el.status.className = `pill ${cls}`;

  const problem = localError ?? status.lastError;
  el.error.textContent = problem ?? '';
  el.error.hidden = !problem;

  const paired = status.connection !== 'unpaired';
  el.pairing.hidden = paired;
  el.paired.hidden = !paired;
  el.device.textContent = status.device ? `paired with ${status.device}` : 'paired';

  renderActive(status.tabs);
  await renderTabs(new Set(status.tabs.map((t) => t.tabId)));
}

// The 1 s poll must not rebuild the DOM under the user's cursor — a checkbox
// replaced mid-click loses the click. Rebuild only when something changed.
let activeSig = '';
let tabSig = '';

function renderActive(tabs: ExtTab[]): void {
  const sig = tabs.map((t) => `${t.tabId}|${t.writable}|${t.title}|${t.origin}`).join('\n');
  el.activeSection.hidden = tabs.length === 0;
  if (sig === activeSig) return;
  activeSig = sig;
  el.activeList.replaceChildren(...tabs.map(activeItem));
}

function activeItem(tab: ExtTab): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'item item--active';

  const row = document.createElement('div');
  row.className = 'item__row';

  const text = document.createElement('div');
  text.className = 'item__text';
  const title = document.createElement('div');
  title.className = 'item__title';
  title.textContent = tab.title || tab.url;
  const host = document.createElement('div');
  host.className = 'item__host';
  host.textContent = tab.origin;
  text.append(title, host);

  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'btn btn--danger';
  off.textContent = 'Deactivate';
  off.addEventListener('click', () => {
    void act({ k: 'deactivate', tabId: tab.tabId });
  });

  row.append(text, off);

  // The write gate. OFF is the default and the safe posture: without it the
  // agent can look (info/text/html/screenshot) but cannot act.
  const write = document.createElement('label');
  write.className = 'write';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = tab.writable;
  box.addEventListener('change', () => {
    void act({ k: 'setWritable', tabId: tab.tabId, writable: box.checked });
  });
  const caption = document.createElement('span');
  caption.textContent = 'Allow interaction';
  const note = document.createElement('span');
  note.className = 'write__note';
  note.textContent = tab.writable ? 'click, type, navigate, run JS' : 'read-only';
  write.append(box, caption, note);

  li.append(row, write);
  return li;
}

async function renderTabs(activated: Set<number>): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(
    (t) => t.id !== undefined && !activated.has(t.id) && isControllableUrl(t.url ?? ''),
  );
  el.tabEmpty.hidden = candidates.length > 0;
  const sig = candidates.map((t) => `${t.id}|${t.title}|${t.url}`).join('\n');
  if (sig === tabSig) return;
  tabSig = sig;
  el.tabList.replaceChildren(...candidates.map(tabItem));
}

function tabItem(tab: chrome.tabs.Tab): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'item';

  const text = document.createElement('div');
  text.className = 'item__text';
  const title = document.createElement('div');
  title.className = 'item__title';
  title.textContent = tab.title || tab.url || '';
  const host = document.createElement('div');
  host.className = 'item__host';
  host.textContent = hostLabel(tab.url ?? '');
  text.append(title, host);

  const on = document.createElement('button');
  on.type = 'button';
  on.className = 'btn';
  on.textContent = 'Activate';
  on.addEventListener('click', () => {
    void activateTab(tab, on);
  });

  li.append(text, on);
  return li;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Least privilege in one function: ask Chrome for THIS tab's host and nothing
 * else, and only once the user has clicked. The extension ships with no host
 * permissions at all, so until this runs it cannot read a single page.
 */
async function activateTab(tab: chrome.tabs.Tab, button: HTMLButtonElement): Promise<void> {
  const pattern = permissionPatternFor(tab.url ?? '');
  if (tab.id === undefined || !pattern) {
    localError = 'This page cannot be handed to an agent.';
    await refresh();
    return;
  }
  button.disabled = true;
  try {
    // Must be the first await in the gesture — see the file header.
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      localError = `Permission for ${pattern} was declined.`;
      return;
    }
    const reply = await ask<ActionReply>({ k: 'activate', tabId: tab.id });
    localError = reply.ok ? null : (reply.error ?? 'Could not activate this tab.');
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

async function act(req: PopupRequest): Promise<void> {
  const reply = await ask<ActionReply>(req);
  localError = reply.ok ? null : (reply.error ?? 'Action failed.');
  await refresh();
}

el.pairForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const code = el.pairCode.value.trim();
  if (!code) return;
  void (async () => {
    localError = null;
    await act({ k: 'pair', code });
    el.pairCode.value = '';
  })();
});

el.unpair.addEventListener('click', () => {
  void act({ k: 'unpair' });
});

// Poll rather than subscribe: the service worker may be evicted between opens,
// and a 1s poll from a popup that only exists while open costs nothing.
void refresh();
setInterval(() => void refresh(), POLL_MS);

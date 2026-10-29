// ─── Command executor ────────────────────────────────────────────────────────
// Runs one `ExtCommand` against one already-authorised tab. Authorisation
// (activated? origin unchanged? permission held? write allowed?) is the caller's
// job — see `background.ts` — so this file stays a straight op → Chrome-API map.
//
// Every op returns a plain JSON-serialisable record using the field names the
// protocol documents (url/title/text/html/result/pngBase64), or throws
// `ExecError` carrying an `EXT_ERRORS` code.
//
// PHASE 1: the DOM-automation ops (snapshot/click/fill/find/wait) currently
// living in src/renderer/components/browserAutomation.ts land here as extra
// cases. They will not use `world: 'MAIN'` string injection but a real content
// script (declared dynamically via chrome.scripting.registerContentScripts on
// the granted origin) messaged with chrome.tabs.sendMessage — the ref registry
// those scripts maintain must survive between commands, which a one-shot
// executeScript cannot do. Keep new ops additive here; the envelope is fixed.

import type { ExtCommand } from '../../src/shared/ext-protocol';
import { EXT_ERRORS } from '../../src/shared/ext-protocol';
import { removeIndicator, setIndicatorHidden } from './indicator';
import { isRestrictedUrl } from './urls';
import { deactivate, dropPermissionIfUnused, getActivated } from './state';

/** An error whose message is one of the EXT_ERRORS codes both ends agree on. */
export class ExecError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ExecError';
  }
}

/** Page text/HTML can be unbounded; the socket and the agent's context are not. */
const CONTENT_CAP = 200_000;

/** Chrome refuses to encode a screenshot larger than this on either axis. */
const MAX_CAPTURE_PX = 16_384;

/** How long a navigation/reload may take before we answer with what we have. */
const LOAD_TIMEOUT_MS = 15_000;

export async function execute(tabId: number, command: ExtCommand): Promise<Record<string, unknown>> {
  switch (command.op) {
    case 'info':
      return meta(tabId);

    case 'text': {
      const raw = await injectMain<string>(tabId, () => (document.body ? document.body.innerText : ''));
      const [text, truncated] = capped(raw ?? '');
      return { text, truncated };
    }

    case 'html': {
      const raw = await injectMain<string>(tabId, () => document.documentElement.outerHTML);
      const [html, truncated] = capped(raw ?? '');
      return { html, truncated };
    }

    case 'eval':
      return evaluate(tabId, command.js);

    case 'navigate': {
      const url = command.url;
      if (!/^https?:\/\//i.test(url)) throw new ExecError(EXT_ERRORS.restrictedUrl);
      if (isRestrictedUrl(url)) throw new ExecError(EXT_ERRORS.restrictedUrl);
      await chrome.tabs.update(tabId, { url });
      await waitForLoad(tabId);
      return meta(tabId);
    }

    case 'back':
      await historyStep(tabId, 'back');
      return meta(tabId);

    case 'forward':
      await historyStep(tabId, 'forward');
      return meta(tabId);

    case 'reload':
      await chrome.tabs.reload(tabId);
      await waitForLoad(tabId);
      return meta(tabId);

    case 'screenshot':
      return { pngBase64: await screenshot(tabId, command.fullPage === true) };

    case 'release':
      return release(tabId);
  }
}

// ─── info / navigation ───────────────────────────────────────────────────────

async function meta(tabId: number): Promise<Record<string, unknown>> {
  const tab = await getTab(tabId);
  return { url: tab.url ?? '', title: tab.title ?? '' };
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new ExecError(EXT_ERRORS.unknownTab);
  }
}

async function historyStep(tabId: number, dir: 'back' | 'forward'): Promise<void> {
  try {
    if (dir === 'back') await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (err) {
    // "Cannot find a next/previous page in history" — a dead end, not a failure
    // of the channel. Report it verbatim so the agent can tell them apart.
    throw new ExecError(messageOf(err));
  }
  await waitForLoad(tabId);
}

/** Same-document navigations (a `#hash`) fire no status events at all, so a
 *  poll backs up the listener. It starts late enough not to catch the `complete`
 *  the tab is still reporting from BEFORE the navigation we just triggered. */
const LOAD_POLL_DELAY_MS = 500;
const LOAD_POLL_MS = 250;

/**
 * Resolve once the tab reports `complete`, or after LOAD_TIMEOUT_MS. A timeout
 * is not an error: a page that streams forever should still answer `info`.
 */
function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pollStart);
      if (poll !== null) clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id: number): void => {
      if (id === tabId) finish();
    };
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    let poll: ReturnType<typeof setInterval> | null = null;
    const pollStart = setTimeout(() => {
      poll = setInterval(() => {
        void chrome.tabs
          .get(tabId)
          .then((tab) => {
            if (tab.status === 'complete') finish();
          })
          .catch(finish);
      }, LOAD_POLL_MS);
    }, LOAD_POLL_DELAY_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// ─── scripting ───────────────────────────────────────────────────────────────

function capped(value: string): [string, boolean] {
  if (value.length <= CONTENT_CAP) return [value, false];
  return [value.slice(0, CONTENT_CAP), true];
}

/**
 * `func` is serialised with Function.prototype.toString() and re-parsed in the
 * page, so it must be self-contained: no closure variables, no imports, no
 * TypeScript that needs a downlevel helper (the bundle targets chrome120).
 */
async function injectMain<T>(tabId: number, func: () => T): Promise<T> {
  let results: chrome.scripting.InjectionResult<chrome.scripting.Awaited<T>>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func });
  } catch (err) {
    throw new ExecError(injectionErrorCode(err));
  }
  const first = results[0];
  if (!first) throw new ExecError(EXT_ERRORS.restrictedUrl);
  return first.result as T;
}

/** Chrome's injection failures are strings; map the two we can act on. */
function injectionErrorCode(err: unknown): string {
  const msg = messageOf(err);
  if (/cannot be scripted|chrome:\/\/|extension gallery|showing error page|Web Store/i.test(msg)) {
    return EXT_ERRORS.restrictedUrl;
  }
  if (/Cannot access|must request permission|host permission/i.test(msg)) {
    return EXT_ERRORS.originRevoked;
  }
  return msg;
}

interface EvalOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * `eval` runs in the page's own realm so it sees the real app state. That realm
 * is also where the page's CSP applies: on a site with a strict `script-src`
 * the dynamic compile below is blocked, and the agent gets that CSP error back
 * rather than a silent wrong answer.
 *
 * The `new Function(src)` below is the FEATURE, not an injection bug: `eval` is
 * defined as "run this JS in the page". It is why the protocol classes `eval`
 * as a write op (EXT_WRITE_OPS), so it only ever reaches here with both the
 * desktop write gate and the per-tab `writable` switch open.
 */
async function evaluate(tabId: number, js: string): Promise<Record<string, unknown>> {
  let results: chrome.scripting.InjectionResult<EvalOutcome>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [js],
      func: async (src: string): Promise<EvalOutcome> => {
        let value: unknown;
        try {
          let compiled: () => unknown;
          try {
            // Expression form first, so `1 + 1` and `document.title` return a
            // value the way a console would.
            compiled = new Function(`"use strict"; return (${src});`) as () => unknown;
          } catch {
            // Not an expression — run it as a statement body instead.
            compiled = new Function(`"use strict"; ${src}`) as () => unknown;
          }
          value = await compiled();
        } catch (e) {
          return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
        // Force the value through JSON here, in the page: executeScript can only
        // return structured-cloneable data, and a DOM node would kill the call.
        try {
          const json = JSON.stringify(value);
          return { ok: true, value: json === undefined ? null : JSON.parse(json) };
        } catch {
          return { ok: true, value: String(value) };
        }
      },
    });
  } catch (err) {
    throw new ExecError(injectionErrorCode(err));
  }
  const outcome = results[0]?.result;
  if (!outcome) throw new ExecError(EXT_ERRORS.restrictedUrl);
  if (!outcome.ok) throw new ExecError(outcome.error ?? 'eval_failed');
  return { result: outcome.value ?? null };
}

// ─── screenshot (CDP) ────────────────────────────────────────────────────────
// captureVisibleTab would need no debugger, but it only ever captures the
// ACTIVE tab of a focused window — useless for a background tab an agent drives
// while the user works elsewhere. So we attach the debugger for the length of
// one capture and detach immediately: the "started debugging this browser"
// infobar should not outlive the command.

const attached = new Set<number>();

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
}

async function screenshot(tabId: number, fullPage: boolean): Promise<string> {
  const tab = await getTab(tabId);
  if (isRestrictedUrl(tab.url ?? '')) throw new ExecError(EXT_ERRORS.restrictedUrl);

  // The control frame is for the human, not for the agent: hide it for the
  // capture so the returned PNG shows the page as the user sees it. Restored in
  // the `finally` below, so a capture that throws cannot leave a tab that is
  // still under control looking unmarked.
  await setIndicatorHidden(tabId, true);
  const target: chrome.debugger.Debuggee = { tabId };
  try {
    // Inside the try so a failed attach still restores the frame below.
    await attach(tabId);
    const params: Record<string, unknown> = { format: 'png', captureBeyondViewport: fullPage };
    if (fullPage) {
      // captureBeyondViewport needs an explicit clip to know how far "beyond"
      // reaches; without it Chrome still stops at the viewport on some versions.
      await cdp(target, 'Page.enable');
      const metrics = await cdp<LayoutMetrics>(target, 'Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        params.clip = {
          x: 0,
          y: 0,
          width: Math.min(Math.max(Math.ceil(size.width), 1), MAX_CAPTURE_PX),
          height: Math.min(Math.max(Math.ceil(size.height), 1), MAX_CAPTURE_PX),
          scale: 1,
        };
      }
    }
    const shot = await cdp<{ data: string }>(target, 'Page.captureScreenshot', params);
    return shot.data;
  } finally {
    await detach(tabId); // idempotent — a no-op when the attach itself failed
    await setIndicatorHidden(tabId, false);
  }
}

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;

  // DevTools (or another extension) owning the tab is the common case and has a
  // clear user-facing fix, so detect it before the attach error muddies it.
  // A debugger attachment outlives the service worker, so "attached" may also
  // be a leftover of OUR own previous session: detaching succeeds only if it
  // was ours, which distinguishes the two without any extra bookkeeping.
  const targets = await chrome.debugger.getTargets();
  if (targets.some((t) => t.tabId === tabId && t.attached)) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      throw new ExecError(EXT_ERRORS.debuggerBusy);
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  } catch (err) {
    const msg = messageOf(err);
    if (/already attached|Another debugger/i.test(msg)) throw new ExecError(EXT_ERRORS.debuggerBusy);
    if (/cannot access|Cannot attach|chrome:\/\//i.test(msg)) throw new ExecError(EXT_ERRORS.restrictedUrl);
    throw new ExecError(msg);
  }
}

/** Idempotent: also the cleanup path for tab close and worker teardown. */
export async function detach(tabId: number): Promise<void> {
  if (!attached.delete(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone (tab closed, DevTools took over) — nothing to clean up */
  }
}

// Chrome detaches us on tab close, navigation to a restricted page, or when the
// user opens DevTools; keep our bookkeeping in step so the next attach retries.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

async function cdp<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const result = await chrome.debugger.sendCommand(target, method, params);
  return (result ?? {}) as T;
}

// ─── release ─────────────────────────────────────────────────────────────────

/** De-escalation: always allowed, even when the origin check would have failed. */
async function release(tabId: number): Promise<Record<string, unknown>> {
  const entry = await getActivated(tabId);
  const wasActivated = await deactivate(tabId);
  await detach(tabId);
  // Before the permission goes back: without it the frame can no longer be
  // removed, and a stranded frame would claim a control nobody holds.
  await removeIndicator(tabId);
  if (entry) await dropPermissionIfUnused(entry.url);
  return { released: wasActivated };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

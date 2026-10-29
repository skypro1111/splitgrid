// ─── "This tab is under agent control" indicator ─────────────────────────────
// Two surfaces, one state: a viewport-edge frame drawn inside the page, and the
// toolbar badge for when the tab is in the background.
//
// The rule this file exists to keep: the frame is on a tab if and only if that
// tab is really drivable right now. Every add/remove/update therefore funnels
// through `syncIndicators`, which diffs "what should be marked" against "what
// we marked", instead of injection calls sprinkled at each call site.
//
// What we marked cannot live in memory: the MV3 worker is evicted while the
// frames stay painted in their tabs, so the record goes to
// `chrome.storage.session` alongside the activated set. On the next wake `boot`
// reconciles both, and a tab that lost its activation while we were gone has
// its frame removed.

import type { ExtTab } from '../../src/shared/ext-protocol';
import type { FrameConfig } from './indicator-inject';
import { applyFrame, pulseFrame, removeFrame, setFrameHidden } from './indicator-inject';
import type { IndicatorLook, IndicatorMode } from './indicator-state';
import { DEFAULT_ACTION_TITLE, desiredIndicators, lookFor } from './indicator-state';

const SESSION_KEY = 'indicatorTabs';

interface Mark {
  mode: IndicatorMode;
  /** False when the injection failed (page still loading, permission gone), so
   *  the next sync retries instead of believing the tab is marked. */
  painted: boolean;
}

let cache: Map<number, Mark> | null = null;

async function loadMarks(): Promise<Map<number, Mark>> {
  if (cache) return cache;
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const raw = stored[SESSION_KEY] as Array<[number, Mark]> | undefined;
  cache = new Map(raw ?? []);
  return cache;
}

async function persistMarks(marks: Map<number, Mark>): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: [...marks.entries()] });
}

// Every sync is a read-modify-write of that record; run them one at a time so
// two events in the same tick cannot interleave and lose one another's writes.
let chain: Promise<void> = Promise.resolve();

function serial(job: () => Promise<void>): Promise<void> {
  const next = chain.then(job, job).catch(() => undefined);
  chain = next;
  return next;
}

/**
 * Bring every tab's frame and badge in line with the registry.
 *
 * `force` re-paints tabs whose document was just replaced (navigation, reload,
 * SPA history) even though their mode did not change — the DOM took the frame
 * with it.
 */
export function syncIndicators(tabs: ExtTab[], connected: boolean, force: number[] = []): Promise<void> {
  return serial(async () => {
    const wanted = desiredIndicators(tabs, connected);
    const marks = await loadMarks();
    let dirty = false;

    for (const tabId of force) {
      const mark = marks.get(tabId);
      if (mark) mark.painted = false;
    }

    // Snapshot the keys: clearing mutates the map underneath us.
    for (const tabId of [...marks.keys()]) {
      if (wanted.has(tabId)) continue;
      await unmark(marks, tabId);
      dirty = true;
    }

    for (const [tabId, mode] of wanted) {
      const mark = marks.get(tabId);
      if (mark && mark.painted && mark.mode === mode) continue;
      const look = lookFor(mode);
      const painted = await inject(tabId, applyFrame, [configOf(look)]);
      await setBadge(tabId, look);
      marks.set(tabId, { mode, painted });
      dirty = true;
    }

    if (dirty) await persistMarks(marks);
  });
}

/**
 * Take a tab's frame down NOW, ahead of the debounced sync.
 *
 * `deactivate` and `release` hand the host permission back in the same breath,
 * and once it is gone we can no longer script the tab to clean up — the frame
 * would be stranded on the page claiming a control nobody has. Those are the
 * only two places allowed to take a frame down outside `syncIndicators`, and
 * this ordering is why.
 */
export function removeIndicator(tabId: number): Promise<void> {
  return serial(async () => {
    const marks = await loadMarks();
    const had = marks.has(tabId);
    await unmark(marks, tabId);
    if (had) await persistMarks(marks);
  });
}

async function unmark(marks: Map<number, Mark>, tabId: number): Promise<void> {
  await inject(tabId, removeFrame, []);
  await clearBadge(tabId);
  marks.delete(tabId);
}

/** A command just ran against this tab — flash the frame. Fire and forget. */
export function pulseIndicator(tabId: number): void {
  void inject(tabId, pulseFrame, []);
}

/**
 * Suppress the frame around a CDP capture. The agent screenshots to verify what
 * the page looks like; a border in every image is noise that would mislead it.
 * Restoring is the caller's `finally` — see executor.ts — so a capture that
 * throws can never leave a controlled tab unmarked.
 */
export async function setIndicatorHidden(tabId: number, hidden: boolean): Promise<void> {
  await inject(tabId, setFrameHidden, [hidden]);
}

function configOf(look: IndicatorLook): FrameConfig {
  return {
    accent: look.accent,
    ink: look.ink,
    borderPx: look.borderPx,
    dashed: look.dashed,
    filledDot: look.filledDot,
    label: look.label,
  };
}

/**
 * Top frame only — the frame marks the viewport, not every iframe in it.
 * Failure is never fatal: a restricted URL, a revoked host permission or a tab
 * that closed mid-flight all land here, and a tab we cannot script is a tab
 * nobody can control either.
 */
async function inject<A extends unknown[]>(
  tabId: number,
  func: (...args: A) => void,
  args: A,
): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return true;
  } catch {
    return false;
  }
}

async function setBadge(tabId: number, look: IndicatorLook): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: look.badgeText });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: look.badgeColor });
    await chrome.action.setBadgeTextColor({ tabId, color: look.ink });
    await chrome.action.setTitle({ tabId, title: look.title });
  } catch {
    /* tab closed between the registry read and here */
  }
}

async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
  } catch {
    /* tab closed — the per-tab badge went with it */
  }
}

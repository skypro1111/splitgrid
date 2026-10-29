import type { ExtCommand } from '../shared/ext-protocol';
import { parseArgv } from '../shared/browser-argv';

// ─── argv → tab command (pure) ───────────────────────────────────────────────
// A browser tab (`--target tab:c1.842`, driven through the companion extension)
// is just another surface for the SAME CLI: the argv vocabulary, the skill and
// the helper binary do not change. This module is the translation layer — it
// maps the CLI's argv onto the phase-0 ExtCommand vocabulary and, crucially,
// says NO loudly for everything the extension can't do yet, so an agent gets an
// actionable error instead of a command that silently does nothing.
//
// Kept free of electron/node so it can be unit-tested directly.

export type TabRoute =
  /** Surface-independent (list/help/clipboard) — still answered by the renderer. */
  | { kind: 'renderer' }
  | { kind: 'command'; command: ExtCommand; infoField?: 'url' | 'title'; extra?: Record<string, unknown> }
  | { kind: 'error'; error: string; message: string };

/** Commands that mean the same thing whichever surface is targeted, so a tab
 *  target must not steal them from the renderer (`list` also merges tabs in). */
const SURFACE_INDEPENDENT = new Set(['', 'list', 'help', '--help', '-h', 'clipboard']);

export const NOT_SUPPORTED_ON_TAB = 'not_supported_on_tab';

function unsupported(name: string): TabRoute {
  return {
    kind: 'error',
    error: NOT_SUPPORTED_ON_TAB,
    message: `"${name}" is not available on a browser tab yet (phase 1); it works on a SplitGrid browser pane.`,
  };
}

/**
 * Decide what a `--target tab:…` command becomes. Returns the ExtCommand to run,
 * a usage error, or 'renderer' for the commands a tab target doesn't change.
 */
export function routeTabCommand(argv: string[]): TabRoute {
  const { positional, full } = parseArgv(argv);
  const cmd = (positional[0] || '').toLowerCase();
  const rest = positional.slice(1);

  if (SURFACE_INDEPENDENT.has(cmd)) return { kind: 'renderer' };

  switch (cmd) {
    case 'open': case 'navigate': case 'goto': {
      const url = rest[0];
      if (!url) return { kind: 'error', error: 'missing_url', message: `usage: ${cmd} <url>` };
      // Echo the url back the way the pane path does, so the reply shape matches.
      return { kind: 'command', command: { op: 'navigate', url }, extra: { url } };
    }
    case 'back': return { kind: 'command', command: { op: 'back' } };
    case 'forward': return { kind: 'command', command: { op: 'forward' } };
    case 'reload': return { kind: 'command', command: { op: 'reload' } };

    case 'get': {
      const what = (rest[0] || '').toLowerCase();
      const sel = rest[1];
      // Element-scoped reads (`get text #app`) need the DOM automation script,
      // which is pane-only until the content script lands.
      if (sel && (what === 'text' || what === 'html')) return unsupported(`get ${what} <selector>`);
      switch (what) {
        case 'url': return { kind: 'command', command: { op: 'info' }, infoField: 'url' };
        case 'title': return { kind: 'command', command: { op: 'info' }, infoField: 'title' };
        case 'text': return { kind: 'command', command: { op: 'text' } };
        case 'html': return { kind: 'command', command: { op: 'html' } };
        case '': return { kind: 'error', error: 'unknown_get', message: 'on a browser tab: get url|title|text|html' };
        default: return unsupported(`get ${what}`);
      }
    }

    case 'eval': {
      const js = rest.join(' ');
      if (!js) return { kind: 'error', error: 'missing_js', message: 'usage: eval <js>' };
      return { kind: 'command', command: { op: 'eval', js } };
    }

    case 'screenshot':
      return { kind: 'command', command: { op: 'screenshot', ...(full ? { fullPage: true } : {}) } };

    // `close` on a tab means "hand it back to the user", not "destroy the tab".
    case 'close': case 'quit': {
      if ((rest[0] || '').toLowerCase() === 'all') return unsupported('close all');
      return { kind: 'command', command: { op: 'release' }, extra: { closed: true } };
    }

    default:
      return unsupported(cmd);
  }
}

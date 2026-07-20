import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// SplitGrid manages a single delimited block inside ~/.tmux.conf and ~/.screenrc
// so the mouse-scroll setting can be toggled on/off without ever touching the
// rest of the user's config. With it enabled the mouse wheel scrolls the
// multiplexer (terminals already forward wheel events once the multiplexer plays
// along); the trade-off is that text selection then goes through tmux/screen
// rather than the host terminal — hold Shift while dragging for native selection.
//
// Two delivery paths share the string logic below:
//   - LOCAL  (applyTerminalMouseConfig)  → node:fs against the user's home dir.
//   - REMOTE (sftp-sync-manager)         → SFTP read/modify/write on an SSH host,
//     reusing TMUX_BLOCK / SCREEN_BLOCK / transformConfig so a button in the SSH
//     connection list can enable scrolling for tmux/screen running on that host.

const BEGIN = '# >>> SplitGrid: mouse scroll (managed — do not edit inside) >>>';
const END = '# <<< SplitGrid: mouse scroll (managed) <<<';

// tmux: mouse mode forwards wheel/clicks to tmux, which scrolls copy-mode.
export const TMUX_BLOCK = [
  BEGIN,
  '# Lets the mouse wheel scroll tmux scrollback / copy-mode.',
  '# Toggle via SplitGrid → Settings → Terminal, or delete this block.',
  'set -g mouse on',
  END,
  '',
].join('\n');

// screen: its mouse support is weak, so instead of mouse tracking we disable the
// alternate-screen switch (ti@:te@). screen then writes into the host terminal's
// native scrollback, which the wheel scrolls directly. Side effect: full-screen
// apps (vim/less) inside screen leave their content in the scrollback on exit.
export const SCREEN_BLOCK = [
  BEGIN,
  '# Lets the mouse wheel scroll GNU screen via the host terminal scrollback.',
  '# Toggle via SplitGrid → Settings → Terminal, or delete this block.',
  'termcapinfo xterm*|rxvt*|kterm*|Eterm* ti@:te@',
  'defscrollback 10000',
  END,
  '',
].join('\n');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove our managed block (and the blank lines hugging it) wherever it sits,
// then tidy leftover blank-line runs so repeated toggles don't accumulate gaps.
export function stripManagedBlock(content: string): string {
  const re = new RegExp(`\\n*${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}[^\\n]*\\n?`, 'g');
  return content
    .replace(re, '\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

// Pure transform: given a config file's current contents ('' if absent), return
// the contents it should have with our block enabled/removed. Callers decide
// whether the result is worth writing (e.g. skip creating an empty file).
export function transformConfig(original: string, block: string, enable: boolean): string {
  let next = stripManagedBlock(original);
  if (enable) {
    if (next && !next.endsWith('\n')) next += '\n';
    next += block;
  }
  return next;
}

function applyToFile(filePath: string, block: string, enable: boolean): void {
  const existed = existsSync(filePath);
  // Disabling a file that was never created: nothing to do.
  if (!enable && !existed) return;

  const original = existed ? readFileSync(filePath, 'utf-8') : '';
  const next = transformConfig(original, block, enable);

  // Don't materialise an empty file just to remove our block from nothing.
  if (!existed && next.trim() === '') return;
  if (next === original) return;

  writeFileSync(filePath, next, 'utf-8');
}

/**
 * Add (enable) or remove (disable) the managed mouse-scroll block in the LOCAL
 * ~/.tmux.conf and ~/.screenrc. Best-effort: a failure on one file is logged and
 * does not block the other. Already-running tmux/screen sessions keep their old
 * config until reloaded (`tmux source-file ~/.tmux.conf`); new sessions pick it
 * up automatically.
 */
export function applyTerminalMouseConfig(enable: boolean): void {
  const home = homedir();
  const targets: Array<{ file: string; block: string }> = [
    { file: path.join(home, '.tmux.conf'), block: TMUX_BLOCK },
    { file: path.join(home, '.screenrc'), block: SCREEN_BLOCK },
  ];
  for (const t of targets) {
    try {
      applyToFile(t.file, t.block, enable);
    } catch (err) {
      console.error(`[mouse-config] failed to update ${t.file}:`, (err as Error).message);
    }
  }
}

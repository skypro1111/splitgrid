import React, { useRef, useEffect, useState } from 'react';
import { Ghostty, Terminal, FitAddon, OSC8LinkProvider, UrlRegexProvider } from 'ghostty-web';
// eslint-disable-next-line import/no-unresolved
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import { TerminalProcessesButton } from './TerminalProcessesButton';
import { EditableTerminalName } from './EditableTerminalName';
import { AgentBrowserButton } from './AgentBrowserButton';
import { SshPasswordHint, computeSshHintAnchor, type SshHintAnchor } from './SshPasswordHint';
import { useSshPasswordOffer } from '../hooks/useSshPasswordOffer';
import { dragHasPaths, getDroppedPaths } from './terminalDrop';
import { pasteClipboardIntoTerminal } from './clipboardPaste';
import { latinKey } from '../../shared/keyboard';
import { promptStreamLogin } from './streamLoginPrompt';
import type {
  TerminalRendererMetrics,
  TerminalSessionInfo,
} from '../../shared/types';

interface GridTerminalProps {
  containerId: string;
  workspaceId: string;
  visible: boolean;
  session: TerminalSessionInfo;
  sendData: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  getBuffer: (id: string) => Promise<string>;
  registerWriter: (id: string, fn: (data: string) => void) => void;
  unregisterWriter: (id: string) => void;
  reportRendererMetrics: (metrics: TerminalRendererMetrics) => void;
  removeRendererMetrics: (sessionId: string) => void;
  onClose: () => void;
  onReconnect?: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onOpenAgentBrowser?: (sessionId: string) => void;
  zoomLevel: number;
  historyOutput?: string;
  historyLinesToReplay?: number;
  workspaceSwitchToken?: string;
  customName?: string;
  onRename?: (name: string | null) => void;
  streaming?: boolean;
  canStream?: boolean;
  onToggleStreaming?: (enabled: boolean, live: { cols: number; rows: number }) => void;
}

const statusColors: Record<string, string> = {
  connecting: '#e5b95c',
  connected: '#15ac91',
  disconnected: '#f14c4c',
  error: '#f14c4c',
};

interface WheelState {
  // Accumulator + throttle state for SGR mouse wheel forwarding.
  // Smoother UX than emitting one ghostty event per tiny trackpad delta.
  wheelAccumulator: number;
  lastSGREmitAt: number;
  sgrFlushTimer: number | null;
  lastWheelEvent: WheelEvent | null;
}

type CachedTerminalInstance = {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposeTimer: number | null;
  sessionId: string;
  wheel: WheelState;
};

const terminalCache = new Map<string, CachedTerminalInstance>();
const TERMINAL_CACHE_TTL_MS = 30_000;
const TERMINAL_FONT_FAMILY = "Menlo, Monaco, 'Courier New', monospace";

type GhosttySelectionManagerLike = {
  selectionStart: { col: number; absoluteRow: number } | null;
  selectionEnd: { col: number; absoluteRow: number } | null;
  hasSelection?: () => boolean;
  requestRender?: () => void;
  selectionChangedEmitter?: {
    fire?: () => void;
  };
  copyToClipboard?: (text: string) => void | Promise<void>;
  __splitgridClipboardPatched?: boolean;
};

type GhosttyCellLike = {
  codepoint: number;
  grapheme_len?: number;
};

type GhosttyWasmTermLike = {
  getScrollbackLength?: () => number;
  getScrollbackLine?: (offset: number) => GhosttyCellLike[] | null;
  getLine?: (row: number) => GhosttyCellLike[] | null;
  getScrollbackGraphemeString?: (offset: number, col: number) => string;
  getGraphemeString?: (row: number, col: number) => string;
};

function normalizeSelectionRange(selectionManager: GhosttySelectionManagerLike) {
  const start = selectionManager.selectionStart;
  const end = selectionManager.selectionEnd;
  if (!start || !end) return null;

  let startCol = start.col;
  let startRow = start.absoluteRow;
  let endCol = end.col;
  let endRow = end.absoluteRow;
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startCol, endCol] = [endCol, startCol];
    [startRow, endRow] = [endRow, startRow];
  }
  return { startCol, startRow, endCol, endRow };
}

function extractSelectionTextFallback(terminal: Terminal): string {
  const internals = terminal as unknown as {
    selectionManager?: GhosttySelectionManagerLike;
    wasmTerm?: GhosttyWasmTermLike;
  };
  const selectionManager = internals.selectionManager;
  const wasmTerm = internals.wasmTerm;
  if (!selectionManager || !wasmTerm) return '';

  const range = normalizeSelectionRange(selectionManager);
  if (!range) return '';

  const scrollbackLength = Math.max(0, wasmTerm.getScrollbackLength?.() ?? 0);
  const lines: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row++) {
    const cells =
      row < scrollbackLength
        ? wasmTerm.getScrollbackLine?.(row) ?? null
        : wasmTerm.getLine?.(row - scrollbackLength) ?? null;
    if (!cells || cells.length === 0) {
      lines.push('');
      continue;
    }

    const fromCol = row === range.startRow ? Math.max(0, range.startCol) : 0;
    const toCol = row === range.endRow
      ? Math.min(cells.length - 1, Math.max(0, range.endCol))
      : cells.length - 1;
    if (toCol < fromCol) {
      lines.push('');
      continue;
    }

    let line = '';
    for (let col = fromCol; col <= toCol; col++) {
      const cell = cells[col];
      if (!cell || cell.codepoint === 0) {
        line += ' ';
        continue;
      }
      if (cell.grapheme_len && cell.grapheme_len > 0) {
        const grapheme =
          row < scrollbackLength
            ? wasmTerm.getScrollbackGraphemeString?.(row, col)
            : wasmTerm.getGraphemeString?.(row - scrollbackLength, col);
        if (grapheme) {
          line += grapheme;
          continue;
        }
      }
      line += String.fromCodePoint(cell.codepoint);
    }

    lines.push(line.replace(/\s+$/u, ''));
  }

  return lines.join('\n');
}

function getSelectionText(terminal: Terminal): string {
  if (terminal.hasSelection && !terminal.hasSelection()) return '';

  const selection = terminal.getSelection();
  if (selection) return selection;
  return extractSelectionTextFallback(terminal);
}

function writeClipboardFallback(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  active?.focus?.();
  return copied;
}

function consumeTerminalShortcut(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
}

async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await window.electronAPI.clipboardWriteText(text);
    const echoed = await window.electronAPI.clipboardReadText();
    if (echoed === text) return true;
  } catch {
    // Fall through to browser clipboard.
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback.
    }
  }

  return writeClipboardFallback(text);
}

function patchGhosttySelectionClipboard(terminal: Terminal): void {
  const selectionManager = (
    terminal as unknown as { selectionManager?: GhosttySelectionManagerLike }
  ).selectionManager;
  if (!selectionManager || selectionManager.__splitgridClipboardPatched) return;

  selectionManager.__splitgridClipboardPatched = true;
  // Ghostty auto-copies on mouseup, even for a zero-width click selection.
  // Route real selections through Electron and ignore click-only selections.
  selectionManager.copyToClipboard = (text: string) => {
    if (!text) return;
    if (selectionManager.hasSelection && !selectionManager.hasSelection()) return;
    void writeClipboardText(text);
  };
}

function selectAllBuffer(terminal: Terminal) {
  const rows = Math.max(1, terminal.rows);
  const cols = Math.max(1, terminal.cols);
  const scrollback = Math.max(
    0,
    typeof terminal.getScrollbackLength === 'function' ? terminal.getScrollbackLength() : 0,
  );
  const selectionManager = (
    terminal as unknown as { selectionManager?: GhosttySelectionManagerLike }
  ).selectionManager;

  // ghostty-web v0.4's public selectAll currently selects only viewport rows.
  // Drive the internal selection manager directly so Cmd+A spans full buffer.
  if (!selectionManager) {
    terminal.selectAll();
    return;
  }

  selectionManager.selectionStart = { col: 0, absoluteRow: 0 };
  selectionManager.selectionEnd = { col: cols - 1, absoluteRow: scrollback + rows - 1 };
  selectionManager.requestRender?.();
  selectionManager.selectionChangedEmitter?.fire?.();
}

// Module-level singleton: initialize the WASM engine once for the whole
// renderer. We pass the URL explicitly so Vite/Electron resolves the .wasm
// asset correctly — ghostty-web's built-in init() relies on a base64 data
// URL that some bundlers/dev servers fail to fetch as binary.
let ghosttyInitPromise: Promise<Ghostty> | null = null;
let ghosttyInstance: Ghostty | null = null;
function ensureGhosttyInitialized(): Promise<Ghostty> {
  if (!ghosttyInitPromise) {
    ghosttyInitPromise = Ghostty.load(ghosttyWasmUrl).then((g) => {
      ghosttyInstance = g;
      return g;
    });
  }
  return ghosttyInitPromise;
}

function disposeCachedTerminal(cacheKey: string) {
  const cached = terminalCache.get(cacheKey);
  if (!cached) return;
  if (cached.disposeTimer !== null) {
    window.clearTimeout(cached.disposeTimer);
  }
  cached.terminal.dispose();
  terminalCache.delete(cacheKey);
}

function attachTerminalElement(container: HTMLElement, terminalElement: HTMLElement | undefined | null) {
  if (!terminalElement) return;
  if (terminalElement === container || terminalElement.contains(container)) return;
  if (container.contains(terminalElement)) return;
  container.appendChild(terminalElement);
}

export const GridTerminal: React.FC<GridTerminalProps> = ({
  containerId,
  workspaceId,
  visible,
  session,
  sendData,
  resize,
  getBuffer,
  registerWriter,
  unregisterWriter,
  reportRendererMetrics,
  removeRendererMetrics,
  onClose,
  onReconnect,
  onSplitRight,
  onSplitDown,
  onOpenAgentBrowser,
  zoomLevel,
  historyOutput,
  historyLinesToReplay = 300,
  workspaceSwitchToken,
  customName,
  onRename,
  streaming,
  canStream,
  onToggleStreaming,
}) => {
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  // Kept current for keydown closures (image paste needs type/shell at press time).
  const sessionMetaRef = useRef({ type: session.type, shell: session.shell });
  sessionMetaRef.current = { type: session.type, shell: session.shell };
  const pwOffer = useSshPasswordOffer(session.id);
  const { activeRef: pwActiveRef, applyRef: pwApplyRef, dismissRef: pwDismissRef } = pwOffer;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [dragOver, setDragOver] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [hintAnchor, setHintAnchor] = useState<SshHintAnchor | null>(null);
  const lastFitAtRef = useRef(0);
  const pendingFitRafRef = useRef<number | null>(null);
  const metricsRef = useRef({
    renderWriteCalls: 0,
    renderWriteChars: 0,
    renderWriteMsTotal: 0,
    fitCalls: 0,
    fitMsTotal: 0,
    refreshCalls: 0,
    refreshMsTotal: 0,
  });
  const FIT_THROTTLE_MS = 80;

  const [ghosttyReady, setGhosttyReady] = useState<Ghostty | null>(ghosttyInstance);
  const [initError, setInitError] = useState<string | null>(null);

  const publishRendererMetrics = () => {
    reportRendererMetrics({
      sessionId: sessionIdRef.current,
      containerId,
      workspaceId,
      renderer: 'ghostty',
      visible: visibleRef.current,
      ...metricsRef.current,
      updatedAt: Date.now(),
    });
  };

  // Load WASM once for the whole renderer.
  useEffect(() => {
    let mounted = true;
    ensureGhosttyInitialized()
      .then((g) => {
        if (!mounted) return;
        setGhosttyReady(g);
        setInitError(null);
      })
      .catch((error) => {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : 'Failed to initialize ghostty-web';
        setInitError(message);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const doFit = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try {
      const startedAt = performance.now();
      fitAddon.fit();
      metricsRef.current.fitCalls += 1;
      metricsRef.current.fitMsTotal += performance.now() - startedAt;
      publishRendererMetrics();
    } catch {
      // Best effort during transient layout states.
    }
  };

  const scheduleFit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastFitAtRef.current < FIT_THROTTLE_MS) return;
    if (pendingFitRafRef.current !== null) {
      if (!force) return;
      cancelAnimationFrame(pendingFitRafRef.current);
    }
    pendingFitRafRef.current = requestAnimationFrame(() => {
      pendingFitRafRef.current = null;
      lastFitAtRef.current = performance.now();
      doFit();
    });
  };

  // Push the *current* fitted size to the PTY, decoupled from the terminal's
  // onResize change-detection. The PTY spawns at 80x24; for a single full-window
  // terminal the one fit→resize can be lost (session not ready) or never re-fire
  // (already at final size), leaving the shell/TUI stuck tiny (~1/4 of the
  // window). An explicit push after layout settles makes the PTY catch up.
  const syncPtySize = () => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.cols <= 0 || terminal.rows <= 0) return;
    resize(sessionIdRef.current, terminal.cols, terminal.rows);
  };

  const getLastLines = (text: string, count: number) => {
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
  };

  useEffect(() => {
    publishRendererMetrics();
    if (visible) {
      scheduleFit(true);
    }
  }, [visible, containerId, workspaceId]);

  useEffect(() => {
    const handlePortalAttached = (event: Event) => {
      const detail = (event as CustomEvent<{ containerId?: string }>).detail;
      if (detail?.containerId !== containerId || !visibleRef.current) return;
      scheduleFit(true);
    };
    window.addEventListener('splitgrid:terminal-portal-attached', handlePortalAttached);
    return () => {
      window.removeEventListener('splitgrid:terminal-portal-attached', handlePortalAttached);
    };
  }, [containerId]);

  useEffect(() => {
    return () => {
      removeRendererMetrics(session.id);
    };
  }, [removeRendererMetrics, session.id]);

  useEffect(() => {
    if (!ghosttyReady || !containerRef.current) return;

    let cached = terminalCache.get(containerId);
    let createdNow = false;
    if (cached && cached.disposeTimer !== null) {
      window.clearTimeout(cached.disposeTimer);
      cached.disposeTimer = null;
    }

    // Re-attach cached terminal element if its parent has changed (e.g. after
    // workspace remount).
    if (
      cached &&
      cached.terminal.element?.parentElement !== containerRef.current
    ) {
      attachTerminalElement(containerRef.current, cached.terminal.element);
    }

    if (!cached) {
      const terminal = new Terminal({
        ghostty: ghosttyReady,
        theme: {
          background: '#141414',
          foreground: '#D4D4D4',
          cursor: '#D4D4D4',
          cursorAccent: '#5b51ec',
          selectionBackground: '#264f78',
          selectionForeground: '#ffffff',
          black: '#1e1e1e',
          red: '#f14c4c',
          green: '#15ac91',
          yellow: '#e5b95c',
          blue: '#4c9df3',
          magenta: '#e567dc',
          cyan: '#75d3ba',
          white: '#D4D4D4',
          brightBlack: '#505050',
          brightRed: '#f14c4c',
          brightGreen: '#15ac91',
          brightYellow: '#e5b95c',
          brightBlue: '#4c9df3',
          brightMagenta: '#e567dc',
          brightCyan: '#75d3ba',
          brightWhite: '#D4D4D4',
        },
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: zoomLevel,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
        // Default smooth scroll: ghostty interpolates viewportY changes over
        // ~100ms, giving a perceptually smooth animation at the renderer's
        // 60fps rAF cadence. Turning this to 0 produces visible step-wise
        // jumps that look like ~20fps scroll even though renders are 60fps.
        smoothScrollDuration: 100,
        allowTransparency: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      try {
        terminal.registerLinkProvider(new OSC8LinkProvider(terminal));
        terminal.registerLinkProvider(new UrlRegexProvider(terminal));
      } catch {
        // Link providers are non-essential for terminal correctness.
      }

      terminal.open(containerRef.current);
      patchGhosttySelectionClipboard(terminal);

      // Native-feeling macOS shortcuts. NOTE: ghostty's customKeyEventHandler
      // returns true when the key was handled here —
      //   return true  = "I handled it; ghostty must NOT process this key"
      //   return false = "let ghostty's KeyEncoder process this key normally"
      // On Windows/Linux we deliberately bypass the Cmd-style block so
      // Ctrl+letter readline shortcuts (Ctrl+A/E/K/U/W) reach the shell.
      const isMac = window.electronAPI?.platform === 'darwin'
        || /mac|iphone|ipod|ipad/i.test(navigator.platform);
      terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return false;

        // Saved-password offer active: Enter pastes it (Tabby-style); any other
        // key dismisses the offer.
        if (pwActiveRef.current) {
          const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey;
          if (ev.key === 'Enter' && plain && !ev.shiftKey) {
            consumeTerminalShortcut(ev);
            pwActiveRef.current = false;
            pwApplyRef.current();
            return false;
          }
          if (ev.key === 'Escape') {
            consumeTerminalShortcut(ev);
            pwActiveRef.current = false;
            pwDismissRef.current();
            return false;
          }
          // Any other keypress — manual typing, Backspace, arrows, Ctrl-combos —
          // means the user is driving the line by hand. Drop the offer so a
          // later Enter submits their own input instead of injecting the saved
          // password (which would otherwise echo as raw text on the command line
          // once the prompt has passed). Bare modifier presses are ignored; the
          // key still passes through to the shell.
          if (ev.key !== 'Shift' && ev.key !== 'Control' && ev.key !== 'Alt' && ev.key !== 'Meta') {
            pwActiveRef.current = false;
            pwDismissRef.current();
          }
        }

        if (isMac && ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          // latinKey, not ev.key: under a non-latin layout (uk/ru) ev.key is the
          // Cyrillic character, so a plain `=== 'c'` check never fires.
          const key = latinKey(ev);

          if (ev.key === 'ArrowLeft') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x01'); // Ctrl+A
            return true;
          }
          if (ev.key === 'ArrowRight') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x05'); // Ctrl+E
            return true;
          }
          if (ev.key === 'ArrowUp') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1b[1;5A');
            return true;
          }
          if (ev.key === 'ArrowDown') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1b[1;5B');
            return true;
          }

          if (key === 'a') {
            consumeTerminalShortcut(ev);
            selectAllBuffer(terminal);
            return true;
          }

          if (key === 'k') {
            consumeTerminalShortcut(ev);
            terminal.clear();
            return true;
          }

          if (ev.key === 'Backspace') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\u0015'); // Ctrl+U
            return true;
          }

          if (key === 'c') {
            consumeTerminalShortcut(ev);
            const selection = getSelectionText(terminal);
            if (selection) {
              void writeClipboardText(selection);
              return true;
            }
            sendData(sessionIdRef.current, '\x03');
            return true;
          }

          if (key === 'v') {
            consumeTerminalShortcut(ev);
            pasteClipboardIntoTerminal(
              terminal,
              (data) => sendData(sessionIdRef.current, data),
              sessionMetaRef.current,
            );
            return true;
          }

          // Other Cmd+key combos (Cmd+= zoom etc.) — let global handlers run.
          return false;
        }

        // Windows/Linux: Ctrl+Shift+V pastes, Ctrl+Shift+C copies the selection
        // (plain Ctrl+V/Ctrl+C remain the control codes the shell expects).
        if (!isMac && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
          const key = latinKey(ev);
          if (key === 'v') {
            consumeTerminalShortcut(ev);
            pasteClipboardIntoTerminal(
              terminal,
              (data) => sendData(sessionIdRef.current, data),
              sessionMetaRef.current,
            );
            return false;
          }
          if (key === 'c') {
            const selection = getSelectionText(terminal);
            if (selection) {
              consumeTerminalShortcut(ev);
              void writeClipboardText(selection);
              return false;
            }
          }
        }

        if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
          if (ev.key === 'ArrowLeft') {
            sendData(sessionIdRef.current, '\x1bb'); // ESC+b: word back
            return true;
          }
          if (ev.key === 'ArrowRight') {
            sendData(sessionIdRef.current, '\x1bf'); // ESC+f: word forward
            return true;
          }
          if (ev.key === 'Backspace') {
            sendData(sessionIdRef.current, '\x1b\x7f'); // ESC+DEL: word back
            return true;
          }
        }

        // Default: let ghostty handle the key (printable chars, arrows, etc.).
        return false;
      });

      // Mouse wheel:
      //  - normal screen → let ghostty's smooth viewport scroll run.
      //  - alt-screen + mouse tracking enabled by app (Claude Code, vim with
      //    `set mouse=a`, tmux with `set -g mouse on`) → forward proper SGR
      //    mouse wheel events so the app handles its own scrolling.
      //  - alt-screen, no mouse tracking → silently swallow (avoids ghostty's
      //    default arrow-key emulation that flicks bash history).
      //
      // Throttle SGR emission only as a safety cap on extreme bursts. The
      // natural rate (wheel event rate × deltaY ÷ WHEEL_PIXELS_PER_TICK) is
      // typically 20–30 Hz on a trackpad, which feels smooth in TUIs that
      // render at >=30 fps. Capping at ~60 Hz prevents pathological spikes
      // without making smooth scrolling look chunky.
      const WHEEL_PIXELS_PER_TICK = 66;
      const SGR_EMIT_MIN_INTERVAL_MS = 16;

      const computeWheelCoords = (ev: WheelEvent | null) => {
        let col = 1;
        let row = 1;
        if (!ev) return { col, row };
        const targetEl =
          terminal.element ??
          ((ev.currentTarget as HTMLElement | null | undefined) ?? null) ??
          ((ev.target as HTMLElement | null | undefined) ?? null);
        const rect = targetEl?.getBoundingClientRect?.();
        if (rect && rect.width > 0 && rect.height > 0 && terminal.cols > 0 && terminal.rows > 0) {
          const cellW = rect.width / terminal.cols;
          const cellH = rect.height / terminal.rows;
          col = Math.max(
            1,
            Math.min(terminal.cols, Math.floor((ev.clientX - rect.left) / cellW) + 1),
          );
          row = Math.max(
            1,
            Math.min(terminal.rows, Math.floor((ev.clientY - rect.top) / cellH) + 1),
          );
        }
        return { col, row };
      };

      const flushSGRAccumulator = () => {
        const c = terminalCache.get(containerId);
        if (!c) return;
        const w = c.wheel;
        const ticks = Math.trunc(Math.abs(w.wheelAccumulator) / WHEEL_PIXELS_PER_TICK);
        if (ticks === 0) return;
        const direction = w.wheelAccumulator > 0 ? 1 : -1;
        w.wheelAccumulator -= direction * ticks * WHEEL_PIXELS_PER_TICK;
        const { col, row } = computeWheelCoords(w.lastWheelEvent);
        const button = direction > 0 ? 65 : 64;
        const limited = Math.min(ticks, 5);
        let payload = '';
        for (let i = 0; i < limited; i++) {
          payload += `\x1b[<${button};${col};${row}M`;
        }
        if (payload) sendData(sessionIdRef.current, payload);
        w.lastSGREmitAt = performance.now();
      };

      terminal.attachCustomWheelEventHandler((ev) => {
        const isAlt = terminal.buffer?.active?.type === 'alternate';
        const c = terminalCache.get(containerId);
        if (!c) return false;
        const w = c.wheel;

        if (!isAlt) {
          w.wheelAccumulator = 0;
          return false;
        }

        const hasMouseTracking = terminal.wasmTerm?.hasMouseTracking?.() ?? false;
        if (!hasMouseTracking) {
          w.wheelAccumulator = 0;
          return true;
        }

        if (
          (w.wheelAccumulator > 0 && ev.deltaY < 0) ||
          (w.wheelAccumulator < 0 && ev.deltaY > 0)
        ) {
          w.wheelAccumulator = 0;
        }
        w.wheelAccumulator += ev.deltaY;
        w.lastWheelEvent = ev;

        const now = performance.now();
        const elapsed = now - w.lastSGREmitAt;
        if (elapsed >= SGR_EMIT_MIN_INTERVAL_MS) {
          flushSGRAccumulator();
        } else if (w.sgrFlushTimer === null) {
          w.sgrFlushTimer = window.setTimeout(() => {
            const c2 = terminalCache.get(containerId);
            if (c2) c2.wheel.sgrFlushTimer = null;
            flushSGRAccumulator();
          }, SGR_EMIT_MIN_INTERVAL_MS - elapsed);
        }
        return true;
      });

      terminal.onData((data) => sendData(sessionIdRef.current, data));
      terminal.onResize(({ cols, rows }) => resize(sessionIdRef.current, cols, rows));

      cached = {
        terminal,
        fitAddon,
        disposeTimer: null,
        sessionId: session.id,
        wheel: {
          wheelAccumulator: 0,
          lastSGREmitAt: 0,
          sgrFlushTimer: null,
          lastWheelEvent: null,
        },
      };
      terminalCache.set(containerId, cached);
      createdNow = true;
    }

    const terminal = cached.terminal;
    terminalRef.current = terminal;
    fitAddonRef.current = cached.fitAddon;
    if (cached.sessionId !== session.id) {
      unregisterWriter(cached.sessionId);
      cached.sessionId = session.id;
      metricsRef.current = {
        renderWriteCalls: 0,
        renderWriteChars: 0,
        renderWriteMsTotal: 0,
        fitCalls: 0,
        fitMsTotal: 0,
        refreshCalls: 0,
        refreshMsTotal: 0,
      };
    }

    let isDisposed = false;
    let writerRegistered = false;
    const writeToTerminal = (data: string) => {
      const startedAt = performance.now();
      terminal.write(data);
      metricsRef.current.renderWriteCalls += 1;
      metricsRef.current.renderWriteChars += data.length;
      metricsRef.current.renderWriteMsTotal += performance.now() - startedAt;
      publishRendererMetrics();
    };
    const writePreservingViewport = (data: string) => {
      if (isDisposed || !data) return;
      // Fast path: when the user is parked at the bottom (viewportY === 0)
      // there is nothing to preserve, so skip the WASM round-trip into
      // getScrollbackLength entirely. Typing produces echo + cursor
      // positioning writes per keystroke, so even a few µs per write
      // accumulate into perceptible input lag.
      const wasViewportY = terminal.viewportY;
      if (wasViewportY === 0) {
        writeToTerminal(data);
        return;
      }
      // Slow path: ghostty's writeInternal force-snaps the viewport back
      // to the bottom on every write (`viewportY !== 0 && scrollToBottom`).
      // If the user is scrolled up, save their position and restore it
      // after the write completes — adjusted by however many lines were
      // appended so the same content stays visible.
      const getLen =
        typeof terminal.getScrollbackLength === 'function'
          ? terminal.getScrollbackLength.bind(terminal)
          : null;
      const wasScrollbackLen = getLen ? getLen() : 0;
      writeToTerminal(data);
      if (terminal.viewportY === 0) {
        const newLen = getLen ? getLen() : wasScrollbackLen;
        const added = Math.max(0, newLen - wasScrollbackLen);
        terminal.scrollToLine(wasViewportY + added);
      }
    };
    const registerLiveWriter = () => {
      if (isDisposed || writerRegistered) return;
      writerRegistered = true;
      registerWriter(sessionIdRef.current, (data: string) => {
        writePreservingViewport(data);
      });
    };

    const hydrateFromBackendBuffer = async (allowHistoryFallback: boolean) => {
      try {
        const buf = await getBuffer(sessionIdRef.current);
        if (isDisposed || terminalRef.current !== terminal) return;
        terminal.reset();
        if (buf) {
          writeToTerminal(buf);
        } else if (allowHistoryFallback) {
          const history = getLastLines(historyOutput ?? '', historyLinesToReplay);
          if (history) {
            writeToTerminal(history);
          }
        }
      } catch {
        if (!allowHistoryFallback || isDisposed || terminalRef.current !== terminal) return;
        const history = getLastLines(historyOutput ?? '', historyLinesToReplay);
        if (history) {
          writeToTerminal(history);
        }
      } finally {
        if (!isDisposed && terminalRef.current === terminal) {
          if (visibleRef.current) {
            scheduleFit(true);
          }
          publishRendererMetrics();
        }
      }
    };

    requestAnimationFrame(() => {
      if (visibleRef.current) {
        doFit();
        syncPtySize();
      }
      void hydrateFromBackendBuffer(createdNow).finally(() => {
        registerLiveWriter();
      });
    });

    // Re-fit + force-sync the PTY size after layout settles. Two passes cover
    // slow first layouts (notably a single full-window terminal, which has no
    // later split/resize to self-heal the 80x24 spawn size).
    const safetyFitTimer = setTimeout(() => {
      doFit();
      syncPtySize();
    }, 200);
    const safetyFitTimer2 = setTimeout(() => {
      doFit();
      syncPtySize();
    }, 600);

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(containerRef.current);

    if (createdNow) {
      terminal.focus();
    }

    const onWindowFocus = () => {
      scheduleFit(true);
    };
    const onWindowResize = () => {
      scheduleFit(true);
    };
    let zoomSettleTimer: number | null = null;
    const onWindowZoomChanged = () => {
      scheduleFit(true);
      if (zoomSettleTimer !== null) {
        window.clearTimeout(zoomSettleTimer);
      }
      zoomSettleTimer = window.setTimeout(() => {
        scheduleFit(true);
        zoomSettleTimer = null;
      }, 120);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        scheduleFit(true);
      }
    };
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('splitgrid:window-zoom', onWindowZoomChanged as EventListener);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isDisposed = true;
      clearTimeout(safetyFitTimer);
      clearTimeout(safetyFitTimer2);
      if (zoomSettleTimer !== null) {
        window.clearTimeout(zoomSettleTimer);
      }
      if (pendingFitRafRef.current !== null) {
        cancelAnimationFrame(pendingFitRafRef.current);
        pendingFitRafRef.current = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('splitgrid:window-zoom', onWindowZoomChanged as EventListener);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      const cachedOnCleanup = terminalCache.get(containerId);
      if (cachedOnCleanup) {
        unregisterWriter(cachedOnCleanup.sessionId);
        if (cachedOnCleanup.disposeTimer !== null) {
          window.clearTimeout(cachedOnCleanup.disposeTimer);
        }
        cachedOnCleanup.disposeTimer = window.setTimeout(() => {
          disposeCachedTerminal(containerId);
        }, TERMINAL_CACHE_TTL_MS);
      } else {
        unregisterWriter(session.id);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    ghosttyReady,
    containerId,
    session.id,
    sendData,
    resize,
    getBuffer,
    registerWriter,
    unregisterWriter,
  ]);

  // Keep terminal font in sync with xterm and container zoom.
  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    const fontChanged = terminal.options.fontFamily !== TERMINAL_FONT_FAMILY;
    const sizeChanged = terminal.options.fontSize !== zoomLevel;
    if (!fontChanged && !sizeChanged) return;
    terminal.options.fontFamily = TERMINAL_FONT_FAMILY;
    terminal.options.fontSize = zoomLevel;
    scheduleFit(true);
  }, [zoomLevel]);

  // Workspace switches reparent the wrapper without remounting this component;
  // ghostty's renderer re-paints automatically once dimensions change, but we
  // still poke it through fit + a 1-row dim cycle in case the new wrapper has
  // identical bounds (mirrors the v1 wake-up path).
  useEffect(() => {
    if (!visibleRef.current) return;
    const wakeRenderer = () => {
      const terminal = terminalRef.current;
      const containerEl = containerRef.current;
      if (!terminal || !containerEl) return;
      if (containerEl.clientWidth === 0 || containerEl.clientHeight === 0) return;
      if (terminal.rows < 2) return;
      try {
        const { cols, rows } = terminal;
        terminal.resize(cols, rows - 1);
        terminal.resize(cols, rows);
      } catch {
        // Best effort.
      }
    };
    wakeRenderer();
    scheduleFit(true);

    const timers = [80, 180, 320, 520].map((ms) =>
      window.setTimeout(() => {
        scheduleFit(true);
      }, ms),
    );
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [workspaceSwitchToken]);

  // While a saved-password offer is live, anchor the hint inline on the prompt
  // row (trailing the cursor) so it never overlaps the bottom line of output.
  useEffect(() => {
    if (!pwOffer.offer) {
      setHintAnchor(null);
      return;
    }
    const recompute = () => {
      const terminal = terminalRef.current;
      const host = containerRef.current;
      const root = rootRef.current;
      if (!terminal || !host || !root) return;
      const metrics = terminal.renderer?.getMetrics();
      if (!metrics) return;
      const buf = terminal.buffer.active;
      setHintAnchor(
        computeSshHintAnchor({
          cursorX: buf.cursorX,
          cursorY: buf.cursorY,
          cellWidth: metrics.width,
          cellHeight: metrics.height,
          hostRect: host.getBoundingClientRect(),
          rootRect: root.getBoundingClientRect(),
        }),
      );
    };
    // The prompt has just painted; compute on the next frame, then follow the
    // cursor (cursor blink does not fire onCursorMove, so this stays cheap).
    const raf = requestAnimationFrame(recompute);
    const terminal = terminalRef.current;
    const subCursor = terminal?.onCursorMove(recompute);
    const subResize = terminal?.onResize(recompute);
    return () => {
      cancelAnimationFrame(raf);
      subCursor?.dispose();
      subResize?.dispose();
    };
  }, [pwOffer.offer]);

  const subtitle = session.type === 'ssh' ? `${session.username}@${session.host}` : session.cwd || '';

  if (initError) {
    return (
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', color: 'var(--accent-red)', fontSize: '12px', padding: '12px', textAlign: 'center', background: 'var(--bg-primary)' }}>
        <span>ghostty-web init failed: {initError}</span>
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-primary)', overflow: 'hidden', boxSizing: 'border-box', padding: '8px' }}>
      <div
        className="container-drag-handle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0 10px',
          height: '32px',
          minHeight: '32px',
          background: 'var(--bg-titlebar)',
          borderBottom: '1px solid var(--border)',
          userSelect: 'none',
          cursor: 'grab',
        }}
      >
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
          style={{ width: '12px', height: '12px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', color: 'transparent', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1, opacity: 0.7 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'transparent'; }}
        >
          x
        </button>
        <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: statusColors[session.status] || 'var(--text-muted)', flexShrink: 0 }} />
        <EditableTerminalName customName={customName} autoLabel={session.label} onRename={onRename} />
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {subtitle}
        </span>
        {onToggleStreaming && (
          <button
            className={streaming ? 'splitgrid-cast-btn' : undefined}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (!canStream) { promptStreamLogin(); return; }
              const terminal = terminalRef.current;
              const cols = terminal && terminal.cols > 0 ? terminal.cols : 80;
              const rows = terminal && terminal.rows > 0 ? terminal.rows : 24;
              onToggleStreaming(!streaming, { cols, rows });
            }}
            title={!canStream ? 'For remote terminal you have to login' : (streaming ? 'Streaming to web' : 'Stream to web')}
            aria-label={streaming ? 'Streaming to web' : 'Stream to web'}
            aria-pressed={!!streaming}
            aria-disabled={!canStream}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: streaming ? 'var(--bg-hover)' : 'transparent', border: 'none', cursor: canStream ? 'pointer' : 'not-allowed', flexShrink: 0, opacity: canStream ? 1 : 0.45, color: streaming ? 'var(--accent-green, #15ac91)' : 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; if (canStream && !streaming) e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = streaming ? 'var(--bg-hover)' : 'transparent'; e.currentTarget.style.color = streaming ? 'var(--accent-green, #15ac91)' : 'var(--text-muted)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 5a4.5 4.5 0 0 0 0 6" />
              <path d="M12.5 5a4.5 4.5 0 0 1 0 6" />
              <path d="M1 3a8 8 0 0 0 0 10" />
              <path d="M15 3a8 8 0 0 1 0 10" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}
        <TerminalProcessesButton sessionId={session.id} sessionType={session.type} />
        {onOpenAgentBrowser && (
          <AgentBrowserButton sessionId={session.id} onOpen={onOpenAgentBrowser} />
        )}
        {onReconnect && session.type === 'ssh' && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onReconnect}
            title="Reconnect SSH"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 8a7 7 0 0 1 12.07-4.83" />
              <path d="M15 8a7 7 0 0 1-12.07 4.83" />
              <polyline points="1 2 1 6 5 6" />
              <polyline points="15 14 15 10 11 10" />
            </svg>
          </button>
        )}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitRight}
          title="Split right"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitHorizontalIcon size={14} />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitDown}
          title="Split down"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitVerticalIcon size={14} />
        </button>
      </div>
      <div
        ref={containerRef}
        onDragOver={(e) => {
          if (!dragHasPaths(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          setDragOver(false);
          const text = getDroppedPaths(e);
          if (!text) return;
          e.preventDefault();
          sendData(sessionIdRef.current, `${text} `);
          // Make this the active terminal and put the caret here so the user can
          // keep typing the command (focusin drives container focus too).
          terminalRef.current?.focus();
        }}
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'block',
          outline: dragOver ? '2px solid var(--accent-blue)' : 'none',
          outlineOffset: '-2px',
        }}
      />
      {pwOffer.offer && <SshPasswordHint offer={pwOffer.offer} onApply={pwOffer.apply} anchor={hintAnchor} />}
      <div className="terminal-dim-overlay" aria-hidden="true" />
      <div className="terminal-focus-ring" aria-hidden="true" />
    </div>
  );
};

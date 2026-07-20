import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import { TerminalProcessesButton } from './TerminalProcessesButton';
import { EditableTerminalName } from './EditableTerminalName';
import { AgentBrowserButton } from './AgentBrowserButton';
import { SshPasswordHint, computeSshHintAnchor, type SshHintAnchor } from './SshPasswordHint';
import { useSshPasswordOffer } from '../hooks/useSshPasswordOffer';
import { dragHasPaths, getDroppedPaths } from './terminalDrop';
import { pasteClipboardIntoTerminal } from './clipboardPaste';
import { promptStreamLogin } from './streamLoginPrompt';
import type {
  TerminalRendererMetrics,
  TerminalSessionInfo,
} from '../../shared/types';

interface XtermTerminalProps {
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

type CachedXtermInstance = {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposeTimer: number | null;
  sessionId: string;
};

const terminalCache = new Map<string, CachedXtermInstance>();
const TERMINAL_CACHE_TTL_MS = 30_000;
const FIT_THROTTLE_MS = 80;
const VSCODE_TERMINAL_SMOOTH_SCROLL_DURATION_MS = 0;
const statusColors: Record<string, string> = {
  connecting: '#d2943e',
  connected: '#3fa266',
  disconnected: '#fc6b83',
  error: '#fc6b83',
};

const cursorDarkTerminalTheme: ITheme = {
  background: '#141414',
  foreground: '#E4E4E4EB',
  // Solid white, NO alpha: an 8-digit (#RRGGBBAA) cursor colour composites
  // wrong for the block cursor on Windows (Chromium/WebGL) and renders dark —
  // the glyph under it (cursorAccent) keeps it readable.
  cursor: '#FFFFFF',
  cursorAccent: '#141414',
  selectionBackground: '#E4E4E41E',
  selectionInactiveBackground: '#E4E4E414',
  scrollbarSliderBackground: 'rgba(103, 103, 103, 0.31)',
  scrollbarSliderHoverBackground: '#676767',
  scrollbarSliderActiveBackground: '#787878',
  black: '#242424',
  red: '#FC6B83',
  green: '#3FA266',
  yellow: '#D2943E',
  blue: '#81A1C1',
  magenta: '#B48EAD',
  cyan: '#88C0D0',
  white: '#E4E4E4',
  brightBlack: '#E4E4E442',
  brightRed: '#FC6B83',
  brightGreen: '#70B489',
  brightYellow: '#F1B467',
  brightBlue: '#87A6C4',
  brightMagenta: '#B48EAD',
  brightCyan: '#88C0D0',
  brightWhite: '#E4E4E4',
};

function disposeCachedTerminal(cacheKey: string) {
  const cached = terminalCache.get(cacheKey);
  if (!cached) return;
  if (cached.disposeTimer !== null) {
    window.clearTimeout(cached.disposeTimer);
  }
  // Free the WebGL slot before disposing so the global budget stays accurate.
  releaseWebglRenderer(cached.terminal);
  cached.terminal.dispose();
  terminalCache.delete(cacheKey);
}

function attachTerminalElement(container: HTMLElement, terminalElement: HTMLElement | undefined | null) {
  if (!terminalElement) return;
  if (terminalElement === container || terminalElement.contains(container)) return;
  if (container.contains(terminalElement)) return;
  container.appendChild(terminalElement);
}

function consumeTerminalShortcut(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
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

function markXtermRenderer(terminal: Terminal, renderer: 'webgl' | 'dom'): void {
  terminal.element?.setAttribute('data-splitgrid-xterm-renderer', renderer);
}

// xterm's WebGL renderer gives EACH terminal its own GPU context. Chromium caps
// the number of live WebGL contexts per renderer process (~16) and, once that's
// exceeded, force-loses the least-recently-used one. With many terminal panes
// that produced a cascade: an evicted terminal's onContextLoss fired, it
// immediately re-acquired WebGL, which evicted another terminal, whose handler
// re-acquired… — the "panes keep crashing and auto-recovering" symptom.
//
// We bound it: at most MAX_WEBGL_CONTEXTS terminals hold a context at once, and
// only while VISIBLE (acquire/release is driven by the `visible` prop, so the
// active workspace's panes win). Terminals over budget use xterm's DOM renderer
// — slower but crash-proof. A lost context is NOT eagerly re-acquired (that was
// the cascade); the pane just drops to DOM until it's hidden and shown again.
const MAX_WEBGL_CONTEXTS = 8;
let activeWebglContexts = 0;
const webglByTerminal = new WeakMap<Terminal, WebglAddon>();

function acquireWebglRenderer(terminal: Terminal): void {
  if (!terminal.element) return;             // not opened yet
  if (webglByTerminal.has(terminal)) return; // already on WebGL
  if (activeWebglContexts >= MAX_WEBGL_CONTEXTS) {
    markXtermRenderer(terminal, 'dom');      // over budget → DOM renderer
    return;
  }
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      // Drop to DOM and free the slot. Do NOT re-acquire here — re-acquiring
      // evicts another terminal's context and restarts the cascade. The
      // visibility effect re-tries only when this pane is next re-shown.
      releaseWebglRenderer(terminal);
    });
    terminal.loadAddon(webglAddon);
    webglByTerminal.set(terminal, webglAddon);
    activeWebglContexts += 1;
    markXtermRenderer(terminal, 'webgl');
  } catch (error) {
    markXtermRenderer(terminal, 'dom');
    console.warn('[xterm] WebGL renderer unavailable; using DOM renderer fallback', error);
  }
}

function releaseWebglRenderer(terminal: Terminal): void {
  const addon = webglByTerminal.get(terminal);
  if (!addon) return;
  webglByTerminal.delete(terminal);
  activeWebglContexts = Math.max(0, activeWebglContexts - 1);
  try { addon.dispose(); } catch { /* may already be disposed on context loss */ }
  markXtermRenderer(terminal, 'dom');
}

function loadOptionalAddons(terminal: Terminal): void {
  try {
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
  } catch {
    // Unicode 11 is a rendering improvement, not required for correctness.
  }

  try {
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));
  } catch {
    // Link activation is non-essential.
  }

  // WebGL is acquired/released by the visibility effect (budgeted), not here, so
  // background terminals don't hold a GPU context.
}

export const XtermTerminal: React.FC<XtermTerminalProps> = ({
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
  const [dragOver, setDragOver] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [hintAnchor, setHintAnchor] = useState<SshHintAnchor | null>(null);
  const lastFitAtRef = useRef(0);
  const pendingFitRafRef = useRef<number | null>(null);
  const mountedOnceRef = useRef(false);
  const metricsRef = useRef({
    renderWriteCalls: 0,
    renderWriteChars: 0,
    renderWriteMsTotal: 0,
    fitCalls: 0,
    fitMsTotal: 0,
    refreshCalls: 0,
    refreshMsTotal: 0,
  });

  const publishRendererMetrics = () => {
    reportRendererMetrics({
      sessionId: sessionIdRef.current,
      containerId,
      workspaceId,
      renderer: 'xterm',
      visible: visibleRef.current,
      ...metricsRef.current,
      updatedAt: Date.now(),
    });
  };

  const doFit = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!terminal || !fitAddon || !container) return;
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;

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

  // Push the *current* fitted size to the PTY, decoupled from xterm's onResize
  // change-detection. The PTY spawns at 80x24; for a single full-window terminal
  // the one fit→resize can be lost (session not ready) or never re-fire (xterm
  // already at its final size → onResize doesn't fall), leaving the shell/TUI
  // stuck tiny (~1/4 of the window). An explicit push after layout settles makes
  // the PTY catch up regardless.
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
    if (!containerRef.current) return;

    let cached = terminalCache.get(containerId);
    let createdNow = false;
    if (cached && cached.disposeTimer !== null) {
      window.clearTimeout(cached.disposeTimer);
      cached.disposeTimer = null;
    }

    if (
      cached &&
      cached.terminal.element?.parentElement !== containerRef.current
    ) {
      attachTerminalElement(containerRef.current, cached.terminal.element);
    }

    if (!cached) {
      const terminal = new Terminal({
        allowTransparency: false,
        altClickMovesCursor: true,
        convertEol: false,
        cursorBlink: false,
        cursorInactiveStyle: 'outline',
        cursorStyle: 'block',
        drawBoldTextInBrightColors: true,
        fastScrollSensitivity: 5,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        fontSize: zoomLevel,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        letterSpacing: 0,
        lineHeight: 1,
        macOptionClickForcesSelection: true,
        macOptionIsMeta: false,
        minimumContrastRatio: 1,
        reflowCursorLine: false,
        rightClickSelectsWord: true,
        scrollback: 1000,
        scrollOnUserInput: true,
        scrollSensitivity: 1,
        smoothScrollDuration: VSCODE_TERMINAL_SMOOTH_SCROLL_DURATION_MS,
        tabStopWidth: 8,
        theme: cursorDarkTerminalTheme,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      loadOptionalAddons(terminal);

      const isMac = window.electronAPI?.platform === 'darwin'
        || /mac|iphone|ipod|ipad/i.test(navigator.platform);

      terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;

        // Saved-password offer active: Enter pastes it (Tabby-style); any other
        // key dismisses the offer. Resolved + written entirely in main; never
        // crosses here.
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
          const key = ev.key.toLowerCase();

          if (ev.key === 'ArrowLeft') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x01');
            return false;
          }
          if (ev.key === 'ArrowRight') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x05');
            return false;
          }
          if (ev.key === 'ArrowUp') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1b[1;5A');
            return false;
          }
          if (ev.key === 'ArrowDown') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1b[1;5B');
            return false;
          }

          if (key === 'a') {
            consumeTerminalShortcut(ev);
            terminal.selectAll();
            return false;
          }

          // NB: ⌘K is intentionally NOT handled here — it's claimed app-wide for
          // the Fast chat palette and intercepted in the main process
          // (before-input-event) before it ever reaches xterm. Use Ctrl+L to
          // clear the screen instead.

          if (ev.key === 'Backspace') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\u0015');
            return false;
          }

          if (key === 'c') {
            consumeTerminalShortcut(ev);
            const selection = terminal.hasSelection() ? terminal.getSelection() : '';
            if (selection) {
              void writeClipboardText(selection);
              return false;
            }
            sendData(sessionIdRef.current, '\x03');
            return false;
          }

          if (key === 'v') {
            consumeTerminalShortcut(ev);
            pasteClipboardIntoTerminal(terminal, (data) => sendData(sessionIdRef.current, data), sessionMetaRef.current);
            return false;
          }

          // Let app-level Cmd shortcuts such as zoom continue through.
          return true;
        }

        // Windows/Linux terminal convention: Ctrl+Shift+V pastes, Ctrl+Shift+C
        // copies the selection (plain Ctrl+V/Ctrl+C stay as the control codes the
        // shell expects). xterm doesn't bind these itself, so handle them here.
        if (!isMac && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
          const key = ev.key.toLowerCase();
          if (key === 'v') {
            consumeTerminalShortcut(ev);
            pasteClipboardIntoTerminal(terminal, (data) => sendData(sessionIdRef.current, data), sessionMetaRef.current);
            return false;
          }
          if (key === 'c') {
            const selection = terminal.hasSelection() ? terminal.getSelection() : '';
            if (selection) {
              consumeTerminalShortcut(ev);
              void writeClipboardText(selection);
              return false;
            }
          }
        }

        if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
          if (ev.key === 'ArrowLeft') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1bb');
            return false;
          }
          if (ev.key === 'ArrowRight') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1bf');
            return false;
          }
          if (ev.key === 'Backspace') {
            consumeTerminalShortcut(ev);
            sendData(sessionIdRef.current, '\x1b\x7f');
            return false;
          }
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
      };
      terminalCache.set(containerId, cached);
      createdNow = true;
    }

    const terminal = cached.terminal;
    terminalRef.current = terminal;
    fitAddonRef.current = cached.fitAddon;
    terminal.options.smoothScrollDuration = VSCODE_TERMINAL_SMOOTH_SCROLL_DURATION_MS;
    const firstComponentMount = !mountedOnceRef.current;
    mountedOnceRef.current = true;
    const sessionChanged = cached.sessionId !== session.id;
    if (sessionChanged) {
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
    const writeState = {
      pending: '',
      raf: null as number | null,
      writing: false,
    };
    const schedulePendingWrite = () => {
      if (writeState.raf !== null || writeState.writing) return;
      writeState.raf = requestAnimationFrame(flushPendingWrite);
    };
    const flushPendingWrite = () => {
      writeState.raf = null;
      if (isDisposed || writeState.writing || !writeState.pending) return;

      const data = writeState.pending;
      writeState.pending = '';
      writeState.writing = true;
      const startedAt = performance.now();
      terminal.write(data, () => {
        metricsRef.current.renderWriteCalls += 1;
        metricsRef.current.renderWriteChars += data.length;
        metricsRef.current.renderWriteMsTotal += performance.now() - startedAt;
        writeState.writing = false;
        if (writeState.pending) schedulePendingWrite();
        publishRendererMetrics();
      });
    };
    const registerLiveWriter = () => {
      if (isDisposed || writerRegistered) return;
      writerRegistered = true;
      registerWriter(sessionIdRef.current, (data: string) => {
        writeState.pending += data;
        schedulePendingWrite();
      });
    };

    const hydrateFromBackendBuffer = async (allowHistoryFallback: boolean) => {
      try {
        const buf = await getBuffer(sessionIdRef.current);
        if (isDisposed || terminalRef.current !== terminal) return;
        terminal.reset();
        if (buf) {
          writeState.pending += buf;
          schedulePendingWrite();
        } else if (allowHistoryFallback) {
          const history = getLastLines(historyOutput ?? '', historyLinesToReplay);
          if (history) {
            writeState.pending += history;
            schedulePendingWrite();
          }
        }
      } catch {
        if (!allowHistoryFallback || isDisposed || terminalRef.current !== terminal) return;
        const history = getLastLines(historyOutput ?? '', historyLinesToReplay);
        if (history) {
          writeState.pending += history;
          schedulePendingWrite();
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
      if (!createdNow && !sessionChanged && !firstComponentMount) {
        registerLiveWriter();
        if (visibleRef.current) {
          scheduleFit(true);
        }
        return;
      }
      void hydrateFromBackendBuffer(true).finally(() => {
        registerLiveWriter();
      });
    });

    // Re-fit + force-sync the PTY size after layout settles. Two passes cover
    // slow first layouts (notably a single full-window terminal, which has no
    // later split/resize to self-heal the 80x24 spawn size).
    const safetyFitTimer = window.setTimeout(() => {
      doFit();
      syncPtySize();
    }, 200);
    const safetyFitTimer2 = window.setTimeout(() => {
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
      window.clearTimeout(safetyFitTimer);
      window.clearTimeout(safetyFitTimer2);
      if (zoomSettleTimer !== null) {
        window.clearTimeout(zoomSettleTimer);
      }
      if (pendingFitRafRef.current !== null) {
        cancelAnimationFrame(pendingFitRafRef.current);
        pendingFitRafRef.current = null;
      }
      if (writeState.raf !== null) {
        cancelAnimationFrame(writeState.raf);
        writeState.raf = null;
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
    containerId,
    session.id,
    sendData,
    resize,
    getBuffer,
    registerWriter,
    unregisterWriter,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.options.fontSize === zoomLevel) return;
    terminal.options.fontSize = zoomLevel;
    scheduleFit(true);
  }, [zoomLevel]);

  // Hold a budgeted WebGL context only while this pane is visible; release it
  // when hidden so the active workspace's terminals get the GPU slots (and the
  // process never exhausts Chromium's WebGL-context limit). See
  // acquireWebglRenderer for why this prevents the crash-and-recover cascade.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!visible) { releaseWebglRenderer(terminal); return; }
    // Defer acquisition to a microtask so that, on a workspace switch, every
    // pane that became hidden in the same commit releases its slot first
    // (effect order across panes isn't guaranteed) — otherwise a now-visible
    // terminal could lose the race for the budget and needlessly stay on DOM.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && visibleRef.current && terminalRef.current === terminal) {
        acquireWebglRenderer(terminal);
      }
    });
    return () => { cancelled = true; };
  }, [visible]);

  useEffect(() => {
    if (!visibleRef.current) return;
    scheduleFit(true);
    const terminal = terminalRef.current;
    if (!terminal) return;
    const endRow = terminal.rows - 1;
    if (endRow < 0) return;
    try {
      const startedAt = performance.now();
      terminal.refresh(0, endRow);
      metricsRef.current.refreshCalls += 1;
      metricsRef.current.refreshMsTotal += performance.now() - startedAt;
      publishRendererMetrics();
    } catch {
      // Best effort after workspace reparent.
    }
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
      // xterm has no public cell-size API; derive it from the screen layer,
      // which is sized to exactly rows × cols cells.
      const screen = host.querySelector<HTMLElement>('.xterm-screen');
      if (!screen || !terminal.rows || !terminal.cols) return;
      const screenRect = screen.getBoundingClientRect();
      const buf = terminal.buffer.active;
      setHintAnchor(
        computeSshHintAnchor({
          cursorX: buf.cursorX,
          cursorY: buf.cursorY,
          cellWidth: screenRect.width / terminal.cols,
          cellHeight: screenRect.height / terminal.rows,
          hostRect: host.getBoundingClientRect(),
          rootRect: root.getBoundingClientRect(),
        }),
      );
    };
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
        className="xterm-terminal-host"
        onMouseDown={() => terminalRef.current?.focus()}
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
          minHeight: 0,
          background: '#141414',
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

import React, { useRef, useCallback, useEffect, useMemo, useState, useLayoutEffect, useContext, createContext } from 'react';
import { PlusSquareIcon } from './Icons';
import type { LayoutNode, SplitNode, SplitDirection, Container, QuickChatHotkey } from '../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../shared/runtime-flags';
import { defaultFocusModeHotkey, hotkeyMatchesInput } from '../../shared/quick-chat-hotkey';
import { isCapturingHotkey } from '../hotkeyCapture';

const MIN_RATIO = 0.1;
const HANDLE_SIZE = 6;

// --- Focus mode ---
// Expands one container over the whole grid (visually overlaying the others)
// WITHOUT touching the layout tree or reparenting any DOM: the chosen LeafCell is
// simply lifted to `position: fixed` at the grid's rect, so terminals/IDE/browser
// /SQL keep running untouched and exiting just clears the id. Transient (resets
// when the grid remounts on workspace switch); never persisted.
interface GridRect { top: number; left: number; width: number; height: number; }
interface FocusModeValue {
  focusModeId: string | null;
  gridRect: GridRect | null;
  toggle: (containerId: string) => void;
}
const FocusModeContext = createContext<FocusModeValue>({ focusModeId: null, gridRect: null, toggle: () => {} });

// Tiny inline glyphs for the focus toggle (no matching entry in Icons.tsx).
const ExpandGlyph: React.FC = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-5 5M2.5 13.5l5-5" />
  </svg>
);
const CompressGlyph: React.FC = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </svg>
);

// Open/close animation for focus mode (expand the container + fade the backdrop).
const FOCUS_ANIM_MS = 220;
const FOCUS_ANIM_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The cell is lifted to the full grid rect immediately (so its content lays out
// once, at full size — no scaling, no mid-animation refit). The open/close is a
// clip-path REVEAL: this is the inset that clips the full cell down to just its
// tile rect; animating between it and `inset(0)` grows/shrinks the visible area
// between the tile and full-screen, leaving the content itself untouched.
const FULL_CLIP = 'inset(0px round 8px)';
function tileClip(from: GridRect, to: GridRect): string {
  const top = Math.max(0, from.top - to.top);
  const left = Math.max(0, from.left - to.left);
  const right = Math.max(0, (to.left + to.width) - (from.left + from.width));
  const bottom = Math.max(0, (to.top + to.height) - (from.top + from.height));
  return `inset(${top}px ${right}px ${bottom}px ${left}px round 8px)`;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// --- Props ---

interface WorkspaceGridProps {
  tree: LayoutNode | null;
  containers: Container[];
  zoomLevels: Record<string, number>;
  focusedContainerId: string | null;
  onTreeChange: (tree: LayoutNode) => void;
  onZoomChange: (containerId: string, zoomLevel: number) => void;
  onFocusedContainerChange: (containerId: string | null) => void;
  onSplit: (containerId: string, direction: SplitDirection, position: 'before' | 'after') => void;
  onClose: (containerId: string) => void;
  onSwap: (id1: string, id2: string) => void;
  onAddFirst: () => void;
  renderContent: (container: Container, onSplitRight: () => void, onSplitDown: () => void, zoomLevel: number) => React.ReactNode;
  /** Configured focus-mode toggle chord. Undefined → platform default. */
  focusModeHotkey?: QuickChatHotkey;
}

// --- Leaf cell ---

function LeafCell({
  containerId,
  containerMap,
  zoomLevel,
  onSplit,
  renderContent,
  onDragStart,
}: {
  containerId: string;
  containerMap: Map<string, Container>;
  zoomLevel: number;
  onSplit: (containerId: string, direction: SplitDirection, position: 'before' | 'after') => void;
  renderContent: (container: Container, onSplitRight: () => void, onSplitDown: () => void, zoomLevel: number) => React.ReactNode;
  onDragStart: (containerId: string, e: MouseEvent) => void;
}) {
  const container = containerMap.get(containerId);
  const cellRef = useRef<HTMLDivElement>(null);
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const focus = useContext(FocusModeContext);
  const isFocused = focus.focusModeId === containerId;
  const [hovered, setHovered] = useState(false);
  const toggleRef = useRef(focus.toggle);
  toggleRef.current = focus.toggle;

  // Native mousedown listener so portal children (IDE) are included
  // in the DOM bubble path — React synthetic events skip portals.
  // A double-click on the drag-handle header toggles focus mode (same path).
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const inHeader = (e: MouseEvent): boolean => {
      let target = e.target as HTMLElement | null;
      while (target && target !== el) {
        if (target.classList.contains('container-drag-handle')) return true;
        target = target.parentElement;
      }
      return false;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (inHeader(e)) onDragStartRef.current(containerId, e);
    };
    const onDoubleClick = (e: MouseEvent) => {
      // Ignore double-clicks on header controls (close/split/etc.).
      if ((e.target as HTMLElement)?.closest('button, input, textarea, select, a')) return;
      if (inHeader(e)) { e.preventDefault(); toggleRef.current(containerId); }
    };
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('dblclick', onDoubleClick);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('dblclick', onDoubleClick);
    };
  }, [containerId]);

  // Toggle the focus-mode class imperatively (NOT via React's className) so it
  // doesn't clobber the `container-focused` / `drag-source` classes that
  // WorkspaceGrid manages on the same element with classList. Layout effect so
  // the gradient frame lands in the same frame as the fixed-position style.
  useLayoutEffect(() => {
    cellRef.current?.classList.toggle('container-focus-mode', isFocused);
  }, [isFocused]);

  if (!container) return null;

  // In focus mode this cell is lifted to fixed positioning over the grid rect,
  // overlaying the others. No DOM move happens (the same node just gets new CSS),
  // so the live terminal/IDE/webview keeps running — it only resizes.
  const focusStyle: React.CSSProperties = isFocused && focus.gridRect
    ? {
        // The purple glow frame is a separate overlay element (.focus-mode-glow)
        // on its own layer so it works over a terminal's GPU canvas; box-border
        // keeps the cell exactly the grid's size.
        position: 'fixed', boxSizing: 'border-box',
        top: focus.gridRect.top, left: focus.gridRect.left,
        width: focus.gridRect.width, height: focus.gridRect.height,
        zIndex: 1001, overflow: 'hidden',
      }
    : { position: 'relative', width: '100%', height: '100%' };

  return (
    <div
      ref={cellRef}
      data-container-id={containerId}
      data-content-type={container.content.type}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...focusStyle, '--container-font-size': `${zoomLevel}px` } as React.CSSProperties}
    >
      {renderContent(
        container,
        () => onSplit(containerId, 'horizontal', 'after'),
        () => onSplit(containerId, 'vertical', 'after'),
        zoomLevel
      )}
      {/* Pulsing purple glow frame — only while focused. Its own compositing
          layer keeps it above the GPU canvas; the pulse is opacity-only (cheap). */}
      {isFocused && <div className="focus-mode-glow" aria-hidden="true" />}
      {(hovered || isFocused) && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleRef.current(containerId); }}
          title={isFocused ? 'Exit focus (⌘/Ctrl+Shift+F)' : 'Focus this container (⌘/Ctrl+Shift+F)'}
          style={{
            position: 'absolute', right: 8, bottom: 8, zIndex: 1002,
            width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)', opacity: 0.85,
            // Own compositing layer so it stays above a terminal's GPU canvas.
            transform: 'translateZ(0)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          {isFocused ? <CompressGlyph /> : <ExpandGlyph />}
        </button>
      )}
    </div>
  );
}

// --- Split pane with resize handle ---

function SplitPane({
  node,
  onNodeChange,
  containerMap,
  zoomLevels,
  onSplit,
  renderContent,
  onDragStart,
}: {
  node: SplitNode;
  onNodeChange: (node: LayoutNode) => void;
  containerMap: Map<string, Container>;
  zoomLevels: Map<string, number>;
  onSplit: (containerId: string, direction: SplitDirection, position: 'before' | 'after') => void;
  renderContent: (container: Container, onSplitRight: () => void, onSplitDown: () => void, zoomLevel: number) => React.ReactNode;
  onDragStart: (containerId: string, e: MouseEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef(node);
  const onNodeChangeRef = useRef(onNodeChange);
  nodeRef.current = node;
  onNodeChangeRef.current = onNodeChange;

  const isHoriz = node.direction === 'horizontal';

  const handleRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = containerRef.current!.getBoundingClientRect();
      const startOffset = isHoriz ? rect.left : rect.top;
      const size = isHoriz ? rect.width : rect.height;
      const handle = handleRef.current;
      const activeLine = isHoriz
        ? `linear-gradient(to right, transparent calc(50% - 1px), var(--text-muted) calc(50% - 1px), var(--text-muted) calc(50% + 1px), transparent calc(50% + 1px))`
        : `linear-gradient(to bottom, transparent calc(50% - 1px), var(--text-muted) calc(50% - 1px), var(--text-muted) calc(50% + 1px), transparent calc(50% + 1px))`;
      if (handle) handle.style.background = activeLine;

      const onMove = (ev: MouseEvent) => {
        const pos = isHoriz ? ev.clientX : ev.clientY;
        const newRatio = clamp((pos - startOffset) / size, MIN_RATIO, 1 - MIN_RATIO);
        onNodeChangeRef.current({ ...nodeRef.current, ratio: newRatio });
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Re-enable browser-overlay pointer events now the drag is over.
        window.dispatchEvent(new CustomEvent('splitgrid:resize-active', { detail: { active: false } }));
        const restoreLine = isHoriz
          ? `linear-gradient(to right, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))`
          : `linear-gradient(to bottom, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))`;
        if (handle) handle.style.background = restoreLine;
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = isHoriz ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      // A browser pane's <webview> floats above the grid and would swallow the
      // mousemove the moment the cursor leaves the thin splitter, aborting the
      // resize. Drop pointer events on every browser overlay for the duration of
      // the drag (mirrors the container-drag `splitgrid:drag-active` pattern).
      window.dispatchEvent(new CustomEvent('splitgrid:resize-active', { detail: { active: true } }));
    },
    [isHoriz]
  );

  const firstStyle: React.CSSProperties = isHoriz
    ? { width: `calc(${node.ratio * 100}% - ${HANDLE_SIZE / 2}px)`, height: '100%' }
    : { height: `calc(${node.ratio * 100}% - ${HANDLE_SIZE / 2}px)`, width: '100%' };

  const thinLine = isHoriz
    ? `linear-gradient(to right, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))`
    : `linear-gradient(to bottom, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))`;

  const handleStyle: React.CSSProperties = {
    flexShrink: 0,
    [isHoriz ? 'width' : 'height']: `${HANDLE_SIZE}px`,
    cursor: isHoriz ? 'col-resize' : 'row-resize',
    background: thinLine,
    zIndex: 5,
    position: 'relative' as const,
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isHoriz ? 'row' : 'column',
        width: '100%',
        height: '100%',
      }}
    >
      <div style={{ ...firstStyle, overflow: 'hidden' }}>
        <TilingNode
          node={node.first}
          onNodeChange={(n) => onNodeChangeRef.current({ ...nodeRef.current, first: n })}
          containerMap={containerMap}
          zoomLevels={zoomLevels}
          onSplit={onSplit}
          renderContent={renderContent}
          onDragStart={onDragStart}
        />
      </div>
      <div
        ref={handleRef}
        style={handleStyle}
        onMouseDown={handleResizeStart}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TilingNode
          node={node.second}
          onNodeChange={(n) => onNodeChangeRef.current({ ...nodeRef.current, second: n })}
          containerMap={containerMap}
          zoomLevels={zoomLevels}
          onSplit={onSplit}
          renderContent={renderContent}
          onDragStart={onDragStart}
        />
      </div>
    </div>
  );
}

// --- Recursive node renderer ---

function TilingNode({
  node,
  onNodeChange,
  containerMap,
  zoomLevels,
  onSplit,
  renderContent,
  onDragStart,
}: {
  node: LayoutNode;
  onNodeChange: (node: LayoutNode) => void;
  containerMap: Map<string, Container>;
  zoomLevels: Map<string, number>;
  onSplit: (containerId: string, direction: SplitDirection, position: 'before' | 'after') => void;
  renderContent: (container: Container, onSplitRight: () => void, onSplitDown: () => void, zoomLevel: number) => React.ReactNode;
  onDragStart: (containerId: string, e: MouseEvent) => void;
}) {
  if (node.type === 'leaf') {
    return (
      <LeafCell
        key={node.containerId}
        containerId={node.containerId}
        containerMap={containerMap}
        zoomLevel={zoomLevels.get(node.containerId) ?? 13}
        onSplit={onSplit}
        renderContent={renderContent}
        onDragStart={onDragStart}
      />
    );
  }

  return (
    <SplitPane
      node={node}
      onNodeChange={onNodeChange}
      containerMap={containerMap}
      zoomLevels={zoomLevels}
      onSplit={onSplit}
      renderContent={renderContent}
      onDragStart={onDragStart}
    />
  );
}

// --- Main grid component ---

export const WorkspaceGrid: React.FC<WorkspaceGridProps> = ({
  tree,
  containers,
  zoomLevels,
  focusedContainerId,
  onTreeChange,
  onZoomChange,
  onFocusedContainerChange,
  onSplit,
  onSwap,
  onAddFirst,
  renderContent,
  focusModeHotkey,
}) => {
  const gridRootRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<LayoutNode | null>(tree);
  const dragRef = useRef<{ sourceId: string; overId: string | null } | null>(null);
  const lastInteractionInGridRef = useRef(false);
  const zoomLevelsRef = useRef(zoomLevels);
  zoomLevelsRef.current = zoomLevels;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const focusedIdRef = useRef<string | null>(focusedContainerId);
  const onFocusedContainerChangeRef = useRef(onFocusedContainerChange);
  onFocusedContainerChangeRef.current = onFocusedContainerChange;
  const containersRef = useRef(containers);
  containersRef.current = containers;
  const [, rerender] = React.useState(0);

  // --- Focus mode state ---
  const [focusModeId, setFocusModeId] = useState<string | null>(null);
  const [gridRect, setGridRect] = useState<GridRect | null>(null);
  const focusModeIdRef = useRef<string | null>(null);
  focusModeIdRef.current = focusModeId;
  const prevFocusModeIdRef = useRef<string | null>(null);
  // Animation plumbing.
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const enterAnimPendingRef = useRef(false);
  const exitingRef = useRef(false);
  const exitAnimRef = useRef<Animation | null>(null);
  const fromRectRef = useRef<GridRect | null>(null); // the focused cell's tile rect (FLIP origin)
  const gridRectRef = useRef<GridRect | null>(null);
  gridRectRef.current = gridRect;

  // Return DOM/input focus to a container's interactive element (so typing keeps
  // working). Covers every type: xterm textarea, Monaco input, the browser
  // <webview>, or a SQL input — falling back to any focusable child.
  const focusContainerDom = useCallback((containerId: string) => {
    // Rich panes (browser <webview>, Monaco) ignore a raw element .focus() — they
    // listen for this and focus their real instance instead.
    window.dispatchEvent(new CustomEvent('splitgrid:focus-container', { detail: { containerId } }));
    // Plain DOM focus covers terminals (xterm textarea) and SQL inputs.
    const cell = document.querySelector(`[data-container-id="${containerId}"]`);
    if (!cell) return;
    const selectors = ['.xterm-helper-textarea', 'textarea', 'input', '[tabindex]'];
    for (const s of selectors) {
      const t = cell.querySelector(s) as HTMLElement | null;
      if (t) { t.focus(); return; }
    }
  }, []);

  // Entering/exiting focus mode steals DOM focus (FAB / backdrop / the lift
  // itself), so re-focus the relevant container — entering: the focused one;
  // exiting: the one we just left. Re-assert a couple of times because the cell's
  // resize/refit (and the portal-target ref cycle) can blur it again a beat after
  // the state change; skip if focus is already inside the target so we never yank
  // focus the user has since moved elsewhere.
  useEffect(() => {
    const prev = prevFocusModeIdRef.current;
    prevFocusModeIdRef.current = focusModeId;
    const target = focusModeId ?? prev;
    if (!target) return;
    // Immediate attempt is unconditional (covers a browser pane whose host still
    // reports the <webview> as active but whose guest needs re-focusing); the
    // later re-asserts only fire if focus drifted out of the target, so they
    // never yank focus the user has since moved elsewhere.
    const focusIfDrifted = () => {
      const ae = document.activeElement as HTMLElement | null;
      const inTarget = ae?.closest?.('[data-container-id]')?.getAttribute('data-container-id') === target;
      if (!inTarget) focusContainerDom(target);
    };
    const raf = requestAnimationFrame(() => focusContainerDom(target));
    const t1 = window.setTimeout(focusIfDrifted, 90);
    const t2 = window.setTimeout(focusIfDrifted, 260);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [focusModeId, focusContainerDom]);

  const measureGrid = useCallback(() => {
    const el = gridRootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setGridRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, []);

  const enterFocus = useCallback((containerId: string) => {
    exitingRef.current = false;
    enterAnimPendingRef.current = true; // the open animation plays once the cell is lifted
    // Capture the tile rect now (before the cell is lifted) as the FLIP origin.
    const el = document.querySelector(`[data-container-id="${containerId}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      fromRectRef.current = { top: r.top, left: r.left, width: r.width, height: r.height };
    } else {
      fromRectRef.current = null;
    }
    // Clear any stale rect so the open animation only fires once the grid has
    // been freshly measured (and the cell is actually lifted to it).
    setGridRect(null);
    setFocusModeId(containerId);
  }, []);

  // Play the close animation, then drop focus mode when it finishes (keeps the
  // cell lifted while it collapses back toward its tile).
  const exitFocus = useCallback(() => {
    const id = focusModeIdRef.current;
    if (!id) { setFocusModeId(null); return; }
    if (exitingRef.current) return;
    const el = document.querySelector(`[data-container-id="${id}"]`) as HTMLElement | null;
    const from = fromRectRef.current;
    const to = gridRectRef.current;
    if (!el || !from || !to || prefersReducedMotion()) { setFocusModeId(null); return; }
    exitingRef.current = true;
    backdropRef.current?.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: FOCUS_ANIM_MS, easing: FOCUS_ANIM_EASE, fill: 'forwards' },
    );
    // Collapse the reveal back into the tile before dropping the cell. clip-path
    // only changes the visible area — the content stays full-size and still.
    const anim = el.animate(
      [{ clipPath: FULL_CLIP }, { clipPath: tileClip(from, to) }],
      { duration: FOCUS_ANIM_MS, easing: FOCUS_ANIM_EASE, fill: 'forwards' },
    );
    exitAnimRef.current = anim;
    anim.onfinish = () => { exitingRef.current = false; setFocusModeId(null); };
    anim.oncancel = () => { exitingRef.current = false; };
  }, []);

  const toggleFocus = useCallback((containerId: string) => {
    if (focusModeIdRef.current === containerId) exitFocus(); else enterFocus(containerId);
  }, [enterFocus, exitFocus]);

  // Keep the lifted cell's rect synced with the grid area while focus is on
  // (covers sidebar collapse, window resize, fullscreen).
  useLayoutEffect(() => {
    if (!focusModeId) return;
    measureGrid();
    const el = gridRootRef.current;
    const ro = el ? new ResizeObserver(() => measureGrid()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', measureGrid);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measureGrid); };
  }, [focusModeId, measureGrid]);

  // Drop focus mode if its container goes away (closed / moved out).
  useEffect(() => {
    if (focusModeId && !containers.some((c) => c.id === focusModeId)) setFocusModeId(null);
  }, [containers, focusModeId]);

  // Open animation: once the cell is lifted to the grid rect, expand it from a
  // slightly smaller state and fade the backdrop in. Runs once per enter.
  useLayoutEffect(() => {
    if (!focusModeId || !enterAnimPendingRef.current || !gridRect) return;
    enterAnimPendingRef.current = false;
    backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOCUS_ANIM_MS, easing: FOCUS_ANIM_EASE });
    const from = fromRectRef.current;
    if (prefersReducedMotion() || !from) return;
    const el = document.querySelector(`[data-container-id="${focusModeId}"]`) as HTMLElement | null;
    // Reveal from the tile rect out to full. Only clip-path moves — the content
    // is already laid out at full size and never scales or refits mid-animation.
    el?.animate(
      [{ clipPath: tileClip(from, gridRect) }, { clipPath: FULL_CLIP }],
      { duration: FOCUS_ANIM_MS, easing: FOCUS_ANIM_EASE },
    );
  }, [focusModeId, gridRect]);

  // After exit settles (cell back in its tile), clear the close animation's
  // forwards transform so it doesn't linger on the now-relative cell. Layout
  // effect → happens before paint, so no flash.
  useLayoutEffect(() => {
    if (focusModeId) return;
    exitAnimRef.current?.cancel();
    exitAnimRef.current = null;
  }, [focusModeId]);

  // Toggle focus on the currently-active container (exit if already focused).
  const toggleFocusOnActive = useCallback(() => {
    if (focusModeIdRef.current) { exitFocus(); return; }
    const activeEl = document.activeElement as HTMLElement | null;
    const fromDom = activeEl?.closest('[data-container-id]')?.getAttribute('data-container-id') ?? null;
    const id = fromDom ?? focusedIdRef.current ?? containersRef.current[0]?.id ?? null;
    if (id) enterFocus(id);
  }, [enterFocus, exitFocus]);

  // Focus-mode toggle chord (default ⌘/Ctrl+Shift+F, configurable in Settings).
  // Capture phase so it fires before a terminal/Monaco can swallow the key (same
  // trick as zoom). Keys typed inside a browser pane never reach here — main
  // forwards those via onFocusModeToggle below. Bail while the Settings recorder
  // is capturing so the chord can be recorded instead of toggling focus.
  const hotkey = useMemo(
    () => focusModeHotkey ?? defaultFocusModeHotkey(window.electronAPI.platform),
    [focusModeHotkey]
  );
  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const handler = (e: KeyboardEvent) => {
      if (isCapturingHotkey()) return;
      if (!hotkeyMatchesInput(hotkey, { key: e.key, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFocusOnActive();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggleFocusOnActive, hotkey]);

  // Same shortcut forwarded from inside a browser pane (its keys can't reach the
  // window listener above). document.activeElement is the <webview> element, so
  // toggleFocusOnActive still resolves the right (browser) container.
  useEffect(() => {
    return window.electronAPI.onFocusModeToggle(() => toggleFocusOnActive());
  }, [toggleFocusOnActive]);

  // Sync tree from props when not interacting
  if (!dragRef.current) treeRef.current = tree;

  const containerMap = new Map(containers.map((c) => [c.id, c]));

  const applyWindowZoom = useCallback((direction: 'in' | 'out' | 'reset') => {
    const current = window.electronAPI.getWindowZoom();
    const next =
      direction === 'in'
        ? current + 0.5
        : direction === 'out'
          ? Math.max(-3, current - 0.5)
          : 0;
    window.electronAPI.setWindowZoom(next);
    window.dispatchEvent(new CustomEvent('splitgrid:window-zoom', { detail: { level: next } }));
  }, []);

  const applyContainerZoom = useCallback((direction: 'in' | 'out' | 'reset') => {
    const activeEl = document.activeElement as HTMLElement | null;
    const focusedFromDom =
      activeEl?.closest('[data-container-id]')?.getAttribute('data-container-id') ?? null;
    const focusInsideGrid = !!(activeEl && gridRootRef.current?.contains(activeEl));
    const shouldUseContainerZoom =
      !!focusedFromDom || focusInsideGrid || lastInteractionInGridRef.current;
    const id = focusedFromDom ?? (shouldUseContainerZoom ? focusedIdRef.current : null);

    if (!id || !containersRef.current.some((c) => c.id === id)) {
      applyWindowZoom(direction);
      return;
    }

    const current = zoomLevelsRef.current[id] ?? 13;
    let next: number;
    if (direction === 'in') next = Math.min(28, current + 1);
    else if (direction === 'out') next = Math.max(8, current - 1);
    else next = 13;
    onZoomChangeRef.current(id, next);
  }, [applyWindowZoom]);

  // Zoom: capture-phase keydown — fires before Monaco/terminal input can intercept.
  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      let direction: 'in' | 'out' | 'reset' | null = null;
      if (e.key === '=' || e.key === '+') direction = 'in';
      else if (e.key === '-') direction = 'out';
      else if (e.key === '0') direction = 'reset';
      if (!direction) return;

      e.preventDefault();
      e.stopPropagation();
      applyContainerZoom(direction);
    };
    // Capture phase — fires before any child handler (Monaco, terminal input, etc.).
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [applyContainerZoom]);

  useEffect(() => {
    return window.electronAPI.onContainerZoom((direction) => {
      applyContainerZoom(direction);
    });
  }, [applyContainerZoom]);

  const handleContainerFocus = useCallback((containerId: string | null) => {
    const prevId = focusedIdRef.current;

    // Remove class from previous focused tile when switching focus.
    if (prevId && prevId !== containerId) {
      document.querySelector(`[data-container-id="${prevId}"]`)?.classList.remove('container-focused');
    }

    // Always ensure class is applied for current focus, even when id is unchanged.
    // This is required after workspace switch because the grid remounts with fresh DOM.
    if (containerId) {
      document.querySelector(`[data-container-id="${containerId}"]`)?.classList.add('container-focused');
    }

    focusedIdRef.current = containerId;
    if (prevId !== containerId) {
      onFocusedContainerChangeRef.current(containerId);
    }
  }, []);

  // Restore per-workspace focused container on switch.
  useEffect(() => {
    const hasFocusedContainer =
      !!focusedContainerId && containersRef.current.some((c) => c.id === focusedContainerId);
    handleContainerFocus(hasFocusedContainer ? focusedContainerId : null);
  }, [focusedContainerId, containers, handleContainerFocus]);

  // Entering focus mode makes that container the focused one, so exiting leaves
  // focus on it (rather than on whatever was active before).
  useEffect(() => {
    if (focusModeId) handleContainerFocus(focusModeId);
  }, [focusModeId, handleContainerFocus]);

  const onTreeChangeRef = useRef(onTreeChange);
  onTreeChangeRef.current = onTreeChange;

  // Drag-to-swap with floating ghost clone of the full container
  const handleDragStart = useCallback(
    (containerId: string, e: MouseEvent) => {
      e.preventDefault();
      dragRef.current = { sourceId: containerId, overId: null };

      const srcEl = document.querySelector(`[data-container-id="${containerId}"]`) as HTMLElement | null;
      if (!srcEl) return;
      srcEl.classList.add('drag-source');

      // Let floating browser overlays drop pointer events so elementFromPoint
      // below can hit-test the grid cells they cover.
      window.dispatchEvent(new CustomEvent('splitgrid:drag-active', { detail: { active: true } }));

      const srcRect = srcEl.getBoundingClientRect();
      // A browser's cell is an empty placeholder (the webview floats on <body>);
      // clone the overlay instead so the drag ghost shows the actual page.
      const ghostSrc = (document.querySelector(`[data-browser-overlay="${containerId}"]`) as HTMLElement | null) ?? srcEl;

      // Thumbnail scale — fit into max 280x200 preview
      const GHOST_MAX_W = 280;
      const GHOST_MAX_H = 200;
      const scale = Math.min(1, GHOST_MAX_W / srcRect.width, GHOST_MAX_H / srcRect.height);
      const ghostW = srcRect.width * scale;
      const ghostH = srcRect.height * scale;

      // Clone the entire container visually
      const ghost = ghostSrc.cloneNode(true) as HTMLElement;
      ghost.className = 'drag-ghost';
      // Strip interactive elements to avoid side effects
      ghost.querySelectorAll('textarea, input, iframe, canvas, video').forEach((el) => {
        (el as HTMLElement).style.visibility = 'hidden';
      });
      // A cloned <webview> would instantiate a real second guest on insert —
      // remove it entirely (the cloned browser chrome above it is enough preview).
      ghost.querySelectorAll('webview').forEach((el) => el.remove());
      // Render at original size, then scale down via CSS transform
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${e.clientX - ghostW / 2}px`,
        top: `${e.clientY - ghostH / 2}px`,
        width: `${srcRect.width}px`,
        height: `${srcRect.height}px`,
        transformOrigin: 'top left',
        transform: `scale(${scale})`,
        borderRadius: `${8 / scale}px`,
        overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
        pointerEvents: 'none',
        zIndex: '9999',
        opacity: '0',
        transition: 'opacity 0.15s ease',
      });
      document.body.appendChild(ghost);
      // Fade in
      requestAnimationFrame(() => {
        ghost.style.opacity = '0.92';
      });

      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        // Center ghost under cursor
        ghost.style.left = `${ev.clientX - ghostW / 2}px`;
        ghost.style.top = `${ev.clientY - ghostH / 2}px`;
        // Kill transition after first frame so it tracks 1:1
        ghost.style.transition = 'none';

        // Detect target — temporarily hide ghost so elementFromPoint sees through it
        ghost.style.display = 'none';
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        ghost.style.display = '';

        const containerEl = el?.closest('[data-container-id]') as HTMLElement | null;
        const newOverId = containerEl?.dataset.containerId ?? null;

        if (dragRef.current!.overId !== newOverId) {
          if (dragRef.current!.overId) {
            document.querySelector(`[data-container-id="${dragRef.current!.overId}"]`)?.classList.remove('drag-target');
          }
          if (newOverId && newOverId !== dragRef.current!.sourceId) {
            document.querySelector(`[data-container-id="${newOverId}"]`)?.classList.add('drag-target');
          }
          dragRef.current!.overId = newOverId;
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.dispatchEvent(new CustomEvent('splitgrid:drag-active', { detail: { active: false } }));
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        const state = dragRef.current;
        const targetId = state?.overId;
        const didSwap = !!(targetId && targetId !== state?.sourceId);

        // Animate ghost out
        ghost.style.transition = 'all 0.2s ease';
        ghost.style.opacity = '0';
        ghost.style.transform = `scale(${scale * 0.9})`;
        setTimeout(() => ghost.remove(), 220);

        document.querySelectorAll('.drag-source, .drag-target').forEach((el) => {
          el.classList.remove('drag-source', 'drag-target');
        });

        if (didSwap) {
          onSwap(state!.sourceId, targetId!);
        }
        dragRef.current = null;
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [onSwap]
  );

  // Bridge from <BrowserPortal>: a browser pane's <webview> floats on <body>,
  // outside the grid cell, so its header drag and dbl-click focus-toggle can't
  // reach the cell-level listeners — they're forwarded as window events.
  useEffect(() => {
    const onBrowserDrag = (e: Event) => {
      const detail = (e as CustomEvent<{ containerId?: string; event?: MouseEvent }>).detail;
      if (detail?.containerId && detail.event) handleDragStart(detail.containerId, detail.event);
    };
    const onBrowserToggleFocus = (e: Event) => {
      const id = (e as CustomEvent<{ containerId?: string }>).detail?.containerId;
      if (id) toggleFocus(id);
    };
    window.addEventListener('splitgrid:browser-drag-start', onBrowserDrag);
    window.addEventListener('splitgrid:browser-toggle-focus', onBrowserToggleFocus);
    return () => {
      window.removeEventListener('splitgrid:browser-drag-start', onBrowserDrag);
      window.removeEventListener('splitgrid:browser-toggle-focus', onBrowserToggleFocus);
    };
  }, [handleDragStart, toggleFocus]);

  const handleNodeChangeAndCommit = useCallback(
    (newTree: LayoutNode) => {
      treeRef.current = newTree;
      rerender((n) => n + 1);
      // Debounce commit (the last update before mouseup will be committed)
      onTreeChangeRef.current(newTree);
    },
    []
  );

  // Single native capture-phase listener for ALL focus management
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      lastInteractionInGridRef.current = !!(gridRootRef.current && gridRootRef.current.contains(target));
      const containerEl = target.closest('[data-container-id]') as HTMLElement | null;
      if (containerEl) {
        const containerId = containerEl.dataset.containerId!;
        handleContainerFocus(containerId);

        const container = containersRef.current.find((c) => c.id === containerId);
        if (container?.content.type === 'ide') {
          // Track IDE active panel at native capture phase (works with portals reliably).
          if (target.closest('.ide-file-explorer')) {
            containerEl.setAttribute('data-ide-active-panel', 'sidebar');
          } else if (target.closest('.monaco-editor') || target.closest('[data-ide-editor]')) {
            containerEl.setAttribute('data-ide-active-panel', 'editor');
          }
        } else {
          containerEl.removeAttribute('data-ide-active-panel');
        }
      }
    };
    // Native capture phase — fires before React, Monaco, terminal input, everything.
    window.addEventListener('mousedown', handler, true);
    return () => window.removeEventListener('mousedown', handler, true);
  }, [handleContainerFocus]);

  useEffect(() => {
    const handler = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      lastInteractionInGridRef.current = !!(gridRootRef.current && gridRootRef.current.contains(target));
      const containerId = target.closest('[data-container-id]')?.getAttribute('data-container-id') ?? null;
      if (containerId) handleContainerFocus(containerId);
    };
    window.addEventListener('focusin', handler, true);
    return () => window.removeEventListener('focusin', handler, true);
  }, [handleContainerFocus]);

  const currentTree = treeRef.current;

  // --- Empty state ---
  if (!currentTree) {
    return (
      <div
        ref={gridRootRef}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div style={{ fontSize: '32px', fontWeight: 700, color: 'var(--bg-surface)', letterSpacing: '-1px' }}>
          SplitGrid
        </div>
        <button
          onClick={onAddFirst}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          <PlusSquareIcon size={16} />
          Add Container
        </button>
      </div>
    );
  }

  // --- Render tiling tree ---
  return (
    <FocusModeContext.Provider value={{ focusModeId, gridRect, toggle: toggleFocus }}>
      <div ref={gridRootRef} style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <TilingNode
          node={currentTree}
          onNodeChange={handleNodeChangeAndCommit}
          containerMap={containerMap}
          zoomLevels={new Map(Object.entries(zoomLevels))}
          onSplit={onSplit}
          renderContent={renderContent}
          onDragStart={handleDragStart}
        />
        {/* Focus-mode backdrop: dims/hides the other (still-running) containers;
            click anywhere on it exits. Sits under the lifted cell (z 1001). */}
        {focusModeId && (
          <div
            ref={backdropRef}
            onClick={() => exitFocus()}
            style={{
              // A plain dark overlay dims the background containers; no
              // backdrop-filter blur — that re-runs a full-screen GPU blur on
              // every frame the (still-running) background terminals repaint,
              // which throttles the machine while focus mode is held.
              position: 'absolute', inset: 0, zIndex: 1000,
              background: 'rgba(0,0,0,0.6)', cursor: 'zoom-out',
            }}
          />
        )}
      </div>
    </FocusModeContext.Provider>
  );
};

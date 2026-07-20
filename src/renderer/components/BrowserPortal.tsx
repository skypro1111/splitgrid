import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { GridBrowser } from './GridBrowser';
import type { Container } from '../../shared/types';

interface BrowserPortalProps {
  container: Container;
  /** Owning workspace — used by the parent to compute `visible`. */
  workspaceId: string;
  visible: boolean;
  zoomLevel: number;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onUrlChange: (url: string) => void;
  onRequestFocus?: (containerId: string) => void;
}

/**
 * Persistent floating host for a browser pane's <webview>.
 *
 * A <webview> reloads its guest page whenever its DOM node is reparented, so the
 * reparenting portal used for terminals/IDE would refresh the page on every
 * workspace switch. Instead we mount a stable wrapper directly on <body> (never
 * moved) and float it over the `[data-browser-target]` placeholder rendered by
 * the active workspace's grid, tracking that placeholder's geometry each frame.
 * When the owning workspace isn't active the placeholder is absent, so the
 * wrapper hides — the webview stays alive the whole time, never reloading.
 *
 * Because the wrapper lives outside the grid cell, header drag and the
 * double-click focus-toggle are bridged to <WorkspaceGrid> via window events
 * (`splitgrid:browser-drag-start` / `splitgrid:browser-toggle-focus`), and pointer
 * events are dropped while a container drag is in flight so the grid's drop
 * detection (elementFromPoint) can see the cells underneath.
 */
export const BrowserPortal: React.FC<BrowserPortalProps> = ({
  container,
  visible,
  zoomLevel,
  onClose,
  onSplitRight,
  onSplitDown,
  onUrlChange,
  onRequestFocus,
}) => {
  const containerId = container.id;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dimRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;

  if (!wrapperRef.current) {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.overflow = 'hidden';
    el.style.display = 'none';
    el.style.contain = 'strict';
    el.setAttribute('data-browser-overlay', containerId);
    wrapperRef.current = el;
  }

  // Mount the wrapper on <body> once; never reparent it (that reloads webview).
  useEffect(() => {
    const el = wrapperRef.current!;
    document.body.appendChild(el);
    return () => { el.remove(); };
  }, []);

  // Header drag + dbl-click focus bridge, plus focus-on-click. The wrapper isn't
  // a grid-cell descendant, so these can't bubble to WorkspaceGrid's listeners.
  useEffect(() => {
    const el = wrapperRef.current!;
    const inDragHandle = (target: EventTarget | null): boolean => {
      const t = target as HTMLElement | null;
      if (!t) return false;
      if (t.closest('button, input, textarea, select, a')) return false;
      return !!t.closest('.container-drag-handle');
    };
    const onMouseDown = (e: MouseEvent) => {
      onRequestFocusRef.current?.(containerId);
      if (e.button === 0 && inDragHandle(e.target)) {
        window.dispatchEvent(new CustomEvent('splitgrid:browser-drag-start', {
          detail: { containerId, event: e },
        }));
      }
    };
    const onDblClick = (e: MouseEvent) => {
      if (inDragHandle(e.target)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('splitgrid:browser-toggle-focus', {
          detail: { containerId },
        }));
      }
    };
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [containerId]);

  // Drop pointer events during a container drag (so the grid can hit-test cells)
  // and during a splitter resize (so the cursor leaving the thin divider onto
  // the webview doesn't swallow the mousemove and abort the drag).
  useEffect(() => {
    const onDragActive = (e: Event) => {
      const active = (e as CustomEvent<{ active?: boolean }>).detail?.active;
      const el = wrapperRef.current;
      if (el) el.style.pointerEvents = active ? 'none' : 'auto';
    };
    window.addEventListener('splitgrid:drag-active', onDragActive);
    window.addEventListener('splitgrid:resize-active', onDragActive);
    return () => {
      window.removeEventListener('splitgrid:drag-active', onDragActive);
      window.removeEventListener('splitgrid:resize-active', onDragActive);
    };
  }, []);

  // Track the placeholder's geometry every frame while visible. rAF (not a
  // ResizeObserver) so the overlay follows splits, pane resizes and the
  // focus-mode lift smoothly; writes happen only when something actually moved.
  useEffect(() => {
    const el = wrapperRef.current!;
    if (!visible) {
      el.style.display = 'none';
      return;
    }

    let raf = 0;
    let last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const target = document.querySelector<HTMLElement>(`[data-browser-target="${containerId}"]`);
      if (!target) {
        if (el.style.display !== 'none') { el.style.display = 'none'; last = ''; }
        return;
      }
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        if (el.style.display !== 'none') { el.style.display = 'none'; last = ''; }
        return;
      }
      const cell = target.closest('[data-container-id]');
      const focusMode = !!cell?.classList.contains('container-focus-mode');
      // The cell's own focus ring (::after) and dim (::before) sit under this
      // floating overlay, so mirror that state onto our own layers instead.
      const focused = !!cell?.classList.contains('container-focused');
      const dragging = !!cell?.classList.contains('drag-source') || !!cell?.classList.contains('drag-target');
      const key = `${r.left}|${r.top}|${r.width}|${r.height}|${focusMode}|${focused}|${dragging}`;
      if (key === last) return;
      last = key;
      el.style.display = 'block';
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      // Raise above the focus-mode backdrop (z 1000) when this pane is focused.
      el.style.zIndex = focusMode ? '1002' : '100';
      // Blue keyboard-focus ring when focused (but not in focus mode — there the
      // gradient frame shows instead); subtle dim while unfocused.
      if (ringRef.current) {
        ringRef.current.style.display = focused && !focusMode && !dragging ? 'block' : 'none';
      }
      if (dimRef.current) {
        dimRef.current.style.opacity = !focused && !focusMode && !dragging ? '1' : '0';
      }
      // Purple focus-mode glow, mirrored from the cell. The cell's own
      // .focus-mode-glow sits under this floating overlay, so paint our own
      // above the webview while this pane is the focus-mode pane.
      if (glowRef.current) {
        glowRef.current.style.display = focusMode && !dragging ? 'block' : 'none';
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.display = 'none';
    };
  }, [containerId, visible]);

  if (container.content.type !== 'browser') {
    return createPortal(null, wrapperRef.current);
  }

  const partition = container.content.browserPartition || 'persist:browser';

  return createPortal(
    <>
      <GridBrowser
        // Keyed by partition so a partition change remounts the <webview>
        // (partition is mount-time only).
        key={partition}
        url={container.content.browserUrl ?? 'about:blank'}
        partition={partition}
        containerId={containerId}
        onRequestFocus={onRequestFocus}
        zoomLevel={zoomLevel}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onUrlChange={onUrlChange}
      />
      {/* Focus ring + dim, mirrored from the cell and painted above the webview
          (the cell's own ::after/::before sit under this floating overlay). */}
      <div
        ref={dimRef}
        style={{
          position: 'absolute', inset: 0, borderRadius: 6, pointerEvents: 'none',
          background: 'rgba(0, 0, 0, 0.24)', zIndex: 5, opacity: 0,
          transition: 'opacity 180ms ease',
          // Promote to its own layer so it paints above the GPU-composited
          // <webview> (a plain div renders beneath it on the edges it covers).
          transform: 'translateZ(0)',
        }}
      />
      <div
        ref={ringRef}
        style={{
          position: 'absolute', inset: 0, borderRadius: 6, pointerEvents: 'none',
          border: '1px solid rgba(53, 157, 255, 0.55)',
          boxShadow: '0 0 0 1px rgba(53, 157, 255, 0.2), 0 0 14px rgba(53, 157, 255, 0.16)',
          zIndex: 6, display: 'none',
          // Promote above the GPU-composited <webview> so the ring shows on all
          // four edges (mirrors .terminal-focus-ring).
          transform: 'translateZ(0)',
        }}
      />
      {/* Focus-mode purple glow, painted above the webview (the cell's own
          .focus-mode-glow is hidden under this floating overlay). Reuses the
          shared class for the border/inset glow + pulse animation; toggled via
          the rAF tick. The class already promotes its own compositing layer. */}
      <div ref={glowRef} className="focus-mode-glow" aria-hidden="true" style={{ display: 'none' }} />
    </>,
    wrapperRef.current,
  );
};

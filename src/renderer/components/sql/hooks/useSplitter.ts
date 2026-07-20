import { useCallback, useRef, useState } from 'react';

interface SplitterOptions {
  /** Initial size in px. */
  initial: number;
  /** Minimum size in px. */
  min: number;
  /** Maximum size in px (or a function computing it from the drag context). */
  max?: number;
  /** Orientation: 'horizontal' drags left/right (sizes a width),
   * 'vertical' drags up/down (sizes a height). */
  axis: 'horizontal' | 'vertical';
  /** When true, dragging towards the start (left/up) GROWS the size
   * (i.e. the resized panel is on the trailing side). Default false. */
  invert?: boolean;
  onChange?: (size: number) => void;
}

/**
 * Minimal mouse-drag splitter hook — mirrors the resize pattern used in
 * DataGrid (document-level mousemove/mouseup listeners, ref-tracked drag
 * origin). Returns the current size, a setter, and an onMouseDown handler to
 * wire onto a splitter element.
 */
export function useSplitter({ initial, min, max, axis, invert, onChange }: SplitterOptions) {
  const [size, setSize] = useState(initial);
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startCoord = axis === 'horizontal' ? e.clientX : e.clientY;
    dragRef.current = { start: startCoord, startSize: size };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const coord = axis === 'horizontal' ? ev.clientX : ev.clientY;
      let delta = coord - dragRef.current.start;
      if (invert) delta = -delta;
      let next = dragRef.current.startSize + delta;
      next = Math.max(min, next);
      if (typeof max === 'number') next = Math.min(max, next);
      setSize(next);
      onChange?.(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = axis === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, axis, min, max, invert, onChange]);

  return { size, setSize, onMouseDown };
}

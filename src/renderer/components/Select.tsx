import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE = 8; // keep this far from the window edges

export interface SelectOption {
  value: string;
  label: string;
  /** Optional muted right-aligned meta (e.g. host, size). */
  meta?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minWidth?: number;
  title?: string;
  /** Optional leading glyph/icon. */
  icon?: React.ReactNode;
  /** Stretch the trigger to fill its container (for form/dialog fields). */
  block?: boolean;
  /** Open the menu immediately on mount (e.g. when used as an inline editor). */
  autoOpen?: boolean;
  /** Fired whenever the menu closes (selection, Esc, or outside-click). */
  onClose?: () => void;
}

/**
 * App-styled dropdown replacing the native <select> (whose popup is OS-drawn and
 * unstyleable). Renders a button + a portalled, fixed-positioned menu so it's
 * never clipped by the pane's overflow. Closes on outside-click, Esc, scroll.
 */
export const Select: React.FC<SelectProps> = ({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  minWidth = 140,
  title,
  icon,
  block,
  autoOpen,
  onClose,
}) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  const current = options.find((o) => o.value === value) ?? null;
  const label = current?.label ?? placeholder ?? '';

  // Place the menu so it stays inside the window: clamp horizontally and flip
  // above the trigger when there isn't enough room below. `menuH` is the actual
  // measured height when known, else an estimate (so the first paint is close).
  const place = (menuH?: number, menuW?: number) => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.max(r.width, minWidth);
    const w = menuW ?? width;
    let left = r.left;
    if (left + w > vw - EDGE) left = vw - EDGE - w;
    if (left < EDGE) left = EDGE;

    const below = vh - r.bottom - EDGE;
    const above = r.top - EDGE;
    const estH = menuH ?? Math.min(320, options.length * 30 + 8);
    let top: number, maxHeight: number;
    if (estH <= below || below >= above) {
      top = r.bottom + 4;
      maxHeight = below;
    } else {
      maxHeight = above;
      top = Math.max(EDGE, r.top - Math.min(estH, above) - 4);
    }
    setPos({ left, top, width, maxHeight: Math.min(320, maxHeight) });
  };

  const openMenu = () => {
    if (disabled) return;
    place();
    setOpen(true);
  };
  const closeMenu = () => { setOpen(false); onClose?.(); };

  // After the menu mounts, re-place using its real measured size (precise flip
  // direction and clamping).
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    place(el.offsetHeight, el.offsetWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Inline-editor mode: pop open as soon as we mount.
  useEffect(() => {
    if (autoOpen) openMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    // Close when an ANCESTOR scrolls (the menu would detach from the button), but
    // NOT when scrolling inside the menu's own list.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <div className="sql-select-wrap" style={block ? { display: 'block', width: '100%' } : undefined}>
      <button
        ref={btnRef}
        type="button"
        className={`sql-select${open ? ' open' : ''}`}
        disabled={disabled}
        title={title}
        style={block ? { width: '100%' } : { minWidth }}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        {icon && <span className="sql-select-ic">{icon}</span>}
        <span className={`sql-select-label${current ? '' : ' ph'}`}>{label}</span>
        <span className="sql-select-caret" aria-hidden>▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="sql-select-menu"
          style={{ left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight, overflowY: 'auto' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.length === 0 && <div className="sql-select-empty">No options</div>}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`sql-select-opt${o.value === value ? ' sel' : ''}`}
              onClick={() => { onChange(o.value); closeMenu(); }}
            >
              <span className="sql-select-opt-label">{o.label}</span>
              {o.meta && <span className="sql-select-opt-meta">{o.meta}</span>}
              <span className="sql-select-check" aria-hidden>{o.value === value ? '✓' : ''}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
};

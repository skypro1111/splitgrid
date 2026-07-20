import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SQLColumnInfo, SQLDialect, SQLEditChange } from '../../../../shared/types';
import { toCsv, toJson, toTsv, toSqlInserts } from '../../../../shared/sql-serialize';
import { Select } from '../../Select';

/* ===========================================================================
 * DataGrid — virtualized, DataGrip-style results grid.
 *
 * Two modes:
 *  - read-only (query results, or table tabs without a primary key)
 *  - editable (table tabs with a known primary key): inline cell editing,
 *    add/delete rows, a local diff buffer, range copy, and a Submit/Revert
 *    toolbar that flushes the buffer through `onApplyEdits` in one transaction.
 *
 * Rows are windowed with @tanstack/react-virtual; columns are NOT virtualized
 * (result sets are wide-but-bounded; resizable fixed-width columns keep header
 * and body aligned, which row-only windowing needs).
 * ======================================================================== */

const ROW_HEIGHT = 26;
const ROW_NUM_WIDTH = 56;
const DEFAULT_COL_WIDTH = 160;
const MIN_COL_WIDTH = 60;
const PAGE_SIZES = [25, 50, 100, 250, 500];

/** A pending edit for a single existing row (keyed by its original PK signature). */
interface RowEdit {
  /** column → new value (local buffer, not yet flushed) */
  changes: Record<string, unknown>;
  /** explicit NULLs (so we can distinguish "set to null" from "untouched") */
  deleted: boolean;
}

/** A locally-added row awaiting INSERT. */
interface NewRow {
  id: string; // local-only id
  values: Record<string, unknown>;
}

/** Per-column metadata used to pick an editor + validate. */
interface ColMeta {
  dataType?: string;
  isNullable: boolean;
  isAutoIncrement: boolean;
  hasDefault: boolean;
}

type EditorKind = 'text' | 'number' | 'boolean';

export interface DataGridEditConfig {
  schema: string;
  table: string;
  /** Primary-key column names; empty/undefined → read-only. */
  primaryKey: string[];
  /** Column metadata for this table (filtered to schema.table). */
  columnsMeta: SQLColumnInfo[];
  dialect: SQLDialect;
  /** Apply the buffer in one transaction; resolves on success. */
  onApplyEdits: (changes: SQLEditChange[]) => Promise<void>;
  /** Re-run the table query after a successful submit. */
  onReload: () => void;
}

interface DataGridProps {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  loading?: boolean;
  page?: number;
  pageSize?: number;
  sortColumn?: string | null;
  sortDirection?: 'ASC' | 'DESC';
  onSort?: (column: string, direction: 'ASC' | 'DESC') => void;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  totalEstimate?: number;
  showPagination?: boolean;
  statusText?: string;
  pageOffset?: number;
  /** When present (and primaryKey non-empty) the grid is editable. */
  edit?: DataGridEditConfig;
  /** Source table + dialect for clipboard "Copy as INSERT" and the SQL export
   * table name. Absent for arbitrary query results (INSERT then uses a default). */
  copyContext?: { schema: string | null; table: string; dialect: SQLDialect };
  /** Opens the Export dialog with the current loaded columns/rows. */
  onExport?: () => void;
  /** Re-run the underlying query/table query. */
  onRefresh?: () => void;
  /** Enables the per-column filter row toggle (table tabs only). */
  filterable?: boolean;
  /** Current server-side filters (column → contains-text). */
  filters?: Record<string, string>;
  /** Called (debounced) when a filter input changes; re-queries with a WHERE. */
  onFilterChange?: (filters: Record<string, string>) => void;
  /** Container zoom factor (1 = base). Scales the virtualized row height so rows
   * grow/shrink with the cell font (which scales via --sql-font-size). */
  uiScale?: number;
}

function formatCellValue(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false };
  return { text: String(value), isNull: false };
}

function formatTotalEstimate(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `~${Math.round(n / 1000)}K`;
  if (n < 1_000_000_000) return `~${Math.round(n / 1_000_000)}M`;
  return `~${Math.round(n / 1_000_000_000)}B`;
}

/** Map a SQL data type to a cell-editor kind. Best-effort, substring match. */
function editorKindFor(dataType?: string): EditorKind {
  if (!dataType) return 'text';
  const t = dataType.toLowerCase();
  if (/bool/.test(t)) return 'boolean';
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(t)) return 'number';
  return 'text';
}

/** Coerce an edited string back to a JS value appropriate for the column type. */
function coerceEditorValue(raw: string, kind: EditorKind): unknown {
  if (kind === 'number') {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/** Stable signature of a row's PK values (for keying edits and detecting dupes). */
function pkSignature(row: Record<string, unknown>, pk: string[]): string {
  return pk.map((c) => `${c}=${JSON.stringify(row[c] ?? null)}`).join('&');
}

/** Inclusive integer range as a Set (order-independent). */
function rangeSet(a: number, b: number): Set<number> {
  const s = new Set<number>();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) s.add(i);
  return s;
}

/** Loose value equality — decides whether an edit actually changed a cell vs its
 * original DB value (drivers may hand back numbers as strings etc.). */
function sameValue(a: unknown, b: unknown): boolean {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return true;
  if (an || bn) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return a === b || String(a) === String(b);
}

export const DataGrid: React.FC<DataGridProps> = ({
  columns,
  rows,
  loading,
  page = 0,
  pageSize = 100,
  sortColumn = null,
  sortDirection = 'ASC',
  onSort,
  onPageChange,
  onPageSizeChange,
  totalEstimate,
  showPagination = false,
  statusText,
  pageOffset = 0,
  edit,
  copyContext,
  onExport,
  onRefresh,
  filterable,
  filters,
  onFilterChange,
  uiScale = 1,
}) => {
  const editable = !!edit && edit.primaryKey.length > 0;
  const pk = edit?.primaryKey ?? [];
  // Row height tracks the container zoom so text never clips inside a fixed row.
  const rowHeight = Math.max(20, Math.round(ROW_HEIGHT * uiScale));

  /* ===== Column visibility (client-side, all grids) ===== */
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenCols.has(c)),
    [columns, hiddenCols],
  );
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [colSearch, setColSearch] = useState('');

  /* ===== Column widths / resize ===== */
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null);
  // New query/table → reset widths AND show all columns.
  useEffect(() => {
    setColWidths({});
    setHiddenCols(new Set());
    setColSearch('');
  }, [columns.join(',')]);

  const toggleColVisible = useCallback((col: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        // Keep at least one column visible.
        if (columns.length - next.size <= 1) return prev;
        next.add(col);
      }
      return next;
    });
  }, [columns.length]);

  const showAllCols = useCallback(() => setHiddenCols(new Set()), []);
  const hideAllCols = useCallback(() => {
    // Hide everything except the first column (keep ≥1 visible).
    setHiddenCols(new Set(columns.slice(1)));
  }, [columns]);

  const widthOf = useCallback((col: string) => colWidths[col] ?? DEFAULT_COL_WIDTH, [colWidths]);

  const handleResizeStart = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { col, startX: e.clientX, startW: widthOf(col) };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newW = Math.max(MIN_COL_WIDTH, resizingRef.current.startW + delta);
      setColWidths((prev) => ({ ...prev, [resizingRef.current!.col]: newW }));
    };
    const onUp = () => {
      resizingRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [widthOf]);

  /* ===== Column metadata lookup ===== */
  const colMeta = useMemo(() => {
    const map = new Map<string, ColMeta>();
    for (const c of edit?.columnsMeta ?? []) {
      map.set(c.column, {
        dataType: c.dataType,
        isNullable: c.isNullable !== false,
        isAutoIncrement: !!c.isAutoIncrement,
        hasDefault: c.defaultValue != null,
      });
    }
    return map;
  }, [edit?.columnsMeta]);

  /* ===== Edit buffer (in-memory, runtime only) ===== */
  const [rowEdits, setRowEdits] = useState<Map<string, RowEdit>>(new Map());
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  // Reset the buffer whenever the underlying rows change identity (reload / page).
  useEffect(() => {
    setRowEdits(new Map());
    setNewRows([]);
    setEditError('');
    setSelectedRows(new Set());
    rowAnchorRef.current = null;
    undoStackRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const pendingCount = useMemo(() => {
    let n = newRows.length;
    rowEdits.forEach((e) => { n += e.deleted ? 1 : Object.keys(e.changes).length; });
    return n;
  }, [rowEdits, newRows]);

  /* ===== Active inline editor ===== */
  // `rowKey` is the PK signature for existing rows, or `new:<id>` for new rows.
  const [editingCell, setEditingCell] = useState<{ rowKey: string; col: string } | null>(null);
  const [editorDraft, setEditorDraft] = useState('');
  const editorInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell) editorInputRef.current?.focus();
  }, [editingCell]);

  /* ===== Cell viewer (read large values) ===== */
  const [cellViewer, setCellViewer] = useState<{ column: string; value: string } | null>(null);

  /* ===== Filter row (server-side, table tabs only) ===== */
  const [showFilter, setShowFilter] = useState(false);
  // Local mirror of inputs so typing is instant; debounced into onFilterChange.
  const [filterDraft, setFilterDraft] = useState<Record<string, string>>(filters ?? {});
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the draft in sync when filters are replaced externally (e.g. clear-all,
  // page reload). Guard with a key compare so we don't clobber in-flight typing.
  const filtersKey = JSON.stringify(filters ?? {});
  useEffect(() => {
    setFilterDraft(filters ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);
  useEffect(() => () => { if (filterTimerRef.current) clearTimeout(filterTimerRef.current); }, []);

  const pushFilters = useCallback((next: Record<string, string>) => {
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => { onFilterChange?.(next); }, 300);
  }, [onFilterChange]);

  const handleFilterInput = useCallback((col: string, value: string) => {
    setFilterDraft((prev) => {
      const next = { ...prev };
      if (value.trim() === '') delete next[col];
      else next[col] = value;
      pushFilters(next);
      return next;
    });
  }, [pushFilters]);

  const clearAllFilters = useCallback(() => {
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    setFilterDraft({});
    onFilterChange?.({});
  }, [onFilterChange]);

  /* ===== Range selection (for TSV copy) ===== */
  // Anchor + focus in {row, col} grid coordinates over the EXISTING rows only.
  const [selAnchor, setSelAnchor] = useState<{ r: number; c: number } | null>(null);
  const [selFocus, setSelFocus] = useState<{ r: number; c: number } | null>(null);
  const selectingRef = useRef(false);
  // Distinguishes a row-gutter drag (whole-row span) from a cell-range drag.
  const rowSelectingRef = useRef(false);

  // Clear the drag-arm flags on any mouseup (even outside a cell).
  useEffect(() => {
    const onUp = () => { selectingRef.current = false; rowSelectingRef.current = false; };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  const inRange = useCallback((r: number, c: number) => {
    if (!selAnchor || !selFocus) return false;
    const r0 = Math.min(selAnchor.r, selFocus.r);
    const r1 = Math.max(selAnchor.r, selFocus.r);
    const c0 = Math.min(selAnchor.c, selFocus.c);
    const c1 = Math.max(selAnchor.c, selFocus.c);
    return r >= r0 && r <= r1 && c >= c0 && c <= c1;
  }, [selAnchor, selFocus]);

  // Explicit whole-row selection (independent of the cell rectangle): click the #
  // gutter to select a row, Shift-click / drag for a contiguous range, Cmd/Ctrl-
  // click to toggle individual rows (non-contiguous). Delete + Copy act on this.
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const rowAnchorRef = useRef<number | null>(null);

  const rowInRange = useCallback((r: number) => selectedRows.has(r), [selectedRows]);

  const onRowNumMouseDown = useCallback((r: number, ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    containerRef.current?.focus({ preventScroll: true });
    // Row selection and the cell rectangle are mutually exclusive — clear the rect.
    setSelAnchor(null);
    setSelFocus(null);
    if (ev.metaKey || ev.ctrlKey) {
      setSelectedRows((prev) => {
        const n = new Set(prev);
        if (n.has(r)) n.delete(r); else n.add(r);
        return n;
      });
      rowAnchorRef.current = r;
    } else if (ev.shiftKey && rowAnchorRef.current != null) {
      setSelectedRows(rangeSet(rowAnchorRef.current, r));
    } else {
      setSelectedRows(new Set([r]));
      rowAnchorRef.current = r;
      rowSelectingRef.current = true;
    }
  }, []);
  const onRowNumMouseEnter = useCallback((r: number) => {
    if (rowSelectingRef.current && rowAnchorRef.current != null) {
      setSelectedRows(rangeSet(rowAnchorRef.current, r));
    }
  }, []);
  const selectAllRows = useCallback(() => {
    if (rows.length === 0) return;
    setSelAnchor(null);
    setSelFocus(null);
    setSelectedRows(rangeSet(0, rows.length - 1));
    rowAnchorRef.current = 0;
    containerRef.current?.focus({ preventScroll: true });
  }, [rows.length]);

  /* ===== Virtualization ===== */
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalDisplayRows = rows.length + newRows.length;
  const rowVirtualizer = useVirtualizer({
    count: totalDisplayRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  // Re-measure when the zoom-driven row height changes.
  useEffect(() => { rowVirtualizer.measure(); }, [rowHeight, rowVirtualizer]);

  const totalWidth = ROW_NUM_WIDTH + visibleColumns.reduce((sum, c) => sum + widthOf(c), 0);

  /* ===== Value resolution (buffer-aware) ===== */
  const displayedValue = useCallback((rowKey: string, col: string, baseRow: Record<string, unknown>) => {
    const e = rowEdits.get(rowKey);
    if (e && col in e.changes) return e.changes[col];
    return baseRow[col];
  }, [rowEdits]);

  /* ===== Original-value lookup + undo stack ===== */
  // Map each existing row's PK signature → its ORIGINAL (unedited) row, so a
  // commit can tell whether the value really changed.
  const baseRowByKey = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of rows) m.set(pkSignature(r, pk), r);
    return m;
  }, [rows, pk]);

  // Snapshot stack of the edit buffer for Cmd/Ctrl+Z.
  const undoStackRef = useRef<Array<{ rowEdits: Map<string, RowEdit>; newRows: NewRow[] }>>([]);
  const pushUndo = useCallback(() => {
    undoStackRef.current.push({
      rowEdits: new Map(rowEdits),
      newRows: newRows.map((r) => ({ ...r, values: { ...r.values } })),
    });
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
  }, [rowEdits, newRows]);
  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setRowEdits(prev.rowEdits);
    setNewRows(prev.newRows);
    setEditError('');
  }, []);

  // Apply a single-cell change, registering it as an edit ONLY when it differs
  // from the row's original value (reverting to the original clears the change;
  // an emptied row-edit entry is dropped). Snapshots for undo only on real change.
  const applyCellChange = useCallback((rowKey: string, col: string, value: unknown) => {
    if (rowKey.startsWith('new:')) {
      const id = rowKey.slice(4);
      const nr = newRows.find((n) => n.id === id);
      if (nr && sameValue(nr.values[col], value)) return;
      pushUndo();
      setNewRows((prev) => prev.map((n) => n.id === id ? { ...n, values: { ...n.values, [col]: value } } : n));
      return;
    }
    const original = baseRowByKey.get(rowKey)?.[col];
    const curEdit = rowEdits.get(rowKey);
    const currentDisplayed = curEdit && col in curEdit.changes ? curEdit.changes[col] : original;
    if (sameValue(currentDisplayed, value)) return; // no-op
    pushUndo();
    setRowEdits((prev) => {
      const next = new Map(prev);
      const cur = next.get(rowKey) ?? { changes: {}, deleted: false };
      const changes = { ...cur.changes };
      if (sameValue(value, original)) delete changes[col];
      else changes[col] = value;
      if (Object.keys(changes).length === 0 && !cur.deleted) next.delete(rowKey);
      else next.set(rowKey, { ...cur, changes });
      return next;
    });
  }, [pushUndo, baseRowByKey, rowEdits, newRows]);

  /* ===== Sorting ===== */
  const handleHeaderClick = useCallback((col: string) => {
    if (!onSort) return;
    if (editingCell) return;
    onSort(col, sortColumn === col ? (sortDirection === 'ASC' ? 'DESC' : 'ASC') : 'ASC');
  }, [onSort, sortColumn, sortDirection, editingCell]);

  /* ===== Editing actions ===== */
  const beginEdit = useCallback((rowKey: string, col: string, currentValue: unknown) => {
    if (!editable) return;
    const meta = colMeta.get(col);
    // Don't block editing autoincrement on existing rows — DataGrip allows it,
    // but we keep it simple: any column is editable.
    void meta;
    const { text, isNull } = formatCellValue(currentValue);
    setEditorDraft(isNull ? '' : text);
    setEditingCell({ rowKey, col });
  }, [editable, colMeta]);

  const commitEdit = useCallback((advanceCol?: number) => {
    if (!editingCell) return;
    const { rowKey, col } = editingCell;
    const kind = editorKindFor(colMeta.get(col)?.dataType);
    const value = coerceEditorValue(editorDraft, kind);
    applyCellChange(rowKey, col, value);
    setEditingCell(null);
    setEditorDraft('');
    // Tab → move to the next column on the same row (best-effort).
    if (advanceCol != null) {
      const nextCol = visibleColumns[advanceCol];
      if (nextCol) {
        // re-open editor on the next cell after state settles
        setTimeout(() => {
          // value resolved fresh on next render; open empty editor
          setEditingCell({ rowKey, col: nextCol });
          setEditorDraft('');
        }, 0);
      }
    }
  }, [editingCell, editorDraft, colMeta, visibleColumns, applyCellChange]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditorDraft('');
  }, []);

  const setCellNull = useCallback((rowKey: string, col: string) => {
    if (!editable) return;
    applyCellChange(rowKey, col, null);
    if (editingCell?.rowKey === rowKey && editingCell.col === col) cancelEdit();
  }, [editable, editingCell, cancelEdit, applyCellChange]);

  const toggleBoolean = useCallback((rowKey: string, col: string, current: unknown) => {
    // tri-state: true → false → null → true
    const next = current === true || current === 'true' || current === 1
      ? false
      : (current === false || current === 'false' || current === 0)
        ? (colMeta.get(col)?.isNullable ? null : true)
        : true;
    applyCellChange(rowKey, col, next);
  }, [colMeta, applyCellChange]);

  const addRow = useCallback(() => {
    pushUndo();
    setNewRows((prev) => [...prev, { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, values: {} }]);
    // scroll to bottom so the new row is visible
    setTimeout(() => rowVirtualizer.scrollToIndex(totalDisplayRows, { align: 'end' }), 0);
  }, [rowVirtualizer, totalDisplayRows, pushUndo]);

  const toggleDeleteSelected = useCallback(() => {
    // Act on the explicit row selection if any, else the cell rectangle's rows.
    const targetRows = selectedRows.size > 0
      ? [...selectedRows]
      : (selAnchor && selFocus ? [...rangeSet(selAnchor.r, selFocus.r)] : []);
    if (targetRows.length === 0) return;
    pushUndo();
    setRowEdits((prev) => {
      const next = new Map(prev);
      for (const r of targetRows) {
        const baseRow = rows[r];
        if (!baseRow) continue;
        const key = pkSignature(baseRow, pk);
        const cur = next.get(key) ?? { changes: {}, deleted: false };
        next.set(key, { ...cur, deleted: !cur.deleted });
      }
      return next;
    });
  }, [selectedRows, selAnchor, selFocus, rows, pk, pushUndo]);

  const removeNewRow = useCallback((id: string) => {
    pushUndo();
    setNewRows((prev) => prev.filter((nr) => nr.id !== id));
  }, [pushUndo]);

  const revert = useCallback(() => {
    setRowEdits(new Map());
    setNewRows([]);
    setEditError('');
    undoStackRef.current = [];
    cancelEdit();
  }, [cancelEdit]);

  const buildChanges = useCallback((): SQLEditChange[] => {
    if (!edit) return [];
    const out: SQLEditChange[] = [];
    // Updates + deletes for existing rows.
    rows.forEach((baseRow) => {
      const key = pkSignature(baseRow, pk);
      const e = rowEdits.get(key);
      if (!e) return;
      const pkValues: Record<string, unknown> = {};
      for (const c of pk) pkValues[c] = baseRow[c] ?? null;
      if (e.deleted) {
        out.push({ kind: 'delete', schema: edit.schema, table: edit.table, pk: pkValues });
        return;
      }
      for (const [col, value] of Object.entries(e.changes)) {
        out.push({ kind: 'update', schema: edit.schema, table: edit.table, pk: pkValues, column: col, value });
      }
    });
    // Inserts.
    newRows.forEach((nr) => {
      // Drop empty autoincrement/default columns so the server fills them.
      const values: Record<string, unknown> = {};
      for (const [col, v] of Object.entries(nr.values)) {
        if (v === undefined) continue;
        values[col] = v;
      }
      out.push({ kind: 'insert', schema: edit.schema, table: edit.table, values });
    });
    return out;
  }, [edit, rows, pk, rowEdits, newRows]);

  const submit = useCallback(async () => {
    if (!edit || pendingCount === 0) return;
    const changes = buildChanges();
    setSubmitting(true);
    setEditError('');
    try {
      await edit.onApplyEdits(changes);
      revert();
      edit.onReload();
    } catch (err) {
      setEditError((err as Error).message || 'Failed to apply changes');
    } finally {
      setSubmitting(false);
    }
  }, [edit, pendingCount, buildChanges, revert]);

  /* ===== Range copy (TSV) ===== */
  const copyRange = useCallback(() => {
    if (!selAnchor || !selFocus) return;
    const r0 = Math.min(selAnchor.r, selFocus.r);
    const r1 = Math.max(selAnchor.r, selFocus.r);
    const c0 = Math.min(selAnchor.c, selFocus.c);
    const c1 = Math.max(selAnchor.c, selFocus.c);
    const lines: string[] = [];
    for (let r = r0; r <= r1; r += 1) {
      const baseRow = rows[r];
      if (!baseRow) continue;
      const key = pkSignature(baseRow, pk);
      const cells: string[] = [];
      for (let c = c0; c <= c1; c += 1) {
        const col = visibleColumns[c];
        if (!col) continue;
        const v = editable ? displayedValue(key, col, baseRow) : baseRow[col];
        const { text, isNull } = formatCellValue(v);
        cells.push(isNull ? '' : text);
      }
      lines.push(cells.join('\t'));
    }
    const tsv = lines.join('\n');
    if (tsv) navigator.clipboard?.writeText(tsv).catch(() => {});
  }, [selAnchor, selFocus, rows, visibleColumns, pk, editable, displayedValue]);

  /* ===== Copy as (TSV / CSV / JSON / INSERT) ===== */
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);

  // Resolve the columns + rows to copy: the selected rectangle when a range is
  // active, otherwise all loaded columns + rows (buffer-aware for editable grids).
  const resolveCopyData = useCallback((): { cols: string[]; data: Array<Record<string, unknown>> } => {
    // Explicit whole-row selection → all visible columns of those rows.
    if (selectedRows.size > 0) {
      const cols = visibleColumns;
      const data: Array<Record<string, unknown>> = [];
      for (const r of [...selectedRows].sort((a, b) => a - b)) {
        const baseRow = rows[r];
        if (!baseRow) continue;
        const key = editable ? pkSignature(baseRow, pk) : '';
        const obj: Record<string, unknown> = {};
        for (const col of cols) obj[col] = editable ? displayedValue(key, col, baseRow) : baseRow[col];
        data.push(obj);
      }
      return { cols, data };
    }
    const hasSel = selAnchor && selFocus;
    const c0 = hasSel ? Math.min(selAnchor!.c, selFocus!.c) : 0;
    const c1 = hasSel ? Math.max(selAnchor!.c, selFocus!.c) : visibleColumns.length - 1;
    const r0 = hasSel ? Math.min(selAnchor!.r, selFocus!.r) : 0;
    const r1 = hasSel ? Math.max(selAnchor!.r, selFocus!.r) : rows.length - 1;
    const cols = visibleColumns.slice(c0, c1 + 1);
    const data: Array<Record<string, unknown>> = [];
    for (let r = r0; r <= r1; r += 1) {
      const baseRow = rows[r];
      if (!baseRow) continue;
      const key = editable ? pkSignature(baseRow, pk) : '';
      const obj: Record<string, unknown> = {};
      for (const col of cols) obj[col] = editable ? displayedValue(key, col, baseRow) : baseRow[col];
      data.push(obj);
    }
    return { cols, data };
  }, [selectedRows, selAnchor, selFocus, visibleColumns, rows, editable, pk, displayedValue]);

  const copyAs = useCallback((format: 'tsv' | 'csv' | 'json' | 'insert') => {
    const { cols, data } = resolveCopyData();
    if (cols.length === 0 || data.length === 0) { setCopyMenuOpen(false); return; }
    let text = '';
    if (format === 'tsv') text = toTsv(cols, data, true);
    else if (format === 'csv') text = toCsv(cols, data, { delimiter: ',', includeHeaders: true });
    else if (format === 'json') text = toJson(cols, data);
    else if (format === 'insert') {
      const table = copyContext?.table ?? 'exported_data';
      const dialect = copyContext?.dialect ?? 'postgres';
      text = toSqlInserts(copyContext?.schema ?? null, table, cols, data, dialect);
    }
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
    setCopyMenuOpen(false);
  }, [resolveCopyData, copyContext]);

  // Copy handler scoped to the grid container: Ctrl/Cmd+C copies the selected
  // rectangle as TSV. The listener lives on the container, so it only fires when
  // focus is inside the grid (and not in a cell editor, which handles its own keys).
  const containerRef = useRef<HTMLDivElement>(null);
  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (editingCell) return; // the inline editor handles its own keys (incl. undo)
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey && editable) {
      undo();
      e.preventDefault();
      return;
    }
    if (key !== 'c') return;
    if (selectedRows.size > 0) {
      const { cols, data } = resolveCopyData();
      if (cols.length && data.length) {
        const tsv = toTsv(cols, data, false);
        if (tsv) navigator.clipboard?.writeText(tsv).catch(() => {});
      }
      e.preventDefault();
    } else if (selAnchor && selFocus) { copyRange(); e.preventDefault(); }
  }, [selectedRows, selAnchor, selFocus, editingCell, copyRange, resolveCopyData, editable, undo]);

  /* ===== Render helpers ===== */
  const renderHeaderCell = (col: string) => (
    <div
      key={col}
      className="dg-th"
      style={{ width: widthOf(col), minWidth: widthOf(col) }}
      onClick={() => handleHeaderClick(col)}
      title={pk.includes(col) ? `${col} (primary key)` : col}
    >
      <span className="dg-th-label">
        {pk.includes(col) && <span className="dg-pk-badge" title="primary key">🔑</span>}
        {col}
      </span>
      {sortColumn === col && <span className="dg-sort">{sortDirection === 'ASC' ? '▲' : '▼'}</span>}
      <div
        className="dg-resize"
        onMouseDown={(e) => handleResizeStart(col, e)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  const renderCellContent = (
    rowKey: string,
    col: string,
    value: unknown,
  ) => {
    const isEditing = editingCell?.rowKey === rowKey && editingCell.col === col;
    const kind = editorKindFor(colMeta.get(col)?.dataType);

    if (isEditing) {
      if (kind === 'boolean') {
        return (
          <Select
            block
            autoOpen
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(raw) => {
              const v = raw === '' ? null : raw === 'true';
              applyCellChange(rowKey, col, v); // commit immediately for selects
              cancelEdit();
            }}
            onClose={cancelEdit}
            options={[
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
              ...(colMeta.get(col)?.isNullable ? [{ value: '', label: 'NULL' }] : []),
            ]}
          />
        );
      }
      return (
        <input
          ref={editorInputRef}
          className="dg-cell-editor"
          type={kind === 'number' ? 'number' : 'text'}
          value={editorDraft}
          spellCheck={false}
          onChange={(e) => setEditorDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
            else if (e.key === 'Tab') {
              e.preventDefault();
              const idx = visibleColumns.indexOf(col);
              commitEdit(e.shiftKey ? idx - 1 : idx + 1);
            } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && colMeta.get(col)?.isNullable) {
              e.preventDefault(); setCellNull(rowKey, col);
            }
          }}
          onBlur={() => commitEdit()}
        />
      );
    }

    const { text, isNull } = formatCellValue(value);
    return (
      <span className={isNull ? 'dg-null' : undefined}>{isNull ? 'NULL' : text}</span>
    );
  };

  /* ===== Empty / loading states ===== */
  if (loading && rows.length === 0) {
    return <div className="sql-datagrid dg"><div className="dg-loading">Loading…</div></div>;
  }
  if (columns.length === 0) {
    return <div className="sql-datagrid dg"><div className="dg-loading" style={{ color: 'var(--text-muted)' }}>No data</div></div>;
  }

  const totalPages = totalEstimate != null && totalEstimate > 0 ? Math.ceil(totalEstimate / pageSize) : null;
  const readOnlyHint = !!edit && edit.primaryKey.length === 0;

  return (
    <div className="sql-datagrid dg" ref={containerRef} tabIndex={-1} onKeyDown={handleContainerKeyDown}>
      {/* Toolbar: edit actions (editable tables) + Columns/Filter + Copy-as / Export */}
      {(editable || onExport || onRefresh || rows.length > 0 || columns.length > 0) && (
        <div className="dg-toolbar">
          {onRefresh && (
            <button className="dg-tool-btn" onClick={onRefresh} title="Refresh — re-run the query" disabled={!!loading}>↻</button>
          )}
          {editable && (
            <>
              <button className="dg-tool-btn" onClick={addRow} title="Add row" disabled={submitting}>+ Row</button>
              <button className="dg-tool-btn" onClick={toggleDeleteSelected} title="Delete selected rows" disabled={submitting || (!selAnchor && selectedRows.size === 0)}>– Delete</button>
            </>
          )}
          {columns.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                className="dg-tool-btn"
                onClick={() => setColMenuOpen((v) => !v)}
                title="Show / hide columns"
              >
                Columns ▾
              </button>
              {colMenuOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 2400 }} onClick={() => setColMenuOpen(false)} />
                  <div className="dg-colmenu" onKeyDown={(e) => { if (e.key === 'Escape') setColMenuOpen(false); }}>
                    <div className="dg-colmenu-search">
                      <input
                        className="dg-colmenu-input"
                        type="text"
                        spellCheck={false}
                        autoFocus
                        placeholder="Search columns…"
                        value={colSearch}
                        onChange={(e) => setColSearch(e.target.value)}
                      />
                    </div>
                    <div className="dg-colmenu-actions">
                      <button onClick={showAllCols}>Show all</button>
                      <button onClick={hideAllCols}>Hide all</button>
                      <span className="dg-colmenu-count">{visibleColumns.length}/{columns.length}</span>
                    </div>
                    <div className="dg-colmenu-list">
                      {columns
                        .filter((c) => c.toLowerCase().includes(colSearch.toLowerCase()))
                        .map((col) => {
                          const visible = !hiddenCols.has(col);
                          const isLastVisible = visible && visibleColumns.length <= 1;
                          return (
                            <label
                              key={col}
                              className="dg-colmenu-opt"
                              title={isLastVisible ? 'At least one column must stay visible' : col}
                            >
                              <input
                                type="checkbox"
                                checked={visible}
                                disabled={isLastVisible}
                                onChange={() => toggleColVisible(col)}
                              />
                              <span className="dg-colmenu-opt-label">{col}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {filterable && (
            <button
              className={`dg-tool-btn${showFilter ? ' active' : ''}`}
              onClick={() => setShowFilter((v) => !v)}
              title="Toggle column filter row"
            >
              Filter
            </button>
          )}
          <div className="dg-tool-spacer" />
          {editError && <span className="dg-tool-error" title={editError}>{editError}</span>}
          {editable && pendingCount > 0 && <span className="dg-pending">{pendingCount} pending</span>}
          {rows.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                className="dg-tool-btn"
                onClick={() => setCopyMenuOpen((v) => !v)}
                title="Copy selection (or all loaded rows) to clipboard"
              >
                Copy as ▾
              </button>
              {copyMenuOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 2400 }} onClick={() => setCopyMenuOpen(false)} />
                  <div className="sql-context-menu" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 2500, minWidth: 120 }}>
                    <button onClick={() => copyAs('tsv')}>TSV</button>
                    <button onClick={() => copyAs('csv')}>CSV</button>
                    <button onClick={() => copyAs('json')}>JSON</button>
                    <button onClick={() => copyAs('insert')}>INSERT</button>
                  </div>
                </>
              )}
            </div>
          )}
          {onExport && (
            <button className="dg-tool-btn" onClick={onExport} title="Export to file">Export…</button>
          )}
          {editable && (
            <>
              <button className="dg-tool-btn" onClick={revert} disabled={pendingCount === 0 || submitting}>Revert</button>
              <button className="dg-tool-btn dg-submit" onClick={() => void submit()} disabled={pendingCount === 0 || submitting}>
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </>
          )}
        </div>
      )}
      {readOnlyHint && (
        <div className="dg-ro-hint">read-only (no primary key)</div>
      )}

      {/* Scroll viewport */}
      <div className="dg-viewport" ref={scrollRef} style={{ position: 'relative' }}>
        {loading && <div className="dg-overlay">Loading…</div>}

        {/* Header (sticky) */}
        <div className="dg-header-stack">
          <div className="dg-header" style={{ width: totalWidth }}>
            <div
              className="dg-th dg-row-num-head dg-row-num-sel-able"
              style={{ width: ROW_NUM_WIDTH, minWidth: ROW_NUM_WIDTH }}
              title="Select all rows"
              onClick={selectAllRows}
            >#</div>
            {visibleColumns.map((col) => renderHeaderCell(col))}
          </div>
          {filterable && showFilter && (
            <div className="dg-filter-row" style={{ width: totalWidth }}>
              <div className="dg-filter-cell dg-filter-rownum" style={{ width: ROW_NUM_WIDTH, minWidth: ROW_NUM_WIDTH }}>
                <button
                  className="dg-filter-clear"
                  title="Clear all filters"
                  onClick={clearAllFilters}
                  disabled={Object.keys(filterDraft).length === 0}
                >×</button>
              </div>
              {visibleColumns.map((col) => (
                <div
                  key={col}
                  className="dg-filter-cell"
                  style={{ width: widthOf(col), minWidth: widthOf(col) }}
                >
                  <input
                    className="dg-filter-input"
                    type="text"
                    spellCheck={false}
                    placeholder="filter…"
                    value={filterDraft[col] ?? ''}
                    onChange={(e) => handleFilterInput(col, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Body (virtualized) */}
        <div style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth, position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const isNew = vi.index >= rows.length;
            if (isNew) {
              const nr = newRows[vi.index - rows.length];
              if (!nr) return null;
              const rowKey = `new:${nr.id}`;
              return (
                <div
                  key={rowKey}
                  className="dg-row dg-row-new"
                  style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${vi.start}px)`, height: rowHeight, width: totalWidth }}
                >
                  <div className="dg-td dg-row-num" style={{ width: ROW_NUM_WIDTH, minWidth: ROW_NUM_WIDTH }}>
                    <button className="dg-rm-new" title="Discard new row" onClick={() => removeNewRow(nr.id)}>×</button>
                  </div>
                  {visibleColumns.map((col) => {
                    const value = nr.values[col];
                    const kind = editorKindFor(colMeta.get(col)?.dataType);
                    return (
                      <div
                        key={col}
                        className="dg-td"
                        style={{ width: widthOf(col), minWidth: widthOf(col) }}
                        onDoubleClick={() => kind === 'boolean' ? toggleBoolean(rowKey, col, value) : beginEdit(rowKey, col, value)}
                      >
                        {renderCellContent(rowKey, col, value)}
                      </div>
                    );
                  })}
                </div>
              );
            }

            const r = vi.index;
            const baseRow = rows[r];
            const rowKey = pkSignature(baseRow, pk);
            const e = editable ? rowEdits.get(rowKey) : undefined;
            const deleted = !!e?.deleted;
            return (
              <div
                key={rowKey + ':' + r}
                className={`dg-row${deleted ? ' dg-row-deleted' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${vi.start}px)`, height: rowHeight, width: totalWidth }}
              >
                <div
                  className={`dg-td dg-row-num dg-row-num-sel-able${rowInRange(r) ? ' dg-row-num-sel' : ''}`}
                  style={{ width: ROW_NUM_WIDTH, minWidth: ROW_NUM_WIDTH }}
                  title="Click to select row · Shift-click for a range"
                  onMouseDown={(ev) => onRowNumMouseDown(r, ev)}
                  onMouseEnter={() => onRowNumMouseEnter(r)}
                >
                  {pageOffset + r + 1}
                </div>
                {visibleColumns.map((col, c) => {
                  const value = editable ? displayedValue(rowKey, col, baseRow) : baseRow[col];
                  const modified = !!e && col in e.changes;
                  const selected = inRange(r, c) || selectedRows.has(r);
                  const kind = editorKindFor(colMeta.get(col)?.dataType);
                  const { text } = formatCellValue(value);
                  return (
                    <div
                      key={col}
                      className={`dg-td${modified ? ' dg-modified' : ''}${selected ? ' dg-selected' : ''}`}
                      style={{ width: widthOf(col), minWidth: widthOf(col) }}
                      title={text.length > 40 ? text : undefined}
                      onMouseDown={(ev) => {
                        if (ev.button !== 0) return;
                        containerRef.current?.focus({ preventScroll: true });
                        if (ev.shiftKey && selAnchor) {
                          setSelFocus({ r, c });
                        } else {
                          // Starting a cell selection clears any whole-row selection.
                          setSelectedRows(new Set());
                          setSelAnchor({ r, c });
                          setSelFocus({ r, c });
                          selectingRef.current = true;
                        }
                      }}
                      onMouseEnter={() => { if (selectingRef.current) setSelFocus({ r, c }); }}
                      onMouseUp={() => { selectingRef.current = false; }}
                      onDoubleClick={() => {
                        if (editable) {
                          if (kind === 'boolean') toggleBoolean(rowKey, col, value);
                          else beginEdit(rowKey, col, value);
                        } else {
                          setCellViewer({ column: col, value: text });
                        }
                      }}
                    >
                      {renderCellContent(rowKey, col, value)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {statusText && <div className="dg-status">{statusText}</div>}

      {showPagination && (
        <div className="dg-pagination">
          <button disabled={page <= 0} onClick={() => onPageChange?.(page - 1)}>← Prev</button>
          <span>Page {page + 1}{totalPages != null && ` of ${totalPages > 10000 ? formatTotalEstimate(totalPages) : totalPages}`}</span>
          <button disabled={rows.length < pageSize} onClick={() => onPageChange?.(page + 1)}>Next →</button>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Rows per page:
            <Select
              value={String(pageSize)}
              onChange={(v) => onPageSizeChange?.(Number(v))}
              options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
              minWidth={72}
            />
          </span>
          {totalEstimate != null && <span>{formatTotalEstimate(totalEstimate)} rows total</span>}
        </div>
      )}

      {/* Big-cell viewer */}
      {cellViewer && (
        <div className="dg-viewer-backdrop" onMouseDown={() => setCellViewer(null)}>
          <div className="dg-viewer" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dg-viewer-head">
              <span className="dg-viewer-title">{cellViewer.column}</span>
              <button onClick={() => navigator.clipboard?.writeText(cellViewer.value).catch(() => {})}>Copy all</button>
              <button onClick={() => setCellViewer(null)}>Close</button>
            </div>
            <div className="dg-viewer-body">
              <textarea value={cellViewer.value} readOnly spellCheck={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

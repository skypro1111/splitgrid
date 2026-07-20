import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteDirEntry } from '../../../shared/types';
import { formatSize, formatMtime, formatMode } from '../../../shared/sftp-format';

// Data layer for one pane of the dual-pane file manager. The table itself is
// path-semantics agnostic: joins, parents, crumbs and all CRUD go through the
// provider, so the same component renders the local and the remote half.
export interface FileProvider {
  kind: 'local' | 'remote';
  list(path: string): Promise<RemoteDirEntry[]>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  join(dir: string, name: string): string;
  parent(path: string): string;
  isRoot(path: string): boolean;
  crumbs(path: string): { label: string; path: string }[];
}

interface FileTableProps {
  provider: FileProvider;
  path: string; // current dir (controlled by parent)
  onPathChange: (path: string) => void; // navigate (parent persists it)
  // Parent-driven reload trigger (e.g. after a cross-pane transfer landed here).
  refreshNonce?: number;
  // Surfaces the current selection so the parent can drive transfers.
  onSelectionChange?: (entries: RemoteDirEntry[]) => void;
  // Files dragged in from the OS (Finder/Explorer): the absolute local paths.
  // The parent decides what to do (upload into the remote dir / copy into the
  // local dir). Internal drags (no OS files) never call this.
  onExternalDrop?: (localPaths: string[]) => void;
  // Activate a (non-directory) entry — double-click or Enter. Only the remote
  // provider wires this (to open the file in the editor); when undefined,
  // activating a file is a no-op (rename stays on the context menu).
  onOpenFile?: (entry: RemoteDirEntry) => void;
  // Per-container zoom level (Cmd/Ctrl +/-). Scales the table content; 13 = 1x.
  zoomLevel?: number;
}

// Below these table widths (in the table's own coordinate space) the metadata
// columns drop one by one — Permissions, then Modified, then Size — so the file
// Name keeps its space and is the LAST thing to collapse.
const COL_BREAKPOINTS: Record<Exclude<SortKey, 'name'>, number> = {
  mode: 460,
  mtime: 360,
  size: 240,
};

type SortKey = 'name' | 'size' | 'mtime' | 'mode';
type SortDir = 'asc' | 'desc';

interface ContextMenuState {
  x: number;
  y: number;
  entry: RemoteDirEntry;
}

// A staged inline operation: creating a new folder, or renaming an entry.
type InlineEdit =
  | { kind: 'new-folder'; value: string }
  | { kind: 'rename'; name: string; value: string }
  | null;

const COLS: { key: SortKey; label: string; width: string; align?: 'right' }[] = [
  { key: 'name', label: 'Name', width: 'auto' },
  { key: 'size', label: 'Size', width: '6.5em', align: 'right' },
  { key: 'mtime', label: 'Modified', width: '8.5em' },
  { key: 'mode', label: 'Permissions', width: '8em' },
];

const FolderGlyph: React.FC = () => (
  <span style={{ color: 'var(--accent)', flexShrink: 0, fontSize: '1em', lineHeight: 1 }}>📁</span>
);
const FileGlyph: React.FC = () => (
  <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: '1em', lineHeight: 1 }}>📄</span>
);

export const FileTable: React.FC<FileTableProps> = ({ provider, path, onPathChange, refreshNonce, onSelectionChange, onExternalDrop, onOpenFile, zoomLevel }) => {
  const baseFont = zoomLevel ?? 13;
  const zoomFactor = baseFont / 13;
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>('');
  const [opError, setOpError] = useState<string>('');
  const [opBusy, setOpBusy] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  // Highlighted while OS files are dragged over the listing (external drop).
  const [dragOver, setDragOver] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Track the table's own (un-zoomed) width so columns can collapse when the
  // container gets too narrow. Compared in the table's coordinate space — i.e.
  // divided by the zoom factor — so zooming in also drops columns.
  const [tableWidth, setTableWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((obs) => setTableWidth(obs[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    setTableWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Name is always shown; metadata columns drop (Permissions → Modified → Size)
  // once the available width falls below their breakpoint, so the name is last
  // to collapse. Until measured, show everything to avoid a flash.
  const visibleCols = useMemo(() => {
    const effective = tableWidth > 0 ? tableWidth / zoomFactor : Infinity;
    return COLS.filter((c) => c.key === 'name' || effective >= COL_BREAKPOINTS[c.key as Exclude<SortKey, 'name'>]);
  }, [tableWidth, zoomFactor]);
  const visibleMetaCols = useMemo(() => visibleCols.filter((c) => c.key !== 'name'), [visibleCols]);
  const visibleKeys = useMemo(() => new Set(visibleCols.map((c) => c.key)), [visibleCols]);

  // ---- Load listing -------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await provider.list(path);
      setEntries(result);
      setSelected(new Set());
      setAnchor(null);
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to read directory');
    } finally {
      setLoading(false);
    }
  }, [provider, path]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  // Reset transient UI whenever the directory changes.
  useEffect(() => {
    setMenu(null);
    setInlineEdit(null);
    setConfirmDelete(null);
    setOpError('');
  }, [path]);

  // Focus the inline edit input when one appears.
  useEffect(() => {
    if (inlineEdit) editInputRef.current?.select();
  }, [inlineEdit]);

  // Surface the selection (as full entries) to the parent.
  useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(entries.filter((e) => selected.has(e.filename)));
  }, [entries, selected, onSelectionChange]);

  // ---- Sorting ------------------------------------------------------------
  const sorted = useMemo(() => {
    const copy = [...entries];
    const dir = sortDir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      // Directories always group first regardless of sort direction.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      let cmp = 0;
      switch (sortKey) {
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'mtime':
          cmp = a.mtime - b.mtime;
          break;
        case 'mode':
          cmp = a.mode - b.mode;
          break;
        case 'name':
        default:
          cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
          break;
      }
      if (cmp === 0) cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
      return cmp * dir;
    });
    return copy;
  }, [entries, sortKey, sortDir]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setSortDir('asc');
      return key;
    });
  }, []);

  // ---- Navigation ---------------------------------------------------------
  const navigateInto = useCallback(
    (entry: RemoteDirEntry) => {
      if (!entry.isDirectory) return;
      onPathChange(provider.join(path, entry.filename));
    },
    [provider, path, onPathChange],
  );

  const navigateUp = useCallback(() => {
    if (!provider.isRoot(path)) onPathChange(provider.parent(path));
  }, [provider, path, onPathChange]);

  // Activate an entry: directories navigate, files open (if a handler is wired).
  const activateEntry = useCallback(
    (entry: RemoteDirEntry) => {
      if (entry.isDirectory) navigateInto(entry);
      else onOpenFile?.(entry);
    },
    [navigateInto, onOpenFile],
  );

  // ---- External (OS) file drop -------------------------------------------
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!onExternalDrop || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    },
    [onExternalDrop],
  );

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore leave events into descendant nodes; only clear when the pointer
    // actually exits the drop container.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!onExternalDrop) return;
      e.preventDefault();
      setDragOver(false);
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.electronAPI.getPathForFile(f))
        .filter(Boolean);
      if (paths.length > 0) onExternalDrop(paths);
    },
    [onExternalDrop],
  );

  // ---- Selection ----------------------------------------------------------
  const selectRow = useCallback(
    (name: string, e: React.MouseEvent) => {
      const names = sorted.map((s) => s.filename);
      if (e.shiftKey && anchor) {
        const from = names.indexOf(anchor);
        const to = names.indexOf(name);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelected(new Set(names.slice(lo, hi + 1)));
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        setAnchor(name);
        return;
      }
      setSelected(new Set([name]));
      setAnchor(name);
    },
    [sorted, anchor],
  );

  // Keyboard: Up/Down move selection, Enter opens a dir.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (inlineEdit || confirmDelete) return;
      const names = sorted.map((s) => s.filename);
      if (names.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = anchor ? names.indexOf(anchor) : -1;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.max(0, Math.min(names.length - 1, cur + delta));
        const name = names[next];
        setSelected(new Set([name]));
        setAnchor(name);
      } else if (e.key === 'Enter' && anchor) {
        const entry = sorted.find((s) => s.filename === anchor);
        // Enter navigates a directory, or opens a single selected file.
        if (entry?.isDirectory) {
          e.preventDefault();
          navigateInto(entry);
        } else if (entry && !entry.isDirectory && onOpenFile && selected.size === 1) {
          e.preventDefault();
          onOpenFile(entry);
        }
      } else if (e.key === 'Escape') {
        setMenu(null);
      }
    },
    [sorted, anchor, inlineEdit, confirmDelete, navigateInto, onOpenFile, selected],
  );

  // ---- Close menu on outside click / Escape ------------------------------
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // ---- Operations ---------------------------------------------------------
  const runOp = useCallback(
    async (fn: () => Promise<void>) => {
      setOpBusy(true);
      setOpError('');
      try {
        await fn();
        await load();
      } catch (err) {
        setOpError((err as Error).message || 'Operation failed');
      } finally {
        setOpBusy(false);
      }
    },
    [load],
  );

  const startNewFolder = useCallback(() => {
    setMenu(null);
    setConfirmDelete(null);
    setInlineEdit({ kind: 'new-folder', value: '' });
  }, []);

  const startRename = useCallback((entry: RemoteDirEntry) => {
    setMenu(null);
    setConfirmDelete(null);
    setSelected(new Set([entry.filename]));
    setAnchor(entry.filename);
    setInlineEdit({ kind: 'rename', name: entry.filename, value: entry.filename });
  }, []);

  const commitInlineEdit = useCallback(() => {
    const edit = inlineEdit;
    if (!edit) return;
    const value = edit.value.trim();
    if (edit.kind === 'new-folder') {
      if (!value) {
        setInlineEdit(null);
        return;
      }
      setInlineEdit(null);
      void runOp(() => provider.mkdir(provider.join(path, value)));
    } else {
      if (!value || value === edit.name) {
        setInlineEdit(null);
        return;
      }
      setInlineEdit(null);
      void runOp(() => provider.rename(provider.join(path, edit.name), provider.join(path, value)));
    }
  }, [inlineEdit, runOp, provider, path]);

  const requestDelete = useCallback(
    (names: string[]) => {
      setMenu(null);
      if (names.length === 0) return;
      setConfirmDelete(names);
    },
    [],
  );

  const confirmDeleteNow = useCallback(() => {
    const names = confirmDelete;
    if (!names) return;
    setConfirmDelete(null);
    void runOp(async () => {
      for (const name of names) {
        await provider.delete(provider.join(path, name));
      }
    });
  }, [confirmDelete, runOp, provider, path]);

  const openContextMenu = useCallback(
    (e: React.MouseEvent, entry: RemoteDirEntry) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-clicking a row outside the current selection selects just it.
      if (!selected.has(entry.filename)) {
        setSelected(new Set([entry.filename]));
        setAnchor(entry.filename);
      }
      const rect = containerRef.current?.getBoundingClientRect();
      setMenu({
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
        entry,
      });
    },
    [selected],
  );

  // ---- Breadcrumb segments -----------------------------------------------
  const crumbs = useMemo(() => provider.crumbs(path), [provider, path]);

  // ---- Styles -------------------------------------------------------------
  const toolbarBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: '0.85em',
    borderRadius: 4, border: '1px solid transparent', background: 'transparent',
    color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const headerCell: React.CSSProperties = {
    padding: '5px 10px', fontSize: '0.8em', fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: 0.4, cursor: 'pointer', userSelect: 'none',
    position: 'sticky', top: 0, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)',
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  const renderNameCell = (entry: RemoteDirEntry, isEditing: boolean) => {
    if (isEditing && inlineEdit && inlineEdit.kind === 'rename') {
      return (
        <input
          ref={editInputRef}
          value={inlineEdit.value}
          onChange={(e) => setInlineEdit({ ...inlineEdit, value: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitInlineEdit();
            else if (e.key === 'Escape') setInlineEdit(null);
          }}
          onBlur={commitInlineEdit}
          style={{
            flex: 1, minWidth: 0, fontSize: '0.92em', padding: '1px 4px', background: 'var(--bg-primary)',
            border: '1px solid var(--accent)', borderRadius: 3, color: 'var(--text-primary)', outline: 'none',
          }}
        />
      );
    }
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {entry.isDirectory ? <FolderGlyph /> : <FileGlyph />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.filename}
        </span>
        {entry.isSymlink && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }} title="symlink">↗</span>}
      </span>
    );
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', fontSize: baseFont, outline: 'none' }}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      {/* Toolbar: breadcrumb + actions */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 32, minHeight: 32,
          padding: '0 8px', background: 'var(--bg-titlebar)', borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {crumbs.map((crumb, i) => (
            <React.Fragment key={crumb.path}>
              {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: '0.85em', opacity: 0.6 }}>/</span>}
              <button
                onClick={() => onPathChange(crumb.path)}
                disabled={crumb.path === path}
                title={crumb.path}
                style={{
                  fontSize: '0.85em', padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent',
                  color: crumb.path === path ? 'var(--text-primary)' : 'var(--text-muted)',
                  cursor: crumb.path === path ? 'default' : 'pointer', whiteSpace: 'nowrap',
                  maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
                  fontWeight: crumb.path === path ? 600 : 400,
                }}
                onMouseEnter={(e) => { if (crumb.path !== path) e.currentTarget.style.color = 'var(--accent)'; }}
                onMouseLeave={(e) => { if (crumb.path !== path) e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>
        <button
          style={toolbarBtn}
          onClick={startNewFolder}
          disabled={opBusy}
          title="New folder"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
        >
          + New folder
        </button>
        <button
          style={toolbarBtn}
          onClick={() => void load()}
          disabled={loading || opBusy}
          title="Refresh"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
        >
          ⟳ Refresh
        </button>
      </div>

      {/* Loading bar */}
      {loading && (
        <div style={{ height: 2, background: 'var(--accent)', opacity: 0.7, flexShrink: 0 }} />
      )}

      {/* Op error banner */}
      {opError && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11,
            background: 'rgba(241,76,76,0.12)', color: 'var(--accent-red)', borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{opError}</span>
          <button
            onClick={() => setOpError('')}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Delete confirm bar */}
      {confirmDelete && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 11,
            background: 'rgba(241,76,76,0.12)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1 }}>
            Delete {confirmDelete.length === 1 ? `“${confirmDelete[0]}”` : `${confirmDelete.length} items`}?{' '}
            {provider.kind === 'local' ? 'Items move to the Trash.' : 'This cannot be undone.'}
          </span>
          <button
            onClick={confirmDeleteNow}
            disabled={opBusy}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', background: 'var(--accent-red)', color: '#fff', cursor: 'pointer' }}
          >
            Delete
          </button>
          <button
            onClick={() => setConfirmDelete(null)}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Table */}
      <div
        style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'auto' }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* External-drop highlight overlay (does not intercept drop events) */}
        {dragOver && (
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none',
              border: '2px dashed var(--accent)', borderRadius: 6,
              background: 'rgba(58,150,221,0.10)', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'var(--bg-surface)', padding: '4px 12px', borderRadius: 6, border: '1px solid var(--accent)' }}>
              {provider.kind === 'remote' ? 'Drop to upload here' : 'Drop to copy here'}
            </span>
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em', color: 'var(--text-primary)', tableLayout: 'fixed' }}>
          <colgroup>
            {visibleCols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleCols.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  style={{ ...headerCell, textAlign: c.align ?? 'left' }}
                >
                  {c.label}{sortArrow(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Loading / error / empty states */}
            {loadError ? (
              <tr>
                <td colSpan={visibleCols.length} style={{ padding: '16px 10px', textAlign: 'center' }}>
                  <div style={{ color: 'var(--accent-red)', fontSize: '0.92em', marginBottom: 8 }}>{loadError}</div>
                  <button
                    onClick={() => void load()}
                    style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--accent)', cursor: 'pointer' }}
                  >
                    Retry
                  </button>
                </td>
              </tr>
            ) : (
              <>
                {/* ".." parent row */}
                {!provider.isRoot(path) && (
                  <tr
                    onClick={navigateUp}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '3px 10px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                        <span style={{ flexShrink: 0 }}>↩</span> ..
                      </span>
                    </td>
                    {visibleMetaCols.map((c) => <td key={c.key} />)}
                  </tr>
                )}

                {/* New-folder inline input row */}
                {inlineEdit && inlineEdit.kind === 'new-folder' && (
                  <tr>
                    <td style={{ padding: '3px 10px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FolderGlyph />
                        <input
                          ref={editInputRef}
                          value={inlineEdit.value}
                          placeholder="New folder name"
                          onChange={(e) => setInlineEdit({ ...inlineEdit, value: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitInlineEdit();
                            else if (e.key === 'Escape') setInlineEdit(null);
                          }}
                          onBlur={commitInlineEdit}
                          style={{
                            flex: 1, minWidth: 0, fontSize: '0.92em', padding: '1px 4px', background: 'var(--bg-primary)',
                            border: '1px solid var(--accent)', borderRadius: 3, color: 'var(--text-primary)', outline: 'none',
                          }}
                        />
                      </span>
                    </td>
                    {visibleMetaCols.map((c) => <td key={c.key} />)}
                  </tr>
                )}

                {/* Rows */}
                {sorted.map((entry) => {
                  const isSel = selected.has(entry.filename);
                  const isEditing = !!inlineEdit && inlineEdit.kind === 'rename' && inlineEdit.name === entry.filename;
                  return (
                    <tr
                      key={entry.filename}
                      onClick={(e) => selectRow(entry.filename, e)}
                      onDoubleClick={() => activateEntry(entry)}
                      onContextMenu={(e) => openContextMenu(e, entry)}
                      style={{
                        cursor: entry.isDirectory ? 'pointer' : 'default',
                        background: isSel ? 'var(--bg-hover)' : 'transparent',
                        boxShadow: isSel ? 'inset 2px 0 0 var(--accent)' : 'none',
                      }}
                      onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ padding: '3px 10px', maxWidth: 0 }}>{renderNameCell(entry, isEditing)}</td>
                      {visibleKeys.has('size') && (
                        <td style={{ padding: '3px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {entry.isDirectory ? '—' : formatSize(entry.size)}
                        </td>
                      )}
                      {visibleKeys.has('mtime') && (
                        <td style={{ padding: '3px 10px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatMtime(entry.mtime, Date.now())}
                        </td>
                      )}
                      {visibleKeys.has('mode') && (
                        <td style={{ padding: '3px 10px', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '0.85em' }}>
                          {formatMode(entry.mode)}
                        </td>
                      )}
                    </tr>
                  );
                })}

                {/* Empty */}
                {!loading && sorted.length === 0 && !inlineEdit && (
                  <tr>
                    <td colSpan={visibleCols.length} style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.92em' }}>
                      Empty directory
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Context menu */}
      {menu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', left: menu.x, top: menu.y, zIndex: 20, minWidth: 150,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)', padding: 4, display: 'flex', flexDirection: 'column', gap: 1,
          }}
        >
          {([
            { label: 'Rename', action: () => startRename(menu.entry) },
            {
              label: 'Delete',
              danger: true,
              action: () => requestDelete(selected.size > 0 ? Array.from(selected) : [menu.entry.filename]),
            },
            { label: 'New folder', action: startNewFolder },
          ] as { label: string; danger?: boolean; action: () => void }[]).map((item) => (
            <button
              key={item.label}
              onClick={item.action}
              disabled={opBusy}
              style={{
                display: 'flex', alignItems: 'center', padding: '5px 10px', fontSize: '0.92em', borderRadius: 4,
                border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
                color: item.danger ? 'var(--accent-red)' : 'var(--text-primary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

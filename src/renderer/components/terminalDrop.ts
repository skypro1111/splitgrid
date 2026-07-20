import type React from 'react';

// Custom MIME used to carry file path(s) when dragging from the IDE tree into a
// terminal. Kept distinct from text/plain so terminals only accept intentional
// path drags (plus OS file drops via dataTransfer.files).
export const SPLITGRID_PATH_MIME = 'application/x-splitgrid-path';

// Quote a path for shell input if it contains anything outside the safe set.
export function shellQuote(p: string): string {
  if (p === '') return "''";
  if (/[^\w@%+=:,./-]/.test(p)) {
    return `'${p.replace(/'/g, `'\\''`)}'`;
  }
  return p;
}

// True if a drag carries something a terminal should accept (our path payload
// or OS files dragged from Finder/Explorer).
export function dragHasPaths(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).some((t) => t === SPLITGRID_PATH_MIME || t === 'Files');
}

// Extract the path string to insert from a drop event. Prefers our payload,
// then OS file paths. Electron 32+ removed File.path, so resolve the path via
// webUtils.getPathForFile (exposed on the preload as getPathForFile).
export function getDroppedPaths(e: React.DragEvent): string | null {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const payload = dt.getData(SPLITGRID_PATH_MIME);
  if (payload) return payload;
  if (dt.files && dt.files.length > 0) {
    const resolve = window.electronAPI?.getPathForFile;
    const paths = Array.from(dt.files)
      .map((f) => {
        try { return resolve ? resolve(f) : (f as File & { path?: string }).path; }
        catch { return undefined; }
      })
      .filter((p): p is string => !!p)
      .map(shellQuote);
    if (paths.length > 0) return paths.join(' ');
  }
  return null;
}

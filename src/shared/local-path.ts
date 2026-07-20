// Pure, dependency-free LOCAL path helpers for the SFTP file manager's local
// pane. Local paths are separator-dependent (POSIX '/' vs Windows '\'), so
// every helper takes the separator injected — no process.platform inside —
// which keeps them unit-testable in the `node` vitest environment.

export type LocalSep = '/' | '\\';

const trimTrailing = (p: string, sep: LocalSep): string =>
  sep === '\\' ? p.replace(/\\+$/, '') : p.replace(/\/+$/, '');

/** True for the filesystem root: '/' on POSIX, a drive root ('C:' / 'C:\')
 *  or a bare '\' on Windows. */
export function isLocalRoot(path: string, sep: LocalSep): boolean {
  if (sep === '\\') return path === '\\' || /^[A-Za-z]:\\?$/.test(path);
  return path === '/' || path === '';
}

/** Append `name` to `dir` with the platform separator, collapsing any
 *  trailing separators on `dir` (so 'C:\' + 'Users' → 'C:\Users'). */
export function joinLocal(dir: string, name: string, sep: LocalSep): string {
  const trimmed = trimTrailing(dir, sep);
  if (sep === '/') return trimmed === '' ? `/${name}` : `${trimmed}/${name}`;
  return `${trimmed}\\${name}`;
}

/** Parent directory. Parent of the root is the root itself; Windows drive
 *  roots keep their trailing backslash ('C:\Users' → 'C:\'). */
export function parentLocal(path: string, sep: LocalSep): string {
  if (sep === '/') {
    if (path === '/' || path === '') return '/';
    const trimmed = trimTrailing(path, sep);
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
  }
  if (isLocalRoot(path, sep)) return path;
  const trimmed = trimTrailing(path, sep);
  const idx = trimmed.lastIndexOf('\\');
  if (idx === -1) return trimmed;
  const head = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(head)) return `${head}\\`;
  return head || '\\';
}

/** Breadcrumb segments root-first. POSIX: [{'/'}, ...segments] (identical to
 *  the remote table's crumbs); Windows: [{'C:' → 'C:\'}, ...segments]. */
export function pathCrumbs(path: string, sep: LocalSep): { label: string; path: string }[] {
  if (sep === '/') {
    const segs = path.split('/').filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const seg of segs) {
      acc += `/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }
  const segs = trimTrailing(path, sep).split('\\').filter(Boolean);
  if (segs.length === 0) return [{ label: '\\', path: '\\' }];
  const drive = segs[0];
  const out: { label: string; path: string }[] = [{ label: drive, path: `${drive}\\` }];
  let acc = drive;
  for (const seg of segs.slice(1)) {
    acc += `\\${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

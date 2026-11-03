import type { Container, Workspace } from '../../shared/types';

// A local terminal's live cwd, pushed by main whenever its shell `cd`s, is
// written into the pane's saved `content.cwd` — the folder the terminal is
// restored into when the workspace opens again (after a close, a quit, or a
// killed app, since the normal save puts it on disk within a second).

const isLocalTerminal = (c: Container, terminalId: string): boolean =>
  c.content.type === 'terminal' &&
  c.content.terminalType !== 'ssh' &&
  c.content.terminalId === terminalId;

/**
 * Set `cwd` on the pane running `terminalId`, in whichever workspace holds it.
 * Returns the SAME array when nothing changes, so an unchanged cwd triggers no
 * re-render and no save. Leaves `updatedAt` alone: a `cd` is not an edit of
 * the workspace and must not reorder recent lists.
 */
export function applyTerminalCwd(workspaces: Workspace[], terminalId: string, cwd: string): Workspace[] {
  if (!terminalId || !cwd) return workspaces;
  let changed = false;
  const next = workspaces.map((ws) => {
    let wsChanged = false;
    const containers = ws.containers.map((c) => {
      if (!isLocalTerminal(c, terminalId) || c.content.cwd === cwd) return c;
      wsChanged = true;
      return { ...c, content: { ...c.content, cwd } };
    });
    if (!wsChanged) return ws;
    changed = true;
    return { ...ws, containers };
  });
  return changed ? next : workspaces;
}

/** Overlay freshly read cwds (terminalId → cwd) onto a workspace's panes. */
export function withTerminalCwds(ws: Workspace, cwds: Record<string, string>): Workspace {
  let changed = false;
  const containers = ws.containers.map((c) => {
    const id = c.content.terminalId;
    const cwd = id ? cwds[id] : undefined;
    if (!id || !cwd || !isLocalTerminal(c, id) || c.content.cwd === cwd) return c;
    changed = true;
    return { ...c, content: { ...c.content, cwd } };
  });
  return changed ? { ...ws, containers } : ws;
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionGroupsState, SavedConnection } from '../../shared/types';

// Saved-connection groups for the SSH surfaces (Settings → SSH, the SSH connect
// pane, the SFTP chooser). Groups and their fold state live in main and are
// global across environment windows; every change is broadcast, so each hook
// instance refetches and all surfaces show the same groups in the same state.

export interface ConnectionGroupSection {
  /** Group name, or null for connections without a group. */
  name: string | null;
  connections: SavedConnection[];
}

/**
 * Split connections into sections following `groupOrder` (groups a connection
 * names but the order lacks are appended), with ungrouped connections last.
 * Empty groups are kept only when `keepEmpty` is set; the ungrouped section is
 * omitted when empty. Connection order within a section is preserved.
 */
export function groupConnections(
  connections: SavedConnection[],
  groupOrder: string[],
  keepEmpty = false,
): ConnectionGroupSection[] {
  const byGroup = new Map<string, SavedConnection[]>();
  for (const g of groupOrder) byGroup.set(g, []);
  const ungrouped: SavedConnection[] = [];
  for (const c of connections) {
    if (!c.group) { ungrouped.push(c); continue; }
    const list = byGroup.get(c.group);
    if (list) list.push(c); else byGroup.set(c.group, [c]);
  }
  const sections: ConnectionGroupSection[] = [];
  for (const [name, list] of byGroup) {
    if (list.length > 0 || keepEmpty) sections.push({ name, connections: list });
  }
  if (ungrouped.length > 0) sections.push({ name: null, connections: ungrouped });
  return sections;
}

const EMPTY: ConnectionGroupsState = { groups: [], collapsed: [] };

export function useConnectionGroups() {
  const [state, setState] = useState<ConnectionGroupsState>(EMPTY);

  useEffect(() => {
    let alive = true;
    const load = () => {
      window.electronAPI.getConnectionGroups()
        .then((next) => { if (alive) setState(next); })
        .catch((e) => console.error('Failed to load connection groups:', e));
    };
    load();
    const unsubscribe = window.electronAPI.onSavedConnectionsChanged(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  const collapsed = useMemo(() => new Set(state.collapsed), [state.collapsed]);

  const setCollapsed = useCallback((name: string, value: boolean) => {
    // Optimistic so the chevron flips instantly; the broadcast confirms it.
    setState((prev) => ({
      ...prev,
      collapsed: value
        ? Array.from(new Set([...prev.collapsed, name]))
        : prev.collapsed.filter((g) => g !== name),
    }));
    void window.electronAPI.setConnectionGroupCollapsed(name, value);
  }, []);

  return {
    groups: state.groups,
    collapsed,
    setCollapsed,
    createGroup: window.electronAPI.createConnectionGroup,
    renameGroup: window.electronAPI.renameConnectionGroup,
    deleteGroup: window.electronAPI.deleteConnectionGroup,
    moveToGroup: window.electronAPI.moveConnectionsToGroup,
  };
}

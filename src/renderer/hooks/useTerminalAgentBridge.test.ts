import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runTerminalAgentCommand, type BridgeDeps } from './useTerminalAgentBridge';
import { openInZone } from '../../shared/agent-zones';
import type { LayoutNode, Workspace } from '../../shared/types';

// `background` / `foreground`: an agent collapses a pane of its zone into the
// zone's tray or brings it back out. Only its own zone panes, and a pane
// already in place is a no-op.

const term = (id: string) => ({ id: `c-${id}`, content: { type: 'terminal' as const, terminalType: 'local' as const, terminalId: id } });

function workspace(): Workspace {
  const zone = { terminal: 'me', name: 'main', label: 'me', anchorId: 'c-me' };
  let tree: LayoutNode | null = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', containerId: 'c-user' }, second: { type: 'leaf', containerId: 'c-me' } };
  for (const [id, background] of [['p1', false], ['bg1', true]] as const) {
    const r = openInZone(tree, { ...zone, newId: `c-${id}`, background });
    if (!r.ok) throw new Error(r.message);
    tree = r.tree;
  }
  return {
    id: 'ws-1', name: 'Main', workingDirectory: null, layoutTree: tree,
    containers: [term('user'), term('me'), term('p1'), term('bg1')],
    containerZooms: {}, focusedContainerId: null,
  } as unknown as Workspace;
}

let deps: BridgeDeps;
beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { getActiveSessions: vi.fn(async () => []) } };
  deps = {
    workspaces: [workspace()],
    openInZone: vi.fn(() => 'x'),
    moveZonePane: vi.fn(),
    removeContainer: vi.fn(),
    createLocalTerminal: vi.fn(),
    connectSaved: vi.fn(),
    closeSession: vi.fn(async () => {}),
    savedConnections: [],
  } as unknown as BridgeDeps;
});

describe('terminal bridge: background / foreground', () => {
  it('moves a zone pane into the tray and back out', async () => {
    expect(await runTerminalAgentCommand(deps, 'me', ['background', 'p1'])).toMatchObject({ ok: true, data: { id: 'p1', background: true, moved: true } });
    expect(deps.moveZonePane).toHaveBeenCalledWith('ws-1', 'c-p1', true);
    expect(await runTerminalAgentCommand(deps, 'me', ['foreground', 'bg1'])).toMatchObject({ ok: true, data: { background: false, moved: true } });
    expect(deps.moveZonePane).toHaveBeenLastCalledWith('ws-1', 'c-bg1', false);
  });

  it('does nothing for a pane already in place', async () => {
    expect(await runTerminalAgentCommand(deps, 'me', ['background', 'bg1'])).toMatchObject({ ok: true, data: { moved: false } });
    expect(deps.moveZonePane).not.toHaveBeenCalled();
  });

  it('refuses panes outside the caller\'s zone', async () => {
    expect(await runTerminalAgentCommand(deps, 'me', ['background', 'user'])).toMatchObject({ ok: false, error: 'not_in_zone' });
    expect(await runTerminalAgentCommand(deps, 'me', ['background', 'p1', '--zone', 'review'])).toMatchObject({ ok: false, error: 'not_in_zone' });
    expect(deps.moveZonePane).not.toHaveBeenCalled();
  });
});

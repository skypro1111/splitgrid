import { describe, it, expect } from 'vitest';
import { resolveHistoryCaller } from './useHistoryAgentBridge';
import type { Workspace } from '../../shared/types';

// The renderer's one job in the history bridge is to say which workspace holds
// the calling terminal. Getting it wrong would hand an agent another workspace's
// sessions, so the lookup is pinned: membership only, no fallbacks.

function workspace(id: string, dir: string | null, terminalIds: string[]): Workspace {
  return {
    id,
    name: id,
    workingDirectory: dir,
    layoutTree: null,
    containers: terminalIds.map((t, i) => ({ id: `${id}-c${i}`, content: { type: 'terminal', terminalType: 'local', terminalId: t } })),
    containerZooms: {},
    focusedContainerId: null,
  } as Workspace;
}

describe('resolveHistoryCaller', () => {
  const A = workspace('ws-a', '/Users/me/a', ['term-a1', 'term-a2']);
  const B = workspace('ws-b', null, ['term-b1']);

  it('answers with the workspace that contains the terminal', () => {
    expect(resolveHistoryCaller([A, B], 'term-a2')).toEqual({ ok: true, data: { workspaceId: 'ws-a', workingDirectory: '/Users/me/a' } });
  });

  it('passes a folderless workspace through as null (main turns it into workspace_has_no_folder)', () => {
    expect(resolveHistoryCaller([A, B], 'term-b1')).toEqual({ ok: true, data: { workspaceId: 'ws-b', workingDirectory: null } });
  });

  it('refuses an unknown terminal even when only one workspace exists', () => {
    expect(resolveHistoryCaller([A], 'term-x')).toMatchObject({ ok: false, error: 'unknown_terminal' });
    expect(resolveHistoryCaller([A], '')).toMatchObject({ ok: false, error: 'unknown_terminal' });
  });
});

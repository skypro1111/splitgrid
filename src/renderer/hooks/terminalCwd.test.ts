import { describe, expect, it } from 'vitest';
import type { Container, Workspace } from '../../shared/types';
import { applyTerminalCwd, withTerminalCwds } from './terminalCwd';

const term = (id: string, terminalId: string, cwd: string, terminalType: 'local' | 'ssh' = 'local'): Container => ({
  id,
  content: { type: 'terminal', terminalType, terminalId, cwd },
});

const ws = (id: string, containers: Container[]): Workspace => ({
  id,
  name: id,
  workingDirectory: '/ws',
  layoutTree: null,
  containers,
  containerZooms: {},
  focusedContainerId: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('applyTerminalCwd', () => {
  it('updates the pane running the terminal, in any workspace', () => {
    const before = [ws('a', [term('c1', 't1', '/old')]), ws('b', [term('c2', 't2', '/x')])];
    const after = applyTerminalCwd(before, 't2', '/new');
    expect(after[1].containers[0].content.cwd).toBe('/new');
    // Untouched workspace keeps its identity.
    expect(after[0]).toBe(before[0]);
  });

  it('does not bump updatedAt', () => {
    const after = applyTerminalCwd([ws('a', [term('c1', 't1', '/old')])], 't1', '/new');
    expect(after[0].updatedAt).toBe(1);
  });

  it('returns the same array when the cwd is unchanged or the terminal is unknown', () => {
    const before = [ws('a', [term('c1', 't1', '/same')])];
    expect(applyTerminalCwd(before, 't1', '/same')).toBe(before);
    expect(applyTerminalCwd(before, 'nope', '/new')).toBe(before);
    expect(applyTerminalCwd(before, 't1', '')).toBe(before);
  });

  it('leaves SSH panes alone', () => {
    const before = [ws('a', [term('c1', 't1', '/remote', 'ssh')])];
    expect(applyTerminalCwd(before, 't1', '/local')).toBe(before);
  });

  it('keeps the rest of the pane content', () => {
    const c: Container = { id: 'c1', content: { type: 'terminal', terminalType: 'local', terminalId: 't1', cwd: '/old', label: 'L', shell: '/bin/zsh' } };
    const after = applyTerminalCwd([ws('a', [c])], 't1', '/new');
    expect(after[0].containers[0].content).toEqual({ ...c.content, cwd: '/new' });
  });
});

describe('withTerminalCwds', () => {
  it('overlays fresh cwds onto matching local panes only', () => {
    const w = ws('a', [term('c1', 't1', '/old'), term('c2', 't2', '/r', 'ssh'), { id: 'c3', content: { type: 'empty' } }]);
    const out = withTerminalCwds(w, { t1: '/new', t2: '/ignored' });
    expect(out.containers[0].content.cwd).toBe('/new');
    expect(out.containers[1].content.cwd).toBe('/r');
    expect(out.containers[2]).toBe(w.containers[2]);
  });

  it('returns the same workspace when nothing changes', () => {
    const w = ws('a', [term('c1', 't1', '/same')]);
    expect(withTerminalCwds(w, { t1: '/same' })).toBe(w);
    expect(withTerminalCwds(w, {})).toBe(w);
  });
});

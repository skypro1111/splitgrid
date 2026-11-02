import { describe, expect, it } from 'vitest';
import type { Container, LayoutNode, Workspace } from '../../shared/types';
import { openInZone } from '../../shared/agent-zones';
import { inZone, resolveZoneRequest, takeZoneFlags, zonePanes } from './agentZone';

const term = (id: string, terminalId: string, label: string): Container => ({
  id, content: { type: 'terminal', terminalType: 'local', terminalId, label },
});

// A workspace with the caller's terminal (c-me), a user terminal (c-user) and
// one pane (c-z1, a browser) already in the caller's main zone.
function workspace(): Workspace {
  const base: LayoutNode = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', containerId: 'c-user' }, second: { type: 'leaf', containerId: 'c-me' } };
  const r = openInZone(base, { terminal: 't-me', name: 'main', label: 'claude', newId: 'c-z1', anchorId: 'c-me' });
  if (!r.ok) throw new Error(r.message);
  return {
    id: 'w', name: 'w', workingDirectory: null, layoutTree: r.tree, containerZooms: {}, focusedContainerId: null,
    containers: [term('c-user', 't-user', 'user'), term('c-me', 't-me', 'claude'), { id: 'c-z1', content: { type: 'browser' } }],
    createdAt: 0, updatedAt: 0,
  };
}

describe('takeZoneFlags', () => {
  it('pulls the zone flags out of any position, both spellings', () => {
    expect(takeZoneFlags(['ssh', '--zone', 'review', 'prod', '--split=down', '--at', 'x'])).toEqual({
      flags: { zone: 'review', split: 'down', at: 'x' },
      rest: ['ssh', 'prod'],
    });
    expect(takeZoneFlags(['build'])).toEqual({ flags: {}, rest: ['build'] });
    expect(takeZoneFlags(['dev', '--bg'])).toEqual({ flags: { background: true }, rest: ['dev'] });
  });
});

describe('resolveZoneRequest', () => {
  it('labels the main zone after the caller\'s terminal and a named one after both', () => {
    const ws = workspace();
    const main = resolveZoneRequest(ws, 't-me', {});
    expect(main.ok && main.req.owner).toEqual({ terminal: 't-me', name: 'main', label: 'claude' });
    const named = resolveZoneRequest(ws, 't-me', { zone: 'review', split: 'down' });
    expect(named.ok && named.req).toEqual({ owner: { terminal: 't-me', name: 'review', label: 'claude · review' }, at: undefined, split: 'down' });
  });

  it('accepts --at for a zone pane and refuses anything outside the zone', () => {
    const ws = workspace();
    const ok = resolveZoneRequest(ws, 't-me', { at: 'c-z1' });
    expect(ok.ok && ok.req.at).toBe('c-z1');
    for (const at of ['t-user', 't-me', 'nope']) {
      const r = resolveZoneRequest(ws, 't-me', { at });
      expect(!r.ok && r.error).toBe('not_in_zone');
    }
    // A subagent's empty zone has nothing to split yet.
    const empty = resolveZoneRequest(ws, 't-me', { zone: 'review', at: 'c-z1' });
    expect(!empty.ok && empty.error).toBe('not_in_zone');
  });

  it('rejects a bad zone name or split', () => {
    const ws = workspace();
    const badZone = resolveZoneRequest(ws, 't-me', { zone: 'has space' });
    expect(!badZone.ok && badZone.error).toBe('bad_zone');
    const badSplit = resolveZoneRequest(ws, 't-me', { split: 'left' });
    expect(!badSplit.ok && badSplit.error).toBe('bad_split');
  });
});

describe('zone membership', () => {
  it('reports zone panes by CLI id and only them as in the zone', () => {
    const ws = workspace();
    const me = { terminal: 't-me', name: 'main' };
    expect(zonePanes(ws, me)).toEqual([{ id: 'c-z1', type: 'browser' }]);
    expect(inZone(ws, me, 'c-z1')).toBe(true);
    expect(inZone(ws, me, 't-user')).toBe(false);
    expect(inZone(ws, me, 't-me')).toBe(false);
    expect(inZone(ws, { terminal: 't-other', name: 'main' }, 'c-z1')).toBe(false);
  });
});

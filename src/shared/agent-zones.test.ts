import { describe, expect, it } from 'vitest';
import type { LayoutNode } from './types';
import { TRAY_RATIO, findZone, openInZone, parseZoneSplit, zoneLayout, zonePaneIds, type OpenInZoneArgs } from './agent-zones';
import { leafIds, pruneLayoutTree, removeLeaf, replaceLeaf } from './layout-tree';

const leaf = (containerId: string): LayoutNode => ({ type: 'leaf', containerId });
const A = { terminal: 'term-a', name: 'main' };

// Open `newId` for the given owner and return the new tree (fails the test on error).
function open(tree: LayoutNode | null, newId: string, extra: Partial<OpenInZoneArgs> = {}): LayoutNode {
  const r = openInZone(tree, { ...A, label: 'Agent A', newId, anchorId: 'caller', ...extra });
  if (!r.ok) throw new Error(r.message);
  return r.tree;
}

describe('openInZone', () => {
  it('creates the zone by splitting the agent\'s own terminal, to the right by default', () => {
    const tree = { type: 'split', direction: 'vertical', ratio: 0.5, first: leaf('user'), second: leaf('caller') } as LayoutNode;
    const r = openInZone(tree, { ...A, label: 'Agent A', newId: 'p1', anchorId: 'caller' });
    expect(r.ok && r.createdZone).toBe(true);
    expect(r.ok && r.tree).toEqual({
      type: 'split', direction: 'vertical', ratio: 0.5, first: leaf('user'),
      second: {
        type: 'split', direction: 'horizontal', ratio: 0.5, first: leaf('caller'),
        second: { type: 'leaf', containerId: 'p1', zone: { ...A, label: 'Agent A' } },
      },
    });
  });

  it('keeps every later pane inside the zone, in the order they were opened', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    tree = open(tree, 'p3');
    tree = open(tree, 'p4');
    expect(zonePaneIds(tree, A)).toEqual(['p1', 'p2', 'p3', 'p4']);
    // The rest of the workspace is untouched: the caller is still the first pane,
    // and the zone is one subtree beside it.
    expect(tree.type === 'split' && tree.first).toEqual(leaf('caller'));
    expect(tree.type === 'split' && leafIds(tree.second)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(findZone(tree, A)).toBe(tree.type === 'split' ? tree.second : null);
  });

  it('alternates right and down by default, and honours an explicit split', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    tree = open(tree, 'p3');
    const zone = findZone(tree, A)!;
    expect(zone.type === 'split' && zone.direction).toBe('horizontal');
    expect(zone.type === 'split' && zone.second.type === 'split' && zone.second.direction).toBe('vertical');

    const downOnly = open(open(open(leaf('caller'), 'p1'), 'p2', { split: 'down' }), 'p3', { split: 'down' });
    const z = findZone(downOnly, A)!;
    expect(z.type === 'split' && z.direction).toBe('vertical');
    expect(z.type === 'split' && z.second.type === 'split' && z.second.direction).toBe('vertical');
  });

  it('splits a chosen pane of the zone with --at', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    tree = open(tree, 'p3', { at: 'p1', split: 'down' });
    expect(zonePaneIds(tree, A)).toEqual(['p1', 'p3', 'p2']);
  });

  it('refuses --at for a pane outside the zone', () => {
    const tree = open(leaf('caller'), 'p1');
    const r = openInZone(tree, { ...A, label: 'Agent A', newId: 'p2', anchorId: 'caller', at: 'caller' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('not_in_zone');
  });

  it('gives subagents sharing a terminal their own zones', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 's1', { name: 'review' });
    tree = open(tree, 's2', { name: 'review' });
    tree = open(tree, 'p2');
    expect(zonePaneIds(tree, A)).toEqual(['p1', 'p2']);
    expect(zonePaneIds(tree, { terminal: 'term-a', name: 'review' })).toEqual(['s1', 's2']);
  });

  it('nests the zone of an agent running inside another agent\'s zone, and keeps the panes apart', () => {
    const B = { terminal: 'term-b', name: 'main' };
    let tree = open(leaf('caller'), 'p1');        // A's zone: p1 (a terminal B will run in)
    tree = open(tree, 'b1', { ...B, anchorId: 'p1' });
    tree = open(tree, 'p2');
    expect(zonePaneIds(tree, A)).toEqual(['p1', 'p2']);
    expect(zonePaneIds(tree, B)).toEqual(['b1']);
    // B's zone lives inside A's.
    expect(leafIds(findZone(tree, A))).toEqual(['p1', 'p2', 'b1']);
  });

  it('starts a zone in an empty workspace as the root', () => {
    const r = openInZone(null, { ...A, label: 'Agent A', newId: 'p1', anchorId: null });
    expect(r.ok && r.tree).toEqual({ type: 'leaf', containerId: 'p1', zone: { ...A, label: 'Agent A' } });
  });
});

describe('zone tray (background processes)', () => {
  it('puts background panes in a thin strip along the zone bottom, side by side', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    tree = open(tree, 'bg1', { background: true });
    tree = open(tree, 'bg2', { background: true });
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p1', 'p2'], tray: ['bg1', 'bg2'] });
    const zone = findZone(tree, A)!;
    expect(zone.type === 'split' && [zone.direction, zone.ratio]).toEqual(['vertical', TRAY_RATIO]);
    const tray = zoneLayout(tree, A).trayRoot!;
    expect(tray.type === 'split' && tray.direction).toBe('horizontal');
    // Regular panes keep going above the tray.
    tree = open(tree, 'p3');
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p1', 'p2', 'p3'], tray: ['bg1', 'bg2'] });
  });

  it('starts as a strip under the agent\'s terminal, and grows for the first regular pane', () => {
    let tree = open(leaf('caller'), 'bg1', { background: true });
    expect(tree).toMatchObject({ type: 'split', direction: 'vertical', ratio: TRAY_RATIO, first: leaf('caller') });
    tree = open(tree, 'p1');
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p1'], tray: ['bg1'] });
    expect(tree).toMatchObject({ type: 'split', direction: 'vertical', ratio: 0.5, first: leaf('caller') });
    const zone = findZone(tree, A)!;
    expect(zone.type === 'split' && zone.ratio).toBe(TRAY_RATIO);
  });

  it('keeps --at to the pool the pane joins', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'bg1', { background: true });
    const r = openInZone(tree, { ...A, label: 'Agent A', newId: 'x', anchorId: 'caller', at: 'p1', background: true });
    expect(!r.ok && r.error).toBe('not_in_zone');
    expect(zonePaneIds(open(tree, 'bg2', { background: true, at: 'bg1' }), A)).toEqual(['p1', 'bg1', 'bg2']);
  });

  it('drops the tray when its last pane closes, and the zone when nothing is left', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'bg1', { background: true });
    tree = open(tree, 'bg2', { background: true });
    tree = removeLeaf(tree, 'bg1')!;
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p1'], tray: ['bg2'] });
    tree = removeLeaf(tree, 'bg2')!;
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p1'], tray: [], trayRoot: null });
    tree = removeLeaf(tree, 'p1')!;
    expect(tree).toEqual(leaf('caller'));
  });

  it('leaves a tray-only zone when the regular panes close', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'bg1', { background: true });
    tree = removeLeaf(tree, 'p1')!;
    expect(zoneLayout(tree, A)).toMatchObject({ main: [], tray: ['bg1'] });
    tree = open(tree, 'p2');
    expect(zoneLayout(tree, A)).toMatchObject({ main: ['p2'], tray: ['bg1'] });
  });
});

describe('zone tag through layout edits', () => {
  it('survives closing panes until the last one goes', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    tree = open(tree, 'p3');
    tree = removeLeaf(tree, 'p1')!;
    expect(zonePaneIds(tree, A)).toEqual(['p2', 'p3']);
    tree = removeLeaf(tree, 'p3')!;
    expect(zonePaneIds(tree, A)).toEqual(['p2']);
    tree = removeLeaf(tree, 'p2')!;
    expect(findZone(tree, A)).toBeNull();
    expect(tree).toEqual(leaf('caller'));
  });

  it('survives pruning a dangling zone pane', () => {
    let tree = open(leaf('caller'), 'p1');
    tree = open(tree, 'p2');
    const pruned = pruneLayoutTree(tree, (id) => id !== 'p1');
    expect(zonePaneIds(pruned, A)).toEqual(['p2']);
  });

  it('takes in a pane the user splits off a zone pane', () => {
    const tree = open(leaf('caller'), 'p1');
    const split: LayoutNode = { type: 'split', direction: 'vertical', ratio: 0.5, first: leaf('p1'), second: leaf('u1') };
    expect(zonePaneIds(replaceLeaf(tree, 'p1', split), A)).toEqual(['p1', 'u1']);
  });
});

describe('parseZoneSplit', () => {
  it('reads right/down and their aliases, and flags anything else', () => {
    expect(parseZoneSplit(undefined)).toBeUndefined();
    expect(parseZoneSplit('right')).toBe('right');
    expect(parseZoneSplit('H')).toBe('right');
    expect(parseZoneSplit('down')).toBe('down');
    expect(parseZoneSplit('vertical')).toBe('down');
    expect(parseZoneSplit('left')).toBeNull();
  });
});

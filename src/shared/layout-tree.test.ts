import { describe, it, expect } from 'vitest';
import type { LayoutNode } from './types';
import { pruneLayoutTree } from './layout-tree';

const leaf = (containerId: string): LayoutNode => ({ type: 'leaf', containerId });
const split = (first: LayoutNode, second: LayoutNode): LayoutNode => ({
  type: 'split', direction: 'horizontal', ratio: 0.5, first, second,
});
const live = (...ids: string[]) => (id: string) => ids.includes(id);

describe('pruneLayoutTree', () => {
  it('returns null for an empty tree', () => {
    expect(pruneLayoutTree(null, live('a'))).toBeNull();
    expect(pruneLayoutTree(undefined, live('a'))).toBeNull();
  });

  it('drops a lone leaf whose container is gone', () => {
    expect(pruneLayoutTree(leaf('gone'), live())).toBeNull();
  });

  it('keeps an intact tree identical (same reference)', () => {
    const tree = split(leaf('a'), split(leaf('b'), leaf('c')));
    expect(pruneLayoutTree(tree, live('a', 'b', 'c'))).toBe(tree);
  });

  it('collapses a split onto its surviving child', () => {
    expect(pruneLayoutTree(split(leaf('a'), leaf('gone')), live('a'))).toEqual(leaf('a'));
    expect(pruneLayoutTree(split(leaf('gone'), leaf('b')), live('b'))).toEqual(leaf('b'));
  });

  it('prunes nested dangling leaves and keeps the ratio of surviving splits', () => {
    const tree = split(leaf('a'), split(leaf('gone'), split(leaf('b'), leaf('c'))));
    expect(pruneLayoutTree(tree, live('a', 'b', 'c'))).toEqual(
      split(leaf('a'), split(leaf('b'), leaf('c'))),
    );
  });

  it('returns null when every container is gone', () => {
    expect(pruneLayoutTree(split(leaf('x'), split(leaf('y'), leaf('z'))), live())).toBeNull();
  });
});

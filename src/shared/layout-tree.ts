import type { LayoutNode } from './types';

// When a node collapses onto (or is replaced by) another, its agent-zone tag
// and tray mark move to the node that takes its place, so the zone (or tray)
// keeps covering the same region. A node that already roots a zone of its own
// keeps that one.
function inheritZone(from: LayoutNode, to: LayoutNode): LayoutNode {
  let out = to;
  if (from.zone && !to.zone) out = { ...out, zone: from.zone };
  if (from.zoneTray && !to.zoneTray) out = { ...out, zoneTray: true };
  return out;
}

/** Replace the leaf for `containerId` with `replacement` (e.g. a split holding it). */
export function replaceLeaf(node: LayoutNode, containerId: string, replacement: LayoutNode): LayoutNode {
  if (node.type === 'leaf') {
    return node.containerId === containerId ? inheritZone(node, replacement) : node;
  }
  const newFirst = replaceLeaf(node.first, containerId, replacement);
  if (newFirst !== node.first) return { ...node, first: newFirst };
  const newSecond = replaceLeaf(node.second, containerId, replacement);
  if (newSecond !== node.second) return { ...node, second: newSecond };
  return node;
}

/** Remove the leaf for `containerId`, promoting its sibling into the parent split's place. */
export function removeLeaf(tree: LayoutNode, containerId: string): LayoutNode | null {
  if (tree.type === 'leaf') {
    return tree.containerId === containerId ? null : tree;
  }
  // Direct child match → promote sibling
  if (tree.first.type === 'leaf' && tree.first.containerId === containerId) return inheritZone(tree, tree.second);
  if (tree.second.type === 'leaf' && tree.second.containerId === containerId) return inheritZone(tree, tree.first);
  // Recurse
  const newFirst = removeLeaf(tree.first, containerId);
  if (newFirst !== tree.first) return { ...tree, first: newFirst! };
  const newSecond = removeLeaf(tree.second, containerId);
  if (newSecond !== tree.second) return { ...tree, second: newSecond! };
  return tree;
}

export function firstLeafId(node: LayoutNode): string | null {
  if (node.type === 'leaf') return node.containerId;
  return firstLeafId(node.first) ?? firstLeafId(node.second);
}

/** Every container id in the subtree, in reading order (first before second). */
export function leafIds(node: LayoutNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.containerId];
  return [...leafIds(node.first), ...leafIds(node.second)];
}

export function swapLeaves(node: LayoutNode, id1: string, id2: string): LayoutNode {
  if (node.type === 'leaf') {
    if (node.containerId === id1) return { ...node, containerId: id2 };
    if (node.containerId === id2) return { ...node, containerId: id1 };
    return node;
  }
  return { ...node, first: swapLeaves(node.first, id1, id2), second: swapLeaves(node.second, id1, id2) };
}

/**
 * Drop every leaf whose container no longer exists, collapsing the splits that
 * are left with a single child.
 *
 * A leaf pointing at a missing container renders as nothing, yet still claims
 * its share of the grid — a workspace whose whole tree is one such leaf looks
 * empty but never shows the "Add Container" empty state, so there is no way
 * left to open a pane in it. Pruning turns that back into an ordinary empty
 * workspace.
 */
export function pruneLayoutTree(
  node: LayoutNode | null | undefined,
  hasContainer: (containerId: string) => boolean,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'leaf') return hasContainer(node.containerId) ? node : null;
  const first = pruneLayoutTree(node.first, hasContainer);
  const second = pruneLayoutTree(node.second, hasContainer);
  if (!first) return second && inheritZone(node, second);
  if (!second) return inheritZone(node, first);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

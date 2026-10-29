import type { LayoutNode } from './types';

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
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

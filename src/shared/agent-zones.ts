import type { AgentZoneTag, LayoutNode, LeafNode, SplitDirection, SplitNode } from './types';
import { firstLeafId, leafIds, replaceLeaf } from './layout-tree';

// ─── Agent zones (pure) ──────────────────────────────────────────────────────
// Each agent gets one region of the workspace for the panes it opens, so a
// handful of agents (and their subagents) can't scatter terminals and browsers
// across the user's layout. The first pane an agent opens splits its own
// terminal and becomes the zone; every later one splits a pane already in the
// zone. Panes are appended after the zone's last pane by default, so the zone
// reads in the order they were opened, and each split goes right or down.
//
// Background processes (a dev server, a watcher) go to the zone's tray instead:
// a thin strip along its bottom where they sit side by side, visible but out of
// the way.
//
// An agent is identified by its terminal plus a zone name. Subagents share the
// parent's terminal and environment, so each passes its own `--zone <name>`;
// without one, everything from that terminal lands in its `main` zone.

export const DEFAULT_ZONE = 'main';

/** The share of a zone (or of the agent's terminal) left above its tray. */
export const TRAY_RATIO = 0.85;

/** `right` puts the new pane beside the target, `down` below it. */
export type ZoneSplit = 'right' | 'down';

export interface ZoneOwner {
  terminal: string;
  name: string;
}

export interface OpenInZoneArgs extends ZoneOwner {
  /** Frame header text, used when this open creates the zone. */
  label: string;
  newId: string;
  /** The pane to split when the zone doesn't exist yet: the agent's own terminal. */
  anchorId: string | null;
  /** A pane in the zone to split; defaults to the zone's last pane. */
  at?: string;
  split?: ZoneSplit;
  /** Put the pane in the zone's tray (a background process). */
  background?: boolean;
}

export type OpenInZoneResult =
  | { ok: true; tree: LayoutNode; createdZone: boolean }
  | { ok: false; error: 'not_in_zone'; message: string };

const DIRECTION: Record<ZoneSplit, SplitDirection> = { right: 'horizontal', down: 'vertical' };

export function parseZoneSplit(value: string | undefined): ZoneSplit | undefined | null {
  if (value == null) return undefined;
  const v = value.toLowerCase();
  if (v === 'right' || v === 'h' || v === 'horizontal') return 'right';
  if (v === 'down' || v === 'v' || v === 'vertical') return 'down';
  return null;
}

export function sameZone(tag: AgentZoneTag | undefined, owner: ZoneOwner): boolean {
  return !!tag && tag.terminal === owner.terminal && tag.name === owner.name;
}

/** The node the owner's zone is rooted at, or null when it has none. */
export function findZone(node: LayoutNode | null | undefined, owner: ZoneOwner): LayoutNode | null {
  if (!node) return null;
  if (sameZone(node.zone, owner)) return node;
  if (node.type === 'leaf') return null;
  return findZone(node.first, owner) ?? findZone(node.second, owner);
}

export interface ZoneLayout {
  /** The zone's regular panes, in reading order. */
  main: string[];
  /** Its tray panes, left to right. */
  tray: string[];
  /** The node the tray is rooted at, if there is one. */
  trayRoot: LayoutNode | null;
}

// The zone's own panes. Another agent's zone nested inside (an agent running
// in a terminal this one opened) belongs to that agent.
function collect(node: LayoutNode, owner: ZoneOwner, isRoot: boolean, inTray: boolean, out: ZoneLayout): void {
  if (!isRoot && node.zone && !sameZone(node.zone, owner)) return;
  if (node.zoneTray && !inTray) { out.trayRoot = node; inTray = true; }
  if (node.type === 'leaf') { (inTray ? out.tray : out.main).push(node.containerId); return; }
  collect(node.first, owner, false, inTray, out);
  collect(node.second, owner, false, inTray, out);
}

export function zoneLayout(tree: LayoutNode | null | undefined, owner: ZoneOwner): ZoneLayout {
  const out: ZoneLayout = { main: [], tray: [], trayRoot: null };
  const zone = findZone(tree, owner);
  if (zone) collect(zone, owner, true, false, out);
  return out;
}

/** Every pane of the zone, tray included. */
export function zonePaneIds(tree: LayoutNode | null | undefined, owner: ZoneOwner): string[] {
  const { main, tray } = zoneLayout(tree, owner);
  return [...main, ...tray];
}

// Swap one node for another by identity (the tree is immutable, so a node
// found by findZone is exactly one place in it).
function replaceNode(node: LayoutNode, target: LayoutNode, replacement: LayoutNode): LayoutNode {
  if (node === target) return replacement;
  if (node.type === 'leaf') return node;
  const first = replaceNode(node.first, target, replacement);
  if (first !== node.first) return { ...node, first };
  const second = replaceNode(node.second, target, replacement);
  return second === node.second ? node : { ...node, second };
}

function parentNodeOf(node: LayoutNode, target: LayoutNode): SplitNode | null {
  if (node.type === 'leaf') return null;
  if (node.first === target || node.second === target) return node;
  return parentNodeOf(node.first, target) ?? parentNodeOf(node.second, target);
}

function withoutZone(node: LayoutNode): LayoutNode {
  const copy = { ...node };
  delete copy.zone;
  return copy;
}

// Without an explicit split, alternate against the target's parent so a run of
// opens tiles the zone (right, down, right, …) instead of slicing it ever
// thinner in one direction.
function parentOf(node: LayoutNode, containerId: string): SplitNode | null {
  if (node.type === 'leaf') return null;
  for (const child of [node.first, node.second]) {
    if (child.type === 'leaf' && child.containerId === containerId) return node;
    const found = parentOf(child, containerId);
    if (found) return found;
  }
  return null;
}

function defaultDirection(zone: LayoutNode, targetId: string): SplitDirection {
  const parent = parentOf(zone, targetId);
  if (!parent) return 'horizontal';
  return parent.direction === 'horizontal' ? 'vertical' : 'horizontal';
}

export function openInZone(tree: LayoutNode | null, args: OpenInZoneArgs): OpenInZoneResult {
  const owner = { terminal: args.terminal, name: args.name };
  const newLeaf: LeafNode = { type: 'leaf', containerId: args.newId };
  const zone = findZone(tree, owner);

  if (tree && zone) {
    const layout = zoneLayout(tree, owner);
    // The pool this pane joins: the tray for a background process, else the
    // regular panes. Empty means the zone has none of that kind yet.
    const panes = args.background ? layout.tray : layout.main;
    if (panes.length > 0) {
      const target = args.at ?? panes[panes.length - 1];
      if (!panes.includes(target)) {
        const which = args.background ? 'tray' : 'regular';
        return { ok: false, error: 'not_in_zone', message: `${args.at} is not one of your zone's ${which} panes; pass --at with one of: ${panes.join(', ')}` };
      }
      const split: SplitNode = {
        type: 'split',
        // Tray panes line up left to right; regular ones alternate.
        direction: args.split ? DIRECTION[args.split] : args.background ? 'horizontal' : defaultDirection(zone, target),
        ratio: 0.5,
        first: { type: 'leaf', containerId: target },
        second: newLeaf,
      };
      // Splitting the zone's (or tray's) root leaf moves its tag up to the new split.
      return { ok: true, tree: replaceLeaf(tree, target, split), createdZone: false };
    }
    // First pane of its kind: the zone splits into regular panes above, tray below.
    const rest = withoutZone(zone);
    const split: SplitNode = {
      type: 'split',
      direction: 'vertical',
      ratio: TRAY_RATIO,
      first: args.background ? rest : newLeaf,
      second: args.background ? { ...newLeaf, zoneTray: true } : rest,
      zone: zone.zone,
    };
    // A zone that so far is only a tray strip under the agent's terminal grows
    // to half of that space for its first regular pane, instead of squeezing
    // the pane into the strip.
    const parent = parentNodeOf(tree, zone);
    if (!args.background && parent && parent.direction === 'vertical' && parent.second === zone && parent.ratio > 0.5) {
      return { ok: true, tree: replaceNode(tree, parent, { ...parent, ratio: 0.5, second: split }), createdZone: false };
    }
    return { ok: true, tree: replaceNode(tree, zone, split), createdZone: false };
  }

  const zoned: LeafNode = {
    ...newLeaf,
    zone: { terminal: args.terminal, name: args.name, label: args.label },
    ...(args.background ? { zoneTray: true as const } : {}),
  };
  if (!tree) return { ok: true, tree: zoned, createdZone: true };
  const anchor = args.anchorId && leafIds(tree).includes(args.anchorId) ? args.anchorId : firstLeafId(tree)!;
  // A background process starts as a thin tray under the agent's terminal.
  const split: SplitNode = args.background
    ? { type: 'split', direction: 'vertical', ratio: TRAY_RATIO, first: { type: 'leaf', containerId: anchor }, second: zoned }
    : { type: 'split', direction: DIRECTION[args.split ?? 'right'], ratio: 0.5, first: { type: 'leaf', containerId: anchor }, second: zoned };
  // An agent running inside another agent's zone gets its zone nested there.
  return { ok: true, tree: replaceLeaf(tree, anchor, split), createdZone: true };
}

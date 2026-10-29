// Commit-graph layout: turns a linear list of commits (as `git log` emits them,
// newest first) into per-row lane/edge instructions the pane can draw.
//
// No ready-made library survives here — @gitgraph/* is unmaintained and built for
// hand-authored illustrations, not for a virtualized log of a real repository —
// so this is the classic "lane" algorithm, kept pure so it can be unit-tested and
// so each row's draw data is self-contained (a virtualized list only ever renders
// a window of rows, and each must be drawable on its own).
//
// Model: a row is a horizontal band. Lines enter at its top edge at lane
// positions, and leave at its bottom edge at lane positions. The commit's node
// sits at `lane`, vertically centered. A link either spans the band (top -> bottom),
// ends at the node (`toNode`), or starts at it (`fromNode`).

export interface GraphInputCommit {
  sha: string;
  parents: string[];
}

export interface GraphLink {
  /** Lane position at the top edge of the row. */
  fromLane: number;
  /** Lane position at the bottom edge of the row. */
  toLane: number;
  /** Palette index. */
  color: number;
  /** The link starts at the node's center (an edge down to a parent). */
  fromNode: boolean;
  /** The link ends at the node's center (a branch merging into this commit). */
  toNode: boolean;
}

export interface GraphRow {
  sha: string;
  /** Lane the commit's node sits in. */
  lane: number;
  color: number;
  /** Lanes occupied anywhere in this row — the width the row needs. */
  width: number;
  links: GraphLink[];
  /** True when this commit has more than one parent. */
  isMerge: boolean;
}

/** Line/node colors, by lane. Picked to stay legible on the app's dark surfaces. */
export const GRAPH_COLORS = [
  '#4c9df3',
  '#15ac91',
  '#e5b95c',
  '#ea7620',
  '#c586c0',
  '#5b9bd5',
  '#f14c4c',
  '#4fc1ff',
  '#dcdcaa',
  '#9d7cd8',
];

export function graphColor(index: number): string {
  return GRAPH_COLORS[((index % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];
}

/**
 * Lay out `commits` (parents-after-children order, as git log emits).
 *
 * Commits whose parents are not in the list — the bottom of a truncated page —
 * simply leave their lines running off the last row, which is what a partially
 * loaded log should look like.
 */
export function buildGraphRows(commits: GraphInputCommit[]): GraphRow[] {
  // lanes[i] = sha of the commit expected next in lane i, or null when free.
  const lanes: (string | null)[] = [];
  // Color travels with the lane, so a branch keeps one color down the page.
  const laneColors: number[] = [];
  let nextColor = 0;

  const allocLane = (sha: string, color?: number): number => {
    let idx = lanes.indexOf(null);
    if (idx === -1) {
      idx = lanes.length;
      lanes.push(null);
      laneColors.push(0);
    }
    lanes[idx] = sha;
    laneColors[idx] = color ?? nextColor++;
    return idx;
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const beforeColors = laneColors.slice();

    // Where does this commit sit? Its own lane if a child already reserved one,
    // otherwise a fresh lane (a branch tip, or the first row).
    let lane = before.indexOf(commit.sha);
    if (lane === -1) lane = allocLane(commit.sha);
    const color = laneColors[lane];

    // Every other lane waiting for this sha is a branch merging in — free it.
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] === commit.sha) lanes[j] = null;
    }

    const links: GraphLink[] = [];

    // Lines arriving at this row's top edge.
    for (let j = 0; j < before.length; j++) {
      const waiting = before[j];
      if (waiting === null) continue;
      if (waiting === commit.sha) {
        // Into the node: either straight down its own lane, or a merge curve.
        links.push({ fromLane: j, toLane: lane, color: beforeColors[j], fromNode: false, toNode: true });
      } else {
        // Unrelated branch passing this row untouched.
        links.push({ fromLane: j, toLane: j, color: beforeColors[j], fromNode: false, toNode: false });
      }
    }

    // Lines leaving the node, one per parent.
    const [firstParent, ...otherParents] = commit.parents;
    if (firstParent) {
      lanes[lane] = firstParent;
      links.push({ fromLane: lane, toLane: lane, color, fromNode: true, toNode: false });
    } else {
      // Root commit — the lane retires here.
      lanes[lane] = null;
    }

    for (const parent of otherParents) {
      let target = lanes.indexOf(parent);
      if (target === -1) target = allocLane(parent);
      links.push({ fromLane: lane, toLane: target, color: laneColors[target], fromNode: true, toNode: false });
    }

    // Trailing free lanes cost width for nothing.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColors.pop();
    }

    rows.push({
      sha: commit.sha,
      lane,
      color,
      width: Math.max(before.length, lanes.length, lane + 1),
      links,
      isMerge: commit.parents.length > 1,
    });
  }

  return rows;
}

/** Widest row in a page — the graph column's width in lanes. */
export function graphWidth(rows: GraphRow[]): number {
  let max = 0;
  for (const row of rows) if (row.width > max) max = row.width;
  return max;
}

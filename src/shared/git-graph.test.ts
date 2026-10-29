import { describe, it, expect } from 'vitest';
import { buildGraphRows, graphWidth, graphColor, GRAPH_COLORS } from './git-graph';

/** `a -> b` means a's parent is b. Written newest-first, like git log. */
const chain = (...pairs: Array<[string, string[]]>) =>
  pairs.map(([sha, parents]) => ({ sha, parents }));

describe('buildGraphRows', () => {
  it('keeps a linear history in one lane', () => {
    const rows = buildGraphRows(chain(['c', ['b']], ['b', ['a']], ['a', []]));

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(graphWidth(rows)).toBe(1);
    // The root commit's lane retires: nothing leaves the last row.
    expect(rows[2].links.every((l) => !l.fromNode)).toBe(true);
  });

  it('gives a second branch tip its own lane and color', () => {
    // Two tips (c, d) both descending from a.
    const rows = buildGraphRows(chain(['c', ['a']], ['d', ['a']], ['a', []]));

    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    expect(rows[0].color).not.toBe(rows[1].color);
    // `a` collapses back into lane 0, with lane 1 curving into it.
    expect(rows[2].lane).toBe(0);
    expect(rows[2].links).toContainEqual(
      expect.objectContaining({ fromLane: 1, toLane: 0, toNode: true })
    );
  });

  it('draws a merge as two edges leaving the node', () => {
    //   m (merge of a and b)
    //   |\
    //   a b
    //    \|
    //     r
    const rows = buildGraphRows(
      chain(['m', ['a', 'b']], ['a', ['r']], ['b', ['r']], ['r', []])
    );

    const merge = rows[0];
    expect(merge.isMerge).toBe(true);
    const outgoing = merge.links.filter((l) => l.fromNode);
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((l) => l.toLane).sort()).toEqual([0, 1]);
    // Second parent opens a new lane, in a different color.
    expect(outgoing[0].color).not.toBe(outgoing[1].color);
    expect(rows[1].lane).toBe(0);
    expect(rows[2].lane).toBe(1);
  });

  it('passes unrelated branches straight through a row', () => {
    // `side` waits in lane 1 while `b` is drawn in lane 0.
    const rows = buildGraphRows(
      chain(['a', ['b']], ['side', ['b']], ['b', []])
    );

    // Row 1 (`side`) is in lane 1; lane 0 is still waiting for `b`.
    const passing = rows[1].links.filter((l) => !l.fromNode && !l.toNode);
    expect(passing).toContainEqual(expect.objectContaining({ fromLane: 0, toLane: 0 }));
  });

  it('reuses a freed lane instead of growing forever', () => {
    // `side` ends at its root, then a new tip appears — it should take lane 1 back.
    const rows = buildGraphRows(
      chain(['a', ['b']], ['side', []], ['newtip', ['b']], ['b', []])
    );

    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(1);
    expect(graphWidth(rows)).toBe(2);
  });

  it('does not lose a lane when the merged-in branch keeps flowing', () => {
    // Every link's lanes stay inside the row's declared width.
    const rows = buildGraphRows(
      chain(
        ['m', ['a', 'b']],
        ['a', ['c']],
        ['b', ['c']],
        ['c', ['d']],
        ['d', []]
      )
    );

    for (const row of rows) {
      for (const link of row.links) {
        expect(link.fromLane).toBeLessThan(row.width);
        expect(link.toLane).toBeLessThan(row.width);
      }
    }
  });

  it('handles a truncated page whose parents are missing', () => {
    const rows = buildGraphRows(chain(['a', ['missing']]));
    expect(rows).toHaveLength(1);
    expect(rows[0].links.filter((l) => l.fromNode)).toHaveLength(1);
  });

  it('handles an empty log', () => {
    expect(buildGraphRows([])).toEqual([]);
    expect(graphWidth([])).toBe(0);
  });
});

describe('graphColor', () => {
  it('wraps around the palette', () => {
    expect(graphColor(0)).toBe(GRAPH_COLORS[0]);
    expect(graphColor(GRAPH_COLORS.length)).toBe(GRAPH_COLORS[0]);
    expect(graphColor(-1)).toBe(GRAPH_COLORS[GRAPH_COLORS.length - 1]);
  });
});

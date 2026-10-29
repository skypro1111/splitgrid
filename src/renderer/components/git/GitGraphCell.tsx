import React from 'react';
import { graphColor, type GraphRow } from '../../../shared/git-graph';

/** Row height of the history list, in px. Shared with GitLogList. */
export const ROW_HEIGHT = 26;
/** Horizontal distance between two graph lanes, in px. */
export const LANE_WIDTH = 14;
const NODE_RADIUS = 3.5;

const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

interface Props {
  row: GraphRow;
  /** Lane count for the whole page, so every row's columns line up. */
  lanes: number;
}

/**
 * The graph column for one commit row.
 *
 * Each row is drawn independently — lines enter at y=0, leave at y=ROW_HEIGHT,
 * and the node sits at the middle — so a virtualized list can mount any window
 * of rows without the ones above it.
 */
export const GitGraphCell: React.FC<Props> = React.memo(({ row, lanes }) => {
  const width = Math.max(lanes, 1) * LANE_WIDTH;
  const h = ROW_HEIGHT;
  const mid = h / 2;

  return (
    <svg
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      style={{ flexShrink: 0, display: 'block', overflow: 'visible' }}
      aria-hidden
    >
      {row.links.map((link, i) => {
        const x1 = laneX(link.fromLane);
        const x2 = laneX(link.toLane);
        const color = graphColor(link.color);
        let d: string;

        if (link.toNode) {
          // A line arriving at this commit: straight down its own lane, or a
          // curve in from the lane of a branch being merged.
          d = x1 === x2 ? `M ${x1} 0 L ${x1} ${mid}` : `M ${x1} 0 C ${x1} ${mid * 0.7} ${x2} ${mid * 0.3} ${x2} ${mid}`;
        } else if (link.fromNode) {
          // A line leaving towards a parent.
          d = x1 === x2 ? `M ${x1} ${mid} L ${x1} ${h}` : `M ${x1} ${mid} C ${x1} ${mid * 1.3} ${x2} ${mid * 1.7} ${x2} ${h}`;
        } else {
          // An unrelated branch passing this row.
          d = `M ${x1} 0 L ${x2} ${h}`;
        }

        return <path key={i} d={d} stroke={color} strokeWidth={1.5} fill="none" strokeLinecap="round" />;
      })}

      <circle
        cx={laneX(row.lane)}
        cy={mid}
        r={NODE_RADIUS}
        fill={row.isMerge ? 'var(--bg-primary)' : graphColor(row.color)}
        stroke={graphColor(row.color)}
        strokeWidth={row.isMerge ? 2 : 1}
      />
    </svg>
  );
});
GitGraphCell.displayName = 'GitGraphCell';

/**
 * The graph column for the synthetic "uncommitted changes" row: a hollow node
 * with a dashed line running down into HEAD.
 */
export const GitGraphWorkingCell: React.FC<{ lane: number; lanes: number; color: number }> = ({
  lane,
  lanes,
  color,
}) => {
  const width = Math.max(lanes, 1) * LANE_WIDTH;
  const x = laneX(lane);
  const mid = ROW_HEIGHT / 2;
  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      style={{ flexShrink: 0, display: 'block', overflow: 'visible' }}
      aria-hidden
    >
      <path
        d={`M ${x} ${mid} L ${x} ${ROW_HEIGHT}`}
        stroke={graphColor(color)}
        strokeWidth={1.5}
        strokeDasharray="2 2"
        fill="none"
      />
      <circle cx={x} cy={mid} r={NODE_RADIUS} fill="var(--bg-primary)" stroke="var(--text-muted)" strokeWidth={1.5} />
    </svg>
  );
};

import React, { useMemo, useState } from 'react';

/** A single node in a Postgres `EXPLAIN (FORMAT JSON)` plan tree. */
interface PgPlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Alias'?: string;
  'Index Name'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Join Type'?: string;
  'Filter'?: string;
  'Index Cond'?: string;
  Plans?: PgPlanNode[];
  [key: string]: unknown;
}

interface ExplainViewProps {
  /** The raw single-cell JSON value returned by EXPLAIN (FORMAT JSON ...). */
  planJson: unknown;
  /** Whether ANALYZE was requested (controls which columns make sense). */
  analyze: boolean;
  /** Original statement that was explained (shown in header). */
  statementText?: string;
}

function coercePlan(planJson: unknown): PgPlanNode | null {
  let data: unknown = planJson;
  // pg returns the JSON in a single cell; it may already be parsed (array) or a string.
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (Array.isArray(data)) data = data[0];
  if (data && typeof data === 'object' && 'Plan' in (data as Record<string, unknown>)) {
    return (data as { Plan: PgPlanNode }).Plan;
  }
  if (data && typeof data === 'object' && 'Node Type' in (data as Record<string, unknown>)) {
    return data as PgPlanNode;
  }
  return null;
}

const fmtNum = (n: number | undefined) =>
  typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : '—';

const PlanNode: React.FC<{ node: PgPlanNode; depth: number; analyze: boolean }> = ({ node, depth, analyze }) => {
  const [open, setOpen] = useState(true);
  const children = node.Plans ?? [];
  const target = node['Relation Name'] || node['Index Name'] || node['Alias'];
  const cost = `cost=${fmtNum(node['Startup Cost'])}..${fmtNum(node['Total Cost'])}`;
  const rows = `rows=${fmtNum(node['Plan Rows'])}`;
  const actual = analyze
    ? ` (actual time=${fmtNum(node['Actual Startup Time'])}..${fmtNum(node['Actual Total Time'])} rows=${fmtNum(node['Actual Rows'])} loops=${fmtNum(node['Actual Loops'])})`
    : '';

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div className="sql-explain-node">
        <button
          className="sql-explain-toggle"
          onClick={() => setOpen((v) => !v)}
          style={{ visibility: children.length ? 'visible' : 'hidden' }}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="sql-explain-type">{node['Node Type'] ?? 'Node'}</span>
        {node['Join Type'] && <span className="sql-explain-meta">{node['Join Type']} Join</span>}
        {target && <span className="sql-explain-rel">on {target}</span>}
        <span className="sql-explain-cost">{cost} {rows}{actual}</span>
      </div>
      {(node.Filter || node['Index Cond']) && (
        <div className="sql-explain-cond" style={{ marginLeft: 14 }}>
          {node['Index Cond'] && <div>Index Cond: {node['Index Cond']}</div>}
          {node.Filter && <div>Filter: {node.Filter}</div>}
        </div>
      )}
      {open && children.map((child, idx) => (
        <PlanNode key={idx} node={child} depth={depth + 1} analyze={analyze} />
      ))}
    </div>
  );
};

/** Renders a Postgres EXPLAIN (FORMAT JSON) plan as a recursive node tree. */
export const ExplainView: React.FC<ExplainViewProps> = ({ planJson, analyze, statementText }) => {
  const root = useMemo(() => coercePlan(planJson), [planJson]);

  if (!root) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10, fontSize: 12, color: 'var(--text-muted)' }}>
        Could not parse the EXPLAIN plan.
      </div>
    );
  }

  return (
    <div className="sql-explain-view" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }}>
      {statementText && (
        <div className="sql-explain-stmt" title={statementText}>{statementText}</div>
      )}
      <PlanNode node={root} depth={0} analyze={analyze} />
    </div>
  );
};

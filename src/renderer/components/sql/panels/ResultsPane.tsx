import React, { useEffect, useState } from 'react';
import { DataGrid, type DataGridEditConfig } from './DataGrid';
import { ExplainView } from './ExplainView';
import type { SQLDialect, SQLQueryResult } from '../../../../shared/types';

/** Per-statement outcome for a multi-statement run (shown in Messages). */
export interface StatementOutcome {
  statementText: string;
  result: SQLQueryResult | null;
  error: string | null;
  durationMs: number;
}

/** A rendered EXPLAIN result attached to a run. */
export interface ExplainResult {
  /** Parsed JSON plan (postgres) or null when rendered as a plain grid. */
  planJson: unknown;
  analyze: boolean;
  statementText: string;
  /** Fallback grid result for non-postgres EXPLAIN. */
  gridResult?: SQLQueryResult | null;
}

interface ResultsPaneProps {
  result: SQLQueryResult | null;
  error: string;
  executing: boolean;
  /** Multi-statement outcomes; when length > 1 (or any error) show sub-tabs. */
  outcomes?: StatementOutcome[];
  /** EXPLAIN result to show as an extra sub-tab. */
  explain?: ExplainResult | null;
  /** Table-tab pagination/sort props (omitted for query tabs). */
  table?: {
    totalEstimate: number;
    page: number;
    pageSize: number;
    sortColumn: string | null;
    sortDirection: 'ASC' | 'DESC';
    onSort: (col: string, dir: 'ASC' | 'DESC') => void;
    onPageChange: (p: number) => void;
    onPageSizeChange: (s: number) => void;
    /** Per-column server-side row filters (column → contains-text). */
    filters: Record<string, string>;
    onFilterChange: (filters: Record<string, string>) => void;
    /** When present + PK known, the grid is editable (see DataGrid). */
    edit?: DataGridEditConfig;
  };
  /** Clipboard "Copy as INSERT" / SQL-export context (source table + dialect). */
  copyContext?: { schema: string | null; table: string; dialect: SQLDialect };
  /** Opens the Export dialog for the currently shown grid. */
  onExport?: () => void;
  /** Re-run the query/table query backing the currently shown grid. */
  onRefresh?: () => void;
  /** Container zoom factor (1 = base); scales the grid row height. */
  uiScale?: number;
}

function statusFor(r: SQLQueryResult): string {
  return `${r.command} | ${r.rowCount} rows | ${r.durationMs} ms${r.truncated ? ' | truncated' : ''}`;
}

const MessagesView: React.FC<{ outcomes: StatementOutcome[] }> = ({ outcomes }) => (
  <div className="sql-messages" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
    {outcomes.map((o, i) => (
      <div key={i} className={`sql-message-row${o.error ? ' error' : ''}`}>
        <span className="sql-message-idx">{i + 1}</span>
        <div className="sql-message-body">
          <div className="sql-message-sql">{o.statementText}</div>
          {o.error ? (
            <div className="sql-message-status error">{o.error}</div>
          ) : o.result ? (
            <div className="sql-message-status">{statusFor(o.result)}</div>
          ) : (
            <div className="sql-message-status">not executed</div>
          )}
        </div>
      </div>
    ))}
  </div>
);

/** Wraps DataGrid with the error banner + status, and (for multi-statement /
 * explain runs) a row of result sub-tabs. */
export const ResultsPane: React.FC<ResultsPaneProps> = ({
  result,
  error,
  executing,
  outcomes,
  explain,
  table,
  copyContext,
  onExport,
  onRefresh,
  uiScale = 1,
}) => {
  // ---- Table tab (editable when an edit config is supplied) ----
  if (table) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {error && <div className="sql-error-banner">{error}</div>}
        <DataGrid
          columns={result?.columns ?? []}
          rows={result?.rows ?? []}
          totalEstimate={table.totalEstimate}
          loading={executing}
          page={table.page}
          pageSize={table.pageSize}
          sortColumn={table.sortColumn}
          sortDirection={table.sortDirection}
          pageOffset={table.page * table.pageSize}
          showPagination
          onSort={table.onSort}
          onPageChange={table.onPageChange}
          onPageSizeChange={table.onPageSizeChange}
          filterable
          filters={table.filters}
          onFilterChange={table.onFilterChange}
          edit={table.edit}
          copyContext={copyContext}
          onExport={onExport}
          onRefresh={onRefresh}
          uiScale={uiScale}
        />
      </div>
    );
  }

  // ---- Determine whether we need the sub-tab chrome ----
  const resultOutcomes = (outcomes ?? []).filter((o) => o.result && (o.result.columns.length > 0 || o.result.rows.length > 0));
  const multi = (outcomes && outcomes.length > 1) || !!explain || resultOutcomes.length > 1;

  if (!multi) {
    // Single-statement (read-only) view.
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {error && <div className="sql-error-banner">{error}</div>}
        {result && (
          <DataGrid
            columns={result.columns}
            rows={result.rows}
            loading={executing}
            statusText={statusFor(result)}
            copyContext={copyContext}
            onExport={onExport}
            onRefresh={onRefresh}
            uiScale={uiScale}
          />
        )}
      </div>
    );
  }

  return <MultiResultsView outcomes={outcomes ?? []} explain={explain ?? null} executing={executing} copyContext={copyContext} onExport={onExport} onRefresh={onRefresh} uiScale={uiScale} />;
};

const MultiResultsView: React.FC<{
  outcomes: StatementOutcome[];
  explain: ExplainResult | null;
  executing: boolean;
  copyContext?: { schema: string | null; table: string; dialect: SQLDialect };
  onExport?: () => void;
  onRefresh?: () => void;
  uiScale?: number;
}> = ({ outcomes, explain, executing, copyContext, onExport, onRefresh, uiScale = 1 }) => {
  const resultOutcomes = outcomes.filter((o) => o.result);
  type SubTab =
    | { kind: 'result'; label: string; result: SQLQueryResult }
    | { kind: 'explain'; label: string }
    | { kind: 'messages'; label: string };

  const subTabs: SubTab[] = [];
  resultOutcomes.forEach((o, i) => {
    if (o.result) subTabs.push({ kind: 'result', label: `Result ${i + 1}`, result: o.result });
  });
  if (explain) subTabs.push({ kind: 'explain', label: 'Explain' });
  subTabs.push({ kind: 'messages', label: 'Messages' });

  const defaultIdx = explain
    ? subTabs.findIndex((t) => t.kind === 'explain')
    : subTabs.findIndex((t) => t.kind === 'result');
  const [active, setActive] = useState(defaultIdx >= 0 ? defaultIdx : subTabs.length - 1);

  useEffect(() => {
    const idx = explain
      ? subTabs.findIndex((t) => t.kind === 'explain')
      : subTabs.findIndex((t) => t.kind === 'result');
    setActive(idx >= 0 ? idx : subTabs.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultOutcomes.length, !!explain]);

  const safeActive = Math.min(active, subTabs.length - 1);
  const current = subTabs[safeActive];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="sql-subtab-bar">
        {subTabs.map((t, i) => (
          <button
            key={`${t.kind}-${i}`}
            className={`sql-subtab${i === safeActive ? ' active' : ''}${t.kind === 'messages' && outcomes.some((o) => o.error) ? ' error' : ''}`}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {current?.kind === 'result' && (
          <DataGrid
            columns={current.result.columns}
            rows={current.result.rows}
            loading={executing}
            statusText={statusFor(current.result)}
            copyContext={copyContext}
            onExport={onExport}
            onRefresh={onRefresh}
            uiScale={uiScale}
          />
        )}
        {current?.kind === 'explain' && explain && (
          explain.planJson != null ? (
            <ExplainView planJson={explain.planJson} analyze={explain.analyze} statementText={explain.statementText} />
          ) : explain.gridResult ? (
            <DataGrid
              columns={explain.gridResult.columns}
              rows={explain.gridResult.rows}
              loading={executing}
              statusText={`EXPLAIN | ${explain.gridResult.rowCount} rows | ${explain.gridResult.durationMs} ms`}
              uiScale={uiScale}
            />
          ) : (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--text-muted)' }}>No plan returned.</div>
          )
        )}
        {current?.kind === 'messages' && <MessagesView outcomes={outcomes} />}
      </div>
    </div>
  );
};

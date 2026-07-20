import React from 'react';

interface EditorPaneProps {
  /** Host div for the Monaco editor instance (owned by the workbench). */
  editorHostRef: React.RefObject<HTMLDivElement | null>;
  executing: boolean;
  canRun: boolean;
  /** Run the statement at the cursor (Cmd/Ctrl+Enter). */
  onRunStatement: () => void;
  /** Run every statement sequentially (Run all / Run script). */
  onRunAll: () => void;
  /** Pretty-print the editor content (or selection) via sql-formatter. */
  onFormat: () => void;
  /** Run EXPLAIN on the statement at the cursor. */
  onExplain: () => void;
  /** Run EXPLAIN ANALYZE on the statement at the cursor (postgres only). */
  onExplainAnalyze?: () => void;
  /** Whether the active dialect supports EXPLAIN ANALYZE. */
  supportsExplainAnalyze: boolean;
  /** Toggle the history/favorites panel. */
  onToggleHistory: () => void;
  historyOpen: boolean;
  /** Optional element rendered at the start of the toolbar (before Run) —
   * used for the query-context (database / schema) picker. */
  leading?: React.ReactNode;
}

/** Monaco editor host + run/format/explain toolbar. The Monaco instance itself
 * is created and managed by the workbench (which owns the models/refs); this
 * pane provides the mount point and the toolbar overlay. */
export const EditorPane: React.FC<EditorPaneProps> = ({
  editorHostRef,
  executing,
  canRun,
  onRunStatement,
  onRunAll,
  onFormat,
  onExplain,
  onExplainAnalyze,
  supportsExplainAnalyze,
  onToggleHistory,
  historyOpen,
  leading,
}) => {
  const disabled = executing || !canRun;
  return (
    <div className="sql-editor-pane">
      <div className="sql-editor-toolbar">
        {leading}
        {leading && <span className="sql-tb-sep" />}
        <button
          onClick={onRunStatement}
          disabled={disabled}
          className="sql-tb-btn sql-tb-run"
          title="Run statement at cursor (⌘/Ctrl+Enter)"
        >
          <span className="sql-tb-gly">▶</span>{executing ? 'Running…' : 'Run'}
        </button>
        <button
          onClick={onRunAll}
          disabled={disabled}
          className="sql-tb-btn"
          title="Run all statements (script)"
        >
          <span className="sql-tb-gly">▶▶</span>Run all
        </button>
        <span className="sql-tb-sep" />
        <button onClick={onExplain} disabled={disabled} className="sql-tb-btn" title="EXPLAIN statement at cursor">
          Explain
        </button>
        {supportsExplainAnalyze && onExplainAnalyze && (
          <button onClick={onExplainAnalyze} disabled={disabled} className="sql-tb-btn" title="EXPLAIN ANALYZE statement at cursor">
            Analyze
          </button>
        )}
        <span className="sql-tb-sep" />
        <button onClick={onFormat} disabled={!canRun} className="sql-tb-btn" title="Format SQL (⇧⌥F)">
          Format
        </button>
        <span className="sql-tb-spacer" />
        <button
          onClick={onToggleHistory}
          className={`sql-tb-btn${historyOpen ? ' active' : ''}`}
          title="History & favorites"
        >
          History
        </button>
      </div>
      <div ref={editorHostRef} className="sql-editor-host" />
    </div>
  );
};

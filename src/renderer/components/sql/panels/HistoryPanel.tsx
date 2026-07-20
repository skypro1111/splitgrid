import React, { useState } from 'react';
import type { SQLHistoryEntry, SQLFavoriteQuery } from '../../../../shared/types';

interface HistoryPanelProps {
  history: SQLHistoryEntry[];
  favorites: SQLFavoriteQuery[];
  onClose: () => void;
  /** Load a query into the active editor (single click). */
  onLoad: (query: string) => void;
  /** Load + immediately run (double click). */
  onRun: (query: string) => void;
  /** Star a history entry → save as favorite. */
  onSaveFavorite: (query: string) => void;
  onDeleteFavorite: (id: string) => void;
  onClearHistory: () => void;
  /** Save the current editor query as a favorite. */
  onSaveCurrent: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  history,
  favorites,
  onClose,
  onLoad,
  onRun,
  onSaveFavorite,
  onDeleteFavorite,
  onClearHistory,
  onSaveCurrent,
}) => {
  const [tab, setTab] = useState<'history' | 'favorites'>('history');

  return (
    <div className="sql-history-panel">
      <div className="sql-history-head">
        <div className="sql-history-tabs">
          <button className={`sql-subtab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
            History
          </button>
          <button className={`sql-subtab${tab === 'favorites' ? ' active' : ''}`} onClick={() => setTab('favorites')}>
            Favorites
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tab === 'history' && history.length > 0 && (
            <button className="sql-btn icon" title="Clear history" onClick={onClearHistory}>🗑</button>
          )}
          {tab === 'favorites' && (
            <button className="sql-btn icon" title="Save current query" onClick={onSaveCurrent}>＋</button>
          )}
          <button className="sql-btn icon" title="Close" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="sql-history-list">
        {tab === 'history' && (
          history.length === 0 ? (
            <div className="sql-history-empty">No history yet</div>
          ) : history.map((h) => (
            <div
              key={h.id}
              className={`sql-history-row${h.ok ? '' : ' error'}`}
              onClick={() => onLoad(h.query)}
              onDoubleClick={() => onRun(h.query)}
              title={h.query}
            >
              <span className={`sql-history-dot${h.ok ? ' ok' : ' err'}`} />
              <span className="sql-history-sql">{oneLine(h.query)}</span>
              <span className="sql-history-meta">
                {fmtTime(h.executedAt)}
                {h.ok && typeof h.rowCount === 'number' ? ` · ${h.rowCount}r` : ''}
                {h.ok && typeof h.durationMs === 'number' ? ` · ${h.durationMs}ms` : ''}
              </span>
              <button
                className="sql-history-star"
                title="Save to favorites"
                onClick={(e) => { e.stopPropagation(); onSaveFavorite(h.query); }}
              >☆</button>
            </div>
          ))
        )}

        {tab === 'favorites' && (
          favorites.length === 0 ? (
            <div className="sql-history-empty">No saved queries</div>
          ) : favorites.map((f) => (
            <div
              key={f.id}
              className="sql-history-row"
              onClick={() => onLoad(f.query)}
              onDoubleClick={() => onRun(f.query)}
              title={f.query}
            >
              <span className="sql-history-dot ok" />
              <span className="sql-history-sql">{f.name}</span>
              <span className="sql-history-meta">{fmtTime(f.createdAt)}</span>
              <button
                className="sql-history-star"
                title="Remove favorite"
                onClick={(e) => { e.stopPropagation(); onDeleteFavorite(f.id); }}
              >🗑</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

import React, { useRef, useState } from 'react';
import { SqlTableIcon, SqlFunctionIcon } from './Icons';
import type { SQLTab } from '../../shared/types';

interface SqlTabBarProps {
  tabs: SQLTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
}

const SqlEditorIcon: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="#DCDCAA" strokeWidth="0.9" fill="#DCDCAA" fillOpacity={0.08} />
    <path d="M4 6l2.5 2L4 10" stroke="#DCDCAA" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="8" y1="10" x2="12" y2="10" stroke="#DCDCAA" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

function tabIcon(tab: SQLTab) {
  if (tab.type === 'table') return <SqlTableIcon size={13} />;
  if (tab.type === 'structure') return <SqlFunctionIcon size={13} />;
  return <SqlEditorIcon size={13} />;
}

export const SqlTabBar: React.FC<SqlTabBarProps> = ({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewQuery,
  onCloseOthers,
  onCloseAll,
}) => {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div className="sql-tab-bar">
        <div className="tab-strip" ref={stripRef}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab${activeTabId === tab.id ? ' active' : ''}`}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
            >
              {tabIcon(tab)}
              <span className="tab-label">{tab.title}</span>
              <span
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button className="tab-new" onClick={onNewQuery} title="New Query">+</button>
      </div>

      {ctxMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 2500 }}
          onClick={() => setCtxMenu(null)}
        >
          <div
            style={{
              position: 'absolute',
              left: ctxMenu.x,
              top: ctxMenu.y,
              minWidth: 150,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { onClose(ctxMenu.tabId); setCtxMenu(null); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 11, color: 'var(--text-primary)' }}
            >
              Close
            </button>
            <button
              onClick={() => { onCloseOthers(ctxMenu.tabId); setCtxMenu(null); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 11, color: 'var(--text-primary)' }}
            >
              Close Others
            </button>
            <button
              onClick={() => { onCloseAll(); setCtxMenu(null); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 11, color: 'var(--text-primary)' }}
            >
              Close All
            </button>
          </div>
        </div>
      )}
    </>
  );
};

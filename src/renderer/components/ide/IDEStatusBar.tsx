import React, { useEffect, useState, useRef } from 'react';
import '../../monacoEnvironment';
import * as monaco from 'monaco-editor';
import { detectLanguage } from './utils';

interface Props {
  filePath: string | null;
}

export const IDEStatusBar: React.FC<Props> = ({ filePath }) => {
  const [line, setLine] = useState(1);
  const [col, setCol] = useState(1);
  const [selection, setSelection] = useState('');
  const [encoding] = useState('UTF-8');
  const [eol, setEol] = useState('LF');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Poll for active editor cursor position
    // (Monaco doesn't expose a global event, so we poll the focused editor)
    const update = () => {
      const editors = monaco.editor.getEditors();
      const active = editors.find(e => e.hasTextFocus()) || editors[0];
      if (active) {
        const pos = active.getPosition();
        if (pos) {
          setLine(pos.lineNumber);
          setCol(pos.column);
        }
        const sel = active.getSelection();
        if (sel && !sel.isEmpty()) {
          const model = active.getModel();
          if (model) {
            const text = model.getValueInRange(sel);
            const lines = text.split('\n').length;
            const chars = text.length;
            setSelection(`(${lines} lines, ${chars} chars selected)`);
          }
        } else {
          setSelection('');
        }
        const model = active.getModel();
        if (model) {
          setEol(model.getEOL() === '\r\n' ? 'CRLF' : 'LF');
        }
      }
    };

    intervalRef.current = setInterval(update, 200);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const lang = filePath ? detectLanguage(filePath) : '';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 24,
        minHeight: 24,
        padding: '0 12px',
        fontSize: 11,
        color: 'var(--text-muted)',
        background: 'var(--bg-statusbar, #141414)',
        userSelect: 'none',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        {filePath && (
          <span style={{ opacity: 0.8 }}>
            {filePath.split('/').pop()}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        {filePath && (
          <>
            <span>
              Ln {line}, Col {col} {selection}
            </span>
            <span>{encoding}</span>
            <span>{eol}</span>
            <span style={{ textTransform: 'capitalize' }}>{lang}</span>
          </>
        )}
      </div>
    </div>
  );
};

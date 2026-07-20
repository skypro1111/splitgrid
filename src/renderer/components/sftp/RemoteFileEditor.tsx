import React, { useEffect, useRef, useState } from 'react';
import '../../monacoEnvironment';
import * as monaco from 'monaco-editor';
import { detectLanguage } from '../ide/utils';
import type { SftpTarget } from '../../../shared/types';

interface Props {
  target: SftpTarget;
  path: string; // absolute remote path of the file being edited
  onClose: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'too-large' }
  | { kind: 'binary' }
  | { kind: 'ready' };

function remoteBasename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// Full-pane overlay that edits a single remote file in Monaco and saves it back
// over SFTP. Reuses the IDE editor's visual setup (theme 'splitgrid-dark', font,
// minimap, …) and its detectLanguage() helper for parity.
export const RemoteFileEditor: React.FC<Props> = ({ target, path, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const baselineRef = useRef<number>(0); // alternative version id of the saved state
  // Latest save handler, so the Monaco command (bound once) always calls current.
  const saveRef = useRef<() => void>(() => {});
  // Holds the loaded content between the read and the editor mount.
  const pendingContentRef = useRef<string>('');

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const fileName = remoteBasename(path);

  // ---- Load file content, then mount Monaco (when editable) --------------
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    (async () => {
      try {
        const r = await window.electronAPI.sftpReadFile(target, path);
        if (cancelled) return;
        if (r.truncated) {
          setLoad({ kind: 'too-large' });
          return;
        }
        if (r.isBinary) {
          setLoad({ kind: 'binary' });
          return;
        }
        // Defer the editor mount to the next render so containerRef is attached.
        setLoad({ kind: 'ready' });
        // Stash the content for the mount effect via a ref-like closure.
        pendingContentRef.current = r.content;
      } catch (err) {
        if (!cancelled) {
          setLoad({ kind: 'error', message: (err as Error).message || 'Failed to read file' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, path]);

  // ---- Mount the editor once the container exists and content is ready ---
  useEffect(() => {
    if (load.kind !== 'ready' || !containerRef.current || editorRef.current) return;

    const model = monaco.editor.createModel(
      pendingContentRef.current,
      detectLanguage(path),
      // Unique in-memory uri per remote path avoids collisions with other models.
      monaco.Uri.parse(`inmemory://sftp/${encodeURIComponent(path)}`),
    );
    modelRef.current = model;
    baselineRef.current = model.getAlternativeVersionId();

    const editor = monaco.editor.create(containerRef.current, {
      theme: 'splitgrid-dark',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
      fontLigatures: true,
      minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      cursorBlinking: 'smooth',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      automaticLayout: true,
      tabSize: 2,
      wordWrap: 'off',
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      glyphMargin: false,
      folding: true,
      links: true,
      padding: { top: 8 },
    });
    editor.setModel(model);
    editorRef.current = editor;
    editor.focus();

    const changeDisposable = model.onDidChangeContent(() => {
      setDirty(model.getAlternativeVersionId() !== baselineRef.current);
    });

    // Cmd/Ctrl+S — save (delegates to the latest save handler via ref).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current();
    });

    return () => {
      changeDisposable.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [load.kind, path]);

  // ---- Save --------------------------------------------------------------
  const save = React.useCallback(async () => {
    const model = modelRef.current;
    if (!model || saving) return;
    // Nothing to write if not dirty.
    if (model.getAlternativeVersionId() === baselineRef.current) return;
    setSaving(true);
    setSaveError('');
    try {
      await window.electronAPI.sftpWriteFile(target, path, model.getValue());
      if (modelRef.current) {
        baselineRef.current = modelRef.current.getAlternativeVersionId();
        setDirty(false);
      }
      setSavedFlash(true);
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [target, path, saving]);

  saveRef.current = () => void save();

  // Auto-clear the transient "Saved" flash.
  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => setSavedFlash(false), 1600);
    return () => clearTimeout(t);
  }, [savedFlash]);

  const handleClose = React.useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  // ---- Styles ------------------------------------------------------------
  const headerBtn: React.CSSProperties = {
    fontSize: 11, padding: '4px 12px', borderRadius: 5, border: '1px solid var(--border)',
    background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer',
  };

  const centered = (children: React.ReactNode) => (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, color: 'var(--text-muted)' }}>
      {children}
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column',
        background: 'var(--bg-primary)',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 36, minHeight: 36, padding: '0 10px',
          background: 'var(--bg-titlebar)', borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
          {dirty && <span title="Unsaved changes" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />}
          {savedFlash && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent-green, #3fb950)', flexShrink: 0 }}>Saved</span>}
        </span>
        {load.kind === 'ready' && (
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            title="Save (⌘/Ctrl+S)"
            style={{
              ...headerBtn,
              color: dirty && !saving ? 'var(--accent)' : 'var(--text-muted)',
              cursor: dirty && !saving ? 'pointer' : 'default',
              opacity: dirty && !saving ? 1 : 0.6,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        <button onClick={handleClose} title="Close" style={headerBtn}>
          Close
        </button>
      </div>

      {/* Save error banner */}
      {saveError && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11, flexShrink: 0,
            background: 'rgba(241,76,76,0.12)', color: 'var(--accent-red)', borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{saveError}</span>
          <button
            onClick={() => setSaveError('')}
            title="Dismiss"
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Discard-changes inline confirm */}
      {confirmClose && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 11, flexShrink: 0,
            background: 'rgba(241,76,76,0.12)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1 }}>Discard unsaved changes?</span>
          <button
            onClick={onClose}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', background: 'var(--accent-red)', color: '#fff', cursor: 'pointer' }}
          >
            Discard
          </button>
          <button
            onClick={() => setConfirmClose(false)}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Body */}
      {load.kind === 'loading' && centered(<span style={{ fontSize: 13 }}>Loading…</span>)}

      {load.kind === 'error' && centered(
        <>
          <span style={{ fontSize: 13, color: 'var(--accent-red)', textAlign: 'center', maxWidth: 360, lineHeight: 1.5 }}>{load.message}</span>
          <button onClick={onClose} style={{ ...headerBtn, color: 'var(--accent)' }}>Close</button>
        </>,
      )}

      {load.kind === 'too-large' && centered(
        <>
          <span style={{ fontSize: 13, textAlign: 'center' }}>File is larger than 5 MB — download it to edit.</span>
          <button onClick={onClose} style={{ ...headerBtn, color: 'var(--accent)' }}>Close</button>
        </>,
      )}

      {load.kind === 'binary' && centered(
        <>
          <span style={{ fontSize: 13, textAlign: 'center' }}>Binary file — download it to view.</span>
          <button onClick={onClose} style={{ ...headerBtn, color: 'var(--accent)' }}>Close</button>
        </>,
      )}

      {/* Monaco container — only mounted when editable */}
      <div
        ref={containerRef}
        style={{
          flex: 1, minHeight: 0,
          display: load.kind === 'ready' ? 'block' : 'none',
        }}
      />
    </div>
  );
};

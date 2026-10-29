import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { EDITOR_THEME } from '../../monacoTheme';
import { detectLanguage } from '../ide/utils';
import type { GitDiffSides } from '../../../shared/git-types';

interface Props {
  diff: GitDiffSides | null;
  loading: boolean;
  /** Side-by-side, or inline like `git diff`. */
  inline: boolean;
  fontSize?: number;
}

/**
 * Monaco's diff editor over the two blob sides the main process handed us.
 *
 * Models are created and disposed per diff under a `git-diff:` scheme so they
 * can never collide with the IDE pane's `file:` models for the same path — two
 * models on one URI is a hard error in Monaco.
 */
export const GitDiffEditor: React.FC<Props> = ({ diff, loading, inline, fontSize = 12 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    editorRef.current = monaco.editor.createDiffEditor(containerRef.current, {
      theme: EDITOR_THEME,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: !inline,
      fontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
      diffAlgorithm: 'advanced',
      lineNumbersMinChars: 3,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });

    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
    };
    // Layout options are updated below; the editor itself is created once.
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: !inline });
  }, [inline]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const previous = modelsRef.current;
    if (!diff || diff.binary || diff.tooLarge) {
      editor.setModel(null);
      previous?.original.dispose();
      previous?.modified.dispose();
      modelsRef.current = null;
      return;
    }

    // A unique suffix keeps every model URI distinct, so switching quickly
    // between files never races a not-yet-disposed model of the same path.
    const seq = ++seqRef.current;
    const language = detectLanguage(diff.modifiedPath ?? diff.originalPath ?? '');
    const original = monaco.editor.createModel(
      diff.original,
      language,
      monaco.Uri.parse(`git-diff:/original/${seq}/${encodeURI(diff.originalPath ?? 'file')}`)
    );
    const modified = monaco.editor.createModel(
      diff.modified,
      language,
      monaco.Uri.parse(`git-diff:/modified/${seq}/${encodeURI(diff.modifiedPath ?? 'file')}`)
    );

    editor.setModel({ original, modified });
    modelsRef.current = { original, modified };
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [diff]);

  const overlay = loading
    ? 'Loading diff…'
    : !diff
      ? 'Select a file to see its diff'
      : diff.binary
        ? 'Binary file — no text diff'
        : diff.tooLarge
          ? 'File too large to diff'
          : null;

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, background: 'var(--bg-editor)' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0, visibility: overlay ? 'hidden' : 'visible' }} />
      {overlay && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}
        >
          {overlay}
        </div>
      )}
    </div>
  );
};

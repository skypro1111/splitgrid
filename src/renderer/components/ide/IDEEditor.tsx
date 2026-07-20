import React, { useEffect, useRef } from 'react';
import '../../monacoEnvironment';
import * as monaco from 'monaco-editor';
import { detectLanguage } from './utils';

interface Props {
  filePath: string | null;
  onDirtyChange: (filePath: string, dirty: boolean) => void;
  onSave: (filePath: string, content: string) => void;
  fontSize?: number;
}

// Shared model cache — one model per file path, survives re-renders
const modelCache = new Map<string, monaco.editor.ITextModel>();
const savedVersions = new Map<string, number>();
// Per-file scroll + cursor, captured manually. We intentionally do NOT use
// editor.saveViewState/restoreViewState: restoreViewState also restores every
// contribution, and the WordHighlighter contribution cancels an internal
// delayer whose promise rejects unhandled ("Canceled"), crashing the renderer.
// Restoring scroll/selection by hand sidesteps that entirely.
// Module-level so it survives the editor being disposed — e.g. switching
// workspaces unmounts the IDE — and is restored when the file is reopened.
interface EditorViewSnapshot {
  scrollTop: number;
  scrollLeft: number;
  selections: monaco.Selection[] | null;
}
const viewStateCache = new Map<string, EditorViewSnapshot>();

function captureViewSnapshot(editor: monaco.editor.IStandaloneCodeEditor): EditorViewSnapshot {
  return {
    scrollTop: editor.getScrollTop(),
    scrollLeft: editor.getScrollLeft(),
    selections: editor.getSelections(),
  };
}

function applyViewSnapshot(editor: monaco.editor.IStandaloneCodeEditor, snap: EditorViewSnapshot) {
  if (snap.selections && snap.selections.length) editor.setSelections(snap.selections);
  // Scroll last so a cursor reveal from setSelections doesn't override it.
  editor.setScrollTop(snap.scrollTop);
  editor.setScrollLeft(snap.scrollLeft);
}

function getOrCreateModel(filePath: string, content: string): monaco.editor.ITextModel {
  const existing = modelCache.get(filePath);
  if (existing && !existing.isDisposed()) return existing;

  const lang = detectLanguage(filePath);
  const uri = monaco.Uri.file(filePath);
  const existingMonaco = monaco.editor.getModel(uri);
  if (existingMonaco) {
    modelCache.set(filePath, existingMonaco);
    return existingMonaco;
  }

  const model = monaco.editor.createModel(content, lang, uri);
  modelCache.set(filePath, model);
  savedVersions.set(filePath, model.getAlternativeVersionId());
  return model;
}

export function disposeModel(filePath: string) {
  const model = modelCache.get(filePath);
  if (model && !model.isDisposed()) model.dispose();
  modelCache.delete(filePath);
  savedVersions.delete(filePath);
  viewStateCache.delete(filePath);
}

export function getModelContent(filePath: string): string | null {
  const model = modelCache.get(filePath);
  if (model && !model.isDisposed()) return model.getValue();
  return null;
}

export function markModelSaved(filePath: string) {
  const model = modelCache.get(filePath);
  if (model && !model.isDisposed()) {
    savedVersions.set(filePath, model.getAlternativeVersionId());
  }
}

/**
 * Reload a model's content from disk if it has no unsaved edits.
 * Called by IDE-level file watcher for ALL open tabs (not just the active one).
 * Returns true if content was updated.
 */
export async function reloadModelFromDisk(filePath: string): Promise<boolean> {
  const model = modelCache.get(filePath);
  if (!model || model.isDisposed()) return false;

  // Don't reload if user has unsaved edits
  const currentVer = model.getAlternativeVersionId();
  const savedVer = savedVersions.get(filePath) ?? 0;
  if (currentVer !== savedVer) return false;

  try {
    const content = await window.electronAPI.readFile(filePath);
    if (model.isDisposed()) return false;
    if (model.getValue() === content) return false; // no actual change
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: content }],
      () => null,
    );
    savedVersions.set(filePath, model.getAlternativeVersionId());
    return true;
  } catch {
    return false;
  }
}

monaco.editor.defineTheme('splitgrid-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#181818',
    'editor.lineHighlightBackground': '#262626',
    'editor.selectionBackground': '#264f78',
    'editorLineNumber.foreground': '#505050',
    'editorLineNumber.activeForeground': '#D4D4D4',
    'editorGutter.background': '#181818',
    'editorWidget.background': '#1a1a1a',
    'editorWidget.border': '#383838',
    'editorSuggestWidget.background': '#1a1a1a',
    'editorSuggestWidget.border': '#383838',
    'editorHoverWidget.background': '#1a1a1a',
    'editorHoverWidget.border': '#383838',
    'editorCursor.foreground': '#D4D4D4',
    'editor.findMatchBackground': '#515c6a',
    'editor.findMatchHighlightBackground': '#ea5c0055',
    'minimap.background': '#181818',
    'scrollbarSlider.background': '#67676750',
    'scrollbarSlider.hoverBackground': '#676767',
    'scrollbarSlider.activeBackground': '#676767',
  },
});

export const IDEEditor: React.FC<Props> = ({ filePath, onDirtyChange, onSave, fontSize = 13 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const currentFileRef = useRef<string | null>(null);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const onSaveRef = useRef(onSave);
  const onDirtyRef = useRef(onDirtyChange);
  onSaveRef.current = onSave;
  onDirtyRef.current = onDirtyChange;

  // Focus-mode (and other callers) ask this container to take focus; a raw DOM
  // .focus() doesn't engage Monaco, so call the editor's own focus() when the
  // request targets the container this editor lives in.
  useEffect(() => {
    const onFocusRequest = (e: Event) => {
      const id = (e as CustomEvent<{ containerId?: string }>).detail?.containerId;
      if (!id || !containerRef.current) return;
      if (containerRef.current.closest(`[data-container-id="${id}"]`)) {
        editorRef.current?.focus();
      }
    };
    window.addEventListener('splitgrid:focus-container', onFocusRequest);
    return () => window.removeEventListener('splitgrid:focus-container', onFocusRequest);
  }, []);

  // Create editor once on mount — div is always rendered
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;

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

    editorRef.current = editor;

    // Cmd/Ctrl+S — save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const model = editor.getModel();
      if (model && currentFileRef.current) {
        onSaveRef.current(currentFileRef.current, model.getValue());
      }
    });

    // Cmd/Ctrl+Shift+D — duplicate line/selection
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () => {
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (!sel || !model) return;

      if (sel.isEmpty()) {
        // No selection: duplicate current line below
        editor.getAction('editor.action.copyLinesDownAction')?.run();
      } else if (sel.startLineNumber === sel.endLineNumber && sel.startColumn !== sel.endColumn) {
        // Inline selection on single line: duplicate text to the right
        const text = model.getValueInRange(sel);
        editor.executeEdits('duplicate', [{
          range: new monaco.Range(sel.endLineNumber, sel.endColumn, sel.endLineNumber, sel.endColumn),
          text,
        }]);
        // Move selection to the duplicated text
        editor.setSelection(new monaco.Selection(
          sel.endLineNumber, sel.endColumn,
          sel.endLineNumber, sel.endColumn + text.length,
        ));
      } else {
        // Multi-line selection: duplicate entire selected lines below
        const startLine = sel.startLineNumber;
        const endLine = sel.endColumn === 1 ? sel.endLineNumber - 1 : sel.endLineNumber;
        const fullRange = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
        const text = model.getValueInRange(fullRange);
        const insertPos = endLine + 1;
        const insertCol = 1;
        editor.executeEdits('duplicate', [{
          range: new monaco.Range(insertPos, insertCol, insertPos, insertCol),
          text: '\n' + text,
        }]);
        // Select the duplicated block
        const newStartLine = insertPos;
        const lineCount = endLine - startLine + 1;
        editor.setSelection(new monaco.Selection(
          newStartLine, 1,
          newStartLine + lineCount - 1, model.getLineMaxColumn(newStartLine + lineCount - 1),
        ));
      }
    });

    // Cmd/Ctrl+/ — toggle line comment
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => {
      editor.getAction('editor.action.commentLine')?.run();
    });

    // Broadcast cursor position for the app status bar (Ln/Col of focused file).
    const broadcastCursor = (line: number, column: number) => {
      if (!currentFileRef.current) return;
      window.dispatchEvent(new CustomEvent('splitgrid:ide-cursor', {
        detail: { filePath: currentFileRef.current, line, column },
      }));
    };
    const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
      broadcastCursor(e.position.lineNumber, e.position.column);
    });
    const focusDisposable = editor.onDidFocusEditorText(() => {
      const pos = editor.getPosition();
      if (pos) broadcastCursor(pos.lineNumber, pos.column);
    });

    return () => {
      // Persist view state before the editor is torn down (e.g. workspace
      // switch unmounts the IDE) so scroll/cursor restore on remount.
      if (currentFileRef.current) {
        viewStateCache.set(currentFileRef.current, captureViewSnapshot(editor));
      }
      cursorDisposable.dispose();
      focusDisposable.dispose();
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Sync font size with prop
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Switch model when filePath changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Clean up previous model listeners
    disposablesRef.current.forEach((d) => d.dispose());
    disposablesRef.current = [];

    // Save the outgoing file's view state before switching models away from it.
    const prevFile = currentFileRef.current;
    if (prevFile && prevFile !== filePath) {
      viewStateCache.set(prevFile, captureViewSnapshot(editor));
    }

    if (!filePath) {
      editor.setModel(null);
      currentFileRef.current = null;
      return;
    }

    currentFileRef.current = filePath;

    // Load & set model
    (async () => {
      let model = modelCache.get(filePath);
      if (!model || model.isDisposed()) {
        try {
          const content = await window.electronAPI.readFile(filePath);
          model = getOrCreateModel(filePath, content);
        } catch (err) {
          console.error('Failed to read file:', filePath, err);
          return;
        }
      }

      // Guard: editor may have been disposed during async gap
      if (!editorRef.current || currentFileRef.current !== filePath) return;

      editor.setModel(model);

      // Restore previously-saved scroll/cursor for this file, if any.
      const snap = viewStateCache.get(filePath);
      if (snap) applyViewSnapshot(editor, snap);

      // Dirty tracking
      const disposable = model.onDidChangeContent(() => {
        const ver = model!.getAlternativeVersionId();
        const saved = savedVersions.get(filePath) ?? 0;
        onDirtyRef.current(filePath, ver !== saved);
      });
      disposablesRef.current.push(disposable);
    })();
  }, [filePath]);

  // External file change handling is done at the IDE level (watches all open tabs).
  // See IDE.tsx onFilesChanged listener.

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {/* Editor container — always rendered so monaco can attach */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          visibility: filePath ? 'visible' : 'hidden',
        }}
      />

      {/* Welcome overlay — shown when no file is open */}
      {!filePath && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-editor)',
            color: 'var(--text-muted)',
            gap: 16,
            userSelect: 'none',
          }}
        >
          <div style={{ fontSize: 48, opacity: 0.15 }}>&lt;/&gt;</div>
          <div style={{ fontSize: 14, opacity: 0.4 }}>Open a file to start editing</div>
          <div style={{ fontSize: 12, opacity: 0.3 }}>
            Use the file explorer on the left
          </div>
        </div>
      )}
    </div>
  );
};

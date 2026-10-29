// The app's Monaco theme, registered on import.
//
// Monaco keeps its palette in a registered theme rather than reading CSS vars,
// so the editor surfaces are (re)defined from the app background whenever the
// user changes it — see shared/background-theme. Lives on its own so every
// Monaco surface (the IDE editor, the Git pane's diff) paints the same without
// one having to import the other.

import './monacoEnvironment';
import * as monaco from 'monaco-editor';
import { getBackgroundTheme, onBackgroundThemeChange } from './theme';
import type { DerivedBackgroundTheme } from '../shared/background-theme';

export const EDITOR_THEME = 'splitgrid-dark';

function defineEditorTheme(theme: DerivedBackgroundTheme): void {
  monaco.editor.defineTheme(EDITOR_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': theme.surfaces.editor,
      'editor.lineHighlightBackground': theme.surfaces.hover,
      'editor.selectionBackground': '#264f78',
      'editorLineNumber.foreground': '#505050',
      'editorLineNumber.activeForeground': '#D4D4D4',
      'editorGutter.background': theme.surfaces.editor,
      'editorWidget.background': theme.surfaces.surface,
      'editorWidget.border': theme.surfaces.border,
      'editorSuggestWidget.background': theme.surfaces.surface,
      'editorSuggestWidget.border': theme.surfaces.border,
      'editorHoverWidget.background': theme.surfaces.surface,
      'editorHoverWidget.border': theme.surfaces.border,
      'editorCursor.foreground': '#D4D4D4',
      'editor.findMatchBackground': '#515c6a',
      'editor.findMatchHighlightBackground': '#ea5c0055',
      'minimap.background': theme.surfaces.editor,
      'scrollbarSlider.background': '#67676750',
      'scrollbarSlider.hoverBackground': '#676767',
      'scrollbarSlider.activeBackground': '#676767',
    },
  });
}

defineEditorTheme(getBackgroundTheme());
// Redefining a theme repaints open editors when it is the active one (monaco's
// standalone theme service refreshes it), so no setTheme call is needed here —
// and none is wanted: setTheme is global and would fight the SQL editor's theme.
onBackgroundThemeChange(defineEditorTheme);

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../../monacoEnvironment';
import * as monaco from 'monaco-editor';
import { SplitHorizontalIcon, SplitVerticalIcon } from '../Icons';
import { SqlTabBar } from '../SqlTabBar';
import { SqlContextSelect } from './SqlContextSelect';
import { format as formatSql, type SqlLanguage } from 'sql-formatter';
import { ConnectionTree, type TableChildren } from './panels/ConnectionTree';
import { ObjectEditor } from './panels/ObjectEditor';
import { EditorPane } from './panels/EditorPane';
import { ResultsPane, type StatementOutcome, type ExplainResult } from './panels/ResultsPane';
import type { DataGridEditConfig } from './panels/DataGrid';
import { HistoryPanel } from './panels/HistoryPanel';
import { ConnectionDialog, type ConnectionFormValues } from './dialogs/ConnectionDialog';
import { ExportDialog, type ExportRequest, type ExportScopeInfo } from './dialogs/ExportDialog';
import { ImportDialog } from './dialogs/ImportDialog';
import { useSplitter } from './hooks/useSplitter';
import { getDialectCapabilities } from '../../../shared/dialects';
import { quoteIdent } from './sqlIdentifiers';
import { splitSqlStatements, statementAtOffset, type SqlStatement } from './sqlStatements';
import { parseCsv, detectCsvDelimiter } from '../../../shared/sql-serialize';
import {
  registerSqlWorkbench, unregisterSqlWorkbench,
  type SqlWorkbenchHandle, type SqlPanelInfo, type SqlConnectionSummary,
  type SqlTableSummary, type SqlColumnSummary,
} from './sqlWorkbenchRegistry';
import type {
  SQLColumnInfo,
  SavedSQLConnection,
  SQLConnectionInfo,
  SQLContainerState,
  SQLDatabaseInfo,
  SQLDialect,
  SQLFavoriteQuery,
  SQLHistoryEntry,
  SQLSchemaObjectKind,
  SQLQueryResult,
  SQLSchemaTree,
  SQLTab,
  SQLQueryTab,
  SQLTableTab,
  SQLStructureTab,
} from '../../../shared/types';

const DEFAULT_QUERY = 'SELECT now();';
const SQL_EDITOR_THEME = 'splitgrid-sql-dark';
const MAX_HISTORY = 50;
const DEFAULT_TREE_WIDTH = 280;
const DEFAULT_EDITOR_HEIGHT = 220;
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'INNER JOIN', 'FULL JOIN', 'ON', 'AS', 'DISTINCT', 'UNION', 'UNION ALL',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SCHEMA',
  'INDEX', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'CALL', 'RETURNING',
];

interface SqlWorkbenchProps {
  /** This pane's container id. Lets the agent SQL bridge look this instance up in
   * the workbench registry and drive it (runtime-only; not persisted). */
  containerId?: string;
  initialState?: SQLContainerState;
  zoomLevel: number;
  onStateChange?: (state: SQLContainerState) => void;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

interface ReconnectState {
  targetSavedId: string | null;
  attempt: number;
  maxAttempts: number;
}

interface TabRuntime {
  result: SQLQueryResult | null;
  error: string;
  executing: boolean;
  page: number;
  pageSize: number;
  sortColumn: string | null;
  sortDirection: 'ASC' | 'DESC';
  totalEstimate: number;
  // Multi-statement run outcomes (empty/length<=1 → single-statement view).
  outcomes: StatementOutcome[];
  // EXPLAIN sub-tab payload for the last explain run on this tab.
  explain: ExplainResult | null;
  // Per-column server-side row filters (table tabs only). column → contains-text.
  filters: Record<string, string>;
}

function newTabRuntime(): TabRuntime {
  return { result: null, error: '', executing: false, page: 0, pageSize: 100, sortColumn: null, sortDirection: 'ASC', totalEstimate: 0, outcomes: [], explain: null, filters: {} };
}

// Map our dialect → sql-formatter's `language` option (verified via docs).
const FORMATTER_LANGUAGE: Record<SQLDialect, SqlLanguage> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  mssql: 'tsql',
};

// Parse a 1-based character position out of an (enriched) postgres error message.
function parseErrorPosition(message: string): number | null {
  const m = /Position:\s*(\d+)/i.exec(message);
  if (m) return parseInt(m[1], 10);
  return null;
}

function makeQueryTabId() { return `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function makeTableTabId(schema: string, name: string) { return `t:${schema}.${name}`; }

function parseAliasMap(sqlPrefix: string): Map<string, { schema: string; table: string }> {
  const aliasMap = new Map<string, { schema: string; table: string }>();
  const regex = /\b(?:from|join)\s+([a-zA-Z_][\w$]*)(?:\.([a-zA-Z_][\w$]*))?(?:\s+(?:as\s+)?([a-zA-Z_][\w$]*))?/gi;
  let match: RegExpExecArray | null = regex.exec(sqlPrefix);
  while (match) {
    const first = match[1];
    const second = match[2];
    const alias = match[3];
    const schema = second ? first : 'public';
    const table = second ?? first;
    if (alias) aliasMap.set(alias.toLowerCase(), { schema, table });
    aliasMap.set(table.toLowerCase(), { schema, table });
    match = regex.exec(sqlPrefix);
  }
  return aliasMap;
}

function emptyForm(): ConnectionFormValues {
  // Empty fields — the dialog shows placeholders (and falls back to sensible
  // defaults on save) instead of pre-filling values.
  return {
    label: '', dialect: 'postgres', host: '', port: 0,
    user: '', password: '', database: '', ssl: false, filePath: '',
  };
}

monaco.editor.defineTheme(SQL_EDITOR_THEME, {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'editor.background': '#181818',
    'editor.lineHighlightBackground': '#262626',
    'editor.selectionBackground': '#264f78',
    'editorLineNumber.foreground': '#505050',
    'editorLineNumber.activeForeground': '#D4D4D4',
  },
});

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({
  containerId,
  initialState,
  zoomLevel,
  onStateChange,
  onClose,
  onSplitRight,
  onSplitDown,
}) => {
  const editorFontSize = Math.max(8, Math.min(28, zoomLevel));
  const uiFontSize = Math.max(10, Math.round(zoomLevel * 0.85));
  // Zoom factor relative to the base (13) — scales the data grid row height so
  // rows track the cell font (which scales via --sql-font-size).
  const uiScale = uiFontSize / Math.round(13 * 0.85);

  /* ===== Connection state ===== */
  const [savedConnections, setSavedConnections] = useState<SavedSQLConnection[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(initialState?.savedConnectionId ?? null);
  const [connectedSavedId, setConnectedSavedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<SQLConnectionInfo | null>(null);
  const [databases, setDatabases] = useState<SQLDatabaseInfo[]>([]);
  const [schemas, setSchemas] = useState<SQLSchemaTree[]>([]);
  const [columns, setColumns] = useState<SQLColumnInfo[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<string[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);
  // Object (table/view/...) context menu in the tree.
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; schema: string; name: string; kind: SQLSchemaObjectKind } | null>(null);
  // Runtime-only per-table children cache (columns/indexes/keys/triggers), keyed
  // by `schema.table`. Never persisted (kept out of SQLContainerState).
  const [tableChildren, setTableChildren] = useState<Record<string, TableChildren>>({});
  // Small modal for rename / drop confirmation.
  const [actionDialog, setActionDialog] = useState<
    | { mode: 'rename'; schema: string; name: string; kind: SQLSchemaObjectKind; value: string }
    | { mode: 'drop'; schema: string; name: string; kind: SQLSchemaObjectKind; cascade: boolean }
    | null
  >(null);
  const [actionError, setActionError] = useState('');
  const [showConnectionDialog, setShowConnectionDialog] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [dialogForm, setDialogForm] = useState<ConnectionFormValues>(emptyForm);
  const [dialogError, setDialogError] = useState('');
  const [connecting, setConnecting] = useState(false); // eslint-disable-line @typescript-eslint/no-unused-vars
  const [reconnectState, setReconnectState] = useState<ReconnectState>({ targetSavedId: null, attempt: 0, maxAttempts: 3 });
  const [failedConnectionIds, setFailedConnectionIds] = useState<Set<string>>(new Set());
  const [connError, setConnError] = useState('');

  /* ===== Export / Import dialogs ===== */
  const [exportDialog, setExportDialog] = useState<ExportScopeInfo | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const [toast, setToast] = useState('');
  const [importDialog, setImportDialog] = useState<{ schema: string; table: string } | null>(null);

  /* ===== Layout (splitters) ===== */
  const treeSplit = useSplitter({
    initial: initialState?.treeWidth ?? DEFAULT_TREE_WIDTH,
    min: 180, max: 640, axis: 'horizontal',
  });
  const editorSplit = useSplitter({
    initial: initialState?.editorHeight ?? DEFAULT_EDITOR_HEIGHT,
    min: 100, axis: 'vertical',
  });

  /* ===== Tab state ===== */
  const initTabs = useMemo(() => {
    if (initialState?.tabs?.length) return initialState.tabs;
    return [{ id: 'query-1', type: 'query' as const, title: 'Query 1', query: DEFAULT_QUERY }];
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tabs, setTabs] = useState<SQLTab[]>(initTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialState?.activeTabId ?? initTabs[0]?.id ?? null);
  const [history, setHistory] = useState<SQLHistoryEntry[]>(initialState?.history ?? []);
  const [favorites, setFavorites] = useState<SQLFavoriteQuery[]>(initialState?.favorites ?? []);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedDatabase, setSelectedDatabase] = useState<string>(initialState?.database ?? 'postgres');
  const [selectedSchema, setSelectedSchema] = useState<string>(initialState?.schema ?? 'public');
  const tabRuntimesRef = useRef<Map<string, TabRuntime>>(new Map());
  // Last-executed statements per query tab, so Refresh re-runs exactly what
  // produced the currently-shown result (not whatever the editor now contains).
  const lastRunRef = useRef<Map<string, SqlStatement[]>>(new Map());
  // Primary-key columns per table tab id (empty array = known no-PK → read-only;
  // undefined = not yet fetched). Runtime-only; never persisted.
  const [tablePks, setTablePks] = useState<Record<string, string[]>>({});

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

  // The connection → database → schema → table path backing the result currently
  // shown on screen. Drives the tree highlight (table set only for table tabs).
  const activePath = useMemo(() => {
    if (!activeTab || !activeTab.savedConnectionId) return null;
    return {
      savedId: activeTab.savedConnectionId,
      database: activeTab.database ?? null,
      schema: (activeTab.type === 'table' || activeTab.type === 'structure' || activeTab.type === 'query')
        ? (activeTab.schema ?? null) : null,
      table: (activeTab.type === 'table' || activeTab.type === 'structure') ? activeTab.objectName : null,
    };
  }, [activeTab]);

  /* ===== Monaco models ===== */
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const syncingRef = useRef(false);
  const lastPersisted = useRef('');
  const treeListRef = useRef<HTMLDivElement>(null);
  const handleRunStatementRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const handleRunSelectionRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const handleFormatRef = useRef<() => void>(() => {});
  const databasesRef = useRef<SQLDatabaseInfo[]>([]);
  const schemasRef = useRef<SQLSchemaTree[]>([]);
  const columnsRef = useRef<SQLColumnInfo[]>([]);
  // True only when the ACTIVE tab's connection is the currently-live one.
  // Gates query execution so a run never hits a stale/other connection.
  const activeConnLiveRef = useRef(false);
  const selectedSchemaRef = useRef('public');
  const selectedDatabaseRef = useRef('postgres'); // eslint-disable-line @typescript-eslint/no-unused-vars

  const getRuntime = useCallback((tabId: string): TabRuntime => {
    let rt = tabRuntimesRef.current.get(tabId);
    if (!rt) { rt = newTabRuntime(); tabRuntimesRef.current.set(tabId, rt); }
    return rt;
  }, []);

  const [, forceUpdate] = useState(0);
  const poke = useCallback(() => forceUpdate((n) => n + 1), []);

  const updateRuntime = useCallback((tabId: string, patch: Partial<TabRuntime>) => {
    const rt = getRuntime(tabId);
    Object.assign(rt, patch);
    poke();
  }, [getRuntime, poke]);

  /* ===== Helpers ===== */
  const toggle = (id: string) => setExpandedNodes((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const expand = (id: string) => setExpandedNodes((p) => (p.includes(id) ? p : [...p, id]));

  const selectedConnection = useMemo(
    () => savedConnections.find((c) => c.id === selectedSavedId) ?? null,
    [savedConnections, selectedSavedId],
  );

  const activeDialect: SQLDialect = selectedConnection?.dialect ?? 'postgres';
  const activeCaps = useMemo(
    () => getDialectCapabilities(activeDialect),
    [activeDialect],
  );
  const activeDialectRef = useRef<SQLDialect>(activeDialect);
  useEffect(() => { activeDialectRef.current = activeDialect; }, [activeDialect]);

  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.savedConnectionId && activeTab.savedConnectionId !== selectedSavedId) {
      setSelectedSavedId(activeTab.savedConnectionId);
    }
    if (activeTab.database) setSelectedDatabase(activeTab.database);
    if (activeTab.type === 'query' && activeTab.schema) setSelectedSchema(activeTab.schema);
    if (activeTab.type === 'table' && activeTab.schema) setSelectedSchema(activeTab.schema);
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { databasesRef.current = databases; }, [databases]);
  useEffect(() => { schemasRef.current = schemas; }, [schemas]);
  useEffect(() => { columnsRef.current = columns; }, [columns]);
  useEffect(() => { selectedSchemaRef.current = selectedSchema; }, [selectedSchema]);
  useEffect(() => { selectedDatabaseRef.current = selectedDatabase; }, [selectedDatabase]);

  useEffect(() => {
    if (!schemas.length) return;
    if (schemas.some((s) => s.schema === selectedSchema)) return;
    const fallback = schemas.find((s) => s.isDefault)?.schema ?? schemas[0]?.schema ?? 'public';
    setSelectedSchema(fallback);
  }, [schemas, selectedSchema]);

  /* ===== Tab operations ===== */
  const openQueryTab = useCallback((query = DEFAULT_QUERY) => {
    const queryCount = tabs.filter((t) => t.type === 'query').length;
    const tab: SQLQueryTab = {
      id: makeQueryTabId(),
      type: 'query',
      title: `Query ${queryCount + 1}`,
      query,
      savedConnectionId: selectedSavedId,
      database: selectedDatabase,
      schema: selectedSchema,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab;
  }, [tabs, selectedSavedId, selectedDatabase, selectedSchema]);

  const openTableTab = useCallback((schema: string, objectName: string, rowEstimate?: number) => {
    const existingId = makeTableTabId(schema, objectName);
    const existing = tabs.find((t) => t.id === existingId);
    if (existing) {
      setActiveTabId(existingId);
      return existing;
    }
    const tab: SQLTableTab = {
      id: existingId,
      type: 'table',
      title: objectName,
      schema,
      objectName,
      savedConnectionId: selectedSavedId,
      database: selectedDatabase,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    const rt = getRuntime(tab.id);
    rt.totalEstimate = rowEstimate ?? 0;
    return tab;
  }, [tabs, getRuntime, selectedSavedId, selectedDatabase]);

  const closeTab = useCallback((tabId: string) => {
    const model = modelsRef.current.get(tabId);
    if (model) { model.dispose(); modelsRef.current.delete(tabId); }
    tabRuntimesRef.current.delete(tabId);
    setTablePks((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        const idx = prev.findIndex((t) => t.id === tabId);
        const neighbor = next[Math.min(idx, next.length - 1)] ?? null;
        setActiveTabId(neighbor?.id ?? null);
      }
      return next;
    });
  }, [activeTabId]);

  const closeOtherTabs = useCallback((keepId: string) => {
    tabs.forEach((t) => { if (t.id !== keepId) { modelsRef.current.get(t.id)?.dispose(); modelsRef.current.delete(t.id); tabRuntimesRef.current.delete(t.id); } });
    setTabs((prev) => prev.filter((t) => t.id === keepId));
    setActiveTabId(keepId);
  }, [tabs]);

  const closeAllTabs = useCallback(() => {
    modelsRef.current.forEach((m) => m.dispose());
    modelsRef.current.clear();
    tabRuntimesRef.current.clear();
    setTabs([]);
    setActiveTabId(null);
  }, []);

  useEffect(() => {
    if (!activeTabId) return;
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== activeTabId) return tab;
        if (tab.type === 'query') {
          return { ...tab, savedConnectionId: selectedSavedId, database: selectedDatabase, schema: selectedSchema };
        }
        return { ...tab, savedConnectionId: selectedSavedId, database: selectedDatabase };
      })
    );
  }, [activeTabId, selectedSavedId, selectedDatabase, selectedSchema]);

  /* ===== Monaco editor ===== */
  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) return;
    const editor = monaco.editor.create(editorHostRef.current, {
      language: 'sql',
      theme: SQL_EDITOR_THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: editorFontSize,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      smoothScrolling: true,
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = editor;
    // Cmd/Ctrl+Enter → run statement at cursor; +Shift → run selection (or all).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void handleRunStatementRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => void handleRunSelectionRef.current());
    // Shift+Alt+F → format.
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => handleFormatRef.current());
    return () => { editor.dispose(); editorRef.current = null; };
  }, [editorFontSize]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: editorFontSize });
  }, [editorFontSize]);

  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const mkItem = (
          label: string, insertText: string, kind: monaco.languages.CompletionItemKind, detail?: string
        ): monaco.languages.CompletionItem => ({ label, insertText, kind, detail, range });

        const dbNames = databasesRef.current.map((db) => db.name);
        const schemaNames = schemasRef.current.map((schema) => schema.schema);
        const tableEntries = schemasRef.current.flatMap((schema) =>
          schema.categories
            .filter((cat) => ['table', 'view', 'materializedView', 'foreignTable'].includes(cat.kind))
            .flatMap((cat) => cat.objects.map((obj) => ({ schema: schema.schema, table: obj.name })))
        );
        const tableKeyToColumns = new Map<string, string[]>();
        for (const c of columnsRef.current) {
          const key = `${c.schema}.${c.table}`.toLowerCase();
          tableKeyToColumns.set(key, [...(tableKeyToColumns.get(key) ?? []), c.column]);
        }

        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const sqlPrefix = model.getValueInRange({
          startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
        });

        if (/\.\s*$/.test(linePrefix)) {
          const explicitTableRef = linePrefix.match(/([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\.\s*$/i);
          if (explicitTableRef) {
            const schema = explicitTableRef[1];
            const table = explicitTableRef[2];
            const key = `${schema}.${table}`.toLowerCase();
            const colSuggestions = (tableKeyToColumns.get(key) ?? []).map((col) =>
              mkItem(col, col, monaco.languages.CompletionItemKind.Field, `${schema}.${table}`));
            return { suggestions: colSuggestions };
          }

          const m = linePrefix.match(/([a-zA-Z_][\w$]*)\s*\.\s*$/i);
          if (m) {
            const lhs = m[1];
            const lhsLower = lhs.toLowerCase();

            const db = dbNames.find((name) => name.toLowerCase() === lhsLower);
            if (db) {
              return { suggestions: schemaNames.map((schema) =>
                mkItem(schema, schema, monaco.languages.CompletionItemKind.Module, `Schema in ${db}`)) };
            }

            const schema = schemaNames.find((name) => name.toLowerCase() === lhsLower);
            if (schema) {
              const tableSuggestions = tableEntries
                .filter((entry) => entry.schema.toLowerCase() === lhsLower)
                .map((entry) => mkItem(entry.table, entry.table, monaco.languages.CompletionItemKind.Struct, `${entry.schema} table`));
              return { suggestions: tableSuggestions };
            }

            const aliasMap = parseAliasMap(sqlPrefix);
            const aliasResolved = aliasMap.get(lhsLower);
            const target = aliasResolved ?? tableEntries.find((entry) => {
              if (entry.table.toLowerCase() !== lhsLower) return false;
              return entry.schema === selectedSchemaRef.current || entry.schema === 'public';
            });
            if (target) {
              const key = `${target.schema}.${target.table}`.toLowerCase();
              const colSuggestions = (tableKeyToColumns.get(key) ?? []).map((col) =>
                mkItem(col, col, monaco.languages.CompletionItemKind.Field, `${target.schema}.${target.table}`));
              return { suggestions: colSuggestions };
            }
          }
        }

        const keywordSuggestions = SQL_KEYWORDS.map((keyword) =>
          mkItem(keyword, keyword, monaco.languages.CompletionItemKind.Keyword, 'SQL keyword'));
        const dbSuggestions = dbNames.map((db) =>
          mkItem(db, db, monaco.languages.CompletionItemKind.Module, 'Database'));
        const schemaSuggestions = schemaNames.map((schema) =>
          mkItem(schema, schema, monaco.languages.CompletionItemKind.Module, 'Schema'));
        const tableSuggestions = tableEntries.map((entry) =>
          mkItem(entry.table, entry.table, monaco.languages.CompletionItemKind.Struct, `${entry.schema} table`));
        return { suggestions: [...keywordSuggestions, ...dbSuggestions, ...schemaSuggestions, ...tableSuggestions] };
      },
    });
    return () => provider.dispose();
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!activeTab || activeTab.type !== 'query') {
      editor.setModel(null);
      return;
    }
    let model = modelsRef.current.get(activeTab.id);
    if (!model) {
      model = monaco.editor.createModel(activeTab.query, 'sql');
      modelsRef.current.set(activeTab.id, model);
      model.onDidChangeContent(() => {
        if (syncingRef.current) return;
        const newQuery = model!.getValue();
        setTabs((prev) => prev.map((t) => t.id === activeTab.id && t.type === 'query' ? { ...t, query: newQuery } : t));
      });
    }
    editor.setModel(model);
    editor.updateOptions({ readOnly: activeTab.type === 'query' && !!activeTab.readOnly });
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ===== Connection operations ===== */
  const refreshSaved = async () => {
    const next = await window.electronAPI.sqlGetSavedConnections();
    setSavedConnections(next);
    if (!selectedSavedId && next.length > 0) setSelectedSavedId(next[0].id);
  };

  const refreshSchemas = async (connectionId: string) => {
    setLoadingSchemas(true);
    try {
      const [s, d, c] = await Promise.all([
        window.electronAPI.sqlListSchemas(connectionId),
        window.electronAPI.sqlListDatabases(connectionId),
        window.electronAPI.sqlListColumns(connectionId),
      ]);
      setSchemas(s); setDatabases(d); setColumns(c);
      const currentDb = d.find((db) => db.isCurrent)?.name;
      if (currentDb) setSelectedDatabase(currentDb);
      const defaultSchema = s.find((schema) => schema.isDefault)?.schema ?? s[0]?.schema;
      if (defaultSchema) setSelectedSchema((prev) => prev || defaultSchema);
    } catch (err) { setConnError((err as Error).message); }
    finally { setLoadingSchemas(false); }
  };

  const handleConnectWithRetry = useCallback(async (
    targetSavedId: string,
    targetDatabase?: string | null
  ): Promise<SQLConnectionInfo | null> => {
    if (!targetSavedId) return null;
    // Keep the currently-active connection alive as a fallback: only tear it
    // down AFTER the new one connects. Otherwise a failed connect would leave us
    // with nothing connected (looks like "switching killed my connection").
    const previousConnId = connection?.id ?? null;
    setConnecting(true);
    setConnError('');
    setReconnectState({ targetSavedId, attempt: 0, maxAttempts: 3 });
    setFailedConnectionIds((prev) => {
      if (!prev.has(targetSavedId)) return prev;
      const next = new Set(prev);
      next.delete(targetSavedId);
      return next;
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      setReconnectState({ targetSavedId, attempt, maxAttempts: 3 });
      try {
        const info = targetDatabase
          ? await window.electronAPI.sqlConnectSavedToDatabase(targetSavedId, targetDatabase)
          : await window.electronAPI.sqlConnectSaved(targetSavedId);
        setConnection(info);
        setConnectedSavedId(targetSavedId);
        setSelectedSavedId(targetSavedId);
        setSelectedDatabase(info.database);
        expand(`conn:${targetSavedId}`);
        // New connection is live — now safe to drop the previous one.
        if (previousConnId && previousConnId !== info.id) {
          await window.electronAPI.sqlDisconnect(previousConnId).catch(() => {});
        }
        await refreshSchemas(info.id);
        setSelectedSchema((prev) => prev || 'public');
        setReconnectState({ targetSavedId: null, attempt: 0, maxAttempts: 3 });
        setConnecting(false);
        return info;
      } catch (err) {
        if (attempt === 3) {
          // Keep the previously-active connection (we never dropped it). Only
          // reset to a blank state when there was nothing to fall back to.
          if (!previousConnId) {
            setConnection(null);
            setConnectedSavedId(null);
            setSchemas([]);
            setDatabases([]);
            setColumns([]);
          }
          setConnError((err as Error).message);
          setFailedConnectionIds((prev) => new Set(prev).add(targetSavedId));
          setReconnectState({ targetSavedId: null, attempt: 0, maxAttempts: 3 });
          setConnecting(false);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return null;
  }, [connection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load saved connections on mount, then auto-reconnect persisted savedConnectionId.
  useEffect(() => {
    void refreshSaved().then(() => {
      if (initialState?.savedConnectionId) {
        void handleConnectWithRetry(initialState.savedConnectionId, initialState.database ?? null);
        if (initialState.schema) setSelectedSchema(initialState.schema);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openAddDialog = useCallback(() => {
    setEditingConnectionId(null);
    setDialogForm(emptyForm());
    setDialogError('');
    setShowConnectionDialog(true);
  }, []);

  const handleSaveConnection = async (values: ConnectionFormValues) => {
    setDialogError('');
    const caps = getDialectCapabilities(values.dialect);
    // Empty host/port fall back to the placeholders' implied defaults.
    const effHost = values.host.trim() || '127.0.0.1';
    const effPort = values.port || caps.defaultPort || 0;
    const fallbackLabel = caps.requiresFilePath
      ? (values.filePath.trim() || values.label.trim() || values.dialect)
      : `${values.user}@${effHost}/${values.database || values.user}`;
    try {
      let saved: SavedSQLConnection;
      if (editingConnectionId) {
        saved = await window.electronAPI.sqlUpdateConnection(editingConnectionId, {
          label: values.label.trim() || fallbackLabel,
          host: effHost,
          port: effPort,
          user: values.user.trim(),
          database: caps.requiresFilePath ? values.filePath.trim() : values.database.trim(),
          ssl: values.ssl,
          ...(caps.requiresFilePath ? { filePath: values.filePath.trim() } : {}),
        });
      } else {
        if (caps.requiresFilePath) {
          if (!values.filePath.trim()) { setDialogError('Database file path is required'); return; }
        } else if (!values.password.trim()) {
          setDialogError('Password is required'); return;
        }
        saved = await window.electronAPI.sqlSaveConnection({
          label: values.label.trim() || fallbackLabel,
          dialect: values.dialect,
          host: effHost,
          port: effPort,
          user: values.user.trim(),
          password: values.password,
          database: caps.requiresFilePath ? values.filePath.trim() : values.database.trim(),
          ssl: values.ssl,
          ...(caps.requiresFilePath ? { filePath: values.filePath.trim() } : {}),
        });
      }
      await refreshSaved();
      setSelectedSavedId(saved.id);
      setShowConnectionDialog(false);
      setEditingConnectionId(null);
      expand(`conn:${saved.id}`);
    } catch (err) { setDialogError((err as Error).message); }
  };

  const handleDeleteSelected = async (targetId: string | null = selectedSavedId) => {
    if (!targetId) return;
    try {
      if (connectedSavedId === targetId && connection?.id) {
        await window.electronAPI.sqlDisconnect(connection.id);
        setConnection(null); setConnectedSavedId(null); setSchemas([]); setDatabases([]); setColumns([]);
      }
      await window.electronAPI.sqlDeleteConnection(targetId);
      await refreshSaved();
      if (selectedSavedId === targetId) setSelectedSavedId(null);
      setExpandedNodes((p) => p.filter((id) => !id.includes(targetId)));
    } catch (err) { setConnError((err as Error).message); }
  };

  const handleConnectSelected = async (targetId: string | null = selectedSavedId) => {
    if (!targetId) { setConnError('Select connection'); return; }
    await handleConnectWithRetry(targetId, selectedDatabase || null);
    expand(`db:${targetId}:${selectedDatabase || 'postgres'}`);
    expand(`schemas:${targetId}:${selectedDatabase || 'postgres'}`);
    expand(`schema:${targetId}:${selectedDatabase || 'postgres'}:${selectedSchema || 'public'}`);
  };

  const handleConnectionSelect = useCallback(async (nextSavedId: string) => {
    setSelectedSavedId(nextSavedId || null);
    if (!nextSavedId) return;
    const saved = savedConnections.find((c) => c.id === nextSavedId);
    const db = saved?.database ?? selectedDatabase;
    setSelectedDatabase(db);
    await handleConnectWithRetry(nextSavedId, db);
  }, [savedConnections, selectedDatabase, handleConnectWithRetry]);

  const handleDatabaseSelect = useCallback(async (nextDatabase: string) => {
    setSelectedDatabase(nextDatabase);
    if (!selectedSavedId) return;
    await handleConnectWithRetry(selectedSavedId, nextDatabase);
  }, [selectedSavedId, handleConnectWithRetry]);

  // Lazily list schemas for an arbitrary database (cascade submenu). Uses a
  // throwaway connection to that db so the active connection is untouched.
  const loadSchemasForDatabase = useCallback(async (db: string): Promise<string[]> => {
    if (db === selectedDatabase) return schemas.map((s) => s.schema);
    if (!selectedSavedId) return [];
    let tempId: string | null = null;
    try {
      const info = await window.electronAPI.sqlConnectSavedToDatabase(selectedSavedId, db);
      tempId = info.id;
      const list = await window.electronAPI.sqlListSchemas(info.id);
      return list.map((s) => s.schema);
    } catch {
      return [];
    } finally {
      if (tempId) await window.electronAPI.sqlDisconnect(tempId).catch(() => {});
    }
  }, [selectedSavedId, selectedDatabase, schemas]);

  // Apply a (connection, database, schema) pick from the cascade. Reconnects
  // only when the connection/database actually changes; empty parts keep current.
  const pickContext = useCallback(async (connId: string, db: string, sch: string) => {
    if (connId && connId !== selectedSavedId) {
      await handleConnectionSelect(connId);
      if (db) await handleDatabaseSelect(db);
    } else if (db && db !== selectedDatabase) {
      await handleDatabaseSelect(db);
    }
    if (sch) setSelectedSchema(sch);
  }, [selectedSavedId, selectedDatabase, handleConnectionSelect, handleDatabaseSelect]);

  const handleDisconnect = async () => {
    if (!connection?.id) return;
    try {
      await window.electronAPI.sqlDisconnect(connection.id);
      setConnection(null); setConnectedSavedId(null); setSchemas([]); setDatabases([]); setColumns([]);
    } catch (err) { setConnError((err as Error).message); }
  };

  /* ===== Query execution ===== */
  const appendHistory = (entry: SQLHistoryEntry) =>
    setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));

  const ensureConnectionForTab = useCallback(async (tab: SQLTab): Promise<string | null> => {
    const targetSavedId = tab.savedConnectionId ?? selectedSavedId;
    const targetDatabase = tab.database ?? selectedDatabase;
    if (!targetSavedId) return null;

    const sameSaved = connectedSavedId === targetSavedId;
    const sameDb = connection?.database === targetDatabase;
    if (!connection?.id || !sameSaved || !sameDb) {
      const info = await handleConnectWithRetry(targetSavedId, targetDatabase);
      return info?.id ?? null;
    }
    return connection?.id ?? null;
  }, [selectedSavedId, selectedDatabase, connectedSavedId, connection?.id, connection?.database, handleConnectWithRetry]);

  // Clear any inline error markers on the given tab's Monaco model.
  const clearMarkers = useCallback((tabId: string) => {
    const model = modelsRef.current.get(tabId);
    if (model) monaco.editor.setModelMarkers(model, 'sql-exec', []);
  }, []);

  // Place a red squiggle at a postgres error position (1-based into the failing
  // statement). `stmtStart` is the statement's source offset. Best-effort.
  const placeErrorMarker = useCallback((tabId: string, message: string, stmtStart: number, stmtLen: number) => {
    const model = modelsRef.current.get(tabId);
    if (!model) return;
    const pos = parseErrorPosition(message);
    if (pos == null) return;
    const offset = stmtStart + Math.min(Math.max(pos - 1, 0), Math.max(stmtLen - 1, 0));
    const p = model.getPositionAt(offset);
    const endP = model.getPositionAt(offset + 1);
    monaco.editor.setModelMarkers(model, 'sql-exec', [{
      severity: monaco.MarkerSeverity.Error,
      message: message.split('\n')[0],
      startLineNumber: p.lineNumber,
      startColumn: p.column,
      endLineNumber: endP.lineNumber,
      endColumn: Math.max(endP.column, p.column + 1),
    }]);
  }, []);

  // Issue the per-run `SET search_path` once (schema dialects only), like Phase 2.
  const applySearchPath = useCallback(async (connectionId: string, tab: SQLTab) => {
    const runSchema = tab.type === 'query' ? (tab.schema ?? selectedSchema) : tab.schema;
    if (runSchema && activeCaps.supportsSchemas) {
      await window.electronAPI.sqlExecute(connectionId, `SET search_path TO ${quoteIdent(runSchema, activeDialect)}`);
    }
  }, [selectedSchema, activeCaps.supportsSchemas, activeDialect]);

  const mkHistoryId = () => `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Run one or more statements sequentially (one sql:execute per statement).
  // Stops on the first error but keeps already-produced results visible.
  const runStatements = useCallback(async (tabId: string, statements: SqlStatement[]) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!activeConnLiveRef.current) {
      updateRuntime(tabId, { error: 'Connection is not active — reconnect to run.' });
      return;
    }
    if (statements.length === 0) { updateRuntime(tabId, { error: 'Query is empty' }); return; }
    lastRunRef.current.set(tabId, statements);
    const activeConnectionId = await ensureConnectionForTab(tab);
    if (!activeConnectionId) return;
    clearMarkers(tabId);
    updateRuntime(tabId, { executing: true, error: '', explain: null });
    try {
      await applySearchPath(activeConnectionId, tab);
    } catch { /* non-fatal: continue, the statements may still work */ }

    const outcomes: StatementOutcome[] = [];
    let firstError = '';
    for (const stmt of statements) {
      const t0 = Date.now();
      try {
        const r = await window.electronAPI.sqlExecute(activeConnectionId, stmt.text);
        outcomes.push({ statementText: stmt.text, result: r, error: null, durationMs: r.durationMs });
        appendHistory({ id: mkHistoryId(), query: stmt.text, executedAt: Date.now(), durationMs: r.durationMs, rowCount: r.rowCount, ok: true });
      } catch (err) {
        const msg = (err as Error).message || 'Query failed';
        outcomes.push({ statementText: stmt.text, result: null, error: msg, durationMs: Date.now() - t0 });
        appendHistory({ id: mkHistoryId(), query: stmt.text, executedAt: Date.now(), ok: false, error: msg });
        firstError = msg;
        placeErrorMarker(tabId, msg, stmt.rawStart, stmt.text.length);
        break; // stop-on-error
      }
    }

    const lastResult = [...outcomes].reverse().find((o) => o.result)?.result ?? null;
    updateRuntime(tabId, {
      executing: false,
      outcomes,
      result: lastResult,
      error: outcomes.length === 1 ? (outcomes[0].error ?? '') : (firstError && !lastResult ? firstError : ''),
    });
  }, [tabs, ensureConnectionForTab, clearMarkers, updateRuntime, applySearchPath, placeErrorMarker]);

  // Re-run the statements that produced a query tab's current result.
  const refreshQuery = useCallback((tabId: string) => {
    const stmts = lastRunRef.current.get(tabId);
    if (stmts && stmts.length) void runStatements(tabId, stmts);
  }, [runStatements]);

  const getActiveModelValue = useCallback((): { tab: SQLQueryTab; model: monaco.editor.ITextModel | null; sql: string } | null => {
    if (!activeTab || activeTab.type !== 'query') return null;
    const model = modelsRef.current.get(activeTab.id) ?? null;
    const sql = model?.getValue() ?? activeTab.query;
    return { tab: activeTab, model, sql };
  }, [activeTab]);

  // Cmd/Ctrl+Enter — run the statement at the cursor.
  const handleRunStatement = useCallback(async () => {
    const ctx = getActiveModelValue();
    if (!ctx) return;
    const { tab, model, sql } = ctx;
    const stmts = splitSqlStatements(sql);
    if (stmts.length === 0) { updateRuntime(tab.id, { error: 'Query is empty' }); return; }
    let target: SqlStatement | null = stmts[0];
    if (model && editorRef.current && editorRef.current.getModel() === model) {
      const offset = model.getOffsetAt(editorRef.current.getPosition() ?? { lineNumber: 1, column: 1 });
      target = statementAtOffset(stmts, offset);
    }
    if (!target) return;
    await runStatements(tab.id, [target]);
  }, [getActiveModelValue, runStatements, updateRuntime]);

  // Cmd/Ctrl+Shift+Enter — run the selection (all statements within it), or all.
  const handleRunSelection = useCallback(async () => {
    const ctx = getActiveModelValue();
    if (!ctx) return;
    const { tab, model } = ctx;
    const editor = editorRef.current;
    let textToRun = ctx.sql;
    let baseOffset = 0;
    if (model && editor && editor.getModel() === model) {
      const sel = editor.getSelection();
      if (sel && !sel.isEmpty()) {
        textToRun = model.getValueInRange(sel);
        baseOffset = model.getOffsetAt(sel.getStartPosition());
      }
    }
    const stmts = splitSqlStatements(textToRun).map((s) => ({
      ...s, rawStart: s.rawStart + baseOffset, start: s.start + baseOffset, end: s.end + baseOffset,
    }));
    await runStatements(tab.id, stmts);
  }, [getActiveModelValue, runStatements]);

  // Run all statements in the editor (script).
  const handleRunAll = useCallback(async () => {
    const ctx = getActiveModelValue();
    if (!ctx) return;
    await runStatements(ctx.tab.id, splitSqlStatements(ctx.sql));
  }, [getActiveModelValue, runStatements]);

  // EXPLAIN / EXPLAIN ANALYZE the statement at the cursor.
  const handleExplain = useCallback(async (analyze: boolean) => {
    const ctx = getActiveModelValue();
    if (!ctx) return;
    if (!activeConnLiveRef.current) { updateRuntime(ctx.tab.id, { error: 'Connection is not active — reconnect to run.' }); return; }
    const { tab, model } = ctx;
    const stmts = splitSqlStatements(ctx.sql);
    if (stmts.length === 0) { updateRuntime(tab.id, { error: 'Query is empty' }); return; }
    let target: SqlStatement | null = stmts[0];
    if (model && editorRef.current && editorRef.current.getModel() === model) {
      const offset = model.getOffsetAt(editorRef.current.getPosition() ?? { lineNumber: 1, column: 1 });
      target = statementAtOffset(stmts, offset);
    }
    if (!target) return;
    const activeConnectionId = await ensureConnectionForTab(tab);
    if (!activeConnectionId) return;
    clearMarkers(tab.id);
    updateRuntime(tab.id, { executing: true, error: '' });
    try {
      await applySearchPath(activeConnectionId, tab);
    } catch { /* non-fatal */ }

    const isPg = activeDialect === 'postgres';
    const stripped = target.text.replace(/;\s*$/, '');
    const explainSql = isPg
      ? `EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE true' : ''}) ${stripped}`
      : `EXPLAIN ${stripped}`;
    try {
      const r = await window.electronAPI.sqlExecute(activeConnectionId, explainSql);
      let explain: ExplainResult;
      if (isPg) {
        // The JSON plan is the single cell of the single row.
        const firstRow = r.rows[0] ?? {};
        const cell = r.columns.length ? firstRow[r.columns[0]] : Object.values(firstRow)[0];
        explain = { planJson: cell, analyze, statementText: stripped };
      } else {
        explain = { planJson: null, analyze, statementText: stripped, gridResult: r };
      }
      updateRuntime(tab.id, { executing: false, explain, outcomes: [], result: null, error: '' });
      appendHistory({ id: mkHistoryId(), query: explainSql, executedAt: Date.now(), durationMs: r.durationMs, rowCount: r.rowCount, ok: true });
    } catch (err) {
      const msg = (err as Error).message || 'Explain failed';
      updateRuntime(tab.id, { executing: false, explain: null, error: msg });
      placeErrorMarker(tab.id, msg, target.rawStart, target.text.length);
      appendHistory({ id: mkHistoryId(), query: explainSql, executedAt: Date.now(), ok: false, error: msg });
    }
  }, [getActiveModelValue, ensureConnectionForTab, clearMarkers, updateRuntime, applySearchPath, activeDialect, placeErrorMarker]);

  // Format the editor content (or selection) via sql-formatter.
  const handleFormat = useCallback(() => {
    const editor = editorRef.current;
    const ctx = getActiveModelValue();
    if (!editor || !ctx || !ctx.model || editor.getModel() !== ctx.model) return;
    const model = ctx.model;
    const language = FORMATTER_LANGUAGE[activeDialectRef.current];
    const sel = editor.getSelection();
    try {
      if (sel && !sel.isEmpty()) {
        const text = model.getValueInRange(sel);
        const out = formatSql(text, { language });
        editor.executeEdits('sql-format', [{ range: sel, text: out, forceMoveMarkers: true }]);
      } else {
        const out = formatSql(model.getValue(), { language });
        const fullRange = model.getFullModelRange();
        editor.executeEdits('sql-format', [{ range: fullRange, text: out, forceMoveMarkers: true }]);
      }
    } catch {
      // Formatting failed (unsupported syntax) — leave content untouched.
    }
  }, [getActiveModelValue]);

  handleRunStatementRef.current = handleRunStatement;
  handleRunSelectionRef.current = handleRunSelection;
  handleFormatRef.current = handleFormat;

  const buildTableQuery = useCallback((schema: string, name: string, rt: TabRuntime) => {
    // Schema-aware table reference: omit schema prefix on dialects without schemas.
    const n = quoteIdent(name, activeDialect);
    const ref = activeCaps.supportsSchemas ? `${quoteIdent(schema, activeDialect)}.${n}` : n;
    let sql = `SELECT * FROM ${ref}`;
    // WHERE: per-column case-insensitive "contains". User input is interpolated
    // as a SQL string literal, so single quotes are doubled to prevent injection;
    // wildcards are added via concatenation so user '%'/'_' are matched literally.
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const conds: string[] = [];
    for (const [col, raw] of Object.entries(rt.filters ?? {})) {
      const val = raw.trim();
      if (!val) continue;
      const ident = quoteIdent(col, activeDialect);
      const L = lit(val);
      switch (activeDialect) {
        case 'postgres':
          conds.push(`CAST(${ident} AS TEXT) ILIKE '%' || ${L} || '%'`);
          break;
        case 'mysql':
        case 'mariadb':
          conds.push(`CAST(${ident} AS CHAR) LIKE CONCAT('%', ${L}, '%')`);
          break;
        case 'sqlite':
          conds.push(`CAST(${ident} AS TEXT) LIKE '%' || ${L} || '%'`);
          break;
        case 'mssql':
          conds.push(`CAST(${ident} AS NVARCHAR(MAX)) LIKE '%' + ${L} + '%'`);
          break;
      }
    }
    if (conds.length > 0) sql += ` WHERE ${conds.join(' AND ')}`;
    if (rt.sortColumn) sql += ` ORDER BY ${quoteIdent(rt.sortColumn, activeDialect)} ${rt.sortDirection}`;
    sql += ` LIMIT ${rt.pageSize} OFFSET ${rt.page * rt.pageSize}`;
    return sql;
  }, [activeCaps.supportsSchemas, activeDialect]);

  const loadTableData = useCallback(async (tab: SQLTableTab, patch?: Partial<TabRuntime>) => {
    const activeConnectionId = await ensureConnectionForTab(tab);
    if (!activeConnectionId) return;
    const rt = getRuntime(tab.id);
    if (patch) Object.assign(rt, patch);
    updateRuntime(tab.id, { executing: true, error: '' });
    const sql = buildTableQuery(tab.schema, tab.objectName, rt);
    try {
      const r = await window.electronAPI.sqlExecute(activeConnectionId, sql);
      updateRuntime(tab.id, { result: r, executing: false });
    } catch (err) {
      updateRuntime(tab.id, { error: (err as Error).message, executing: false });
    }
    // Fetch the primary key once per tab so the grid can decide editability.
    if (tablePks[tab.id] === undefined) {
      try {
        const pk = await window.electronAPI.sqlGetPrimaryKey(activeConnectionId, tab.schema, tab.objectName);
        setTablePks((prev) => ({ ...prev, [tab.id]: pk }));
      } catch {
        setTablePks((prev) => ({ ...prev, [tab.id]: [] }));
      }
    }
  }, [ensureConnectionForTab, getRuntime, updateRuntime, buildTableQuery, tablePks]);

  // Auto-load active table tab once after a workspace switch/remount.
  useEffect(() => {
    if (!activeTab || activeTab.type !== 'table') return;
    const rt = getRuntime(activeTab.id);
    if (rt.executing || rt.result) return;
    void loadTableData(activeTab);
  }, [activeTabId, activeTab, getRuntime, loadTableData]);

  const handleTreeTableClick = useCallback((schema: string, objectName: string, rowEstimate?: number) => {
    const tab = openTableTab(schema, objectName, rowEstimate);
    if (tab.type === 'table' && !getRuntime(tab.id).result) {
      void loadTableData(tab as SQLTableTab);
    }
  }, [openTableTab, getRuntime, loadTableData]);

  const handleTreeObjectClick = useCallback((schema: string, objectName: string, kind: SQLSchemaObjectKind) => {
    if (kind === 'table' || kind === 'view' || kind === 'materializedView' || kind === 'foreignTable') {
      const rowEst = schemas.flatMap((s) => s.categories.flatMap((c) => c.objects))
        .find((o) => o.name === objectName)?.rowEstimate ?? undefined;
      handleTreeTableClick(schema, objectName, rowEst ?? 0);
      return;
    }
    const s = quoteIdent(schema, activeDialect);
    const o = quoteIdent(objectName, activeDialect);
    let q = `-- ${schema}.${objectName}`;
    if (kind === 'function') q = `SELECT ${s}.${o}(/* args */);`;
    else if (kind === 'procedure') q = `CALL ${s}.${o}(/* args */);`;
    else if (kind === 'sequence') q = `SELECT * FROM ${s}.${o};`;
    openQueryTab(q);
  }, [schemas, handleTreeTableClick, openQueryTab, activeDialect]);

  /* ===== Tree: lazy table-children load ===== */
  // Load a table's columns/indexes/keys/triggers on first expand. Cached by
  // `schema.table`; never refetched while cached (only on explicit refresh).
  const handleExpandTable = useCallback(async (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    if (tableChildren[key]) return; // already loaded or loading
    if (!connection?.id) return;
    setTableChildren((prev) => ({ ...prev, [key]: { columns: [], indexes: [], keys: [], triggers: [], loading: true } }));
    try {
      const [indexes, keys, triggers] = await Promise.all([
        window.electronAPI.sqlListIndexes(connection.id, schema, table),
        window.electronAPI.sqlListKeys(connection.id, schema, table),
        window.electronAPI.sqlListTriggers(connection.id, schema, table),
      ]);
      const cols = columnsRef.current.filter((c) => c.schema === schema && c.table === table);
      setTableChildren((prev) => ({ ...prev, [key]: { columns: cols, indexes, keys, triggers, loading: false } }));
    } catch (err) {
      setTableChildren((prev) => ({ ...prev, [key]: { columns: [], indexes: [], keys: [], triggers: [], loading: false, error: (err as Error).message } }));
    }
  }, [tableChildren, connection?.id]);

  // Force-reload one table's children (bypasses the cache), picking up DDL
  // changes: refetches connection columns plus this table's indexes/keys/triggers.
  const reloadTableChildren = useCallback(async (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    if (!connection?.id) return;
    setTableChildren((prev) => ({ ...prev, [key]: { columns: [], indexes: [], keys: [], triggers: [], loading: true } }));
    try {
      const [cols, indexes, keys, triggers] = await Promise.all([
        window.electronAPI.sqlListColumns(connection.id),
        window.electronAPI.sqlListIndexes(connection.id, schema, table),
        window.electronAPI.sqlListKeys(connection.id, schema, table),
        window.electronAPI.sqlListTriggers(connection.id, schema, table),
      ]);
      setColumns(cols);
      const filtered = cols.filter((c) => c.schema === schema && c.table === table);
      setTableChildren((prev) => ({ ...prev, [key]: { columns: filtered, indexes, keys, triggers, loading: false } }));
    } catch (err) {
      setTableChildren((prev) => ({ ...prev, [key]: { columns: [], indexes: [], keys: [], triggers: [], loading: false, error: (err as Error).message } }));
    }
  }, [connection?.id]);

  // Reload the whole live tree (schemas/databases/columns) and drop the per-table
  // children cache — used by the connection/database/schema inline refresh buttons.
  const reloadTree = useCallback(() => {
    if (connection?.id) void refreshSchemas(connection.id);
    setTableChildren({});
  }, [connection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear cached children whenever the connection/database changes.
  useEffect(() => { setTableChildren({}); }, [connection?.id]);

  /* ===== Object actions (DDL viewer / generate / rename / drop) ===== */
  const openStructureTab = useCallback((schema: string, objectName: string, kind: SQLSchemaObjectKind) => {
    const id = `s:${schema}.${objectName}`;
    if (tabs.some((t) => t.id === id)) { setActiveTabId(id); return; }
    const tab: SQLStructureTab = {
      id, type: 'structure', title: `${objectName} (structure)`, schema, objectName, kind,
      savedConnectionId: selectedSavedId, database: selectedDatabase,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }, [tabs, selectedSavedId, selectedDatabase]);

  const openDdlTab = useCallback(async (schema: string, objectName: string, kind: SQLSchemaObjectKind) => {
    const tab = openQueryTab(`-- Loading DDL for ${schema}.${objectName}…`);
    setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, title: `${objectName} DDL`, readOnly: true } : t));
    const connId = await ensureConnectionForTab(tab);
    let ddlText = `-- Could not resolve a connection`;
    if (connId) {
      try {
        const r = await window.electronAPI.sqlGetDdl(connId, schema, objectName, kind);
        ddlText = r.ddl || `-- No DDL available for ${schema}.${objectName}`;
      } catch (err) {
        ddlText = `-- Failed to load DDL: ${(err as Error).message}`;
      }
    }
    const model = modelsRef.current.get(tab.id);
    if (model) model.setValue(ddlText);
    else setTabs((prev) => prev.map((t) => t.id === tab.id && t.type === 'query' ? { ...t, query: ddlText } : t));
  }, [openQueryTab, ensureConnectionForTab]);

  const generateSelect = useCallback((schema: string, name: string) => {
    const n = quoteIdent(name, activeDialect);
    const ref = activeCaps.supportsSchemas ? `${quoteIdent(schema, activeDialect)}.${n}` : n;
    openQueryTab(`SELECT * FROM ${ref} LIMIT 100;`);
  }, [openQueryTab, activeDialect, activeCaps.supportsSchemas]);

  const generateInsert = useCallback((schema: string, name: string) => {
    const n = quoteIdent(name, activeDialect);
    const ref = activeCaps.supportsSchemas ? `${quoteIdent(schema, activeDialect)}.${n}` : n;
    const cols = columnsRef.current.filter((c) => c.schema === schema && c.table === name);
    const colList = cols.length ? cols.map((c) => quoteIdent(c.column, activeDialect)).join(', ') : '/* columns */';
    const valList = cols.length ? cols.map(() => '?').join(', ') : '/* values */';
    openQueryTab(`INSERT INTO ${ref} (${colList})\nVALUES (${valList});`);
  }, [openQueryTab, activeDialect, activeCaps.supportsSchemas]);

  const refreshAfterMutation = useCallback(async () => {
    if (connection?.id) await refreshSchemas(connection.id);
    setTableChildren({});
  }, [connection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRename = useCallback(async (schema: string, name: string, kind: SQLSchemaObjectKind, newName: string) => {
    if (!connection?.id) { setActionError('Not connected'); return; }
    const trimmed = newName.trim();
    if (!trimmed || trimmed === name) { setActionDialog(null); return; }
    try {
      await window.electronAPI.sqlRenameObject(connection.id, kind, schema, name, trimmed);
      setActionDialog(null);
      setActionError('');
      await refreshAfterMutation();
    } catch (err) { setActionError((err as Error).message); }
  }, [connection?.id, refreshAfterMutation]);

  const handleDrop = useCallback(async (schema: string, name: string, kind: SQLSchemaObjectKind, cascade: boolean) => {
    if (!connection?.id) { setActionError('Not connected'); return; }
    try {
      await window.electronAPI.sqlDropObject(connection.id, kind, schema, name, { cascade });
      setActionDialog(null);
      setActionError('');
      await refreshAfterMutation();
    } catch (err) { setActionError((err as Error).message); }
  }, [connection?.id, refreshAfterMutation]);

  /* ===== Export / Import ===== */
  // Open the export dialog seeded with the active tab's loaded grid + (table tabs)
  // its source-table ref so a full-table export is offered.
  const openExportDialog = useCallback(() => {
    if (!activeTab) return;
    const rt = getRuntime(activeTab.id);
    const result = rt.result;
    const columns = result?.columns ?? [];
    const table = activeTab.type === 'table'
      ? { schema: (activeTab as SQLTableTab).schema, name: (activeTab as SQLTableTab).objectName }
      : undefined;
    setExportError('');
    setExportDialog({
      columns,
      rowCount: result?.rows.length ?? 0,
      table,
      connectionId: connection?.id ?? null,
      dialect: activeDialect,
    });
  }, [activeTab, getRuntime, connection?.id, activeDialect]);

  const handleExportConfirm = useCallback(async (req: ExportRequest) => {
    if (!exportDialog) return;
    setExportBusy(true);
    setExportError('');
    try {
      const rt = activeTab ? getRuntime(activeTab.id) : null;
      const res = await window.electronAPI.sqlExport(exportDialog.connectionId, {
        format: req.format,
        scope: req.scope,
        filePath: '', // empty → main shows a Save dialog
        includeHeaders: req.includeHeaders,
        delimiter: req.delimiter,
        nullText: req.nullText,
        sqlTableName: req.sqlTableName,
        dialect: exportDialog.dialect,
        table: exportDialog.table,
        // current-view scope: pass the loaded grid rows inline.
        columns: req.scope === 'current' ? (rt?.result?.columns ?? exportDialog.columns) : undefined,
        rows: req.scope === 'current' ? (rt?.result?.rows ?? []) : undefined,
      });
      if (res.ok) {
        setExportDialog(null);
        setToast(`Exported ${res.rowCount} rows → ${res.filePath}`);
        setTimeout(() => setToast(''), 5000);
      }
    } catch (err) {
      setExportError((err as Error).message || 'Export failed');
    } finally {
      setExportBusy(false);
    }
  }, [exportDialog, activeTab, getRuntime]);

  const copyContextForActive = useMemo(() => {
    if (activeTab?.type === 'table') {
      const t = activeTab as SQLTableTab;
      return { schema: t.schema, table: t.objectName, dialect: activeDialect };
    }
    return undefined;
  }, [activeTab, activeDialect]);

  /* ===== Persist state ===== */
  useEffect(() => {
    if (!onStateChange) return;
    const payload: SQLContainerState = {
      connectionId: connection?.id ?? null,
      savedConnectionId: selectedSavedId,
      connectionName: selectedConnection?.label ?? 'SQL',
      host: selectedConnection?.host ?? '127.0.0.1',
      port: selectedConnection?.port ?? 5432,
      user: selectedConnection?.user ?? 'postgres',
      database: selectedDatabase || selectedConnection?.database || 'postgres',
      schema: selectedSchema || 'public',
      ssl: selectedConnection?.ssl ?? false,
      tabs: tabs.map((t) => {
        if (t.type === 'query') {
          const model = modelsRef.current.get(t.id);
          return { ...t, query: model?.getValue() ?? t.query };
        }
        return t;
      }),
      activeTabId,
      history,
      favorites,
      treeWidth: treeSplit.size,
      editorHeight: editorSplit.size,
    };
    const s = JSON.stringify(payload);
    if (s === lastPersisted.current) return;
    lastPersisted.current = s;
    onStateChange(payload);
  }, [connection?.id, selectedSavedId, selectedConnection, selectedDatabase, selectedSchema, tabs, activeTabId, history, favorites, treeSplit.size, editorSplit.size, onStateChange]);

  /* ===== History & favorites actions ===== */
  const loadQueryIntoEditor = useCallback((query: string) => {
    // Load into the active query tab's model (or open a new one).
    let tab = activeTab && activeTab.type === 'query' ? activeTab : null;
    if (!tab) tab = openQueryTab(query);
    else {
      const model = modelsRef.current.get(tab.id);
      if (model) model.setValue(query);
      else setTabs((prev) => prev.map((t) => t.id === tab!.id && t.type === 'query' ? { ...t, query } : t));
    }
    return tab;
  }, [activeTab, openQueryTab]);

  const handleHistoryRun = useCallback(async (query: string) => {
    const tab = loadQueryIntoEditor(query);
    setActiveTabId(tab.id);
    // Defer so the model is mounted before running.
    setTimeout(() => { void runStatements(tab.id, splitSqlStatements(query)); }, 0);
  }, [loadQueryIntoEditor, runStatements]);

  const handleSaveFavorite = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const name = trimmed.replace(/\s+/g, ' ').slice(0, 48);
    setFavorites((prev) => [{ id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, query: trimmed, createdAt: Date.now() }, ...prev]);
  }, []);

  const handleDeleteFavorite = useCallback((id: string) => {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /* ===== Agent SQL bridge: imperative handle ===== */
  // Expose this live instance to useSqlAgentBridge via the registry so an agent's
  // commands run through the SAME handlers as the user's clicks and the results
  // surface in the panel (tabs/grid). A ref holds the current implementations so
  // the registered handle (registered once, keyed by containerId) never goes
  // stale across re-renders.
  const handleImplRef = useRef<SqlWorkbenchHandle | null>(null);

  const buildPanelInfo = useCallback((): SqlPanelInfo => ({
    connected: !!connection?.id,
    connectionName: selectedConnection?.label ?? null,
    savedConnectionId: selectedSavedId,
    dialect: activeDialect,
    database: selectedDatabase || connection?.database || null,
    schema: activeCaps.supportsSchemas ? (selectedSchema || null) : null,
    supportsSchemas: activeCaps.supportsSchemas,
  }), [connection?.id, connection?.database, selectedConnection, selectedSavedId, activeDialect, selectedDatabase, activeCaps.supportsSchemas, selectedSchema]);

  // Match a saved connection by id, exact label, then substring (forgiving, like
  // the terminal bridge's `open ssh <name>`).
  const findSaved = useCallback((nameOrId: string) => {
    const q = nameOrId.trim().toLowerCase();
    return savedConnections.find((c) => c.id === nameOrId)
      ?? savedConnections.find((c) => c.label.toLowerCase() === q)
      ?? savedConnections.find((c) => c.label.toLowerCase().includes(q))
      ?? null;
  }, [savedConnections]);

  // Run SQL and surface it: load it into (or open) a query tab, then run it
  // through the existing runStatements path so results render. Returns the last
  // statement's result for the agent.
  const runQueryForAgent = useCallback(async (sql: string): Promise<SQLQueryResult> => {
    const tab = loadQueryIntoEditor(sql);
    setActiveTabId(tab.id);
    const stmts = splitSqlStatements(sql);
    await runStatements(tab.id, stmts);
    const rt = getRuntime(tab.id);
    if (rt.error && !rt.result) throw new Error(rt.error);
    if (!rt.result) throw new Error('No result');
    return rt.result;
  }, [loadQueryIntoEditor, runStatements, getRuntime]);

  // EXPLAIN (read) the SQL directly through the driver and surface it in a query
  // tab. Returns the raw plan result. (Dialect-specific EXPLAIN prefix mirrors
  // handleExplain's non-analyze branch.)
  const explainForAgent = useCallback(async (sql: string): Promise<SQLQueryResult> => {
    const stripped = sql.trim().replace(/;\s*$/, '');
    const explainSql = activeDialect === 'postgres'
      ? `EXPLAIN (FORMAT JSON) ${stripped}`
      : `EXPLAIN ${stripped}`;
    return runQueryForAgent(explainSql);
  }, [activeDialect, runQueryForAgent]);

  handleImplRef.current = {
    getInfo: () => buildPanelInfo(),
    listConnections: (): SqlConnectionSummary[] => savedConnections.map((c) => ({
      id: c.id, label: c.label, dialect: c.dialect, host: c.host, port: c.port, database: c.database,
    })),
    useConnection: async (nameOrId, database) => {
      const saved = findSaved(nameOrId);
      if (!saved) throw new Error(`no saved connection matches "${nameOrId}"`);
      await handleConnectionSelect(saved.id);
      if (database) await handleDatabaseSelect(database);
      return buildPanelInfo();
    },
    listTables: (schema): SqlTableSummary[] => {
      const wanted = schema ?? (activeCaps.supportsSchemas ? selectedSchema : undefined);
      const out: SqlTableSummary[] = [];
      for (const s of schemasRef.current) {
        if (wanted && s.schema !== wanted) continue;
        for (const cat of s.categories) {
          if (!['table', 'view', 'materializedView', 'foreignTable'].includes(cat.kind)) continue;
          for (const obj of cat.objects) {
            out.push({ schema: s.schema, name: obj.name, kind: cat.kind, rowEstimate: obj.rowEstimate });
          }
        }
      }
      return out;
    },
    listColumns: async (table, schema): Promise<SqlColumnSummary[]> => {
      const sch = schema ?? (activeCaps.supportsSchemas ? selectedSchema : '');
      const cols = columnsRef.current.filter((c) => c.table === table && (!sch || c.schema === sch));
      let pk: string[] = [];
      if (connection?.id) {
        try { pk = await window.electronAPI.sqlGetPrimaryKey(connection.id, sch || cols[0]?.schema || '', table); } catch { pk = []; }
      }
      return cols.map((c) => ({
        column: c.column,
        dataType: c.dataType ?? '',
        nullable: c.isNullable ?? true,
        primaryKey: c.isPrimaryKey ?? pk.includes(c.column),
      }));
    },
    getDdl: async (table, schema) => {
      if (!connection?.id) throw new Error('not connected');
      const sch = schema ?? (activeCaps.supportsSchemas ? selectedSchema : 'public');
      const r = await window.electronAPI.sqlGetDdl(connection.id, sch, table, 'table');
      return r.ddl || '';
    },
    runQuery: (sql) => runQueryForAgent(sql),
    explain: (sql) => explainForAgent(sql),
    exportTable: async (table, format, filePath, schema) => {
      if (!connection?.id) throw new Error('not connected');
      const sch = schema ?? (activeCaps.supportsSchemas ? selectedSchema : 'public');
      const res = await window.electronAPI.sqlExport(connection.id, {
        format, scope: 'full', filePath, includeHeaders: true,
        dialect: activeDialect, table: { schema: sch, name: table },
        sqlTableName: table,
      });
      return { rowCount: res.rowCount, filePath: res.filePath };
    },
    importCsv: async (table, csvPath, schema) => {
      if (!connection?.id) throw new Error('not connected');
      const sch = schema ?? (activeCaps.supportsSchemas ? selectedSchema : 'public');
      const text = await window.electronAPI.readFile(csvPath);
      const delimiter = detectCsvDelimiter(text);
      const matrix = parseCsv(text, delimiter);
      if (matrix.length < 1) throw new Error('CSV is empty');
      const headers = matrix[0];
      const dataRows = matrix.slice(1);
      const rows: unknown[][] = dataRows.map((r) => headers.map((_h, i) => r[i] ?? ''));
      const res = await window.electronAPI.sqlImportRows(connection.id, {
        schema: sch, table, columns: headers, rows,
      });
      // Reload the table tab if it's open so the import surfaces.
      const tabId = makeTableTabId(sch, table);
      if (tabs.some((t) => t.id === tabId)) {
        const tab = tabs.find((t) => t.id === tabId) as SQLTableTab;
        void loadTableData(tab);
      }
      return { imported: res.imported };
    },
  };

  useEffect(() => {
    if (!containerId) return;
    const handle: SqlWorkbenchHandle = {
      getInfo: () => handleImplRef.current!.getInfo(),
      listConnections: () => handleImplRef.current!.listConnections(),
      useConnection: (n, d) => handleImplRef.current!.useConnection(n, d),
      listTables: (s) => handleImplRef.current!.listTables(s),
      listColumns: (t, s) => handleImplRef.current!.listColumns(t, s),
      getDdl: (t, s) => handleImplRef.current!.getDdl(t, s),
      runQuery: (sql) => handleImplRef.current!.runQuery(sql),
      explain: (sql) => handleImplRef.current!.explain(sql),
      exportTable: (t, f, p, s) => handleImplRef.current!.exportTable(t, f, p, s),
      importCsv: (t, p, s) => handleImplRef.current!.importCsv(t, p, s),
    };
    registerSqlWorkbench(containerId, handle);
    return () => unregisterSqlWorkbench(containerId);
  }, [containerId]);

  /* ============ Right panel content ============ */
  const isQueryTab = activeTab?.type === 'query';
  const isTableTab = activeTab?.type === 'table';
  const isStructureTab = activeTab?.type === 'structure';
  const activeRt = activeTab ? getRuntime(activeTab.id) : null;
  const hasQueryResults = isQueryTab && (activeRt?.result || activeRt?.error || (activeRt?.outcomes.length ?? 0) > 0 || activeRt?.explain);

  // The active tab's target connection, and whether it is the currently-live one.
  // Query features are blocked unless the selected connection is actually active.
  const activeTabSavedId = activeTab?.savedConnectionId ?? selectedSavedId;
  const activeConnLive = !!connection && !connecting && connectedSavedId === activeTabSavedId;
  activeConnLiveRef.current = activeConnLive;

  /* ============ Main layout ============ */
  return (
    <div
      className="sql-workbench"
      style={{ fontSize: `${uiFontSize}px`, '--sql-font-size': `${uiFontSize}px` } as React.CSSProperties}
    >
      {/* Title bar */}
      <div className="container-drag-handle sql-titlebar">
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onClose} title="Close" className="sql-close-dot" />
        <span className="sql-title-label">
          SQL Explorer{connection ? ` — ${connection.database}@${connection.host}` : ''}
        </span>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitRight} title="Split right" className="sql-titlebar-btn">
          <SplitHorizontalIcon size={14} />
        </button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitDown} title="Split down" className="sql-titlebar-btn">
          <SplitVerticalIcon size={14} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* ========= Left panel — tree ========= */}
        <div style={{ width: treeSplit.size, flexShrink: 0, minWidth: 0, borderRight: '1px solid var(--border)' }}>
          <ConnectionTree
            savedConnections={savedConnections}
            selectedSavedId={selectedSavedId}
            connectedSavedId={connectedSavedId}
            connection={connection}
            databases={databases}
            schemas={schemas}
            expandedNodes={expandedNodes}
            loadingSchemas={loadingSchemas}
            treeFilter={treeFilter}
            failedConnectionIds={failedConnectionIds}
            connError={connError}
            activePath={activePath}
            treeListRef={treeListRef}
            onFilterChange={setTreeFilter}
            onAddConnection={openAddDialog}
            onRefresh={() => void refreshSaved()}
            onReloadTree={reloadTree}
            onReloadTable={(schema, table) => void reloadTableChildren(schema, table)}
            setSelectedSavedId={setSelectedSavedId}
            toggle={toggle}
            setExpandedNodes={setExpandedNodes}
            onContextMenu={(x, y, connectionId) => setContextMenu({ x, y, connectionId })}
            onConnectSelected={(id) => void handleConnectSelected(id)}
            onDisconnect={() => void handleDisconnect()}
            onObjectClick={handleTreeObjectClick}
            onObjectContextMenu={(x, y, schema, name, kind) => setObjMenu({ x, y, schema, name, kind })}
            tableChildren={tableChildren}
            onExpandTable={(schema, table) => void handleExpandTable(schema, table)}
          />
        </div>

        {/* Tree splitter */}
        <div className="sql-splitter sql-splitter-v" onMouseDown={treeSplit.onMouseDown} title="Drag to resize" />

        {/* ========= Right panel — tabs + content ========= */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <SqlTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={setActiveTabId}
            onClose={closeTab}
            onNewQuery={() => openQueryTab()}
            onCloseOthers={closeOtherTabs}
            onCloseAll={closeAllTabs}
          />

          {/* Empty state */}
          {!activeTab && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Open a table from the tree or create a new query tab
            </div>
          )}

          {/* Query tab: editor (always mounted for Monaco) + results split */}
          <div style={{ flex: 1, minHeight: 0, display: isQueryTab ? 'flex' : 'none', flexDirection: 'row' }}>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: hasQueryResults ? undefined : 1, height: hasQueryResults ? editorSplit.size : undefined, minHeight: 100 }}>
                <EditorPane
                  editorHostRef={editorHostRef}
                  executing={!!activeRt?.executing}
                  canRun={activeConnLive}
                  onRunStatement={() => void handleRunStatement()}
                  onRunAll={() => void handleRunAll()}
                  onFormat={handleFormat}
                  onExplain={() => void handleExplain(false)}
                  onExplainAnalyze={() => void handleExplain(true)}
                  supportsExplainAnalyze={activeCaps.supportsExplainAnalyze}
                  onToggleHistory={() => setShowHistory((v) => !v)}
                  historyOpen={showHistory}
                  leading={(activeCaps.supportsMultipleDatabases || activeCaps.supportsSchemas) ? (
                    <>
                      <SqlContextSelect
                        connections={connectedSavedId && connection
                          ? savedConnections.filter((c) => c.id === connectedSavedId).map((c) => ({ id: c.id, label: c.label, dialect: c.dialect }))
                          : []}
                        connectionId={selectedSavedId ?? ''}
                        connectionLabel={selectedConnection?.label ?? ''}
                        connected={activeConnLive}
                        showDatabase={activeCaps.supportsMultipleDatabases}
                        showSchema={activeCaps.supportsSchemas}
                        database={selectedDatabase}
                        schema={selectedSchema}
                        activeConnId={connectedSavedId ?? ''}
                        activeDatabases={databases.map((db) => db.name)}
                        activeDatabase={selectedDatabase}
                        activeSchemas={schemas.map((s) => s.schema)}
                        loadSchemas={loadSchemasForDatabase}
                        onPick={(connId, db, sch) => { void pickContext(connId, db, sch); }}
                      />
                      {reconnectState.targetSavedId && reconnectState.attempt > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--accent-yellow)' }}>
                          Reconnect {reconnectState.attempt}/{reconnectState.maxAttempts}
                        </span>
                      )}
                    </>
                  ) : undefined}
                />
              </div>
              {hasQueryResults && (
                <>
                  <div className="sql-splitter sql-splitter-h" onMouseDown={editorSplit.onMouseDown} title="Drag to resize" />
                  <ResultsPane
                    result={activeRt?.result ?? null}
                    error={activeRt?.error ?? ''}
                    executing={!!activeRt?.executing}
                    outcomes={activeRt?.outcomes}
                    explain={activeRt?.explain ?? null}
                    onExport={openExportDialog}
                    onRefresh={activeTab ? () => refreshQuery(activeTab.id) : undefined}
                    uiScale={uiScale}
                  />
                </>
              )}
            </div>
            {showHistory && (
              <HistoryPanel
                history={history}
                favorites={favorites}
                onClose={() => setShowHistory(false)}
                onLoad={(q) => loadQueryIntoEditor(q)}
                onRun={(q) => void handleHistoryRun(q)}
                onSaveFavorite={handleSaveFavorite}
                onDeleteFavorite={handleDeleteFavorite}
                onClearHistory={() => setHistory([])}
                onSaveCurrent={() => { const ctx = getActiveModelValue(); if (ctx?.sql.trim()) handleSaveFavorite(ctx.sql); }}
              />
            )}
          </div>

          {/* Table tab: DataGrid full height */}
          {isTableTab && activeTab.type === 'table' && activeRt && (() => {
            const tableTab = activeTab as SQLTableTab;
            const pk = tablePks[tableTab.id];
            // Build the editable config once a PK has been resolved AND we have a
            // live connection (matching whatever the grid is showing).
            const editConfig: DataGridEditConfig | undefined = pk !== undefined && connection?.id ? {
              schema: tableTab.schema,
              table: tableTab.objectName,
              primaryKey: pk,
              columnsMeta: columns.filter((c) => c.schema === tableTab.schema && c.table === tableTab.objectName),
              dialect: activeDialect,
              onApplyEdits: async (changes) => {
                await window.electronAPI.sqlApplyEdits(connection!.id, changes);
              },
              onReload: () => { void loadTableData(tableTab); },
            } : undefined;
            return (
              <ResultsPane
                result={activeRt.result ?? null}
                error={activeRt.error}
                executing={activeRt.executing}
                table={{
                  totalEstimate: activeRt.totalEstimate,
                  page: activeRt.page,
                  pageSize: activeRt.pageSize,
                  sortColumn: activeRt.sortColumn,
                  sortDirection: activeRt.sortDirection,
                  onSort: (col, dir) => void loadTableData(tableTab, { sortColumn: col, sortDirection: dir, page: 0 }),
                  onPageChange: (p) => void loadTableData(tableTab, { page: p }),
                  onPageSizeChange: (s) => void loadTableData(tableTab, { pageSize: s, page: 0 }),
                  filters: activeRt.filters,
                  onFilterChange: (f) => void loadTableData(tableTab, { filters: f, page: 0 }),
                  edit: editConfig,
                }}
                copyContext={copyContextForActive}
                onExport={openExportDialog}
                onRefresh={() => void loadTableData(tableTab)}
                uiScale={uiScale}
              />
            );
          })()}

          {/* Structure tab: read-only object inspector */}
          {isStructureTab && activeTab.type === 'structure' && (
            <ObjectEditor
              schema={activeTab.schema}
              objectName={activeTab.objectName}
              connectionId={connection?.id ?? null}
              columns={columns.filter((c) => c.schema === activeTab.schema && c.table === activeTab.objectName)}
            />
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2500 }} onClick={() => setContextMenu(null)}>
          <div className="sql-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setSelectedSavedId(contextMenu.connectionId); connectedSavedId === contextMenu.connectionId ? void handleDisconnect() : void handleConnectSelected(contextMenu.connectionId); setContextMenu(null); }}>
              {connectedSavedId === contextMenu.connectionId ? 'Disconnect' : 'Connect'}
            </button>
            <button onClick={() => {
              const t = savedConnections.find((c) => c.id === contextMenu.connectionId);
              if (t) {
                setEditingConnectionId(null);
                setDialogForm({
                  label: `${t.label} copy`, dialect: t.dialect, host: t.host, port: t.port,
                  user: t.user, password: '', database: t.database, ssl: t.ssl, filePath: t.filePath ?? '',
                });
                setDialogError('');
                setShowConnectionDialog(true);
              }
              setContextMenu(null);
            }}>Duplicate</button>
            <button onClick={() => {
              const t = savedConnections.find((c) => c.id === contextMenu.connectionId);
              if (t) {
                setEditingConnectionId(t.id);
                setDialogForm({
                  label: t.label, dialect: t.dialect, host: t.host, port: t.port,
                  user: t.user, password: '', database: t.database, ssl: t.ssl, filePath: t.filePath ?? '',
                });
                setDialogError('');
                setShowConnectionDialog(true);
              }
              setContextMenu(null);
            }}>Rename / Edit</button>
            <button className="danger" onClick={() => { setSelectedSavedId(contextMenu.connectionId); void handleDeleteSelected(contextMenu.connectionId); setContextMenu(null); }}>Delete</button>
          </div>
        </div>
      )}

      {/* Object context menu (right-click table/view/object in tree) */}
      {objMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2500 }} onClick={() => setObjMenu(null)}>
          <div className="sql-context-menu" style={{ left: objMenu.x, top: objMenu.y }} onClick={(e) => e.stopPropagation()}>
            {(objMenu.kind === 'table' || objMenu.kind === 'view' || objMenu.kind === 'materializedView' || objMenu.kind === 'foreignTable') && (
              <>
                <button onClick={() => { handleTreeObjectClick(objMenu.schema, objMenu.name, objMenu.kind); setObjMenu(null); }}>Open Data</button>
                <button onClick={() => { openStructureTab(objMenu.schema, objMenu.name, objMenu.kind); setObjMenu(null); }}>Structure</button>
                <button onClick={() => { generateSelect(objMenu.schema, objMenu.name); setObjMenu(null); }}>Generate SELECT</button>
                <button onClick={() => { generateInsert(objMenu.schema, objMenu.name); setObjMenu(null); }}>Generate INSERT</button>
                <button onClick={() => {
                  setExportError('');
                  setExportDialog({
                    columns: [],
                    rowCount: 0,
                    table: { schema: objMenu.schema, name: objMenu.name },
                    connectionId: connection?.id ?? null,
                    dialect: activeDialect,
                  });
                  setObjMenu(null);
                }}>Export Data…</button>
                {objMenu.kind === 'table' && (
                  <button onClick={() => { setImportDialog({ schema: objMenu.schema, table: objMenu.name }); setObjMenu(null); }}>Import CSV…</button>
                )}
              </>
            )}
            <button onClick={() => { void openDdlTab(objMenu.schema, objMenu.name, objMenu.kind); setObjMenu(null); }}>View DDL</button>
            <button onClick={() => { void window.electronAPI.clipboardWriteText(objMenu.name); setObjMenu(null); }}>Copy Name</button>
            <button onClick={() => { setActionError(''); setActionDialog({ mode: 'rename', schema: objMenu.schema, name: objMenu.name, kind: objMenu.kind, value: objMenu.name }); setObjMenu(null); }}>Rename…</button>
            <button className="danger" onClick={() => { setActionError(''); setActionDialog({ mode: 'drop', schema: objMenu.schema, name: objMenu.name, kind: objMenu.kind, cascade: false }); setObjMenu(null); }}>Drop…</button>
          </div>
        </div>
      )}

      {/* Rename / Drop confirmation dialog */}
      {actionDialog && (
        <div className="sql-modal-backdrop" onClick={() => { setActionDialog(null); setActionError(''); }}>
          <div className="sql-modal" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            {actionDialog.mode === 'rename' ? (
              <>
                <div className="sql-modal-title">Rename {actionDialog.kind}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{actionDialog.schema}.{actionDialog.name}</div>
                <input
                  autoFocus
                  value={actionDialog.value}
                  onChange={(e) => setActionDialog({ ...actionDialog, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(actionDialog.schema, actionDialog.name, actionDialog.kind, actionDialog.value); }}
                  style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', boxSizing: 'border-box' }}
                />
                {actionError && <div style={{ color: 'var(--accent-red)', fontSize: 12, marginTop: 8 }}>{actionError}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="sql-btn" onClick={() => { setActionDialog(null); setActionError(''); }}>Cancel</button>
                  <button className="sql-btn primary" onClick={() => void handleRename(actionDialog.schema, actionDialog.name, actionDialog.kind, actionDialog.value)}>Rename</button>
                </div>
              </>
            ) : (
              <>
                <div className="sql-modal-title">Drop {actionDialog.kind}</div>
                <div style={{ fontSize: 13, margin: '8px 0' }}>
                  This will permanently drop <strong>{actionDialog.schema}.{actionDialog.name}</strong>. This cannot be undone.
                </div>
                {activeCaps.dialect === 'postgres' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={actionDialog.cascade} onChange={(e) => setActionDialog({ ...actionDialog, cascade: e.target.checked })} />
                    Cascade (drop dependent objects)
                  </label>
                )}
                {actionError && <div style={{ color: 'var(--accent-red)', fontSize: 12, marginTop: 8 }}>{actionError}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="sql-btn" onClick={() => { setActionDialog(null); setActionError(''); }}>Cancel</button>
                  <button className="sql-btn danger" onClick={() => void handleDrop(actionDialog.schema, actionDialog.name, actionDialog.kind, actionDialog.cascade)}>Drop</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Connection wizard */}
      {showConnectionDialog && (
        <ConnectionDialog
          editing={!!editingConnectionId}
          initial={dialogForm}
          error={dialogError}
          onCancel={() => { setShowConnectionDialog(false); setEditingConnectionId(null); setDialogError(''); }}
          onSave={handleSaveConnection}
        />
      )}

      {/* Export dialog */}
      {exportDialog && (
        <ExportDialog
          info={exportDialog}
          busy={exportBusy}
          error={exportError}
          onCancel={() => { if (!exportBusy) { setExportDialog(null); setExportError(''); } }}
          onConfirm={(req) => void handleExportConfirm(req)}
        />
      )}

      {/* Import dialog (table tabs / object menu) */}
      {importDialog && connection?.id && (
        <ImportDialog
          connectionId={connection.id}
          schema={importDialog.schema}
          table={importDialog.table}
          targetColumns={columns.filter((c) => c.schema === importDialog.schema && c.table === importDialog.table)}
          onCancel={() => setImportDialog(null)}
          onDone={(imported) => {
            setToast(`Imported ${imported} rows into ${importDialog.table}`);
            setTimeout(() => setToast(''), 5000);
            // Reload the open table tab if it matches.
            const tab = tabs.find((t) => t.id === makeTableTabId(importDialog.schema, importDialog.table));
            if (tab && tab.type === 'table') void loadTableData(tab as SQLTableTab);
            setImportDialog(null);
          }}
        />
      )}

      {/* Transient success toast */}
      {toast && (
        <div className="sql-export-toast" onClick={() => setToast('')}>{toast}</div>
      )}
    </div>
  );
};

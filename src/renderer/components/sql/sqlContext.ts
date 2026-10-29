// Pure rules for the SQL pane's query context (connection ▸ database ▸ schema).
// Kept out of SqlWorkbench so the "which database do we actually connect to"
// decisions are testable — getting them wrong is what made a pane re-use the
// previously selected database name for every new connection.

/** Schemas as the tree reports them (only the two fields these rules need). */
export interface SchemaChoice {
  schema: string;
  isDefault?: boolean;
}

export interface ContextSelection {
  /** Connection the pane is pointed at (may not be the live one). */
  selectedSavedId: string | null;
  /** Connection that is actually live, if any. */
  connectedSavedId: string | null;
  /** Whether a live connection exists at all. */
  connected: boolean;
  database: string;
  schema: string;
}

export type ContextPlan =
  | { action: 'connect'; savedId: string; database: string | null; schema: string | null }
  | { action: 'schema'; schema: string }
  | { action: 'none' };

/**
 * The database a connect should target: an explicit request wins, otherwise the
 * TARGET connection's own saved database. Deliberately never falls back to the
 * pane's current selection — that is how connecting to a second server ended up
 * opening (or failing on) the first server's database.
 */
export function resolveTargetDatabase(
  requested: string | null | undefined,
  savedDatabase: string | null | undefined,
): string {
  return (requested ?? '').trim() || (savedDatabase ?? '').trim();
}

/**
 * The schema to select in a database that was just opened. A preference (the
 * user's pick, or a tab's recorded schema) is honoured only when that schema
 * exists here; otherwise the database's own default is used. Returns '' when
 * the dialect/database has no schemas.
 */
export function resolveSchema(available: SchemaChoice[], preferred?: string | null): string {
  if (preferred && available.some((s) => s.schema === preferred)) return preferred;
  return available.find((s) => s.isDefault)?.schema ?? available[0]?.schema ?? '';
}

/**
 * Turn a cascade pick (connection ▸ database ▸ schema; empty parts mean "keep")
 * into a single action. Switching connection or database is ONE connect that
 * carries the picked schema — connecting twice, or applying the schema after
 * the reconnect, loses the pick.
 */
export function planContextPick(
  pick: { connectionId: string; database: string; schema: string },
  current: ContextSelection,
): ContextPlan {
  const savedId = pick.connectionId || current.selectedSavedId;
  if (!savedId) return { action: 'none' };

  const switchingConnection = savedId !== current.connectedSavedId || !current.connected;
  if (switchingConnection || (pick.database && pick.database !== current.database)) {
    return {
      action: 'connect',
      savedId,
      // No database picked while switching connection → let the target
      // connection's own saved database decide.
      database: pick.database || (switchingConnection ? null : current.database),
      schema: pick.schema || null,
    };
  }
  if (pick.schema && pick.schema !== current.schema) return { action: 'schema', schema: pick.schema };
  return { action: 'none' };
}

/**
 * Tab id for a table/structure tab. Scoped to the connection + database it was
 * opened from: the same `schema.table` exists in other databases, so a bare
 * `t:schema.table` id made switching database reuse — and keep showing — the
 * previous database's tab.
 */
export function makeObjectTabId(
  prefix: 't' | 's',
  savedId: string | null,
  database: string,
  schema: string,
  name: string,
): string {
  return `${prefix}:${savedId ?? ''}:${database}:${schema}.${name}`;
}

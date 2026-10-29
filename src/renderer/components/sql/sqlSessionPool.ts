import type { SQLConnectionInfo } from '../../../shared/types';

// Keeps the SQL pane's backend sessions alive across UI switches. Moving between
// databases or connections used to disconnect the previous session and open a
// brand-new one every time — slow, and it dropped anything session-scoped (temp
// tables, `SET`s, an open transaction). The pool hands the same session back
// instead, and only ever closes one on an explicit disconnect/delete, on
// eviction, or when the pane goes away.

/** Identifies one (saved connection, database) pair. */
export function sessionKey(savedId: string, database?: string | null): string {
  return `${savedId}::${(database ?? '').trim()}`;
}

export interface PooledSession {
  savedId: string;
  /** The database the server actually opened for this session. */
  database: string;
  info: SQLConnectionInfo;
  /** Monotonic use stamp; the eviction victim is the lowest. */
  lastUsed: number;
}

export interface SqlSessionPoolDeps {
  connect(savedId: string, database: string | null): Promise<SQLConnectionInfo>;
  disconnect(connectionId: string): Promise<void>;
  /** How many sessions stay warm at once (default DEFAULT_SESSION_LIMIT). */
  limit?: number;
}

/** Warm sessions per pane. Enough to flip between a few databases without ever
 * reconnecting, low enough not to sit on a pile of idle server connections. */
export const DEFAULT_SESSION_LIMIT = 6;

export class SqlSessionPool {
  private byKey = new Map<string, PooledSession>();
  private inflight = new Map<string, Promise<SQLConnectionInfo>>();
  private clock = 0;
  private protectedId: string | null = null;
  private readonly limit: number;

  constructor(private readonly deps: SqlSessionPoolDeps) {
    this.limit = Math.max(1, deps.limit ?? DEFAULT_SESSION_LIMIT);
  }

  /** Distinct open sessions, most-recently-used first. */
  list(): PooledSession[] {
    const distinct = new Map<string, PooledSession>();
    for (const session of this.byKey.values()) distinct.set(session.info.id, session);
    return [...distinct.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** The already-open session for this pair, without opening one. */
  peek(savedId: string, database?: string | null): SQLConnectionInfo | null {
    return this.byKey.get(sessionKey(savedId, database))?.info ?? null;
  }

  /** Mark the session the pane is currently showing — it is never evicted. */
  protect(connectionId: string | null): void {
    this.protectedId = connectionId;
  }

  /**
   * The session for (savedId, database), opening one only if none is warm.
   * `reused` tells the caller whether it got an existing session, so a failure
   * right after can be treated as "that session died" rather than "the server
   * refused us".
   */
  async acquire(savedId: string, database?: string | null): Promise<{ info: SQLConnectionInfo; reused: boolean }> {
    const key = sessionKey(savedId, database);
    const open = this.byKey.get(key);
    if (open) {
      open.lastUsed = ++this.clock;
      return { info: open.info, reused: true };
    }
    // Hovering the context cascade asks for the same database several times;
    // share the in-flight connect instead of opening a session per hover.
    const pending = this.inflight.get(key);
    if (pending) return { info: await pending, reused: true };

    const promise = this.deps.connect(savedId, (database ?? '').trim() || null);
    this.inflight.set(key, promise);
    let info: SQLConnectionInfo;
    try {
      info = await promise;
    } finally {
      this.inflight.delete(key);
    }
    const session: PooledSession = { savedId, database: info.database, info, lastUsed: ++this.clock };
    this.byKey.set(key, session);
    // Also reachable under the database the server actually opened, so picking
    // that database by name later reuses this session instead of opening a second.
    const realKey = sessionKey(savedId, info.database);
    if (realKey !== key) this.byKey.set(realKey, session);
    await this.evict();
    return { info, reused: false };
  }

  /** Close one session and forget every key pointing at it. */
  async drop(connectionId: string): Promise<void> {
    let found = false;
    for (const [key, session] of [...this.byKey]) {
      if (session.info.id !== connectionId) continue;
      this.byKey.delete(key);
      found = true;
    }
    if (this.protectedId === connectionId) this.protectedId = null;
    if (found) await this.deps.disconnect(connectionId).catch(() => {});
  }

  /** Close every session of one saved connection — all of its databases. */
  async dropSaved(savedId: string): Promise<void> {
    const ids = new Set([...this.byKey.values()].filter((s) => s.savedId === savedId).map((s) => s.info.id));
    for (const id of ids) await this.drop(id);
  }

  /** Close everything (the pane is going away). */
  async closeAll(): Promise<void> {
    const ids = new Set([...this.byKey.values()].map((s) => s.info.id));
    this.byKey.clear();
    this.inflight.clear();
    this.protectedId = null;
    await Promise.all([...ids].map((id) => this.deps.disconnect(id).catch(() => {})));
  }

  private async evict(): Promise<void> {
    let open = this.list();
    while (open.length > this.limit) {
      // Least recently used first, but never the one on screen.
      const victim = [...open].reverse().find((s) => s.info.id !== this.protectedId);
      if (!victim) return;
      await this.drop(victim.info.id);
      open = this.list();
    }
  }
}

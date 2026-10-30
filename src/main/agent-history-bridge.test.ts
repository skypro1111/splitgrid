import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

// The history bridge hands an agent the user's past sessions, so two things are
// pinned here: the main-side HARD-REFUSE gate (/history reuses the shared agent
// token, so without the history opt-in nothing may be read, not even help), and
// SCOPE (every query goes out with the workspace id the OWNING window reported
// for the calling terminal, never anything the agent supplied).
//
// Electron is mocked so the module loads under node. The fake window answers the
// reqId-correlated `history-agent:resolve` by invoking the captured
// `history-agent:context` listener, exactly as the preload would. The history
// service is mocked; the REAL gate setter in local-shell-manager is used.

const h = vi.hoisted(() => {
  const listeners = new Map<string, (e: unknown, payload: unknown) => void>();
  const state: {
    reply: ((terminal: string) => { ok: boolean; data?: Record<string, unknown>; error?: string }) | null;
    sent: Array<{ channel: string; payload: { reqId: string; terminal: string } }>;
  } = { reply: null, sent: [] };
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: { reqId: string; terminal: string }) => {
      state.sent.push({ channel, payload });
      const r = state.reply?.(payload.terminal);
      if (r) queueMicrotask(() => listeners.get('history-agent:context')?.({}, { reqId: payload.reqId, ...r }));
    },
  };
  const win = { isDestroyed: () => false, webContents: wc };
  return {
    listeners,
    state,
    win,
    getFocusedWindow: vi.fn((): unknown => null),
    getAllWindows: vi.fn((): unknown[] => []),
    fromWebContents: vi.fn((): unknown => win),
    fromId: vi.fn((): unknown => wc),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: h.getFocusedWindow,
    getAllWindows: h.getAllWindows,
    fromWebContents: h.fromWebContents,
  },
  webContents: { fromId: h.fromId },
  ipcMain: { on: vi.fn((ch: string, fn: (e: unknown, p: unknown) => void) => { h.listeners.set(ch, fn); }) },
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}));

const svc = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ enabled: true, progress: { state: 'idle' }, workspaces: [] })),
  estimate: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  onStatus: vi.fn(),
  search: vi.fn(async (): Promise<unknown[]> => []),
  sessionsForFile: vi.fn(async (): Promise<unknown[]> => []),
  showChunk: vi.fn(async (): Promise<unknown[]> => []),
  listSessions: vi.fn(async (): Promise<unknown[]> => []),
  why: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('./history/service', () => ({ getHistoryService: () => svc }));

import {
  processHistoryCommand, startHistoryBridge, setHistoryOwnerResolver, parseHistoryArgv, parseSince,
  executeHistoryCommand, flattenHistoryResult,
} from './agent-history-bridge';
import { setAgentHistoryEnabled } from './local-shell-manager';
import type { HistoryService } from './history/types';

const WS_DIR = path.resolve('/Users/me/project');
const OWN = { ok: true, data: { workspaceId: 'ws-own', workingDirectory: WS_DIR } };

startHistoryBridge();

describe('processHistoryCommand: main-side hard-refuse gate', () => {
  beforeEach(() => {
    h.getFocusedWindow.mockClear();
    h.getAllWindows.mockClear();
    h.fromId.mockClear();
    h.state.sent = [];
    svc.search.mockClear();
  });
  afterEach(() => setAgentHistoryEnabled(false));

  it('refuses with history_disabled while off, without touching any window or the service', async () => {
    setAgentHistoryEnabled(false);
    for (const argv of [['search', 'x'], ['help'], ['sessions'], []]) {
      const res = await processHistoryCommand('term-1', argv);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('history_disabled');
    }
    expect(h.fromId).not.toHaveBeenCalled();
    expect(h.getFocusedWindow).not.toHaveBeenCalled();
    expect(h.state.sent).toHaveLength(0);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('with the gate open, an empty command is empty_command and help needs no round-trip', async () => {
    setAgentHistoryEnabled(true);
    expect((await processHistoryCommand('term-1', [])).error).toBe('empty_command');
    const help = await processHistoryCommand('term-1', ['help']);
    expect(help.ok).toBe(true);
    expect(help.data?.commands).toBeDefined();
    expect(h.state.sent).toHaveLength(0);
  });

  it('rejects bad args before asking the renderer anything', async () => {
    setAgentHistoryEnabled(true);
    const res = await processHistoryCommand('term-1', ['search']);
    expect(res.error).toBe('bad_args');
    expect(h.state.sent).toHaveLength(0);
  });
});

describe('processHistoryCommand: workspace resolution round-trip', () => {
  beforeEach(() => {
    setAgentHistoryEnabled(true);
    setHistoryOwnerResolver((t) => (t === 'term-1' ? 7 : undefined));
    h.state.sent = [];
    h.state.reply = () => OWN;
    for (const fn of [svc.search, svc.sessionsForFile, svc.showChunk, svc.listSessions]) fn.mockClear();
  });
  afterEach(() => setAgentHistoryEnabled(false));

  it('asks the OWNING window, then queries the service with the workspace id it reported', async () => {
    svc.search.mockResolvedValueOnce([
      { chunkId: 's1:3', sessionId: 's1', ts: new Date(2026, 8, 14, 16, 2).getTime(), kind: 'turn', snippet: '  User: why backoff  ', score: 0.9, sessionTitle: 'Fix reconnect' },
    ]);
    const res = await processHistoryCommand('term-1', ['search', 'reconnect', 'backoff', '--limit', '3']);
    expect(h.fromId).toHaveBeenCalledWith(7);
    expect(h.state.sent[0]).toMatchObject({ channel: 'history-agent:resolve', payload: { terminal: 'term-1' } });
    expect(svc.search).toHaveBeenCalledWith('ws-own', 'reconnect backoff', { limit: 3, since: undefined });
    expect(flattenHistoryResult(res)).toEqual({
      ok: true,
      query: 'reconnect backoff',
      hits: [{ date: '2026-09-14 16:02', session: 'Fix reconnect', chunkId: 's1:3', snippet: 'User: why backoff' }],
    });
  });

  it('refuses a terminal the renderer cannot place, without calling the service', async () => {
    h.state.reply = () => ({ ok: false, error: 'unknown_terminal' });
    const res = await processHistoryCommand('term-1', ['sessions']);
    expect(res.error).toBe('unknown_terminal');
    expect(svc.listSessions).not.toHaveBeenCalled();
  });

  it('refuses an empty terminal id outright', async () => {
    const res = await processHistoryCommand('', ['sessions']);
    expect(res.error).toBe('unknown_terminal');
    expect(h.state.sent).toHaveLength(0);
  });

  it('a workspace without a folder gets workspace_has_no_folder', async () => {
    h.state.reply = () => ({ ok: true, data: { workspaceId: 'ws-own', workingDirectory: null } });
    const res = await processHistoryCommand('term-1', ['sessions']);
    expect(res.error).toBe('workspace_has_no_folder');
    expect(svc.listSessions).not.toHaveBeenCalled();
  });

  it('resolves a relative `file` path against the caller cwd', async () => {
    const cwd = path.join(WS_DIR, 'src');
    await processHistoryCommand('term-1', ['file', 'net/socket.ts'], cwd);
    expect(svc.sessionsForFile).toHaveBeenCalledWith('ws-own', path.join(cwd, 'net', 'socket.ts'), 15);
  });

  it('times out when the renderer never answers', async () => {
    vi.useFakeTimers();
    try {
      h.state.reply = () => null as never;
      const p = processHistoryCommand('term-1', ['sessions']);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await p).error).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseHistoryArgv', () => {
  const NOW = new Date(2026, 9, 30, 12, 0).getTime();

  it('joins the query and reads flags in any position', () => {
    expect(parseHistoryArgv(['search', '--since', '30d', 'retry', 'logic', '--limit=4'], NOW)).toEqual({
      ok: true,
      command: { cmd: 'search', query: 'retry logic', limit: 4, since: NOW - 30 * 86_400_000 },
    });
  });

  it('clamps limits and radius to their maximums', () => {
    expect(parseHistoryArgv(['search', 'x', '--limit', '999'])).toMatchObject({ command: { limit: 30 } });
    expect(parseHistoryArgv(['sessions', '--limit', '999'])).toMatchObject({ command: { limit: 100 } });
    expect(parseHistoryArgv(['show', 'a:1', '--radius', '50'])).toMatchObject({ command: { radius: 5 } });
    expect(parseHistoryArgv(['show', 'a:1', '--radius', '0'])).toMatchObject({ command: { radius: 0 } });
  });

  it('rejects malformed input with bad_args / unknown_command', () => {
    expect(parseHistoryArgv(['search', 'x', '--limit', '0'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['search', 'x', '--limit'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['search', 'x', '--since', 'yesterday'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['file'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['show', 'a', 'b'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['sessions', 'extra'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['rm', 'x'])).toMatchObject({ ok: false, error: 'unknown_command' });
  });

  it('parseSince handles relative units and dates', () => {
    expect(parseSince('12h', NOW)).toBe(NOW - 12 * 3_600_000);
    expect(parseSince('2w', NOW)).toBe(NOW - 14 * 86_400_000);
    expect(parseSince('2026-09-01', NOW)).toBe(new Date(2026, 8, 1).getTime());
    expect(parseSince('soon', NOW)).toBeNull();
  });
});

describe('parseHistoryArgv: why', () => {
  it('takes a cited path:line, an explicit --line, or a whole file', () => {
    expect(parseHistoryArgv(['why', 'src/a.ts:42'])).toEqual({ ok: true, command: { cmd: 'why', file: 'src/a.ts', line: 42 } });
    expect(parseHistoryArgv(['why', 'src/a.ts', '--line', '7'])).toEqual({ ok: true, command: { cmd: 'why', file: 'src/a.ts', line: 7 } });
    expect(parseHistoryArgv(['why', 'src/a.ts'])).toEqual({ ok: true, command: { cmd: 'why', file: 'src/a.ts' } });
  });

  it('keeps Windows drive letters and rejects a bad line', () => {
    expect(parseHistoryArgv(['why', 'C:\\repo\\a.ts'])).toEqual({ ok: true, command: { cmd: 'why', file: 'C:\\repo\\a.ts' } });
    expect(parseHistoryArgv(['why', 'a.ts', '--line', '0'])).toMatchObject({ ok: false, error: 'bad_args' });
    expect(parseHistoryArgv(['why'])).toMatchObject({ ok: false, error: 'bad_args' });
  });
});

describe('executeHistoryCommand: compact reply shapes', () => {
  const ctx = { workspaceId: 'ws-own', workingDirectory: WS_DIR };
  const mk = (over: Partial<Record<keyof HistoryService, unknown>> = {}): HistoryService =>
    ({ ...svc, ...over } as unknown as HistoryService);

  it('file: newest first, no scores or ids beyond what the agent needs', async () => {
    const s = mk({
      sessionsForFile: vi.fn(async () => [
        { sessionId: 'a', chunkId: 'a:1', ts: 1_000, title: 'old' },
        { sessionId: 'b', chunkId: 'b:9', ts: 9_000 },
      ]),
    });
    const res = await executeHistoryCommand(s, ctx, { cmd: 'file', file: path.join(WS_DIR, 'x.ts'), limit: 5 }, '');
    const sessions = res.data?.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((r) => r.chunkId)).toEqual(['b:9', 'a:1']);
    expect(sessions[0]).toEqual({ date: expect.any(String), session: null, chunkId: 'b:9' });
  });

  it('show: marks the focus chunk, truncates very long turns, and reports a missing chunk', async () => {
    const long = 'x'.repeat(10_000);
    const s = mk({
      showChunk: vi.fn(async () => [
        { chunkId: 'a:1', ts: 1, text: 'before' },
        { chunkId: 'a:2', ts: 2, text: long },
      ]),
    });
    const res = await executeHistoryCommand(s, ctx, { cmd: 'show', chunkId: 'a:2', radius: 1 }, '');
    const chunks = res.data?.chunks as Array<Record<string, unknown>>;
    expect(chunks[0].focus).toBeUndefined();
    expect(chunks[1]).toMatchObject({ focus: true, truncated: true });
    expect((chunks[1].text as string).length).toBeLessThanOrEqual(6_000);

    const none = await executeHistoryCommand(mk(), ctx, { cmd: 'show', chunkId: 'zz:1', radius: 1 }, '');
    expect(none.error).toBe('chunk_not_found');
  });

  it('adds a note while the index is still building, so empty is not read as "never discussed"', async () => {
    const s = mk({ getStatus: vi.fn(() => ({ enabled: true, progress: { state: 'indexing' }, workspaces: [] })) });
    const res = await executeHistoryCommand(s, ctx, { cmd: 'search', query: 'x', limit: 8 }, '');
    expect(res.data?.note).toMatch(/indexing/);
  });

  it('surfaces a service failure as history_error rather than throwing', async () => {
    const s = mk({ listSessions: vi.fn(async () => { throw new Error('db locked'); }) });
    const res = await executeHistoryCommand(s, ctx, { cmd: 'sessions', limit: 5 }, '');
    expect(res).toEqual({ ok: false, error: 'history_error', data: { message: 'db locked' } });
  });
});

describe('executeHistoryCommand: why', () => {
  const ctx = { workspaceId: 'ws-own', workingDirectory: WS_DIR };
  const mk = (over: Partial<Record<keyof HistoryService, unknown>> = {}): HistoryService =>
    ({ ...svc, ...over } as unknown as HistoryService);

  it('resolves the path against the caller cwd and reports commits with their sessions', async () => {
    const why = vi.fn(async () => [
      {
        commit: { sha: 'a'.repeat(40), ts: 5_000, subject: 'Write settings atomically', author: 'me' },
        edits: [{ sessionId: 's', chunkId: 's:3', ts: 4_000, title: 'atomic writes', snippet: 'User: why atomic' }],
      },
      { commit: { sha: '0'.repeat(40), ts: 0, subject: '(not committed yet)', author: '', uncommitted: true }, edits: [] },
    ]);
    const res = await executeHistoryCommand(mk({ why }), ctx, { cmd: 'why', file: 'src/x.ts', line: 3 }, path.join(WS_DIR, 'pkg'));
    expect(why).toHaveBeenCalledWith('ws-own', path.join(WS_DIR, 'pkg', 'src/x.ts'), 3);
    const commits = res.data?.commits as Array<Record<string, unknown>>;
    expect(commits[0]).toMatchObject({ commit: 'aaaaaaaaaa', subject: 'Write settings atomically', sessions: [{ chunkId: 's:3', session: 'atomic writes' }] });
    expect(commits[1].commit).toBeNull();
    expect(res.data?.line).toBe(3);
  });

  it('explains an empty result', async () => {
    const res = await executeHistoryCommand(mk(), ctx, { cmd: 'why', file: path.join(WS_DIR, 'x.ts') }, '');
    expect(res.data?.note).toMatch(/no commits found/);
  });
});

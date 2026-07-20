import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  TerminalSessionInfo,
  SSHConnectionConfig,
  SavedConnection,
  LocalShellConfig,
  TerminalRendererMetrics,
} from '../../shared/types';
import { feedTerminalInput, noteTerminalOutput, dropCommandBuffer } from '../utils/commandCapture';

export type TerminalWriter = (data: string) => void;

// Content-diff activity detection (used for terminals without a hooked agent;
// agent terminals get a far better signal from lifecycle hooks). Output windows are
// coalesced over a short slice, then hashed: the visible (control-stripped)
// content changing vs the previous window = activity. Idle TUI repaints of the
// same frame don't count; output right after a resize or user input is ignored.
const ACTIVITY_COALESCE_MS = 80;
const ACTIVITY_QUEUE_CHARS = 8000;
const RESIZE_GRACE_MS = 1200;
const INPUT_GRACE_MS = 600;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const CSI_SEQUENCE_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ESC_SEQUENCE_RE = new RegExp(`${ESC}[@-_][0-?]*[ -/]*`, 'g');

function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return h;
}

function stripTerminalControlSequences(value: string): string {
  const withoutAnsi = value
    .replace(OSC_SEQUENCE_RE, '')
    .replace(CSI_SEQUENCE_RE, '')
    .replace(ESC_SEQUENCE_RE, '')
    .replace(/\r/g, '\n');
  let out = '';
  for (const ch of withoutAnsi) {
    const code = ch.charCodeAt(0);
    if (ch === '\n' || ch === '\t' || code >= 32) out += ch;
  }
  return out;
}

export function useTerminals() {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  // True once the live session list has been fetched from main at least once.
  // Terminal restore must wait for this — running with an empty (not-yet-loaded)
  // session list makes every persisted terminal look dead and spawns duplicate
  // shells, orphaning live PTYs (and desyncing $SPLITGRID_TERMINAL ↔ terminalId).
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const writersRef = useRef<Map<string, TerminalWriter>>(new Map());
  const rendererMetricsRef = useRef<Map<string, TerminalRendererMetrics>>(new Map());
  // Content-diff activity state (non-Claude terminals).
  const lastOutputChangeAtRef = useRef<Map<string, number>>(new Map());
  const lastWindowHashRef = useRef<Map<string, number>>(new Map());
  const lastResizeAtRef = useRef<Map<string, number>>(new Map());
  const lastInputAtRef = useRef<Map<string, number>>(new Map());
  const activityQueueRef = useRef<Map<string, string>>(new Map());
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set of session IDs that have unread Claude Code responses
  const [claudeResponseSessionIds, setClaudeResponseSessionIds] = useState<Set<string>>(new Set());

  const detectActivity = useCallback((sessionId: string, data: string) => {
    const cleaned = stripTerminalControlSequences(data);
    if (!cleaned.trim()) return;
    const windowHash = hashString(cleaned.replace(/\s+/g, ' ').trim());
    if (lastWindowHashRef.current.get(sessionId) === windowHash) return;
    lastWindowHashRef.current.set(sessionId, windowHash);
    const now = Date.now();
    const resizedAt = lastResizeAtRef.current.get(sessionId);
    if (resizedAt && now - resizedAt < RESIZE_GRACE_MS) return;
    const inputAt = lastInputAtRef.current.get(sessionId);
    if (inputAt && now - inputAt < INPUT_GRACE_MS) return;
    lastOutputChangeAtRef.current.set(sessionId, now);
  }, []);

  const processActivityQueue = useCallback(() => {
    activityTimerRef.current = null;
    if (activityQueueRef.current.size === 0) return;
    const queued = activityQueueRef.current;
    activityQueueRef.current = new Map();
    for (const [sessionId, data] of queued) detectActivity(sessionId, data);
  }, [detectActivity]);

  const queueTerminalActivity = useCallback((sessionId: string, data: string) => {
    const existing = activityQueueRef.current.get(sessionId) ?? '';
    activityQueueRef.current.set(sessionId, `${existing}${data}`.slice(-ACTIVITY_QUEUE_CHARS));
    if (!activityTimerRef.current) {
      activityTimerRef.current = setTimeout(processActivityQueue, ACTIVITY_COALESCE_MS);
    }
  }, [processActivityQueue]);

  // Restore sessions after reload + load saved connections
  useEffect(() => {
    (async () => {
      try {
        const active = await window.electronAPI.getActiveSessions();
        if (active.length > 0) {
          setSessions(active);
        }
      } catch (e) {
        console.error('Failed to restore sessions:', e);
      } finally {
        // Mark loaded even on failure/empty so restore can proceed (a genuinely
        // empty list means the PTYs are gone and persisted terminals do need
        // re-spawning — that's correct restore, not the pre-load race).
        setSessionsLoaded(true);
      }
      try {
        setSavedConnections(await window.electronAPI.getSavedConnections());
      } catch (e) {
        console.error('Failed to load saved connections:', e);
      }
    })();
  }, []);

  // IPC event subscriptions
  useEffect(() => {
    const unsubData = window.electronAPI.onData((id, data) => {
      const writer = writersRef.current.get(id);
      if (writer) writer(data);
      noteTerminalOutput(id, data);
      queueTerminalActivity(id, data);
    });

    const unsubReady = window.electronAPI.onSessionReady((id) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'connected' as const } : s))
      );
    });

    const unsubClosed = window.electronAPI.onSessionClosed((id) => {
      rendererMetricsRef.current.delete(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'disconnected' as const } : s))
      );
    });

    const unsubError = window.electronAPI.onError((id, msg) => {
      console.error(`Terminal error [${id}]:`, msg);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'error' as const } : s))
      );
    });

    const unsubClaude = window.electronAPI.onClaudeResponse((sessionId) => {
      setClaudeResponseSessionIds(prev => new Set(prev).add(sessionId));
      // Play notification sound
      try {
        const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUoGAACAgICAgICBgYKCg4OEhYWGh4iIiYqLi4yNjY6Oj4+QkJGRkpKTk5OTlJSUlJSUlJSUk5OTk5KSkpKRkZGRkJCQj4+Pj46OjY2NjIyLi4qKiYmIiIeHhoaFhYSEg4OCgoGBgYCAgICA');
        audio.volume = 0.3;
        audio.play().catch(() => {});
      } catch {
        // Notification sound is best effort.
      }
    });

    return () => {
      unsubData();
      unsubReady();
      unsubClosed();
      unsubError();
      unsubClaude();
      if (activityTimerRef.current) {
        clearTimeout(activityTimerRef.current);
        activityTimerRef.current = null;
      }
    };
  }, [queueTerminalActivity]);

  const registerWriter = useCallback((id: string, fn: TerminalWriter) => {
    writersRef.current.set(id, fn);
  }, []);

  const unregisterWriter = useCallback((id: string) => {
    writersRef.current.delete(id);
  }, []);

  const createSSHSession = useCallback(
    async (config: Omit<SSHConnectionConfig, 'id'>) => {
      const info = await window.electronAPI.createSession(config);
      setSessions((prev) => [...prev, info]);
      return info;
    },
    []
  );

  const createLocalTerminal = useCallback(async (config?: LocalShellConfig) => {
    const info = await window.electronAPI.createLocalTerminal(config);
    setSessions((prev) => [...prev, info]);
    return info;
  }, []);

  const closeSession = useCallback(async (id: string) => {
    await window.electronAPI.closeSession(id);
    writersRef.current.delete(id);
    rendererMetricsRef.current.delete(id);
    lastOutputChangeAtRef.current.delete(id);
    lastWindowHashRef.current.delete(id);
    lastResizeAtRef.current.delete(id);
    lastInputAtRef.current.delete(id);
    activityQueueRef.current.delete(id);
    dropCommandBuffer(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const sendData = useCallback((id: string, data: string) => {
    lastInputAtRef.current.set(id, Date.now());
    feedTerminalInput(id, data);
    window.electronAPI.sendData(id, data);
  }, []);

  const resize = useCallback((id: string, cols: number, rows: number) => {
    lastResizeAtRef.current.set(id, Date.now());
    window.electronAPI.resize(id, cols, rows);
  }, []);

  const getBuffer = useCallback(async (id: string) => {
    return window.electronAPI.getSessionBuffer(id);
  }, []);

  const reportRendererMetrics = useCallback((metrics: TerminalRendererMetrics) => {
    rendererMetricsRef.current.set(metrics.sessionId, metrics);
  }, []);

  const removeRendererMetrics = useCallback((sessionId: string) => {
    rendererMetricsRef.current.delete(sessionId);
  }, []);

  const getRendererMetricsSnapshot = useCallback(() => {
    return Array.from(rendererMetricsRef.current.values());
  }, []);

  // Last time a session's visible output meaningfully changed (content-diff),
  // for non-Claude working/stopped detection. 0 if never.
  const getLastOutputAt = useCallback((id: string) => lastOutputChangeAtRef.current.get(id) ?? 0, []);

  // Saved connections
  const saveConnection = useCallback(
    async (config: Omit<SSHConnectionConfig, 'id'>) => {
      const saved = await window.electronAPI.saveConnection(config);
      setSavedConnections((prev) => [...prev, saved]);
      return saved;
    },
    []
  );

  const updateConnection = useCallback(
    async (id: string, config: Omit<SSHConnectionConfig, 'id'>) => {
      const updated = await window.electronAPI.updateConnection(id, config);
      setSavedConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
      return updated;
    },
    []
  );

  const deleteSavedConnection = useCallback(async (id: string) => {
    await window.electronAPI.deleteSavedConnection(id);
    setSavedConnections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const connectSaved = useCallback(async (savedId: string) => {
    const info = await window.electronAPI.connectSaved(savedId);
    setSessions((prev) => [...prev, info]);
    return info;
  }, []);

  const testSavedConnection = useCallback(async (savedId: string) => {
    return window.electronAPI.testSavedConnection(savedId);
  }, []);

  const clearClaudeResponse = useCallback((sessionId: string) => {
    setClaudeResponseSessionIds(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const clearClaudeResponsesForSessions = useCallback((sessionIds: string[]) => {
    setClaudeResponseSessionIds(prev => {
      const next = new Set(prev);
      for (const id of sessionIds) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  return {
    sessions,
    sessionsLoaded,
    createSSHSession,
    createLocalTerminal,
    closeSession,
    sendData,
    resize,
    getBuffer,
    registerWriter,
    unregisterWriter,
    reportRendererMetrics,
    removeRendererMetrics,
    getRendererMetricsSnapshot,
    getLastOutputAt,
    savedConnections,
    saveConnection,
    updateConnection,
    deleteSavedConnection,
    connectSaved,
    testSavedConnection,
    claudeResponseSessionIds,
    clearClaudeResponse,
    clearClaudeResponsesForSessions,
  };
}

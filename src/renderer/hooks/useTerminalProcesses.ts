import { useEffect, useReducer } from 'react';
import type { TerminalListenPort, TerminalResourceSnapshot } from '../../shared/types';

/**
 * Shared, ref-counted poller for per-terminal process info from the main
 * process resource snapshot. A single `ps` (in main) feeds every consumer —
 * sidebar process labels, the per-terminal process popover/icon, and the
 * Working/Stopped activity detector — so we never run more than one poll loop.
 */

export interface TerminalProcInfo {
  processCount: number;
  /** Friendly name of the terminal's foreground process (e.g. "claude", "zsh"). */
  processCommand?: string;
  /** Instantaneous CPU% of the terminal's process tree (0..100*cores). */
  processCpuPercent: number;
  /** TCP ports the terminal's process tree is currently LISTENing on. */
  listenPorts: number[];
  /** Same ports, each with the PID(s) holding it (for the kill action). */
  ports: TerminalListenPort[];
}

const POLL_MS = 2000;
// A tree using more than this much CPU is considered actively "working".
const BUSY_CPU_PERCENT = 12;

const infoBySession = new Map<string, TerminalProcInfo>();
// The most recent raw snapshot, kept so other consumers (e.g. the StatusBar's
// aggregate CPU/RSS totals) can reuse THIS poll instead of running a second
// getResourceSnapshot loop — each snapshot shells out `ps` across every
// terminal, so one shared poll halves that cost.
let lastSnapshot: TerminalResourceSnapshot | null = null;
// Last time each session was seen busy (CPU over threshold, or an explicit
// markSessionBusy on submit). Drives Working/Stopped via the activity detector.
const lastBusyAtBySession = new Map<string, number>();
const subscribers = new Set<() => void>();
let timer: number | null = null;

async function poll() {
  try {
    const snap = await window.electronAPI.getResourceSnapshot();
    lastSnapshot = snap;
    const now = Date.now();
    infoBySession.clear();
    for (const s of snap.sessions) {
      const cpu = typeof s.processCpuPercent === 'number' ? s.processCpuPercent : 0;
      infoBySession.set(s.id, {
        processCount: typeof s.processCount === 'number' ? s.processCount : 0,
        processCommand: s.processCommand,
        processCpuPercent: cpu,
        listenPorts: Array.isArray(s.listenPorts) ? s.listenPorts : [],
        ports: Array.isArray(s.ports) ? s.ports : [],
      });
      if (cpu >= BUSY_CPU_PERCENT) lastBusyAtBySession.set(s.id, now);
    }
  } catch {
    // ignore — keep last known values
  }
  subscribers.forEach((cb) => cb());
}

export function subscribeTerminalProcesses(cb: () => void): () => void {
  subscribers.add(cb);
  if (timer === null) {
    void poll();
    timer = window.setInterval(poll, POLL_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function getTerminalProcInfo(sessionId: string): TerminalProcInfo | undefined {
  return infoBySession.get(sessionId);
}

/** The most recent raw resource snapshot from the shared poll (null until the
 *  first poll resolves). Consumers should subscribe via subscribeTerminalProcesses
 *  to be notified when it updates. */
export function getLastResourceSnapshot(): TerminalResourceSnapshot | null {
  return lastSnapshot;
}

/** Last time the session's process tree was busy (ms epoch, 0 if never). */
export function getLastBusyAt(sessionId: string): number {
  return lastBusyAtBySession.get(sessionId) ?? 0;
}

/**
 * Mark a session busy right now. Used to bridge the gap between submitting a
 * prompt (Enter) and the agent's CPU ramping up, so Working shows immediately
 * instead of after the first poll.
 */
export function markSessionBusy(sessionId: string): void {
  lastBusyAtBySession.set(sessionId, Date.now());
}

/** Subscribe + re-render on each poll; returns the live session→info map. */
export function useTerminalProcesses(): Map<string, TerminalProcInfo> {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeTerminalProcesses(force), []);
  return infoBySession;
}

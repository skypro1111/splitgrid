import { useCallback, useEffect, useRef } from 'react';
import type { AppSettings, ClaudeActivityState, Workspace } from '../../shared/types';
import { useNotificationSound } from './useNotificationSound';

export type AttentionKind = 'done' | 'waiting';

interface Options {
  getSettings: () => AppSettings;
  getWorkspaces: () => Workspace[];
  /** Switch to the workspace and focus the terminal's container (click on a notification). */
  focusContainerInWorkspace: (workspaceId: string, containerId: string) => void;
  switchWorkspace: (workspaceId: string) => void;
}

/**
 * Title and body of the system notification for a terminal that needs
 * attention. The workspace leads the title, so it survives truncation. The body
 * is `detail` when the agent's hooks gave one — its final reply for Done, the
 * question or the tool call awaiting permission for Waiting — already one short
 * line (main's agent-hook-detail), so the banner stays a banner.
 */
export function attentionText(kind: AttentionKind, ws: Workspace, sessionId: string, detail?: string): { title: string; body: string } {
  const c = ws.containers.find((x) => x.content.type === 'terminal' && x.content.terminalId === sessionId);
  const label = c?.content.customName?.trim() || c?.content.label || 'Terminal';
  return {
    title: `${ws.name} · ${label} — ${kind === 'done' ? 'Done' : 'waiting for you'}`,
    body: detail?.trim() || (kind === 'done' ? 'Finished its turn' : 'Needs your input'),
  };
}

// The state a detail must have arrived with to describe this kind of attention.
const DETAIL_STATE: Record<AttentionKind, ClaudeActivityState> = { done: 'idle', waiting: 'waiting' };

/**
 * "An agent needs you" notifications: a sound (as before) plus, while the
 * window is unfocused, a system notification that opens the workspace and the
 * terminal when clicked. Done always notifies; Waiting unless turned off in
 * Settings. Mute-all and a workspace's own mute silence both.
 */
export function useAgentAttention(options: Options) {
  const optsRef = useRef(options);
  optsRef.current = options;
  const playSound = useNotificationSound({
    getSettings: () => optsRef.current.getSettings(),
    getWorkspace: (id) => optsRef.current.getWorkspaces().find((w) => w.id === id),
  });

  // The last activity line per terminal, with the state it came with. Written
  // straight from the IPC event, which lands before the re-render that fires
  // the Done/Waiting edge, so it is in place when notify runs.
  const detailsRef = useRef(new Map<string, { state: ClaudeActivityState; detail?: string }>());
  useEffect(() => window.electronAPI.onClaudeActivity(({ terminalId, state, detail }) => {
    detailsRef.current.set(terminalId, { state, detail });
  }), []);

  const notify = useCallback((kind: AttentionKind, sessionId: string, workspaceId: string) => {
    const settings = optsRef.current.getSettings();
    if (kind === 'waiting' && settings.notifyOnWaiting === false) return;
    playSound(sessionId, workspaceId);

    const ws = optsRef.current.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws || settings.muteAll || ws.notifyMuted || settings.systemNotifications === false) return;
    // In a focused window the sidebar badge and the sound already say it.
    if (document.hasFocus()) return;
    const last = detailsRef.current.get(sessionId);
    const detail = last?.state === DETAIL_STATE[kind] ? last.detail : undefined;
    void window.electronAPI.showAgentNotification({ workspaceId, sessionId, ...attentionText(kind, ws, sessionId, detail) })
      .catch(() => {});
  }, [playSound]);

  useEffect(() => window.electronAPI.onAgentNotificationActivate(({ workspaceId, sessionId }) => {
    const { getWorkspaces, focusContainerInWorkspace, switchWorkspace } = optsRef.current;
    const ws = getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return;
    const c = ws.containers.find((x) => x.content.type === 'terminal' && x.content.terminalId === sessionId);
    if (c) focusContainerInWorkspace(workspaceId, c.id);
    else switchWorkspace(workspaceId);
  }), []);

  const onDone = useCallback((sid: string, wsId: string) => notify('done', sid, wsId), [notify]);
  const onWaiting = useCallback((sid: string, wsId: string) => notify('waiting', sid, wsId), [notify]);
  return { onDone, onWaiting };
}

import { useCallback, useEffect, useRef } from 'react';
import type { AppSettings, Workspace } from '../../shared/types';
import { useNotificationSound } from './useNotificationSound';

export type AttentionKind = 'done' | 'waiting';

interface Options {
  getSettings: () => AppSettings;
  getWorkspaces: () => Workspace[];
  /** Switch to the workspace and focus the terminal's container (click on a notification). */
  focusContainerInWorkspace: (workspaceId: string, containerId: string) => void;
  switchWorkspace: (workspaceId: string) => void;
}

/** Title and body of the system notification for a terminal that needs attention. */
export function attentionText(kind: AttentionKind, ws: Workspace, sessionId: string): { title: string; body: string } {
  const c = ws.containers.find((x) => x.content.type === 'terminal' && x.content.terminalId === sessionId);
  const label = c?.content.customName?.trim() || c?.content.label || 'Terminal';
  return {
    title: kind === 'done' ? `${label} — Done` : `${label} — waiting for you`,
    body: kind === 'done' ? `Finished in workspace "${ws.name}"` : `Needs your input in workspace "${ws.name}"`,
  };
}

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

  const notify = useCallback((kind: AttentionKind, sessionId: string, workspaceId: string) => {
    const settings = optsRef.current.getSettings();
    if (kind === 'waiting' && settings.notifyOnWaiting === false) return;
    playSound(sessionId, workspaceId);

    const ws = optsRef.current.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws || settings.muteAll || ws.notifyMuted || settings.systemNotifications === false) return;
    // In a focused window the sidebar badge and the sound already say it.
    if (document.hasFocus()) return;
    void window.electronAPI.showAgentNotification({ workspaceId, sessionId, ...attentionText(kind, ws, sessionId) })
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

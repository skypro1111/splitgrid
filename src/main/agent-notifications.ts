import { BrowserWindow, Notification, app, ipcMain } from 'electron';
import type { AgentNotificationRequest } from '../shared/types';

// ─── System notifications for agents that need attention ────────────────────
// The renderer decides WHEN (an agent finished or started waiting while its
// window was unfocused); main only posts the OS notification and, on click,
// brings that window forward and tells it which workspace/terminal to open.
// The OS may ask for permission the first time one is posted.

export const AGENT_NOTIFICATION_ACTIVATE_CHANNEL = 'agent-notification:activate';

const MAX_TEXT = 200;
const clip = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

// One live notification per terminal (per window): a newer one replaces the
// last instead of stacking up in Notification Center. The map also keeps each
// Notification referenced — a collected one silently loses its click handler.
const live = new Map<string, Notification>();

function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

export function registerAgentNotifications(): void {
  ipcMain.handle('agent-notification:show', (event, raw: AgentNotificationRequest) => {
    if (!Notification.isSupported()) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !raw || typeof raw !== 'object') return false;
    const workspaceId = clip(raw.workspaceId);
    const sessionId = clip(raw.sessionId);
    if (!workspaceId || !sessionId) return false;

    const key = `${event.sender.id}:${sessionId}`;
    live.get(key)?.close();

    // silent: the renderer already plays the user's chosen sound (and honours
    // mute), so the OS must not add its own on top.
    const n = new Notification({ title: clip(raw.title) || 'SplitGrid', body: clip(raw.body), silent: true });
    const forget = () => { if (live.get(key) === n) live.delete(key); };
    n.on('click', () => {
      forget();
      if (win.isDestroyed()) return;
      bringForward(win);
      win.webContents.send(AGENT_NOTIFICATION_ACTIVATE_CHANNEL, { workspaceId, sessionId });
    });
    n.on('close', forget);
    n.on('failed', (_e, error) => {
      forget();
      console.warn('[notifications] failed to post:', error);
    });
    live.set(key, n);
    n.show();
    return true;
  });
}

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { BrowserWindow, ipcMain } from 'electron';
import { handleBrowserRequest } from './agent-browser-bridge';
import { handleTerminalRequest } from './agent-terminal-bridge';
import { handleSqlRequest } from './agent-sql-bridge';

// ─── Agent activity receiver ─────────────────────────────────────────────────
// Agents launched inside a splitgrid terminal report their turn lifecycle by
// invoking the bundled hook helper, which POSTs {terminal,event} to /hook here
// (tagged with the $SPLITGRID_TERMINAL injected at spawn). Hooks are installed into
// each agent's global config by agent-hooks/installer. We map the event to a
// three-state activity and broadcast it to the renderer:
//   prompt-submit / start    -> 'working'  (turn started)
//   stop / done              -> 'idle'     (turn finished)
//   notification (mid-turn)  -> 'waiting'  (needs permission / input)

export const RECEIVER_PORT = 19558;

export type ClaudeActivityState = 'working' | 'idle' | 'waiting';

// Flip a stuck 'working' terminal to idle if we somehow miss its stop event
// (crashed agent / no Stop hook). With Pre/PostToolUse heartbeats refreshing
// activity on every tool call, this is now a pure crashed-agent backstop, so it
// can be generous: it only trips during a single tool / thinking gap longer than
// this with no Stop — far better than falsely flipping to Done mid-turn.
const SAFETY_IDLE_MS = 600_000;

let server: Server | null = null;
let wslServer: Server | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
// Primary bind stays on loopback; WSL reachability is added as a separate
// listener on the WSL vEthernet IP (see addReceiverInterface), never via 0.0.0.0.
const bindHost = '127.0.0.1';

interface TermState {
  state: ClaudeActivityState;
  lastEventAt: number;
}
const stateByTerminal = new Map<string, TermState>();

function broadcast(terminalId: string, state: ClaudeActivityState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('claude-activity:state', { terminalId, state });
  }
}

function setState(terminalId: string, state: ClaudeActivityState): void {
  const prev = stateByTerminal.get(terminalId);
  stateByTerminal.set(terminalId, { state, lastEventAt: Date.now() });
  if (prev?.state !== state) {
    console.log(`[activity] term=${terminalId.slice(0, 8)} -> ${state}`);
    broadcast(terminalId, state);
  }
}

// Lifecycle event names the helper may send, mapped to activity state. 'tool'
// (Pre/PostToolUse) is a 'working' heartbeat — it keeps a long turn marked active
// between prompt-submit and the final stop.
const HOOK_EVENT_STATE: Record<string, ClaudeActivityState> = {
  prompt: 'working', 'prompt-submit': 'working', 'user-prompt': 'working',
  start: 'working', active: 'working', tool: 'working',
  stop: 'idle', idle: 'idle', done: 'idle', end: 'idle',
  notification: 'waiting', notify: 'waiting', 'needs-input': 'waiting',
  waiting: 'waiting', permission: 'waiting',
};

export function handleHookEvent(terminal: string, event: string): void {
  const state = HOOK_EVENT_STATE[event.trim().toLowerCase()];
  if (!terminal || !state) return;
  // "waiting" only counts mid-turn — a permission/question while working. The
  // SAME notification fires when the agent sits idle after a turn ("waiting for
  // your input"); that must NOT override the finished state, or the terminal
  // sticks on Waiting once output ends.
  if (state === 'waiting' && stateByTerminal.get(terminal)?.state !== 'working') return;
  // Tool heartbeats fire on every tool call; only log when they actually change
  // state (setState logs transitions) to avoid flooding the console.
  if (event.trim().toLowerCase() !== 'tool') {
    console.log(`[hook] term=${terminal.slice(0, 8)} event=${event} -> ${state}`);
  }
  setState(terminal, state);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function getClaudeActivityStates(): Record<string, ClaudeActivityState> {
  const out: Record<string, ClaudeActivityState> = {};
  for (const [id, s] of stateByTerminal) out[id] = s.state;
  return out;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    // Agent browser control shares this port; the bridge handles its own reply.
    if ((req.url || '').startsWith('/browser')) {
      await handleBrowserRequest(raw, res);
      return;
    }
    // Agent terminal control (drive/inspect sibling terminals) shares it too.
    if ((req.url || '').startsWith('/terminal')) {
      await handleTerminalRequest(raw, res);
      return;
    }
    // Agent SQL control (query/inspect/export the SQL component) shares it too.
    if ((req.url || '').startsWith('/sql')) {
      await handleSqlRequest(raw, res);
      return;
    }
    if ((req.url || '').startsWith('/hook')) {
      let hook: any = null;
      try { hook = JSON.parse(raw.toString('utf8') || '{}'); } catch { hook = null; }
      if (hook && typeof hook.terminal === 'string' && typeof hook.event === 'string') {
        handleHookEvent(hook.terminal, hook.event);
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  } catch (err) {
    console.error('[activity] receiver error:', (err as Error).message);
    try {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch {
      // response may already be sent
    }
  }
}

export function startActivityReceiver(): void {
  if (server) return;

  ipcMain.handle('claude-activity:get', () => getClaudeActivityStates());

  server = createServer(handleRequest);
  server.on('error', (err) => console.error('[activity] server error:', err.message));
  server.listen(RECEIVER_PORT, bindHost, () => {
    console.log(`[activity] receiver on http://${bindHost}:${RECEIVER_PORT}`);
  });

  // Safety sweep: clear a working terminal gone silent far longer than any real
  // turn (missed stop event / crashed agent).
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of stateByTerminal) {
      if (s.state !== 'idle' && now - s.lastEventAt > SAFETY_IDLE_MS) {
        setState(id, 'idle');
      }
    }
  }, 30_000);
}

// Add a SECOND listener bound to a specific extra address — the host's WSL
// vEthernet IP — so default-NAT distros (which reach the host via that gateway,
// not 127.0.0.1) can report. We deliberately do NOT widen the primary bind to
// 0.0.0.0: the WSL subnet is host↔WSL only and not routable from the LAN, so
// this keeps the listener off every other interface. Idempotent per address.
export function addReceiverInterface(ip: string): void {
  if (!ip || ip === bindHost || wslServer) return;
  const extra = createServer(handleRequest);
  extra.on('error', (err) => console.error('[activity] wsl listener error:', err.message));
  extra.listen(RECEIVER_PORT, ip, () => {
    console.log(`[activity] receiver also on http://${ip}:${RECEIVER_PORT} (WSL)`);
  });
  wslServer = extra;
}

export function stopActivityReceiver(): void {
  server?.close();
  server = null;
  wslServer?.close();
  wslServer = null;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  stateByTerminal.clear();
}

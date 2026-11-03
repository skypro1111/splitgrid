import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { BrowserWindow, ipcMain } from 'electron';
import { handleBrowserRequest, isKnownTerminal } from './agent-browser-bridge';
import { handleTerminalRequest } from './agent-terminal-bridge';
import { handleSqlRequest } from './agent-sql-bridge';
import { handleSftpRequest } from './agent-sftp-bridge';
import { handleHistoryRequest } from './agent-history-bridge';
import { handleAgentPaneRequest } from './agent-pane-bridge';
import { startExtensionChannel, stopExtensionChannel } from './agent-browser-channel';
import { parseHookPayload } from './agent-hook-detail';
import { applyHookEvent, hookEventName, sweep, type Step, type TermActivity } from './agent-activity-machine';
import type { ClaudeActivityState } from '../shared/types';

// ─── Agent activity receiver ─────────────────────────────────────────────────
// Agents launched inside a splitgrid terminal report their turn lifecycle by
// invoking the bundled hook helper, which POSTs to /hook?terminal=…&event=… here
// (tagged with the $SPLITGRID_TERMINAL injected at spawn), with the agent's own
// hook input as the body. That input supplies the line a notification shows
// (agent-hook-detail): the final reply on Stop, the question or the tool call
// awaiting permission while waiting. Hooks are installed into
// each agent's global config by agent-hooks/installer. We map the event to a
// turn state (agent-activity-machine) and broadcast it to the renderer:
//   prompt-submit / tool calls   -> 'working'
//   stop (nothing left to wake)  -> 'idle'     (Done)
//   permission prompt / question -> 'waiting'
//   session start/end, interrupt -> 'ready'    (at its prompt, nothing to announce)

export const RECEIVER_PORT = 19558;

// Largest request body we buffer. Agent commands are argv + paths (never file
// contents), so this is generous; without a cap any local process — or a web
// page POSTing to loopback — could stream a body until main runs out of memory.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

class BodyTooLargeError extends Error {}

let server: Server | null = null;
let wslServer: Server | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
// Primary bind stays on loopback; WSL reachability is added as a separate
// listener on the WSL vEthernet IP (see addReceiverInterface), never via 0.0.0.0.
const bindHost = '127.0.0.1';

const activityByTerminal = new Map<string, TermActivity>();

function broadcast(terminalId: string, state: ClaudeActivityState, detail?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('claude-activity:state', { terminalId, state, ...(detail ? { detail } : {}) });
  }
}

function commit(terminalId: string, step: Step | null): void {
  if (!step) return;
  activityByTerminal.set(terminalId, step.next);
  if (step.emit) {
    console.log(`[activity] term=${terminalId.slice(0, 8)} -> ${step.emit.state}`);
    broadcast(terminalId, step.emit.state, step.emit.detail);
  }
}

/** `rawPayload` is the agent's hook input (parsed JSON), when the helper sent it. */
export function handleHookEvent(terminal: string, event: string, rawPayload?: unknown): void {
  const name = hookEventName(event);
  if (!terminal || !name) return;
  // /hook carries no token (fire-and-forget by design), so only accept ids this
  // run actually created — otherwise junk ids would grow the map without bound.
  if (!isKnownTerminal(terminal)) return;
  const step = applyHookEvent(activityByTerminal.get(terminal), name, parseHookPayload(rawPayload), Date.now());
  // Tool heartbeats fire on every tool call; transitions are logged in commit.
  if (name !== 'tool' && step?.emit) console.log(`[hook] term=${terminal.slice(0, 8)} event=${event}`);
  commit(terminal, step);
}

// Where the helper put the terminal and event: the query string (current
// helpers, whose body is the agent's raw hook input) or, from older helpers, a
// {terminal,event} body.
function hookTarget(url: string | undefined): { terminal: string; event: string } | null {
  const q = new URL(url || '/', 'http://localhost').searchParams;
  const terminal = q.get('terminal');
  const event = q.get('event');
  return terminal && event ? { terminal, event } : null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function getClaudeActivityStates(): Record<string, ClaudeActivityState> {
  const out: Record<string, ClaudeActivityState> = {};
  for (const [id, s] of activityByTerminal) out[id] = s.state;
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
    // Agent SFTP access (move files to/from the workspace's remote hosts) too.
    if ((req.url || '').startsWith('/sftp')) {
      await handleSftpRequest(raw, res);
      return;
    }
    // Agent workspace-history search (past Claude Code sessions, read-only).
    if ((req.url || '').startsWith('/history')) {
      await handleHistoryRequest(raw, res);
      return;
    }
    // Claude Code pane control/inspection. Answered by the main process itself
    // (not the renderer) so it still works when a pane's UI is stuck.
    if ((req.url || '').startsWith('/agent')) {
      await handleAgentPaneRequest(raw, res);
      return;
    }
    if ((req.url || '').startsWith('/hook')) {
      let body: unknown = null;
      try { body = JSON.parse(raw.toString('utf8') || 'null'); } catch { body = null; }
      const target = hookTarget(req.url);
      const legacy = body as { terminal?: unknown; event?: unknown } | null;
      if (target) {
        handleHookEvent(target.terminal, target.event, body);
      } else if (legacy && typeof legacy.terminal === 'string' && typeof legacy.event === 'string') {
        handleHookEvent(legacy.terminal, legacy.event);
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // A hook whose input was huge (a Write of a large file) still counts.
      const target = (req.url || '').startsWith('/hook') ? hookTarget(req.url) : null;
      if (target) handleHookEvent(target.terminal, target.event);
      // Answer, then drop the connection so the rest of the body is never read.
      try {
        res.writeHead(413, { connection: 'close' }).end(() => req.destroy());
      } catch {
        req.destroy();
      }
      return;
    }
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
  // The companion browser extension rides the same loopback server, upgraded to
  // a WebSocket on EXT_WS_PATH (extension origins + a pairing token only).
  startExtensionChannel(server);

  // Safety sweep: a working turn gone silent with no tool running (see
  // agent-activity-machine.sweep) goes back to 'ready' — never to Done.
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of activityByTerminal) {
      // A closed terminal leaves the owner map; forget its activity too.
      if (!isKnownTerminal(id)) {
        activityByTerminal.delete(id);
        continue;
      }
      commit(id, sweep(s, now));
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
  stopExtensionChannel();
  server?.close();
  server = null;
  wslServer?.close();
  wslServer = null;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  activityByTerminal.clear();
}

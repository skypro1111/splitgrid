import { app, webContents } from 'electron';

// ─── Agent browser network capture (CDP) ─────────────────────────────────────
// Optional network inspection for the agent's browser pane: attach the Chrome
// DevTools Protocol debugger to the GUEST webContents, enable the Network
// domain, and buffer requests/responses so the agent can verify its own API
// calls (status codes, failures, types). Attachment is LAZY — nothing is touched
// until the agent issues a `network` command — and we ALWAYS detach on pane
// teardown and app quit. (A debugger left attached at window teardown is what
// hard-crashed the renderer during the old Chrome-login work, so detach is
// non-negotiable here.)

const BUFFER_CAP = 300;

interface NetEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  failed?: boolean;
  errorText?: string;
  finished?: boolean;
}

interface NetState {
  buffer: NetEntry[];
  index: Map<string, NetEntry>;
  handler: (event: unknown, method: string, params: Record<string, unknown>) => void;
}

const states = new Map<number, NetState>();

function trim(st: NetState): void {
  if (st.buffer.length <= BUFFER_CAP) return;
  const drop = st.buffer.length - BUFFER_CAP;
  const removed = st.buffer.splice(0, drop);
  for (const e of removed) st.index.delete(e.requestId);
}

function onMessage(wcId: number, method: string, params: Record<string, unknown>): void {
  const st = states.get(wcId);
  if (!st) return;
  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = params.request as { url?: string; method?: string } | undefined;
      const id = String(params.requestId);
      // A redirect re-fires requestWillBeSent with the same id; keep the latest.
      let e = st.index.get(id);
      if (!e) { e = { requestId: id, url: '', method: '' }; st.index.set(id, e); st.buffer.push(e); }
      e.url = req?.url ?? e.url;
      e.method = req?.method ?? e.method;
      e.resourceType = (params.type as string) ?? e.resourceType;
      trim(st);
      break;
    }
    case 'Network.responseReceived': {
      const e = st.index.get(String(params.requestId));
      const resp = params.response as { status?: number; statusText?: string; mimeType?: string; fromDiskCache?: boolean } | undefined;
      if (!e || !resp) break;
      e.status = resp.status;
      e.statusText = resp.statusText;
      e.mimeType = resp.mimeType;
      e.fromCache = !!resp.fromDiskCache;
      e.resourceType = (params.type as string) ?? e.resourceType;
      break;
    }
    case 'Network.loadingFailed': {
      const e = st.index.get(String(params.requestId));
      if (!e) break;
      e.failed = true;
      e.errorText = params.errorText as string;
      e.finished = true;
      break;
    }
    case 'Network.loadingFinished': {
      const e = st.index.get(String(params.requestId));
      if (e) e.finished = true;
      break;
    }
  }
}

function ensureAttached(wcId: number): void {
  if (states.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) throw new Error('browser_not_ready');
  if (wc.debugger.isAttached()) throw new Error('debugger_busy'); // devtools or another client
  wc.debugger.attach('1.3');
  const handler = (_event: unknown, method: string, params: Record<string, unknown>) => onMessage(wcId, method, params);
  wc.debugger.on('message', handler as never);
  states.set(wcId, { buffer: [], index: new Map(), handler });
  wc.debugger.sendCommand('Network.enable').catch(() => { /* best effort */ });
  // Detach if the pane goes away while we're attached.
  wc.once('destroyed', () => detach(wcId));
}

function detach(wcId: number): void {
  const st = states.get(wcId);
  if (!st) return;
  states.delete(wcId);
  const wc = webContents.fromId(wcId);
  try {
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      wc.debugger.removeListener('message', st.handler as never);
      wc.debugger.detach();
    }
  } catch { /* already gone */ }
}

// Detach everything on quit — never leave a debugger attached at teardown.
let quitHooked = false;
function hookQuit(): void {
  if (quitHooked) return;
  quitHooked = true;
  app.on('will-quit', () => { for (const id of [...states.keys()]) detach(id); });
}

/**
 * Run a network sub-command against the guest webContents `wcId`:
 *   start  — attach + enable + reset buffer
 *   list   — return buffered requests (auto-attaches; first call returns empty)
 *   clear  — empty the buffer (stays attached)
 *   stop   — detach
 */
export function handleNetworkOp(op: string, wcId: number): Record<string, unknown> {
  hookQuit();
  switch (op) {
    case 'stop':
      detach(wcId);
      return { ok: true, capturing: false, stopped: true };
    case 'clear': {
      const st = states.get(wcId);
      if (st) { st.buffer.length = 0; st.index.clear(); }
      return { ok: true, cleared: true, capturing: !!st };
    }
    case 'start': {
      detach(wcId); // reset any prior capture
      ensureAttached(wcId);
      return { ok: true, capturing: true, started: true, requests: [] };
    }
    case 'list':
    default: {
      const fresh = !states.has(wcId);
      ensureAttached(wcId);
      const st = states.get(wcId)!;
      return {
        ok: true,
        capturing: true,
        ...(fresh ? { started: true, note: 'capture just started — re-run after the page makes requests' } : {}),
        count: st.buffer.length,
        requests: st.buffer.map((e) => ({ ...e })),
      };
    }
  }
}

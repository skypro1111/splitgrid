import type { WebSocket } from 'ws';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ProducerMsg, SessionMeta, ViewerMsg } from './protocol.js';
import { config } from './config.js';

const { Terminal } = headless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

// The relay keeps the AUTHORITATIVE terminal state server-side: a headless xterm
// emulator per session, fed every byte the producer streams. That means a viewer
// that connects late — or simply refreshes the page — is replayed the REAL
// current screen (serialized as a valid escape stream), not a raw byte log that
// would garble a TUI or start mid-escape-sequence.
interface LiveSession {
  meta: SessionMeta;
  term: HeadlessTerminal;
  serializer: SerializeAddon;
}

function makeSession(meta: SessionMeta): LiveSession {
  const term = new Terminal({
    cols: meta.cols || 80,
    rows: meta.rows || 24,
    scrollback: config.scrollbackLines,
    allowProposedApi: true, // required by the serialize addon
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { meta, term, serializer };
}

// One room per WorkOS user. A user may have several producers (multiple devices)
// and several viewers (multiple browser tabs) connected at once; output from any
// producer fans out to every viewer in the same room.
class Room {
  readonly producers = new Set<WebSocket>();
  readonly viewers = new Set<WebSocket>();
  private readonly sessions = new Map<string, LiveSession>();

  get empty(): boolean {
    return this.producers.size === 0 && this.viewers.size === 0;
  }

  addProducer(ws: WebSocket): void {
    this.producers.add(ws);
  }

  removeProducer(ws: WebSocket): void {
    this.producers.delete(ws);
    // Last producer gone → the live terminals no longer exist. Tell viewers and
    // drop the emulators so a later reconnect starts from a clean slate.
    if (this.producers.size === 0) {
      for (const id of this.sessions.keys()) this.broadcast({ t: 'close', id });
      for (const s of this.sessions.values()) s.term.dispose();
      this.sessions.clear();
    }
  }

  addViewer(ws: WebSocket): void {
    this.viewers.add(ws);
    // Catch the new viewer up: the session list, then the real current screen of
    // each session (serialized from the headless emulator).
    this.send(ws, { t: 'sessions', sessions: [...this.sessions.values()].map((s) => s.meta) });
    for (const s of this.sessions.values()) {
      const snapshot = s.serializer.serialize();
      if (snapshot) this.send(ws, { t: 'snapshot', id: s.meta.id, buffer: snapshot });
    }
  }

  removeViewer(ws: WebSocket): void {
    this.viewers.delete(ws);
  }

  // Forward a viewer's keystrokes to the producer(s). Only for a session this
  // room currently knows about (i.e. one the desktop is actively streaming) —
  // input for an unknown/closed id is dropped, never reaching a PTY.
  inputFromViewer(id: string, data: string): void {
    if (!this.sessions.has(id)) return;
    const msg = JSON.stringify({ t: 'input', id, data });
    for (const p of this.producers) if (p.readyState === p.OPEN) p.send(msg);
  }

  // Apply a producer message: update server-side state, then fan out to viewers.
  ingest(msg: ProducerMsg): void {
    switch (msg.t) {
      case 'hello': {
        // `hello` is the producer's FULL authoritative set on (re)connect.
        // Reconcile to it exactly: upsert the listed sessions and drop any we
        // still hold that the producer no longer has (self-heals drift).
        const live = new Set(msg.sessions.map((m) => m.id));
        for (const id of [...this.sessions.keys()]) {
          if (!live.has(id)) {
            this.sessions.get(id)!.term.dispose();
            this.sessions.delete(id);
          }
        }
        for (const meta of msg.sessions) this.upsert(meta);
        this.broadcast({ t: 'sessions', sessions: [...this.sessions.values()].map((s) => s.meta) });
        break;
      }
      case 'open':
        this.upsert(msg.session);
        this.broadcast({ t: 'open', session: msg.session });
        break;
      case 'data': {
        const s = this.sessions.get(msg.id);
        if (s) s.term.write(msg.chunk); // keep the authoritative emulator current
        this.broadcast({ t: 'data', id: msg.id, chunk: msg.chunk });
        break;
      }
      case 'resize': {
        const s = this.sessions.get(msg.id);
        if (s) {
          s.meta.cols = msg.cols;
          s.meta.rows = msg.rows;
          s.term.resize(msg.cols, msg.rows);
        }
        this.broadcast({ t: 'resize', id: msg.id, cols: msg.cols, rows: msg.rows });
        break;
      }
      case 'close': {
        const s = this.sessions.get(msg.id);
        if (s) s.term.dispose();
        this.sessions.delete(msg.id);
        this.broadcast({ t: 'close', id: msg.id });
        break;
      }
    }
  }

  // Create or update a session. A re-announced session (producer reconnect) keeps
  // its existing emulator so the screen survives; only the metadata is refreshed.
  private upsert(meta: SessionMeta): void {
    const existing = this.sessions.get(meta.id);
    if (existing) {
      existing.meta = meta;
      if (existing.term.cols !== (meta.cols || 80) || existing.term.rows !== (meta.rows || 24)) {
        existing.term.resize(meta.cols || 80, meta.rows || 24);
      }
    } else {
      this.sessions.set(meta.id, makeSession(meta));
    }
  }

  private send(ws: WebSocket, msg: ViewerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ViewerMsg): void {
    const data = JSON.stringify(msg);
    for (const v of this.viewers) if (v.readyState === v.OPEN) v.send(data);
  }
}

const rooms = new Map<string, Room>();

export function roomFor(userId: string): Room {
  let r = rooms.get(userId);
  if (!r) {
    r = new Room();
    rooms.set(userId, r);
  }
  return r;
}

// Reclaim a room once both its producers and viewers are gone.
export function dropIfEmpty(userId: string): void {
  if (rooms.get(userId)?.empty) rooms.delete(userId);
}

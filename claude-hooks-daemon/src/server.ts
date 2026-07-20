#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { HookEvent, DaemonStatus } from './types.js';

const PORT = parseInt(process.env.CLAUDE_HOOKS_PORT || '19557', 10);
const MAX_EVENTS_PER_SESSION = 500;
const MAX_SESSIONS = 100;

// --- State ---

const sessions = new Map<string, HookEvent[]>();
const startedAt = Date.now();
let totalEvents = 0;

function storeEvent(event: HookEvent): void {
  let list = sessions.get(event.session_id);
  if (!list) {
    // evict oldest session if limit reached
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value!;
      sessions.delete(oldest);
    }
    list = [];
    sessions.set(event.session_id, list);
  }
  list.push(event);
  if (list.length > MAX_EVENTS_PER_SESSION) {
    list.shift();
  }
  totalEvents++;
}

// --- WebSocket ---

const httpServer = createServer(handleHTTP);
const wss = new WebSocketServer({ noServer: true });

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(event: HookEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// --- HTTP ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // POST /event — receive hook event
  if (req.method === 'POST' && url.pathname === '/event') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const event: HookEvent = {
        ...data,
        timestamp: Date.now(),
      };
      storeEvent(event);
      broadcast(event);
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // GET /status — daemon health
  if (req.method === 'GET' && url.pathname === '/status') {
    const status: DaemonStatus = {
      uptime: Date.now() - startedAt,
      sessions: sessions.size,
      totalEvents,
      port: PORT,
    };
    json(res, 200, status);
    return;
  }

  // GET /events?session_id=xxx — fetch stored events
  if (req.method === 'GET' && url.pathname === '/events') {
    const sessionId = url.searchParams.get('session_id');
    if (sessionId) {
      json(res, 200, sessions.get(sessionId) || []);
    } else {
      // all sessions summary
      const summary: Record<string, number> = {};
      for (const [id, events] of sessions) {
        summary[id] = events.length;
      }
      json(res, 200, summary);
    }
    return;
  }

  // GET /sessions — list active sessions with last event
  if (req.method === 'GET' && url.pathname === '/sessions') {
    const result: Array<{ session_id: string; event_count: number; last_event: HookEvent | null }> = [];
    for (const [id, events] of sessions) {
      result.push({
        session_id: id,
        event_count: events.length,
        last_event: events[events.length - 1] || null,
      });
    }
    json(res, 200, result);
    return;
  }

  json(res, 404, { error: 'Not found' });
}

// --- Upgrade WebSocket ---

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// --- Start ---

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-hooks-daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`  POST /event    — receive hook events`);
  console.log(`  GET  /status   — daemon health`);
  console.log(`  GET  /events   — stored events`);
  console.log(`  GET  /sessions — active sessions`);
  console.log(`  WS   /ws       — live event stream`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const ws of clients) ws.close();
  httpServer.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  for (const ws of clients) ws.close();
  httpServer.close(() => process.exit(0));
});

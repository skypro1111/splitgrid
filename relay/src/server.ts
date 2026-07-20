import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { isAllowed, verifyAccessToken, workos } from './workos.js';
import { dropIfEmpty, roomFor } from './rooms.js';
import type { ProducerMsg, ViewerInMsg } from './protocol.js';

const here = dirname(fileURLToPath(import.meta.url));

// Secure cookies require HTTPS; relax only for a plain-http local origin so dev
// still works. Production (https PUBLIC_URL) always gets Secure cookies.
const secureCookies = config.publicUrl.startsWith('https://');

const STATE_COOKIE = 'sg_oauth_state';

const app = Fastify({
  logger: {
    // Defense-in-depth: never let bearer tokens / session cookies reach the logs.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});
await app.register(cookie);
await app.register(websocket);
// index:false so the root isn't auto-served — the explicit, auth-gated `GET /`
// below owns it. Other assets (e.g. vendored xterm) are still served by path.
await app.register(staticPlugin, { root: join(here, '..', 'public'), index: false });

// The viewer page, read once. The signed-in user is injected per request so the
// page can show who's viewing without an extra round-trip.
const VIEWER_HTML = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
function renderViewer(user: ViewerUser): string {
  // Escape `<` so a value containing `</script>` can't break out of the tag.
  const json = JSON.stringify(user).replace(/</g, '\\u003c');
  return VIEWER_HTML.replace('</head>', `<script>window.__SG_USER__ = ${json};</script>\n</head>`);
}

// ── Web viewer auth (WorkOS AuthKit, server-side code flow) ──────────────────

app.get('/login', async (_req, reply) => {
  // CSRF protection for the OAuth flow: bind this login attempt to a random
  // state echoed back on /callback.
  const state = randomBytes(32).toString('base64url');
  reply.setCookie(STATE_COOKIE, state, {
    path: '/',
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    maxAge: 600, // 10 min to complete the login
  });
  const url = workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId: config.workos.clientId,
    redirectUri: `${config.publicUrl}/callback`,
    state,
  });
  return reply.redirect(url);
});

app.get('/callback', async (req, reply) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const expectedState = req.cookies[STATE_COOKIE];
  reply.clearCookie(STATE_COOKIE, { path: '/' });

  if (!code) return reply.code(400).send('missing authorization code');
  // Reject if the state is absent or doesn't match the cookie we set on /login.
  if (!state || !expectedState || state !== expectedState) {
    return reply.code(400).send('invalid OAuth state');
  }

  const { sealedSession } = await workos.userManagement.authenticateWithCode({
    clientId: config.workos.clientId,
    code,
    session: { sealSession: true, cookiePassword: config.workos.cookiePassword },
  });
  reply.setCookie(config.cookieName, sealedSession!, {
    path: '/',
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
  });
  return reply.redirect('/');
});

app.get('/logout', async (req, reply) => {
  const sealed = req.cookies[config.cookieName];
  reply.clearCookie(config.cookieName, { path: '/' });
  if (sealed) {
    try {
      const session = workos.userManagement.loadSealedSession({
        sessionData: sealed,
        cookiePassword: config.workos.cookiePassword,
      });
      return reply.redirect(await session.getLogoutUrl());
    } catch {
      /* fall through to home */
    }
  }
  return reply.redirect('/');
});

interface ViewerUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
}

// Resolve the signed-in viewer from the session cookie. Returns null when there
// is no valid session (expired/absent/tampered).
async function viewerUser(sealed: string | undefined): Promise<ViewerUser | null> {
  if (!sealed) return null;
  try {
    const session = workos.userManagement.loadSealedSession({
      sessionData: sealed,
      cookiePassword: config.workos.cookiePassword,
    });
    const result = await session.authenticate();
    if (result.authenticated) {
      const u = result.user;
      return {
        id: u.id,
        email: u.email,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        profilePictureUrl: u.profilePictureUrl ?? null,
      };
    }
  } catch {
    /* invalid/expired cookie */
  }
  return null;
}

// Auth-gated viewer page: no valid session → straight to /login (no flash of an
// empty viewer, and the HTML itself isn't served to anonymous visitors).
app.get('/', async (req, reply) => {
  const user = await viewerUser(req.cookies[config.cookieName]);
  if (!user || !isAllowed(user.id)) return reply.redirect('/login');
  return reply.type('text/html').send(renderViewer(user));
});

// ── WebSockets ───────────────────────────────────────────────────────────────

// Desktop producer: authenticated by a WorkOS access token in the
// `Authorization: Bearer` header (never the query string — it would land in
// access logs). The desktop producer is a Node client and can set the header on
// the WS upgrade.
app.get('/ws/producer', { websocket: true }, async (socket, req) => {
  const token = bearer(req);
  if (!token) {
    req.log.warn('producer rejected: no bearer token (auth header not received)');
    socket.close(4401, 'unauthorized');
    return;
  }
  let userId: string;
  try {
    const v = await verifyAccessToken(token);
    if (!isAllowed(v.userId)) throw new Error(`user ${v.userId} not in allowlist`);
    userId = v.userId;
  } catch (err) {
    // Decode (NOT verify) the token claims to diagnose mismatches. iss/exp/sub
    // aren't secrets; the signature/token body is never logged.
    let claims = '(undecodable)';
    try {
      const p = JSON.parse(Buffer.from((token.split('.')[1] ?? ''), 'base64url').toString('utf8'));
      claims = `iss=${p.iss} aud=${p.aud ?? '∅'} sub=${p.sub} exp=${p.exp}`;
    } catch { /* not a JWT */ }
    req.log.warn(`producer rejected: ${(err as Error).message} | token { ${claims} } | now=${Math.floor(Date.now() / 1000)}`);
    socket.close(4401, 'unauthorized');
    return;
  }

  const room = roomFor(userId);
  room.addProducer(socket);
  socket.on('message', (raw: Buffer) => {
    let msg: ProducerMsg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    room.ingest(msg);
  });
  socket.on('close', () => {
    room.removeProducer(socket);
    dropIfEmpty(userId);
  });
});

// Web viewer: authenticated by the session cookie. The only message it may send
// upstream is `input` (keystrokes), forwarded to the same user's producer(s).
app.get('/ws/viewer', { websocket: true }, async (socket, req) => {
  const user = await viewerUser(req.cookies[config.cookieName]);
  if (!user || !isAllowed(user.id)) {
    socket.close(4401, 'unauthorized');
    return;
  }
  const room = roomFor(user.id);
  room.addViewer(socket);
  socket.on('message', (raw: Buffer) => {
    let msg: ViewerInMsg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg && msg.t === 'input' && typeof msg.id === 'string' && typeof msg.data === 'string') {
      room.inputFromViewer(msg.id, msg.data);
    }
  });
  socket.on('close', () => {
    room.removeViewer(socket);
    dropIfEmpty(user.id);
  });
});

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`relay listening — public origin ${config.publicUrl}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

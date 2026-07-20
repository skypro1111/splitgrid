# SplitGrid relay

Streams terminal output from the SplitGrid desktop app to the web, read-only,
authenticated with [WorkOS AuthKit](https://workos.com/docs/authkit).

```
Desktop (Electron)            Relay (this service)              Web viewer
─────────────────             ────────────────────             ──────────
AuthKit PKCE via       ──►    /ws/producer                
workos-auth:// deep link      verify access-token JWT (JWKS)
push terminal output          route by `sub` → Room[userId]
                              /login /callback (AuthKit)  ◄──   redirect login
                              sealed session cookie
                              /ws/viewer (cookie auth)    ──►    xterm.js render
```

One **room per WorkOS user** (`sub`). A user can connect several producers
(devices) and several viewers (tabs); output fans out to every viewer in the
room. Viewers are read-only — nothing they send reaches a PTY.

## Prerequisites — WorkOS dashboard (your action)

These can't be scripted; do them once at <https://dashboard.workos.com>:

1. Create an **AuthKit** application (or use an existing one).
2. Copy the **API key** (`sk_...`) and **Client ID** (`client_...`).
3. Under **Redirect URIs**, add both:
   - `workos-auth://callback` — the desktop app (deep link).
   - `https://<relay-domain>/callback` — this relay's web login, e.g.
     `https://stream.splitgrid.dev/callback`.
4. Enable the **Google** social connection (or email/password) in AuthKit.
5. (Optional, recommended for single-user) After your first login, note your
   WorkOS **user id** (`user_...`) and put it in `ALLOWED_USER_IDS` so only your
   account is accepted.

## Local run

```sh
cd relay
cp .env.example .env        # fill in WORKOS_* and PUBLIC_URL
npm install
npm run dev                 # http://localhost:8787  (set PUBLIC_URL accordingly)
```

For a purely local test set `PUBLIC_URL=http://localhost:8787` and register
`http://localhost:8787/callback` as a redirect URI in WorkOS.

## Deploy (Oracle box, behind the existing nginx)

Runs on `PORT` (default 8787) bound to localhost; the existing nginx terminates
TLS for `stream.splitgrid.dev` and proxies HTTP **and** WebSocket upgrades:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;       # WebSocket upgrade
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 1h;                         # keep idle WS alive
}
```

Reuse the Let's Encrypt setup already covering splitgrid.dev (add the
`stream.` subdomain to the cert). A `Dockerfile` is included for parity with the
landing-page deployment.

## Before production

- **Vendor xterm** into `public/` instead of the jsDelivr CDN (removes the
  CDN-compromise / SRI concern). `public/index.html` has a note where.
- Buffers are in-memory; a relay restart drops scrollback (producers re-send on
  reconnect). Fine for a single node — revisit if you scale out.

## Layout

| File | Purpose |
|------|---------|
| `src/config.ts`   | env config + single-user allowlist |
| `src/workos.ts`   | WorkOS client, access-token JWT verification, allowlist gate |
| `src/protocol.ts` | producer/viewer wire message types |
| `src/rooms.ts`    | per-user rooms, scrollback, fan-out |
| `src/server.ts`   | Fastify: auth routes + producer/viewer WebSockets |
| `public/index.html` | read-only xterm.js viewer |

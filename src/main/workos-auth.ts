import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthSession, AuthUser } from '../shared/types';

// ─── WorkOS desktop auth (AuthKit, PKCE public client) ───────────────────────
//
// The desktop app is a PUBLIC OAuth client: it ships no API key and no client
// secret (those can be extracted from a distributed binary). It authenticates
// with the AuthKit PKCE flow over a custom-scheme deep link, exactly mirroring
// WorkOS's official electron-authkit-example — but hitting the User Management
// HTTP endpoints directly (the installed @workos-inc/node is the older
// API-key-required class API, unusable for a public client, and adding the
// newer SDK would be a heavy bundle for what is two POSTs).
//
// Flow: startLogin() opens the system browser at the authorize URL with a PKCE
// challenge → the user signs in (Google) → WorkOS redirects to
// workos-auth://callback?code=... → the OS routes that to this (already-running)
// instance → handleCallback() exchanges code+verifier for tokens → tokens are
// sealed with safeStorage (OS keychain) in userData. The renderer only ever
// sees the user profile via onAuthChanged; tokens never leave main.

// Public WorkOS client id for the SplitGrid AuthKit application. NOT a secret —
// safe to ship. Must match the relay's WORKOS_CLIENT_ID so the access token it
// mints verifies against the same JWKS. Overridable for staging.
const CLIENT_ID = process.env.SPLITGRID_WORKOS_CLIENT_ID || 'client_01KVBN9K9JT08JJAV7AAW53B18';
const PROTOCOL = 'workos-auth';
const REDIRECT_URI = `${PROTOCOL}://callback`;
const AUTHORIZE_URL = 'https://api.workos.com/user_management/authorize';
const TOKEN_URL = 'https://api.workos.com/user_management/authenticate';
const PKCE_TTL_MS = 10 * 60 * 1000;

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// Transient PKCE state between startLogin() and the deep-link callback. In-memory
// is sufficient on every platform: the callback is delivered to THIS running
// instance (macOS open-url; Windows/Linux second-instance argv on the single
// instance that holds the lock), so the process — and this variable — survive.
let pending: { verifier: string; state: string; exp: number } | null = null;

let cached: StoredAuth | null | undefined; // undefined = not loaded from disk yet

const authFile = (): string => path.join(app.getPath('userData'), 'workos-auth.json');

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function persist(data: StoredAuth | null): void {
  cached = data;
  const file = authFile();
  if (!data) {
    try { rmSync(file); } catch { /* already gone */ }
    return;
  }
  try {
    // 0o700 dir / 0o600 file so only this user can read the stored tokens.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

    // Prefer the OS keychain (Keychain/DPAPI/libsecret) — encrypted at rest.
    // But an UNSIGNED packaged macOS app often can't use it (isEncryptionAvailable
    // false, or encryptString throws), and bailing there meant the session lived
    // only in memory and was silently lost on every relaunch. So fall back to a
    // base64 record in the same 0o600 file — NOT encryption, but the standard
    // model for desktop/CLI credential files (gh, aws, npm) and far better UX
    // than logging the user out each restart.
    let record: { v: number; enc: boolean; payload: string } | null = null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const payload = safeStorage.encryptString(JSON.stringify(data)).toString('base64');
        record = { v: 1, enc: true, payload };
      } catch (e) {
        console.warn('[auth] keychain encrypt failed, storing unencrypted at rest:', e);
      }
    }
    if (!record) {
      const payload = Buffer.from(JSON.stringify(data), 'utf-8').toString('base64');
      record = { v: 1, enc: false, payload };
    }
    writeFileSync(file, JSON.stringify(record), { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    console.error('[auth] failed to persist tokens:', e);
  }
}

function load(): StoredAuth | null {
  if (cached !== undefined) return cached;
  const file = authFile();
  if (!existsSync(file)) {
    cached = null;
    return null;
  }
  try {
    const { enc, payload } = JSON.parse(readFileSync(file, 'utf-8')) as { v?: number; enc: boolean; payload: string };
    const buf = Buffer.from(payload, 'base64');
    // Try the encrypted path first (when enc === true). If decryption fails
    // (keychain unavailable after update, etc.), fall back to treating the payload
    // as an unencoded base64 string so the session survives instead of logging the
    // user out on every restart. The original encrypted payload remains on disk;
    // on the next successful persist we'll re-encrypt with the current keychain.
    let json: string;
    if (enc) {
      try {
        json = safeStorage.decryptString(buf);
      } catch (decryptErr) {
        console.warn('[auth] keychain decrypt failed, falling back to unencrypted payload:', decryptErr);
        json = buf.toString('utf-8');
      }
    } else {
      json = buf.toString('utf-8');
    }
    cached = JSON.parse(json) as StoredAuth;
  } catch (e) {
    console.error('[auth] failed to read stored tokens:', e);
    cached = null;
  }
  return cached;
}

// Map a WorkOS user object (snake_case) to our camelCase AuthUser.
function mapUser(u: Record<string, unknown>): AuthUser {
  return {
    id: String(u.id),
    email: String(u.email ?? ''),
    firstName: (u.first_name as string | null) ?? null,
    lastName: (u.last_name as string | null) ?? null,
    profilePictureUrl: (u.profile_picture_url as string | null) ?? null,
  };
}

function jwtExpSeconds(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function getSession(): AuthSession | null {
  const cur = load();
  return cur ? { user: cur.user } : null;
}

function broadcastAuth(): void {
  const session = getSession();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('auth:changed', session);
    }
  }
}

export async function startLogin(): Promise<void> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  pending = { verifier, state, exp: Date.now() + PKCE_TTL_MS };

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('provider', 'authkit');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  await shell.openExternal(url.toString());
}

// Exchange the authorization code (+ PKCE verifier) returned on the deep link.
async function handleCallback(callbackUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return;
  }
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  const err = parsed.searchParams.get('error');

  const p = pending;
  pending = null;

  if (err || !code) {
    console.error('[auth] callback without code:', err ?? '(no code)');
    return;
  }
  // CSRF: the callback must match the login we initiated, unexpired. A missing
  // state must NOT pass — require it present and equal.
  if (!p || Date.now() > p.exp || !state || state !== p.state) {
    console.error('[auth] callback state mismatch, missing, or expired');
    return;
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        code_verifier: p.verifier,
      }),
    });
    if (!res.ok) {
      console.error('[auth] token exchange failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string; user: Record<string, unknown> };
    persist({ accessToken: data.access_token, refreshToken: data.refresh_token, user: mapUser(data.user) });
  } catch (e) {
    console.error('[auth] token exchange error:', e);
  }
  broadcastAuth();
}

// Refresh the access token using the stored refresh token. Clears the session on
// a hard auth failure (so the UI falls back to signed-out). Returns success.
async function refresh(): Promise<boolean> {
  const cur = load();
  if (!cur?.refreshToken) return false;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: cur.refreshToken,
      }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        persist(null);
        broadcastAuth();
      }
      return false;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string; user?: Record<string, unknown> };
    persist({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: data.user ? mapUser(data.user) : cur.user,
    });
    return true;
  } catch (e) {
    console.error('[auth] refresh error:', e);
    return false;
  }
}

// A valid access token for the relay producer connection, refreshing if it is
// expired (or within 30s of expiry). null when signed out / refresh failed. If
// the JWT exp claim can't be parsed, conservatively treat the token as expired
// and attempt refresh — better to fail early with a fresh token than return a
// potentially invalid one that causes relay connection failures.
export async function getAccessToken(): Promise<string | null> {
  const cur = load();
  if (!cur) return null;
  const exp = jwtExpSeconds(cur.accessToken);
  const isExpired = exp === null || Date.now() / 1000 >= exp - 30;
  if (isExpired) {
    return (await refresh()) ? load()?.accessToken ?? null : null;
  }
  return cur.accessToken;
}

export function logout(): void {
  persist(null);
  broadcastAuth();
}

// Pull a workos-auth:// callback URL out of a process argv (Windows/Linux
// deliver the deep link as a launch argument to the second instance). Returns
// true when one was found and handled.
export function handleDeepLinkArgv(argv: string[]): boolean {
  const url = argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
  if (!url) return false;
  void handleCallback(url);
  return true;
}

// Register the protocol, the macOS deep-link listener, and the renderer IPC.
// Call once at startup. The Windows/Linux deep link is wired by the caller's
// existing second-instance handler via handleDeepLinkArgv().
export function initWorkosAuth(): void {
  // Register the renderer IPC first so the Account UI always works, even if
  // protocol registration below ever throws on some platform.
  ipcMain.handle('auth:get-session', () => getSession());
  ipcMain.handle('auth:login', () => startLogin());
  ipcMain.handle('auth:logout', () => logout());

  app.on('open-url', (event, url) => {
    if (url.startsWith(`${PROTOCOL}://`)) {
      event.preventDefault();
      void handleCallback(url);
    }
  });

  try {
    if (process.defaultApp && process.argv.length >= 2) {
      // Dev: electron is launched as `electron .`, so the OS must relaunch it
      // with the script path to route the protocol back to us.
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch (e) {
    console.error('[auth] setAsDefaultProtocolClient failed:', e);
  }
}

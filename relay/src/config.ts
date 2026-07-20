import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const clientId = req('WORKOS_CLIENT_ID');

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  // Public origin of the relay (no trailing slash), e.g. https://stream.splitgrid.dev.
  // The OAuth redirect URI is derived from this and must match the WorkOS dashboard.
  publicUrl: req('PUBLIC_URL').replace(/\/$/, ''),

  workos: {
    apiKey: req('WORKOS_API_KEY'),
    clientId,
    // Seals the session cookie; must be >= 32 chars.
    cookiePassword: req('WORKOS_COOKIE_PASSWORD'),
    // Per-client JWKS — used to verify desktop access tokens.
    jwksUrl: `https://api.workos.com/sso/jwks/${clientId}`,
  },

  // Client ids whose access tokens the producer endpoint accepts. With WorkOS's
  // Applications model, the web AuthKit flow runs under one client (WORKOS_CLIENT_ID,
  // which carries the homepage/redirect config) but the access token is signed by
  // the ENVIRONMENT's AuthKit client, so its `iss` names a different client id.
  // List every client id that may sign a valid token (comma-separated); each is
  // verified against its own JWKS. Defaults to just WORKOS_CLIENT_ID.
  acceptedClientIds: [
    ...new Set([
      clientId,
      ...(process.env.ACCEPTED_TOKEN_CLIENT_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ],

  // Optional single-user allowlist (comma-separated WorkOS user ids). Empty =
  // allow any authenticated user, each isolated to their own room by sub.
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  cookieName: 'sg_session',
  // Scrollback lines kept per terminal in the server-side headless emulator, so
  // a late-joining (or page-refreshing) viewer is sent the real current screen
  // plus history instead of a blank one.
  scrollbackLines: Number(process.env.SCROLLBACK_LINES ?? 5000),
} as const;

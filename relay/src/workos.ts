import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';

export const workos = new WorkOS(config.workos.apiKey, { clientId: config.workos.clientId });

// One JWKS per accepted client id (the token's `iss` names which client signed
// it; we verify against THAT client's keys). Lazily created + cached.
const jwksByClient = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(clientId: string) {
  let set = jwksByClient.get(clientId);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));
    jwksByClient.set(clientId, set);
  }
  return set;
}

// Pull the client id out of a WorkOS issuer like
// `https://api.workos.com/user_management/<clientId>`.
function clientIdFromIss(iss: unknown): string | null {
  if (typeof iss !== 'string') return null;
  const m = iss.match(/\/user_management\/(client_[A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

export interface VerifiedToken {
  userId: string; // `sub`
  sessionId?: string; // `sid`
}

// Verify a WorkOS access token presented by a desktop producer. The token may be
// signed by any of the accepted clients (WorkOS Applications: the env's AuthKit
// client signs tokens even when the flow ran under a different application
// client) — we read the token's own `iss`, require its client to be allow-listed,
// then verify against that client's JWKS. No `audience` pin (AuthKit tokens carry
// no `aud`); RS256 enforced.
export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(token);
  } catch {
    throw new Error('malformed token');
  }
  const tokenClient = clientIdFromIss(unverified.iss);
  if (!tokenClient || !config.acceptedClientIds.includes(tokenClient)) {
    throw new Error(`issuer client not accepted: ${tokenClient ?? '∅'}`);
  }
  const { payload } = await jwtVerify(token, jwksFor(tokenClient), {
    issuer: unverified.iss as string,
    algorithms: ['RS256'],
  });
  if (typeof payload.sub !== 'string') throw new Error('token missing sub');
  return {
    userId: payload.sub,
    sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
  };
}

// Single-user gate: empty allowlist = allow anyone (each user gets their own
// room); non-empty = only the listed WorkOS user ids.
export function isAllowed(userId: string): boolean {
  return config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId);
}

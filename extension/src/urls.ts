// ─── URL / origin helpers ────────────────────────────────────────────────────
// Shared by the popup (what may be activated), the registry (revocation checks)
// and the executor (what may be driven). Kept dependency-free so every context
// can import it.

/**
 * Pages the extension can never drive, whatever permissions say. Chrome refuses
 * script injection and debugger attach on its own surfaces, and deliberately
 * blocks extensions on the Web Store so a page can't install things for you.
 */
const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-native:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'data:',
  'blob:',
  'file:',
  'javascript:',
];

const RESTRICTED_HOSTS = [
  'chrome.google.com', // legacy Web Store host
  'chromewebstore.google.com',
  'microsoftedge.microsoft.com',
];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `https://example.com:8443` — the strict identity we pin a tab to. */
export function originOf(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  // `origin` is the string "null" for opaque origins (data:, sandboxed).
  return u.origin && u.origin !== 'null' ? u.origin : null;
}

/**
 * The match pattern we ask `chrome.permissions.request()` for. Chrome match
 * patterns have no port component — a host pattern covers every port — so the
 * grant is host-wide while the registry still pins the tab to the full origin.
 * The stricter of the two wins, which is the origin.
 */
export function permissionPatternFor(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return `${u.protocol}//${u.hostname}/*`;
}

export function isRestrictedUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return true;
  if (RESTRICTED_SCHEMES.includes(u.protocol)) return true;
  if (u.protocol === 'https:' && RESTRICTED_HOSTS.includes(u.hostname)) return true;
  return false;
}

/** A tab the user is allowed to hand over: a real http(s) page, not a Chrome surface. */
export function isControllableUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isRestrictedUrl(url);
}

/** Short "example.com" style label for the popup. */
export function hostLabel(url: string): string {
  const u = parse(url);
  return u ? u.host || u.protocol : url;
}

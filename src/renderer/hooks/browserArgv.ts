// ─── Agent browser CLI argv parsing (pure) ───────────────────────────────────
// Extracted from useBrowserAgentBridge so the flag/positional parsing can be
// unit-tested without React, the browser registry, or a live <webview>. Pulls
// the known flags out of an argv array and returns the rest as positionals.

// Wait commands cap below the bridge's 35s request timeout so a real timeout
// comes back as a clean reply, never a transport error.
export const MAX_WAIT_MS = 30_000;

export interface ParsedArgv {
  positional: string[];
  target?: string;
  timeoutMs?: number;
  viewport: boolean;
  full: boolean;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  let target: string | undefined;
  let timeoutMs: number | undefined;
  let viewport = false;
  let full = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '--surface') { target = argv[++i]; continue; }
    if (a === '--timeout' || a === '-t') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(n)));
      continue;
    }
    if (a === '--viewport') { viewport = true; continue; }
    if (a === '--full' || a === '--fullpage') { full = true; continue; }
    positional.push(a);
  }
  return { positional, target, timeoutMs, viewport, full };
}

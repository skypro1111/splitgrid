// ─── WSL integration (Windows) ───────────────────────────────────────────────
// Treat each installed WSL distro as a first-class shell target: spawning
// `wsl.exe -d <distro>` drops the user into a real Linux login shell (bash/zsh
// with the full GNU userland), not the half-emulated Git Bash. A WSL target is
// encoded in the `shell` string as the sentinel `wsl:<distro>` so it round-trips
// through Settings / session restore like any other shell path; createShell()
// recognises the prefix and translates it to the actual wsl.exe invocation.
//
// All of this is Windows-only; on macOS/Linux every export here is inert.
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

export const WSL_SHELL_PREFIX = 'wsl:';

export function isWslShell(shell: string | undefined): boolean {
  return !!shell && shell.startsWith(WSL_SHELL_PREFIX);
}

export function wslDistroFromShell(shell: string): string {
  return shell.slice(WSL_SHELL_PREFIX.length);
}

export function wslShellFor(distro: string): string {
  return WSL_SHELL_PREFIX + distro;
}

export function wslExePath(): string {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(sysRoot, 'System32', 'wsl.exe');
}

// Distros that `wsl -l` reports but that are Docker Desktop's internal plumbing,
// not user shells — never offer them as a terminal.
const INTERNAL_DISTRO_RE = /^docker-desktop(-data)?$/i;

let cachedDistros: string[] | null = null;
let inFlight: Promise<string[]> | null = null;

function runWsl(args: string[], timeoutMs = 4000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      wslExePath(),
      args,
      { encoding: 'buffer', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout as Buffer)),
    );
  });
}

// Enumerate installed WSL distros. `wsl -l -q` prints just the names, one per
// line — but as UTF-16LE with a BOM (a classic gotcha: decoded as UTF-8 it comes
// out as garbage interleaved with NULs). Result is cached for the app session;
// the first call wakes the WSL service and can take ~1s.
export async function detectWslDistros(force = false): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  if (!force && cachedDistros) return cachedDistros;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const buf = await runWsl(['--list', '--quiet']);
      // utf16le decode leaves a BOM (U+FEFF) and may keep stray NULs; strip both.
      const text = buf.toString('utf16le').replace(/[\uFEFF\u0000]/g, '');
      const distros = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((name) => !INTERNAL_DISTRO_RE.test(name));
      cachedDistros = distros;
      return distros;
    } catch {
      cachedDistros = [];
      return [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Synchronous view of the last detection (false until detectWslDistros resolves
// once). Used at receiver-startup to decide the bind interface without blocking.
export function hasWslDistrosCached(): boolean {
  return !!cachedDistros && cachedDistros.length > 0;
}

// The host's IPv4 on the WSL NAT subnet — the "vEthernet (WSL)" adapter, which a
// default-NAT distro uses as its default gateway to reach the host. This subnet
// is host↔WSL only (not routable from the physical LAN), so binding the receiver
// to this address exposes it to WSL without exposing it to the network at large.
// Returns undefined under mirrored networking (no such adapter) — there 127.0.0.1
// already reaches the host, so no extra bind is needed.
export function wslHostInterfaceIp(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/wsl/i.test(name) || !addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && a.address) return a.address;
    }
  }
  return undefined;
}

import * as pty from 'node-pty';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeWslOutput } from './wsl-encoding';
import { parseWslScan, aggregateWslTerminal, type WslRow } from './wsl-metrics';
import { existsSync, appendFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { RECEIVER_PORT } from './agent-activity-receiver';
import { BROWSER_TOKEN } from './agent-browser-bridge';
import { bridgeDirPath } from './agent-file-bridge';
import { hookHelperPath, browserHelperPath, terminalHelperPath, sqlHelperPath } from './agent-hooks/paths';
import {
  detectWslDistros, isWslShell, wslDistroFromShell, wslShellFor, wslExePath,
} from './wsl';
import { AGENT_COMMANDS } from '../shared/types';
import type {
  TerminalSessionInfo,
  LocalShellConfig,
  TerminalResourceInfo,
  TerminalProcessInfo,
  TerminalListenPort,
  KillProcessResult,
  ShellOption,
} from '../shared/types';

const MAX_BUFFER_SIZE = 100_000;

// Gate for injecting splitgrid's SPLITGRID_* env (agent hooks + browser control) into
// spawned terminals. Off until the user opts into agent integrations in
// Settings; applies to terminals spawned after the change. See agent-integrations.ts.
let agentIntegrationsEnabled = false;
export function setAgentIntegrationsEnabled(enabled: boolean): void {
  agentIntegrationsEnabled = enabled;
}

// Sub-gate (only matters while agentIntegrationsEnabled): inject the
// SPLITGRID_TERMINAL_* env so an agent can drive the other terminals in its
// workspace. Off until the user opts into terminal control in Settings.
let terminalControlEnabled = false;
export function setAgentTerminalControlEnabled(enabled: boolean): void {
  terminalControlEnabled = enabled;
}

// Sub-gate (only matters while agentIntegrationsEnabled): inject the
// SPLITGRID_SQL_* env so an agent can query/inspect/export against the SQL
// component. Off until the user opts into SQL control in Settings.
let sqlControlEnabled = false;
export function setAgentSqlControlEnabled(enabled: boolean): void {
  sqlControlEnabled = enabled;
}
// Read accessor for the SQL bridge's server-side hard-refuse gate (Phase B). The
// /sql endpoint reuses the SHARED agent token, so an agent with only browser/
// terminal control still holds it and could POST to /sql — env-injection gating
// alone is insufficient. The bridge consults this BEFORE forwarding to the
// renderer, so SQL is authoritatively off in main when the user hasn't opted in.
export function isAgentSqlControlEnabled(): boolean {
  return sqlControlEnabled;
}

// Sub-sub-gate (only matters while sqlControlEnabled): exposes the
// SPLITGRID_SQL_WRITE=1 capability HINT so the CLI/skill can advertise that
// write/DDL is allowed. This env var is only a hint — the real enforcement is
// server-side in the renderer dispatch (Phase B); exposing it is cheap and
// matches how the agent learns its current state.
let sqlWriteEnabled = false;
export function setAgentSqlWriteEnabled(enabled: boolean): void {
  sqlWriteEnabled = enabled;
}
// Read accessor for the SQL write gate (Phase B). The value is passed to the
// renderer per-command (in the sql:command payload) so the renderer classifies
// statements but can NEVER self-grant write — the authoritative flag always
// comes from main on each call.
export function isAgentSqlWriteEnabled(): boolean {
  return sqlWriteEnabled;
}

// TEMP diagnostics for the WSL terminal crash: trace the spawn intent + outcome
// to ~/splitgrid-terminal-debug.log. If "spawn intent" is logged but neither "spawn
// OK" nor a caught error follows before the app dies, the crash is inside
// node-pty's native spawn (ConPTY) rather than catchable JS.
function termDbg(msg: string): void {
  try {
    appendFileSync(path.join(os.homedir(), 'splitgrid-terminal-debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* best-effort */ }
}

// ─── Shell discovery (Windows) ───────────────────────────────────────────────
// Detect the shells installed on this machine so the user can pick a default in
// Settings. Windows only for now (cmd / PowerShell / PowerShell 7 / Git Bash +
// any installed WSL distro); on macOS/Linux the login shell ($SHELL) is used and
// this returns []. Each option's `path` is what createShell resolves: a real exe
// path for native shells, or the `wsl:<distro>` sentinel for a WSL target.
export async function detectShells(): Promise<ShellOption[]> {
  if (process.platform !== 'win32') return [];
  const out: ShellOption[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, p: string | undefined) => {
    if (!p || seen.has(p.toLowerCase()) || !existsSync(p)) return;
    seen.add(p.toLowerCase());
    out.push({ id, label, path: p });
  };
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pfW64 = process.env.ProgramW6432;
  const localApp = process.env.LOCALAPPDATA;

  add('cmd', 'Command Prompt', process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe'));
  add('powershell', 'Windows PowerShell', path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  // PowerShell 7+
  for (const base of [pf, pfW64, pfX86].filter(Boolean) as string[]) {
    add('pwsh', 'PowerShell 7', path.join(base, 'PowerShell', '7', 'pwsh.exe'));
  }
  // Git Bash
  for (const base of [pf, pfX86, localApp ? path.join(localApp, 'Programs') : ''].filter(Boolean) as string[]) {
    add('git-bash', 'Git Bash', path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  // WSL distros: each becomes a `wsl:<distro>` target. The path is a sentinel,
  // not a file on disk, so it bypasses the existsSync gate in add().
  for (const distro of await detectWslDistros()) {
    out.push({ id: `wsl:${distro}`, label: `WSL: ${distro}`, path: wslShellFor(distro) });
  }
  return out;
}

// Arguments to spawn a given shell with. POSIX shells are launched as a login
// shell (-l) so profiles load; on Windows the args depend on the shell family:
// Git Bash wants an interactive login shell, PowerShell a clean prompt, cmd none.
function shellArgsFor(shellPath: string, isWindows: boolean): string[] {
  if (!isWindows) return ['-l'];
  const base = (shellPath.split(/[\\/]/).pop() || shellPath).toLowerCase();
  if (base.includes('bash')) return ['--login', '-i'];
  if (base === 'powershell.exe' || base === 'pwsh.exe') return ['-NoLogo'];
  return []; // cmd.exe, wsl.exe, or anything else
}

interface LocalShellSession {
  pty: pty.IPty;
  info: TerminalSessionInfo;
  buffer: string;
  inputBytes: number;
  outputBytes: number;
  lastDataAt?: number;
  closing: boolean;
  onDataDispose?: { dispose: () => void };
  onExitDispose?: { dispose: () => void };
}

interface ShellCallbacks {
  onData: (sessionId: string, data: string) => void;
  onReady: (sessionId: string) => void;
  onClose: (sessionId: string, info?: { exitedCleanly: boolean }) => void;
  onError: (sessionId: string, message: string) => void;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssBytes: number;
  command: string;
}

// Per-process row for the metrics query: process-group ids (to find the
// terminal's foreground job) and cumulative CPU time (to derive *instantaneous*
// CPU between snapshots — ps %cpu is a lifetime average and is useless for
// "is it working right now").
interface MetricRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  rssBytes: number;
  cpuSeconds: number;
  command: string;
}

// Parse ps `time=` ([DD-]HH:MM:SS or MM:SS.ss) into total seconds.
function parseCpuTimeSeconds(value: string): number {
  const t = value.trim();
  if (!t) return 0;
  let days = 0;
  let rest = t;
  const dash = t.indexOf('-');
  if (dash >= 0) {
    days = Number(t.slice(0, dash)) || 0;
    rest = t.slice(dash + 1);
  }
  let seconds = 0;
  for (const part of rest.split(':')) {
    const n = Number(part);
    seconds = seconds * 60 + (Number.isFinite(n) ? n : 0);
  }
  return days * 86400 + seconds;
}

// Previous CPU-time sample per PTY root, to compute instantaneous CPU%.
const prevTreeCpu = new Map<number, { cpuSeconds: number; at: number; percent: number }>();

// Same, but for WSL terminals — keyed by the splitgrid terminal id (= SPLITGRID_TERMINAL)
// rather than a pty pid, because the Windows wsl.exe pid is meaningless inside the
// distro where the real CPU time lives.
const prevWslCpu = new Map<string, { cpuSeconds: number; at: number; percent: number }>();

// Per-process cumulative CPU samples for the Processes popover's instantaneous
// per-row CPU% (the tree maps above are per-PTY-root totals; these are per-pid).
// Native Windows is keyed by pid; WSL by `${terminalId}:${pid}` since pids are
// only unique within a distro. Entries older than 30s (popover closed) are swept.
const prevWinProcCpu = new Map<number, { cpuSeconds: number; at: number; percent: number }>();
const prevWslProcCpu = new Map<string, { cpuSeconds: number; at: number; percent: number }>();
const PROC_CPU_TTL_MS = 30_000;

const INTERPRETER_RE = /^(node|nodejs|bun|deno|python|python3|ruby|php|npx|pnpm|yarn|sh|bash|zsh)$/i;
// Agent CLIs the foreground-process labeler recognizes by name. Shared with the
// renderer (see AGENT_COMMANDS in shared/types) so "what counts as an agent" has
// one definition across the main/renderer split.
const KNOWN_AGENTS = AGENT_COMMANDS;

// Split a command line into tokens, treating a double-quoted run (which may
// contain spaces) as a single token. Good enough for label extraction across
// POSIX and Windows command lines; doesn't try to handle escaped quotes.
function tokenizeCommand(cmd: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;
    if (cmd[i] === '"') {
      const end = cmd.indexOf('"', i + 1);
      if (end === -1) { toks.push(cmd.slice(i + 1)); break; }
      toks.push(cmd.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < cmd.length && !/\s/.test(cmd[j])) j++;
      toks.push(cmd.slice(i, j));
      i = j;
    }
  }
  return toks;
}

// Turn a full command line into a short, friendly process name for the UI:
// agent CLIs by name (claude/codex/cursor), interpreters by their script, else
// the executable basename. e.g. "node /x/claude/cli.js --foo" -> "claude".
function deriveProcessLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const hay = trimmed.toLowerCase();
  for (const agent of KNOWN_AGENTS) {
    if (hay.includes(agent)) return agent;
  }
  // Tokenize respecting Windows quoting: a path with spaces is wrapped in double
  // quotes, e.g. `"C:\Program Files\…\pwsh.exe" "C:\my proj\app.js"`. Naïve
  // whitespace splitting would cut those paths at the first internal space.
  const toks = tokenizeCommand(trimmed);
  const first = toks[0] ?? '';
  const restParts = toks.slice(1);
  // Basename across both POSIX (/) and Windows (\) separators; drop a leading
  // '-' (login shells), surrounding quotes, a trailing ':' (ps quirk), and an
  // .exe/.cmd/.bat/.com suffix so Windows shows "powershell" not "powershell.exe".
  const baseName = (p: string): string =>
    (p.replace(/^-/, '').replace(/"/g, '').split(/[\\/]/).pop() || p).replace(/:$/, '').replace(/\.(exe|cmd|bat|com)$/i, '');
  const exeBase = baseName(first);
  if (INTERPRETER_RE.test(exeBase)) {
    for (const arg of restParts) {
      if (arg.startsWith('-')) continue;
      const base = arg.replace(/"/g, '').split(/[\\/]/).pop() || arg;
      return base.replace(/\.(js|mjs|cjs|ts|py|rb)$/i, '') || exeBase;
    }
  }
  return exeBase;
}

function parseMetricRows(output: string): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // pid ppid pgid tpgid rss time command…  (tpgid is -1 with no foreground)
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      rssBytes: Number(match[5]) * 1024,
      cpuSeconds: parseCpuTimeSeconds(match[6]),
      command: match[7],
    });
  }
  return rows;
}

interface ProcessTreeMetric {
  cpuPercent: number;
  rssBytes: number;
  processCount: number;
  command?: string;
  listenPorts: number[];
  ports: TerminalListenPort[];
}

// Collapse a port→pids map into the sorted TerminalListenPort[] the renderer
// uses (open the URL, kill the holder).
function portInfosFromMap(portPids: Map<number, Set<number>>): TerminalListenPort[] {
  return [...portPids.entries()]
    .map(([port, pids]) => ({ port, pids: [...pids].sort((a, b) => a - b) }))
    .sort((a, b) => a.port - b.port);
}

// One `lsof` for every TCP socket in the LISTEN state, mapped pid -> {ports}.
// Used to surface "what is this terminal hosting" (dev servers etc.) in the
// sidebar. macOS/Linux only; missing lsof or any failure yields an empty map so
// the rest of the resource snapshot is unaffected.
async function collectListenPortsByPid(): Promise<Map<number, Set<number>>> {
  const byPid = new Map<number, Set<number>>();
  if (process.platform === 'win32') return byPid;
  let output: string;
  try {
    // -Fpn: machine-readable, emit only pid (p) and name (n) fields. Every `n`
    // line belongs to the most recent `p` line until the next `p`.
    output = await execFileText('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  } catch {
    return byPid;
  }
  let pid = 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
    } else if (tag === 'n' && pid > 0) {
      // value like "*:3000", "127.0.0.1:5173", "[::1]:8080", "*:*"
      const portStr = value.slice(value.lastIndexOf(':') + 1);
      const port = Number(portStr);
      if (Number.isInteger(port) && port > 0) {
        let set = byPid.get(pid);
        if (!set) { set = new Set(); byPid.set(pid, set); }
        set.add(port);
      }
    }
  }
  return byPid;
}

function execFileText(command: string, args: string[], timeoutMs = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

// Run a shell script inside a WSL distro by PIPING it to `sh` over stdin, NOT as a
// `sh -c <arg>` command-line argument. Passing a complex script (quotes, $(), globs)
// as an argument through the Windows→wsl.exe command-line layer mangles it — quotes
// and substitutions get garbled, so only fragments run. stdin is raw bytes and
// bypasses all Windows argument quoting, so the script arrives intact.
function execWslScript(distro: string, script: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(wslExePath(), ['-d', distro, '--', 'sh', '-s'], { windowsHide: true });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(buf ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(new Error('wsl scan timeout')); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(undefined, Buffer.concat(chunks)));
    // The child may exit before we finish writing; swallow EPIPE on stdin.
    child.stdin.on('error', () => { /* ignore */ });
    child.stdin.write(script);
    child.stdin.end();
  });
}

// decodeWslOutput (UTF-16/UTF-8 sniff + BOM strip) lives in ./wsl-encoding —
// shared with agent-wsl-install and unit-tested there.

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      command: match[5],
    });
  }
  return rows;
}

// ─── Windows process metrics ─────────────────────────────────────────────────
// Windows has no controlling-tty foreground process group (tpgid), so the
// "current command" is found by walking the shell's descendant tree: an agent
// (claude/codex/cursor) running under the terminal wins; otherwise the deepest
// non-shell descendant; otherwise the shell itself when idle. Data comes from a
// single Win32_Process CIM query (pid/ppid/cmdline/cpu-ticks/working-set);
// listening ports from `netstat -ano`. Fields are joined with \u0001 (SOH) so a
// command line containing spaces/commas/tabs never breaks parsing.
const WIN_SHELLISH = new Set(['cmd', 'powershell', 'pwsh', 'conhost', 'conpty', 'wininit', 'windowsterminal', 'openconsole']);

interface WinRow { pid: number; ppid: number; cpuSeconds: number; rssBytes: number; command: string; }

async function collectListenPortsByPidWindows(): Promise<Map<number, Set<number>>> {
  const byPid = new Map<number, Set<number>>();
  let output: string;
  try {
    output = await execFileText('netstat', ['-ano', '-p', 'tcp'], 4000);
  } catch {
    return byPid;
  }
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // proto local foreign state pid
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    if (parts[3].toUpperCase() !== 'LISTENING') continue;
    const pid = Number(parts[4]);
    const port = Number(parts[1].split(':').pop());
    if (!Number.isFinite(pid) || !Number.isFinite(port)) continue;
    let set = byPid.get(pid);
    if (!set) { set = new Set(); byPid.set(pid, set); }
    set.add(port);
  }
  return byPid;
}

const WIN_PS_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { ' +
  "$c = [string]$_.CommandLine -replace '[\\u0001\\r\\n\\t]',' '; " +
  '(@($_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,$_.KernelModeTime,$_.UserModeTime,$_.Name,$c) -join [char]1) }';

async function collectWindowsProcessMetrics(roots: number[]): Promise<{
  supported: boolean;
  metrics: Map<number, ProcessTreeMetric>;
}> {
  let output: string;
  try {
    output = await execFileText(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PS_SCRIPT],
      5000,
    );
  } catch {
    return { supported: false, metrics: new Map() };
  }

  const byPid = new Map<number, WinRow>();
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\u0001');
    if (f.length < 7) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    if (!Number.isFinite(pid)) continue;
    // KernelModeTime + UserModeTime are cumulative in 100-ns ticks → seconds.
    const cpuSeconds = (Number(f[3]) + Number(f[4])) / 1e7;
    const command = (f[6] && f[6].trim()) ? f[6].trim() : f[5];
    byPid.set(pid, { pid, ppid, cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0, rssBytes: Number(f[2]) || 0, command });
    const kids = childrenByParent.get(ppid) ?? [];
    kids.push(pid);
    childrenByParent.set(ppid, kids);
  }
  if (byPid.size === 0) return { supported: false, metrics: new Map() };

  const portsByPid = await collectListenPortsByPidWindows();
  const now = Date.now();
  const liveRoots = new Set<number>();
  const metrics = new Map<number, ProcessTreeMetric>();

  for (const rootPid of roots) {
    const stack: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
    const seen = new Set<number>();
    let cpuSeconds = 0, rssBytes = 0, processCount = 0;
    const portPids = new Map<number, Set<number>>();
    let agentLabel: string | undefined;
    let deepest: { label: string; depth: number } | undefined;

    while (stack.length > 0) {
      const { pid, depth } = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = byPid.get(pid);
      if (row) {
        cpuSeconds += row.cpuSeconds;
        rssBytes += row.rssBytes;
        processCount += 1;
        const label = deriveProcessLabel(row.command);
        if (depth > 0) {
          if (!agentLabel && KNOWN_AGENTS.includes(label)) agentLabel = label;
          if (label && !WIN_SHELLISH.has(label) && (!deepest || depth > deepest.depth)) {
            deepest = { label, depth };
          }
        }
      }
      for (const port of portsByPid.get(pid) ?? []) {
        let set = portPids.get(port);
        if (!set) { set = new Set(); portPids.set(port, set); }
        set.add(pid);
      }
      for (const child of childrenByParent.get(pid) ?? []) stack.push({ pid: child, depth: depth + 1 });
    }
    liveRoots.add(rootPid);

    // Instantaneous tree CPU% from the cumulative-time delta since last poll.
    const prev = prevTreeCpu.get(rootPid);
    let cpuPercent = prev?.percent ?? 0;
    if (prev) {
      const dt = (now - prev.at) / 1000;
      if (dt >= 0.5) cpuPercent = Math.max(0, ((cpuSeconds - prev.cpuSeconds) / dt) * 100);
    }
    prevTreeCpu.set(rootPid, { cpuSeconds, at: now, percent: cpuPercent });

    // Foreground command: agent first, else deepest non-shell descendant, else
    // the shell itself (idle).
    const rootRow = byPid.get(rootPid);
    const command = agentLabel ?? deepest?.label ?? (rootRow ? deriveProcessLabel(rootRow.command) : undefined);

    const ports = portInfosFromMap(portPids);
    metrics.set(rootPid, {
      cpuPercent,
      rssBytes,
      processCount,
      command,
      listenPorts: ports.map((p) => p.port),
      ports,
    });
  }
  for (const pid of prevTreeCpu.keys()) {
    if (!liveRoots.has(pid)) prevTreeCpu.delete(pid);
  }
  return { supported: true, metrics };
}

// ─── WSL process metrics (L2: query inside the distro) ───────────────────────
// Win32_Process only sees `wsl.exe`, never the Linux processes running inside the
// distro, so a WSL terminal's native pid yields nothing useful. Instead we run a
// single scan INSIDE each distro via `wsl.exe -d <distro> -- sh -c …` and correlate
// every Linux process to its terminal through the SPLITGRID_TERMINAL env var we already
// inject (WSLENV /u): every process in a terminal's tree inherits it, so a /proc
// environ scan partitions the distro's processes per terminal with zero guessing.
//
// The script emits SOH()-joined rows so command lines with spaces never break
// parsing. Line types: `C<clk_tck>` (CPU tick rate), `P<term><pid><ppid><tpgid><rssBytes><cpuTicks><cmd>`
// (one per process carrying SPLITGRID_TERMINAL), `L<pid><port>` (one per listening socket).
// Foreground command, like the native POSIX path, is the leader of the controlling
// tty's foreground process group (root.tpgid) — naturally claude/vim when busy, the
// shell when idle.
const WSL_PS_SCRIPT = `S=$(printf '\\001');T=$(getconf CLK_TCK 2>/dev/null||echo 100);PG=$(getconf PAGESIZE 2>/dev/null||echo 4096);printf 'C%s%s\\n' "$S" "$T";for d in /proc/[0-9]*;do e="$d/environ";[ -r "$e" ]||continue;term=$(tr '\\0' '\\n' < "$e" 2>/dev/null|grep -m1 '^SPLITGRID_TERMINAL=')||continue;[ -n "$term" ]||continue;term=\${term#SPLITGRID_TERMINAL=};[ -n "$term" ]||continue;st=$(cat "$d/stat" 2>/dev/null)||continue;pid=\${d##*/};rest=\${st#*) };set -- $rest;ppid=$2;tpgid=$6;ut=\${12};stime=\${13};rss=\${22};cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null);cmd=\${cmd% };if [ -z "$cmd" ];then c=\${st#*(};cmd=\${c%)*};fi;rb=$((rss*PG));ct=$((ut+stime));printf '%s\\n' "P$S$term$S$pid$S$ppid$S$tpgid$S$rb$S$ct$S$cmd";done;ss -Hltnp 2>/dev/null|while IFS= read -r ln;do la=$(echo "$ln"|awk '{print $4}');port=\${la##*:};case "$port" in ''|*[!0-9]*)continue;;esac;echo "$ln"|grep -o 'pid=[0-9]*'|while IFS= read -r p;do printf '%s\\n' "L$S\${p#pid=}$S$port";done;done`;

// WslRow + parsing/aggregation live in ./wsl-metrics (pure, unit-tested).

async function collectWslProcessMetrics(
  sessions: { id: string; distro: string }[],
): Promise<Map<string, ProcessTreeMetric>> {
  const result = new Map<string, ProcessTreeMetric>();
  // One distro scan can serve every terminal that lives in it.
  const wantByDistro = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (!s.distro) continue;
    let set = wantByDistro.get(s.distro);
    if (!set) { set = new Set(); wantByDistro.set(s.distro, set); }
    set.add(s.id);
  }

  const now = Date.now();
  const liveTerminals = new Set<string>();

  await Promise.all([...wantByDistro.entries()].map(async ([distro, wantIds]) => {
    let output: string;
    try {
      const buf = await execWslScript(distro, WSL_PS_SCRIPT, 5000);
      output = decodeWslOutput(buf);
      termDbg(`wsl scan distro=${distro} want=${[...wantIds].join(',')} bytes=${buf.length} sample=${JSON.stringify(output.slice(0, 240))}`);
    } catch (err) {
      termDbg(`wsl scan distro=${distro} FAILED: ${(err as Error).message}`);
      return; // distro not running / wsl.exe failed — leave these terminals without metrics
    }

    const { clk, rowsByTerm, portsByPid } = parseWslScan(output);

    termDbg(`wsl scan distro=${distro} parsed terms=[${[...rowsByTerm.keys()].join(',')}] rowsPerTerm=${JSON.stringify([...rowsByTerm].map(([t, r]) => [t.slice(0, 8), r.length]))}`);

    for (const id of wantIds) {
      const rows = rowsByTerm.get(id);
      if (!rows || rows.length === 0) continue;
      const agg = aggregateWslTerminal(rows, portsByPid, clk);

      // Instantaneous CPU % from the cumulative-seconds delta (stateful, so it
      // stays here rather than in the pure aggregate).
      const prev = prevWslCpu.get(id);
      let cpuPercent = prev?.percent ?? 0;
      if (prev) {
        const dt = (now - prev.at) / 1000;
        if (dt >= 0.5) cpuPercent = Math.max(0, ((agg.cpuSeconds - prev.cpuSeconds) / dt) * 100);
      }
      prevWslCpu.set(id, { cpuSeconds: agg.cpuSeconds, at: now, percent: cpuPercent });
      liveTerminals.add(id);

      const finalCommand = agg.foregroundCommand ? deriveProcessLabel(agg.foregroundCommand) : undefined;
      termDbg(`wsl metric id=${id.slice(0, 8)} procs=${agg.processCount} cmd=${finalCommand} rss=${agg.rssBytes} cpu=${cpuPercent.toFixed(1)} ports=${agg.listenPorts.join(',')}`);
      result.set(id, {
        cpuPercent,
        rssBytes: agg.rssBytes,
        processCount: agg.processCount,
        command: finalCommand,
        listenPorts: agg.listenPorts,
        ports: agg.ports,
      });
    }
  }));

  // Drop CPU history for WSL terminals that no longer exist.
  for (const id of prevWslCpu.keys()) {
    if (!liveTerminals.has(id)) prevWslCpu.delete(id);
  }
  return result;
}

async function collectProcessTreeMetrics(rootPids: number[]): Promise<{
  supported: boolean;
  metrics: Map<number, ProcessTreeMetric>;
}> {
  const roots = rootPids.filter((pid) => Number.isFinite(pid) && pid > 0);
  if (roots.length === 0) {
    return { supported: true, metrics: new Map() };
  }
  if (process.platform === 'win32') {
    return collectWindowsProcessMetrics(roots);
  }

  try {
    const rows = parseMetricRows(
      await execFileText('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,rss=,time=,command='])
    );
    const now = Date.now();
    const portsByPid = await collectListenPortsByPid();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const childrenByParent = new Map<number, MetricRow[]>();
    for (const row of rows) {
      const children = childrenByParent.get(row.ppid) ?? [];
      children.push(row);
      childrenByParent.set(row.ppid, children);
    }

    const liveRoots = new Set<number>();
    const metrics = new Map<number, ProcessTreeMetric>();
    for (const rootPid of roots) {
      const stack = [rootPid];
      const seen = new Set<number>();
      let cpuSeconds = 0;
      let rssBytes = 0;
      let processCount = 0;
      const portPids = new Map<number, Set<number>>();
      while (stack.length > 0) {
        const pid = stack.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const row = byPid.get(pid);
        if (row) {
          cpuSeconds += Number.isFinite(row.cpuSeconds) ? row.cpuSeconds : 0;
          rssBytes += Number.isFinite(row.rssBytes) ? row.rssBytes : 0;
          processCount += 1;
        }
        for (const port of portsByPid.get(pid) ?? []) {
          let set = portPids.get(port);
          if (!set) { set = new Set(); portPids.set(port, set); }
          set.add(pid);
        }
        for (const child of childrenByParent.get(pid) ?? []) {
          stack.push(child.pid);
        }
      }
      liveRoots.add(rootPid);

      // Instantaneous tree CPU%: change in cumulative CPU time over wall time
      // since the previous snapshot. ps %cpu is a lifetime average, useless for
      // "working right now"; this reflects the last poll interval.
      const prev = prevTreeCpu.get(rootPid);
      let cpuPercent = prev?.percent ?? 0;
      if (prev) {
        const dt = (now - prev.at) / 1000;
        if (dt >= 0.5) {
          cpuPercent = Math.max(0, ((cpuSeconds - prev.cpuSeconds) / dt) * 100);
        }
      }
      prevTreeCpu.set(rootPid, { cpuSeconds, at: now, percent: cpuPercent });

      const root = byPid.get(rootPid);
      // The foreground job of the controlling terminal is the process group
      // whose id == the tty's tpgid; its group leader (pid == tpgid) is what the
      // user is running right now (claude/vim/…). When idle that leader IS the
      // shell, so we naturally fall back to the shell name.
      let command = root?.command;
      if (root && root.tpgid > 0) {
        const leader = byPid.get(root.tpgid);
        if (leader) command = leader.command;
      }
      const ports = portInfosFromMap(portPids);
      metrics.set(rootPid, {
        cpuPercent,
        rssBytes,
        processCount,
        command: command ? deriveProcessLabel(command) : undefined,
        listenPorts: ports.map((p) => p.port),
        ports,
      });
    }
    // Drop CPU history for terminals that no longer exist.
    for (const pid of prevTreeCpu.keys()) {
      if (!liveRoots.has(pid)) prevTreeCpu.delete(pid);
    }
    return { supported: true, metrics };
  } catch {
    return { supported: false, metrics: new Map() };
  }
}

// Walk the process tree from a root pid and return all pids, root-first (BFS).
// Used to suspend/resume the whole shell tree, not just the foreground job —
// interactive shells put background jobs in their own process groups, so a
// single kill(-pgid) would miss them.
async function collectTreePids(rootPid: number): Promise<number[]> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'win32') return [rootPid];
  try {
    const rows = parseProcessRows(
      await execFileText('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='])
    );
    const childrenByParent = new Map<number, number[]>();
    for (const row of rows) {
      const arr = childrenByParent.get(row.ppid) ?? [];
      arr.push(row.pid);
      childrenByParent.set(row.ppid, arr);
    }
    const ordered: number[] = [];
    const seen = new Set<number>();
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      ordered.push(pid);
      for (const child of childrenByParent.get(pid) ?? []) queue.push(child);
    }
    return ordered;
  } catch {
    return [rootPid];
  }
}

// Full live process tree under a native-Windows PTY root, depth-first (root
// first), with full command lines. Mirrors the Win32_Process walk used for the
// sidebar metrics so the popover and the icon highlight stay consistent. Per-row
// CPU% is the instantaneous cumulative-time delta since the previous poll (the
// popover polls every ~2s, so the first sample reads 0 then real values).
async function collectWindowsProcessTree(rootPid: number): Promise<TerminalProcessInfo[]> {
  let output: string;
  try {
    output = await execFileText(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PS_SCRIPT],
      5000,
    );
  } catch {
    return [];
  }

  const byPid = new Map<number, WinRow>();
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\u0001');
    if (f.length < 7) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    if (!Number.isFinite(pid)) continue;
    const cpuSeconds = (Number(f[3]) + Number(f[4])) / 1e7;
    const command = (f[6] && f[6].trim()) ? f[6].trim() : f[5];
    byPid.set(pid, { pid, ppid, cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0, rssBytes: Number(f[2]) || 0, command });
    const kids = childrenByParent.get(ppid) ?? [];
    kids.push(pid);
    childrenByParent.set(ppid, kids);
  }
  if (!byPid.has(rootPid)) return [];

  const now = Date.now();
  const out: TerminalProcessInfo[] = [];
  const seen = new Set<number>();
  const walk = (pid: number, depth: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) {
      const prev = prevWinProcCpu.get(pid);
      let cpuPercent = prev?.percent ?? 0;
      if (prev) {
        const dt = (now - prev.at) / 1000;
        if (dt >= 0.5) cpuPercent = Math.max(0, ((row.cpuSeconds - prev.cpuSeconds) / dt) * 100);
      }
      prevWinProcCpu.set(pid, { cpuSeconds: row.cpuSeconds, at: now, percent: cpuPercent });
      out.push({ pid: row.pid, ppid: row.ppid, depth, command: row.command, cpuPercent, rssBytes: row.rssBytes });
    }
    const kids = (childrenByParent.get(pid) ?? []).slice().sort((a, b) => a - b);
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(rootPid, 0);
  for (const [pid, s] of prevWinProcCpu) {
    if (now - s.at > PROC_CPU_TTL_MS) prevWinProcCpu.delete(pid);
  }
  return out;
}

// Full live process tree for a WSL terminal, scanned INSIDE the distro (Win32 only
// sees wsl.exe). Reuses WSL_PS_SCRIPT — every process carrying this terminal's
// SPLITGRID_TERMINAL is a member; the root is the login shell (parent outside the
// set). Per-row CPU% is the cumulative-tick delta since the previous poll.
async function collectWslProcessTree(distro: string, terminalId: string): Promise<TerminalProcessInfo[]> {
  let output: string;
  try {
    output = decodeWslOutput(await execWslScript(distro, WSL_PS_SCRIPT, 5000));
  } catch {
    return [];
  }

  let clk = 100;
  const rows: WslRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\u0001');
    if (f[0] === 'C') { const t = Number(f[1]); if (Number.isFinite(t) && t > 0) clk = t; continue; }
    if (f[0] !== 'P' || f.length < 8 || f[1] !== terminalId) continue;
    const pid = Number(f[2]);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      ppid: Number(f[3]) || 0,
      tpgid: Number(f[4]) || -1,
      rssBytes: Number(f[5]) || 0,
      cpuTicks: Number(f[6]) || 0,
      command: f[7] || '',
    });
  }
  if (rows.length === 0) return [];

  const pidSet = new Set(rows.map((r) => r.pid));
  const childrenByParent = new Map<number, WslRow[]>();
  for (const r of rows) {
    const arr = childrenByParent.get(r.ppid) ?? [];
    arr.push(r);
    childrenByParent.set(r.ppid, arr);
  }
  const sorted = [...rows].sort((a, b) => a.pid - b.pid);
  const root = sorted.find((r) => !pidSet.has(r.ppid)) ?? sorted[0];

  const now = Date.now();
  const out: TerminalProcessInfo[] = [];
  const seen = new Set<number>();
  const walk = (r: WslRow, depth: number) => {
    if (seen.has(r.pid)) return;
    seen.add(r.pid);
    const key = `${terminalId}:${r.pid}`;
    const cpuSeconds = r.cpuTicks / clk;
    const prev = prevWslProcCpu.get(key);
    let cpuPercent = prev?.percent ?? 0;
    if (prev) {
      const dt = (now - prev.at) / 1000;
      if (dt >= 0.5) cpuPercent = Math.max(0, ((cpuSeconds - prev.cpuSeconds) / dt) * 100);
    }
    prevWslProcCpu.set(key, { cpuSeconds, at: now, percent: cpuPercent });
    out.push({ pid: r.pid, ppid: r.ppid, depth, command: r.command, cpuPercent, rssBytes: r.rssBytes });
    const kids = (childrenByParent.get(r.pid) ?? []).slice().sort((a, b) => a.pid - b.pid);
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(root, 0);
  for (const [key, s] of prevWslProcCpu) {
    if (now - s.at > PROC_CPU_TTL_MS) prevWslProcCpu.delete(key);
  }
  return out;
}

// Full live process tree under a PTY root, ordered depth-first (root first),
// with full command lines (`command=`, not `comm=`) so callers can see exactly
// what each process is running.
async function collectProcessTree(rootPid: number): Promise<TerminalProcessInfo[]> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'win32') return collectWindowsProcessTree(rootPid);
  try {
    const rows = parseProcessRows(
      await execFileText('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,command='])
    );
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const childrenByParent = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const arr = childrenByParent.get(row.ppid) ?? [];
      arr.push(row);
      childrenByParent.set(row.ppid, arr);
    }
    const out: TerminalProcessInfo[] = [];
    const seen = new Set<number>();
    const walk = (pid: number, depth: number) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      const row = byPid.get(pid);
      if (row) {
        out.push({
          pid: row.pid,
          ppid: row.ppid,
          depth,
          command: row.command,
          cpuPercent: Number.isFinite(row.cpuPercent) ? row.cpuPercent : 0,
          rssBytes: Number.isFinite(row.rssBytes) ? row.rssBytes : 0,
        });
      }
      const kids = (childrenByParent.get(pid) ?? []).sort((a, b) => a.pid - b.pid);
      for (const kid of kids) walk(kid.pid, depth + 1);
    };
    walk(rootPid, 0);
    return out;
  } catch {
    return [];
  }
}

export class LocalShellManager {
  private sessions = new Map<string, LocalShellSession>();
  private callbacks: ShellCallbacks | null = null;
  private isShuttingDown = false;
  private frozen = new Set<string>();

  setCallbacks(callbacks: ShellCallbacks): void {
    this.callbacks = callbacks;
  }

  private safeNotify(cb: (() => void) | undefined): void {
    if (!cb) return;
    try {
      cb();
    } catch {
      // Ignore renderer/event delivery errors during lifecycle races.
    }
  }

  createShell(
    id: string,
    config?: LocalShellConfig,
    callbacks?: ShellCallbacks
  ): TerminalSessionInfo {
    const cb = callbacks || this.callbacks;
    if (!cb) {
      throw new Error('No callbacks registered');
    }

    const isWindows = process.platform === 'win32';
    const homedir = os.homedir();

    // Prefer the user's login shell ($SHELL). When it is unset (e.g. launched
    // from a desktop session or service that doesn't export it), fall back to
    // the platform's de-facto default: zsh on macOS (Catalina+), bash on Linux.
    // Hardcoding /bin/zsh breaks minimal Linux installs that ship only bash.
    const defaultShell = isWindows
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

    const shell = config?.shell || defaultShell;
    const cwd = config?.cwd || homedir;
    const label = config?.label || 'Local';

    // A WSL target encodes its distro in `shell` as `wsl:<distro>`. We spawn the
    // real wsl.exe, which launches the distro's default login shell. We pass ONLY
    // `-d <distro>` — no `--cd`: older wsl.exe builds reject `--cd`, exit instantly,
    // and a process that exits during ConPTY startup can crash node-pty natively
    // (taking the whole app down). The shell starts in the mapped Windows cwd.
    // `shell` (the sentinel) is kept on info.shell so the terminal round-trips
    // through Settings / session restore.
    const isWsl = isWindows && isWslShell(shell);
    const spawnFile = isWsl ? wslExePath() : shell;
    const shellArgs = isWsl
      ? ['-d', wslDistroFromShell(shell)]
      // Args depend on the shell: POSIX login shell (-l) sources profile files
      // (docker/pyenv/homebrew PATH); on Windows, Git Bash/PowerShell/cmd differ.
      : shellArgsFor(shell, isWindows);

    // Build the env. POSIX-only PATH augmentation and LANG/LC_CTYPE hints
    // are skipped on Windows where the separator (`;`) and locale model
    // are different.
    const basePath = process.env.PATH || '';
    let fullPath = basePath;
    if (!isWindows) {
      const extraPaths = [
        '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin',
        `${homedir}/.local/bin`, `${homedir}/.cargo/bin`,
      ].filter((p) => !basePath.includes(p));
      if (extraPaths.length > 0) {
        fullPath = `${basePath}:${extraPaths.join(':')}`;
      }
    }

    const info: TerminalSessionInfo = {
      id,
      type: 'local',
      label,
      status: 'connected',
      createdAt: Date.now(),
      cwd,
      shell,
    };

    try {
      const baseEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: fullPath,
      };
      if (!isWindows) {
        baseEnv.LANG = process.env.LANG || 'en_US.UTF-8';
        baseEnv.LC_CTYPE = 'UTF-8';
      }

      // Agent integrations (hooks + browser control) are opt-in: inject the
      // SPLITGRID_* env only when the user has enabled them in Settings. When off,
      // terminals spawn with no splitgrid-specific env, so an agent running inside
      // sees nothing to hook into or drive.
      if (agentIntegrationsEnabled) {
        // Agent lifecycle hooks (installed into ~/.claude, ~/.codex, … configs)
        // resolve this terminal's identity + reporting endpoint from the env, then
        // invoke the bundled helper to report turn state. Works for any agent,
        // cross-platform; no-ops outside splitgrid (empty SPLITGRID_TERMINAL).
        baseEnv.SPLITGRID_TERMINAL = id;
        baseEnv.SPLITGRID_HOOK_ENDPOINT = `http://127.0.0.1:${RECEIVER_PORT}/hook`;
        baseEnv.SPLITGRID_HOOK_CLI = hookHelperPath(isWsl);

        // Agent browser control: this terminal's agent can drive its <webview>
        // browser pane via the bundled helper, gated by a per-run token.
        baseEnv.SPLITGRID_BROWSER_ENDPOINT = `http://127.0.0.1:${RECEIVER_PORT}/browser`;
        baseEnv.SPLITGRID_BROWSER_CLI = browserHelperPath(isWsl);
        baseEnv.SPLITGRID_BROWSER_TOKEN = BROWSER_TOKEN;

        // Agent terminal control: this terminal's agent can list, read and drive
        // the OTHER terminals in its workspace via the bundled helper. Same per-run
        // secret as the browser bridge (writing to a sibling shell runs arbitrary
        // commands, so it's equally privileged). Gated on its own sub-opt-in, so
        // browser control can be enabled without it.
        if (terminalControlEnabled) {
          baseEnv.SPLITGRID_TERMINAL_ENDPOINT = `http://127.0.0.1:${RECEIVER_PORT}/terminal`;
          baseEnv.SPLITGRID_TERMINAL_CLI = terminalHelperPath(isWsl);
          baseEnv.SPLITGRID_TERMINAL_TOKEN = BROWSER_TOKEN;
        }

        // Agent SQL control: this terminal's agent can run queries, inspect
        // schema and export results against the SQL component via the bundled
        // helper. Same per-run secret as the other bridges (running arbitrary SQL
        // is equally privileged). Gated on its own sub-opt-in. SPLITGRID_SQL_WRITE
        // is a capability HINT only (read-only vs write/DDL); real enforcement is
        // server-side in the renderer dispatch (Phase B).
        if (sqlControlEnabled) {
          baseEnv.SPLITGRID_SQL_ENDPOINT = `http://127.0.0.1:${RECEIVER_PORT}/sql`;
          baseEnv.SPLITGRID_SQL_CLI = sqlHelperPath(isWsl);
          baseEnv.SPLITGRID_SQL_TOKEN = BROWSER_TOKEN;
          if (sqlWriteEnabled) baseEnv.SPLITGRID_SQL_WRITE = '1';
        }

        // WSL terminals: env doesn't cross the Win32→Linux boundary unless listed
        // in WSLENV. /u shares Win→WSL only; /p path-translates the helper scripts
        // (C:\…\splitgrid-*.sh → /mnt/c/…). The .sh helpers themselves rewrite the
        // 127.0.0.1 endpoint to the Windows host as seen from inside the distro.
        if (isWsl) {
          // The localhost receiver is unreachable from inside the distro (NAT +
          // Windows Firewall block the vEthernet gateway), so the helpers fall back
          // to a FILE bridge. SPLITGRID_BRIDGE_DIR points at splitgrid's userData bridge
          // dir; /up path-translates it to the distro's /mnt/<drive>/… view.
          baseEnv.SPLITGRID_BRIDGE_DIR = bridgeDirPath();
          const share = [
            'SPLITGRID_TERMINAL/u',
            'SPLITGRID_HOOK_ENDPOINT/u',
            'SPLITGRID_HOOK_CLI/up',
            'SPLITGRID_BROWSER_ENDPOINT/u',
            'SPLITGRID_BROWSER_CLI/up',
            'SPLITGRID_BROWSER_TOKEN/u',
            // Only share the terminal-control vars when that sub-opt-in is on —
            // they aren't set on baseEnv otherwise, so listing them would be a no-op
            // at best, but keep WSLENV honest about what actually crosses.
            ...(terminalControlEnabled ? [
              'SPLITGRID_TERMINAL_ENDPOINT/u',
              'SPLITGRID_TERMINAL_CLI/up',
              'SPLITGRID_TERMINAL_TOKEN/u',
            ] : []),
            // Only share the SQL-control vars when that sub-opt-in is on — they
            // aren't set on baseEnv otherwise. SPLITGRID_SQL_WRITE is a bare hint
            // flag, shared with /u (no path translation), and only when set.
            ...(sqlControlEnabled ? [
              'SPLITGRID_SQL_ENDPOINT/u',
              'SPLITGRID_SQL_CLI/up',
              'SPLITGRID_SQL_TOKEN/u',
              ...(sqlWriteEnabled ? ['SPLITGRID_SQL_WRITE/u'] : []),
            ] : []),
            'SPLITGRID_BRIDGE_DIR/up',
          ];
          baseEnv.WSLENV = [process.env.WSLENV, ...share].filter(Boolean).join(':');
        }
      }

      termDbg(`spawn intent id=${id} isWsl=${isWsl} file=${spawnFile} args=${JSON.stringify(shellArgs)} cwd=${cwd}`);
      const ptyProcess = pty.spawn(spawnFile, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: baseEnv,
      });
      termDbg(`spawn OK id=${id} pid=${ptyProcess.pid}`);

      const session: LocalShellSession = {
        pty: ptyProcess,
        info,
        buffer: '',
        inputBytes: 0,
        outputBytes: 0,
        closing: false,
      };

      this.sessions.set(id, session);

      session.onDataDispose = ptyProcess.onData((data: string) => {
        if (session.closing) return;
        session.buffer += data;
        session.outputBytes += Buffer.byteLength(data, 'utf8');
        session.lastDataAt = Date.now();
        if (session.buffer.length > MAX_BUFFER_SIZE) {
          const trimChars = session.buffer.length - MAX_BUFFER_SIZE;
          session.buffer = session.buffer.slice(
            trimChars
          );
        }
        this.safeNotify(() => cb.onData(id, data));
      });

      session.onExitDispose = ptyProcess.onExit(() => {
        info.status = 'disconnected';
        if (!session.closing) {
          // The shell process exited on its own — `exit` / full logout.
          this.safeNotify(() => cb.onClose(id, { exitedCleanly: true }));
        }
        this.sessions.delete(id);
      });

      this.safeNotify(() => cb.onReady(id));
      return info;
    } catch (err) {
      termDbg(`spawn THREW id=${id}: ${(err as Error).message}\n${(err as Error).stack}`);
      info.status = 'error';
      this.safeNotify(() => cb.onError(id, (err as Error).message));
      throw err;
    }
  }

  sendData(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.inputBytes += Buffer.byteLength(data, 'utf8');
      session.pty.write(data);
    }
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      // node-pty's resize() issues an ioctl on the master fd and throws if it is
      // no longer valid (EBADF) — e.g. the child exited between a resize event
      // being queued and handled. A resize failure must never crash the whole
      // app via the uncaughtException handler, so swallow it.
      try {
        session.pty.resize(cols, rows);
      } catch {
        /* pty already gone — nothing to resize */
      }
    }
  }

  // Suspend the shell's entire process tree (SIGSTOP). No-op on Windows, where
  // node-pty would terminate rather than suspend the process.
  async pauseShell(id: string): Promise<{ supported: boolean; frozen: boolean }> {
    const session = this.sessions.get(id);
    if (!session) return { supported: process.platform !== 'win32', frozen: false };
    if (process.platform === 'win32') return { supported: false, frozen: false };
    const pids = await collectTreePids(session.pty.pid);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGSTOP'); } catch { /* process already gone */ }
    }
    this.frozen.add(id);
    return { supported: true, frozen: true };
  }

  // Resume a suspended shell tree (SIGCONT), leaves-first so child jobs come
  // back before the shell that may be waiting on them.
  async resumeShell(id: string): Promise<{ supported: boolean; frozen: boolean }> {
    this.frozen.delete(id);
    const session = this.sessions.get(id);
    if (!session) return { supported: process.platform !== 'win32', frozen: false };
    if (process.platform === 'win32') return { supported: false, frozen: false };
    const pids = await collectTreePids(session.pty.pid);
    for (const pid of pids.reverse()) {
      try { process.kill(pid, 'SIGCONT'); } catch { /* process already gone */ }
    }
    return { supported: true, frozen: false };
  }

  isFrozen(id: string): boolean {
    return this.frozen.has(id);
  }

  async getProcessTree(id: string): Promise<TerminalProcessInfo[]> {
    const session = this.sessions.get(id);
    if (!session) return [];
    // WSL: the Windows wsl.exe pid only exposes the Win32 side, so scan inside the
    // distro keyed by terminal id (same mechanism as the WSL metrics path).
    if (process.platform === 'win32' && isWslShell(session.info.shell)) {
      return collectWslProcessTree(wslDistroFromShell(session.info.shell ?? ''), id);
    }
    return collectProcessTree(session.pty.pid);
  }

  closeShell(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.closing = true;
      session.onDataDispose?.dispose();
      session.onExitDispose?.dispose();
      // A suspended process won't act on SIGHUP/SIGTERM until continued —
      // resume the group first so the kill actually lands.
      if (this.frozen.has(id) && process.platform !== 'win32') {
        try { process.kill(session.pty.pid, 'SIGCONT'); } catch { /* gone */ }
      }
      this.frozen.delete(id);
      try {
        session.pty.kill();
      } catch {
        // Ignore kill errors during terminal teardown.
      }
      this.sessions.delete(id);
      if (!this.isShuttingDown) {
        this.safeNotify(() => this.callbacks?.onClose(id));
      }
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.closeShell(id);
    }
  }

  shutdownForAppExit(): void {
    this.isShuttingDown = true;
    this.closeAll();
    this.callbacks = null;
  }

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  getSessionInfo(id: string): TerminalSessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  getAllSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  async getAllDiagnostics(): Promise<{
    processMetricsSupported: boolean;
    sessions: TerminalResourceInfo[];
  }> {
    const all = Array.from(this.sessions.values());
    const isWindows = process.platform === 'win32';
    const isWsl = (s: LocalShellSession) => isWindows && isWslShell(s.info.shell);
    // Native terminals query by pty pid; WSL terminals can't (the Windows wsl.exe
    // pid is opaque to the distro), so they go through an in-distro scan keyed by
    // terminal id. Both run concurrently.
    const [processMetrics, wslMetrics] = await Promise.all([
      collectProcessTreeMetrics(all.filter((s) => !isWsl(s)).map((s) => s.pty.pid)),
      (() => {
        const wsl = all.filter(isWsl);
        return wsl.length
          ? collectWslProcessMetrics(wsl.map((s) => ({ id: s.info.id, distro: wslDistroFromShell(s.info.shell ?? '') })))
          : Promise.resolve(new Map<string, ProcessTreeMetric>());
      })(),
    ]);
    return {
      processMetricsSupported: processMetrics.supported,
      sessions: all.map((s) => {
        const metric = isWsl(s) ? wslMetrics.get(s.info.id) : processMetrics.metrics.get(s.pty.pid);
        return {
          id: s.info.id,
          type: 'local',
          label: s.info.label,
          status: s.info.status,
          cwd: s.info.cwd,
          shell: s.info.shell,
          pid: s.pty.pid,
          processCount: metric?.processCount,
          processCommand: metric?.command,
          processCpuPercent: metric?.cpuPercent,
          processRssBytes: metric?.rssBytes,
          listenPorts: metric?.listenPorts,
          ports: metric?.ports,
          inputBytes: s.inputBytes,
          outputBytes: s.outputBytes,
          bufferSize: s.buffer.length,
          lastDataAt: s.lastDataAt,
        };
      }),
    };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  // Terminate a process (by PID) that a terminal's tree is hosting — e.g. the
  // dev server holding a port. Routed to the right place per session context:
  //   WSL    → `wsl -d <distro> -- kill -<sig> <pid>` (pid is in-distro)
  //   Windows native → `taskkill /PID <pid> [/F]`
  //   macOS / Linux  → process.kill(pid, SIG…)
  // The PID must come from this session's snapshot; we only guard against the
  // obvious foot-guns (init / invalid). SIGKILL by default so the port frees.
  async killProcess(
    sessionId: string,
    pid: number,
    signal: 'TERM' | 'KILL' = 'KILL',
  ): Promise<KillProcessResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Terminal session not found' };
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'Invalid PID' };
    const isWindows = process.platform === 'win32';
    try {
      if (isWindows && isWslShell(session.info.shell)) {
        const distro = wslDistroFromShell(session.info.shell ?? '');
        const sig = signal === 'KILL' ? '9' : '15';
        await execFileText(wslExePath(), ['-d', distro, '--', 'kill', `-${sig}`, String(pid)], 4000);
        return { ok: true };
      }
      if (isWindows) {
        const args = signal === 'KILL' ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)];
        await execFileText('taskkill', args, 4000);
        return { ok: true };
      }
      process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

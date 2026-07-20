// ─── WSL /proc scan parsing + aggregation (pure) ─────────────────────────────
// The L2 process-detection logic, extracted from local-shell-manager so the
// fiddly row parsing and root/foreground selection (which broke repeatedly with
// encoding + degenerate-output bugs) is unit-testable on synthetic scan output.
// The scan script emits SOH (0x01) separated lines:
//   C<SOH><clk_tck>
//   P<SOH><term><SOH><pid><SOH><ppid><SOH><tpgid><SOH><rssBytes><SOH><cpuTicks><SOH><cmd>
//   L<SOH><pid><SOH><port>
// Stateful bits (instantaneous CPU %, label prettifying) stay in the caller.

const SOH = '\u0001';

import type { TerminalListenPort } from '../shared/types';

export interface WslRow {
  pid: number;
  ppid: number;
  tpgid: number;
  rssBytes: number;
  cpuTicks: number;
  command: string;
}

export interface WslScan {
  clk: number;                              // CLK_TCK (cpuTicks → seconds)
  rowsByTerm: Map<string, WslRow[]>;        // P-rows grouped by SPLITGRID_TERMINAL
  portsByPid: Map<number, Set<number>>;     // listening ports from L-rows
}

export function parseWslScan(output: string): WslScan {
  let clk = 100;
  const rowsByTerm = new Map<string, WslRow[]>();
  const portsByPid = new Map<number, Set<number>>();

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split(SOH);
    if (f[0] === 'C') {
      const t = Number(f[1]);
      if (Number.isFinite(t) && t > 0) clk = t;
      continue;
    }
    if (f[0] === 'L') {
      const pid = Number(f[1]);
      const port = Number(f[2]);
      if (Number.isFinite(pid) && Number.isFinite(port) && port > 0) {
        let set = portsByPid.get(pid);
        if (!set) { set = new Set(); portsByPid.set(pid, set); }
        set.add(port);
      }
      continue;
    }
    if (f[0] !== 'P' || f.length < 8) continue;
    const pid = Number(f[2]);
    if (!Number.isFinite(pid)) continue;
    const arr = rowsByTerm.get(f[1]) ?? [];
    arr.push({
      pid,
      ppid: Number(f[3]) || 0,
      tpgid: Number(f[4]) || -1,
      rssBytes: Number(f[5]) || 0,
      cpuTicks: Number(f[6]) || 0,
      command: f[7] || '',
    });
    rowsByTerm.set(f[1], arr);
  }

  return { clk, rowsByTerm, portsByPid };
}

export interface WslAggregate {
  cpuSeconds: number;
  rssBytes: number;
  processCount: number;
  foregroundCommand: string | undefined;    // raw cmdline (caller prettifies)
  listenPorts: number[];
  ports: TerminalListenPort[];               // ports with the in-distro PID(s) holding them
}

/**
 * Aggregate one terminal's process rows into a metric. Sums RSS/CPU across the
 * tree; picks the foreground command:
 *   root  = the login shell — the matched process whose parent is OUTSIDE the set
 *           (its parent is wsl's /init relay, which carries no SPLITGRID_TERMINAL);
 *           smallest pid breaks ties.
 *   command = leader of root's tty foreground group (root.tpgid) if present,
 *           else root's own command — so it's `claude`/`vim` while busy, the
 *           shell when idle.
 */
export function aggregateWslTerminal(
  rows: WslRow[],
  portsByPid: Map<number, Set<number>>,
  clk: number,
): WslAggregate {
  const pidSet = new Set(rows.map((r) => r.pid));
  const byPid = new Map(rows.map((r) => [r.pid, r]));

  let cpuSeconds = 0;
  let rssBytes = 0;
  const portPids = new Map<number, Set<number>>();
  for (const r of rows) {
    cpuSeconds += r.cpuTicks / clk;
    rssBytes += r.rssBytes;
    for (const p of portsByPid.get(r.pid) ?? []) {
      let set = portPids.get(p);
      if (!set) { set = new Set(); portPids.set(p, set); }
      set.add(r.pid);
    }
  }

  const sorted = [...rows].sort((a, b) => a.pid - b.pid);
  const root = sorted.find((r) => !pidSet.has(r.ppid)) ?? sorted[0];
  let command = root?.command;
  if (root && root.tpgid > 0) {
    const leader = byPid.get(root.tpgid);
    if (leader) command = leader.command;
  }

  const ports: TerminalListenPort[] = [...portPids.entries()]
    .map(([port, pids]) => ({ port, pids: [...pids].sort((a, b) => a - b) }))
    .sort((a, b) => a.port - b.port);

  return {
    cpuSeconds,
    rssBytes,
    processCount: rows.length,
    foregroundCommand: command,
    listenPorts: ports.map((p) => p.port),
    ports,
  };
}

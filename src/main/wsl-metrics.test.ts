import { describe, it, expect } from 'vitest';
import { parseWslScan, aggregateWslTerminal } from './wsl-metrics';

const SOH = String.fromCharCode(1);
const P = (term: string, pid: number, ppid: number, tpgid: number, rss: number, ticks: number, cmd: string) =>
  ['P', term, pid, ppid, tpgid, rss, ticks, cmd].join(SOH);
const C = (clk: number) => ['C', clk].join(SOH);
const L = (pid: number, port: number) => ['L', pid, port].join(SOH);

describe('parseWslScan', () => {
  it('reads CLK_TCK from the C row (defaults to 100 without one)', () => {
    expect(parseWslScan(C(250)).clk).toBe(250);
    expect(parseWslScan(P('t', 1, 0, -1, 0, 0, 'x')).clk).toBe(100);
  });

  it('groups P rows by terminal and parses the fields', () => {
    const out = [P('t1', 100, 5, 200, 1000, 50, 'bash'), P('t2', 300, 9, -1, 2000, 10, 'zsh')].join('\n');
    const { rowsByTerm } = parseWslScan(out);
    expect([...rowsByTerm.keys()].sort()).toEqual(['t1', 't2']);
    expect(rowsByTerm.get('t1')![0]).toEqual({ pid: 100, ppid: 5, tpgid: 200, rssBytes: 1000, cpuTicks: 50, command: 'bash' });
  });

  it('collects listening ports per pid from L rows', () => {
    const { portsByPid } = parseWslScan([L(200, 3000), L(200, 8080), L(7, 22)].join('\n'));
    expect([...portsByPid.get(200)!].sort((a, b) => a - b)).toEqual([3000, 8080]);
    expect([...portsByPid.get(7)!]).toEqual([22]);
  });

  it('skips malformed rows (short P, non-numeric pid, blank lines)', () => {
    const out = ['P' + SOH + 't' + SOH + 'notapid' + SOH + '0', 'P' + SOH + 't', '', 'garbage'].join('\n');
    const { rowsByTerm } = parseWslScan(out);
    expect(rowsByTerm.size).toBe(0);
  });
});

describe('aggregateWslTerminal', () => {
  it('sums rss/cpu and picks the foreground (tpgid leader) command', () => {
    // shell (root: ppid 5 is OUTSIDE the set) → foreground job is its tpgid leader.
    const { rowsByTerm, portsByPid, clk } = parseWslScan([
      C(100),
      P('t1', 100, 5, 200, 1000, 50, 'bash'),         // login shell (root)
      P('t1', 200, 100, 200, 5000, 150, 'node claude'), // foreground job
      L(200, 3000),
    ].join('\n'));

    const agg = aggregateWslTerminal(rowsByTerm.get('t1')!, portsByPid, clk);
    expect(agg.processCount).toBe(2);
    expect(agg.rssBytes).toBe(6000);
    expect(agg.cpuSeconds).toBeCloseTo(2.0); // (50 + 150) / 100
    expect(agg.foregroundCommand).toBe('node claude');
    expect(agg.listenPorts).toEqual([3000]);
    // Port carries the in-distro PID holding it (for the kill action).
    expect(agg.ports).toEqual([{ port: 3000, pids: [200] }]);
  });

  it('falls back to the root command when there is no foreground group (tpgid<=0)', () => {
    const { rowsByTerm, portsByPid, clk } = parseWslScan([
      P('t', 100, 5, -1, 1000, 10, 'bash'),
    ].join('\n'));
    expect(aggregateWslTerminal(rowsByTerm.get('t')!, portsByPid, clk).foregroundCommand).toBe('bash');
  });

  it('breaks root ties by smallest pid among parentless processes', () => {
    // Both 100 and 90 have parents outside the set; the smaller pid (90) wins.
    const { rowsByTerm, portsByPid, clk } = parseWslScan([
      P('t', 100, 1, -1, 0, 0, 'late'),
      P('t', 90, 1, -1, 0, 0, 'early'),
    ].join('\n'));
    expect(aggregateWslTerminal(rowsByTerm.get('t')!, portsByPid, clk).foregroundCommand).toBe('early');
  });
});

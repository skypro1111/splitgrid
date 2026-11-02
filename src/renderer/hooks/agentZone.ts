import type { Container, Workspace } from '../../shared/types';
import { DEFAULT_ZONE, parseZoneSplit, zoneLayout, zonePaneIds, type ZoneOwner, type ZoneSplit } from '../../shared/agent-zones';

// ─── Agent zone requests (renderer side) ─────────────────────────────────────
// The flags every pane-opening bridge command shares, and the checks behind
// them. The layout rules themselves are in shared/agent-zones.

export interface ZoneFlags {
  zone?: string;
  at?: string;
  split?: string;
  /** `--background` / `--bg`: a background process, for the zone's tray. */
  background?: boolean;
}

export interface ZoneRequest {
  owner: ZoneOwner & { label: string };
  /** Container id of the pane to split, already checked to be in the zone. */
  at?: string;
  split?: ZoneSplit;
  background?: boolean;
}

type Reply = { ok: false; error: string; data: Record<string, unknown> };

const ZONE_NAME = /^[\w.-]{1,40}$/;

/** Pull `--zone`, `--at`, `--split` (also `--flag=value`) and `--background` out of positional args. */
export function takeZoneFlags(args: string[]): { flags: ZoneFlags; rest: string[] } {
  const flags: ZoneFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--background' || args[i] === '--bg') { flags.background = true; continue; }
    const m = /^--(zone|at|split)(?:=(.*))?$/.exec(args[i]);
    if (!m) { rest.push(args[i]); continue; }
    flags[m[1] as 'zone' | 'at' | 'split'] = m[2] ?? args[++i];
  }
  return { flags, rest };
}

// Pane ids as the CLIs print them: a terminal's session id, otherwise the
// container (surface) id.
export function paneIdOf(c: Container): string {
  return c.content.type === 'terminal' && c.content.terminalId ? c.content.terminalId : c.id;
}

function containerFor(ws: Workspace, paneId: string): Container | undefined {
  return ws.containers.find((c) => c.id === paneId || (c.content.type === 'terminal' && c.content.terminalId === paneId));
}

/** The container of the agent's own terminal: where its zone is anchored. */
export function agentTerminalContainerId(containers: Container[], terminal: string): string | null {
  return containers.find((c) => c.content.type === 'terminal' && c.content.terminalId === terminal)?.id ?? null;
}

export function zoneOwner(terminal: string, zone?: string): ZoneOwner {
  return { terminal, name: zone || DEFAULT_ZONE };
}

/** The zone's panes in order, as CLI ids with their type. */
export function zonePanes(ws: Workspace, owner: ZoneOwner): Array<{ id: string; type: string; background?: boolean }> {
  const byId = new Map(ws.containers.map((c) => [c.id, c]));
  const tray = new Set(zoneLayout(ws.layoutTree, owner).tray);
  return zonePaneIds(ws.layoutTree, owner).flatMap((cid) => {
    const c = byId.get(cid);
    return c ? [{ id: paneIdOf(c), type: c.content.type, ...(tray.has(cid) ? { background: true } : {}) }] : [];
  });
}

/** Whether a pane (CLI id or container id) is one of the owner's zone panes. */
export function inZone(ws: Workspace, owner: ZoneOwner, paneId: string): boolean {
  const c = containerFor(ws, paneId);
  return !!c && zonePaneIds(ws.layoutTree, owner).includes(c.id);
}

export function resolveZoneRequest(ws: Workspace, terminal: string, flags: ZoneFlags): { ok: true; req: ZoneRequest } | Reply {
  if (flags.zone !== undefined && !ZONE_NAME.test(flags.zone)) {
    return { ok: false, error: 'bad_zone', data: { message: '--zone takes a short name: letters, digits, "-", "_" or "." (up to 40)' } };
  }
  const split = parseZoneSplit(flags.split);
  if (split === null) return { ok: false, error: 'bad_split', data: { message: '--split takes right or down' } };

  const owner = zoneOwner(terminal, flags.zone);
  const caller = ws.containers.find((c) => c.content.type === 'terminal' && c.content.terminalId === terminal);
  const callerLabel = caller?.content.customName?.trim() || caller?.content.label || 'Agent';
  const label = owner.name === DEFAULT_ZONE ? callerLabel : `${callerLabel} · ${owner.name}`;

  let at: string | undefined;
  if (flags.at !== undefined) {
    const c = containerFor(ws, flags.at);
    // --at splits a pane of the pool the new one joins: the tray or the rest.
    const layout = zoneLayout(ws.layoutTree, owner);
    const pool = flags.background ? layout.tray : layout.main;
    if (!c || !pool.includes(c.id)) {
      const panes = zonePanes(ws, owner);
      return {
        ok: false,
        error: 'not_in_zone',
        data: {
          message: panes.length
            ? `--at must be one of your zone's ${flags.background ? 'tray' : 'regular'} panes`
            : 'your zone has no panes yet; open one without --at',
          zone: owner.name,
          panes,
        },
      };
    }
    at = c.id;
  }
  return { ok: true, req: { owner: { ...owner, label }, at, split, background: flags.background } };
}

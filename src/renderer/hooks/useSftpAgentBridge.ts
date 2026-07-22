import { useEffect, useRef } from 'react';
import type {
  Workspace, SavedConnection, SftpTarget, RemoteDirEntry, WorkspaceSyncTarget,
} from '../../shared/types';
import {
  resolveAgentLocalPath, resolveAgentRemotePath, remoteBasename, type LocalSep,
} from '../../shared/agent-sftp-paths';

// ─── Agent SFTP bridge (renderer side) ───────────────────────────────────────
// Receives an agent's SFTP command (forwarded from main, keyed by reqId),
// resolves the caller's workspace from the live layout, and moves files through
// the SAME IPC the UI uses (sftpUpload/sftpDownload, sftpPushPaths/sftpPullPaths,
// runWorkspaceSyncNow, sftp:*). Nothing here re-implements SFTP: the point is to
// give an agent the transfer path it otherwise fakes by base64-ing files through
// an SSH pane or standing up a web server.
//
// TARGET POLICY (workspace-scoped, never cross-workspace). A target is either:
//   • a configured SYNC target of this workspace — it has a remotePath, so
//     remote paths are confined to it; or
//   • the host of an SSH TERMINAL pane in this workspace — no configured root,
//     and none is invented: the agent already has a shell on that host through
//     the pane, so confining its SFTP would protect nothing.
// One candidate → it is the default. Several → the agent must pass --target.
//
// WRITE GATE: every command carries `writeAllowed`, read from main per call. The
// renderer classifies commands but can never self-grant write, so enforcement
// stays authoritative in main. Reads (targets/status/ls/stat/cat) and pulling
// files DOWN work without it; anything that changes the remote does not.
//
// LOCAL PATHS are confined to the workspace's working directory — see
// shared/agent-sftp-paths. Without a working directory the local side is refused
// outright rather than defaulting to somewhere surprising.

interface BridgeDeps {
  workspaces: Workspace[];
  // Saved SSH connections, to resolve a sync target's / SSH pane's connectionId
  // into a host label the agent can recognise.
  savedConnections: SavedConnection[];
}

type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string };

const HELP = {
  usage: 'splitgrid-sftp <command> [args]   (acts on the remote hosts of YOUR workspace)',
  commands: [
    'targets                      — hosts you can transfer to/from + the default one',
    'status                       — workspace sync config + last sync per target',
    'ls <remote> [--target N]     — list a remote directory',
    'stat <remote>                — one remote entry (size, mtime, dir?)',
    'cat <remote>                 — read a remote text file',
    'get <remote> [localdir]      — download a file/dir into the workspace',
    'send <local...> [remotedir]  — upload paths to the remote  (write)',
    'push <path...>               — sync-push workspace paths to every target (write)',
    'pull <path...>               — sync-pull workspace paths from the target',
    'sync                         — run the full workspace sync now (write)',
    'mkdir <remote>               — create a remote directory (write)',
    'mv <old> <new>               — rename/move on the remote (write)',
    'rm <remote> --force          — delete a remote path (write, needs --force)',
  ],
  notes: [
    'Local paths are relative to the workspace directory and cannot leave it.',
    'Remote paths on a sync target are relative to its remotePath; on an SSH-pane target give an absolute path.',
    'Pick a host with --target <name|number> when `targets` lists more than one.',
  ],
};

// Commands that change something on the remote — refused unless writeAllowed.
const WRITE_COMMANDS = new Set(['send', 'push', 'sync', 'mkdir', 'mv', 'rm']);

// A host an agent may transfer to, resolved from the caller's workspace.
interface AgentTarget {
  name: string;               // what the agent passes to --target
  kind: 'sync' | 'ssh';
  connectionId: string;
  host: string;
  username?: string;
  // Sync targets confine remote paths to their remotePath; SSH panes don't.
  remoteRoot: string | null;
  enabled: boolean;
  syncTargetId?: string;
}

export function useSftpAgentBridge(deps: BridgeDeps): void {
  // The IPC listener is registered once; read live state through a ref so it
  // always sees the current workspaces without re-subscribing.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handle = async (payload: { reqId: string; terminal: string; argv: string[]; writeAllowed: boolean }): Promise<void> => {
      const { reqId, terminal, argv, writeAllowed } = payload;
      let reply: Reply;
      try {
        reply = await runSftpAgentCommand(depsRef.current, terminal, argv, writeAllowed);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message || 'internal_error' };
      }
      window.electronAPI.sendSftpResult({ reqId, ...reply });
    };

    const unsub = window.electronAPI.onSftpCommand((payload) => { void handle(payload); });
    return unsub;
  }, []);
}

function localSep(): LocalSep {
  return window.electronAPI?.platform === 'win32' ? '\\' : '/';
}

// Every host reachable from this workspace: its enabled sync targets first
// (they carry a remote root), then the hosts of its SSH panes.
function targetsOf(ws: Workspace, saved: SavedConnection[]): AgentTarget[] {
  const byId = new Map(saved.map((c) => [c.id, c]));
  const out: AgentTarget[] = [];

  for (const t of ws.sync?.targets ?? []) {
    if (!t.connectionId) continue;
    const conn = byId.get(t.connectionId);
    out.push({
      name: t.name || conn?.label || t.id,
      kind: 'sync',
      connectionId: t.connectionId,
      host: conn?.host ?? 'unknown',
      username: conn?.username,
      remoteRoot: t.remotePath || null,
      enabled: !!t.enabled && !!ws.sync?.enabled,
      syncTargetId: t.id,
    });
  }

  for (const c of ws.containers) {
    if (c.content.type !== 'terminal') continue;
    if (c.content.terminalType !== 'ssh') continue;
    const connectionId = c.content.connectionId;
    if (!connectionId) continue;
    // A host already covered by a sync target keeps that (rooted) entry.
    if (out.some((t) => t.connectionId === connectionId)) continue;
    const conn = byId.get(connectionId);
    out.push({
      name: conn?.label || c.content.label || connectionId,
      kind: 'ssh',
      connectionId,
      host: conn?.host ?? 'unknown',
      username: conn?.username,
      remoteRoot: null,
      enabled: true,
      syncTargetId: undefined,
    });
  }

  return out;
}

// Pull `--target <name|index>` out of the args; returns it plus the rest.
function takeTarget(args: string[]): { target?: string; rest: string[] } {
  const rest: string[] = [];
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target' || a === '-t') { target = args[++i]; continue; }
    const m = /^--target=(.+)$/.exec(a);
    if (m) { target = m[1]; continue; }
    rest.push(a);
  }
  return { target, rest };
}

function takeFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== flag);
  return { present: rest.length !== args.length, rest };
}

// Resolve --target (by name, case-insensitive substring, or 1-based index)
// against the workspace's candidates.
function pickTarget(targets: AgentTarget[], want?: string): { target?: AgentTarget; error?: Reply } {
  const usable = targets.filter((t) => t.enabled);
  if (usable.length === 0) {
    return {
      error: {
        ok: false,
        error: 'no_targets',
        data: { message: 'this workspace has no remote host: configure a sync target or open an SSH terminal in it' },
      },
    };
  }
  if (!want) {
    if (usable.length === 1) return { target: usable[0] };
    return {
      error: {
        ok: false,
        error: 'ambiguous_target',
        data: { message: 'several hosts available — pass --target <name>', targets: usable.map((t) => t.name) },
      },
    };
  }
  const idx = Number(want);
  if (Number.isInteger(idx) && idx >= 1 && idx <= usable.length) return { target: usable[idx - 1] };
  const q = want.toLowerCase();
  const match =
    usable.find((t) => t.name.toLowerCase() === q) ??
    usable.find((t) => t.host.toLowerCase() === q) ??
    usable.find((t) => t.name.toLowerCase().includes(q));
  if (!match) {
    return {
      error: {
        ok: false,
        error: 'unknown_target',
        data: { message: 'no such host in this workspace; run: targets', query: want, targets: usable.map((t) => t.name) },
      },
    };
  }
  return { target: match };
}

// The SftpTarget the sftp:* IPC expects. `containerId` keys the cached SFTP
// session: a per-connection agent id, so agent traffic reuses one session and
// never disturbs a real pane's.
function sftpTargetFor(ws: Workspace, t: AgentTarget): SftpTarget {
  return { connectionId: t.connectionId, workspaceId: ws.id, containerId: `agent-sftp:${t.connectionId}` };
}

function syncOptions(ws: Workspace, syncId?: string) {
  return {
    workspaceId: ws.id,
    localRootPath: ws.workingDirectory ?? '',
    sync: ws.sync ?? null,
    ...(syncId ? { syncId } : {}),
  };
}

function describeTarget(t: AgentTarget, index: number) {
  return {
    n: index + 1,
    name: t.name,
    kind: t.kind,
    host: t.host,
    user: t.username,
    remoteRoot: t.remoteRoot,
    enabled: t.enabled,
  };
}

// A transferId for the cancellable bulk IPC. crypto.randomUUID is available in
// the renderer; the value only has to be unique per in-flight transfer.
function newTransferId(): string {
  return `agent-${crypto.randomUUID()}`;
}

/**
 * The command dispatch, exported for tests. The hook wires it to IPC; keeping it
 * a pure function of (deps, terminal, argv, writeAllowed) lets the target
 * resolution, the write gate and the path confinement be tested without Electron.
 */
export async function runSftpAgentCommand(deps: BridgeDeps, terminal: string, argv: string[], writeAllowed: boolean): Promise<Reply> {
  const { workspaces } = deps;
  const cmd = (argv[0] || '').toLowerCase();
  const rawRest = argv.slice(1);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '') {
    return { ok: true, data: { ...HELP, writeAllowed } };
  }

  if (WRITE_COMMANDS.has(cmd) && !writeAllowed) {
    return {
      ok: false,
      error: 'write_not_allowed',
      data: { message: `"${cmd}" writes to a remote host; SFTP access is read-only. Ask the user to enable writes in Settings → Agent integrations.` },
    };
  }

  // Caller's workspace = the one holding its terminal. Fall back to the sole
  // workspace if the terminal can't be located (e.g. just closed).
  const callerWs =
    workspaces.find((ws) => ws.containers.some((c) => c.content.terminalId === terminal)) ??
    (workspaces.length === 1 ? workspaces[0] : null);
  if (!callerWs) {
    return { ok: false, error: 'unknown_terminal', data: { message: 'cannot locate the calling terminal\'s workspace' } };
  }

  const targets = targetsOf(callerWs, deps.savedConnections);
  const sep = localSep();
  const root = callerWs.workingDirectory;

  if (cmd === 'targets') {
    return {
      ok: true,
      data: {
        workspace: callerWs.name,
        workspaceDir: root,
        writeAllowed,
        targets: targets.map(describeTarget),
        default: targets.filter((t) => t.enabled).length === 1 ? targets.find((t) => t.enabled)?.name : null,
      },
    };
  }

  if (cmd === 'status') {
    const sync = callerWs.sync;
    return {
      ok: true,
      data: {
        workspace: callerWs.name,
        workspaceDir: root,
        writeAllowed,
        syncEnabled: !!sync?.enabled,
        useGitIgnore: !!sync?.useGitIgnore,
        syncTargets: (sync?.targets ?? []).map((t: WorkspaceSyncTarget) => ({
          name: t.name,
          enabled: t.enabled,
          remotePath: t.remotePath,
          lastSyncAt: t.lastSyncAt,
          lastSyncStatus: t.lastSyncStatus,
          lastSyncError: t.lastSyncError,
        })),
        sshTargets: targets.filter((t) => t.kind === 'ssh').map((t) => t.name),
      },
    };
  }

  // ── Workspace-sync commands: no target picking, they act on the config ──────
  if (cmd === 'push' || cmd === 'pull' || cmd === 'sync') {
    if (!callerWs.sync?.enabled || !(callerWs.sync.targets ?? []).some((t) => t.enabled)) {
      return { ok: false, error: 'sync_not_configured', data: { message: 'workspace sync is not configured/enabled; use `send`/`get` with --target instead' } };
    }
    if (!root) {
      return { ok: false, error: 'no_workspace_dir', data: { message: 'this workspace has no working directory, so local paths cannot be resolved' } };
    }

    if (cmd === 'sync') {
      const result = await window.electronAPI.runWorkspaceSyncNow(syncOptions(callerWs, newTransferId()));
      return { ok: true, data: { command: 'sync', ...(result as Record<string, unknown>) } };
    }

    if (rawRest.length === 0) {
      return { ok: false, error: 'missing_path', data: { message: `usage: ${cmd} <path...>  (paths are relative to the workspace directory)` } };
    }
    const paths: string[] = [];
    for (const p of rawRest) {
      const abs = resolveAgentLocalPath(root, p, sep);
      if (!abs) return { ok: false, error: 'path_out_of_scope', data: { message: 'local paths must stay inside the workspace directory', path: p, workspaceDir: root } };
      paths.push(abs);
    }
    const api = cmd === 'push' ? window.electronAPI.sftpPushPaths : window.electronAPI.sftpPullPaths;
    const result = await api(paths, syncOptions(callerWs, newTransferId())) as Record<string, unknown>;
    return { ok: true, data: { command: cmd, paths, ...result } };
  }

  // ── Everything else acts on ONE host ───────────────────────────────────────
  const picked = takeTarget(rawRest);
  const { target, error } = pickTarget(targets, picked.target);
  if (error) return error;
  const t = target!;
  const st = sftpTargetFor(callerWs, t);
  const args = picked.rest;

  const remote = (p: string): string | null => resolveAgentRemotePath(t.remoteRoot, p);
  const outOfScope = (p: string): Reply => ({
    ok: false,
    error: 'remote_out_of_scope',
    data: t.remoteRoot
      ? { message: 'remote paths must stay inside this target\'s remote root', path: p, remoteRoot: t.remoteRoot }
      : { message: 'give an absolute remote path for an SSH-pane target (it has no configured remote root)', path: p },
  });

  switch (cmd) {
    case 'ls': {
      const p = remote(args[0] ?? (t.remoteRoot ?? ''));
      if (!p) return outOfScope(args[0] ?? '');
      const entries = await window.electronAPI.sftpStatDir(st, p) as RemoteDirEntry[];
      return {
        ok: true,
        data: {
          target: t.name,
          path: p,
          entries: entries.map((e) => ({
            name: e.filename, dir: e.isDirectory, size: e.size, mtime: e.mtime,
          })),
        },
      };
    }

    case 'stat': {
      if (!args[0]) return { ok: false, error: 'missing_path', data: { message: 'usage: stat <remote>' } };
      const p = remote(args[0]);
      if (!p) return outOfScope(args[0]);
      // There is no single-entry stat IPC: list the PARENT and pick the entry.
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      const base = remoteBasename(p);
      const entries = await window.electronAPI.sftpStatDir(st, parent) as RemoteDirEntry[];
      const found = entries.find((e) => e.filename === base);
      if (!found) return { ok: false, error: 'not_found', data: { target: t.name, path: p } };
      return {
        ok: true,
        data: { target: t.name, path: p, dir: found.isDirectory, size: found.size, mtime: found.mtime, mode: found.mode },
      };
    }

    case 'cat': {
      if (!args[0]) return { ok: false, error: 'missing_path', data: { message: 'usage: cat <remote>' } };
      const p = remote(args[0]);
      if (!p) return outOfScope(args[0]);
      const file = await window.electronAPI.sftpReadFile(st, p);
      return { ok: true, data: { target: t.name, path: p, ...file } };
    }

    case 'get': {
      if (!args[0]) return { ok: false, error: 'missing_path', data: { message: 'usage: get <remote> [local-dir]' } };
      const p = remote(args[0]);
      if (!p) return outOfScope(args[0]);
      const localDir = resolveAgentLocalPath(root, args[1] ?? '.', sep);
      if (!localDir) {
        return { ok: false, error: 'path_out_of_scope', data: { message: 'the download directory must be inside the workspace directory', path: args[1] ?? '.', workspaceDir: root } };
      }
      // Probe whether it's a directory: listing a file errors, and the download
      // IPC needs to know which it is to walk it.
      let isDirectory = false;
      try {
        await window.electronAPI.sftpStatDir(st, p);
        isDirectory = true;
      } catch { /* a file (or unreadable — the transfer reports that) */ }
      const result = await window.electronAPI.sftpDownload(st, [{ path: p, isDirectory }], localDir, newTransferId());
      return {
        ok: !!(result as { ok?: boolean }).ok,
        data: {
          command: 'get', target: t.name, remote: p, localDir,
          local: `${localDir}${sep}${remoteBasename(p)}`,
          ...(result as Record<string, unknown>),
        },
      };
    }

    case 'send': {
      if (args.length === 0) return { ok: false, error: 'missing_path', data: { message: 'usage: send <local...> [remote-dir]' } };
      // The trailing arg is the remote dir when more than one path is given;
      // with a single path it's optional (defaults to the target's root).
      let remoteDirArg: string | undefined;
      let localArgs = args;
      if (args.length > 1) {
        remoteDirArg = args[args.length - 1];
        localArgs = args.slice(0, -1);
      }
      const remoteDir = remote(remoteDirArg ?? (t.remoteRoot ?? ''));
      if (!remoteDir) return outOfScope(remoteDirArg ?? '');

      const locals: string[] = [];
      for (const p of localArgs) {
        const abs = resolveAgentLocalPath(root, p, sep);
        if (!abs) return { ok: false, error: 'path_out_of_scope', data: { message: 'local paths must stay inside the workspace directory', path: p, workspaceDir: root } };
        locals.push(abs);
      }
      const result = await window.electronAPI.sftpUpload(st, locals, remoteDir, newTransferId());
      return {
        ok: !!(result as { ok?: boolean }).ok,
        data: { command: 'send', target: t.name, remoteDir, locals, ...(result as Record<string, unknown>) },
      };
    }

    case 'mkdir': {
      if (!args[0]) return { ok: false, error: 'missing_path', data: { message: 'usage: mkdir <remote>' } };
      const p = remote(args[0]);
      if (!p) return outOfScope(args[0]);
      await window.electronAPI.sftpMkdir(st, p);
      return { ok: true, data: { command: 'mkdir', target: t.name, path: p } };
    }

    case 'mv': {
      if (!args[0] || !args[1]) return { ok: false, error: 'missing_path', data: { message: 'usage: mv <old-remote> <new-remote>' } };
      const from = remote(args[0]);
      const to = remote(args[1]);
      if (!from) return outOfScope(args[0]);
      if (!to) return outOfScope(args[1]);
      await window.electronAPI.sftpRename(st, from, to);
      return { ok: true, data: { command: 'mv', target: t.name, from, to } };
    }

    case 'rm': {
      const { present: force, rest } = takeFlag(args, '--force');
      if (!rest[0]) return { ok: false, error: 'missing_path', data: { message: 'usage: rm <remote> --force' } };
      if (!force) {
        return { ok: false, error: 'force_required', data: { message: 'deleting on a remote host is irreversible — repeat with --force if you mean it', path: rest[0] } };
      }
      const p = remote(rest[0]);
      if (!p) return outOfScope(rest[0]);
      await window.electronAPI.sftpDeletePath(st, p);
      return { ok: true, data: { command: 'rm', target: t.name, path: p, deleted: true } };
    }

    default:
      return { ok: false, error: 'unknown_command', data: { command: cmd, ...HELP } };
  }
}

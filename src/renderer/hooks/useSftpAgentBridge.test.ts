import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSftpAgentCommand } from './useSftpAgentBridge';
import type { Workspace, SavedConnection } from '../../shared/types';

// The dispatch is where an agent's SFTP request meets the user's data: it picks
// the host, enforces the write gate main handed it, and confines both sides'
// paths. These tests drive it against a fake electronAPI so every branch is
// exercised without Electron or a real server.

const CONN: SavedConnection[] = [
  { id: 'c-prod', label: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', authMethod: 'password' },
  { id: 'c-box', label: 'devbox', host: '10.0.0.9', port: 22, username: 'root', authMethod: 'password' },
];

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Main',
    workingDirectory: '/Users/me/project',
    layoutTree: null,
    containers: [
      { id: 'cont-1', content: { type: 'terminal', terminalType: 'local', terminalId: 'term-1' } },
    ],
    containerZooms: {},
    focusedContainerId: null,
    ...over,
  } as Workspace;
}

const SYNCED = workspace({
  sync: {
    enabled: true,
    useGitIgnore: true,
    targets: [{ id: 'st-1', name: 'prod', enabled: true, connectionId: 'c-prod', remotePath: '/srv/app' }],
  },
});

let api: Record<string, ReturnType<typeof vi.fn> | string>;

beforeEach(() => {
  api = {
    platform: 'darwin',
    sftpStatDir: vi.fn(async () => [
      { filename: 'app.js', isDirectory: false, isSymlink: false, size: 12, mtime: 1, mode: 33188 },
    ]),
    sftpReadFile: vi.fn(async () => ({ content: 'hello', size: 5, truncated: false, isBinary: false })),
    sftpMkdir: vi.fn(async () => undefined),
    sftpRename: vi.fn(async () => undefined),
    sftpDeletePath: vi.fn(async () => undefined),
    sftpUpload: vi.fn(async () => ({ ok: true, transferred: 1, total: 1, errors: [] })),
    sftpDownload: vi.fn(async () => ({ ok: true, transferred: 1, total: 1, errors: [] })),
    sftpPushPaths: vi.fn(async () => ({ pushed: 2, total: 2, targetResults: [{ ok: true }] })),
    sftpPullPaths: vi.fn(async () => ({ pulled: 1, total: 1, targetResults: [{ ok: true }] })),
    runWorkspaceSyncNow: vi.fn(async () => ({ synced: 3, errors: 0 })),
  };
  (globalThis as unknown as { window: unknown }).window = { electronAPI: api };
  (globalThis as unknown as { crypto: Crypto }).crypto ??= { randomUUID: () => 'uuid' } as Crypto;
});

const run = (argv: string[], opts: { ws?: Workspace; write?: boolean } = {}) =>
  runSftpAgentCommand(
    { workspaces: [opts.ws ?? SYNCED], savedConnections: CONN },
    'term-1',
    argv,
    opts.write ?? false,
  );

describe('targets', () => {
  it('lists a sync target with its remote root', async () => {
    const res = await run(['targets']);
    expect(res.ok).toBe(true);
    expect(res.data?.targets).toEqual([
      expect.objectContaining({ name: 'prod', kind: 'sync', host: '10.0.0.5', remoteRoot: '/srv/app', enabled: true }),
    ]);
    expect(res.data?.default).toBe('prod');
  });

  it('includes the host of an SSH pane, with no remote root', async () => {
    const ws = workspace({
      containers: [
        { id: 'cont-1', content: { type: 'terminal', terminalType: 'local', terminalId: 'term-1' } },
        { id: 'cont-2', content: { type: 'terminal', terminalType: 'ssh', terminalId: 'term-2', connectionId: 'c-box' } },
      ],
    } as Partial<Workspace>);
    const res = await run(['targets'], { ws });
    expect(res.data?.targets).toEqual([
      expect.objectContaining({ name: 'devbox', kind: 'ssh', remoteRoot: null }),
    ]);
  });

  it('refuses host commands when the workspace has no remote at all', async () => {
    const res = await run(['ls', '/srv'], { ws: workspace() });
    expect(res.error).toBe('no_targets');
  });

  it('demands --target when several hosts are reachable', async () => {
    const ws = workspace({
      sync: SYNCED.sync,
      containers: [
        { id: 'cont-1', content: { type: 'terminal', terminalType: 'local', terminalId: 'term-1' } },
        { id: 'cont-2', content: { type: 'terminal', terminalType: 'ssh', terminalId: 'term-2', connectionId: 'c-box' } },
      ],
    } as Partial<Workspace>);
    const ambiguous = await run(['ls', '/srv/app'], { ws });
    expect(ambiguous.error).toBe('ambiguous_target');
    const picked = await run(['ls', '/srv/app', '--target', 'prod'], { ws });
    expect(picked.ok).toBe(true);
  });
});

describe('write gate', () => {
  it('refuses every mutating command while read-only', async () => {
    for (const argv of [['send', 'a.js'], ['push', 'a.js'], ['sync'], ['mkdir', 'x'], ['mv', 'a', 'b'], ['rm', 'a', '--force']]) {
      const res = await run(argv);
      expect(res.error).toBe('write_not_allowed');
    }
    expect(api.sftpUpload).not.toHaveBeenCalled();
  });

  it('allows reads and downloads while read-only', async () => {
    expect((await run(['ls', '/srv/app'])).ok).toBe(true);
    expect((await run(['cat', 'config.yml'])).ok).toBe(true);
    expect((await run(['get', '/srv/app/app.js'])).ok).toBe(true);
    expect((await run(['pull', 'src'])).ok).toBe(true);
  });
});

describe('path confinement', () => {
  it('refuses a local path that escapes the workspace', async () => {
    const res = await run(['send', '../../.ssh/id_rsa'], { write: true });
    expect(res.error).toBe('path_out_of_scope');
    expect(api.sftpUpload).not.toHaveBeenCalled();
  });

  it('refuses a remote path outside the sync target root', async () => {
    const res = await run(['cat', '/etc/passwd']);
    expect(res.error).toBe('remote_out_of_scope');
    expect(api.sftpReadFile).not.toHaveBeenCalled();
  });

  it('resolves remote paths relative to the target root', async () => {
    await run(['cat', 'config.yml']);
    expect(api.sftpReadFile).toHaveBeenCalledWith(
      { connectionId: 'c-prod', workspaceId: 'ws-1', containerId: 'agent-sftp:c-prod' },
      '/srv/app/config.yml',
    );
  });

  it('refuses a relative remote path on an SSH-pane target', async () => {
    const ws = workspace({
      containers: [
        { id: 'cont-1', content: { type: 'terminal', terminalType: 'local', terminalId: 'term-1' } },
        { id: 'cont-2', content: { type: 'terminal', terminalType: 'ssh', terminalId: 'term-2', connectionId: 'c-box' } },
      ],
    } as Partial<Workspace>);
    expect((await run(['ls', 'relative/dir'], { ws })).error).toBe('remote_out_of_scope');
    expect((await run(['ls', '/var/log'], { ws })).ok).toBe(true);
  });
});

describe('transfers', () => {
  it('send uploads workspace-relative paths into the remote dir', async () => {
    const res = await run(['send', 'dist/app.js', 'public'], { write: true });
    expect(res.ok).toBe(true);
    expect(api.sftpUpload).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c-prod' }),
      ['/Users/me/project/dist/app.js'],
      '/srv/app/public',
      expect.stringContaining('agent-'),
    );
  });

  it('send with a single path defaults to the target root', async () => {
    await run(['send', 'dist/app.js'], { write: true });
    expect(api.sftpUpload).toHaveBeenCalledWith(expect.anything(), ['/Users/me/project/dist/app.js'], '/srv/app', expect.anything());
  });

  it('get downloads into the workspace and reports the local path', async () => {
    const res = await run(['get', 'logs/app.log', 'tmp']);
    expect(api.sftpDownload).toHaveBeenCalledWith(
      expect.anything(),
      [{ path: '/srv/app/logs/app.log', isDirectory: true }], // statDir succeeded in the stub
      '/Users/me/project/tmp',
      expect.anything(),
    );
    expect(res.data?.local).toBe('/Users/me/project/tmp/app.log');
  });

  it('push/pull go through the workspace sync options', async () => {
    await run(['push', 'src'], { write: true });
    expect(api.sftpPushPaths).toHaveBeenCalledWith(
      ['/Users/me/project/src'],
      expect.objectContaining({ workspaceId: 'ws-1', localRootPath: '/Users/me/project', sync: SYNCED.sync }),
    );
  });

  it('sync refuses when the workspace has no enabled sync target', async () => {
    const res = await run(['sync'], { ws: workspace(), write: true });
    expect(res.error).toBe('sync_not_configured');
    expect(api.runWorkspaceSyncNow).not.toHaveBeenCalled();
  });
});

describe('destructive guard', () => {
  it('rm needs --force', async () => {
    const res = await run(['rm', 'old.js'], { write: true });
    expect(res.error).toBe('force_required');
    expect(api.sftpDeletePath).not.toHaveBeenCalled();
  });

  it('rm --force deletes inside the target root', async () => {
    const res = await run(['rm', 'old.js', '--force'], { write: true });
    expect(res.ok).toBe(true);
    expect(api.sftpDeletePath).toHaveBeenCalledWith(expect.anything(), '/srv/app/old.js');
  });
});

describe('misc', () => {
  it('help reports the current write capability', async () => {
    expect((await run(['help'])).data?.writeAllowed).toBe(false);
    expect((await run(['help'], { write: true })).data?.writeAllowed).toBe(true);
  });

  it('unknown commands come back with the command list', async () => {
    const res = await run(['rsync', 'x']);
    expect(res.error).toBe('unknown_command');
    expect(res.data?.commands).toBeTruthy();
  });
});

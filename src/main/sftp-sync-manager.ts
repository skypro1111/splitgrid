import { Client } from 'ssh2';
import { readFileSync } from 'node:fs';
import type { SSHConnectionConfig, RemoteDirEntry, RemoteFileContent } from '../shared/types';
import { LEGACY_SSH_ALGORITHMS } from './ssh-legacy-algorithms';
import { makeHostVerifier } from './known-hosts-store';
import { hostKeyChangedMessage } from '../shared/host-key';
import { TMUX_BLOCK, SCREEN_BLOCK, transformConfig } from './terminal-mouse-config';

type ConnectionConfig = Omit<SSHConnectionConfig, 'id'>;

const CONNECT_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const READDIR_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 1;
// Largest file the in-app editor will open over SFTP; bigger files are
// reported as truncated so the renderer can offer download instead.
const MAX_EDIT_SIZE = 5 * 1024 * 1024;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Minimal shapes for the ssh2 SFTP callback payloads the file-manager methods
// read (session.sftp itself is loosely typed, so we annotate at the call site).
interface SftpFileEntry {
  filename: string;
  attrs?: { mode?: number; size?: number; mtime?: number };
}
interface SftpStats {
  size?: number;
}

interface CachedSession {
  client: Client;
  sftp: any;
  signature: string;
  alive: boolean;
  /** Directories already confirmed to exist on this session (skip redundant mkdir) */
  knownDirs: Set<string>;
}

function signatureOf(config: ConnectionConfig): string {
  return [
    config.host,
    String(config.port),
    config.username,
    config.authMethod,
    config.privateKeyPath ?? '',
  ].join('|');
}

function isConnectionError(err: Error): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('no sftp') ||
    msg.includes('channel') ||
    msg.includes('socket') ||
    msg.includes('eof') ||
    msg.includes('timeout') ||
    msg.includes('reset') ||
    msg.includes('broken pipe') ||
    msg.includes('ended') ||
    msg.includes('closed')
  );
}

function connectSftp(config: ConnectionConfig): Promise<CachedSession> {
  const client = new Client();
  const signature = signatureOf(config);
  // Set by hostVerifier when the server's key differs from the pinned one, so
  // the connection rejects with a clear "host key changed" message.
  let hostKeyMismatch: { expected: string; actual: string } | null = null;

  const connectConfig: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.username,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    readyTimeout: CONNECT_TIMEOUT_MS,
    // Fall back to legacy KEX / host-key algorithms for old servers (appended
    // last, so modern servers keep using strong algorithms).
    algorithms: LEGACY_SSH_ALGORITHMS,
    // TOFU host-key pinning: pin on first sight, fail closed if it changes.
    hostVerifier: makeHostVerifier(config.host, config.port, (m) => { hostKeyMismatch = m; }),
  };

  if (config.authMethod === 'password') {
    connectConfig.password = config.password;
  } else {
    if (!config.privateKeyPath) {
      throw new Error('Missing private key path');
    }
    connectConfig.privateKey = readFileSync(config.privateKeyPath);
    connectConfig.passphrase = config.passphrase;
  }

  return new Promise<CachedSession>((resolve, reject) => {
    let settled = false;

    const onError = (err: Error) => {
      if (!settled) {
        settled = true;
        client.removeAllListeners();
        reject(hostKeyMismatch
          ? new Error(hostKeyChangedMessage({ host: config.host, port: config.port, ...hostKeyMismatch }))
          : err);
      }
      // After settlement: swallow — session.alive=false handles reconnect
    };

    client.on('error', onError);

    client.once('ready', () => {
      client.sftp((err, sftp) => {
        if (err) {
          settled = true;
          client.removeAllListeners();
          client.end();
          reject(err);
          return;
        }
        settled = true;
        const session: CachedSession = { client, sftp, signature, alive: true, knownDirs: new Set() };

        // Replace connection-phase handler with liveness tracker
        client.removeAllListeners('error');
        client.on('error', () => { session.alive = false; });
        client.on('close', () => { session.alive = false; });
        client.on('end', () => { session.alive = false; });

        resolve(session);
      });
    });

    client.connect(connectConfig as Parameters<Client['connect']>[0]);
  });
}

export class SFTPSyncManager {
  private sessions = new Map<string, CachedSession>();
  private pendingConnects = new Map<string, Promise<CachedSession>>();

  private sessionKey(workspaceId: string, targetId: string): string {
    return `${workspaceId}:${targetId}`;
  }

  private async getSession(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig
  ): Promise<CachedSession> {
    const key = this.sessionKey(workspaceId, targetId);
    const current = this.sessions.get(key);
    const signature = signatureOf(config);

    // Return cached session if alive and matching config
    if (current && current.alive && current.signature === signature) {
      return current;
    }

    // Dispose dead/mismatched session
    if (current) {
      try { current.client.end(); } catch { /* ignore */ }
      this.sessions.delete(key);
    }

    // Deduplicate concurrent connection attempts for the same key
    const pending = this.pendingConnects.get(key);
    if (pending) return pending;

    const promise = connectSftp(config).then((created) => {
      this.sessions.set(key, created);
      this.pendingConnects.delete(key);
      return created;
    }).catch((err) => {
      this.pendingConnects.delete(key);
      throw err;
    });
    this.pendingConnects.set(key, promise);
    return promise;
  }

  /** Invalidate a specific session so next call reconnects */
  private invalidateSession(workspaceId: string, targetId: string): void {
    const key = this.sessionKey(workspaceId, targetId);
    const session = this.sessions.get(key);
    if (session) {
      session.alive = false;
      try { session.client.end(); } catch { /* ignore */ }
      this.sessions.delete(key);
    }
  }

  /** Run an operation with automatic retry on connection errors */
  private async withRetry<T>(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    op: (session: CachedSession) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const session = await this.getSession(workspaceId, targetId, config);
      try {
        return await op(session);
      } catch (err) {
        if (attempt < MAX_RETRIES && isConnectionError(err as Error)) {
          console.warn(`[sftp] connection error, reconnecting (attempt ${attempt + 1}):`, (err as Error).message);
          this.invalidateSession(workspaceId, targetId);
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  async testConnection(config: ConnectionConfig): Promise<void> {
    const session = await connectSftp(config);
    session.client.end();
  }

  /**
   * Enable mouse-wheel scrolling for tmux/screen running ON this remote host by
   * writing SplitGrid's managed block into the remote ~/.tmux.conf and
   * ~/.screenrc (read-modify-write over SFTP, so the rest of those files is left
   * intact and re-applying is idempotent). Opens a throwaway connection.
   */
  async applyMouseScrollConfig(config: ConnectionConfig): Promise<void> {
    const session = await connectSftp(config);
    try {
      // Resolve the remote home so we don't depend on the SFTP root being it.
      const home = (await new Promise<string>((resolve, reject) => {
        session.sftp.realpath('.', (err: Error | undefined, p: string) => (err ? reject(err) : resolve(p)));
      })).replace(/\/+$/, '');

      const targets: Array<{ path: string; block: string }> = [
        { path: `${home}/.tmux.conf`, block: TMUX_BLOCK },
        { path: `${home}/.screenrc`, block: SCREEN_BLOCK },
      ];

      for (const t of targets) {
        const original = await this.readRemoteTextOrEmpty(session, t.path);
        const next = transformConfig(original, t.block, true);
        if (next === original) continue;
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            session.sftp.writeFile(t.path, Buffer.from(next, 'utf8'), (err: Error | undefined) =>
              (err ? reject(err) : resolve()));
          }),
          TRANSFER_TIMEOUT_MS,
          `writeFile ${t.path}`,
        );
      }
    } finally {
      try { session.client.end(); } catch { /* ignore */ }
    }
  }

  // Read a remote text file, treating "no such file" as empty so a missing
  // dotfile is simply created rather than failing the whole apply.
  private readRemoteTextOrEmpty(session: CachedSession, remotePath: string): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        session.sftp.readFile(remotePath, (err: (Error & { code?: number }) | undefined, data: Buffer) => {
          if (err) {
            if (err.code === 2 || /no such file/i.test(err.message)) return resolve('');
            return reject(err);
          }
          resolve(data.toString('utf8'));
        });
      }),
      TRANSFER_TIMEOUT_MS,
      `readFile ${remotePath}`,
    );
  }

  private async ensureRemoteDirWithSession(session: CachedSession, dir: string): Promise<void> {
    const normalized = dir.replace(/\\/g, '/');
    if (session.knownDirs.has(normalized)) return;

    const parts = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '/' : '';

    for (const part of parts) {
      current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part;
      if (session.knownDirs.has(current)) continue;
      await new Promise<void>((resolve) => {
        session.sftp.mkdir(current, () => resolve());
      });
      session.knownDirs.add(current);
    }
    session.knownDirs.add(normalized);
  }

  async ensureRemoteDir(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remoteDir: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, (session) =>
      this.ensureRemoteDirWithSession(session, remoteDir));
  }

  /** Push file directly — caller manages concurrency */
  async syncFileDirect(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    localFile: string,
    remoteFile: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const remoteDir = remoteFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      await this.ensureRemoteDirWithSession(session, remoteDir);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          session.sftp.fastPut(localFile, remoteFile, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        TRANSFER_TIMEOUT_MS,
        `fastPut ${localFile}`,
      );
    });
  }

  /** Pull file directly — caller manages concurrency */
  async pullFileDirect(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remoteFile: string,
    localFile: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const localDir = localFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (localDir) {
        const { mkdir: mkdirFs } = await import('node:fs/promises');
        await mkdirFs(localDir, { recursive: true }).catch(() => {});
      }
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          session.sftp.fastGet(remoteFile, localFile, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        TRANSFER_TIMEOUT_MS,
        `fastGet ${remoteFile}`,
      );
    });
  }

  /** Push file (queued — for auto-sync on save) */
  async syncFile(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    localFile: string,
    remoteFile: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const remoteDir = remoteFile
        .replace(/\\/g, '/')
        .split('/')
        .slice(0, -1)
        .join('/') || '/';
      await this.ensureRemoteDirWithSession(session, remoteDir);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          session.sftp.fastPut(localFile, remoteFile, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        TRANSFER_TIMEOUT_MS,
        `fastPut ${localFile}`,
      );
    });
  }

  /** Pull file (queued) */
  async pullFile(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remoteFile: string,
    localFile: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const localDir = localFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (localDir) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(localDir, { recursive: true }).catch(() => {});
      }
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          session.sftp.fastGet(remoteFile, localFile, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        TRANSFER_TIMEOUT_MS,
        `fastGet ${remoteFile}`,
      );
    });
  }

  async listRemoteDir(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<Array<{ filename: string; isDirectory: boolean }>> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const entries = await withTimeout(
        new Promise<any[]>((resolve, reject) => {
          session.sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
            if (err) reject(err);
            else resolve(list ?? []);
          });
        }),
        READDIR_TIMEOUT_MS,
        `readdir ${remotePath}`,
      );
      return entries
        .filter(e => e.filename && e.filename !== '.' && e.filename !== '..')
        .map(e => ({
          filename: e.filename as string,
          isDirectory: !!(e.attrs && typeof e.attrs.mode === 'number' && (e.attrs.mode & 0o40000) !== 0),
        }));
    });
  }

  async deleteRemotePath(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const sftp = session.sftp;

      const lstat = await new Promise<any>((resolve, reject) => {
        sftp.lstat(remotePath, (err: Error | undefined, stats: any) => {
          if (err) reject(err);
          else resolve(stats);
        });
      }).catch(() => null);
      if (!lstat) return;

      const removeRecursive = async (p: string): Promise<void> => {
        const st = await new Promise<any>((resolve, reject) => {
          sftp.lstat(p, (err: Error | undefined, stats: any) => {
            if (err) reject(err);
            else resolve(stats);
          });
        }).catch(() => null);
        if (!st) return;
        if (typeof st.isDirectory === 'function' && st.isDirectory()) {
          const entries = await new Promise<any[]>((resolve, reject) => {
            sftp.readdir(p, (err: Error | undefined, list: any[]) => {
              if (err) reject(err);
              else resolve(list ?? []);
            });
          }).catch(() => []);
          for (const entry of entries) {
            const name = entry.filename as string;
            if (!name || name === '.' || name === '..') continue;
            await removeRecursive(`${p}/${name}`.replace(/\/{2,}/g, '/'));
          }
          await new Promise<void>((resolve, reject) => {
            sftp.rmdir(p, (err: Error | undefined) => (err ? reject(err) : resolve()));
          }).catch(() => {});
          return;
        }
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(p, (err: Error | undefined) => (err ? reject(err) : resolve()));
        }).catch(() => {});
      };

      await removeRecursive(remotePath.replace(/\\/g, '/'));
    });
  }

  /** Like listRemoteDir but returns rich stat info per entry (for the file manager). */
  async statRemoteDir(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<RemoteDirEntry[]> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const entries = await withTimeout(
        new Promise<SftpFileEntry[]>((resolve, reject) => {
          session.sftp.readdir(remotePath, (err: Error | undefined, list: SftpFileEntry[]) => {
            if (err) reject(err);
            else resolve(list ?? []);
          });
        }),
        READDIR_TIMEOUT_MS,
        `readdir ${remotePath}`,
      );
      return entries
        .filter(e => e.filename && e.filename !== '.' && e.filename !== '..')
        .map(e => {
          const attrs = e.attrs ?? {};
          const mode = typeof attrs.mode === 'number' ? attrs.mode : 0;
          return {
            filename: e.filename as string,
            isDirectory: (mode & 0o40000) !== 0,
            isSymlink: (mode & 0o120000) === 0o120000,
            size: attrs.size ?? 0,
            mtime: attrs.mtime ?? 0,
            mode,
          } satisfies RemoteDirEntry;
        });
    });
  }

  /** Create a single remote directory; rejects on error (unlike ensureRemoteDir). */
  async mkdirRemote(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const normalized = remotePath.replace(/\\/g, '/');
      await new Promise<void>((resolve, reject) => {
        session.sftp.mkdir(normalized, (err: Error | undefined) => (err ? reject(err) : resolve()));
      });
    });
  }

  /** Rename / move a remote path. */
  async renameRemote(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const from = oldPath.replace(/\\/g, '/');
      const to = newPath.replace(/\\/g, '/');
      await new Promise<void>((resolve, reject) => {
        session.sftp.rename(from, to, (err: Error | undefined) => (err ? reject(err) : resolve()));
      });
    });
  }

  /** Read a remote file's contents for editing; guards size and detects binary. */
  async readRemoteFile(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<RemoteFileContent> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const normalized = remotePath.replace(/\\/g, '/');
      const stats = await new Promise<SftpStats>((resolve, reject) => {
        session.sftp.stat(normalized, (err: Error | undefined, st: SftpStats) => (err ? reject(err) : resolve(st)));
      });
      const size: number = stats?.size ?? 0;
      if (size > MAX_EDIT_SIZE) {
        return { content: '', size, truncated: true, isBinary: false };
      }
      const buf = await withTimeout(
        new Promise<Buffer>((resolve, reject) => {
          session.sftp.readFile(normalized, (err: Error | undefined, data: Buffer) => (err ? reject(err) : resolve(data)));
        }),
        TRANSFER_TIMEOUT_MS,
        `readFile ${normalized}`,
      );
      if (buf.includes(0)) {
        return { content: '', size, truncated: false, isBinary: true };
      }
      return { content: buf.toString('utf8'), size, truncated: false, isBinary: false };
    });
  }

  /** Write (overwrite) a remote file's UTF-8 contents. */
  async writeRemoteFile(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string,
    content: string
  ): Promise<void> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const normalized = remotePath.replace(/\\/g, '/');
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          session.sftp.writeFile(normalized, Buffer.from(content, 'utf8'), (err: Error | undefined) =>
            (err ? reject(err) : resolve()));
        }),
        TRANSFER_TIMEOUT_MS,
        `writeFile ${normalized}`,
      );
    });
  }

  /** Resolve a remote path to its canonical absolute form. */
  async realpathRemote(
    workspaceId: string,
    targetId: string,
    config: ConnectionConfig,
    remotePath: string
  ): Promise<string> {
    return this.withRetry(workspaceId, targetId, config, async (session) => {
      const normalized = remotePath.replace(/\\/g, '/');
      return new Promise<string>((resolve, reject) => {
        session.sftp.realpath(normalized, (err: Error | undefined, resolved: string) =>
          (err ? reject(err) : resolve(resolved)));
      });
    });
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(`${workspaceId}:`)) continue;
      session.alive = false;
      try { session.client.end(); } catch { /* ignore */ }
      this.sessions.delete(key);
    }
  }

  closeAll(): void {
    for (const [, session] of this.sessions) {
      session.alive = false;
      try { session.client.end(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    this.pendingConnects.clear();
  }
}

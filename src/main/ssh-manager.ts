import { Client, ClientChannel } from 'ssh2';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  SSHConnectionConfig,
  TerminalResourceInfo,
} from '../shared/types';
import { endsWithPasswordPrompt } from './ssh-prompt';
import { LEGACY_SSH_ALGORITHMS } from './ssh-legacy-algorithms';
import { makeHostVerifier } from './known-hosts-store';
import { hostKeyChangedMessage } from '../shared/host-key';

interface SSHSessionInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  createdAt: number;
}

const MAX_BUFFER_SIZE = 100_000;

interface SSHSession {
  client: Client;
  channel: ClientChannel | null;
  config: SSHConnectionConfig;
  info: SSHSessionInfo;
  buffer: string;
  inputBytes: number;
  outputBytes: number;
  lastDataAt?: number;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  // True between detecting a password prompt and the next non-prompt output,
  // so we offer the saved password once per prompt rather than on every chunk.
  promptPending?: boolean;
}

interface SessionCallbacks {
  onData: (sessionId: string, data: string) => void;
  onReady: (sessionId: string) => void;
  onClose: (sessionId: string, info?: { exitedCleanly: boolean }) => void;
  onError: (sessionId: string, message: string) => void;
  // Fired when a password/sudo prompt is detected on an opted-in connection.
  onPasswordPrompt?: (sessionId: string, label: string, source: 'sudo' | 'login') => void;
}

export class SSHManager {
  private sessions = new Map<string, SSHSession>();
  private callbacks: SessionCallbacks | null = null;

  setCallbacks(callbacks: SessionCallbacks): void {
    this.callbacks = callbacks;
  }

  createSession(
    config: SSHConnectionConfig,
    callbacks?: SessionCallbacks
  ): Promise<SSHSessionInfo> {
    const cb = callbacks || this.callbacks;
    if (!cb) {
      return Promise.reject(new Error('No callbacks registered'));
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      // Set by hostVerifier when the server's key differs from the pinned one,
      // so client.on('error') can report a clear "host key changed" message.
      let hostKeyMismatch: { expected: string; actual: string } | null = null;
      const info: SSHSessionInfo = {
        id: config.id,
        label: config.label,
        host: config.host,
        port: config.port,
        username: config.username,
        status: 'connecting',
        createdAt: Date.now(),
      };

      const session: SSHSession = {
        client, channel: null, config, info, buffer: '',
        inputBytes: 0,
        outputBytes: 0,
        stdoutDecoder: new StringDecoder('utf8'),
        stderrDecoder: new StringDecoder('utf8'),
      };
      this.sessions.set(config.id, session);

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: 80, rows: 24 },
          (err, channel) => {
            if (err) {
              info.status = 'error';
              cb.onError(config.id, err.message);
              // The transport is already up (client fired 'ready'), so no
              // 'close'/'error' will follow on its own — tear the client down
              // and drop the session, else it lingers with keepalive running.
              try { client.end(); } catch { /* already closing */ }
              this.sessions.delete(config.id);
              if (!settled) { settled = true; reject(err); }
              return;
            }

            session.channel = channel;
            info.status = 'connected';
            cb.onReady(config.id);
            if (!settled) { settled = true; resolve(info); }

            channel.on('data', (data: Buffer) => {
              const str = session.stdoutDecoder.write(data);
              if (!str) return;
              session.buffer += str;
              session.outputBytes += data.length;
              session.lastDataAt = Date.now();
              if (session.buffer.length > MAX_BUFFER_SIZE) {
                const trimChars = session.buffer.length - MAX_BUFFER_SIZE;
                session.buffer = session.buffer.slice(
                  trimChars
                );
              }
              cb.onData(config.id, str);
              this.detectPrompt(session, cb);
            });

            channel.stderr.on('data', (data: Buffer) => {
              const str = session.stderrDecoder.write(data);
              if (!str) return;
              session.buffer += str;
              session.outputBytes += data.length;
              session.lastDataAt = Date.now();
              if (session.buffer.length > MAX_BUFFER_SIZE) {
                const trimChars = session.buffer.length - MAX_BUFFER_SIZE;
                session.buffer = session.buffer.slice(
                  trimChars
                );
              }
              cb.onData(config.id, str);
              this.detectPrompt(session, cb);
            });

            channel.on('close', () => {
              info.status = 'disconnected';
              // The remote shell closed its channel — a clean logout / `exit`.
              cb.onClose(config.id, { exitedCleanly: true });
              this.sessions.delete(config.id);
            });
          }
        );
      });

      client.on('error', (err) => {
        info.status = 'error';
        const message = hostKeyMismatch
          ? hostKeyChangedMessage({ host: config.host, port: config.port, ...hostKeyMismatch })
          : err.message;
        cb.onError(config.id, message);
        this.sessions.delete(config.id);
        if (!settled) { settled = true; reject(new Error(message)); }
      });

      client.on('close', () => {
        if (info.status === 'connected' || info.status === 'connecting') {
          // Transport closed while still up (no channel close first) — an
          // unexpected drop, not a logout. Keep the container for reconnect.
          info.status = 'disconnected';
          cb.onClose(config.id, { exitedCleanly: false });
        }
        this.sessions.delete(config.id);
      });

      const connectConfig: Record<string, unknown> = {
        host: config.host,
        port: config.port,
        username: config.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        // Allow falling back to legacy KEX / host-key algorithms so we can still
        // connect to old servers; modern servers are unaffected (appended last).
        algorithms: LEGACY_SSH_ALGORITHMS,
        // TOFU host-key pinning: pin on first sight, fail closed if it changes.
        hostVerifier: makeHostVerifier(config.host, config.port, (m) => { hostKeyMismatch = m; }),
      };

      if (config.authMethod === 'password') {
        connectConfig.password = config.password;
      } else if (config.authMethod === 'privateKey') {
        try {
          connectConfig.privateKey = readFileSync(config.privateKeyPath!);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (err) {
          this.sessions.delete(config.id);
          reject(new Error(`Failed to read private key: ${(err as Error).message}`));
          return;
        }
      }

      client.connect(connectConfig as Parameters<Client['connect']>[0]);
    });
  }

  sendData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.channel) {
      session.inputBytes += Buffer.byteLength(data, 'utf8');
      session.channel.write(data);
    }
  }

  // Resolve the credential to offer at a prompt: a dedicated sudo password if
  // set, else the login password. Never leaves the main process.
  private credentialFor(session: SSHSession): { value: string; source: 'sudo' | 'login' } | null {
    const sudo = session.config.sudoPassword;
    if (sudo) return { value: sudo, source: 'sudo' };
    const login = session.config.password;
    if (login) return { value: login, source: 'login' };
    return null;
  }

  // After each chunk, check whether the buffer now ENDS in a password prompt.
  // Gated on the connection opting in (offerSavedPassword) and having a stored
  // credential. Fires onPasswordPrompt at most once per prompt; the pending flag
  // clears as soon as non-prompt output arrives (prompt answered / moved on).
  private detectPrompt(session: SSHSession, cb: SessionCallbacks): void {
    if (!cb.onPasswordPrompt) return;
    if (!session.config.offerSavedPassword) return;
    const cred = this.credentialFor(session);
    if (!cred) return;
    const atPrompt = endsWithPasswordPrompt(session.buffer);
    if (atPrompt) {
      if (session.promptPending) return; // already offered for this prompt
      session.promptPending = true;
      cb.onPasswordPrompt(session.info.id, session.info.label, cred.source);
    } else {
      session.promptPending = false;
    }
  }

  // User confirmed in the UI: inject the saved password + Enter into the PTY.
  // The password is read here in main and written straight to the channel — it
  // is never sent to the renderer. Returns false if nothing was sent.
  applyStoredPassword(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.channel) return false;
    const cred = this.credentialFor(session);
    if (!cred) return false;
    const data = cred.value + '\n';
    session.inputBytes += Buffer.byteLength(data, 'utf8');
    session.channel.write(data);
    session.promptPending = false;
    return true;
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.channel) {
      session.channel.setWindow(rows, cols, 0, 0);
    }
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.channel) {
        session.channel.close();
      }
      session.client.end();
      this.sessions.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }

  getSessionBuffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.buffer ?? '';
  }

  getSessionInfo(sessionId: string): SSHSessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  getAllSessions(): SSHSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  getAllDiagnostics(): TerminalResourceInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.info.id,
      type: 'ssh',
      label: s.info.label,
      status: s.info.status,
      host: s.info.host,
      port: s.info.port,
      username: s.info.username,
      inputBytes: s.inputBytes,
      outputBytes: s.outputBytes,
      bufferSize: s.buffer.length,
      lastDataAt: s.lastDataAt,
    }));
  }
}

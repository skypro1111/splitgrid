import { v4 as uuidv4 } from 'uuid';
import { SSHManager } from './ssh-manager';
import { LocalShellManager } from './local-shell-manager';
import type {
  SSHConnectionConfig,
  TerminalSessionInfo,
  LocalShellConfig,
  TerminalResourceSnapshot,
  TerminalProcessInfo,
  KillProcessResult,
} from '../shared/types';

interface TerminalCallbacks {
  onData: (sessionId: string, data: string) => void;
  onReady: (sessionId: string) => void;
  // `exitedCleanly` true means the shell/SSH session ended on its own (logout /
  // `exit`), as opposed to a connection drop — the renderer uses it to decide
  // whether to close the terminal's container.
  onClose: (sessionId: string, info?: { exitedCleanly: boolean }) => void;
  onError: (sessionId: string, message: string) => void;
  // SSH only: a password/sudo prompt was detected on an opted-in connection.
  onPasswordPrompt?: (sessionId: string, label: string, source: 'sudo' | 'login') => void;
}

export class TerminalManager {
  private sshManager = new SSHManager();
  private localManager = new LocalShellManager();
  private typeMap = new Map<string, 'ssh' | 'local'>();

  setCallbacks(callbacks: TerminalCallbacks): void {
    this.sshManager.setCallbacks(callbacks);
    this.localManager.setCallbacks(callbacks);
  }

  async createSSHSession(
    config: SSHConnectionConfig
  ): Promise<TerminalSessionInfo> {
    this.typeMap.set(config.id, 'ssh');
    const sshInfo = await this.sshManager.createSession(config).catch((error) => {
      this.typeMap.delete(config.id);
      throw error;
    });
    return {
      id: sshInfo.id,
      type: 'ssh',
      label: sshInfo.label,
      status: sshInfo.status,
      createdAt: sshInfo.createdAt,
      host: sshInfo.host,
      port: sshInfo.port,
      username: sshInfo.username,
    };
  }

  createLocalShell(config?: LocalShellConfig, id = uuidv4()): TerminalSessionInfo {
    this.typeMap.set(id, 'local');
    return this.localManager.createShell(id, config);
  }

  sendData(id: string, data: string): void {
    const type = this.typeMap.get(id);
    if (type === 'ssh') {
      this.sshManager.sendData(id, data);
    } else if (type === 'local') {
      this.localManager.sendData(id, data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const type = this.typeMap.get(id);
    if (type === 'ssh') {
      this.sshManager.resizeTerminal(id, cols, rows);
    } else if (type === 'local') {
      this.localManager.resizeTerminal(id, cols, rows);
    }
  }

  closeSession(id: string): void {
    const type = this.typeMap.get(id);
    if (type === 'ssh') {
      this.sshManager.closeSession(id);
    } else if (type === 'local') {
      this.localManager.closeShell(id);
    }
    this.typeMap.delete(id);
  }

  closeAll(): void {
    this.sshManager.closeAll();
    this.localManager.closeAll();
    this.typeMap.clear();
  }

  shutdownForAppExit(): void {
    // Prevent callbacks into renderer while Electron is shutting down.
    const noopCallbacks: TerminalCallbacks = {
      onData: () => {},
      onReady: () => {},
      onClose: () => {},
      onError: () => {},
    };
    this.sshManager.setCallbacks(noopCallbacks);
    this.localManager.setCallbacks(noopCallbacks);

    this.sshManager.closeAll();
    this.localManager.shutdownForAppExit();
    this.typeMap.clear();
  }

  getBuffer(id: string): string {
    const type = this.typeMap.get(id);
    if (type === 'ssh') {
      return this.sshManager.getSessionBuffer(id);
    } else if (type === 'local') {
      return this.localManager.getBuffer(id);
    }
    return '';
  }

  getAllSessions(): TerminalSessionInfo[] {
    const sshSessions = this.sshManager.getAllSessions().map((s) => ({
      id: s.id,
      type: 'ssh' as const,
      label: s.label,
      status: s.status,
      createdAt: s.createdAt,
      host: s.host,
      port: s.port,
      username: s.username,
    }));
    const localSessions = this.localManager.getAllSessions();
    return [...sshSessions, ...localSessions];
  }

  getSSHManager(): SSHManager {
    return this.sshManager;
  }

  // Freeze/unfreeze a single session. Only local PTYs can be suspended; SSH has
  // no local child process to signal, so it reports unsupported and stays live.
  async pauseSession(id: string): Promise<{ supported: boolean; frozen: boolean }> {
    if (this.typeMap.get(id) === 'local') {
      return this.localManager.pauseShell(id);
    }
    return { supported: false, frozen: false };
  }

  async resumeSession(id: string): Promise<{ supported: boolean; frozen: boolean }> {
    if (this.typeMap.get(id) === 'local') {
      return this.localManager.resumeShell(id);
    }
    return { supported: false, frozen: false };
  }

  // Live process tree for a terminal. Local only — SSH child processes run on
  // the remote host and aren't visible to the local `ps`.
  async getProcessTree(id: string): Promise<TerminalProcessInfo[]> {
    if (this.typeMap.get(id) === 'local') {
      return this.localManager.getProcessTree(id);
    }
    return [];
  }

  async getResourceSnapshot(): Promise<TerminalResourceSnapshot> {
    const local = await this.localManager.getAllDiagnostics();
    return {
      collectedAt: Date.now(),
      processMetricsSupported: local.processMetricsSupported,
      sessions: [
        ...this.sshManager.getAllDiagnostics(),
        ...local.sessions,
      ],
    };
  }

  // Kill a port-holding process in a session's tree. Only local/WSL terminals
  // expose ports today, so SSH/unknown sessions are rejected.
  async killProcess(
    sessionId: string,
    pid: number,
    signal?: 'TERM' | 'KILL',
  ): Promise<KillProcessResult> {
    if (this.localManager.has(sessionId)) {
      return this.localManager.killProcess(sessionId, pid, signal);
    }
    return { ok: false, error: 'Killing processes is not supported for this session' };
  }
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Workspace, WorkspaceState } from '../shared/types';

// Hoisted state the electron mock reads at call time: app.getPath('userData')
// must return a per-test temp dir so the store writes nowhere real.
const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

// Imported AFTER the mock (vi.mock is hoisted above imports automatically).
import { WorkspaceStore } from './workspace-store';

let workDir: string;

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Project A',
    workingDirectory: null,
    layoutTree: null,
    containers: [],
    containerZooms: {},
    focusedContainerId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function makeState(workspaces: Workspace[]): WorkspaceState {
  return { activeWorkspaceId: workspaces[0]?.id ?? null, workspaces };
}

const folderFile = (dir: string) => path.join(dir, '.splitgrid', 'workspace.json');

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-ws-ud-'));
  workDir = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-ws-dir-'));
});
afterEach(() => {
  for (const d of [h.userData, workDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('per-workspace folder settings (.splitgrid)', () => {
  it('mirrors a folder-bound workspace into .splitgrid/workspace.json + writes a .gitignore', () => {
    const store = new WorkspaceStore();
    store.save(makeState([makeWorkspace({ workingDirectory: workDir, notes: 'hello' })]));

    expect(existsSync(folderFile(workDir))).toBe(true);
    const parsed = JSON.parse(readFileSync(folderFile(workDir), 'utf-8'));
    expect(parsed.workspace.notes).toBe('hello');
    expect(parsed.workspace.id).toBe('ws-1');

    const gitignore = path.join(workDir, '.splitgrid', '.gitignore');
    expect(existsSync(gitignore)).toBe(true);
    expect(readFileSync(gitignore, 'utf-8')).toContain('*');
  });

  it('does NOT create a folder file for a workspace without a workingDirectory', () => {
    const store = new WorkspaceStore();
    store.save(makeState([makeWorkspace({ workingDirectory: null })]));
    expect(existsSync(folderFile(workDir))).toBe(false);
  });

  it('skips silently when the workingDirectory no longer exists', () => {
    const store = new WorkspaceStore();
    const gone = path.join(workDir, 'deleted-subdir');
    expect(() =>
      store.save(makeState([makeWorkspace({ workingDirectory: gone })])),
    ).not.toThrow();
    expect(existsSync(folderFile(gone))).toBe(false);
  });

  it('treats the folder copy as authoritative on load (folder content wins)', () => {
    const store = new WorkspaceStore();
    // userData record says name "Old / env"; the folder says "New / folder".
    store.save(makeState([makeWorkspace({ workingDirectory: workDir, name: 'Old / env', notes: 'env-notes' })]));

    // Simulate the folder being updated out of band (e.g. another machine).
    const folderPayload = JSON.parse(readFileSync(folderFile(workDir), 'utf-8'));
    folderPayload.workspace.name = 'New / folder';
    folderPayload.workspace.notes = 'folder-notes';
    folderPayload.workspace.id = 'some-other-id';
    folderPayload.workspace.workingDirectory = '/somewhere/else';
    writeFileSync(folderFile(workDir), JSON.stringify(folderPayload), 'utf-8');

    const loaded = store.load();
    const ws = loaded!.workspaces[0];
    // Content comes from the folder...
    expect(ws.name).toBe('New / folder');
    expect(ws.notes).toBe('folder-notes');
    // ...but identity + folder binding stay tied to the environment entry.
    expect(ws.id).toBe('ws-1');
    expect(ws.workingDirectory).toBe(workDir);
  });

  it('falls back to the userData copy when no folder file is present', () => {
    const store = new WorkspaceStore();
    store.save(makeState([makeWorkspace({ workingDirectory: workDir, notes: 'env-only' })]));
    rmSync(path.join(workDir, '.splitgrid'), { recursive: true, force: true });

    const loaded = store.load();
    expect(loaded!.workspaces[0].notes).toBe('env-only');
  });
});

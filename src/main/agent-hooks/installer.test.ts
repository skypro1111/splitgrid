import { describe, it, expect, vi } from 'vitest';

// installer.ts → paths.ts imports electron's `app`. applyHooksToConfig itself is
// pure (takes root/def/helperPath), so a minimal app stub is enough to load it.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }));

import { applyHooksToConfig } from './installer';
import { CLAUDE } from './registry';

const HELPER = '/opt/splitgrid/splitgrid-hook.sh'; // contains the "splitgrid-hook" marker

type Entry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
const splitgridEntry = (list: Entry[]) => list.find((e) => e.hooks?.some((h) => h.command.includes('splitgrid-hook')));

describe('applyHooksToConfig', () => {
  it('writes a splitgrid hook for every Claude event into an empty config', () => {
    const root = applyHooksToConfig({}, CLAUDE, HELPER);
    const hooks = (root as any).hooks;
    for (const ev of CLAUDE.events) {
      const list: Entry[] = hooks[ev.agentEvent];
      expect(Array.isArray(list)).toBe(true);
      const mine = splitgridEntry(list)!;
      expect(mine.hooks[0]).toMatchObject({
        type: 'command',
        command: `"${HELPER}" ${ev.splitgridEvent}`,
        timeout: CLAUDE.timeoutMs,
      });
    }
  });

  it('sets matcher:"*" only for events that need one (Pre/PostToolUse)', () => {
    const hooks = (applyHooksToConfig({}, CLAUDE, HELPER) as any).hooks;
    expect(splitgridEntry(hooks.PreToolUse)!.matcher).toBe('*');
    expect(splitgridEntry(hooks.Stop)!.matcher).toBeUndefined();
  });

  it('is idempotent — applying twice leaves exactly one splitgrid entry per event', () => {
    let root = applyHooksToConfig({}, CLAUDE, HELPER);
    root = applyHooksToConfig(root, CLAUDE, HELPER);
    const hooks = (root as any).hooks;
    for (const ev of CLAUDE.events) {
      const owned = (hooks[ev.agentEvent] as Entry[]).filter((e) => e.hooks?.some((h) => h.command.includes('splitgrid-hook')));
      expect(owned).toHaveLength(1);
    }
  });

  it("preserves the user's own (non-splitgrid) hook entries", () => {
    const userEntry: Entry = { hooks: [{ type: 'command', command: 'my-own-linter.sh' }] };
    const root: any = { hooks: { Stop: [userEntry] } };
    applyHooksToConfig(root, CLAUDE, HELPER);
    expect(root.hooks.Stop).toContain(userEntry);              // user's entry kept
    expect(splitgridEntry(root.hooks.Stop)).toBeDefined();        // splitgrid's added alongside
    expect(root.hooks.Stop).toHaveLength(2);
  });

  it('replaces a stale splitgrid entry (old helper path) with the current one', () => {
    const stale: Entry = { hooks: [{ type: 'command', command: '"/old/splitgrid-hook.sh" stop' }] };
    const root: any = { hooks: { Stop: [stale] } };
    applyHooksToConfig(root, CLAUDE, HELPER);
    const list: Entry[] = root.hooks.Stop;
    expect(list).not.toContain(stale);                          // old one dropped
    expect(splitgridEntry(list)!.hooks[0].command).toBe(`"${HELPER}" stop`);
    expect(list).toHaveLength(1);
  });
});

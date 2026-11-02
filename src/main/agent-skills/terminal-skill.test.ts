import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent-hooks/paths', () => ({ terminalSkillResourcePath: () => '' }));
import { BACKGROUND_DESCRIPTION, BACKGROUND_RULE, renderTerminalSkill } from './terminal-skill';

const BUNDLED = readFileSync(path.resolve(__dirname, '../../../resources/skills/sg-terminal/SKILL.md'), 'utf8');
const description = (text: string) => /^description: (.*)$/m.exec(text)?.[1] ?? '';

describe('renderTerminalSkill', () => {
  it('finds both passages it swaps in the bundled skill', () => {
    // An edit to either passage in SKILL.md must be mirrored in terminal-skill.ts,
    // or the "long-running processes in panes" setting silently stops doing anything.
    expect(BUNDLED).toContain(BACKGROUND_DESCRIPTION);
    expect(BUNDLED).toContain(BACKGROUND_RULE);
  });

  it('ships background jobs allowed and SSH in its own pane', () => {
    expect(renderTerminalSkill(BUNDLED, false)).toBe(BUNDLED);
    expect(description(BUNDLED)).toContain('Simple background jobs may stay background Bash jobs.');
    expect(description(BUNDLED)).toContain('never ssh from Bash');
  });

  it('puts every long-running process in a pane with the setting on, keeping SSH and valid frontmatter', () => {
    const out = renderTerminalSkill(BUNDLED, true);
    expect(out).not.toContain('may stay in the background');
    expect(out).toContain('go in a tray pane, not the background');
    expect(out).toContain('SSH always gets its own pane');
    const desc = description(out);
    expect(desc).toContain('instead of a background Bash job');
    expect(desc).toContain('never ssh from Bash');
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).not.toMatch(/: |\s#|[<>]|\b(you|your|I)\b/);
  });
});

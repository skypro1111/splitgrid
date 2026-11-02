import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The bundled sg-* skills are matched by their `description` alone, so a
// frontmatter that doesn't parse costs the skill its trigger. Claude Code's
// parser happens to be lenient, but the Agent Skills spec is plain YAML: a
// `: ` or ` #` inside an unquoted value breaks it. Keep every field a
// single-line plain scalar that any YAML parser reads the same way.

const SKILLS_DIR = path.resolve(__dirname, '../../../resources/skills');
const skills = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function frontmatter(name: string): Record<string, string> {
  const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${name}: SKILL.md must open with a --- frontmatter block on line 1`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z][a-z-]*): (.*)$/.exec(line);
    if (!kv) throw new Error(`${name}: frontmatter line is not a single-line "key: value": ${line}`);
    fields[kv[1]] = kv[2];
  }
  return fields;
}

describe('bundled agent skills', () => {
  it('ships the sg-* set', () => {
    expect(skills.sort()).toEqual(['sg-agent', 'sg-browser', 'sg-history', 'sg-sftp', 'sg-sql', 'sg-terminal']);
  });

  it.each(skills)('%s has spec-valid frontmatter', (name) => {
    const fm = frontmatter(name);
    expect(fm.name).toBe(name);
    expect(fm.name).toMatch(/^[a-z0-9-]{1,64}$/);

    const desc = fm.description ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
    // Plain-scalar hazards: these end the value early or make it a mapping.
    expect(desc).not.toMatch(/: |\s#|^['"&*!|>%@`{[]/);
    // XML-like tags are refused by the spec and shown escaped by Claude Code.
    expect(desc).not.toMatch(/[<>]/);
    // Descriptions are injected into the system prompt: third person only.
    expect(desc).not.toMatch(/\b(you|your|I)\b/);
  });
});

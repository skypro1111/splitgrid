import { describe, expect, it } from 'vitest';
import { listThreads } from './claude-agent-manager';
import { ClaudeAgentSession } from './claude-agent-session';

describe('thread history + models (live)', () => {
  it('lists past Claude threads for a directory — the pane\'s /resume', async () => {
    const threads = await listThreads(process.cwd());
    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThan(0);
    expect(threads[0].sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(typeof threads[0].summary).toBe('string');
    // Newest first, which is the order the picker shows.
    expect(threads[0].lastModified).toBeGreaterThanOrEqual(threads[threads.length - 1].lastModified);
  }, 60_000);

  it('reports the models this account may select', async () => {
    const session = new ClaudeAgentSession({ cwd: process.cwd() }, { emit: () => undefined });
    await session.start();
    const deadline = Date.now() + 30_000;
    let models: { value: string; label: string }[] = [];
    while (Date.now() < deadline && models.length === 0) {
      models = await session.supportedModels();
      if (models.length === 0) await new Promise((r) => setTimeout(r, 200));
    }
    expect(models.length).toBeGreaterThan(1);
    expect(models.some((m) => m.value === 'default')).toBe(true);
    await session.stop();
  }, 90_000);

  it('opens a resumed thread with its conversation already in view', async () => {
    const threads = await listThreads(process.cwd());
    // Pick a thread with real content — the newest may be a bare handshake.
    const candidate = threads.find((t) => t.summary && t.summary !== 'Untitled thread') ?? threads[0];
    expect(candidate).toBeDefined();

    const session = new ClaudeAgentSession(
      { cwd: process.cwd(), resumeSessionId: candidate.sessionId },
      { emit: () => undefined },
    );
    await session.start();

    // Seeded before the CLI says anything: `resume` continues a thread but
    // never replays it, so a resumed pane would otherwise open blank.
    const history = session.replay();
    const conversation = history.filter(
      (e) => e.type === 'user.message' || e.type === 'text.delta',
    );
    expect(conversation.length).toBeGreaterThan(0);
    expect(history.some((e) => e.type === 'user.message')).toBe(true);

    await session.stop();
  }, 90_000);
});

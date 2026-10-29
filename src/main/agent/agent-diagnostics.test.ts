import { afterEach, describe, expect, it } from 'vitest';
import { agentDiag, readAgentDiagnostics, resetAgentDiagnostics } from './agent-diagnostics';

afterEach(() => resetAgentDiagnostics());

describe('agentDiag', () => {
  it('records steps in order with their detail', () => {
    agentDiag('s1', 'start', { cwd: '/w' });
    agentDiag('s1', 'query-created');

    const entries = readAgentDiagnostics('s1');
    expect(entries.map((entry) => entry.step)).toEqual(['start', 'query-created']);
    expect(entries[0].detail).toEqual({ cwd: '/w' });
    expect(entries[0].at).toBeGreaterThan(0);
  });

  it('keeps sessions apart', () => {
    agentDiag('s1', 'a');
    agentDiag('s2', 'b');
    expect(readAgentDiagnostics('s1').map((entry) => entry.step)).toEqual(['a']);
    expect(readAgentDiagnostics('s2').map((entry) => entry.step)).toEqual(['b']);
    expect(readAgentDiagnostics()).toHaveLength(2);
  });

  it('returns the newest entries when tailed', () => {
    for (let index = 0; index < 10; index += 1) agentDiag('s1', `step-${index}`);
    const entries = readAgentDiagnostics('s1', 3);
    expect(entries.map((entry) => entry.step)).toEqual(['step-7', 'step-8', 'step-9']);
  });

  it('never throws without a configured log file', () => {
    expect(() => agentDiag('s1', 'no-sink')).not.toThrow();
  });
});

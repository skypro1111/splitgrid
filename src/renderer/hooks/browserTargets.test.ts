import { describe, it, expect } from 'vitest';
import { decideBrowserTarget, type TargetCandidate } from './browserTargets';

const T = 'term-A';

describe('decideBrowserTarget — explicit --target', () => {
  const list: TargetCandidate[] = [{ id: 'b1', ownerTerminal: 'other' }, { id: 'b2' }];
  it('resolves an existing explicit target (no claim, even if owned by someone else)', () => {
    expect(decideBrowserTarget(list, T, 'b1')).toEqual({ kind: 'resolved', id: 'b1', claim: false });
  });
  it('reports not_found for an explicit target absent from the list', () => {
    expect(decideBrowserTarget(list, T, 'nope')).toEqual({ kind: 'not_found' });
  });
});

describe('decideBrowserTarget — implicit (ownership)', () => {
  it('resolves the single browser the caller owns', () => {
    const list: TargetCandidate[] = [{ id: 'b1', ownerTerminal: T }, { id: 'b2', ownerTerminal: 'other' }];
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'resolved', id: 'b1', claim: false });
  });

  it('is ambiguous when the caller owns more than one', () => {
    const list: TargetCandidate[] = [{ id: 'b1', ownerTerminal: T }, { id: 'b2', ownerTerminal: T }];
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'ambiguous', mine: ['b1', 'b2'] });
  });

  it('claims the sole unowned pane when the caller owns none', () => {
    const list: TargetCandidate[] = [{ id: 'b1' }];
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'resolved', id: 'b1', claim: true });
  });

  it('does NOT claim an unowned pane when several are unowned (ambiguous → none)', () => {
    const list: TargetCandidate[] = [{ id: 'b1' }, { id: 'b2' }];
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'none', all: ['b1', 'b2'] });
  });

  it('returns none (not claim) when the only unowned panes coexist with others owned by someone else', () => {
    const list: TargetCandidate[] = [{ id: 'b1', ownerTerminal: 'other' }, { id: 'b2' }];
    // caller owns 0, exactly one unowned (b2) → claim it
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'resolved', id: 'b2', claim: true });
  });

  it('returns none for an empty workspace', () => {
    expect(decideBrowserTarget([], T)).toEqual({ kind: 'none', all: [] });
  });

  it('prefers an owned pane over claiming an unowned one', () => {
    const list: TargetCandidate[] = [{ id: 'mine', ownerTerminal: T }, { id: 'free' }];
    expect(decideBrowserTarget(list, T)).toEqual({ kind: 'resolved', id: 'mine', claim: false });
  });
});

// ─── Agent browser ownership resolution (pure) ───────────────────────────────
// Decides WHICH existing browser pane a no-/explicit-target command acts on,
// per the ownership rule. Extracted from useBrowserAgentBridge so the subtle
// matrix (own=1, own>1 ambiguous, unowned=1 claim, none) is unit-testable
// without the registry/live webviews. The hook layers presentation (error
// payloads enriched with live url/title) on top of these decisions.

export interface TargetCandidate {
  id: string;
  ownerTerminal?: string;
}

export type TargetDecision =
  | { kind: 'resolved'; id: string; claim: boolean }  // claim = newly took an unowned pane
  | { kind: 'not_found' }                              // explicit --target not present
  | { kind: 'ambiguous'; mine: string[] }              // caller owns >1 — must disambiguate
  | { kind: 'none'; all: string[] };                   // nothing owned/claimable

export function decideBrowserTarget(
  list: TargetCandidate[],
  terminal: string,
  explicitTarget?: string,
): TargetDecision {
  if (explicitTarget) {
    const found = list.find((b) => b.id === explicitTarget);
    return found ? { kind: 'resolved', id: found.id, claim: false } : { kind: 'not_found' };
  }

  const mine = list.filter((b) => b.ownerTerminal === terminal);
  if (mine.length === 1) return { kind: 'resolved', id: mine[0].id, claim: false };
  if (mine.length > 1) return { kind: 'ambiguous', mine: mine.map((b) => b.id) };

  // Nobody owns it yet and there's exactly one — adopt it.
  const unowned = list.filter((b) => !b.ownerTerminal);
  if (unowned.length === 1) return { kind: 'resolved', id: unowned[0].id, claim: true };

  return { kind: 'none', all: list.map((b) => b.id) };
}

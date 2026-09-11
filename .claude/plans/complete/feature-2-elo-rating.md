# Plan: Feature 2 — Elo Rating Calculation Module

## Context

We're building a pure, standalone Elo calculation module. How ratings are stored, tracked over time, and integrated with the rest of the system is a future concern. Feature 2 is done when the module is implemented and all tests pass.

---

## Elo formula

For a 1v1 match between players A and B:

```
E_A = 1 / (1 + 10^((R_B - R_A) / 400))   // expected score for A
E_B = 1 - E_A                              // expected score for B

new_R_A = R_A + K * (S_A - E_A)
new_R_B = R_B + K * (S_B - E_B)
```

Where:
- `R_A`, `R_B` — current ratings
- `S_A`, `S_B` — actual score: 1 for win, 0 for loss, 0.5 for draw
- `K` — sensitivity factor, **32** is the standard starting value

The returned changes are rounded to the nearest integer (`Math.round`). The two players' changes sum to 0 before rounding; after rounding the sum is 0 or ±1. Do not try to force perfect symmetry post-rounding — both outcomes are correct.

---

## New file: `src/lib/elo.ts`

A pure, stateless utility. No side effects, no imports beyond standard TypeScript.

```ts
/** Standard K-factor. Could later be made dynamic (e.g. higher for new players). */
export const K_FACTOR = 32

/** Actual result type. */
export type EloResult = 'A' | 'B' | 'draw'

/** Internal only — not exported. Tests cover it indirectly via calculateElo1v1. */
function expectedScore(ratingA: number, ratingB: number): number

/**
 * Calculate Elo rating changes for a 1v1 match.
 * Returns { changeA, changeB } as integers (Math.round applied).
 *
 * @param kFactor - Optional override; defaults to K_FACTOR.
 *   Accepts a parameter rather than closing over the constant so future
 *   dynamic K (e.g. provisional ratings) doesn't require a breaking signature change.
 *
 * Note: 'draw' is supported by the formula but callers should verify their
 * win/loss display logic handles draws correctly before using it.
 */
export function calculateElo1v1(
  ratingA: number,
  ratingB: number,
  result: EloResult,
  kFactor: number = K_FACTOR
): { changeA: number; changeB: number }
```

---

## Files to create

| Action | File | Notes |
|--------|------|-------|
| Create | `src/lib/elo.ts` | Pure Elo calculation function + `EloResult` type |
| Create | `src/lib/elo.test.ts` | Vitest unit tests |

---

## Tests

Create `src/lib/elo.test.ts`. Add `// @vitest-environment node` at the top — this is a pure maths module; the node environment is faster and avoids jsdom overhead.

Key cases to cover:

- **Equal ratings (1000 vs 1000, A wins):** `changeA` = `+16`, `changeB` = `-16` (K=32, E=0.5)
- **Favourite wins (1800 vs 1000, A wins):** `changeA` is small positive (≈+2), `changeB` is small negative (≈-2)
- **Underdog wins (1000 vs 1800, A wins):** `changeA` is large positive (≈+30), `changeB` is large negative (≈-30)
- **Draw between equal players:** both changes = 0
- **Sum after rounding:** `Math.abs(changeA + changeB) <= 1` for all win/loss cases
- **Custom K-factor:** passing `kFactor: 16` should halve the deltas vs default K=32

Run with: `npx vitest run src/lib/elo.test.ts`

---

## Verification

Run `npx vitest run src/lib/elo.test.ts` — all tests pass.

# Plan: Feature 2 — Proper Elo Rating Calculation

## Context

The current rating system applies a flat +10/-10 delta regardless of the players' relative ratings. This means a top-rated player gains the same amount beating a newcomer as they would beating a peer — which makes the league table less meaningful over time. The fix is to implement the standard Elo formula, where upsets yield larger swings and expected results yield smaller ones. The logic lives inline in `seed.ts` and will need to be centralised so the same function can be reused when game result submission is built (Feature 3).

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

`ratingChange` is rounded to the nearest integer (`Math.round`). The two players' changes sum to 0 before rounding; after rounding the sum is 0 or ±1. Do not try to force perfect symmetry post-rounding — both outcomes are correct.

**Integer storage note:** `ratingChange` and `ratingAfter` are both stored as `Int` in the schema. Always pass `Math.round()` output into Prisma — it will not auto-round floats. `ratingAfter` should be stored as `ratingBefore + ratingChange` (integer arithmetic), not re-derived from the floating-point formula. This accumulates a small rounding error over many games but keeps the audit trail self-consistent.

---

## Team vs team (deferred to Feature 3)

The schema supports `TEAM_VS_TEAM` but the seed only generates `ONE_VS_ONE` games. Rather than ship `calculateEloTeam` in Feature 2 with no exercising code or tests, defer it to Feature 3 when there is an actual call-site. The intended design: use the average rating of each team as the representative rating, calculate the Elo delta as if it were a 1v1, apply that same delta to every player on each side. Known limitation: a high-rated and a low-rated player receive identical deltas — this is accepted for simplicity and should be noted in a code comment when implemented.

---

## New file: `src/lib/elo.ts`

A pure, stateless utility with no Prisma dependency. No side effects, no imports beyond standard TypeScript.

```ts
/** Standard K-factor. Could later be made dynamic (e.g. higher for new players). */
export const K_FACTOR = 32

/** Actual result type — exported so Feature 3 callers don't need to re-declare it. */
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
 */
export function calculateElo1v1(
  ratingA: number,
  ratingB: number,
  result: EloResult,
  kFactor: number = K_FACTOR
): { changeA: number; changeB: number }
```

**Draw support caveat:** `EloResult` includes `'draw'` for completeness. However, the existing `league.tsx` UI infers wins as `ratingChange > 0` and losses as `ratingChange < 0`. A draw where the higher-rated player draws against a lower-rated player produces a negative `ratingChange` for them — the UI will count it as a loss. **Do not pass `'draw'` until the league table win/loss counting is updated.** Flag this as a known limitation in the code comments.

---

## Changes to `seed.ts`

Replace the hardcoded `winnerDelta = 10` / `loserDelta = -10` block with a call to `calculateElo1v1`.

Before:
```ts
const winnerDelta = 10
const loserDelta = -10
```

After:
```ts
import { calculateElo1v1 } from './src/lib/elo'

const { changeA, changeB } = calculateElo1v1(
  userA.currentRating,
  userB.currentRating,
  teamAWins ? 'A' : 'B'
)
// use changeA / changeB in place of winnerDelta / loserDelta
```

**Critical — do not remove the per-iteration `findUnique` calls:** Lines 52–53 of `seed.ts` re-fetch `userA` and `userB` from the DB at the start of each game. This is load-bearing — it ensures `currentRating` reflects the updated value from the previous game. If someone hoists these lookups outside the inner loop as a refactor, every game after round 1 silently uses stale ratings. Leave the re-fetch in place.

---

## How Feature 3 will use this

Feature 3 (game submission) will call `calculateElo1v1` roughly like:

```ts
import { calculateElo1v1, type EloResult } from '@/lib/elo'

const { changeA, changeB } = calculateElo1v1(userA.currentRating, userB.currentRating, result)

await prisma.$transaction([
  prisma.gameResult.create({ ... }),
  prisma.gameParticipant.createMany({
    data: [
      { userId: userA.id, ratingBefore: userA.currentRating, ratingChange: changeA, ratingAfter: userA.currentRating + changeA, ... },
      { userId: userB.id, ratingBefore: userB.currentRating, ratingChange: changeB, ratingAfter: userB.currentRating + changeB, ... },
    ]
  }),
  prisma.user.update({ where: { id: userA.id }, data: { currentRating: userA.currentRating + changeA } }),
  prisma.user.update({ where: { id: userB.id }, data: { currentRating: userB.currentRating + changeB } }),
])
```

The function returns changes, not new ratings. Callers are responsible for computing `ratingAfter` and updating `User.currentRating`.

---

## Files to create / modify

| Action | File | Change |
|--------|------|--------|
| Create | `src/lib/elo.ts` | Pure Elo calculation function + `EloResult` type |
| Create | `src/lib/elo.test.ts` | Vitest unit tests |
| Modify | `seed.ts` | Use `calculateElo1v1` instead of hardcoded deltas |

No schema or migration changes required.

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

1. Run `npx vitest run src/lib/elo.test.ts` — all tests pass
2. Run `npm run db:reset` to wipe and re-seed with the new logic

   > **Note:** The seed uses `Math.random()` for winners, so each `db:reset` produces different rating values. Use the worked example below for a deterministic correctness check.

3. **Worked example — verify one row manually in Prisma Studio:**
   - Player A rating: 1500, Player B rating: 1200, A wins
   - `E_A = 1 / (1 + 10^(-300/400)) ≈ 0.849`
   - `changeA = round(32 × (1 − 0.849)) = round(4.83) = 5`
   - `changeB = round(32 × (0 − 0.151)) = round(−4.83) = −5`
   - Find a `GameParticipant` row in Prisma Studio where `ratingBefore` ≈ 1500 wins against `ratingBefore` ≈ 1200; confirm `ratingChange = 5`

4. Visit `/league` — rankings render correctly with the new rating values

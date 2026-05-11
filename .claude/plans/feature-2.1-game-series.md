# Feature 2.1 — Process Game Series

## Context

Feature 2 delivered `calculateElo1v1`, a pure function for computing Elo changes from a single match. Feature 2.1 extends this by adding a stateful series processor: given an ordered list of game results and a starting ratings map, it calls `calculateElo1v1` for each game in sequence (carrying forward updated ratings), and returns a full audit trail of every rating change alongside a final ratings snapshot.

Primary use cases:
- Re-seeding the database after a fresh wipe or schema migration (replace `seed.ts` ad-hoc logic)
- Importing an ordered game history from an offline tournament or external system
- Backing a future server function that batch-records games to the DB with zero Elo logic in the route layer

---

## Scope

**In scope:** Pure lib function + tests. No DB writes, no server function, no route changes.

**Out of scope (future feature):** A `createServerFn` that takes series input, resolves DB user IDs, calls `processGameSeries`, and writes `GameResult` + `GameParticipant` records + updates `User.currentRating`. The audit trail output is designed to make this trivially easy when the time comes.

---

## New Files

| File | Purpose |
|---|---|
| `src/lib/game-series.ts` | New lib function and types |
| `src/lib/game-series.test.ts` | Full test coverage (mandatory per CLAUDE.md) |

No existing files need modification. `src/lib/elo.ts` already exports everything needed (`calculateElo1v1`, `EloResult`, `K_FACTOR`).

**Why a new file rather than extending `elo.ts`?** `elo.ts` is a stateless math module; `game-series.ts` is a domain-aware orchestrator that imports from it. They have different reasons to change, and separate test files stay 1:1 with source files.

---

## Types

```typescript
// src/lib/game-series.ts

import { type EloResult, calculateElo1v1, K_FACTOR } from './elo'

export const DEFAULT_RATING = 1000

export interface GameSeriesInput {
  playerA: string      // any stable identifier (DB user ID, username, etc.)
  playerB: string
  result: EloResult    // 'A' = playerA won, 'B' = playerB won, 'draw'
  kFactor?: number     // per-game override; falls back to K_FACTOR (32)
}

export interface ProcessSeriesOptions {
  defaultRating?: number  // rating for players absent from startingRatings; default 1000
}

export interface GameAuditEntry {
  index: number            // 0-based position in input array
  playerA: string
  playerB: string
  result: EloResult
  ratingBeforeA: number
  ratingBeforeB: number
  changeA: number
  changeB: number
  ratingAfterA: number
  ratingAfterB: number
}

export interface GameSeriesResult {
  auditTrail: GameAuditEntry[]
  finalRatings: Record<string, number>
}
```

`GameAuditEntry` mirrors the `GameParticipant` model fields exactly (`ratingBefore`, `ratingAfter`, `ratingChange`) so a future server function can write DB records by direct field mapping — no arithmetic at the call site.

---

## Function Signature

```typescript
export function processGameSeries(
  startingRatings: Record<string, number>,
  games: GameSeriesInput[],
  options?: ProcessSeriesOptions,
): GameSeriesResult
```

---

## Algorithm

1. **Copy** `startingRatings` into a mutable `Map<string, number>` (`workingRatings`). Never mutate the caller's object.
2. **Resolve ratings** via an internal `getRating(id)` helper that reads from `workingRatings`, falling back to `options?.defaultRating ?? DEFAULT_RATING` for unknown players.
3. **Iterate** games in order. For each game at index `i`:
   a. Guard: throw `Error` if `playerA === playerB`.
   b. Read `ratingBeforeA = getRating(playerA)`, `ratingBeforeB = getRating(playerB)`.
   c. Call `calculateElo1v1(ratingBeforeA, ratingBeforeB, result, kFactor ?? K_FACTOR)` → `{ changeA, changeB }`.
   d. Compute `ratingAfterA = ratingBeforeA + changeA`, `ratingAfterB = ratingBeforeB + changeB`.
   e. Write updated values back into `workingRatings`.
   f. Push a `GameAuditEntry` onto the accumulator.
4. **Return** `{ auditTrail, finalRatings: Object.fromEntries(workingRatings) }`.

`finalRatings` contains every player who appeared in the series plus any players from `startingRatings` who sat out all games (ratings unchanged but still present in the output).

---

## Edge Cases

| Case | Behaviour |
|---|---|
| Player absent from `startingRatings` | Defaults to `defaultRating` on first encounter; carries forward from there |
| Same player in multiple games | Updated rating from game N used as `ratingBefore` in game N+1 |
| Empty `games` array | Returns `{ auditTrail: [], finalRatings: { ...startingRatings } }` |
| `playerA === playerB` | Throws `Error('playerA and playerB must be different')` |
| Custom `kFactor` per game | Passed through to `calculateElo1v1`; absent = module default (32) |
| Players in `startingRatings` who play no games | Present in `finalRatings` with original rating |

---

## Tests (`src/lib/game-series.test.ts`)

### Happy path
1. Single game, A wins — validate all eight fields of the single audit entry
2. Single game, B wins — symmetric to case 1
3. Single game, draw — both changes are 0 for equal-rated players
4. Two sequential games, same pair — `ratingBeforeA` of game 2 equals `ratingAfterA` of game 1
5. Three games, three pairs sharing one player — verify shared player's rating chains correctly across both of their games
6. `finalRatings` contains all players, including those who only appeared once

### Default rating behaviour
7. Unknown player defaults to 1000 — `ratingBeforeB` is 1000 when `playerB` absent from `startingRatings`
8. Custom `defaultRating` option — unknown player gets the custom value, not 1000
9. Both players unknown — both start at `defaultRating`

### Edge cases
10. Empty `games` array — returns `auditTrail: []` and `finalRatings` matching `startingRatings`
11. Players in `startingRatings` who play no games — present in `finalRatings` unchanged
12. Per-game `kFactor` — result matches `calculateElo1v1` called with that `kFactor` directly
13. `playerA === playerB` — throws with a descriptive error message
14. Input `startingRatings` not mutated — verify the original object's values after the call

### Invariants
15. `index` field matches 0-based position for a 3-game series
16. `ratingAfter = ratingBefore + change` holds for both players across every entry in the audit trail

---

## Future Server Function Sketch (out of scope here, for reference)

A future `recordGameSeries` server function would:
1. Accept a list of `{ playerAId, playerBId, result }` (DB user IDs)
2. Look up `currentRating` for each unique user ID from Prisma
3. Call `processGameSeries(startingRatings, games)`
4. Write one `GameResult` + two `GameParticipant` records per audit entry (using the pre-computed `ratingBefore/After/Change` values directly)
5. Update `User.currentRating` for each player using `finalRatings`

No Elo logic lives in the server function — it's pure persistence.

---

## Verification

```bash
npx vitest run src/lib/game-series.test.ts   # run new tests in isolation
npm run test                                  # full suite — confirm nothing regressed
npm run check                                 # Biome lint + format
```

No build step needed — this is a pure lib addition with no route changes.

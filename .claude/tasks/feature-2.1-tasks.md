# Feature 2.1 — Process Game Series: Task List

Plan: `.claude/plans/feature-2.1-game-series.md`
Branch: `game-series-agent-f21`
Worktree: `.claude/worktrees/game-series-f21`

---

## Dependency graph

```
Task 1 (implement game-series.ts)
    └── Task 2 (write game-series.test.ts)
            └── Task 3 (verify: tests + lint)
```

Tasks 1 and 2 are **sequential** — the test file imports from the implementation, and
the test agent should read the real implementation to ensure types align exactly.
Task 3 is blocked on both.

---

## Task 1 — Implement `src/lib/game-series.ts`

**Status:** pending
**Depends on:** nothing
**Blocks:** Task 2, Task 3

Write the implementation file from scratch. Deliverables:

- All exported types: `GameSeriesInput`, `ProcessSeriesOptions`, `GameAuditEntry`, `GameSeriesResult`
- Exported constant: `DEFAULT_RATING = 1000`
- Exported function: `processGameSeries(startingRatings, games, options?)`

Key implementation notes (see plan for full detail):
- Copy `startingRatings` into a `Map` — never mutate caller's object
- Internal `getRating` helper with `defaultRating` fallback
- Iterate games, carrying forward updated ratings between each game
- Guard: throw `Error('playerA and playerB must be different')` when `playerA === playerB`
- Per-game `kFactor` override falls back to imported `K_FACTOR` (32) from `./elo`
- Return `{ auditTrail: GameAuditEntry[], finalRatings: Record<string, number> }`
- `GameAuditEntry.index` is 0-based position in the input array
- `ratingAfter = ratingBefore + change` (both players, every game)

---

## Task 2 — Write `src/lib/game-series.test.ts`

**Status:** pending
**Depends on:** Task 1
**Blocks:** Task 3

Write the full test suite (16 tests). Read the implementation file first to ensure
types and behaviour are reflected accurately.

Test groups:

**Happy path (tests 1–6)**
1. Single game, A wins — validate all 9 fields of the audit entry
2. Single game, B wins — symmetric
3. Single game, draw — changes are 0 for equal-rated players
4. Two sequential games, same pair — `ratingBeforeA` of game 2 equals `ratingAfterA` of game 1
5. Three games, three pairs sharing one player — shared player's rating chains correctly
6. `finalRatings` contains all players including those who appeared only once

**Default rating (tests 7–9)**
7. Unknown player defaults to 1000
8. Custom `defaultRating` option applies to unknown players
9. Both players unknown — both start at `defaultRating`

**Edge cases (tests 10–14)**
10. Empty `games` array — `auditTrail: []`, `finalRatings` matches `startingRatings`
11. Players in `startingRatings` who play no games — still present in `finalRatings`
12. Per-game `kFactor` — result matches direct `calculateElo1v1` call with same kFactor
13. `playerA === playerB` — throws with descriptive message
14. Input `startingRatings` not mutated after the call

**Invariants (tests 15–16)**
15. `index` field matches 0-based position for a 3-game series
16. `ratingAfter = ratingBefore + change` holds for both players across all audit entries

---

## Task 3 — Verify

**Status:** pending
**Depends on:** Tasks 1 and 2
**Blocks:** nothing

Run in the worktree:

```bash
npx vitest run src/lib/game-series.test.ts   # new tests pass
npm run test                                  # full suite — no regressions
npm run check                                 # Biome lint + format clean
```

All three must pass before the branch is ready for PR review.

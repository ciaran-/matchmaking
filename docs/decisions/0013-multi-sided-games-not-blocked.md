# 0013. Games are 1v1 today; nothing may block teams or more than two sides

- **Status:** Accepted
- **Date:** 2026-09-11 (replacing the 1v1-only stance of 2026-05-14)
- **Source:** `.claude/plans/complete/feature-3-record-game-result.md`,
  `.claude/plans/complete/feature-4-matchmaking.md`,
  `.claude/plans/complete/feature-8-match-history.md`; product direction
  stated 2026-09-11
- **Supersedes:** feature 4's locked decision #8 ("Forward-compat for
  teams: none. Team support is a future refactor.")

## Context

Every feature so far is 1v1, and feature 4 locked in "no forward
compatibility for teams; refactor later". The product will add:

- **team games** (N v N),
- **free-for-all** games between three or more players, and
- **multi-team** games (team v team v team).

"Refactor later" is cheap for code. It is expensive for anything durable —
database schema, stored history, a published API contract — which is
exactly what makes a later refactor hard.

## Decision

- **Build 1v1 now.** Team and multi-sided features are not built
  speculatively (0012).
- **Do not foreclose the other shapes.** Durable things — database schema,
  stored data, the published API, and shared `src/lib/` function
  signatures — must not newly assume exactly two sides or exactly one
  player per side.
  - If a 1v1 assumption is simplest right now, keep it somewhere cheap to
    change (a UI component, an adapter, a validation rule) and say so.
- **Check new designs against all three future shapes.** If a design could
  only support them through a data migration or a `v2` API, its plan must
  call that trade-off out explicitly.
- **An outcome is not always win/loss/draw.** With three or more sides,
  results are placements. Do not bake a two-way outcome into new durable
  shapes.

## Consequences

Existing designs already assume two sides. Each will need work when
multi-sided games arrive, and none should be extended further:

| Where | Assumes | Affects |
| --- | --- | --- |
| `GameResult.teamAScore` / `teamBScore`, `Team` enum (`A`, `B`) | Exactly two sides | Games with 3+ sides need a schema migration (a score or placement per side) |
| `GameMode` (`ONE_VS_ONE`, `TEAM_VS_TEAM`) | No mode for 3+ sides | Free-for-all and multi-team games |
| `PendingGameEvent` `playerA*` / `playerB*` / `searchA*` / `searchB*` columns | A match is two players | All team and multi-player matchmaking |
| Matcher (`findMatchFor`, `proposePendingGame`) | Pairs two searches | Forming groups or teams |
| `calculateElo1v1`, `processGameSeries` (0008) | A pairwise, two-player rating | Teams and free-for-all need a different rating method |
| `game-outcome.ts` (0009) | Win/loss/draw from two team scores | Works for N v N teams; 3+ sides need placements |
| `authorization.ts` `GameSides { playerAId, playerBId }` (0006) | Two participants | Team participation |
| REST `POST /games`, `POST /matches/{id}/result` (`result: "A" \| "B" \| "draw"`) | Two sides, in the published `v1` contract | Multi-sided recording needs a new, additive shape or `v2` |
| Match history | A single opponent; `TEAM_VS_TEAM` filtered out | Team and free-for-all history |

- The next new durable shape is the offline importer's payload (feature 12).
  It should be designed to carry more than two sides even if it accepts
  only 1v1 at first.
- Where it costs little, prefer shapes that already generalise — for
  example a list of participants with a side and a result each, rather than
  `A` / `B` columns.

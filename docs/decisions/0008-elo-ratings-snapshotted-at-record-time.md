# 0008. Elo is applied at record time and snapshotted per game

- **Status:** Accepted
- **Date:** 2026-05-13
- **Source:** `.claude/plans/complete/feature-2-elo-rating.md`,
  `.claude/plans/complete/feature-3-record-game-result.md`,
  `.claude/plans/complete/feature-2.1-game-series.md`

## Context

Players need a rating that moves with results, and the app needs a rating
history for profiles and charts.

## Decision

- **Standard Elo.** K = 32 (`K_FACTOR`, overridable per call). Changes are
  rounded to whole numbers, so the two players' changes may sum to ±1. New
  players start at 1000. The calculation is pure, in `src/lib/elo.ts`.
- **Ratings are applied when a game is recorded**, using each player's
  `User.currentRating` at that moment. The rating snapshots on matchmaking
  events are for display only.
- **Each game snapshots its effect.** Every `GameParticipant` stores
  `ratingBefore`, `ratingAfter` and `ratingChange`, and `User.currentRating`
  holds the running value. History is never recomputed.

## Consequences

- Rating history and charts read straight from the snapshots.
- **Elo depends on order.** Recording or importing games out of order gives
  a different ladder, with no error to notice. Any bulk import must apply
  games in the order they were played (feature 12).
- Editing or deleting a past game would need every later rating recomputed.
  That is not supported.
- **Known gap:** `recordGame` reads both ratings before its write
  transaction, then writes absolute values. If two games involving the same
  player are recorded concurrently, one rating change is lost, and both
  participations show the same `ratingBefore`. Matchmaking's
  one-active-search-per-user rule narrows this, but ad-hoc and admin
  recording bypass it. Not yet fixed.
- `processGameSeries` (`src/lib/game-series.ts`) computes an ordered series
  in memory, but nothing in production calls it yet.
- The calculation is pairwise and two-player (`calculateElo1v1`). Team and
  multi-sided games will need a different rating method. The
  per-participant snapshot columns do not assume two sides, so they carry
  over (0013).

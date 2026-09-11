# Rating Progression Chart — Feature Plan

A line chart of a player's rating over time, rendered on their profile
(feature 7). Turns the per-game `ratingAfter` snapshots already stored into a
visible progression curve.

High-level plan; per-section detail and the task breakdown come later.

## Context

- The data is already a timeseries: each `GameParticipant` row carries
  `ratingAfter`, and its `GameResult.createdAt` gives the timestamp. Ordering
  a player's participations by game time yields the rating curve directly. No
  schema change expected.
- A charting precedent exists in feature 5 (`LeagueActivity` rating-
  distribution chart) — reuse the same approach/library rather than
  introducing a new dependency.
- Shared-core contract: query in `src/lib/`, thin server-fn wrapper, REST
  reuse (feature 6).

## Goal

On the profile page, a line chart of rating (y) over time / games-played (x),
from the player's first game to now, with the starting rating
(`DEFAULT_RATING`, 1000) as the origin point.

Backed by `getPlayerRatingHistory(identifier)` (+ tests) returning an ordered
series of `{ rating, at, gameResultId }` points, and a thin server-fn
wrapper.

## Non-goals

- No date-range / zoom controls in v1.
- No comparison overlays (vs. another player, vs. league average).
- No downsampling/bucketing yet — fine for the game counts a single player
  will have early on. Revisit only if a player accrues enough games to make
  the series heavy (consistent with "improve scaling as features mature").
- No annotations (win/loss markers on points) in v1 — note as a nice-to-have
  follow-up that pairs well with feature 8.

## Backend (`src/lib/`)

- `getPlayerRatingHistory(identifier)` → ordered points from the player's
  `GameParticipant` rows joined to `GameResult.createdAt`, ascending. Same
  per-user-ordered-by-game-time access path as feature 8 — coordinate the two
  so they share index assumptions.
- Decide whether the series is x-by-time (real timestamps, uneven spacing) or
  x-by-game-index (even spacing). Leaning game-index for early UX; keep the
  timestamp on each point regardless so the axis can change later.

## UI

- A chart section on the profile (feature 7), matching the feature-5 chart's
  styling and library. Sensible empty/short-series states (0 games → just the
  starting point; 1 game → two points).

## Dependencies & sequencing

- Depends on **feature 7** (mounts on the profile). Shares a backend access
  pattern with **feature 8** — worth building after or alongside it to reuse
  the query shape. Independent of feature 10.

## Open questions

- x-axis: time vs. game-index (above).
- Charting library: confirm feature 5's choice covers a line/timeseries
  chart; reuse it.

# Match History — Feature Plan

A per-player, reverse-chronological log of completed games: opponent, result,
rating change, and when it happened. Renders on the player profile (feature
7); the underlying data already exists.

High-level plan; per-section detail and the task breakdown come later.

## Context

- Every completed game already records what this needs: `GameResult`
  (`mode`, `teamAScore`, `teamBScore`, `createdAt`) and `GameParticipant`
  (`team`, `ratingBefore`, `ratingAfter`, `ratingChange`). No schema change
  expected.
- Shows real identities (opponent usernames) — consistent with the existing
  public ranking, distinct from feature 5's anonymised live view.
- Shared-core contract: query lives in `src/lib/`, server fn wraps it, REST
  API (feature 6) reuses it.

## Goal

A paginated list, newest first, where each row shows:

- opponent username (link to their profile — feature 7),
- result from *this* player's perspective (win / loss / draw),
- rating change (`ratingChange`, signed) and resulting rating
  (`ratingAfter`),
- timestamp,
- mode (`ONE_VS_ONE` / `TEAM_VS_TEAM`).

Backed by `getPlayerMatchHistory(identifier, { cursor/limit })` (+ tests)
and a thin server-fn wrapper. Rendered as a section on the profile page.

## Non-goals

- No per-game detail/expanded view (per-round stats, etc.) — the schema has
  commented-out slots for kills/score but they're unused; out of scope.
- No filtering by opponent/mode/date in v1 (note as a follow-up).
- No global "recent games across the league" feed — this is *per player*.
  (A global feed is a separate idea; flag, don't build.)
- No dispute/correction actions (that's competitive-integrity work, item 6
  from the roadmap, not this).

## Backend (`src/lib/`)

- `getPlayerMatchHistory(identifier, opts)` → page of rows joined across
  `GameParticipant` + `GameResult`, resolving the *opponent* participant per
  game. Pagination via cursor on `GameResult.createdAt` (stable, index-
  friendly — `@@index([mode, createdAt])` exists; confirm an access path for
  per-user history ordering).
- Result-from-perspective + opponent resolution assume **two participants**
  (1v1). Define behaviour for `TEAM_VS_TEAM` now (collapse the other team? list
  teammates?) or explicitly scope v1 to 1v1 and guard. Team matchmaking
  itself isn't built yet, so 1v1-only is a defensible v1.

## UI

- A list/table section mounted on the profile (feature 7), matching its
  visual language. Win/loss/draw and signed rating delta visually distinct
  (green/red). "Load more" or paged navigation.
- Empty state for players with no games.

## Dependencies & sequencing

- Depends on **feature 7** (needs the profile page to mount on, and the
  per-player identifier convention). Independent of features 9 and 10.

## Open questions

- `TEAM_VS_TEAM` handling vs. 1v1-only v1 (above).
- Page size and pagination style (cursor "load more" vs. numbered pages).
- Index check: is `GameParticipant(userId)` + `GameResult.createdAt`
  ordering efficient, or is a composite index warranted? Measure before
  adding.


## Measured scaling finding (2026-09-10, not acted on)

`EXPLAIN ANALYZE` against a seeded database — 500 users, ~15,300 `ONE_VS_ONE`
games, and one player whose 300 games were all inserted *before* 15,000 games
of later league traffic — showed Postgres scanning ~15,021 rows (~24ms) to
return a page of 20.

It drives the query from `GameResult_mode_createdAt_idx` backwards and
nested-loop-probes `GameParticipant`, rather than starting from the selective
`GameParticipant(userId)` index. Rephrasing the query to lead from
`GameParticipant` produced an **identical** physical plan, so this is not
fixable by rewriting it.

**The cost therefore scales with total league volume since that player's most
recent game, not with their own history size.** A dormant or new player is the
worst case, and it gets worse as the league grows — the opposite of the
intuition that light users are cheap.

Fine at current volume. The candidate fix is denormalising `createdAt` onto
`GameParticipant` and indexing `[userId, createdAt]` to give a genuine
per-user access path. Deliberately not done: it is a migration plus a write-path
change, and it should be validated against real traffic rather than a
synthetic worst case.

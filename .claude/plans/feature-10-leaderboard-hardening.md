# Leaderboard Hardening — Feature Plan

Turn the existing `/league` ranking *prototype* into a real leaderboard:
server-side aggregation, pagination, a "where am I" highlight, links into
player profiles, and username search. This is **hardening of an existing
surface**, not a greenfield build.

High-level plan; per-section detail and the task breakdown come later.

## Context

- `/league` already renders a ranking table (`getLeaguePlaces` in
  `src/routes/league.tsx`): rank, username, wins, losses, games, rating,
  ordered by `currentRating` desc.
- Its current implementation has clear problems to fix:
  - **Unbounded fetch**: `prisma.user.findMany({ include: { gameParticipations: true } })` pulls *every* user with *every* participation row, then
    computes W/L/games **client-side** by filtering `ratingChange`. This does
    not survive growth — exactly the kind of thing to firm up as the product
    matures.
  - **No pagination** — one giant table.
  - **No profile links** — usernames are plain text (feature 7 gives them a
    destination).
  - **No current-user highlight** — a player can't find themselves.
  - **No search.**
  - Leftover starter cosmetics (TanStack logo, "RANKINGS" heading on a
    `/league` route).
- Shared-core contract: aggregation query moves into `src/lib/`, server fn
  wraps it, REST API (feature 6) reuses it.

## Goal

A leaderboard that:

- computes W/L/draw/games/rating **in the query** (aggregate, not by
  shipping participation arrays to the client),
- paginates (top-N + page/▾ through the field),
- **highlights the signed-in user's row** and offers a "jump to my rank",
- links each player to their **profile** (feature 7),
- supports **search by username**.

Backed by a `getLeaderboard({ page/cursor, search })` lib fn (+ tests)
replacing the inline `getLeaguePlaces` loader.

## Non-goals

- No seasons / time-windowed leaderboards (all-time only). Seasons are
  competitive-integrity roadmap work, not this.
- No filters by mode/region/etc.
- No leaderboard caching/materialised view yet — fix the query first
  (aggregate in SQL); only consider a read model if measurement shows the
  aggregate is the bottleneck (per "don't cache before measuring").
- Not redesigning the page's whole visual identity — fix the leftover
  starter cosmetics, but a full restyle is separate.

## Backend (`src/lib/`)

- `getLeaderboard(opts)` → ranked page with per-player aggregates computed in
  the query (`GROUP BY` over `GameParticipant`, or a precomputed count), plus
  rank. **Reuse the canonical W/L/draw definition from feature 7** so the
  profile and leaderboard never disagree.
- "My rank" needs a rank-of-one-user query (count of higher ratings) — share
  with feature 7's rank computation.

## UI

- Refit the existing `/league` table: pagination controls, current-user
  highlight, profile links on usernames, a search box. Remove starter
  cosmetics. Keep the `RecordGameModal` flow that already lives here (or note
  if it should move).

## Dependencies & sequencing

- **Independent** of features 8 and 9. Best built **after feature 7** so
  usernames can link to real profiles and the W/L/draw + rank definitions can
  be shared — but could ship before 7 with links stubbed.

## Open questions

- Pagination style (cursor vs. numbered) and page size.
- Whether aggregates are computed live (`GROUP BY` per request) or via a
  cheap denormalised counter on `User` — start with live, measure, decide.
- Does `RecordGameModal` belong on the leaderboard long-term, or move to a
  more natural home? (Out of scope to move, but worth noting.)

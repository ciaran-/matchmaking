# Player Profile Page — Feature Plan

A per-player page showing who a player is and how they're doing: identity,
current rating, league rank, and headline win/loss record. This is the
**anchor surface** for the player-facing work — match history (feature 8)
and the rating chart (feature 9) render *on* this page, and the leaderboard
(feature 10) links *into* it.

High-level plan; per-section detail and the task breakdown come later.

## Context

- A basic public ranking already exists at `/league` (`getLeaguePlaces` →
  username, rating, W/L/games). It shows identities publicly, so a profile
  page exposing the same facts per-player is consistent, not a new privacy
  posture. This is distinct from feature 5's *anonymised live activity* view.
- Data already present: `User` (`username`, `currentRating`, `createdAt`),
  `GameParticipant` (`ratingBefore/After/Change`, `team`), `GameResult`.
- Shared-core contract (CLAUDE.md): a `src/lib/` function holds the query;
  the route's server fn is a thin wrapper; the future REST API (feature 6)
  reuses the same lib fn.

## Goal

A route — e.g. `/player/$username` (exact param shape TBD; see open
questions) — that renders for any signed-in user:

- **Identity**: username, member-since.
- **Headline stats**: current rating, league rank, wins / losses / draws /
  total games.
- Placeholders / slots where **match history** (feature 8) and the **rating
  chart** (feature 9) will mount.

Backed by a single `getPlayerProfile(identifier)` lib fn (+ unit/integration
tests) and a thin server-fn wrapper.

## Non-goals

- No match history list (feature 8) or rating chart (feature 9) — just the
  mount points.
- No profile editing (avatar, display name, bio). Read-only.
- No "is this me?" ownership actions yet (settings, key management). Auth
  only gates *viewing*.
- No follower/social features.
- Not solving leaderboard rank at scale — `rank` here is computed simply
  (count of users with a higher rating); revisit if it shows up as a
  bottleneck (consistent with the "improve scaling as features mature"
  stance).

## Backend (`src/lib/`)

- `getPlayerProfile(identifier)` → identity + headline stats + rank.
  Aggregates W/L/draw/total from the player's `GameParticipant` rows
  **in the query**, not by hauling all rows to the client (the mistake the
  current `/league` table makes — see feature 10).
- Decide W/L/draw semantics centrally so leaderboard (feature 10) and
  profile agree (a draw is `ratingChange === 0`? or derived from team
  scores? — pin this down once, reuse everywhere).

## UI

- New route + component. Reuse the existing visual language (`/league`
  gradients, `storybook/` primitives).
- Graceful "player not found" state.

## Dependencies & sequencing

- **First** of the four player-facing features — 8 and 9 mount here, 10
  links here. No dependency on the REST API (feature 6).

## Open questions

- Route param: `username` (readable, but renames break links) vs. opaque
  `id` (stable, ugly) vs. both. Leaning `username` for shareability.
- Whether profiles are visible to *signed-out* users (public ranking
  already is, behind the sign-in gate) — confirm the gate policy.
- Canonical W/L/draw definition (above) — shared with feature 10.

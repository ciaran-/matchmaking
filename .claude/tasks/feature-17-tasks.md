# Feature 17 — Durable Schema v2: Task List

Plan: `.claude/plans/feature-17-durable-schema-v2.md` — read in full before
starting, including its twelve decisions and the **Production exposure**
section. Draft decision record:
`docs/decisions/0015-draft-league-scoped-ratings-and-sides.md`.

Roadmap item R5 (R5a + R5b + R5c folded), feature 17.

---

## Dependency graph

```
T1 (schema + migration)
 └─> T2 (test infrastructure)
      └─> T3 (ratings per league)
           └─> T4 (sides and placements)
                └─> T5 (matchmaking league scoping)
                     └─> T6 (API)
                          └─> T7 (web routes)
                               └─> T8 (close-out)
```

**This feature is a chain, not a fan-out.** It is worth saying plainly,
because its size invites parallel agents and they would collide: T3, T4 and
T5 all touch `src/lib/record-game.ts`, and T5's `pending-game.ts` calls
`recordGame` with the signature T4 changes. Drive the chain directly.

The one genuinely separable piece is T8's documentation work, which can be
drafted while T6 and T7 are in flight.

---

## Pre-flight (do once)

1. Read the plan and the draft 0015.
2. Read `CLAUDE.md` — **Pre-commit Checklist**, **Testing**, **Code Style**,
   and the client-bundle verification under **`createServerFn` Pattern**.
3. Confirm `npm run check`, `npm test`, `npm run test:integration` and
   `npm run build` pass on `main`.
4. Branch: `feature-17-durable-schema-v2-agent-<short-id>`.
5. **This work carries a migration, including destructive drops.** It
   applies to the production database when this branch's first deploy
   preview builds, before review — the standing call-out from 17 Sep 2026,
   declined again on 13 Oct. Test the migration locally before pushing, and
   expect production's schema to move at that first preview.
6. Migrations run through the Prisma MCP server (`migrate-dev`), per
   `CLAUDE.md`.

---

## T1 — Schema and migration

**Status:** not started
**Depends on:** nothing
**Blocks:** everything

The plan's **Schema** and **Migration** sections are the specification; do
not re-derive the shapes here.

### Read first

- `schema.prisma` in full — note it sits at the repo root, not in
  `prisma/`.
- `prisma/migrations/` for the house style of hand-written SQL.
- The plan's seven migration steps.

### Change

- Add `Game`, `Ruleset`, `League`, `LeagueMembership`, `LeagueRating`, and
  the `GameSource` and `MembershipStatus` enums.
- Add `GameSide`; move `GameResult` to `@@id([id, leagueId])` and
  `GameParticipant` to `@@id([gameResultId, leagueId, userId])`.
- Add `leagueId` to both matchmaking event logs, and into their indexes.
- Seed the `Game`, `Ruleset` and `matchmaking-internal-seed-league`;
  enrol every existing user; copy `currentRating` into `LeagueRating`;
  stamp `leagueId` everywhere; convert each result into two `GameSide`
  rows mapping `Team.A` → ordinal 0 and `Team.B` → 1.
- Drop `User.currentRating`, `teamAScore`, `teamBScore`, `Team`,
  `GameMode`.
- Update `prisma/seed.ts` (or wherever `db:seed` points) to produce the
  new shape — the hand-written seed is still what local and preview run on.

### Verify

- The migration runs from **empty** and against a **copy of current local
  data**. Both, before pushing.
- `npm run db:generate`, then `npm run build` — a stale Prisma client is
  the failure mode CLAUDE.md's Netlify checklist warns about.
- The repo will not typecheck until T3–T7 land. That is expected: commit
  T1 with the schema and migration only, and do not chase type errors in
  call sites yet.

### If step 5 fights

The score-to-placement backfill is the only non-mechanical step. If it
complicates the migration, reset the data instead (decision 10) and keep
the mapping in `src/lib/` where R6's importer and R7's replay will use it.
Do not spend a day on a backfill for data we have agreed is disposable.

---

## T2 — Test infrastructure

**Status:** not started
**Depends on:** T1
**Blocks:** T3–T7's tests

Every integration test now needs a league. Doing this before the lib work
means the rest of the chain has somewhere to write its tests.

### Read first

- `src/test/db.ts`, `src/test/factories/user.ts`,
  `src/test/factories/game-result.ts`, `src/test/scenarios.ts`.

### Change

- A `createLeague(prisma, overrides?)` factory, seeding its `Game` and
  `Ruleset`.
- `createUser` gains an optional league: membership plus a `LeagueRating`
  row when a rating is given, and **no rating row when it is not** — the
  unrated-member case is the one most likely to be got wrong downstream.
- `createGameResult` takes a league and `sides[]`, defaulting to two sides
  so existing call sites stay short.
- `scenarios.ts`: `twoEqualRatedPlayers` and friends take a league.

### Verify

- `npm run test:integration` passes with the factories updated and the
  suites themselves otherwise untouched, where that is possible. Where a
  test must change, it is because it asserted on a dropped column.

---

## T3 — Ratings per league

**Status:** not started
**Depends on:** T2

`User.currentRating` is gone; `LeagueRating` replaces it.

### Read first

- `src/lib/leaderboard.ts`, `src/lib/player-profile.ts`,
  `src/lib/player-rating-history.ts`, `src/lib/record-game.ts`,
  `src/lib/sync-user.ts`.

### Change

- Reads move to `LeagueRating`, keyed `(leagueId, userId)`, using the
  `@@index([leagueId, currentRating])` for the leaderboard.
- `recordGame` writes `LeagueRating` inside its existing transaction, and
  takes the league. The `SELECT … FOR UPDATE` lock from feature 14 moves
  to the rating rows — **do not lose it**; it is what makes concurrent
  games on the same player safe.
- `sync-user.ts` stops setting a starting rating. A new user gets a
  membership when they join a league and a rating when they first play
  (0015: having a rating means having played).
- `player-profile.ts` returns a rating per league rather than one number.

### Verify

- Unit tests per `src/lib/` function, per CLAUDE.md.
- An integration test that a member with no `LeagueRating` row does not
  appear on the leaderboard and does not break the profile view.
- The feature 14 concurrency test still passes against the new lock target.

---

## T4 — Sides and placements

**Status:** not started
**Depends on:** T3

### Read first

- `src/lib/game-outcome.ts` and 0009 (win/loss/draw is read from the
  score).
- `src/lib/player-match-history.ts`, `src/lib/record-game.ts`,
  `src/lib/game-series.ts`.

### Change

- A score-to-placement mapping in `src/lib/`, with its own test file. R6
  and R7 will both use it, so it does not live in a route.
- `game-outcome.ts` reads placements, with the two-side case derived from
  scores exactly as today.
- `record-game.ts` takes `sides[]` and writes `GameSide` rows.
- `player-match-history.ts` reads sides, and stops filtering out
  `TEAM_VS_TEAM` — there is no `GameMode` any more. Team games still
  cannot be *recorded* until R11; history should simply not assume one
  opponent.
- `calculateElo1v1` is unchanged. It is fed from the new shape.

### Verify

- Unit tests, including a 3-side case for the placement mapping even though
  nothing can record one yet. That test is the proof 0013 asked for.
- `npm run test:integration`.

---

## T5 — Matchmaking league scoping

**Status:** not started
**Depends on:** T4

### Read first

- `src/lib/matchmaking/search.ts`, `matcher.ts`, `state.ts`,
  `pending-game.ts`, `dashboard.ts`, `run-matcher.ts`, `tolerance.ts`.
- 0010 on derived state, and the plan's note that a league filter does not
  bound the `DISTINCT ON` queries.

### Change

- A search names a league; `startSearch` records it and refuses a user who
  is not a member.
- `findMatchFor` and `proposePendingGame` pair only within one league.
  **This is the correctness heart of the task** — a cross-league pairing
  would rate two players on a ladder neither is on.
- `leagueId` on both event logs' writes, and into the derived-state
  queries.
- `run-matcher.ts` iterates leagues with active searches. One pass still
  serves them all; per-league sharding is explicitly out of scope.
- `pending-game.ts` passes the league through to `recordGame`.

### Verify

- An integration test that two searches in different leagues are **never**
  paired, and that a non-member cannot start a search.
- The feature 14 atomicity test still passes.
- `npm run test:integration`.

---

## T6 — API

**Status:** not started
**Depends on:** T5

Per decision 6, the API is part of this feature. Per decision 12, the flat
paths are **removed** — no aliases.

### Read first

- `docs/api-conventions.md` §2 (URL namespace), §3 (envelope), §6b
  (authorization), and 0011.
- `src/lib/api/schemas.ts`, `middleware.ts`, `openapi.ts`.
- The plan's API table.

### Change

- Move `/leaderboard`, `/league/activity`, `/games`, `/matches/*`,
  `/search`, `/search/cancel`, `/me/search` under
  `/api/v1/leagues/{slug}/…`; delete the old route files.
- Add `GET /api/v1/leagues` and `POST /api/v1/leagues` — creation is
  admin-only (decision 4), authorised through `src/lib/authorization.ts`,
  not inline.
- `/players/{username}` returns per-league ratings; its `matches` and
  `ratings` sub-routes take a league filter.
- Writes accept `sides[]`; keep `result: "A" | "B" | "draw"` working as an
  **adapter at the route boundary**, never in `src/lib/`.
- Regenerate the OpenAPI document and check it serves.

### Verify

- Every `*.integration.test.ts` under `src/routes/api/` updated to the new
  paths, via `src/test/http.ts`.
- A test that a non-admin gets 403 from `POST /leagues`.
- A test that a game id from league A is not readable under league B's
  path — the composite key makes this a real case, not a theoretical one.
- `npm run build`, plus the client-bundle grep with `grep -a`.

---

## T7 — Web routes

**Status:** not started
**Depends on:** T6

### Read first

- `src/routes/league.tsx`, `match.tsx`, `player.$username.tsx`,
  `index.tsx`.

### Change

- Each page resolves a league and passes it to its server functions.
- `match.tsx` reads sides rather than `teamAScore` / `teamBScore`.
- `player.$username.tsx` shows a rating per league.

### Decision needed before starting

**How does the web app know which league it is looking at?** The plan does
not settle this and it is a UI question, not a schema one. With admin-only
creation and one seed league, the cheap answer is that pages resolve the
signed-in user's single active membership and fall back to the seed league,
with no switcher UI — simplest markup, no new state, and consistent with
holding league creation back (decision 4). A league slug in the page route
is the other option and is where this ends up once users have several
leagues. **Raise it rather than picking one silently.**

### Verify

- `npm run build`, and the app driven manually: leaderboard, record a game
  through matchmaking, view a profile, view match history.

---

## T8 — Close-out

**Status:** not started
**Depends on:** T7 (documentation may be drafted earlier)

- **Accept 0015**: rename
  `docs/decisions/0015-draft-league-scoped-ratings-and-sides.md` without
  `-draft-`, status to `Accepted`, update the index table, and correct
  anything the work disproved **before** accepting it.
- **Amend 0013's consequence table** in place, in the same commit as the
  change that closes each row, per the precedent feature 14 set with 0010:
  the `teamAScore` / `teamBScore`, `GameMode`, `game-outcome.ts` and match
  history rows close. The `playerA*` / `playerB*` and pairwise-rating rows
  stay open for R10–R12.
- **Update 0011 and `docs/api-conventions.md`** for league-scoped paths and
  the dropped flat ones.
- Mark R5 done in `.claude/plans/roadmap.md`.
- `git mv` the plan and this task list into `complete/`, updating the
  references in both.

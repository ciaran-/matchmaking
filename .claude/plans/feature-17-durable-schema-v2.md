# Durable Schema v2: Leagues, Sides and Placements — Feature Plan

Replace the single global rating and the two-sided score columns with
league-scoped ratings and a row per side, and carry both through the `v1`
API in the same feature.

Feature 17, roadmap item R5 (`.claude/plans/roadmap.md`) — R5a, R5b and R5c
together. Tasks: `.claude/tasks/feature-17-tasks.md`. The pivot of the autumn 2026 roadmap: everything after it writes
into these shapes.

## Context

Three durable shapes block the roadmap, and all three are schema.

**One global rating.** `User.currentRating` is a single `Int` with its own
index, read by `leaderboard.ts`, `matchmaking/search.ts`,
`player-profile.ts`, `record-game.ts` and `sync-user.ts`, and surfaced by
`league.tsx`, `match.tsx`, `player.$username.tsx` and
`api/v1/search.ts`. A player cannot hold two ratings, so a second league
would corrupt the first.

**Two sides, baked in.** `GameResult.teamAScore` / `teamBScore` and the
`Team` enum (`A`, `B`) appear in `game-outcome.ts`,
`player-match-history.ts`, `record-game.ts` and `match.tsx`. Decision 0013
lists nine places that assume exactly two sides and says none should be
extended further.

**No provenance.** `GameResult` records no source and no recording actor.
0005 requires both before the first import (roadmap R6).

The matchmaking event log carries the same assumptions in
`playerAId` / `playerBId` / `searchAAttemptId` / `searchBAttemptId`, and
has no league at all — so the matcher would pair a search in one league
with a search in another.

## Decisions taken (13 Oct 2026)

Answers to the open questions from R4 and from this plan's scoping
conversation. All are Ciaran's, recorded here because several constrain
work beyond this feature; decision record 0015 carries the durable ones.

1. **A rating is keyed `(user, league)`.** Even once a game concept exists,
   each league holds its own rating. Seeding a new league from a previous
   one — a season rollover, or "ranked once you have played X unranked
   games" — is a read of the old league's ratings, not a shared key.
2. **A league is owned by a user for now** (`League.createdByUserId`).
   Organisations come later and are an addition, not a re-key.
3. **Both enrolment paths are supported.** A game using our API for its own
   matchmaking auto-enrols its users into a default league; user-created
   leagues and offline play use an explicit join.
4. **Only seeds and admins create leagues** at this stage. Opening it up
   may become a role or a scoped permission (R15a).
5. **`Game` and `Ruleset` land as simple models**, each referenced by key.
   A league holds exactly one ruleset. The `GameMode` enum is retired —
   it is the only thing defining rules today, and it should not be.
6. **All of R5 ships as one feature, API included.** Not half-shipped, and
   API routes count as part of a feature by default rather than as
   optional follow-up work.
7. **Matchmaking is league-scoped.** A search names a league; the matcher
   only pairs within one.
8. **Rating rows are separate from membership rows** (option B below).
9. **High-volume tables carry `leagueId` in their primary key**, so
   partitioning stays a SQL-only change later. No partitioning now.
10. **The existing ladder becomes `matchmaking-internal-seed-league`.**
    Zeroing out current games, or deleting data, is acceptable at this
    stage — Ciaran will be explicit when that stops being true.
11. **One migration if it stays simple**, tested thoroughly locally.
    Expand/contract is the right shape under real load; it is not needed
    yet.
12. **The flat `v1` paths are dropped, not kept as adapters.** Every
    reference to them is updated to the league-scoped equivalent for the
    seed league. 0011 permits a documented breaking change within `v1`, and
    with no live users there is nothing to deprecate gently.

Prisma stays while it is useful. If it obstructs scaling later, moving off
it is a decision for that moment, not a constraint on this one.

## Schema

New models, in the shape decided above:

```prisma
model Game {
  id   String @id @default(cuid())
  key  String @unique          // "pool", "darts"
  name String
  rulesets Ruleset[]
  leagues  League[]
}

model Ruleset {
  id     String @id @default(cuid())
  gameId String
  key    String                 // "1v1-elo"
  name   String
  game   Game   @relation(fields: [gameId], references: [id])
  @@unique([gameId, key])
}

model League {
  id              String   @id @default(cuid())
  slug            String   @unique
  name            String
  gameId          String
  rulesetId       String
  createdByUserId String
  createdAt       DateTime @default(now())
}

model LeagueMembership {
  leagueId String
  userId   String
  joinedAt DateTime         @default(now())
  status   MembershipStatus @default(ACTIVE)   // ACTIVE | LEFT
  @@id([leagueId, userId])
}

model LeagueRating {
  leagueId      String
  userId        String
  currentRating Int      @default(1000)
  updatedAt     DateTime @updatedAt
  @@id([leagueId, userId])
  @@index([leagueId, currentRating])           // leaderboard
}
```

Membership and rating are separate rows on the same key because
auto-enrolment (decision 3) makes "a member who has never played" the
common case on day one. Under a single row, every auto-enrolled user gets a
fabricated 1000 that lands in the leaderboard index and has to be filtered
out of every view; with two, **having a rating means having played**. It
also gives R9a's provisional ratings somewhere honest to live, lets a
member leave without destroying their rating, and keeps the hot write off
the row that holds join metadata.

`GameResult` gains the league, provenance and a row per side:

```prisma
model GameResult {
  id               String     @id @default(cuid())
  leagueId         String
  createdAt        DateTime   @default(now())
  source           GameSource                  // MATCHMAKING | MANUAL | IMPORT
  recordedByUserId String?                     // null for service callers until R6
  sides            GameSide[]
  participants     GameParticipant[]
  @@id([id, leagueId])
  @@index([leagueId, createdAt])
}

model GameSide {
  gameResultId String
  leagueId     String
  ordinal      Int        // 0, 1, … — replaces Team A/B
  score        Int
  placement    Int        // 1 = winner; equal values are a draw
  @@id([gameResultId, leagueId, ordinal])
}

model GameParticipant {
  gameResultId String
  leagueId     String
  userId       String
  sideOrdinal  Int
  ratingBefore Int
  ratingAfter  Int
  ratingChange Int
  @@id([gameResultId, leagueId, userId])
  @@index([leagueId, userId])
}
```

`placement` alongside `score` is what lets 3+ sides arrive as an addition
(R12) rather than a re-key: with two sides, placement is derived from the
scores and `game-outcome.ts` keeps working behind it.

Both event logs gain `leagueId` and take it into their indexes.
`playerAId` / `playerBId` stay as they are — the matchmaking event log is
R10 and R14's problem, and 0013 does not require it to generalise in this
feature. What it does require is that the matcher cannot cross leagues.

### What the composite keys cost

Postgres will not accept a unique index on a partitioned table unless it
includes the partition key. So once `GameResult` is keyed `(id, leagueId)`,
**`id` cannot be enforced unique on its own**. In practice a cuid will not
collide, but the database stops guaranteeing it, and a lookup by bare game
id is no longer a unique-key read.

That is not a cost to absorb quietly — it is the reason the API paths below
become league-scoped rather than staying flat. R4 already decided a caller
names the league explicitly; this makes it structural.

## API (R5c, folded in)

League-scoped paths for everything a league owns, per
`docs/api-conventions.md` §2:

| Today | Feature 17 |
| --- | --- |
| `GET /api/v1/leaderboard` | `GET /api/v1/leagues/{slug}/leaderboard` |
| `GET /api/v1/league/activity` | `GET /api/v1/leagues/{slug}/activity` |
| `POST /api/v1/games` | `POST /api/v1/leagues/{slug}/games` |
| `GET /api/v1/matches/{id}` and its actions | `GET /api/v1/leagues/{slug}/matches/{id}` … |
| `POST /api/v1/search`, `/search/cancel`, `GET /me/search` | league-scoped equivalents |
| — | `GET /api/v1/leagues`, `POST /api/v1/leagues` (admin only) |

`GET /api/v1/players/{username}` returns a rating per league rather than
one number. `/players/{username}/matches` and `/ratings` take a league
filter.

The left-hand paths are **removed**, per decision 12 — no aliases, no
deprecation window. Everything referencing them (the web app's fetches, the
OpenAPI document, `docs/api-conventions.md`, the integration tests) moves to
the league-scoped form against the seed league.

**Writes gain `sides[]`**, and v1's `result: "A" | "B" | "draw"` is kept as
an adapter over it, per R5c. The adapter lives at the route boundary, not
in `src/lib/` — the shared core takes sides.

## Migration

One migration, per decision 11:

1. Create the five new models, `GameSource` and `MembershipStatus`.
2. Seed a `Game`, a `Ruleset` and the `matchmaking-internal-seed-league`.
3. Enrol every existing `User`; copy `currentRating` into `LeagueRating`.
4. Stamp `leagueId` on `GameResult`, `GameParticipant` and both event logs.
5. Convert each `GameResult` into two `GameSide` rows, mapping `Team.A` → 0
   and `Team.B` → 1, and `GameParticipant.team` → `sideOrdinal`.
6. Re-key the primary keys to their composite forms.
7. Drop `User.currentRating`, `teamAScore`, `teamBScore`, `Team` and
   `GameMode`.

Step 5 is the only interesting part. It is worth writing rather than
resetting, because R6's importer and R7's replay need the same
score-to-placement mapping anyway — but it is not load-bearing. If it
fights the migration, reset instead (decision 10) and keep the mapping in
`src/lib/` where those features will use it.

## Production exposure

**This feature is almost entirely migrations, including destructive drops,
and `netlify.toml` runs `prisma migrate deploy` in every build context. The
migration will apply to the production database when this branch's first
deploy preview builds — before anyone reviews it.**

That is the risk R1 was deferred to carry (17 Sep 2026), and feature 17 is
its largest single exposure. The zero-cost partial fix — `[context.*]`
blocks confining `migrate deploy` to the production context — was offered
again on 13 Oct 2026 and deliberately declined, so the agreed handling
applies instead: the migration is tested locally first, and production's
schema is expected to change at the first preview build rather than at
merge. Decision 10 is what makes that tolerable: there are no live users,
and losing current data is acceptable.

## Rejected

- **A global rating kept alongside per-league ratings**, as a "primary"
  number. Two sources of truth for the same quantity, and nothing needs it.
- **Partitioning in this feature.** Prisma cannot express it; it would be
  raw SQL for a problem no measurement has shown (0012). Decision 9 keeps
  it available, which is the whole point.
- **A separate R5c API feature.** Decision 6.
- **Generalising the matchmaking event log to N players here.** R10 and R14
  rewrite that area; widening it now is speculative (0013 allows a cheap
  1v1 assumption where it is cheap to change).

## Non-goals

- Organisations owning leagues, and user-facing league creation (2, 4).
- Team and free-for-all rating maths (R11, R12). `calculateElo1v1` runs
  unchanged, fed from the new shape and the per-league rating.
- Rating replay, disputes, seasons, provisional ratings (R7, R8, R9).
- R13's projection tables, and per-league matcher sharding. Both stay
  triggered by usage.

## Risks

- **The diff is wide**: nine `src/lib/` modules, four page routes and
  roughly fifteen API routes, plus every integration factory and scenario,
  which all now need a league.
- **Composite foreign keys are verbose in Prisma** and touch every relation
  on `GameResult`. Mechanical, but it is where typos will hide.
- **`GameResult.id` loses its uniqueness guarantee** (above). Any code that
  looks up a game by bare id must be found and given a league.
- **One migration with destructive drops**, applied to production from a
  preview build. See above.
- **Re-keying the event logs touches 0010's derived-state queries**, which
  already scan with `DISTINCT ON`. Adding a league filter does not bound
  them; R13 remains the fix, and multiple leagues make it worse.
- **One matcher pass still serves all leagues**, so a busy league delays
  matching in every other. Not fixed here; league scoping provides the
  shard key for when it is.

## Verification

- `npm run check`, `npm run build`, `npm test`,
  `npm run test:integration`.
- Client-bundle grep for server-only signals, per CLAUDE.md, using `grep -a`
  — several of these modules sit behind server functions.
- The migration runs from empty **and** against a copy of current data
  locally, before the branch is pushed.
- A deploy preview, given the breadth of the route changes.
- Every `src/lib/` function that gains a league parameter keeps its unit
  test, per CLAUDE.md's "every new function in `src/lib/` must have a test".

## When done

- Accept decision record **0015**, drafted up front as
  `docs/decisions/0015-draft-league-scoped-ratings-and-sides.md`: rename it
  without `-draft-`, set the status to `Accepted`, update the index, and
  correct anything the work disproved before doing so.
- Amend 0013's consequence table: the `teamAScore` / `teamBScore`,
  `GameMode`, `game-outcome.ts` and match-history rows close with this
  feature. Amend in place, in the same commit as the change, per the
  precedent set by feature 14 against 0010.
- Update 0011 and `docs/api-conventions.md` for the league-scoped paths.
- Mark R5 done in the roadmap, and `git mv` this plan and its task list
  into `complete/`.

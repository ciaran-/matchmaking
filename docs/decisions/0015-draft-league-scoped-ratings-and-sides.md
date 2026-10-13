# 0015. Ratings are per league; results are a row per side

- **Status:** Draft — the decisions are made, the work is not done
- **Date:** 2026-10-13
- **Source:** `.claude/plans/feature-17-durable-schema-v2.md`, roadmap item
  R5, and R4's direction of 2026-09-14
- **Partly closes:** 0013's consequence table (the two-sided rows)

**Why this is a draft.** The decisions below were taken on 13 Oct 2026 and
are what feature 17 is being built against. They are written down now
rather than at the end so they survive a lost context, but nothing here is
in the schema yet. On completion of feature 17 this file is renamed to
`0015-league-scoped-ratings-and-sides.md`, the status becomes `Accepted`,
and anything the work proved wrong is corrected here before that happens.
Until then, read it as intent.

## Context

Three durable shapes stood in the way of the autumn 2026 roadmap, all of
them schema:

- `User.currentRating` was a single global `Int`, so a player could hold
  exactly one rating. R4 decided on 14 Sep 2026 that the platform is
  multi-league from the start, which that column cannot express.
- `GameResult.teamAScore` / `teamBScore` and the `Team` enum assumed
  exactly two sides. 0013 listed nine places that assumption reached and
  required that nothing extend it further.
- `GameResult` recorded no source and no recording actor, which 0005
  requires before the first offline import.

R4 left two questions open "with R5's plan": who owns a league, and whether
a game or ruleset concept sits above one. Both are answered here.

## Decision

**A rating is keyed `(user, league)`.** A player holds a separate rating in
each league they play in. This holds even though a `Game` concept now
exists above leagues: two leagues for the same game do not share a rating.
Seeding a new league from an older one — a season rollover, or "ranked once
you have played X unranked games" — is a read of the old league's ratings,
not a shared key.

**Membership and rating are separate rows on the same key.**
`LeagueMembership` records that a user belongs to a league;
`LeagueRating` records what they are rated there. Both are keyed
`(leagueId, userId)`. A membership without a rating row is the normal
state of a member who has not played.

**`Game` and `Ruleset` sit above `League`, each referenced by key.** A
league holds exactly one ruleset, which is what defines how its games are
scored and rated. The `GameMode` enum is retired: it was the only thing
describing rules, and a two-value enum on each result is the wrong place
for that.

**A league is owned by a user for now.** `League.createdByUserId`.
Organisations are wanted and will come; adding an owning organisation later
is an addition rather than a re-key, so it is deferred deliberately.

**Only seeds and admins create leagues** at this stage. Opening that up is
expected to become a role or a scoped permission (see 0006 and roadmap
R15a), not an unguarded endpoint.

**A result is a row per side, carrying both a score and a placement.**
`GameSide` replaces the two score columns; `GameParticipant` references a
side by ordinal rather than a `Team` enum. Placement is what lets three or
more sides arrive as an addition rather than a re-key: with two sides it is
derived from the scores, and win/loss/draw continues to be read from the
score (0009) behind it.

**Every result records its provenance** — a source (matchmaking, manual,
import) and the recording actor — which is what 0005 asked for.

**Leagues are row-scoped within one database, and high-volume tables carry
`leagueId` in their primary key.** `GameResult`, `GameParticipant`,
`GameSide` and both matchmaking event logs are keyed with the league. No
partitioning is done now; the key shape is what keeps partitioning a
SQL-only change if volume ever asks for it.

**A caller always names the league explicitly.** League-scoped resources
carry it in the path. The flat `v1` paths that implied a single league
(`/leaderboard`, `/games`, `/matches/{id}`, `/search`) are dropped rather
than kept as adapters, and their references are updated to the
league-scoped equivalents for the seed league.

## Consequences

- **`GameResult.id` is no longer unique on its own.** Postgres will not
  accept a unique index on a partitioned table unless it includes the
  partition key, so a composite primary key is incompatible with a
  standalone unique on `id`. A cuid will not collide in practice, but the
  database stops guaranteeing it, and a lookup by bare game id is no longer
  a unique-key read. This is the structural reason the API paths are
  league-scoped rather than flat.
- **Every league-scoped query carries a league filter**, from this point
  onward. A query written without one is a bug, not an optimisation.
- **Having a rating means having played.** Any view that lists rated
  players reads `LeagueRating`; any view that lists members reads
  `LeagueMembership`. Auto-enrolling a game's whole playerbase therefore
  costs one row each and does not populate leaderboards with fabricated
  starting ratings.
- **A player can leave a league without losing their rating**
  (`MembershipStatus.LEFT`), which R9b's seasons and any future rejoin flow
  depend on.
- **The scaling ladder is row-scoped → partitioned → separate instances**,
  and each rung is reachable without a rewrite because `leagueId` is on
  every row. Database-per-tenant stays what R4 called it: a value judgement
  for a customer who genuinely needs it. Row scoping is its prerequisite,
  not its alternative.
- **Noisy neighbours remain, in two known places.** 0010's derived-state
  queries scan the whole event log, so one league's volume slows every
  other league's matchmaking until roadmap R13 lands projection tables; and
  one matcher pass still serves all leagues, so a busy league delays
  matching elsewhere. League scoping supplies the shard key for the second
  whenever it is worth doing.
- **A rating belonging to `(user, game)` across leagues would be a
  re-key**, not an addition. R4 recorded that as a chosen risk and this
  record keeps the choice explicit.
- **Four of 0013's nine two-sided rows close** with feature 17:
  `teamAScore` / `teamBScore`, `GameMode`, `game-outcome.ts` and match
  history. The matchmaking event log's `playerA*` / `playerB*` columns and
  the pairwise rating maths stay two-sided deliberately, for R10 to R12.

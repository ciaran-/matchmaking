# Roadmap — Autumn 2026

Fifteen items in proposed order, covering roughly eight focused weeks from
Monday 14 September 2026. This is a sequencing document, not a plan: each
item still needs its own plan under `.claude/plans/` before any code, and
its own feature number (the next free one is 13) at that point.

**Status:** R1–R5 are agreed, and R4 is now answered — the platform is
multi-league (see R4). R6 onward are proposed and not yet reviewed.

Charted version (private artifact):
<https://claude.ai/code/artifact/2e27f310-bf42-4369-9c91-849937405953>
The chart still shows R5 at its pre-multi-league size; see R5 below.

## Why this order

- **Get production out of the development loop.** Deploy previews use the
  production database, and `netlify.toml` runs `prisma migrate deploy` in
  every build context, so a pull request can change the production schema
  before anyone reviews it.
- **Settle durable shapes early.** League scoping, sides and placements,
  and game provenance are all schema. They land before the importer and
  disputes write more data in the current single-league, two-sided shape
  (0013).
- **Protect the ladder before widening it.** Import, disputes and seasons
  land while 1v1 is the only mode, so each is designed against a single
  rating model.
- **Complete features beat hardening.** Scale work waits for real usage
  (see "Deliberately left off"). The suggested rule while it waits —
  proposed here, not previously agreed — is to keep new event-log queries
  bounded by an indexed key or a recent time window, and to keep durable
  shapes free of two-sided assumptions.

## Sizing

Sizes are relative to the features shipped on 9–10 September 2026:
S ≈ feature 9, M ≈ features 7 and 10, L ≈ feature 11, XL ≈ feature 6.

Those six shipped in two days, but most were read-only views over existing
data. Most items here are migrations, write paths or rating maths; three
need a product decision first and three more produce a decision record. The
eight-week shape assumes about two items a week. If the September pace
holds, the order stands and the calendar compresses.

## Week 1 — Get production out of the loop

### R1. Separate environments from production (L)

Plan written: `.claude/plans/environment-separation.md`.

Production, preview and local databases, on AWS-hosted Postgres.

- **R1a** — Previews get their own database, and preview builds migrate
  only that one. *Ships:* a pull request can no longer change the
  production schema.
- **R1b** — Migrations reach production only from a `main` deploy, after
  running from empty in CI and against the preview copy. *Ships:* every
  migration is exercised against production-shaped data first.
- **R1c** — Refresh pipeline: restore the RDS snapshot to a scratch
  instance, anonymise it there, dump it, load preview. Preview is
  overwritten on a schedule and holds nothing long-lived. Locally,
  `npm run db:refresh` loads the same dump on demand. *Ships:* local and
  preview data with production shapes; the hand-written seed retires.

Anonymise in the scratch instance, never in preview after loading —
otherwise production personal data sits in the least-protected database
(0007). A full anonymised copy is simpler than a slice while the database
is small, since a slice still needs every user its games reference.

**Trade-off:** one shared preview database means two open pull requests
with different migrations both write to it, and an abandoned one leaves its
migration behind. A destructive migration breaks other previews until the
next refresh. The scheduled refresh is the reset.

### R2. Hardening sweep (S)

- Check whether `matchmaker-tick` answers over HTTP in production. If it
  does, anyone can trigger extra matcher passes (open question in 0005).
- Make `convertPendingGameToResult` a single transaction. A failure
  between recording the game and appending `PLAYED` leaves an orphaned
  game (0010). R8 adds a second write to this path.
- Remove the merged worktrees under `.claude/worktrees/` and the merged
  agent branches.

### R3. Clerk Core 3 upgrade (S)

Plan already written: `.claude/plans/clerk-react-core-3-upgrade.md`.
`@clerk/clerk-react` is deprecated and the app runs two Clerk cores side
by side.

All environments currently share one Clerk dev instance. Splitting that
per environment is a later config change, but not a free one:
`sync-user.ts` matches on `clerkId` alone, so existing users would arrive
with new Clerk IDs, collide on the email unique constraint, and fail to
sign in. That switch needs a one-time relink (Clerk's import keeping the
old ID as an external ID, or matching verified email once), and personal
API keys would need reissuing.

## Weeks 2–4 — Settle the durable shapes

### R4. One league, or many? — answered 14 Sep 2026

**Many.** The platform supports multiple leagues from the start, with at
least two in production at launch. The reasoning is optionality: a
single-league schema would foreclose selling the platform as a framework or
package that a multiplayer game developer runs for their own players. That
is a durable shape, and the expensive kind to add later — the same argument
as 0013.

Still to write: decision record 0015, which needs the sub-questions in
"Decisions needed" below answered first.

### R5. Durable schema v2: leagues, sides and placements (XL) — needs R4

Grew from L to XL when R4 was answered, which pushes the items after it by
roughly half a week. It is the pivot of the whole roadmap: everything after
it writes into these shapes.

- **R5a** — League scoping. A `League` entity, membership, and a rating per
  player *per league* — `User.currentRating` is a single global number
  today and cannot stay one. Leaderboards, matchmaking, the activity
  dashboard and match history all become league-scoped. *Ships:* a second
  league can exist without corrupting the first.
- **R5b** — Sides and placements. A row per side (score and placement)
  replaces `teamAScore`/`teamBScore`, per 0013's list of nine two-sided
  assumptions. `GameResult` gains provenance: source (matchmaking, manual,
  import) and the recording actor, which 0005 requires before the first
  import. Existing games are backfilled. *Ships:* every game records who
  entered it and how.
- **R5c** — API. League-scoped paths, plus the additive `sides[]` shape on
  game writes and history reads, with v1's
  `result: "A" | "B" | "draw"` kept as an adapter. *Ships:* clients can
  adopt the shapes that support teams and multiple leagues.

Rating maths is unchanged: `calculateElo1v1` still runs, fed from the new
shape and the per-league rating.

The framework/package ambition also raises the stakes on the REST API being
the primary interface rather than an afterthought (0011), and on service
identity (0005), since an embedding developer is exactly the third-party
caller that decision anticipated.

## Weeks 4–6 — Protect the ladder

### R6. Offline game import (L) — feature 12; needs R5, and R7 for R6b

The first real service caller, which settles 0005's credential question.

- **R6a** — Forward-only import: a signed-secret service credential
  (0005's guidance for internal jobs), a batch idempotency key,
  all-or-nothing batches in played-at order, using R5's `sides[]` payload
  and naming a league. Rejects any game older than an involved player's
  latest rated game. *Ships:* offline results recorded without corrupting
  ratings.
- **R6b** — Backdated import, placing games where they happened in
  history, via R7.

### R7. Rating replay engine (L) — needs R5

Recompute ratings forward from a point in history, built on
`processGameSeries` (feature 2.1). Shared by R6b, R8b and any future
change to the rating model.

**Scale risk:** a correction spreads to every later game of anyone who
later played an affected player, which within a league can be most of the
ladder. It has to be bounded and asynchronous. League scoping helps: a
replay stops at the league boundary.

**Needs a decision:** replay history exactly, or apply compensating
adjustments? Replay supersedes part of 0008.

### R8. Result confirmation and disputes (M) — needs R2 for R8a, R7 for R8b

Today the first report wins (0010), so one player's mistake or bad faith
sets both ratings.

- **R8a** — Both players confirm the reported score; a mismatch marks the
  match disputed and applies no rating change. *Ships:* bad results stop
  reaching the ladder.
- **R8b** — An admin resolves the dispute, and the correction applies
  through R7.

### R9. Provisional ratings and seasons (M) — needs R5 for R9b

- **R9a** — Higher K for a player's first games, with a provisional badge.
  `calculateElo1v1` already takes a K-factor, so no signature change.
  Parallel-safe. *Ships:* new players reach their level in fewer games.
- **R9b** — Seasons: time-windowed leaderboards, an archive of past
  standings, an optional soft reset. Scoped per league, so two leagues can
  run on different season calendars.

## Weeks 6–7 — Finish the core loop

### R10. Live matchmaking (L)

- **R10a** — Better feedback while polling: a countdown for the 10-second
  confirm window, tab title and browser notification on match found, and
  no instant rematch with an opponent who just declined (all from feature
  4's out-of-scope list). Parallel-safe. *Ships:* most of the noticeable
  improvement, with no new infrastructure.
- **R10b** — Push delivery replaces polling on `/match`.

`/match` polls every 2 seconds while a player searches or confirms, so
10,000 queued players is roughly 5,000 requests a second before anyone
plays. Push also removes most of the read volume R13 would relieve, which
is part of why R13 can wait.

**Needs a decision:** Netlify Functions cannot hold long-lived
connections, so push needs a managed pub/sub service or a separate socket
host.

## Weeks 7–8 — Beyond 1v1

### R11. Team games (L) — needs R5, R6a

Record team games by hand and by import, choose a team rating method
(decision record), and show teammates in match history and profiles. Match
history filters out `TEAM_VS_TEAM` today. Matchmaking stays 1v1.

### R12. Free-for-all and multi-team (L) — needs R5, R11

Results become placements, which break the win/loss/draw assumption in
`game-outcome.ts` (0009). A decision record chooses the rating model for
three or more sides, comparing pairwise Elo across placements with a
Weng-Lin (OpenSkill-style) model.

## Week 8 onward — When usage asks for it

### R13. Matchmaking read models (L) — triggered, not scheduled

`getActiveSearches` and `getActiveMatches` derive state with unbounded
`DISTINCT ON` over a whole event table (`state.ts:137`, `:247`, `:286`),
so their cost grows with total events written rather than with what is
active (0010). Real, but not urgent: it waits for actual usage, or for
R14. Note that multiple leagues make it worse — one league's event volume
slows every other league's queries until this lands.

The fix is active-search and active-match projection tables written in the
same transaction as each event, with events still the source of truth,
keyed by a participant list rather than `playerA`/`playerB` so R14 extends
them instead of replacing them.

### R14. Group matchmaking (XL) — needs R10b, R11, R12, R13

Queue as a party, form teams and lobbies in the matcher, confirm per
participant. Group confirmations fail more often, which is another reason
push delivery comes first.

### R15. Scoped roles and tournaments (XL) — needs R5, R8

- **R15a** — A grant table keyed by (user, scope), as
  `docs/api-conventions.md` prescribes, with an organiser role. A global
  `ADMIN` cannot express authority bounded to one tournament — or, now, to
  one league (0006).
- **R15b** — Tournaments: brackets or Swiss rounds.

**Needs a decision:** do tournament games count toward the main ladder?

## Decisions needed, and when

| Decision | Needed by | Items |
| --- | --- | --- |
| ~~One league, or many?~~ Answered 14 Sep: many | — | R4, R5 |
| League sub-questions (below), to write 0015 | Before week 2 | R5 |
| Do imported and tournament games count toward the ladder? | Before week 4 | R6, R15 |
| Replay history, or compensating adjustments? | Before week 5 | R7, R8 |
| Where do push connections live? | Before week 7 | R10 |

The sub-questions R5a cannot be designed without:

1. **Who owns a league** — a customer or organisation account, or a user?
   This decides whether an organisation entity is needed now.
2. **Can one person play in several leagues**, carrying a separate rating
   in each? Assumed yes, since it follows from multi-league, but it is
   what forces `currentRating` out of `User`.
3. **How is a league's data isolated** — row-scoped in one database, or a
   database per tenant? Row scoping is the expected answer; it needs saying
   once, because every query then carries a league filter.
4. **How does a caller address a league in the API** — a path segment
   (`/leagues/{id}/...`), or inferred from the credential? This is part of
   the published contract (0011).

## Deliberately left off

- **Load testing and performance baselines.** Dropped on direction given
  14 Sep 2026: complete, tested features matter more than hardening right
  now. Instead, check the plan of a new or changed query against the
  preview database, which holds production-shaped data after R1c.
- **Adoption features** (invites, joining, shareable public pages). The
  minimum feature set and UX come first.
- **Per-pull-request databases.** One shared preview database is enough at
  this size; the scheduled refresh is the reset button.
- **Caches and Redis.** Ruled out by 0012 until something measured is
  slow.
- **Moving off Prisma.** No plan until raised. Items keep database access
  inside `src/lib/`, so the move stays possible.
- **Username changes and profile editing.** 0014 makes a rename a
  link-breaking change.
- **Third-party developer platform.** No OAuth apps or partner onboarding
  yet. Note this sits closer to the roadmap than it did, given the
  framework ambition behind R4.
- **Launch branding and landing page**, plus removing unused starter
  dependencies. Needs a brand direction more than engineering.

## Provenance

Drafted 11–14 September 2026 from the plans in `.claude/plans/`, decision
records 0001–0014, and product direction given in conversation. Where this
document proposes a rule that has not been agreed (for example the
event-log query guidance above), it says so.

# Offline Game Import — Feature Plan

Recording games that were played away from the app, in bulk, as the
system rather than as a person.

**This plan is deliberately unfinished.** It is a starting point for a
design discussion, not a decided approach. The open questions below are
the point of it; several have no obvious right answer and at least one
(ordering) can silently corrupt the ladder if answered wrong.

Spun out of `.claude/plans/complete/feature-11-service-identity.md`, where it was
Checkpoint 3. It is a feature in its own right, not a checkpoint of an
auth change.

## Context

Feature 7 deliberately closed the ability for a user to record a game
between two arbitrary players: you may record a game you played in, and
an `ADMIN` may record anyone's. That was the right call for users and it
is what makes this feature necessary — the system needs a capability that
users specifically must not have.

**This is the first concrete caller that authenticates as the system**,
which makes it the thing that unblocks feature 11's deferred credential
decision. `matchmaker-tick` never did: it runs `runMatcherPass()` in the
same process and calls `src/lib/` directly, so it has no request to
authenticate.

Relevant existing pieces:

- `recordGame` (`src/lib/record-game.ts`) — records one 1v1 result and
  applies Elo. No idempotency key, no backdating.
- `POST /api/v1/games` — the HTTP path, participant-scoped.
- `resolveActor` / `requireUser` (`src/lib/auth.ts`) — the actor seam.
  An importer would be the first `kind: 'service'` caller.
- `createGameResult` test factory already supports a `createdAt`
  override, so the storage shape anticipates backdating even though no
  API does.

## The three problems that are not authentication

These are the substance of the feature. Auth is comparatively easy.

### 1. Elo is order-dependent

Rating changes depend on the ratings *at the time of the game*, so
replaying historical games in the wrong order produces different final
ratings — silently, with no error and no obvious wrongness in the result.
A batch of the same games submitted in two different orders yields two
different ladders.

Implications to work through:

- The import needs an explicit played-at ordering, and must apply games
  in it rather than in submission order.
- What happens when an imported game predates games already recorded in
  the app? Applying it "now" gives a mathematically different answer than
  history would have. Options: reject out-of-order imports, accept the
  approximation and document it, or recompute affected ratings forward —
  which is a much larger piece of work and touches `GameParticipant`'s
  `ratingBefore`/`ratingAfter` snapshots.
- Does an import need to be atomic with respect to concurrent live games?

### 2. Idempotency

`recordGame` has no idempotency key. A retried, duplicated, or
partially-failed import would apply rating changes twice and corrupt the
ladder in a way that is hard to detect after the fact and harder to undo.

- Natural key, or a client-supplied import/batch id?
- **A partial import is worse than a rejected one.** Prefer
  all-or-nothing per batch, which pushes toward a single transaction and
  therefore a bound on batch size.

### 3. Backdating

`GameResult.createdAt` drives the activity dashboard and its "last 24h"
window. Imported games stamped `now` would distort those views; games
stamped with their real date will not appear in recent-activity surfaces
at all, which may or may not be wanted.

## Open questions for discussion

- **Shape**: one endpoint taking an array, or an import "job" resource
  that can be inspected and retried? The latter is more machinery but
  makes partial failure and idempotency legible.
- **Size**: what is a realistic batch? That decides transaction vs.
  chunking, and interacts with feature 11's rate limiter (a legitimate
  import will look like abuse).
- **Provenance**: should an imported `GameResult` record that it was
  imported, and by which service? Feature 11's plan flags that
  `GameResult` has no actor attribution today. Backfilling that later is
  guesswork, so decide before the first import runs.
- **Validation**: what does the system do with an import referencing an
  unknown player — reject the batch, or create the player?
- **Team games**: 1v1 only, matching the rest of the app, or does bulk
  import make `TEAM_VS_TEAM` worth supporting? Match history currently
  excludes team games entirely.
- **Undo**: is there a story for reversing a bad import, or is the answer
  "restore the database"? This bears on whether `recordGame` gains an
  import batch id.

## Non-goals (proposed)

- Not a general admin data-editing surface.
- Not rating recomputation across history — unless question 1 forces it,
  in which case that is its own feature.
- Not a UI. The first version is called by the system, not by a person.

## Dependencies

- Feature 11's credential decision, which this unblocks by being the
  first real caller. For a purely internal importer, a signed secret from
  the secrets manager keeps Clerk out of the internal critical path; if
  the importer is ever operated by a third party, that changes.

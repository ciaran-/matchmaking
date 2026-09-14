# Atomic Game Conversion — Feature Plan

Close the orphan-risk window in `convertPendingGameToResult`, so recording
a game and marking the match played either both happen or neither does.

Part of roadmap item R2, feature 14 (`.claude/plans/roadmap.md`).
Tasks, covering all three sweep items: `.claude/tasks/feature-14-tasks.md`.

## Context

`src/lib/matchmaking/pending-game.ts` converts a `BOTH_CONFIRMED` match
into a result in two steps:

1. `recordGame(...)` — its own `prisma.$transaction([...])` writing the
   `GameResult`, both `GameParticipant` rows, and both users'
   `currentRating`.
2. A second `prisma.$transaction` that re-reads state, enforces first-wins,
   and appends `PLAYED` plus two `CONSUMED` events.

The function's own header documents the consequence: if the process dies
between the two, a real `GameResult` exists that no `PLAYED` event
references. Ratings have moved, but the match still reads as
`BOTH_CONFIRMED`, and the first-wins check rejects a retry, so it needs
manual reconciliation. Decision 0010 records this as known.

The original reason was composition: `recordGame` owns its transaction,
and threading a transaction client through it "would require refactoring
it".

Two facts make that refactor small now:

- `src/lib/matchmaking/state.ts` already exports
  `DbClient = PrismaClient | Prisma.TransactionClient`, and functions
  across `src/lib/` already take `client: DbClient = prisma` as a trailing
  parameter — `leaderboard.ts` and `state.ts` both do.
- `recordGame`'s three production call sites (`src/routes/league.tsx`,
  `src/routes/api/v1/games.ts`, `pending-game.ts`) and its unit and
  integration tests all call it with a single argument. An **optional**
  trailing parameter changes none of them.

## Goal

A crash or error anywhere in the conversion leaves the database as it was:
no `GameResult`, no rating change, no events. The first-wins guarantee is
preserved.

## Approach

`recordGame` gains an optional client, and owns a transaction only when it
is not given one:

- Called as today, it opens `prisma.$transaction(async (tx) => ...)` and
  runs inside it. Existing callers keep their atomicity.
- Called with a client, it runs directly on that client and opens nothing.
  The caller's transaction is the unit of work.

`convertPendingGameToResult` then opens one interactive transaction and
does everything inside it: re-read state, enforce first-wins, call
`recordGame(input, tx)`, append `PLAYED` and both `CONSUMED` events.

Two details this forces, both deliberate:

- **The array form of `$transaction` has to go.** `Prisma.TransactionClient`
  has no `$transaction` method, so the current
  `prisma.$transaction([create, update, update])` becomes sequential
  awaits on the client inside an interactive transaction.
- **The rating pre-read moves inside the transaction.** `recordGame`
  currently reads both users with `prisma.user.findMany` *before* its
  transaction opens, so two concurrent games involving the same player can
  read the same `currentRating` and one write can be lost. Inside one
  transaction it reads through the same client.

### Rejected

- **Passing a callback into `recordGame`** to run extra work inside its
  transaction. It inverts control for one caller's benefit and makes the
  signature harder to read than an optional client.
- **An outbox or reconciliation job.** Correct, and far more machinery than
  a single transaction, which is available and already the codebase's
  idiom.

## Decisions needed

- ~~Does the concurrent-rating race get fixed here?~~ **Yes, decided
  14 Sep.** Both user rows are locked with `SELECT … FOR UPDATE`, as
  `startSearch` already does for its "one active search per user" rule. The
  same lines are being touched anyway, and leaving a known defect in place
  while editing around it is not worth the saved effort.
- ~~How to record the change against 0010?~~ **Decided 14 Sep: amend the
  bullet.** 0010's consequence list describes the orphan window, and that
  stops being true. The bullet is edited to say so — no new decision
  record, and no chain of cross-references to past issues. A commit message
  alone would not do it: future readers and agents read `docs/decisions/`
  and the plans, not git history, so a record left asserting a live defect
  will be believed.

  **The amendment ships in the same commit as the fix, never before it.**
  A record must not claim a repair that has not landed.

## Non-goals

- Any change to the Elo maths, or to what a recorded game contains.
- Rating replay or correction of games already recorded (roadmap R7).
- The provenance and sides work (roadmap R5), which rewrites this area
  again later. This change should not anticipate it.

## Risks

- **Longer-held row locks.** The user rows are now locked for the duration
  of the whole conversion rather than just the write. The work inside is
  small and local, but it is a real change to lock duration on the hottest
  rows in the system.
- **Prisma's interactive transaction timeout** (5 s by default) now covers
  the event appends as well. Comfortable, but it is a ceiling that did not
  previously apply.
- **Test isolation.** `src/test/db.ts` already notes that library functions
  must share the test's connection. Tests calling `recordGame` inside a
  transaction need the same client passed through.

## Verification

- Existing unit and integration tests pass unchanged — the signature is
  backward compatible, and that is the point.
- A new integration test: force the event-append step to fail after
  `recordGame` has run, and assert that **no** `GameResult` exists and
  neither player's `currentRating` moved. This is the test that would have
  failed before the change.
- The existing first-wins test still passes: a second submitter on a match
  already `PLAYED` fails cleanly.

## When done

- Delete the `KNOWN ORPHAN-RISK WINDOW` comment block, rather than leaving
  a description of a problem that no longer exists.
- Record the 0010 follow-up per the decision above.
- Move this plan and its task list into `complete/`.

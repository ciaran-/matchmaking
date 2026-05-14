# Feature 4 — Matchmaking: Task List

Plan: `.claude/plans/feature-4-matchmaking.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

---

## Dependency graph

```
T1 (schema + migration)
   └─> T2 (test infra: db.ts reset, factory, scenario)
        └─> T4 (state.ts) ──┬─> T5 (search.ts)        ─┐
                            ├─> T7 (pending-game.ts)  ─┼─> T8 (run-matcher.ts) ──┬─> T9 (server functions)  ──> T10 (UI)
                            └─> T6 (matcher.ts)       ─┘                          └─> T11 (Netlify tick)
                                  ↑
T3 (tolerance.ts) ────────────────┘                                                      T10 + T11 ──> T12 (e2e verification)
```

### Parallelism opportunities

- **T1 and T3** can start simultaneously. T3 (tolerance) is pure math — no schema or DB dependency.
- **T5, T6, T7** can be three separate agents/developers in parallel once T4 (state) lands. They all depend on `state.ts` but not on each other.
- **T9 and T11** can run in parallel once T8 lands. They touch different files.
- **T10** is sequential after T9 (same file, `src/routes/match.tsx`).

### Strict ordering

T1 → T2 → T4 → (T5, T6, T7) → T8 → (T9, T11) → T10 → T12

---

## Pre-flight (do once before starting any task)

1. Read `.claude/plans/feature-4-matchmaking.md` end-to-end.
2. Read `CLAUDE.md` — in particular the **`createServerFn` pattern**, **Sentry instrumentation**, **Testing**, and **Prisma MCP server** sections.
3. Confirm `.mcp.json` exists locally with a valid `DATABASE_URL` (per CLAUDE.md). If not, set it up before T1.
4. Confirm `npm install` and `npm run build` succeed against the current `main`.
5. Create a working branch: `feature-4-matchmaking-agent-<short-id>` (per CLAUDE.md sub-agent / worktree convention).

---

## T1 — Schema additions and migration

**Status:** pending
**Depends on:** nothing
**Blocks:** T2, T4, T5, T6, T7, T8, T9, T10, T11

### Context

Add two new event tables (`MatchmakingSearchEvent`, `PendingGameEvent`) and a back-relation on `User`. Both tables are append-only — no `@unique` on lifecycle state, no partial indices. See plan §"Schema changes" for the exact Prisma definitions and column rationale.

### Read first

- `schema.prisma` — current shape, existing `User`, `GameResult`, `GameParticipant` models
- Plan §"Schema changes (`schema.prisma`)"

### Modify

- `schema.prisma`

### Implementation

Add the two `model` blocks and two `enum` blocks exactly as specified in the plan. Add `matchmakingSearchEvents MatchmakingSearchEvent[]` to the `User` model.

Do **not** add a back-relation from `GameResult` to `PendingGameEvent`. The reference is one-way via `PendingGameEvent.gameResultId` as a plain string column (no Prisma `@relation`).

### Run the migration

Use the Prisma MCP server (per CLAUDE.md "Prisma MCP Server" section). Name the migration `add_matchmaking_events`. Inspect the generated SQL to confirm:

- Two new tables with the right columns
- Three indices on `MatchmakingSearchEvent`, two on `PendingGameEvent`
- No partial unique index (none should be needed)
- Enum types created

### Acceptance criteria

- `npm run db:generate` succeeds.
- `prisma migrate status` reports clean.
- `npx tsc --noEmit` passes (Prisma client types pick up the new models).
- Manual check via Prisma Studio (`npm run db:studio`) shows both new tables.

---

## T2 — Test infrastructure: db.reset, factory, scenario

**Status:** pending
**Depends on:** T1
**Blocks:** T4, T5, T6, T7, T8

### Context

Integration tests for matchmaking need (a) the per-test `reset()` to clear the new tables in FK-safe order, (b) factories that append events for setup, and (c) a shared scenario for the most common "two searching players" setup.

### Read first

- `src/test/db.ts` — current `createTestDatabase()` and `reset()` shape
- `src/test/factories/user.ts` — pattern for factory functions
- `src/test/scenarios.ts` — pattern for scenarios
- Plan §"Tests > New test infra"

### Modify

- `src/test/db.ts` — extend `reset()` to delete `MatchmakingSearchEvent` and `PendingGameEvent`. FK-safe order: delete events first (they reference `User`), then existing tables.

### Create

- `src/test/factories/matchmaking-events.ts` exporting:

  ```ts
  export interface CreateStartedSearchOptions {
    rating?: number;          // override the rating snapshot
    createdAt?: Date;         // backdate for "old search" scenarios
  }

  export async function createStartedSearch(
    prisma: PrismaClient,
    user: User,
    overrides?: CreateStartedSearchOptions,
  ): Promise<{ attemptId: string; event: MatchmakingSearchEvent }>;

  export async function appendSearchEvent(
    prisma: PrismaClient,
    attemptId: string,
    type: MatchmakingSearchEventType,
    overrides?: { matchId?: string; createdAt?: Date; userId?: string },
  ): Promise<MatchmakingSearchEvent>;

  export async function appendMatchEvent(
    prisma: PrismaClient,
    matchId: string,
    type: PendingGameEventType,
    overrides?: {
      playerAId?: string; playerBId?: string;
      playerARating?: number; playerBRating?: number;
      searchAAttemptId?: string; searchBAttemptId?: string;
      actingPlayerId?: string;
      gameResultId?: string;
      createdAt?: Date;
    },
  ): Promise<PendingGameEvent>;
  ```

  - `createStartedSearch` generates a fresh `attemptId` (cuid), reads `user.currentRating` as the default rating snapshot.
  - `appendSearchEvent` and `appendMatchEvent` set `userId`/`playerAId`/etc. from the override; if absent for a STARTED/PROPOSED event, throw — these are required fields for those types.

- Add to `src/test/scenarios.ts`:

  ```ts
  export async function twoSearchingPlayersAtEqualRating(prisma: PrismaClient): Promise<{
    playerA: User;
    playerB: User;
    searchA: { attemptId: string; event: MatchmakingSearchEvent };
    searchB: { attemptId: string; event: MatchmakingSearchEvent };
  }>;
  ```

  Builds on the existing `twoEqualRatedPlayers(prisma)` scenario; calls `createStartedSearch` for each.

### Acceptance criteria

- `reset()` clears all matchmaking event rows between tests (verified by a tiny self-test that inserts an event, calls reset, expects 0 rows).
- Factory functions compile against the migrated Prisma client types.
- `npm run test` (unit) still passes — no integration test failures.

---

## T3 — `tolerance.ts` (pure)

**Status:** pending
**Depends on:** nothing — start in parallel with T1
**Blocks:** T6

### Context

Pure math, no I/O. Used by `matcher.ts` and (potentially) the UI for displaying current tolerance.

### Create

- `src/lib/matchmaking/tolerance.ts`
- `src/lib/matchmaking/tolerance.test.ts`

### Implementation

```ts
export const TOLERANCE_BASE = 50;
export const TOLERANCE_GROWTH_PER_SEC = 10;
export const TOLERANCE_CAP = 400;

export function toleranceForElapsed(elapsedSeconds: number): number {
  return Math.min(TOLERANCE_BASE + TOLERANCE_GROWTH_PER_SEC * elapsedSeconds, TOLERANCE_CAP);
}

export function ratingBand(rating: number, elapsedSeconds: number): { min: number; max: number } {
  const t = toleranceForElapsed(elapsedSeconds);
  return { min: rating - t, max: rating + t };
}
```

Negative `elapsedSeconds` should still return `TOLERANCE_BASE` (clamp at 0 inside the function, or assert positive — pick clamping for resilience).

### Tests (`tolerance.test.ts`, unit)

Per the plan:
- Starts at `TOLERANCE_BASE` at `t = 0`.
- Grows linearly: at `t = 10`, returns `TOLERANCE_BASE + 100`.
- Caps at `TOLERANCE_CAP`: at `t = 1000`, returns `TOLERANCE_CAP`.
- `ratingBand(1000, 0)` returns `{ min: 950, max: 1050 }`.
- Negative elapsed clamps to base (band at `t = -5` equals band at `t = 0`).

### Acceptance criteria

- `npx vitest run src/lib/matchmaking/tolerance.test.ts` passes.
- No imports of `@/db`, `@prisma/client`, or Node-only modules. This must remain pure.

---

## T4 — `state.ts` (derivation layer)

**Status:** pending
**Depends on:** T1, T2
**Blocks:** T5, T6, T7

### Context

Centralises "latest event → derived current state" reads. All other modules query searches and matches *through* this module — no other module touches event rows directly. The hot query is `getActiveSearches`, used by the matcher.

### Read first

- Plan §"Modules > `state.ts`"
- `src/db.ts` — singleton Prisma client

### Create

- `src/lib/matchmaking/state.ts`
- `src/lib/matchmaking/state.integration.test.ts`

### Implementation

Export the two interfaces (`DerivedSearchState`, `DerivedMatchState`) and four async functions exactly as defined in the plan.

**`getActiveSearches`** must use Postgres `DISTINCT ON`:

```ts
const rows = await prisma.$queryRaw<MatchmakingSearchEvent[]>`
  SELECT DISTINCT ON ("attemptId") *
  FROM "MatchmakingSearchEvent"
  ORDER BY "attemptId", "createdAt" DESC
`;
return rows.filter(r => r.type === 'STARTED').map(toDerivedSearchState);
```

Then map the rows into `DerivedSearchState` — note that the latest event might not be the STARTED event (we may need to re-fetch STARTED for `rating`/`startedAt`). Implementation hint: for an attempt, the latest event always carries `attemptId, userId, type, createdAt`; but `rating` and `startedAt` come from the STARTED event. Two queries (one for latest-per-attempt, one for the STARTED rows), join in app code; OR one query with a self-join. Pick whichever reads more cleanly — performance is comparable at this scale.

**`getActiveSearchForUser`**: query `MatchmakingSearchEvent` for the user, order by `createdAt DESC`, take the first row. If `type === STARTED` or `MATCHED`, it's active; else return null. Read the STARTED event for rating/startedAt if not already in hand.

**`getMatchState`**: query all `PendingGameEvent` rows for the matchId, ordered by `createdAt`. The PROPOSED event holds the static facts (players, snapshots, search refs). The latest event drives `.status`. Accumulate `confirmedBy` from every `CONFIRMED_BY` event (set of `actingPlayerId`). On `PLAYED`, capture `gameResultId`.

**`getSearchAttempt`**: like `getActiveSearchForUser` but keyed by `attemptId` and not filtered to active.

### Tests (`state.integration.test.ts`)

Per the plan's test list under "state.integration.test.ts". Use `createStartedSearch` and `appendSearchEvent` factories from T2 to set up scenarios. For PendingGame tests, use `appendMatchEvent`.

### Acceptance criteria

- All test cases pass.
- `npm run lint` clean (no `any`, no unused imports).
- No call site outside `state.ts` queries `MatchmakingSearchEvent` or `PendingGameEvent` directly — verified by grep.

---

## T5 — `search.ts` (search lifecycle)

**Status:** pending
**Depends on:** T4
**Blocks:** T8
**Parallel with:** T6, T7

### Context

Writes events for the search lifecycle. `createSearch` is idempotent and uses `SELECT FOR UPDATE` on the user row to prevent races (rare in practice but airtight). `reapAbandonedSearches` is the reaper used by the scheduled tick.

### Read first

- Plan §"Modules > `search.ts`"
- T4's `state.ts` for `getActiveSearchForUser`

### Create

- `src/lib/matchmaking/search.ts`
- `src/lib/matchmaking/search.integration.test.ts`

### Implementation

Exported signatures per the plan. Notes:

- `createSearch` must use `prisma.$transaction` and execute a `SELECT FOR UPDATE` on the user row using `$queryRaw`:
  ```ts
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const active = await getActiveSearchForUser(userId, tx); // pass tx so derivation runs inside the lock
  if (active) return active;
  // insert new STARTED event with cuid() attemptId
  ```
  This requires `state.ts` functions to accept an optional `tx` parameter — add this in T4 if not already done; otherwise add a small read-helper inline.

- `cancelSearch` reads the active state, validates it's not terminal, appends `CANCELLED`. The `attemptId` and `userId` come from the active search.

- `reapAbandonedSearches`: one query to find candidate `attemptId`s where the latest event is `STARTED` and that `STARTED.createdAt < now() - N seconds`. For each, insert an `ABANDONED` event. Bulk insert (one `createMany`) is fine; race with another writer (e.g., the same user starts searching again at the same instant) is acceptable — the latest-event-wins semantics resolve it.

### Tests (`search.integration.test.ts`)

Per the plan. Important specific tests:
- Idempotency of `createSearch` (called twice → one STARTED event, returns same `attemptId`).
- Re-queue after CANCELLED creates a *new* `attemptId`.
- `reapAbandonedSearches` does not touch `MATCHED` attempts.

### Acceptance criteria

- All test cases pass.
- `SELECT FOR UPDATE` lock verified by a concurrency test (two `Promise.all`-ed `createSearch` calls for the same user → exactly one STARTED event after both resolve).

---

## T6 — `matcher.ts`

**Status:** pending
**Depends on:** T3, T4
**Blocks:** T8
**Parallel with:** T5, T7

### Context

Pure read function. Given a search, return a candidate or null. Symmetric tolerance enforced — both sides must accept each other.

### Read first

- Plan §"Modules > `matcher.ts`"
- T3's `tolerance.ts`, T4's `state.ts`

### Create

- `src/lib/matchmaking/matcher.ts`
- `src/lib/matchmaking/matcher.integration.test.ts`

### Implementation

```ts
import { getActiveSearches } from './state';
import { ratingBand } from './tolerance';
import type { DerivedSearchState } from './state';

export async function findMatchFor(
  search: DerivedSearchState,
  now: Date = new Date(),
): Promise<DerivedSearchState | null> {
  const candidates = await getActiveSearches();

  const elapsed = (now.getTime() - search.startedAt.getTime()) / 1000;
  const searcherBand = ratingBand(search.rating, elapsed);

  const eligible = candidates
    .filter(c => c.userId !== search.userId)
    .filter(c => c.rating >= searcherBand.min && c.rating <= searcherBand.max)
    .filter(c => {
      const candidateElapsed = (now.getTime() - c.startedAt.getTime()) / 1000;
      const candidateBand = ratingBand(c.rating, candidateElapsed);
      return search.rating >= candidateBand.min && search.rating <= candidateBand.max;
    })
    .sort((a, b) => {
      const aDelta = Math.abs(a.rating - search.rating);
      const bDelta = Math.abs(b.rating - search.rating);
      if (aDelta !== bDelta) return aDelta - bDelta;
      return a.startedAt.getTime() - b.startedAt.getTime();
    });

  return eligible[0] ?? null;
}
```

### Tests (`matcher.integration.test.ts`)

Per the plan. Use the T2 factory's `createdAt` override to backdate searches for the "wait widens tolerance" cases.

### Acceptance criteria

- All test cases pass.
- No write operations in this module — verified by grep for `prisma.*\.create|update|delete`.

---

## T7 — `pending-game.ts` (match lifecycle)

**Status:** pending
**Depends on:** T4
**Blocks:** T8
**Parallel with:** T5, T6

### Context

The most concurrency-sensitive module. Handles propose / confirm / decline / expire / convert. Read the plan's concurrency contract for `proposePendingGame` carefully — there's a deterministic lock-ordering rule to prevent deadlocks.

### Read first

- Plan §"Modules > `pending-game.ts`" — especially the concurrency contract
- `src/lib/record-game.ts` — existing signature, used by `convertPendingGameToResult`
- T4's `state.ts`

### Create

- `src/lib/matchmaking/pending-game.ts`
- `src/lib/matchmaking/pending-game.integration.test.ts`

### Implementation

Exported signatures and constant per the plan:

```ts
export const PENDING_GAME_CONFIRM_WINDOW_SECONDS = 10;
```

**`proposePendingGame(searchAAttemptId, searchBAttemptId)`**:

1. Inside `prisma.$transaction`:
2. Read both searches' current derived state (using T4 helpers, passing `tx`).
3. Determine the two `userId`s. Lock them in order `min(idA, idB), max(idA, idB)` via two `SELECT … FOR UPDATE` queries.
4. Re-derive state for both searches. Throw if either is no longer `STARTED`.
5. Generate `matchId = cuid()`.
6. Insert one `PendingGameEvent` (type=PROPOSED, all snapshot fields populated).
7. Insert two `MatchmakingSearchEvent` (type=MATCHED, `matchId` set, one per search).
8. Return `getMatchState(matchId)`.

**`confirmPendingGame(matchId, userId)`**:

1. Read `getMatchState(matchId)`. Validate `userId ∈ {playerAId, playerBId}` (else throw).
2. If `userId ∈ matchState.confirmedBy`, return current state (idempotent for double-click).
3. Validate current `status` is `PROPOSED` or `CONFIRMED_BY` (else throw — match is already terminal).
4. Inside transaction:
   - Insert `CONFIRMED_BY` with `actingPlayerId = userId`.
   - Re-read events for the matchId; if now both players have CONFIRMED_BY, also insert `BOTH_CONFIRMED`.
5. Return fresh `getMatchState`.

**`declinePendingGame(matchId, userId)`**:

1. Validate `userId ∈ {playerAId, playerBId}`. Validate status is `PROPOSED` or `CONFIRMED_BY`.
2. Inside transaction:
   - Insert `DECLINED` event on `PendingGameEvent` with `actingPlayerId = userId`.
   - Insert `DECLINED` event on `MatchmakingSearchEvent` for each of the two search attempts.
3. Return fresh `getMatchState`.

**`expireIfStale(matchId, now = new Date())`**:

1. Read `getMatchState(matchId)`. If status is terminal, return null.
2. If `now - proposedAt < PENDING_GAME_CONFIRM_WINDOW_SECONDS * 1000`, return null.
3. Inside transaction:
   - Insert `EXPIRED` event on `PendingGameEvent`.
   - Insert `EXPIRED` event on each of the two search attempts.
4. Return fresh `getMatchState`.

**`convertPendingGameToResult(matchId, reporterUserId, result)`**:

1. Read `getMatchState`. Throw if status is not `BOTH_CONFIRMED`.
2. Validate `reporterUserId ∈ {playerAId, playerBId}`.
3. Inside transaction:
   - Re-read state. Throw if status changed (race).
   - Call `recordGame({ playerAId, playerBId, result })` — note the existing `recordGame` is not transaction-aware. Confirm whether it can be passed a `tx`; if not, accept that the GameResult write is outside this transaction (still safe because the next steps gate on it).
   - Insert `PLAYED` on `PendingGameEvent` with `gameResultId = recordGameResult.gameResult.id`.
   - Insert `CONSUMED` on each search attempt.
4. Return `{ gameResult, matchState: getMatchState(matchId) }`.

**Note on `recordGame` integration**: `src/lib/record-game.ts` currently runs its own `prisma.$transaction`. Composing transactions in Prisma is non-trivial. Pragmatic approach: call `recordGame` first (its own transaction), then run a second transaction for the event writes. Race window is small; if the second transaction fails (network blip), we have an orphaned `GameResult` without a `PLAYED` event — surface this in a known-issues comment in the file. Acceptable for v1.

### Tests (`pending-game.integration.test.ts`)

Per the plan. The concurrent-propose test is important — use `Promise.all` against two `proposePendingGame` calls competing for the same search.

### Acceptance criteria

- All test cases pass.
- Lock-ordering logic verified by a deadlock-stress test (10 concurrent propose attempts crossing the same pair of users → no deadlock, exactly one match created).

---

## T8 — `run-matcher.ts` (orchestration)

**Status:** pending
**Depends on:** T5, T6, T7
**Blocks:** T9, T11

### Context

Glues the modules together. Two entry points: hot path (`runMatcherForSearch`) and tick (`runMatcherPass`).

### Read first

- Plan §"Modules > `run-matcher.ts`"

### Create

- `src/lib/matchmaking/run-matcher.ts`
- `src/lib/matchmaking/run-matcher.integration.test.ts`

### Implementation

```ts
import { getActiveSearches, getSearchAttempt } from './state';
import { findMatchFor } from './matcher';
import { proposePendingGame, expireIfStale } from './pending-game';
import { reapAbandonedSearches } from './search';

const ABANDONED_AFTER_SECONDS = 60 * 5; // 5 minutes

export async function runMatcherForSearch(attemptId: string): Promise<{ matched: boolean }> {
  const search = await getSearchAttempt(attemptId);
  if (!search || search.status !== 'STARTED') return { matched: false };

  const candidate = await findMatchFor(search);
  if (!candidate) return { matched: false };

  try {
    await proposePendingGame(search.attemptId, candidate.attemptId);
    return { matched: true };
  } catch (_) {
    // Race lost — candidate was paired by someone else, or search is no longer STARTED
    return { matched: false };
  }
}

export async function runMatcherPass() {
  const searchesReaped = await reapAbandonedSearches(ABANDONED_AFTER_SECONDS);

  // Expire stale PROPOSED/CONFIRMED_BY matches.
  // Implementation: query PendingGameEvent for matchIds whose latest event is
  // PROPOSED or CONFIRMED_BY and whose PROPOSED.createdAt is older than the
  // window. Call expireIfStale on each. Count successes.
  const pendingGamesExpired = /* ... */ 0;

  // Iterate active searches, attempting matches until a pass produces no new pairs.
  let matchesCreated = 0;
  let progress = true;
  while (progress) {
    progress = false;
    const actives = await getActiveSearches();
    for (const s of actives) {
      const result = await runMatcherForSearch(s.attemptId);
      if (result.matched) {
        matchesCreated++;
        progress = true;
      }
    }
  }

  return { matchesCreated, searchesReaped, pendingGamesExpired };
}
```

Implement the "expire stale matches" query — see plan §"`run-matcher.ts`". One option: extend `state.ts` with a `getStaleMatchIds(staleAfterSeconds)` helper rather than putting raw SQL here.

### Tests (`run-matcher.integration.test.ts`)

Per the plan.

### Acceptance criteria

- All test cases pass.
- `runMatcherPass` is idempotent: calling it twice in a row when nothing's changed returns `{ matchesCreated: 0, searchesReaped: 0, pendingGamesExpired: 0 }` on the second call.

---

## T9 — Server functions in `src/routes/match.tsx`

**Status:** pending
**Depends on:** T8
**Blocks:** T10
**Parallel with:** T11

### Context

Six server functions, all POST, all auth-guarded, all wrapped in `Sentry.startSpan`. They are the *only* boundary between the client and the lib modules. The route file also hosts the UI in T10, but for this task we only need the server functions exported and wired.

### Read first

- CLAUDE.md §"`createServerFn` Pattern" and §"Clerk auth guard (in server functions)"
- CLAUDE.md §"Sentry Instrumentation"
- `src/routes/league.tsx` — `recordGameFn` is the canonical example to mirror

### Create

- `src/routes/match.tsx` (skeleton only at this stage — UI comes in T10)

### Implementation

Top of file: route definition with `ssr: 'data-only'` (like `league.tsx`). No static imports of server-only modules.

For each server function, follow this template (using `startSearchFn` as the example):

```ts
const startSearchFn = createServerFn({ method: 'POST' }).handler(async () => {
  return Sentry.startSpan({ name: 'Matchmaking: start search' }, async () => {
    const secretKey = process.env.CLERK_SECRET_KEY;
    const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
    if (!secretKey || !publishableKey) throw new Error('Missing Clerk env vars');

    const { createClerkClient } = await import('@clerk/backend');
    const { getRequest } = await import('@tanstack/react-start/server');
    const clerk = createClerkClient({ secretKey, publishableKey });
    const auth = await clerk.authenticateRequest(getRequest());
    if (!auth.isSignedIn) throw new Error('Unauthorized');
    const clerkId = auth.toAuth().userId;

    const { prisma } = await import('@/db');
    const dbUser = await prisma.user.findUnique({ where: { clerkId } });
    if (!dbUser) throw new Error('User not found');

    const { createSearch } = await import('@/lib/matchmaking/search');
    const { runMatcherForSearch } = await import('@/lib/matchmaking/run-matcher');

    const search = await createSearch(dbUser.id);
    await runMatcherForSearch(search.attemptId);
    // re-read final state in case the matcher fired
    const { getActiveSearchForUser } = await import('@/lib/matchmaking/state');
    return { search: await getActiveSearchForUser(dbUser.id) };
  });
});
```

Repeat the pattern for the other five (each takes an input validator typed like `recordGameFn`):

| Server fn | Input | Returns |
|---|---|---|
| `startSearchFn` | none | `{ search: DerivedSearchState \| null }` |
| `cancelSearchFn` | none | `{ search: DerivedSearchState }` |
| `pollSearchStatusFn` | none | `{ search: DerivedSearchState \| null, match: DerivedMatchState \| null }` — if search is `MATCHED`, also call `expireIfStale(matchId)` before reading the match state |
| `confirmMatchFn` | `{ matchId: string }` | `{ match: DerivedMatchState }` |
| `declineMatchFn` | `{ matchId: string }` | `{ match: DerivedMatchState }` |
| `recordPendingGameResultFn` | `{ matchId: string; result: 'A' \| 'B' \| 'draw' }` — note: `'A'` means reporter won, `'B'` means opponent won. The handler must map A/B to the actual `playerAId`/`playerBId` of the match. | `{ gameResult, match: DerivedMatchState }` |

For the auth guard helper, consider extracting it to `src/lib/matchmaking/auth.ts` to avoid duplicating the Clerk dance six times — but only if it stays a one-liner at the call sites. Don't over-engineer.

### Acceptance criteria

- All six functions compile.
- Each implements the auth guard.
- Each wraps its body in `Sentry.startSpan`.
- No top-level static imports of `@/db`, `@/lib/matchmaking/*`, `@clerk/backend`, or `@tanstack/react-start/server` in this file.
- `npm run build` passes (this is the canary for accidental static imports — per CLAUDE.md the dev server hides them).

---

## T10 — UI state machine in `src/routes/match.tsx`

**Status:** pending
**Depends on:** T9

### Context

Single page hosting the matchmaking state machine. Drives state from a polling `useQuery`. See plan §"UI" for the state diagram.

### Read first

- Plan §"UI — `src/routes/match.tsx`"
- `src/routes/league.tsx` — for the modal / mutation pattern (loader + invalidate + error display)
- `src/integrations/tanstack-query/root-provider.tsx` — confirms QueryClient is set up

### Modify

- `src/routes/match.tsx` (extend the file from T9)

### Implementation

A single component `MatchPage` rendered by the route. Internally:

- `useUser()` from Clerk for `isSignedIn` gate.
- One `useQuery({ queryKey: ['matchmaking', 'status'], queryFn: () => pollSearchStatusFn(), refetchInterval: 2000, enabled: state !== 'idle' && state !== 'submit-result' })`.
- A `useReducer` (or `useState` + a derive function) mapping `(uiPhase, pollData)` → next UI phase. The phases:
  - `idle`
  - `searching`
  - `match-proposed`
  - `play`
  - `submit-result`
- Mutations (`startSearchFn`, `cancelSearchFn`, `confirmMatchFn`, `declineMatchFn`, `recordPendingGameResultFn`) via `useMutation` from React Query, each calling `queryClient.invalidateQueries(['matchmaking', 'status'])` on success.
- After `recordPendingGameResultFn` succeeds, also call `router.invalidate()` so any open `/league` view picks up the new game.

Use Tailwind for styling, matching the look of `/league`. No new design components — straight markup is fine.

Edge cases the UI must handle:
- `poll.search.status === 'CANCELLED'/'ABANDONED'/'EXPIRED'/'DECLINED'` while in `searching` or `match-proposed` → transition to `idle` with a message indicating *why*.
- `poll.match.status === 'PLAYED'` while in `play` (opponent reported first) → transition to `submit-result` showing the result they entered.
- Error state for any mutation — match the `RecordGameModal` pattern from `league.tsx` (state holds an error message; show it inline; clear on next attempt).

### Acceptance criteria

- Manual test using the e2e script in plan §"Verification" — at least steps 1–8 work in two browser sessions.
- `npm run build` clean.
- `npm run format` no diff.

---

## T11 — Netlify scheduled tick

**Status:** pending
**Depends on:** T8
**Parallel with:** T9

### Context

Periodic backstop for abandonment and stale-match expiry. Minute granularity. No new infra — Netlify supports scheduled functions natively.

### Read first

- Plan §"Scheduled tick"
- Existing `netlify/functions/` directory (may be empty; check) and `netlify.toml` to confirm functions location

### Create

- `netlify/functions/matchmaker-tick.ts`

If the `netlify/functions/` directory doesn't exist, create it. Check whether `netlify.toml` already declares a `[functions]` directory; if not, add one pointing to `netlify/functions`. Confirm Netlify's documented schedule syntax (`schedule: '@every 1m'` or cron string) against the installed `@netlify/functions` version (look at `node_modules/@netlify/functions/package.json` for guidance, or use cron `* * * * *`).

### Implementation

```ts
import type { Config } from '@netlify/functions';

export default async () => {
  const { runMatcherPass } = await import('../../src/lib/matchmaking/run-matcher');
  const result = await runMatcherPass();
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

export const config: Config = {
  schedule: '@every 1m', // OR '* * * * *' depending on what the Netlify version supports
};
```

If `@netlify/functions` is not already a project dependency, add it (`npm install --save-dev @netlify/functions`). Check first — TanStack Start projects on Netlify usually already pull it transitively.

### Acceptance criteria

- File compiles.
- `npm run build` produces a Netlify-deployable bundle (check `dist/.netlify` after build).
- The schedule config is recognised by Netlify (verify by reading the build log; Netlify warns on invalid schedules).
- Functional verification only happens after a Netlify deploy. For local verification, manually invoke `runMatcherPass()` via a test script or a temporary `/api/_admin/run-matcher` route (do NOT ship the admin route — delete before merging).

---

## T12 — End-to-end verification

**Status:** pending
**Depends on:** T10, T11

### Context

Manual e2e walkthrough per plan §"Verification". Final smoke test before opening the PR.

### Steps

Follow plan §"Verification" exactly. Two browser sessions, two test users with similar ratings. Walk through:

1. Migration applied (`prisma migrate status` clean).
2. `npm run dev` running.
3. Happy path: both find a match → confirm → play → record result.
4. `/league` reflects the new game and updated ratings.
5. Each edge case in the plan's "Edge cases to spot-check manually" list:
   - Cancel mid-search
   - Decline a proposed match
   - Close-tab abandonment (~6 minute wait)
   - Confirm-window expiry (one accepts, other waits >10s)
   - Conflicting results (simultaneous submits)
6. Inspect the audit trail in Prisma Studio: open `MatchmakingSearchEvent` filtered by `attemptId`, confirm events read like a story (STARTED → MATCHED → CONSUMED, etc.).

### Final checks

```
npm run format    # no diff
npm run build     # clean
npm run test      # unit tests pass
npm run test:integration   # integration tests pass
```

Document any deviations or surprises in the PR description, not in the codebase. Do NOT create a commit until the user explicitly approves the work (per CLAUDE.md and project memory: plan/task approval ≠ implementation go-ahead is for plans; for tasks, the convention is the same — commit only on explicit request).

---

## Conventions for sub-agents working on this list

- **Branch naming**: per CLAUDE.md, use `feature-4-matchmaking-agent-<short-id>` if spawned in a worktree.
- **Imports**: server-only modules (`@/db`, `@/lib/matchmaking/*`, `@clerk/backend`, `@tanstack/react-start/server`) must be dynamically imported inside `createServerFn` handlers — never statically imported in route files. See CLAUDE.md.
- **Path alias**: `@/*` resolves to `./src/*`.
- **Test discipline**:
  - Every new `src/lib/` function gets a co-located test file.
  - Server-only test files need `// @vitest-environment node` at the top.
  - Mock at module boundaries (`vi.mock('@/db', ...)` for unit tests; integration tests use the real container via `createTestDatabase()`).
- **Pre-commit checklist** (CLAUDE.md):
  - `npm run format`
  - `npm run build`
  - If `package-lock.json` regenerated: `npm ci`
- **Commits**: only when the user explicitly asks. Tasks should leave the working tree ready-for-review but uncommitted, unless the user has authorised commits in advance for the worktree.

# Matchmaking — Feature Plan

## Context

The app currently lets players record completed 1v1 games (`recordGame`) which feeds the Elo ladder shown on `/league`. There is no way for players to *find* an opponent — every recorded game is ad-hoc, arranged out-of-band, and unbalanced pairings rely on social etiquette.

Matchmaking is the missing top half of the game lifecycle: a player declares "I want to play", the system pairs them with someone of similar rating within seconds, and the pair goes off to play. The result is then recorded through the existing `recordGame` path. Two design goals, in priority order:

1. **Match quality** — pair players within a tight rating band.
2. **Match speed** — get pairings done in seconds, not minutes; widen the acceptable rating band as wait time grows.

The existing record-game flow stays untouched alongside this — ad-hoc games remain possible. Matchmaking is an additional, opt-in funnel.

## Locked-in decisions

These are settled. The plan below builds on them.

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | 1v1 only. No team data structures. Refactor for teams later. |
| 2 | Latency | Real-time (seconds). Player sits on a "searching…" screen. |
| 3 | Relationship to `recordGame` | Both flows coexist. Matchmaking creates a parallel path that funnels back into `recordGame` for the final result write. |
| 4 | Matcher trigger | Hybrid — runs synchronously on every new search, AND on a periodic Netlify scheduled tick. |
| 5 | Where pending games live | New `PendingGame` table. `GameResult` keeps its meaning of "completed game only". |
| 6 | Cancel | Player can cancel their own search at any time. |
| 7 | Decline | Either player can decline a proposed match. Both searches end on decline; players must re-queue. |
| 8 | Forward-compat for teams | None. Pure 1v1 in the schema. Team support is a future refactor. |
| 9 | Search audit trail | `MatchmakingSearch` rows are **kept** after they end, with a terminal status. Implies a partial unique index on `userId WHERE status = 'SEARCHING'`. |
| 10 | Stalled PendingGame expiry | Yes — default 10s confirm window, configurable. |
| 11 | Result reporting conflict | First-wins. The second submitter hits `gameResultId @unique` and gets a clean error. |
| 12 | `pollSearchStatusFn` HTTP method | POST (heartbeat-bump is a side effect; POST is correct per CLAUDE.md). |

## Schema changes (`schema.prisma`)

Two new models plus a back-relation on `User` and `GameResult`.

### `MatchmakingSearch`

```prisma
model MatchmakingSearch {
  id           String              @id @default(cuid())
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt

  userId       String
  user         User                @relation(fields: [userId], references: [id])

  rating       Int                                       // snapshot of currentRating at create
  status       MatchmakingSearchStatus @default(SEARCHING)

  // Heartbeat from the client poll. Absence = abandoned tab.
  lastPolledAt DateTime            @default(now())

  pendingGameId String?            @unique
  pendingGame   PendingGame?       @relation("PendingGameSearches", fields: [pendingGameId], references: [id])

  @@index([status, rating])
  @@index([status, lastPolledAt])
  @@index([userId, status])
  // Partial unique index added in raw SQL inside the migration —
  // see migration notes below. Prisma's schema language doesn't
  // type partial uniques, so we hand-edit the generated SQL.
}

enum MatchmakingSearchStatus {
  SEARCHING       // open in the queue
  MATCHED         // paired into a PendingGame, awaiting confirms
  CANCELLED       // player cancelled
  ABANDONED       // cleanup reaper killed it (heartbeat went silent)
  DECLINED        // associated PendingGame was declined by one side
  CONSUMED        // PendingGame was played → GameResult exists
  EXPIRED         // matched but PendingGame confirm window passed
}
```

**Migration hand-edit**: after `prisma migrate dev`, append to the generated `migration.sql`:

```sql
CREATE UNIQUE INDEX "MatchmakingSearch_userId_searching_unique"
  ON "MatchmakingSearch"("userId")
  WHERE status = 'SEARCHING';
```

This is the v1 way to keep terminal rows (decision #9) while still preventing a player from holding two open searches. Application code uses `findFirst({ where: { userId, status: 'SEARCHING' } })` rather than `findUnique`.

### `PendingGame`

```prisma
model PendingGame {
  id          String              @id @default(cuid())
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt

  playerAId   String
  playerBId   String
  playerA     User                @relation("PendingGamePlayerA", fields: [playerAId], references: [id])
  playerB     User                @relation("PendingGamePlayerB", fields: [playerBId], references: [id])

  // Rating snapshot at match time — for display only.
  // The eventual GameResult uses User.currentRating at submit time.
  playerARating Int
  playerBRating Int

  playerAConfirmed Boolean         @default(false)
  playerBConfirmed Boolean         @default(false)

  status      PendingGameStatus   @default(PROPOSED)

  searches    MatchmakingSearch[] @relation("PendingGameSearches")

  gameResultId String?            @unique
  gameResult   GameResult?        @relation(fields: [gameResultId], references: [id])

  @@index([status, createdAt])
  @@index([playerAId, status])
  @@index([playerBId, status])
}

enum PendingGameStatus {
  PROPOSED        // both players seeing "Match found, confirm?"
  CONFIRMED       // both confirmed; awaiting result submission
  DECLINED        // one player declined; terminal
  PLAYED          // result submitted → GameResult exists
  EXPIRED         // confirm window passed without both confirms; terminal
}
```

### Back-relations

```prisma
model User {
  ...
  matchmakingSearches  MatchmakingSearch[]
  pendingGamesAsA      PendingGame[] @relation("PendingGamePlayerA")
  pendingGamesAsB      PendingGame[] @relation("PendingGamePlayerB")
}

model GameResult {
  ...
  pendingGame  PendingGame?    // back-relation from PendingGame.gameResultId
}
```

Migration via the Prisma MCP server. Before deploy, `prisma migrate deploy` against prod (CLAUDE.md Netlify checklist).

## Modules (`src/lib/matchmaking/`)

All server-only. Each gets a co-located `.test.ts` (unit) and/or `.integration.test.ts`.

### `tolerance.ts`

Pure. No I/O. Used by the matcher and by clients computing display state.

```ts
export const TOLERANCE_BASE = 50;
export const TOLERANCE_GROWTH_PER_SEC = 10;
export const TOLERANCE_CAP = 400;

export function toleranceForElapsed(elapsedSeconds: number): number;
export function ratingBand(rating: number, elapsedSeconds: number): { min: number; max: number };
```

Formula: `min(BASE + GROWTH_PER_SEC * elapsed, CAP)`. Starts ±50, grows +10/sec, caps at ±400.

### `search.ts`

`MatchmakingSearch` lifecycle.

```ts
export async function createSearch(userId: string): Promise<MatchmakingSearch>;     // snapshots currentRating; idempotent if a SEARCHING row already exists
export async function cancelSearch(userId: string): Promise<MatchmakingSearch>;     // SEARCHING/MATCHED → CANCELLED; declining propagates separately
export async function recordPoll(userId: string): Promise<MatchmakingSearch | null>; // bumps lastPolledAt on the active row
export async function getActiveSearchForUser(userId: string): Promise<MatchmakingSearch | null>;
export async function listOpenSearches(): Promise<MatchmakingSearch[]>;             // status = SEARCHING
export async function reapAbandoned(staleAfterSeconds: number): Promise<number>;    // SEARCHING → ABANDONED for lastPolledAt < now - N
```

Depends on `@/db`.

### `matcher.ts`

Read-only. Given an active search, return a candidate or `null`.

```ts
export async function findMatchFor(
  search: MatchmakingSearch,
  now?: Date,
): Promise<MatchmakingSearch | null>;
```

Query: `status = SEARCHING`, `userId != search.userId`, `rating` within the *searcher's* tolerance band AND the candidate's *own* band must include `search.rating` (symmetric tolerance), ordered by `|rating - search.rating| ASC, createdAt ASC`, limit 1. Symmetric tolerance is the guard against a long-waiting wide-tolerance search snatching a fresh narrow-tolerance arrival that would prefer a closer pair.

Depends on `@/db`, `./tolerance`.

### `pending-game.ts`

`PendingGame` lifecycle.

```ts
export const PENDING_GAME_CONFIRM_WINDOW_SECONDS = 10;

export async function proposePendingGame(searchAId: string, searchBId: string): Promise<PendingGame>;
export async function confirmPendingGame(pendingGameId: string, userId: string): Promise<PendingGame>;
export async function declinePendingGame(pendingGameId: string, userId: string): Promise<PendingGame>;
export async function expireIfStale(pendingGameId: string, now?: Date): Promise<PendingGame | null>;
export async function convertPendingGameToResult(
  pendingGameId: string,
  reporterUserId: string,
  result: EloResult,
): Promise<GameResult>;
```

**Concurrency contract for `proposePendingGame`** (the most racy spot in the system):

In a single `prisma.$transaction`:
1. `updateMany({ where: { id: searchAId, status: 'SEARCHING' }, data: { status: 'MATCHED', ... } })` — must return `count === 1`, else abort.
2. Same for `searchBId`.
3. `pendingGame.create(...)` with both players and rating snapshots.
4. Update both searches' `pendingGameId` with the freshly-created id.

If either `updateMany` returns `count === 0`, throw and let the transaction roll back. The two callers (hot-path and tick) can both run `proposePendingGame` concurrently; whichever wins the `SEARCHING → MATCHED` race writes the PendingGame, the other throws cleanly.

**Decline** flips PendingGame to `DECLINED` and both searches to `DECLINED`. Per decision #7, both players must re-queue.

**`expireIfStale`** is called inline from the poll handler (`pollSearchStatusFn`) — if `now - createdAt > PENDING_GAME_CONFIRM_WINDOW_SECONDS` and status is `PROPOSED`, flip to `EXPIRED` and flip both searches to `EXPIRED`. This makes expiry feel instant for either online player and doesn't depend on the minute-ly tick.

**`convertPendingGameToResult`** delegates to existing `src/lib/record-game.ts:recordGame` (signature: `{ playerAId, playerBId, result } → { gameResult, ratingChangeA, ratingChangeB }`). In the same transaction, stamp `PendingGame.gameResultId`, flip status to `PLAYED`, flip both searches to `CONSUMED`. Idempotent via `PendingGame.gameResultId @unique` — second submitter throws.

Depends on `@/db`, `./elo`, `./record-game`.

### `run-matcher.ts`

Orchestration. The shared core for the hot path AND the scheduled tick.

```ts
export async function runMatcherForSearch(searchId: string): Promise<{ matched: boolean }>;
export async function runMatcherPass(): Promise<{ matchesCreated: number; searchesReaped: number; pendingGamesExpired: number }>;
```

`runMatcherForSearch` is called from `startSearchFn` immediately after `createSearch` — gives one-round-trip pairing when a candidate is waiting.

`runMatcherPass` is what the Netlify tick calls. Reap abandoned → expire stale PROPOSED PendingGames → loop matching open searches until a pass produces no new pairs.

Depends on `./search`, `./matcher`, `./pending-game`.

## Server functions

All in a new route file `src/routes/match.tsx`. Every handler with side effects:
- Implements the Clerk auth guard pattern from CLAUDE.md.
- Wraps the body in `Sentry.startSpan(...)`.
- Dynamically imports server-only modules inside the handler (never at the top).

| Name | Method | Calls |
|---|---|---|
| `startSearchFn` | POST | `search.createSearch` → `runMatcher.runMatcherForSearch` |
| `cancelSearchFn` | POST | `search.cancelSearch` |
| `pollSearchStatusFn` | POST | `search.recordPoll`, then `pendingGame.expireIfStale` if matched, returns `{ search, pendingGame? }` |
| `confirmMatchFn` | POST | `pending-game.confirmPendingGame` |
| `declineMatchFn` | POST | `pending-game.declinePendingGame` |
| `recordPendingGameResultFn` | POST | `pending-game.convertPendingGameToResult` |

Input validation in the style of `recordGameFn` in `src/routes/league.tsx`. Auth-guarded `userId` flows through every handler — players can only act on their own searches/their own confirms.

## UI — `src/routes/match.tsx`

Auth-gated route, single page hosting a state machine driven by a polling `useQuery`.

```
idle
  └─ "Find a match" → POST startSearchFn → searching

searching                                  (useQuery polling pollSearchStatusFn every 2s)
  ├─ "Cancel" → POST cancelSearchFn → idle
  ├─ poll.search.status = MATCHED → match-proposed
  ├─ poll.search.status = CANCELLED/ABANDONED/EXPIRED → idle (with message)

match-proposed                             (still polling)
  ├─ shows opponent username, rating, ratingDelta, confirm/decline buttons
  ├─ "Accept" → POST confirmMatchFn
  ├─ "Decline" → POST declineMatchFn → idle ("you declined")
  ├─ poll.pendingGame.opponentConfirmed flips → UI updates ("opponent confirmed, waiting on you")
  ├─ poll.pendingGame.status = CONFIRMED → play
  ├─ poll.pendingGame.status = DECLINED → idle ("opponent declined")
  └─ poll.pendingGame.status = EXPIRED → idle ("match expired, opponent didn't confirm")

play
  ├─ "I won" / "Draw" / "Opponent won" → POST recordPendingGameResultFn → submit-result
  └─ poll.pendingGame.status = PLAYED (opponent submitted first) → submit-result

submit-result
  └─ Shows the new GameResult + rating delta. "Find another match" → idle
```

Polling stops when `state ∈ {idle, submit-result}`. The 2s `refetchInterval` is also the heartbeat — every successful poll bumps `lastPolledAt` server-side. Each mutation calls `queryClient.invalidateQueries(['matchmaking', 'status'])` so the UI doesn't wait up to 2s for the next tick. `router.invalidate()` after the final result submission so any open `/league` view picks up the new rating.

## Scheduled tick

`netlify/functions/matchmaker-tick.ts`. Netlify scheduled function, `schedule: '@every 1m'`. Calls `runMatcherPass()`. This is the safety net for:
- Reaping abandoned searches whose heartbeat has gone silent (closed tab).
- Expiring `PROPOSED` PendingGames where both players have walked away (neither is polling, so neither triggers inline `expireIfStale`).
- Re-matching lone searches whose tolerance has widened since the last hot-path attempt.

Minute granularity is acceptable — the *fast* path is the hot-path matcher on `createSearch`, and inline expiry on poll. The tick is the backstop, not the primary mechanism.

## Abandonment detection

The 2s client poll IS the heartbeat. `pollSearchStatusFn` bumps `lastPolledAt` on every call.

```
client polls every 2s   →   server bumps lastPolledAt   →   matchmaking row is "alive"
client closes tab        →   no more bumps               →   lastPolledAt freezes
tick fires every 60s     →   reapAbandoned(15)           →   SEARCHING rows with stale heartbeat → ABANDONED
```

Threshold: 15 seconds (~7 missed polls). Long enough to tolerate network blips and brief tab-hidden moments; short enough that the row is gone before the next tick.

## Tests

Follow `src/test/db.ts` / `src/test/factories/user.ts` / `src/test/scenarios.ts` conventions. Add:

**New test infra**
- Update `src/test/db.ts:reset()` to also delete `MatchmakingSearch` and `PendingGame` (FK-safe order).
- New factory `src/test/factories/matchmaking-search.ts` — `createSearch(prisma, user, overrides?)`.
- New scenario `twoSearchingPlayersAtEqualRating(prisma)`.

**`tolerance.test.ts`** (unit)
- Starts at `TOLERANCE_BASE` at t=0.
- Grows linearly at `TOLERANCE_GROWTH_PER_SEC`.
- Caps at `TOLERANCE_CAP`.

**`search.integration.test.ts`**
- `createSearch` snapshots `currentRating`.
- `createSearch` is idempotent if a SEARCHING row already exists (returns it).
- `createSearch` after a CANCELLED prior search creates a new row (partial unique allows it).
- `recordPoll` bumps `lastPolledAt`.
- `reapAbandoned` only touches `SEARCHING`, never `MATCHED`/`CONSUMED`.
- Cancelling an active search moves status to CANCELLED.

**`matcher.integration.test.ts`**
- Returns null when no other searches exist.
- Pairs two equal-rated fresh searches.
- Does NOT pair players outside base tolerance at t=0 (e.g. 1000 vs 1500).
- Pairs the same two players when wait-time has widened both bands (backdate `createdAt`).
- Prefers the closer-rated candidate when multiple in range.
- Enforces symmetric tolerance (fresh narrow search ignores old wide search outside fresh band).

**`pending-game.integration.test.ts`**
- `proposePendingGame` flips both searches to MATCHED with `pendingGameId` set.
- Concurrent `proposePendingGame` against the same search: only one succeeds, the other throws.
- Confirming one side leaves status `PROPOSED`.
- Confirming both transitions to `CONFIRMED`.
- Decline flips PendingGame to `DECLINED` and both searches to `DECLINED`.
- `expireIfStale` is a no-op before the window elapses.
- `expireIfStale` after the window elapses flips PendingGame → EXPIRED, both searches → EXPIRED.
- `convertPendingGameToResult` creates a `GameResult`, updates user ratings, flips PendingGame → PLAYED, both searches → CONSUMED.
- Second call to `convertPendingGameToResult` for the same id throws (first-wins on `gameResultId @unique`).

**`run-matcher.integration.test.ts`**
- `runMatcherForSearch` returns `{ matched: true }` when a candidate exists.
- `runMatcherForSearch` returns `{ matched: false }` when no candidate exists in tolerance.
- `runMatcherPass` pairs all matchable searches and reaps stale ones in one pass.
- `runMatcherPass` expires stale PROPOSED PendingGames.

## Known limitations & implementation notes

- **Prisma + partial unique**: the `WHERE status = 'SEARCHING'` unique index is added via raw SQL in the migration file. The Prisma client doesn't type-check it; `findUnique({ where: { userId } })` will not work — use `findFirst({ where: { userId, status: 'SEARCHING' } })`. Document this in `search.ts`.
- **Rating snapshot vs current rating**: `PendingGame.playerARating`/`playerBRating` are display-only. The actual rating math runs against `User.currentRating` at submit time inside `recordGame`. If a player completes an ad-hoc record-game between match-time and result-submit, the snapshot will be stale — accepted by design.
- **Result reporting conflict**: first-wins. Second submitter gets an error. Disputed-result UX is deferred.
- **Netlify scheduled function reliability**: minute granularity, may drift under load. Since the hot path handles the common case, this is mostly the abandonment-reaper's cadence. Acceptable.
- **POST cadence**: 2s POST per active user is fine for an internal app. At scale would warrant moving heartbeat to a WebSocket or SSE channel.
- **Confirm window default**: 10s. The constant is `PENDING_GAME_CONFIRM_WINDOW_SECONDS` in `pending-game.ts`. If we later want a UI countdown, the client can read elapsed time off `pendingGame.createdAt` rather than the constant being shipped client-side.
- **No team support in schema**: per decision #1/#8. When teams come, expect a new `PendingGameParticipant` join table and a `mode` field. Existing two-column `playerA/playerB` shape becomes legacy 1v1.

## Critical files to be modified / created

**Modified**
- `schema.prisma` — new models, enums, back-relations
- `src/test/db.ts` — extend `reset()` to clear new tables
- `src/test/scenarios.ts` — add `twoSearchingPlayersAtEqualRating`

**Created**
- `src/lib/matchmaking/tolerance.ts` + `tolerance.test.ts`
- `src/lib/matchmaking/search.ts` + `search.integration.test.ts`
- `src/lib/matchmaking/matcher.ts` + `matcher.integration.test.ts`
- `src/lib/matchmaking/pending-game.ts` + `pending-game.integration.test.ts`
- `src/lib/matchmaking/run-matcher.ts` + `run-matcher.integration.test.ts`
- `src/routes/match.tsx` — UI + server functions
- `src/test/factories/matchmaking-search.ts`
- `netlify/functions/matchmaker-tick.ts`
- `prisma/migrations/<ts>_add_matchmaking/migration.sql` — hand-edited to add partial unique index

## Verification

End-to-end (manual, two browser sessions):
1. Run `npm run db:migrate` (via Prisma MCP) to apply the new schema. Confirm `prisma migrate status` is clean.
2. Run `npm run dev`.
3. Sign in as User A in browser 1. Navigate to `/match`. Click "Find a match". Confirm "Searching…" screen.
4. Sign in as User B in browser 2 (similar rating). Navigate to `/match`. Click "Find a match".
5. Both browsers should transition to "Match found, confirm?" within 2s.
6. Both click "Accept". Both transition to "Play" screen.
7. One browser submits "I won". Both transition to "Result recorded" with rating deltas.
8. Open `/league` in a third tab — confirm the new game appears and ratings updated.

Edge cases to spot-check manually:
- Cancel mid-search → return to idle.
- Decline → return to idle with appropriate message.
- Close the tab on the "searching" screen, wait ~75 seconds, reload `/match` — search should no longer be active.
- Two browsers, one accepts, the other waits >10s → both see "match expired".
- Two browsers report conflicting results simultaneously — one succeeds, the other gets a clean error.

Automated:
- `npm run test` — all unit tests pass.
- `npm run test:integration` — all new integration tests pass.
- `npm run build` — clean Vite/Prisma build (per CLAUDE.md pre-commit checklist).
- `npm run format` — no diff.

## Out of scope (future)

- Team queues (1vN, NvN)
- Disputed result UX
- Confirm-window countdown shown to the player
- Push notifications instead of polling
- Per-player "do not match" exclusions (e.g. for declined opponents)
- Matchmaking history page (admin-only view of `MatchmakingSearch` audit rows)

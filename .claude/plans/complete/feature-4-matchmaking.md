# Matchmaking — Feature Plan

## Context

The app currently lets players record completed 1v1 games (`recordGame`), which feeds the Elo ladder shown on `/league`. There is no way for players to *find* an opponent — every recorded game is ad-hoc, arranged out-of-band, and unbalanced pairings rely on social etiquette.

Matchmaking is the missing top half of the game lifecycle: a player declares "I want to play", the system pairs them with someone of similar rating within seconds, and the pair goes off to play. The result is then recorded through the existing `recordGame` path. Two design goals, in priority order:

1. **Match quality** — pair players within a tight rating band.
2. **Match speed** — pair within seconds; widen the acceptable rating band as wait time grows.

The existing record-game flow stays untouched alongside this — ad-hoc games remain possible. Matchmaking is an additional, opt-in funnel.

This feature is **foundational** for the application's long-term direction, so the data model is shaped for correctness and observability over implementation speed. Specifically, matchmaking state is **event-sourced**: every state transition is a new append-only row in an event table; "current state" is derived from the latest event for an attempt. This gets us an audit trail for free, eliminates the partial-unique-index / Prisma-schema-divergence problem, and matches the natural shape of matchmaking ("a sequence of things that happened to a search attempt").

## Locked-in decisions

These are settled. The plan below builds on them.

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | 1v1 only. No team data structures. Refactor for teams later. |
| 2 | Latency | Real-time (seconds). Player sits on a "searching…" screen. |
| 3 | Relationship to `recordGame` | Both flows coexist. Matchmaking creates a parallel path that funnels back into `recordGame` for the final result write. |
| 4 | Matcher trigger | Hybrid — runs synchronously on every new search, AND on a periodic Netlify scheduled tick. |
| 5 | Where pending games live | A `PendingGameEvent` event stream. `GameResult` keeps its meaning of "completed game only". |
| 6 | Cancel | Player can cancel their own search at any time (appends `CANCELLED` event). |
| 7 | Decline | Either player can decline a proposed match (appends `DECLINED` event for the match AND both searches). Both players must re-queue. |
| 8 | Forward-compat for teams | None. Pure 1v1 in the schema. Team support is a future refactor. |
| 9 | Audit model | **Event-sourced.** Every state transition is an append-only row. Current state is derived from the latest event for an attempt. No `@unique` constraints on lifecycle state. |
| 10 | Stalled PendingGame expiry | Yes — default 10s confirm window, configurable. Inline expiry on poll; tick as backstop. |
| 11 | Result reporting conflict | First-wins. Second submitter's transaction fails because the match's latest event is `PLAYED`. |
| 12 | `pollSearchStatusFn` HTTP method | POST. Heartbeats are *reads*, not events — but POST avoids accidental triggering by router preloading and gives us a clean place to inline-expire stale `PROPOSED` matches as a side effect. |
| 13 | Uniqueness enforcement | Application-layer inside a transaction with `SELECT FOR UPDATE` on the user row. No DB-level "one active attempt per user" constraint. The race window for a single user is tiny in practice. |
| 14 | Heartbeat tracking | None. Polls are pull-only ("has a match been found?"), not push assertions ("I'm still here"). Abandonment is detected by the reaper finding long-stale `STARTED`-only attempts. |
| 15 | Abandonment window | ~5 minutes. The minute-ly tick reaps `STARTED` attempts older than this and writes `ABANDONED` events. The "matched-with-a-ghost" case is handled in 10s by the PendingGame expiry pathway, so the longer abandonment window only matters for never-paired searches. |

## Schema changes (`schema.prisma`)

Two new event tables. Both append-only. No `@unique` constraints. No partial indices. Fully expressible in Prisma.

### `MatchmakingSearchEvent`

Each row is one transition in the lifecycle of a single search attempt. Rows for the same attempt share an `attemptId`. The latest event for an `attemptId` (ordered by `createdAt DESC`) IS the current state.

```prisma
model MatchmakingSearchEvent {
  id          String                       @id @default(cuid())
  // Groups events for a single search attempt. Shared across all the
  // STARTED/MATCHED/CONSUMED/etc rows produced for one attempt.
  attemptId   String
  userId      String
  user        User                         @relation(fields: [userId], references: [id])
  type        MatchmakingSearchEventType

  // Set on STARTED — rating snapshot at search create. Null on subsequent
  // events for the same attempt (read from STARTED if needed).
  rating      Int?

  // Set on MATCHED — references the PendingGameEvent.matchId for the
  // proposal this search was paired into.
  matchId     String?

  createdAt   DateTime                     @default(now())

  @@index([attemptId, createdAt])         // latest-event-per-attempt scans
  @@index([userId, createdAt])            // "what is this user currently doing?"
  @@index([type, createdAt])              // reaper / analytics queries
}

enum MatchmakingSearchEventType {
  STARTED       // player entered the queue
  MATCHED       // matcher paired this attempt into a PendingGame (matchId set)
  CANCELLED     // player cancelled their own search
  ABANDONED     // reaper swept a stale STARTED-only attempt
  DECLINED      // associated match was declined by one side
  EXPIRED       // associated match expired (didn't confirm in time)
  CONSUMED      // associated match was played → GameResult exists
}
```

### `PendingGameEvent`

Each row is one transition in the lifecycle of a single match proposal. Rows share a `matchId`.

```prisma
model PendingGameEvent {
  id                 String              @id @default(cuid())
  // Groups events for a single match proposal.
  matchId            String
  type               PendingGameEventType

  // Set on PROPOSED — the static facts about the pairing.
  playerAId          String?
  playerBId          String?
  // Display-only rating snapshots at match time. The actual rating math
  // runs against User.currentRating at submit time inside recordGame.
  playerARating      Int?
  playerBRating      Int?
  // Cross-references back into MatchmakingSearchEvent.attemptId for the
  // two searches that produced this proposal.
  searchAAttemptId   String?
  searchBAttemptId   String?

  // Set on CONFIRMED_BY and DECLINED — which player took the action.
  actingPlayerId     String?

  // Set on PLAYED — the GameResult this match was recorded as.
  gameResultId       String?

  createdAt          DateTime            @default(now())

  @@index([matchId, createdAt])
  @@index([type, createdAt])
}

enum PendingGameEventType {
  PROPOSED          // matcher paired two searches; players see "match found, confirm?"
  CONFIRMED_BY      // one side confirmed (actingPlayerId identifies which)
  BOTH_CONFIRMED    // synthesised transition event, fired when the second CONFIRMED_BY lands
  DECLINED          // one player declined; terminal
  EXPIRED           // confirm window passed; terminal
  PLAYED            // result submitted → GameResult exists; terminal
}
```

**Why `BOTH_CONFIRMED` is its own event** (not derived from "two CONFIRMED_BY events exist"): the polling client just reads the latest event and dispatches UI state from `type`. No event-count logic in the client. Easy to drop later if it stops earning its keep.

**Why `POLLED` is not an event**: heartbeats are read-only queries, not state transitions. Per decision #14, we don't track liveness — abandonment is a long-window reaper concern, not a fast-feedback signal.

### Back-relations

```prisma
model User {
  ...
  matchmakingSearchEvents  MatchmakingSearchEvent[]
}
```

No back-relation from `GameResult` to `PendingGameEvent` — the link is one-way via `PendingGameEvent.gameResultId` (a plain string ref, not an FK relation in Prisma, to keep `GameResult` independent of matchmaking concerns). The ad-hoc record-game path produces `GameResult` rows with no `PendingGameEvent` referencing them, and that's fine.

Migration via the Prisma MCP server. Before deploy, `prisma migrate deploy` against prod (CLAUDE.md Netlify checklist).

## Modules (`src/lib/matchmaking/`)

All server-only. Each gets a co-located `.test.ts` (unit) and/or `.integration.test.ts`.

### `tolerance.ts`

Pure. No I/O. Used by the matcher and by clients displaying the current band.

```ts
export const TOLERANCE_BASE = 50;
export const TOLERANCE_GROWTH_PER_SEC = 10;
export const TOLERANCE_CAP = 400;

export function toleranceForElapsed(elapsedSeconds: number): number;
export function ratingBand(rating: number, elapsedSeconds: number): { min: number; max: number };
```

Formula: `min(BASE + GROWTH_PER_SEC * elapsed, CAP)`. Starts ±50, grows +10/sec, caps at ±400.

### `state.ts`

Centralises the "latest event → derived current state" logic. All other modules go through this. This is where the `DISTINCT ON` queries live.

```ts
export interface DerivedSearchState {
  attemptId: string;
  userId: string;
  rating: number;                              // from the STARTED event
  startedAt: Date;                              // STARTED.createdAt
  status: MatchmakingSearchEventType;          // type of the latest event
  matchId: string | null;                       // if MATCHED, the proposal id
  latestEventAt: Date;
}

export interface DerivedMatchState {
  matchId: string;
  playerAId: string;
  playerBId: string;
  playerARating: number;
  playerBRating: number;
  searchAAttemptId: string;
  searchBAttemptId: string;
  proposedAt: Date;
  status: PendingGameEventType;
  confirmedBy: Set<string>;                     // playerIds who have CONFIRMED_BY
  gameResultId: string | null;
  latestEventAt: Date;
}

export async function getActiveSearchForUser(userId: string): Promise<DerivedSearchState | null>;
export async function getActiveSearches(): Promise<DerivedSearchState[]>;        // status = STARTED
export async function getMatchState(matchId: string): Promise<DerivedMatchState | null>;
export async function getSearchAttempt(attemptId: string): Promise<DerivedSearchState | null>;
```

`getActiveSearches` is the matcher's hot query:

```sql
SELECT DISTINCT ON ("attemptId") *
FROM "MatchmakingSearchEvent"
ORDER BY "attemptId", "createdAt" DESC
```

…then filter the result to `type = 'STARTED'`. Backed by index `(attemptId, createdAt DESC)`. Encapsulated here so the matcher itself stays clean.

Depends on `@/db`.

### `search.ts`

Search-attempt lifecycle. All writes append events.

```ts
export async function createSearch(userId: string): Promise<DerivedSearchState>;
// Idempotent for tab-refresh / multi-tab: if the user already has an active
// STARTED attempt, return that state without writing a new event.
// Transactional with SELECT FOR UPDATE on the user row to prevent races.

export async function cancelSearch(userId: string): Promise<DerivedSearchState>;
// Appends CANCELLED. Throws if the user has no active attempt or it's already terminal.

export async function reapAbandonedSearches(staleAfterSeconds: number): Promise<number>;
// Finds attemptIds where latest event is STARTED and STARTED.createdAt < now - N.
// Appends ABANDONED events for each. Returns count reaped.
```

`createSearch` snapshots `user.currentRating` into the STARTED event's `rating` field.

Depends on `@/db`, `./state`.

### `matcher.ts`

Read-only. Given a search's derived state, return a candidate counterpart or `null`.

```ts
export async function findMatchFor(
  search: DerivedSearchState,
  now?: Date,
): Promise<DerivedSearchState | null>;
```

Algorithm:
1. Fetch `getActiveSearches()`.
2. Filter to other users with rating within the **searcher's** tolerance band (computed from elapsed since `search.startedAt`).
3. Further filter to candidates whose **own** band (computed from elapsed since their `startedAt`) includes `search.rating`. This symmetric-tolerance check prevents a long-waiting wide-tolerance search from snatching a fresh narrow-tolerance arrival that would prefer a closer pair.
4. Order by `abs(rating - search.rating) ASC, startedAt ASC`; return the first.

Depends on `./state`, `./tolerance`.

### `pending-game.ts`

Pending-match lifecycle. All writes append events. The most concurrency-sensitive module.

```ts
export const PENDING_GAME_CONFIRM_WINDOW_SECONDS = 10;

export async function proposePendingGame(
  searchAAttemptId: string,
  searchBAttemptId: string,
): Promise<DerivedMatchState>;

export async function confirmPendingGame(
  matchId: string,
  userId: string,
): Promise<DerivedMatchState>;

export async function declinePendingGame(
  matchId: string,
  userId: string,
): Promise<DerivedMatchState>;

export async function expireIfStale(matchId: string, now?: Date): Promise<DerivedMatchState | null>;

export async function convertPendingGameToResult(
  matchId: string,
  reporterUserId: string,
  result: EloResult,
): Promise<{ gameResult: GameResult; matchState: DerivedMatchState }>;
```

**Concurrency contract for `proposePendingGame`** (the racy spot):

In a single `prisma.$transaction`:
1. `SELECT FOR UPDATE` the two `User` rows (lock acquired in a deterministic order — e.g. lower user id first — to avoid deadlocks).
2. Re-derive the latest event for each search attempt. Both must be `STARTED`, else throw.
3. Generate a fresh `matchId`.
4. Insert one `PROPOSED` event in `PendingGameEvent`.
5. Insert one `MATCHED` event for each search in `MatchmakingSearchEvent`, both referencing the new `matchId`.

If either search has progressed beyond `STARTED` (between the matcher's read and this transaction's write), the proposal is abandoned cleanly inside the transaction's rollback. The two callers of the matcher (hot path + tick) can run concurrently; whichever wins the lock proposes the match, the other discovers its candidate is no longer available and tries a different one (or returns null for that pass).

**`confirmPendingGame`**: appends `CONFIRMED_BY` with `actingPlayerId = userId`. Inside the same transaction, count `CONFIRMED_BY` events for this `matchId`; if both players are represented, also append `BOTH_CONFIRMED`. Validates `userId ∈ {playerAId, playerBId}` from the `PROPOSED` event. Idempotent for double-clicks — if the same user already has a `CONFIRMED_BY` event, no-op.

**`declinePendingGame`**: appends `DECLINED` for the match (with `actingPlayerId = userId`), then appends `DECLINED` for both searches. Per decision #7, both players must re-queue.

**`expireIfStale`**: if the latest event for `matchId` is `PROPOSED` or `CONFIRMED_BY` and `now - PROPOSED.createdAt > PENDING_GAME_CONFIRM_WINDOW_SECONDS`, append `EXPIRED` for the match AND `EXPIRED` for both searches. Returns the resulting state, or `null` if not stale.

**`convertPendingGameToResult`**: requires the latest match event is `BOTH_CONFIRMED`. Inside a transaction:
1. Delegate to existing `src/lib/record-game.ts:recordGame` (signature: `{ playerAId, playerBId, result } → { gameResult, ratingChangeA, ratingChangeB }`).
2. Append `PLAYED` to `PendingGameEvent` with `gameResultId` set.
3. Append `CONSUMED` to each search.

First-wins on reporting conflict: re-derived state must be `BOTH_CONFIRMED`; if the latest event is already `PLAYED`, the second submitter throws cleanly.

Depends on `@/db`, `./state`, `./record-game` (existing `src/lib/record-game.ts`).

### `run-matcher.ts`

Orchestration. Shared by the hot path and the scheduled tick.

```ts
export async function runMatcherForSearch(attemptId: string): Promise<{ matched: boolean }>;
export async function runMatcherPass(): Promise<{ matchesCreated: number; searchesReaped: number; pendingGamesExpired: number }>;
```

`runMatcherForSearch` is called from `startSearchFn` immediately after `createSearch` — gives one-round-trip pairing when a candidate is waiting.

`runMatcherPass` is what the Netlify tick calls:
1. `reapAbandonedSearches(staleAfterSeconds = 300)` — appends `ABANDONED` events for `STARTED` attempts older than 5 minutes.
2. For each `PROPOSED`/`CONFIRMED_BY` match older than `PENDING_GAME_CONFIRM_WINDOW_SECONDS`, call `expireIfStale`.
3. Loop over `getActiveSearches()` trying `findMatchFor` + `proposePendingGame` until a pass produces no new matches.

Depends on `./search`, `./matcher`, `./pending-game`, `./state`.

## Server functions

All in a new route file `src/routes/match.tsx`. Every handler with side effects:
- Implements the Clerk auth guard pattern from CLAUDE.md.
- Wraps the body in `Sentry.startSpan(...)`.
- Dynamically imports server-only modules inside the handler (never at the top).

| Name | Method | Calls |
|---|---|---|
| `startSearchFn` | POST | `search.createSearch` → `runMatcher.runMatcherForSearch` |
| `cancelSearchFn` | POST | `search.cancelSearch` |
| `pollSearchStatusFn` | POST | `state.getActiveSearchForUser`; if status is `MATCHED`, then `pending-game.expireIfStale(matchId)` then re-read |
| `confirmMatchFn` | POST | `pending-game.confirmPendingGame` |
| `declineMatchFn` | POST | `pending-game.declinePendingGame` |
| `recordPendingGameResultFn` | POST | `pending-game.convertPendingGameToResult` |

`pollSearchStatusFn` returns `{ search: DerivedSearchState | null, match: DerivedMatchState | null }`. The client renders state from these two pieces.

Input validation in the style of `recordGameFn` in `src/routes/league.tsx`. Auth-guarded `userId` flows through every handler — players can only act on their own attempts/their own confirms.

## UI — `src/routes/match.tsx`

Auth-gated route, single page hosting a state machine driven by a polling `useQuery`.

```
idle
  └─ "Find a match" → POST startSearchFn → searching

searching                                  (polling pollSearchStatusFn every 2s)
  ├─ "Cancel" → POST cancelSearchFn → idle
  ├─ poll.search.status = MATCHED → match-proposed
  ├─ poll.search.status = CANCELLED/ABANDONED/EXPIRED → idle (with message)

match-proposed                             (still polling)
  ├─ shows opponent username, rating, ratingDelta, confirm/decline buttons
  ├─ "Accept" → POST confirmMatchFn
  ├─ "Decline" → POST declineMatchFn → idle ("you declined")
  ├─ poll.match.confirmedBy gains opponent → UI updates ("opponent confirmed, waiting on you")
  ├─ poll.match.status = BOTH_CONFIRMED → play
  ├─ poll.match.status = DECLINED → idle ("opponent declined")
  └─ poll.match.status = EXPIRED → idle ("match expired, opponent didn't confirm")

play
  ├─ "I won" / "Draw" / "Opponent won" → POST recordPendingGameResultFn → submit-result
  └─ poll.match.status = PLAYED (opponent submitted first) → submit-result

submit-result
  └─ Shows the new GameResult + rating delta. "Find another match" → idle
```

Polling stops when `state ∈ {idle, submit-result}`. The `useQuery` is configured `refetchInterval: 2000`. Each mutation calls `queryClient.invalidateQueries(['matchmaking', 'status'])` so the UI doesn't wait up to 2s for the next tick. `router.invalidate()` after the final result submission so any open `/league` view picks up the new rating.

The UI never reads events directly. It receives `DerivedSearchState` and `DerivedMatchState` from `pollSearchStatusFn` and dispatches on `.status` and `.confirmedBy`. The event-sourced backend is invisible to the client.

## Scheduled tick

`netlify/functions/matchmaker-tick.ts`. Netlify scheduled function, `schedule: '@every 1m'`. Calls `runMatcherPass()`. This is the safety net for:
- Reaping abandoned searches (`STARTED` events older than 5 minutes with no subsequent events).
- Expiring `PROPOSED`/`CONFIRMED_BY` matches where both players have walked away (neither is polling, so neither triggers inline `expireIfStale`).
- Re-matching lone searches whose tolerance has widened since the last hot-path attempt.

Minute granularity is acceptable — the *fast* paths are the hot-path matcher on `createSearch` and inline expiry on poll. The tick is the backstop.

## Abandonment detection

No heartbeats. Polls are read-only ("has a match been found?"), not push assertions ("I'm still here"). Abandonment is detected by absence of progress in the event log:

```
T=0    player opens /match, clicks "Find a match"
       → STARTED event written
T=0-N  no other player joins
       polls return { status: STARTED }
T=5    player closes tab
       polls stop. No more events for this attemptId.
T=300  reaper runs (any 1-min tick after the 5-min threshold)
       → ABANDONED event written
```

The "matched-with-a-ghost" case is faster: if a phantom player gets paired with an active player, the active player's polls trigger `expireIfStale` after 10s and an `EXPIRED` event resolves both sides.

The trade-off vs. fast heartbeat-based detection: a never-paired closed-tab search lingers in the queue for up to ~5 minutes. During that window, the matcher may pair it with an active player, who then has to wait 10s and re-queue. Acceptable for the audit-purity win, given internal-app traffic levels.

## Tests

Follow `src/test/db.ts` / `src/test/factories/user.ts` / `src/test/scenarios.ts` conventions. Add:

### New test infra
- Update `src/test/db.ts:reset()` to delete `MatchmakingSearchEvent` and `PendingGameEvent`.
- New factory `src/test/factories/matchmaking-events.ts`:
  - `createStartedSearch(prisma, user, overrides?)` — appends a STARTED event, returns `{ attemptId, event }`.
  - `appendSearchEvent(prisma, attemptId, type, overrides?)` — for setting up arbitrary state in tests.
- New scenario `twoSearchingPlayersAtEqualRating(prisma)` in `src/test/scenarios.ts`.

### `tolerance.test.ts` (unit)
- Starts at `TOLERANCE_BASE` at t=0.
- Grows linearly at `TOLERANCE_GROWTH_PER_SEC`.
- Caps at `TOLERANCE_CAP`.

### `state.integration.test.ts`
- `getActiveSearchForUser` returns `null` when the user has no events.
- Returns the STARTED state when the user has only a STARTED event.
- Returns the latest event when the user has multiple events for one attempt.
- Returns `null` (no active attempt) when the latest event is terminal.
- After re-queueing (terminal → new STARTED with a new attemptId), returns the new attempt.
- `getActiveSearches` excludes attempts whose latest event is terminal.
- `getMatchState` correctly accumulates `confirmedBy` from multiple `CONFIRMED_BY` events.

### `search.integration.test.ts`
- `createSearch` writes a STARTED event with the user's current rating snapshot.
- `createSearch` is idempotent: if a STARTED attempt already exists, returns it without writing a new event.
- `createSearch` after a CANCELLED previous attempt creates a NEW attempt with a fresh `attemptId`.
- `cancelSearch` appends a CANCELLED event referencing the active attempt.
- `reapAbandonedSearches(300)` writes ABANDONED for STARTED attempts older than 5 minutes, no-ops for fresh ones.
- `reapAbandonedSearches` does NOT touch attempts that have progressed past STARTED (e.g. MATCHED).

### `matcher.integration.test.ts`
- Returns `null` when no other searches exist.
- Pairs two equal-rated fresh searches.
- Does NOT pair players outside base tolerance at t=0 (e.g. 1000 vs 1500).
- Pairs the same two players when both have waited long enough to widen (backdate `STARTED.createdAt`).
- Prefers the closer-rated candidate when multiple are in range.
- Enforces symmetric tolerance (fresh narrow search ignores old wide search outside fresh band).

### `pending-game.integration.test.ts`
- `proposePendingGame` writes one PROPOSED, two MATCHED events; cross-references match correctly.
- Concurrent `proposePendingGame` against the same search: only one succeeds; the other throws because the search's latest event is no longer STARTED.
- `confirmPendingGame` writes CONFIRMED_BY; a second confirm by the same user is a no-op (idempotent for double-click).
- After both players' CONFIRMED_BY, `confirmPendingGame` also writes BOTH_CONFIRMED.
- `declinePendingGame` writes DECLINED for the match AND for both searches.
- `expireIfStale` before the window: no-op, returns the current state.
- `expireIfStale` after the window: writes EXPIRED for the match AND for both searches.
- `convertPendingGameToResult` requires BOTH_CONFIRMED; throws otherwise.
- `convertPendingGameToResult` creates a GameResult, writes PLAYED with `gameResultId`, writes CONSUMED for both searches.
- Second `convertPendingGameToResult` call for the same matchId throws (latest event is PLAYED, not BOTH_CONFIRMED).

### `run-matcher.integration.test.ts`
- `runMatcherForSearch` returns `{ matched: true }` when a candidate exists.
- `runMatcherForSearch` returns `{ matched: false }` when no candidate exists in tolerance.
- `runMatcherPass` pairs all matchable searches, reaps stale STARTED-only attempts, and expires stale PROPOSED matches in one pass.

## Known limitations & implementation notes

- **Event-sourced model is internal**: the client-facing types (`DerivedSearchState`, `DerivedMatchState`) hide the events. The UI never reads events directly. This keeps the abstraction contained.
- **Rating snapshot vs current rating**: `PendingGameEvent.playerARating`/`playerBRating` are display-only. The actual rating math runs against `User.currentRating` at submit time inside `recordGame`. If a player completes an ad-hoc record-game between match-time and result-submit, the snapshot is stale — accepted by design.
- **Result reporting conflict**: first-wins. Re-derived state at convert time must be `BOTH_CONFIRMED`; if it's already `PLAYED`, the second submitter throws. Disputed-result UX is deferred.
- **Netlify scheduled function reliability**: minute granularity, may drift under load. The hot path handles the common case; the tick is mostly the abandonment reaper. Acceptable.
- **POST cadence**: 2s POST per active user. Fine for an internal app. At scale would warrant moving the read to SSE / WebSocket.
- **Confirm window default**: 10s. The constant is `PENDING_GAME_CONFIRM_WINDOW_SECONDS` in `pending-game.ts`. If we later want a UI countdown, the client can read elapsed time off `match.proposedAt` rather than the constant being shipped client-side.
- **No team support in schema**: per decision #1/#8. When teams come, expect a `participants` shape on `PendingGameEvent` (and possibly a `mode` field). The current two-column `playerA/playerB` shape becomes a 1v1 special case.
- **Synthesised `BOTH_CONFIRMED` event**: not strictly required (could be derived from two `CONFIRMED_BY` events). Kept for UI simplicity — the client dispatches off `.status` alone. If it becomes inconvenient later, reduce to derived state.
- **`SELECT FOR UPDATE` on user rows in `proposePendingGame`**: locks are acquired in deterministic order (lower user id first) to prevent deadlocks. Worth a concurrency integration test that simulates the race.
- **Reaper window is 5 minutes, not 15 seconds**: per decision #14/#15. A closed-tab search lingers up to ~5 minutes. Tunable via the constant in `run-matcher.ts`.

## Critical files to be modified / created

**Modified**
- `schema.prisma` — new event models, enums, back-relation on `User`
- `src/test/db.ts` — extend `reset()` to clear `MatchmakingSearchEvent` and `PendingGameEvent`
- `src/test/scenarios.ts` — add `twoSearchingPlayersAtEqualRating`

**Created**
- `src/lib/matchmaking/tolerance.ts` + `tolerance.test.ts`
- `src/lib/matchmaking/state.ts` + `state.integration.test.ts`
- `src/lib/matchmaking/search.ts` + `search.integration.test.ts`
- `src/lib/matchmaking/matcher.ts` + `matcher.integration.test.ts`
- `src/lib/matchmaking/pending-game.ts` + `pending-game.integration.test.ts`
- `src/lib/matchmaking/run-matcher.ts` + `run-matcher.integration.test.ts`
- `src/routes/match.tsx` — UI + server functions
- `src/test/factories/matchmaking-events.ts`
- `netlify/functions/matchmaker-tick.ts`

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
- Cancel mid-search → return to idle. Inspect DB: STARTED then CANCELLED events for the attempt.
- Decline → return to idle. Inspect DB: PROPOSED, MATCHED×2, DECLINED, DECLINED×2 events.
- Close the tab on the "searching" screen, wait ~6 minutes, reload `/match` — search no longer active; DB shows ABANDONED event.
- Two browsers, one accepts, the other waits >10s → both see "match expired"; DB shows EXPIRED events for the match and both searches.
- Two browsers report conflicting results simultaneously — one succeeds, the other gets a clean error. Only one PLAYED event in the DB.

Inspect the audit trail: `SELECT * FROM "MatchmakingSearchEvent" WHERE "attemptId" = ... ORDER BY "createdAt"` should read like a story for any attempt.

Automated:
- `npm run test` — all unit tests pass.
- `npm run test:integration` — all new integration tests pass.
- `npm run build` — clean Vite/Prisma build (per CLAUDE.md pre-commit checklist).
- `npm run format` — no diff.

## Out of scope (future)

- Team queues (1vN, NvN)
- Disputed result UX
- Confirm-window countdown shown to the player
- Push notifications / SSE / WebSockets instead of polling
- Per-player "do not match" exclusions (e.g. for declined opponents)
- Matchmaking history / admin dashboard built on the event log
- Aggregated metrics derived from the event log (median match time, decline rates, abandonment rates)

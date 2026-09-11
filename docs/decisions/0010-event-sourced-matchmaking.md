# 0010. Matchmaking state is event-sourced; clients poll

- **Status:** Accepted
- **Date:** 2026-05-14
- **Source:** `.claude/plans/complete/feature-4-matchmaking.md`

## Context

Matchmaking takes a player from "I want to play" to a recorded result:
search, pair, confirm, play, report. It was treated as foundational, so the
model favours correctness and observability over speed of implementation.

## Decision

- **Append-only events.**
  - `MatchmakingSearchEvent` rows share an `attemptId`, and
    `PendingGameEvent` rows share a `matchId`.
  - An attempt's or match's current state is its latest event.
  - All derivation lives in `src/lib/matchmaking/state.ts`. Clients receive
    derived state and never see events.
- **No database constraints on lifecycle state.**
  - "One active search per user" is enforced in application code, inside a
    transaction with `SELECT … FOR UPDATE` on the user row.
  - Proposing a match locks both users in a fixed order to avoid
    deadlocks.
- **`GameResult` means a completed game only.** Pending matches exist only
  in the event stream. `PendingGameEvent.gameResultId` is a plain reference,
  so `GameResult` stays independent of matchmaking.
- **The matcher runs in two places:** on every new search, and on a
  one-minute Netlify scheduled tick. The tick reaps searches abandoned for
  5 minutes, expires stale proposals, and re-tries searches whose tolerance
  has widened.
- **Rating tolerance** starts at ±50, grows 10 per second, and caps at ±400.
  It is symmetric: each player's band must contain the other's rating.
- **Confirming a match:** a 10-second window, expired as a side effect of
  polling. A decline sends both players back to the queue.
- **Reporting a result:** the first report wins; the second fails cleanly.
- **Clients poll.** No heartbeats and no push.

## Consequences

- Every attempt has a full audit trail, with no partial unique indexes.
- **Biggest known scaling risk:** `getActiveSearches` and
  `getActiveMatches` scan the whole event log with `DISTINCT ON`. Their cost
  grows with total events, not active searches. A projection table or a
  query over only recent events is the tracked fix.
- Polling costs a request every few seconds per active player. Realtime
  delivery is a follow-up.
- `convertPendingGameToResult` calls `recordGame` and then appends events
  in a separate transaction. If the second step fails, a recorded game is
  left orphaned. This is known and documented in the code.
- A match proposal is two players (`playerA*` / `playerB*` columns) and the
  matcher pairs two searches. Team and multi-sided matchmaking will need a
  participants shape and group formation (0013).

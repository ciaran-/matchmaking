# League Activity Dashboard

A live, anonymised view of league activity on the match page. Shows who's
in the system right now (without showing *who*) and how busy the league
has been recently. Designed as an engagement feature, not a surveillance
tool.

## Goal

On `match.tsx`, render a panel with:

1. **Rating-distribution chart** — single horizontal rating axis with
   three series of dots layered on it:
   - Searching (queued, awaiting a match)
   - Awaiting confirmation (matched, one or both haven't confirmed yet)
   - Playing (both confirmed, no result yet)

   Each dot represents one rating bucket. Dot size scales with the count
   in that bucket.

2. **Recent-results counters** — three numbers above or below the chart:
   - Games completed in the last 5 minutes
   - Games completed in the last 1 hour
   - Games completed today (server-local since 00:00)

The panel is visible to **any signed-in user**, regardless of whether
they are themselves in the queue. It is fully aggregated — no
identities, no per-user fields.

## Non-goals

- No admin role gating. (No role mechanism exists yet; the
  anonymisation contract makes the feature safe for all signed-in users.
  Gating can be layered in later when roles arrive.)
- No per-user filtering or personalisation of the bundle. Every caller
  gets the same payload.
- No historical timeseries, no per-day chart, no rolling 24h shape.
- No push / websockets / SSE. Polling only.
- No reworking of the existing `getActiveSearches` scan cost. (See
  scaling notes — flagged, not fixed in this feature.)

## Privacy contract (hard requirement)

The server function returns **only** aggregated counts. No identifying
fields appear in the payload at any layer.

Payload shape (sketch — see Data shape section for the canonical type):

```
{
  buckets: [{ rating: 1000, searching: 3, awaitingConfirmation: 1, playing: 2 }, ...],
  recentResults: { last5Min: 7, lastHour: 42, today: 188 },
  generatedAt: '2026-05-20T14:32:18.000Z'
}
```

Forbidden in the payload: `userId`, `clerkId`, `attemptId`, `matchId`,
`gameResultId`, `username`, `email`, raw ratings, timestamps of
individual events.

Ratings are server-side binned into **25-point buckets**. This serves
three purposes:
1. The chart's "dot-per-bucket" visual needs bucketed input anyway.
2. Precise ratings are quasi-identifying in small cohorts (and the
   feature is built for the small-cohort case as much as the large
   one — early days will be precisely when fingerprinting is easiest).
3. Sparse representation keeps payload size bounded.

For the pair categories (`awaitingConfirmation`, `playing`), each player
is counted once in their own rating bucket. A match between a 1010
player and a 1090 player contributes `+1` to bucket 1000 and `+1` to
bucket 1075.

## Scaling considerations (called out explicitly)

This feature is sized for a future of tens of thousands of concurrent
signed-in users polling every ~5 seconds — roughly 2k req/s on a single
endpoint. The v1 design must handle that, or have a clear upgrade path.

1. **The aggregate is identical for every caller.** This is the most
   important property — it means the result is trivially cacheable.
   Wrap the aggregation in an in-process TTL cache (3 s). At 2k req/s,
   the underlying queries still only run ~0.33 times per second.

2. **In-process cache is best-effort on serverless.** Netlify functions
   reuse warm instances but not deterministically. Cold starts pay the
   full query cost. Acceptable for v1. The upgrade path is a shared
   cache (Redis or equivalent) — call it out in the follow-ups list.

3. **Pre-existing query cost — flag, do not fix here.**
   `getActiveSearches()` (src/lib/matchmaking/state.ts) uses
   `DISTINCT ON ("attemptId")` over the **full** `MatchmakingSearchEvent`
   table. As the append-only event log grows, this becomes
   `O(total events)` rather than `O(active searches)`. The new
   `getActiveMatches` mirrors the same pattern over `PendingGameEvent`
   and inherits the same problem.

   Caching the dashboard aggregate means we run these expensive queries
   at most once per cache window regardless of caller volume. The
   underlying cost still grows with event-log size and will need
   addressing separately — this is the most likely scaling bottleneck
   for matchmaking generally, not just for this feature. Logged as a
   follow-up below.

4. **Recent-results counts are cheap.** Three `count() WHERE
   createdAt >= ?` queries against `GameResult`, each hitting the head
   of the existing `[mode, createdAt]` index. Bounded cost regardless
   of total game volume.

5. **Payload size is bounded** by the number of *populated* rating
   buckets. At realistic rating spread, even a busy league should fit
   well under 1 KB.

## Data shape

`src/lib/matchmaking/dashboard.ts`:

```ts
export interface LeagueActivityBucket {
  /** Lower bound of the 25-point bucket. e.g. 1000 covers [1000, 1025). */
  rating: number;
  searching: number;
  awaitingConfirmation: number;
  playing: number;
}

export interface LeagueActivityBundle {
  /** Sparse — only buckets with at least one non-zero count. Sorted ascending by rating. */
  buckets: LeagueActivityBucket[];
  recentResults: {
    last5Min: number;
    lastHour: number;
    /** Since 00:00 in the server's local time. */
    today: number;
  };
  /** ISO timestamp; client uses this to show a freshness indicator. */
  generatedAt: string;
}
```

## Files

### New

- `src/lib/matchmaking/dashboard.ts` — pure aggregation. Exports
  `getLeagueActivity(client?: DbClient): Promise<LeagueActivityBundle>`.
- `src/lib/matchmaking/dashboard.integration.test.ts` — integration
  tests using existing factories and `withRollback`.
- `src/components/LeagueActivity.tsx` — React component. Takes the
  bundle, renders the chart + counters. Pure presentation.

### Modified

- `src/lib/matchmaking/state.ts` — add `getActiveMatches(client?)`
  returning `DerivedMatchState[]` for every non-terminal match.
  Mirrors `getActiveSearches`. Uses `DISTINCT ON ("matchId")` over
  `PendingGameEvent`, filtering to non-terminal latest types
  (`PROPOSED`, `CONFIRMED_BY`, `BOTH_CONFIRMED`).
- `src/lib/matchmaking/state.integration.test.ts` (or sibling file) —
  add coverage for `getActiveMatches` across all status transitions.
- `src/routes/match.tsx` — add `getLeagueActivityFn` server fn
  (`method: 'GET'`, Sentry-wrapped, dynamic import per CLAUDE.md).
  Poll via TanStack Query at a 5-second interval. Render
  `<LeagueActivity />` below the existing per-player UI.

## Implementation steps

1. **`getActiveMatches` in `state.ts`**
   - Mirror `getActiveSearches`: `DISTINCT ON ("matchId")` over
     `PendingGameEvent` ordered by `matchId, createdAt DESC, id DESC`.
   - Latest-row filter: keep only matches whose latest event type is
     non-terminal (`PROPOSED`, `CONFIRMED_BY`, `BOTH_CONFIRMED`).
   - For each surviving match, fetch the events for the match and
     build a `DerivedMatchState` using the same logic
     `getMatchState` already uses (or refactor that logic into a
     shared helper).
2. **Tests for `getActiveMatches`** — assert: PROPOSED-only match is
   included; CONFIRMED_BY by one player is included; BOTH_CONFIRMED
   is included; DECLINED / EXPIRED / PLAYED are excluded.
3. **`dashboard.ts`**
   - Call `getActiveSearches` and `getActiveMatches` in parallel
     (`Promise.all`).
   - Run the three `GameResult.count` queries in parallel as well.
   - Increment a shared `Map<bucketLowerBound, LeagueActivityBucket>`:
     - Each searcher → `searching++` at their bucket.
     - Each match where status ∈ {`PROPOSED`, `CONFIRMED_BY`} → for
       each of the two player ratings, `awaitingConfirmation++` at
       that bucket.
     - Each match where status = `BOTH_CONFIRMED` →
       `playing++` per player rating.
   - Bin via `Math.floor(rating / 25) * 25`.
   - Sort buckets ascending. Drop empty buckets (sparse).
   - Wrap the whole function in `Sentry.startSpan` at the call site
     (server fn), not inside the lib — keep lib framework-free.
4. **Integration tests for `getLeagueActivity`**
   - Empty state: all zeros, empty buckets, `recentResults` all 0.
   - Multiple searchers across buckets.
   - A `PROPOSED` match contributes to `awaitingConfirmation` for
     both players.
   - A `BOTH_CONFIRMED` match contributes to `playing` for both
     players.
   - A `PLAYED` match doesn't contribute to anything in the buckets
     but does contribute to `recentResults` according to its
     `createdAt`.
   - Time-window logic: insert `GameResult`s with controlled
     `createdAt` and assert the three counters land correctly. Use
     `withRollback` and explicit `createdAt` overrides via the
     factory.
5. **In-process cache**
   - Small module (could be in `dashboard.ts` or a sibling
     `cache.ts`): a single `let cached: { value, expiresAt }` plus a
     `getLeagueActivityCached()` wrapper. 3 s TTL.
   - The raw `getLeagueActivity` stays exported and uncached so tests
     can call it without time-based behaviour.
   - The server fn calls the cached version.
6. **Server fn in `match.tsx`**
   - `getLeagueActivityFn = createServerFn({ method: 'GET' }).handler(...)`.
   - Dynamic-import `@/lib/matchmaking/dashboard` inside.
   - Wrap body in `Sentry.startSpan({ name: 'League activity bundle' }, ...)`.
   - No auth needed beyond "signed-in user" — but we should still
     enforce that, mirroring the other server fns in this file.
     Without it, the endpoint is publicly cacheable activity data
     for anyone with the URL. Use the existing `authenticatedUser()`
     helper in the file.
7. **`<LeagueActivity />` component**
   - Three counter pills at the top: 5m / 1h / today.
   - SVG chart below:
     - x-axis: rating (auto-range to the populated bucket span,
       padded a bit on each side; show tick labels at sensible
       round numbers).
     - One row of dots per series (or all three series overlaid with
       distinct colors and a legend — overlaid reads as the more
       direct answer to "who's where").
     - Dot radius derived from count via `sqrt` (so a count of 9
       isn't 9× the size of a count of 1).
     - Tiny tooltip on hover showing the bucket + counts, no
       identities.
   - No charting library. Plain SVG. The chart is small and the
     dependency cost isn't justified.
   - Empty state: a single muted line, "No activity right now."
   - Stale-data indicator using `generatedAt` (e.g. greyed-out
     border if older than 30 s).
8. **Wire into `match.tsx`**
   - `useQuery({ queryKey: ['leagueActivity'], queryFn: () => getLeagueActivityFn(), refetchInterval: 5000 })`.
   - Render the component below the existing per-player block. No
     conditional on whether the player is in the queue — this is
     ambient context, always visible.
9. **Manual verification**
   - Seed multiple users at different ratings, start some searches,
     pair some, confirm one side, confirm both, record some results.
     Hit `/match` in the browser and confirm the visualisation
     reflects state and updates on the 5 s cadence.

## Acceptance criteria

- `getLeagueActivity` is unit/integration tested across the empty,
  searchers-only, awaiting-confirmation, playing, and recent-results
  cases.
- The server fn payload contains *no* identifying fields — verified
  by a test that asserts no key in the bundle matches a denylist
  (`userId`, `attemptId`, `matchId`, `gameResultId`, `username`,
  `email`).
- The match page renders the chart and counters for any signed-in
  user, regardless of whether they're in the queue.
- The 3 s in-process cache is exercised: a unit test confirms that
  back-to-back calls don't re-run the underlying query.
- `npm run check` and `npm run build` pass.

## Open follow-ups (track separately, do not bundle into this feature)

- **Rework `getActiveSearches` / `getActiveMatches` to avoid
  full-event-log scans.** Likely the biggest scaling risk in
  matchmaking overall. Possible directions: a maintained
  "active attempts" / "active matches" projection table updated on
  each event; or a working-set query that only looks at the recent
  tail of the event log.
- **Shared cache (Redis or equivalent)** if v1 in-process caching
  proves insufficient under real load — first sign would be
  per-instance query rates trending up with traffic.
- **Admin role gating** for any future variant of this view that
  includes identifying data. Requires a role mechanism on `User`
  (or via Clerk orgs/roles).
- **Historical / time-series view** (queue depth over the last
  hour, etc.) if we want trends, not just current state.

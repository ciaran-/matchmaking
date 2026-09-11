# 0012. Measure before caching or adding infrastructure

- **Status:** Accepted
- **Date:** 2026-05-22
- **Source:** `.claude/plans/complete/feature-5-league-activity-dashboard.md`
  (the cache it proposed was removed in review before merge)

## Context

The product is built to serve tens of thousands of concurrent users, so
designs that will not scale should not ship. The feature 5 plan answered
that with a 3-second in-process cache around the dashboard. The cache hid
the real bottleneck the same plan had identified — full event-log scans
(0010) — and brought module-level state and test-only reset hooks into the
public API. It was removed before merge.

## Decision

No speculative caching or infrastructure. When something is slow, in order:

1. **Measure** it: profile, and read the query plan.
2. **Fix the cause:** the query, an index, the schema, a projection table.
3. **Cache at the edge** with `Cache-Control`: shared across instances,
   with no application code.
4. **Use a shared cache** such as Redis, only if the edge is not enough.
5. **Cache in the application** as a last resort.

Designing for scale means not shipping what we know will not scale. It does
not mean adding caches just in case. The same applies to other speculative
infrastructure: the rate limiter (0011) does not use Redis for that reason.

## Consequences

- Scaling risks are recorded with their measurements rather than hidden
  behind a cache. Current examples:
  - Event-log scans in matchmaking (0010).
  - Match history. Measured 2026-09-10: a page of 20 for a dormant player
    scanned about 15,000 rows, because the query walks the global
    `GameResult` index. Cost grows with league traffic since the player's
    last game, not with their own history. The candidate fix — copy
    `createdAt` onto `GameParticipant` with a `[userId, createdAt]` index —
    waits for real traffic to confirm it.
- A cache that does land must name its measurement, its target and its
  upgrade path.
- Memoizing within a single request (for example actor resolution in
  `src/lib/auth.ts`) avoids repeated work in one request. It is not a
  cross-request cache and is not covered by this rule.

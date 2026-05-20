# Feature 5 — League Activity Dashboard: Task List

Plan: `.claude/plans/feature-5-league-activity-dashboard.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

---

## Dependency graph

```
T1 (factory: createdAt override) ─┐
                                  ├─> T3 (dashboard.ts aggregation) ──┬─> T4 (TTL cache)        ─┐
T2 (getActiveMatches in state.ts)─┘                                   ├─> T7 (anonymisation test)┤
                                                                                                 ├─> T6 (server fn + wire-up) ──> T8 (verify + commit)
                                                              T5 (LeagueActivity component) ────┘
```

### Parallelism opportunities

- **T1 and T2** can start in parallel — they touch different files and have no dependency on each other.
- **T5 (component)** can start in parallel with T1/T2/T3/T4. It only needs the `LeagueActivityBundle` type, which is fully specified in the plan and reproduced in T5's context below. The component can be built and tested with mock fixtures.
- **T4 (cache) and T7 (anonymisation test)** can run in parallel once T3 lands. Different concerns, different files.

### Strict ordering

(T1, T2) → T3 → (T4, T7) → T6 → T8
T5 floats — depends only on the type definition (plan §"Data shape"); merge before T6.

---

## Pre-flight (do once before starting any task)

1. Read `.claude/plans/feature-5-league-activity-dashboard.md` end-to-end. The plan is the source of truth for shape, naming, and acceptance criteria.
2. Read `CLAUDE.md` — in particular **`createServerFn` Pattern**, **Sentry Instrumentation**, **Testing** (both unit and integration), and **Code Style**.
3. Confirm `npm install`, `npm run build`, and `npm run test` succeed against the current `main`.
4. Confirm `.mcp.json` exists locally with a valid `DATABASE_URL` (no migrations are needed for this feature, but integration tests require Docker for testcontainers).
5. Create a working branch: `feature-5-league-activity-agent-<short-id>` (per CLAUDE.md sub-agent / worktree convention).

**No schema changes are required for this feature.** The existing `MatchmakingSearchEvent`, `PendingGameEvent`, and `GameResult` tables already supply everything needed.

---

## T1 — Extend `createGameResult` factory for `createdAt` override

**Status:** pending
**Depends on:** nothing
**Blocks:** T3
**Parallel with:** T2, T5

### Context

The dashboard's `recentResults` counters (`last5Min`, `lastHour`, `today`) require integration tests that insert games with controlled `createdAt` timestamps. The current factory at `src/test/factories/game-result.ts` only sets `createdAt` to `now()` (DB default).

### Read first

- `src/test/factories/game-result.ts` — current shape
- `src/test/factories/matchmaking-events.ts` — pattern for overrides (this file already supports `createdAt` overrides; mirror its approach)

### Modify

- `src/test/factories/game-result.ts`

### Implementation

Add `createdAt?: Date` to `GameResultOverrides`. Pass it through to `prisma.gameResult.create({ data: { ..., createdAt: overrides.createdAt } })`. Prisma allows explicit `createdAt` writes even with `@default(now())`.

Do not add a `participants[].createdAt` override — the participants don't have their own `createdAt` field in the schema.

### Acceptance criteria

- TypeScript compiles.
- A throwaway test (or manual REPL) confirms that `createGameResult(prisma, { createdAt: new Date('2020-01-01') })` produces a row with that exact timestamp.
- Existing `record-game.integration.test.ts` and any other consumers still pass — the change is purely additive.

---

## T2 — Add `getActiveMatches` to `state.ts`

**Status:** pending
**Depends on:** nothing
**Blocks:** T3
**Parallel with:** T1, T5

### Context

`state.ts` already exposes `getActiveSearches()` for the searcher side and `getMatchState(matchId)` for a single match. The dashboard needs an equivalent of `getActiveSearches` for matches — "every match whose latest event is non-terminal." This is also a generally useful primitive likely to be reused by future admin/observability work.

### Read first

- `src/lib/matchmaking/state.ts` — particularly `getActiveSearches` (mirror its `DISTINCT ON` shape) and `getMatchState` (the per-match derivation logic to reuse)
- Plan §"Implementation steps" item 1
- `schema.prisma` — `PendingGameEvent` model and `PendingGameEventType` enum

### Modify

- `src/lib/matchmaking/state.ts` — add the new function. If the per-match derivation in `getMatchState` is large enough to warrant extraction, factor it into a private helper `buildDerivedMatchState(events)` that both functions call. Keep the public surface clean.
- `src/lib/matchmaking/state.integration.test.ts` (or its sibling test file — check what exists) — add coverage.

### Implementation sketch

```ts
export async function getActiveMatches(
  client: DbClient = prisma,
): Promise<DerivedMatchState[]> {
  // Step 1: latest event per match
  const latestRows = await client.$queryRaw<PendingGameEvent[]>`
    SELECT DISTINCT ON ("matchId") *
    FROM "PendingGameEvent"
    ORDER BY "matchId", "createdAt" DESC, "id" DESC
  `;

  const TERMINAL: PendingGameEventType[] = ['DECLINED', 'EXPIRED', 'PLAYED'];
  const activeMatchIds = latestRows
    .filter(r => !TERMINAL.includes(r.type))
    .map(r => r.matchId);

  if (activeMatchIds.length === 0) return [];

  // Step 2: full event history for each active match (needed to build DerivedMatchState)
  const allEvents = await client.pendingGameEvent.findMany({
    where: { matchId: { in: activeMatchIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // Group by matchId, then reuse the same derivation logic getMatchState uses.
  // Return DerivedMatchState[] sorted by matchId or proposedAt — pick proposedAt asc for stable ordering.
}
```

`BOTH_CONFIRMED` is non-terminal (the match is "playing"); `PROPOSED` and `CONFIRMED_BY` are also non-terminal (the match is "awaiting confirmation"). Only `DECLINED`, `EXPIRED`, and `PLAYED` are terminal.

### Tests

Add an integration test file (or extend the existing one). Cases:

- Empty state → empty array.
- One `PROPOSED` event → included.
- `CONFIRMED_BY` after `PROPOSED` → included.
- `BOTH_CONFIRMED` after both `CONFIRMED_BY` events → included; `status === 'BOTH_CONFIRMED'`; `confirmedBy.size === 2`.
- `DECLINED` after `PROPOSED` → excluded.
- `EXPIRED` after `PROPOSED` → excluded.
- `PLAYED` after `BOTH_CONFIRMED` → excluded.
- Mixed: three matches at different states → only the non-terminal ones are returned.

Use the existing `appendMatchEvent` factory from `src/test/factories/matchmaking-events.ts`.

### Acceptance criteria

- All test cases pass with `npx vitest run src/lib/matchmaking/state.integration.test.ts`.
- No new modules import from `@/db` directly — use the injected `client` param (default `prisma`).
- `npm run check` clean.
- A grep of the codebase confirms no other module queries `PendingGameEvent` directly except `state.ts` and the existing `pending-game.ts` writer (existing pattern).

---

## T3 — `dashboard.ts` aggregation (pure, no cache)

**Status:** pending
**Depends on:** T1, T2
**Blocks:** T4, T6, T7

### Context

Pure aggregation that produces `LeagueActivityBundle`. No HTTP, no framework, no caching — just functions that take a `DbClient` and return the bundle. The cache is layered on top in T4.

### Read first

- Plan §"Data shape" and §"Implementation steps" item 3
- `src/lib/matchmaking/state.ts` — for `getActiveSearches`, `getActiveMatches` (T2), `DerivedMatchState` enum/shape
- `src/db.ts` — singleton Prisma export

### Create

- `src/lib/matchmaking/dashboard.ts`
- `src/lib/matchmaking/dashboard.integration.test.ts`

### Implementation

```ts
// dashboard.ts
import { prisma } from '@/db';
import type { DbClient } from '@/lib/matchmaking/state';
import { getActiveMatches, getActiveSearches } from '@/lib/matchmaking/state';

export const RATING_BUCKET_SIZE = 25;

export interface LeagueActivityBucket {
  rating: number; // bucket lower bound
  searching: number;
  awaitingConfirmation: number;
  playing: number;
}

export interface LeagueActivityBundle {
  buckets: LeagueActivityBucket[];
  recentResults: { last5Min: number; lastHour: number; today: number };
  generatedAt: string;
}

export function ratingBucket(rating: number): number {
  return Math.floor(rating / RATING_BUCKET_SIZE) * RATING_BUCKET_SIZE;
}

export async function getLeagueActivity(
  client: DbClient = prisma,
): Promise<LeagueActivityBundle> {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const [searches, matches, last5Min, lastHour, today] = await Promise.all([
    getActiveSearches(client),
    getActiveMatches(client),
    client.gameResult.count({ where: { createdAt: { gte: fiveMinAgo } } }),
    client.gameResult.count({ where: { createdAt: { gte: oneHourAgo } } }),
    client.gameResult.count({ where: { createdAt: { gte: startOfToday } } }),
  ]);

  const buckets = new Map<number, LeagueActivityBucket>();
  const bump = (rating: number, key: 'searching' | 'awaitingConfirmation' | 'playing') => {
    const b = ratingBucket(rating);
    const existing = buckets.get(b) ?? { rating: b, searching: 0, awaitingConfirmation: 0, playing: 0 };
    existing[key]++;
    buckets.set(b, existing);
  };

  searches.forEach(s => bump(s.rating, 'searching'));
  matches.forEach(m => {
    const key = m.status === 'BOTH_CONFIRMED' ? 'playing' : 'awaitingConfirmation';
    bump(m.playerARating, key);
    bump(m.playerBRating, key);
  });

  return {
    buckets: [...buckets.values()].sort((a, b) => a.rating - b.rating),
    recentResults: { last5Min, lastHour, today },
    generatedAt: now.toISOString(),
  };
}
```

Notes:
- `BOTH_CONFIRMED` → `playing`. `PROPOSED` and `CONFIRMED_BY` → `awaitingConfirmation`. Any other status would be a bug in `getActiveMatches` (terminal states should be filtered upstream), so a defensive default to `awaitingConfirmation` is fine.
- Use `.forEach` / `.map` per CLAUDE.md code style — no `for` loops.
- Pure function except for `new Date()` — accept that for now; tests can stub the clock via `vi.useFakeTimers()` if needed.
- The lib must remain framework-free. **Do not** import `@tanstack/react-start` or wrap in `Sentry.startSpan` here — that wrapping happens at the server fn in T6.

### Tests (`dashboard.integration.test.ts`)

Add `// @vitest-environment node` at the top (per CLAUDE.md testing notes).

Cases — each uses `withRollback`:

1. **Empty state**: no users, no searches, no matches, no games. Returns `buckets: []`, `recentResults: { last5Min: 0, lastHour: 0, today: 0 }`, `generatedAt` is an ISO string.

2. **Searchers across multiple buckets**:
   - Create users at ratings 1010, 1020, 1080.
   - Call `createStartedSearch` for each.
   - Assert two buckets returned: rating 1000 with `searching: 2`, rating 1075 with `searching: 1`. All other keys 0. (Note: 1080 → bucket 1075, since 25-point buckets; 1010 and 1020 both → 1000.)

3. **Match awaiting confirmation contributes both players**:
   - Two users at 1000 and 1050.
   - Append `PROPOSED` `appendMatchEvent` with both players.
   - Assert bucket 1000 has `awaitingConfirmation: 1`; bucket 1050 has `awaitingConfirmation: 1`.

4. **`BOTH_CONFIRMED` match counts as playing**:
   - Same as case 3 but also append `CONFIRMED_BY` ×2 then `BOTH_CONFIRMED`.
   - Assert `playing: 1` at each player's bucket; `awaitingConfirmation: 0`.

5. **Terminal matches don't appear in buckets**:
   - Create a `PROPOSED` then `DECLINED` match.
   - Assert no contribution to buckets.

6. **Recent-results counts**:
   - Insert `GameResult` rows via `createGameResult(prisma, { createdAt: ... })` (T1) at:
     - 2 minutes ago → counts toward `last5Min`, `lastHour`, `today`.
     - 30 minutes ago → counts toward `lastHour`, `today` only.
     - 5 hours ago (still today) → counts toward `today` only.
     - Yesterday → counts toward none.
   - Assert `recentResults: { last5Min: 1, lastHour: 2, today: 3 }`.

7. **Sparse output**: ratings 1000 and 1500 only → two buckets, nothing in between. Buckets sorted ascending.

### Acceptance criteria

- All test cases pass.
- `npm run check` clean.
- No `for` loops; `.map`/`.filter`/`.forEach` only (CLAUDE.md code style).
- No imports of `@tanstack/react-start`, `@clerk/backend`, or React in this file or its test.

---

## T4 — In-process TTL cache wrapper

**Status:** pending
**Depends on:** T3
**Blocks:** T6
**Parallel with:** T5, T7

### Context

Per the plan, the league-activity payload is identical for every caller. Cache it in-process with a short TTL so the underlying queries run at most once per cache window regardless of caller volume. This is the v1 scaling lever; shared/Redis cache is a follow-up.

### Read first

- Plan §"Scaling considerations" items 1, 2
- T3's `dashboard.ts`

### Modify

- `src/lib/matchmaking/dashboard.ts` — add a cached wrapper alongside the existing pure function. Do **not** remove or replace `getLeagueActivity` — tests must keep using the uncached version to stay deterministic.

### Implementation

```ts
const CACHE_TTL_MS = 3_000;

interface CacheSlot {
  value: Promise<LeagueActivityBundle>;
  expiresAt: number;
}
let cached: CacheSlot | null = null;

export async function getLeagueActivityCached(
  client: DbClient = prisma,
  now: () => number = Date.now,
): Promise<LeagueActivityBundle> {
  const t = now();
  if (cached && cached.expiresAt > t) return cached.value;
  const value = getLeagueActivity(client);
  cached = { value, expiresAt: t + CACHE_TTL_MS };
  // On error, evict so the next caller retries fresh.
  value.catch(() => { if (cached?.value === value) cached = null; });
  return value;
}

// Test-only: reset module-level state.
export function __resetLeagueActivityCacheForTests() {
  cached = null;
}
```

Notes:
- Cache the **Promise**, not the resolved value. This collapses concurrent callers during a cache miss into a single underlying query — important under the 2k req/s target.
- The injected `now` makes the cache testable without `vi.useFakeTimers()`.
- Eviction on error means a transient DB hiccup doesn't poison the cache for 3 s.
- The `__reset` export is acceptable here because the alternative (a class instance per server fn invocation) wastes the cache. The double-underscore prefix signals "test only."

### Tests (`dashboard.integration.test.ts` or a sibling unit test)

A small unit-style test block (no DB needed; mock the underlying function via `vi.mock` or by injecting a stub `client` that the test controls):

1. **Within TTL**: two back-to-back calls invoke the underlying query exactly once. Use a fake client with a spy on `getActiveSearches` (or mock `state` module), or use `vi.spyOn` on `getLeagueActivity`. Pick whichever reads more cleanly.
2. **After TTL expires**: advance the injected `now` past the TTL; next call re-runs the query.
3. **Error eviction**: if `getLeagueActivity` rejects, the cache slot clears so the next call retries (and can succeed against a now-working stub).
4. **Concurrent callers during miss collapse**: `Promise.all([getCached(), getCached(), getCached()])` triggers one underlying call.

### Acceptance criteria

- All four cache cases pass.
- The pure `getLeagueActivity` integration tests (T3) still pass — they shouldn't depend on the cache at all.
- `npm run check` clean.

---

## T5 — `<LeagueActivity />` component

**Status:** pending
**Depends on:** the `LeagueActivityBundle` type (specified in the plan; reproduced below — does NOT require T3 to be merged)
**Blocks:** T6
**Parallel with:** T1, T2, T3, T4, T7

### Context

Pure presentation component. Takes a `LeagueActivityBundle` (and a loading/error state) and renders the chart + counters. No data fetching inside the component — that lives in the route file in T6. This is parallelisable from day one because the bundle shape is locked in by the plan.

### Read first

- Plan §"Implementation steps" item 7
- Plan §"Data shape" (the `LeagueActivityBundle` interface)
- `src/routes/match.tsx` — existing Tailwind / visual style (gradients, slate palette, uppercase letterspacing for headings) so the new component matches the page's look
- `src/components/` if it exists, or `src/` for similar UI files — match the existing structure

### Create

- `src/components/LeagueActivity.tsx`
- `src/components/LeagueActivity.test.tsx` (component test with Vitest + React Testing Library if already set up; if not, skip and rely on T8 manual verification — check what test infra exists for components first)

### Type contract (canonical — copy from plan)

```ts
export interface LeagueActivityBucket {
  rating: number;
  searching: number;
  awaitingConfirmation: number;
  playing: number;
}

export interface LeagueActivityBundle {
  buckets: LeagueActivityBucket[];
  recentResults: { last5Min: number; lastHour: number; today: number };
  generatedAt: string; // ISO
}
```

The component imports this type from `@/lib/matchmaking/dashboard` once T3 lands. While T3 is in flight, define a local copy of the interface in a `// TODO: replace with import from @/lib/matchmaking/dashboard once T3 merges` block — and fix this up before T6 wires things together.

### Implementation

```tsx
interface Props {
  bundle: LeagueActivityBundle | undefined;
  isLoading: boolean;
  error?: { message?: string };
}

export function LeagueActivity({ bundle, isLoading, error }: Props) {
  // ...
}
```

UI structure:
- Section heading: "League Activity" in the page's heading style.
- Counter row: three small pills/cards for `last5Min`, `lastHour`, `today`. Label them clearly ("Last 5 min", "Last hour", "Today").
- Chart: an SVG element. See "Chart implementation" below.
- Empty state: when `bundle.buckets.length === 0` AND all `recentResults` counts are 0, render a muted line: "No activity right now."
- Loading state (`isLoading && !bundle`): a placeholder skeleton or muted "Loading…" line. If the cache has produced a previous value, prefer showing the stale value with a subtle indicator over a hard skeleton — this is an ambient panel, not a primary action.
- Error state: a muted "Couldn't load league activity" line. Don't surface the raw message.
- Freshness indicator: if `Date.now() - new Date(bundle.generatedAt).getTime() > 30_000`, dim the panel or add a small "stale" marker.

### Chart implementation

Plain SVG, no charting library.

- Width: container-width (responsive); height fixed (e.g. 200px).
- X-axis: rating. Compute `min = floor((min populated bucket - 50) / 25) * 25`, `max = ceil((max populated bucket + 50) / 25) * 25` so the populated range has padding. If buckets are empty, skip the chart (handled by empty state).
- Three horizontal "lanes" (top: searching, middle: awaiting confirmation, bottom: playing) with distinct colors — pick three accessible colors from the existing Tailwind palette (e.g. cyan/blue, amber, emerald).
  - **Alternative considered**: overlaid on one line. Pick lanes — overlaid will create visual collision when buckets share a rating, and lanes communicate "three buckets" more clearly.
- Each non-zero count is a dot. Radius via `Math.sqrt(count) * scale` (so 9 isn't 9× the size of 1).
- Tick labels at sensible round-numbered ratings (every 100 or 200 depending on span).
- Series legend below the chart.
- Tooltip on hover (native `<title>` element inside each circle is fine — no JS): "Rating 1000–1024: 3 searching".

Verify in dev that nothing in the rendered DOM contains identifying data — the tooltip is purely counts + bucket bounds.

### Tests

If component testing is already set up in this project (check `package.json` for `@testing-library/react` etc.), add:

- Renders all three counter values.
- Renders one dot per (bucket, non-zero series) combination.
- Empty state renders the "No activity right now" line when bundle is empty.
- Error state doesn't leak `error.message` to the DOM.

If component testing isn't set up, **do not add it as part of this task** — note it in T8 for manual verification instead. Setting up React Testing Library is a separate piece of infra.

### Acceptance criteria

- Component renders given a hand-crafted `LeagueActivityBundle` mock in Storybook-style isolation (or a dev page). Easiest verification: temporarily render `<LeagueActivity bundle={mockBundle} isLoading={false} />` on the match page during dev.
- No identifying fields are rendered anywhere in the output. (Hand-audit: the props only contain counts and buckets; if you can't get identity into props, you can't render it.)
- `npm run check` clean.

---

## T6 — Server fn + wire into `match.tsx`

**Status:** pending
**Depends on:** T4 (cache), T5 (component), T3 (types)
**Blocks:** T8

### Context

Adds the public-facing endpoint and renders the panel on the match page. Follows the existing `createServerFn` patterns in `match.tsx` exactly.

### Read first

- `src/routes/match.tsx` — all existing server fns (`startSearchFn`, `cancelSearchFn`, `pollSearchStatusFn`, etc.), the `authenticatedUser()` helper, and the page render structure
- CLAUDE.md §"`createServerFn` Pattern" — dynamic import requirement is non-negotiable
- CLAUDE.md §"Sentry Instrumentation" — `Sentry.startSpan` wrap
- Plan §"Implementation steps" items 6, 8

### Modify

- `src/routes/match.tsx`

### Implementation — server fn

Add alongside the other server fns:

```ts
export const getLeagueActivityFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    return Sentry.startSpan(
      { name: 'Matchmaking: league activity bundle' },
      async () => {
        // Auth: any signed-in user. This is anonymised data but we still
        // gate to authenticated callers — see plan §"Implementation
        // steps" item 6 (rationale: don't expose activity to anonymous
        // crawlers / unauthenticated clients).
        await authenticatedUser();

        const { getLeagueActivityCached } = await import(
          '@/lib/matchmaking/dashboard'
        );
        return getLeagueActivityCached();
      },
    );
  },
);
```

Notes:
- `method: 'GET'` because the call is a pure read; this also lets TanStack Router preload safely (per CLAUDE.md).
- Dynamic import of `@/lib/matchmaking/dashboard` — the module imports `@/db`, so it must not leak into the client bundle.
- The `authenticatedUser()` call exists already in the file; reuse it. It throws on missing env or unsigned callers.

### Implementation — render

Inside the page component:

```tsx
const leagueActivityQuery = useQuery({
  queryKey: ['leagueActivity'],
  queryFn: () => getLeagueActivityFn(),
  refetchInterval: 5_000,
});

// ... in the JSX, below the existing per-player section:
<LeagueActivity
  bundle={leagueActivityQuery.data}
  isLoading={leagueActivityQuery.isLoading}
  error={leagueActivityQuery.error as { message?: string } | undefined}
/>
```

- The panel renders **regardless** of `phase`. It's ambient context, not part of the queue/match flow.
- Don't gate on `isSignedIn` here — the route is already behind a sign-in check; the server fn re-checks auth defensively.
- 5-second `refetchInterval` matches the plan. Don't try to be clever with adaptive polling for v1.

### Acceptance criteria

- `npm run build` succeeds (this catches client/server bundle leakage — the most likely failure mode if the dynamic import is wrong).
- The match page renders the new panel for any signed-in user.
- `npm run check` clean.
- Manual smoke test: open `/match` while signed in. Panel appears below the existing UI. Doesn't break any existing phase rendering. Updates on a 5-second cadence (verify in DevTools network tab).

---

## T7 — Anonymisation contract test

**Status:** pending
**Depends on:** T3
**Blocks:** T8
**Parallel with:** T4, T5

### Context

The privacy contract is the most important property of this feature and the easiest to accidentally violate (e.g. someone "helpfully" adds `userId` to the bundle later). Lock it in with an automated test that asserts the bundle's structure contains no fields from a denylist.

### Read first

- Plan §"Privacy contract"
- T3's `dashboard.ts` output

### Create or modify

- Add a test block in `src/lib/matchmaking/dashboard.integration.test.ts` (or a sibling unit test file, since this doesn't strictly need the DB if you use a fixture).

### Implementation

```ts
const FORBIDDEN_KEYS = [
  'userId',
  'clerkId',
  'attemptId',
  'matchId',
  'gameResultId',
  'username',
  'email',
  'playerAId',
  'playerBId',
  'actingPlayerId',
];

function collectKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    value.forEach(v => collectKeys(v, acc));
    return acc;
  }
  Object.keys(value).forEach(k => {
    acc.add(k);
    collectKeys((value as Record<string, unknown>)[k], acc);
  });
  return acc;
}

it('returns no identifying fields in any bucket or pair', async () => {
  // Set up a rich scenario: searchers, awaiting-confirmation matches, playing matches, recent games.
  // Then call getLeagueActivity and:
  const bundle = await getLeagueActivity(prisma);
  const keys = collectKeys(bundle);
  FORBIDDEN_KEYS.forEach(k => expect(keys).not.toContain(k));
});
```

The "rich scenario" matters — running the test against an empty DB would pass trivially. Use a setup similar to T3's case 7 (sparse, multi-bucket) plus a `BOTH_CONFIRMED` match plus a recent game.

Also add a simpler assertion: bundle's top-level keys are exactly `['buckets', 'recentResults', 'generatedAt']`. This guards against future drift.

### Acceptance criteria

- Test passes against a rich populated DB scenario.
- Test fails (when temporarily edited) if `userId` were added anywhere in the payload — sanity-check by adding `userId: 'x'` to a bucket locally, watching the test fail, then reverting.
- `npm run check` clean.

---

## T8 — Pre-commit verification, manual smoke, branch ready

**Status:** pending
**Depends on:** T6, T7
**Blocks:** nothing (merge)

### Context

Final pass. Catches anything the per-task acceptance criteria missed. The build step in particular is non-negotiable — Vite client/server bundle errors are invisible during dev mode (per CLAUDE.md and the saved memory).

### Pre-commit checklist (run in order, fix anything that fails)

1. `npm run format` — formatter.
2. `npm run check` — Biome lint + format check (CI runs this; stricter than format alone).
3. `npm run build` — catches client/server bundle leaks and Vite-only errors.
4. `npm run test` — unit tests.
5. `npm run test:integration` — integration tests (requires Docker running).

### Manual verification

In a fresh `npm run dev`:

1. Sign in as a normal user. Navigate to `/match`. Confirm the panel renders.
2. With no activity, confirm the empty state ("No activity right now").
3. Seed multiple users at varied ratings (via `db:seed` or manual SQL), start searches from a couple of them, propose a match between two, confirm one side, confirm both. Watch the panel update on the 5-second cadence and show:
   - Searchers as dots in the "searching" lane.
   - The pair-in-flight as dots in the "awaiting confirmation" lane.
   - After both-confirm, the pair moves to the "playing" lane.
   - On `PLAYED`, the pair disappears from the chart and the recent-results counters tick up.
4. In DevTools, inspect the response of `getLeagueActivityFn` — confirm no identifying fields are present. Hand-eye check.
5. Confirm the polling interval is ~5 s, not 2 s (don't conflate with the existing `pollSearchStatusFn`).
6. Sign out → the panel disappears (route guard).

### Branch & PR

- Branch name: `feature-5-league-activity-agent-<short-id>` (per CLAUDE.md and the saved memory on naming).
- If `package-lock.json` was regenerated for any reason, run `npm ci` (not `npm install`) before pushing — per CLAUDE.md.
- Open a PR titled "feat: league activity dashboard on match page" (or similar). Body should reference the plan path and call out the scaling follow-ups list verbatim from the plan.

### Acceptance criteria

- All checklist steps pass.
- Manual smoke passes.
- PR opened with the right title and a body that includes the plan link and the follow-ups.

---

## Out of scope (do not bundle into this feature)

These are listed in the plan's "Open follow-ups" section — file them as separate issues, do not bundle:

- Reworking `getActiveSearches` / `getActiveMatches` to avoid full-event-log scans at scale.
- Shared cache (Redis or equivalent).
- Admin role gating for any future identity-bearing variant.
- Historical / time-series view.

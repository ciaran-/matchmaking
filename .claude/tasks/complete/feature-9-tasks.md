# Feature 9 — Rating Progression Chart: Task List

Plan: `.claude/plans/complete/feature-9-rating-progression-chart.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

Renders **on the player profile** (feature 7) — feature 7 must be merged first. Shares a backend access pattern with feature 8; build after or alongside it to reuse the query shape.

---

## Dependency graph

```
[feature 7 merged] ──> T1 (getPlayerRatingHistory lib fn) ──> T2 (server fn) ──> T3 (<RatingChart /> SVG + mount) ──> T4 (verify + commit)
```

### Parallelism

- **T3's chart** can be built against the `RatingHistoryPoint[]` type (specified in T1) with a mock series.

### Strict ordering

(feature 7) → T1 → T2 → T3 → T4.

---

## Pre-flight (do once)

1. Read `.claude/plans/complete/feature-9-rating-progression-chart.md` and `feature-7-player-profile.md`.
2. Read `CLAUDE.md` — **`createServerFn` Pattern**, **Sentry Instrumentation**, **Testing**, **Code Style**.
3. Confirm feature 7 is merged. Confirm `npm run build`/`test`/`test:integration` pass.
4. No schema changes required.
5. Branch: `feature-9-rating-progression-agent-<short-id>`.

**Charting decision (locked):** use **plain SVG**, no charting library — this matches feature 5's `LeagueActivity` chart (which is hand-rolled SVG). Do not add a dependency.

**Key facts**: each `GameParticipant` has `ratingAfter`; its `GameResult.createdAt` is the timestamp. Ascending order of a player's participations by game time = the rating curve. Starting rating is `DEFAULT_RATING` (1000) from `src/lib/game-series.ts`.

---

## T1 — `getPlayerRatingHistory` lib fn

**Status:** pending
**Depends on:** feature 7 merged
**Blocks:** T2, T3

### Context

Return an ordered rating timeseries for a player, oldest→newest, prefixed with the starting-rating origin point so a brand-new or single-game player still charts sensibly.

### Read first

- `schema.prisma` — `GameParticipant`, `GameResult`.
- `src/lib/match-history.ts` (feature 8, if merged) — reuse the same per-user-ordered-by-game-time access path and `DbClient` alias; coordinate index assumptions.
- `src/lib/player-profile.ts` (feature 7) — username resolution.
- `src/lib/game-series.ts` — `DEFAULT_RATING`.

### Create

- `src/lib/rating-history.ts` (server-only header).
- `src/lib/rating-history.integration.test.ts` (`// @vitest-environment node`).

### Implementation

```ts
export interface RatingHistoryPoint {
  rating: number;
  at: string;                 // ISO timestamp of the game (origin point uses memberSince)
  gameResultId: string | null;// null for the synthetic starting-rating origin point
}

export async function getPlayerRatingHistory(
  username: string,
  client: DbClient = prisma,
): Promise<RatingHistoryPoint[] | null> { /* ... */ }
```

- Resolve `username → user`; return `null` if unknown.
- Load the player's `GameParticipant` rows joined to `GameResult.createdAt`, **ascending**, projecting `{ ratingAfter, createdAt, gameResultId }`. v1: include all modes' games (rating is rating regardless of mode) — but since only 1v1 exists today this is moot; note it.
- Prepend a synthetic origin point: `{ rating: DEFAULT_RATING, at: user.createdAt (ISO), gameResultId: null }` so the curve starts at 1000. (If the very first game's `ratingBefore` differs from `DEFAULT_RATING` for any reason, prefer the first game's `ratingBefore` for the origin — document the choice.)
- Map rows → points with `.map` (no `for` loops).
- Wrap in `Sentry.startSpan({ name: 'Player rating history' }, ...)`.

### Tests

`withRollback` + factories. Cases:

1. Unknown username → `null`.
2. New user, no games → single origin point at `DEFAULT_RATING`.
3. One game → two points: origin then `ratingAfter`.
4. Several games → points ascending by time; `rating` values equal each game's `ratingAfter`; `gameResultId` set on real points, `null` on origin.
5. Ordering is strictly oldest→newest even if games were inserted out of order.

### Acceptance criteria

- All cases pass; origin point present; ordering correct.
- No `for` loops; `npm run check` clean.

---

## T2 — Server fn wrapper

**Status:** pending
**Depends on:** T1
**Blocks:** T3

### Implementation

```ts
export const getPlayerRatingHistoryFn = createServerFn({ method: 'GET' })
  .inputValidator((d: { username: string }) => d)
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: 'Rating history' }, async () => {
      await authenticatedUser();
      return getPlayerRatingHistory(data.username);
    });
  });
```

- `method: 'GET'`; static import at top of the route file (colocate with the profile route per feature 7's pattern).

### Acceptance criteria

- `npm run build` clean; no `@prisma`/`PrismaClient` in the client bundle. `npm run check` clean.

---

## T3 — `<RatingChart />` (plain SVG) + mount on profile

**Status:** pending
**Depends on:** T2
**Blocks:** T4

### Context

A line chart of rating over the player's games, mounted in feature 7's chart slot. Hand-rolled SVG, styled to match feature 5's chart.

### Read first

- `src/components/LeagueActivity.tsx` — the existing hand-rolled SVG chart: copy its approach to axes, scaling, colors, responsive width / fixed height, and native `<title>` tooltips.
- `src/routes/player.$username.tsx` — the `{/* MOUNT: rating progression chart ... */}` slot.

### Create

- `src/components/RatingChart.tsx`
- `src/components/RatingChart.test.tsx`

### Implementation

- Props: `{ username: string }`. Fetch via `useQuery` calling `getPlayerRatingHistoryFn`.
- **x-axis: game index** (even spacing) for v1 — keep the `at` timestamp on each point in a `<title>` so the axis can switch to time later (plan open question). x labels: "Start", then game numbers (sparse if many).
- **y-axis: rating**, padded to a sensible round range around `[min, max]` of the series.
- Render the series as an SVG `<polyline>`/`<path>` plus a dot per point; each dot a native `<title>`: "Game N · rating 1024 · <date>" (origin: "Start · 1000").
- Colors/styling from the existing palette (cyan/blue line on slate, matching `LeagueActivity`).
- States: loading skeleton; the "just the origin point" case (0 games) renders a flat single point with a muted "No games yet" note; error → muted "Couldn't load rating history" (no raw message).
- Mount in the profile slot: `<RatingChart username={username} />`.

### Tests (`RatingChart.test.tsx`)

With a mock `RatingHistoryPoint[]`: renders one dot per point; polyline has the right number of vertices; origin point labelled "Start"; empty/origin-only state renders the muted note; error state hides the raw message.

### Acceptance criteria

- Chart renders on the profile, curve matches the series, tooltips show per-point detail.
- No charting-library dependency added.
- `npm run build` + `npm run check` clean.

---

## T4 — Verification + commit

**Status:** pending
**Depends on:** T3

### Pre-commit checklist (in order)

1. `npm run format` 2. `npm run check` 3. `npm run build` 4. `npm run test` 5. `npm run test:integration` (Docker)

### Manual verification

1. `npm run dev`, sign in, record several games for one user so their rating moves up and down.
2. Open the profile → chart shows the progression starting at 1000, matching the recorded `ratingAfter` values (cross-check against the feature-8 history rows if present).
3. Hover points → tooltips show game number, rating, date.
4. New user → origin-only state with the muted note.

### Branch & PR

- Branch `feature-9-rating-progression-agent-<short-id>`. `npm ci` if lockfile regenerated.
- PR title e.g. "feat: rating progression chart on profile". Body references the plan; notes x-axis-by-index choice and the time-axis / win-loss-annotation follow-ups.

### Acceptance criteria

- All checks green; manual smoke passes; chart values agree with recorded ratings.

---

## Out of scope (do not bundle)

- Date-range / zoom controls; time-based x-axis (v1 is game-index).
- Comparison overlays (vs. another player / league average).
- Downsampling/bucketing.
- Win/loss markers on points (nice-to-have; pairs with feature 8 later).

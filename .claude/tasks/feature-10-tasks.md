# Feature 10 — Leaderboard Hardening: Task List

Plan: `.claude/plans/feature-10-leaderboard-hardening.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

This is **hardening of the existing `/league` surface**, not a greenfield build. Best built **after feature 7** (to reuse its W/L/draw + rank definitions and link usernames to real profiles), but it can ship before 7 with profile links stubbed.

---

## Dependency graph

```
T1 (getLeaderboard lib fn: SQL aggregation + pagination + search) ──┐
T2 (my-rank query — shared with feature 7) ─────────────────────────┴─> T3 (refit /league route) ──> T4 (verify + commit)
```

### Parallelism

- **T1 and T2** touch the same new lib module but are separable queries — one author can do both; if split, T2 is small.
- **T3's UI work** (pagination controls, search box, highlight, removing starter cosmetics) can be drafted against the `LeaderboardPage` type while T1/T2 finish.

### Strict ordering

(T1, T2) → T3 → T4.

---

## Pre-flight (do once)

1. Read `.claude/plans/feature-10-leaderboard-hardening.md`. If feature 7 is merged, also read `feature-7-player-profile.md` (you will reuse its canonical W/L/draw + rank helpers).
2. Read `CLAUDE.md` — **`createServerFn` Pattern**, **Sentry Instrumentation**, **Testing**, **Code Style**, and **`feedback_no_premature_caching`** (fix the query first; no materialised view yet).
3. Confirm `npm run build`/`test`/`test:integration` pass on `main`.
4. No schema changes required (unless T1's measurement justifies a denormalised counter — see T1; treat that as a separate decision, not assumed).
5. Branch: `feature-10-leaderboard-agent-<short-id>`.

**Current state to replace** (`src/routes/league.tsx`):
- `getLeaguePlaces` does `prisma.user.findMany({ include: { gameParticipations: true } })` — pulls **every** user with **every** participation row, then computes W/L/games **client-side** by filtering `ratingChange`. No pagination, no search, no profile links, no current-user highlight. Heading says "RANKINGS" with a leftover TanStack starter logo.

---

## T1 — `getLeaderboard` lib fn (SQL aggregation + pagination + search)

**Status:** pending
**Depends on:** nothing (feature 7 helpers if merged)
**Blocks:** T3

### Context

Replace the unbounded client-side aggregation with a single ranked, paginated, optionally-searched query whose W/L/draw counts are computed **in SQL**.

### Read first

- `src/routes/league.tsx` lines 16–25 (the anti-pattern being replaced) and the table render (190–267) for the columns currently shown.
- `src/lib/player-profile.ts` (feature 7, if merged) — **import its canonical W/L/draw helper/constants** so leaderboard and profile agree. If feature 7 is not merged, define the same rule (`win = ratingChange > 0`, `loss < 0`, `draw === 0`) and leave a `// TODO: dedupe with feature 7` note.
- `src/lib/matchmaking/dashboard.ts` — lib read fn + integration test pattern, `DbClient` default param.

### Create

- `src/lib/leaderboard.ts` (server-only header).
- `src/lib/leaderboard.integration.test.ts` (`// @vitest-environment node`).

### Implementation

```ts
export interface LeaderboardRow {
  rank: number;            // 1-based, dense vs. standard — pick & document (recommend standard: ties share rank, next rank skips)
  id: string;
  username: string;
  currentRating: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
}

export interface LeaderboardPage {
  rows: LeaderboardRow[];
  total: number;           // total users matching the (optional) search
  page: number;
  pageSize: number;
}

export async function getLeaderboard(
  opts: { page?: number; pageSize?: number; search?: string } = {},
  client: DbClient = prisma,
): Promise<LeaderboardPage> { /* ... */ }
```

- Order by `currentRating DESC`, tie-break by `username ASC` (stable).
- Compute W/L/draw/games **in the query** — aggregate over `GameParticipant` (`COUNT(*) FILTER (WHERE "ratingChange" > 0)` etc. via a `$queryRaw`, or Prisma `groupBy` joined to the user page). Do **not** load participation arrays into JS.
- `rank` reflects global position (not page-relative): for page N, the first row's rank is `(page-1)*pageSize + 1`, adjusted for the chosen tie semantics. Document dense-vs-standard ranking and be consistent with feature 7's `rank`.
- `search`: case-insensitive `username` prefix/contains filter; `total` counts matches.
- Pagination via `page`/`pageSize` (numbered pages are fine here — the dataset is rank-ordered and bounded per page; clamp `pageSize` to a max).
- **Measurement note**: before considering any denormalised counter on `User`, confirm the aggregate query's plan against a seeded dataset. Only escalate to denormalisation if measurement shows it's the bottleneck (`feedback_no_premature_caching`). Default: live aggregate.
- Wrap in `Sentry.startSpan({ name: 'Leaderboard page' }, ...)`.

### Tests

`withRollback` + factories. Cases:

1. Empty DB → `rows: []`, `total: 0`.
2. Users at distinct ratings → ranked desc; ranks 1..N; aggregates correct for users with mixed W/L/draw.
3. Tie on rating → tie-break by username; rank semantics as documented.
4. Pagination: 5 users, `pageSize: 2` → page 1 ranks 1–2, page 2 ranks 3–4, page 3 rank 5; `total` constant at 5.
5. Search by username substring → only matches returned; `total` reflects the filtered count; ranks still reflect **global** standing (decide & test: does a searched row show its global rank or its position within results? Recommend **global rank** — document it).
6. A user with zero games → appears with all-zero counts at the rating-derived rank.

### Acceptance criteria

- Aggregation is in-SQL; no per-user participation arrays loaded.
- Ranking + pagination + search correct and documented.
- Counts agree with feature 7's profile for the same user (if 7 merged).
- No `for` loops; `npm run check` clean.

---

## T2 — "My rank" query (shared with feature 7)

**Status:** pending
**Depends on:** nothing
**Blocks:** T3

### Context

To highlight and "jump to" the signed-in user, the page needs the caller's rank and which page they're on, without scanning the whole list client-side.

### Read first

- Feature 7's rank computation in `src/lib/player-profile.ts` (if merged) — reuse it; do not define a second rank formula.

### Implementation

In `src/lib/leaderboard.ts`, add:

```ts
export async function getUserRank(
  userId: string,
  pageSize: number,
  client: DbClient = prisma,
): Promise<{ rank: number; page: number } | null>;
```

- `rank` = `(count of users with currentRating > this user's) + 1` (same definition as feature 7 — import/share it).
- `page` = `Math.ceil(rank / pageSize)`.
- Returns `null` if the user doesn't exist.

### Tests

Cases: user at top → rank 1, page 1; user mid-field with `pageSize: 2` → correct rank + page; tie behaviour consistent with T1; unknown user → `null`.

### Acceptance criteria

- Rank matches feature 7 and T1's `rank` for the same user. `npm run check` clean.

---

## T3 — Refit the `/league` route

**Status:** pending
**Depends on:** T1, T2
**Blocks:** T4

### Context

Replace `getLeaguePlaces` and upgrade the table: pagination, current-user highlight + "jump to me", profile links, username search, and removal of leftover starter cosmetics. Keep the existing `RecordGameModal` flow working.

### Read first

- `src/routes/league.tsx` in full — the loader, the table render, and the `RecordGameModal` (which depends on the loaded `players` list).
- `src/components/SignInGate.tsx`; `@clerk/clerk-react` `useUser` for the current user id (mapped to the DB user — note the page already authenticates).
- Feature 7's profile route path (`/player/<username>`) for the links (stub the link target if feature 7 isn't merged yet).

### Modify

- `src/routes/league.tsx`:
  - Replace the `getLeaguePlaces` loader with a `getLeaderboardFn` server fn (`createServerFn({ method: 'GET' })`, static import of `getLeaderboard`, `Sentry.startSpan`, gated by `authenticatedUser`). Pass `page`/`search` (from URL search params via TanStack Router `validateSearch`, so pagination/search are linkable).
  - Add a `getUserRankFn` server fn for the highlight/jump.
  - **Table**: render `LeaderboardRow[]`; usernames link to `/player/<username>`; highlight the signed-in user's row; a "jump to my rank" control that navigates to their page; a search input bound to the URL param; pagination controls (prev/next/page numbers).
  - **Cosmetics**: remove the TanStack starter logo (`/tanstack-circle-logo.png`); make the heading coherent with the route (e.g. "Leaderboard"). Don't restyle the whole page — just fix the leftover scaffolding.
  - **`RecordGameModal`**: it currently takes the full `players` list (for the two dropdowns) from the unbounded loader. The leaderboard page is now paginated, so it can't supply all players. Options (pick and note): (a) give the modal its own lightweight `getAllPlayersForPicker` server fn (id + username only), or (b) leave the modal sourcing players separately. Do **not** silently regress the modal to only the current page of players. Recommend (a).

### Tests

- If feasible, a light render test of the table component with a mock `LeaderboardPage`: rows render with links, the current user's row is highlighted, pagination controls reflect `page`/`total`.
- The query logic is covered in T1/T2.

### Acceptance criteria

- `/league` paginates, searches, highlights the current user, and links to profiles.
- Record-game flow still works with a full player list (not just the current page).
- Starter logo/heading cleaned up.
- `npm run build` clean; client bundle free of `@prisma`/`PrismaClient`. `npm run check` clean.

---

## T4 — Verification + commit

**Status:** pending
**Depends on:** T3

### Pre-commit checklist (in order)

1. `npm run format` 2. `npm run check` 3. `npm run build` 4. `npm run test` 5. `npm run test:integration` (Docker)

### Manual verification

1. `npm run dev`, sign in, `npm run db:seed` (need enough users to span multiple pages).
2. `/league`: verify ranking order, in-row W/L/D counts (cross-check one user against their profile — must match), pagination across pages, and that the URL updates so a page/search is shareable.
3. Search a username substring → filtered results; ranks shown are global (per T1 decision).
4. Current user's row is highlighted; "jump to my rank" lands on the right page.
5. Click a username → their profile (feature 7) or the stubbed target.
6. Record a game via the modal → the dropdowns list all players (not just the current page); after recording, the leaderboard reflects the change (`router.invalidate()`).
7. Confirm the starter logo is gone.

### Branch & PR

- Branch `feature-10-leaderboard-agent-<short-id>`. `npm ci` if lockfile regenerated.
- PR title e.g. "feat: harden leaderboard (pagination, search, profile links)". Body references the plan; notes the W/L/draw definition is shared with feature 7 and lists the seasons/materialised-view follow-ups.

### Acceptance criteria

- All checks green; manual smoke passes; leaderboard counts agree with profiles; no unbounded fetch remains.

---

## Out of scope (do not bundle)

- Seasons / time-windowed leaderboards.
- Filters by mode/region.
- Caching / materialised view (fix the query first; only revisit if measurement demands it).
- Full visual redesign of the page (only the leftover starter cosmetics are in scope).
- Moving `RecordGameModal` to a different home (note it; don't relocate here).

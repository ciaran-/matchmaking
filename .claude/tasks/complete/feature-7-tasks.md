# Feature 7 — Player Profile Page: Task List

Plan: `.claude/plans/complete/feature-7-player-profile.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

This is the **anchor** of the player-facing work (features 7–10). Features 8 and 9 mount onto the page built here; feature 10 links into it. Build this first.

---

## Dependency graph

```
T1 (W/L/draw + rank semantics + getPlayerProfile lib fn) ──> T2 (server fn) ──> T3 (route + UI + mount slots) ──> T4 (verify + commit)
```

### Parallelism

- **T3's UI shell** can be drafted in parallel with T1/T2 against the `PlayerProfile` type (fully specified in T1 below), using a mock fixture — but it can't wire to the server fn until T2 lands.

### Strict ordering

T1 → T2 → T3 → T4.

---

## Pre-flight (do once)

1. Read `.claude/plans/complete/feature-7-player-profile.md` end-to-end.
2. Read `CLAUDE.md` — **`createServerFn` Pattern**, **Sentry Instrumentation**, **Testing**, **Code Style**, **Path Aliases**.
3. Confirm `npm install`, `npm run build`, `npm run test`, `npm run test:integration` (Docker) pass on `main`.
4. No schema changes are required — `User`, `GameParticipant`, `GameResult` already hold everything.
5. Branch: `feature-7-player-profile-agent-<short-id>`.

**Key facts**: `User` has `username` (unique), `currentRating`, `createdAt`. `GameParticipant` has `userId`, `ratingChange`, and belongs to a `GameResult` (with `createdAt`, `mode`). Default rating is 1000 (`DEFAULT_RATING` in `src/lib/game-series.ts`).

---

## T1 — Canonical stats + `getPlayerProfile` lib fn

**Status:** pending
**Depends on:** nothing
**Blocks:** T2, T3

### Context

Define the **single source of truth** for win/loss/draw semantics and league rank, then expose a profile read. Feature 10 (leaderboard) must reuse these exact definitions so the profile and leaderboard never disagree. The current `/league` table infers wins from `ratingChange > 0` and computes client-side over full participation arrays — do **not** repeat that; compute in the query.

### Read first

- `schema.prisma` — `User`, `GameParticipant`, `GameResult`.
- `src/routes/league.tsx` lines 16–25 (the existing naive aggregation — the anti-pattern to replace).
- `src/lib/game-series.ts` — `DEFAULT_RATING`.
- `src/lib/matchmaking/dashboard.ts` — example of a lib read fn with a `DbClient = prisma` default param and an integration test sibling.

### Create

- `src/lib/player-profile.ts` (server-only header).
- `src/lib/player-profile.integration.test.ts` (`// @vitest-environment node`).

### Implementation

Decide & document the canonical definitions at the top of the file as exported constants/helpers so feature 10 imports them:

- **CORRECTED (2026-09-10).** This task originally specified **Win** = `ratingChange > 0`, **Loss** = `ratingChange < 0`, **Draw** = `ratingChange === 0`. That rule is **wrong** and was live on `/league` and `GET /api/v1/leaderboard`. Elo moves both players on a draw unless their ratings are exactly equal (draw at 1200 v 1000 gives -8 / +8), so it counted a draw as a **win** for the underdog and a **loss** for the favourite. The task's own parenthetical — "a draw between equal-rated players yields 0" — states the condition without following it through.
- The outcome is read from the **recorded score**: `recordGame` writes `{ A: [1,0], B: [0,1], draw: [0,0] }`, so comparing `teamAScore`/`teamBScore` against the participant's `team` is unambiguous and survives any change to the rating algorithm. Implemented once in `src/lib/game-outcome.ts` (`outcomeFor` for a single row, `countOutcomes` for in-query aggregation); feature 10 must import from there rather than re-deriving.

```ts
export interface PlayerProfile {
  id: string;
  username: string;
  currentRating: number;
  memberSince: string;       // ISO
  rank: number;              // 1-based; count of users with a strictly higher rating + 1
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
}

export async function getPlayerProfile(
  username: string,
  client: DbClient = prisma,
): Promise<PlayerProfile | null> { /* ... */ }
```

- Resolve the user by `username` (unique). Return `null` if not found (caller maps to 404 / not-found UI).
- Aggregate W/L/draw/total **in the query** — a `groupBy`/aggregate over `GameParticipant where userId = ...`, or a single raw query. Do **not** load all participations into JS.
- `rank` = `(count of User where currentRating > thisUser.currentRating) + 1`. Note ties share the higher rank number under this definition — acceptable; document it.
- Wrap the body in `Sentry.startSpan({ name: 'Get player profile' }, ...)`.
- `DbClient` type: import from `src/lib/matchmaking/state.ts` if exported there, else define a local alias consistent with existing lib modules.

### Tests

Use `createTestDatabase` + `db.reset()` (there is no `withRollback` helper) with the `createUser` / `createGameResult` factories. Cases:

1. Unknown username → `null`.
2. New user, no games → rating 1000, rank reflects others, all counts 0.
3. User with mixed results (wins, losses, a draw) → exact W/L/draw/total.
4. Rank: three users at ratings 1200/1100/1000 → ranks 1/2/3; a fourth at 1100 (tie) → document/assert the tie behaviour.
5. `memberSince` equals the user's `createdAt` as ISO.

### Acceptance criteria

- All cases pass; aggregation is in-query (no full-array client-side counting).
- W/L/draw constants/helpers are exported for reuse by feature 10.
- No `for` loops (CLAUDE.md). `npm run check` clean.

---

## T2 — Server fn wrapper

**Status:** pending
**Depends on:** T1
**Blocks:** T3

### Context

Thin `createServerFn` wrapper over `getPlayerProfile`, following the file's existing patterns.

### Read first

- `src/routes/match.tsx` server fns + `authenticatedUser()` usage (or `src/lib/auth.ts` if feature 6's T2 has landed — prefer the shared helper if available).
- CLAUDE.md §"`createServerFn` Pattern" (static imports at top of file).

### Implementation

In the new route file (T3) or a colocated module, add:

```ts
export const getPlayerProfileFn = createServerFn({ method: 'GET' })
  .inputValidator((data: { username: string }) => data)
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: 'Player profile' }, async () => {
      await authenticatedUser(); // gate to signed-in users; confirm policy in T1/plan open questions
      return getPlayerProfile(data.username);
    });
  });
```

- `method: 'GET'` — pure read, preload-safe.
- Static import `getPlayerProfile` at the top of the file (the server-fn split keeps it out of the client bundle).

### Acceptance criteria

- `npm run build` succeeds; grep the client bundle for `@prisma`/`PrismaClient` → zero matches (CLAUDE.md verification).
- `npm run check` clean.

---

## T3 — Profile route + UI + mount slots

**Status:** pending
**Depends on:** T2
**Blocks:** T4

### Context

The `/player/$username` route rendering identity + headline stats, with clearly-marked mount points for match history (feature 8) and the rating chart (feature 9).

### Read first

- `src/routes/league.tsx` and `src/routes/match.tsx` — visual language (slate gradients, `storybook/` primitives, heading style) to match.
- `src/components/SignInGate.tsx` — gating pattern.
- TanStack Router dynamic-segment routing (`$username`) — see existing `createFileRoute` usage.

### Create

- `src/routes/player.$username.tsx` (confirm the exact file-route filename convention against `routeTree.gen.ts` patterns — do not hand-edit `routeTree.gen.ts`).

### Implementation

- Route with `ssr: 'data-only'`, a `loader` calling `getPlayerProfileFn({ data: { username } })`, behind `SignInGate` (match feature plan's gating decision).
- Render: username + member-since header; a headline stat row (current rating, rank, W / L / D, games played) using the existing card/pill styling.
- **Mount slots**: two clearly-commented placeholder regions —
  ```tsx
  {/* MOUNT: match history — feature 8 (<MatchHistory username=... />) */}
  {/* MOUNT: rating progression chart — feature 9 (<RatingChart username=... />) */}
  ```
  Render nothing (or a muted "Coming soon" is acceptable) until those features land.
- **Not-found**: when the loader returns `null`, render a clean "Player not found" state (don't throw an unstyled error).

### Tests

If component testing is set up (it is — `@testing-library/react` present), add a light render test of the profile component with a mock `PlayerProfile`: renders rating, rank, W/L/D; renders the not-found state when given `null`. Keep it to presentation; the data logic is covered in T1.

### Acceptance criteria

- Visiting `/player/<existing-username>` while signed in shows correct stats.
- Visiting an unknown username shows the not-found state.
- Mount slots are present and clearly labelled for features 8/9.
- `npm run build` + `npm run check` clean.

---

## T4 — Verification + commit

**Status:** pending
**Depends on:** T3
**Blocks:** nothing

### Pre-commit checklist (in order)

1. `npm run format`
2. `npm run check`
3. `npm run build` (catches client/server bundle leaks)
4. `npm run test`
5. `npm run test:integration` (Docker)

### Manual verification

1. `npm run dev`, sign in, `npm run db:seed` (or create users + record a few games).
2. Visit `/player/<seeded-username>` — verify rating, rank, and W/L/D match the seeded data.
3. Cross-check rank against `/league` ordering — they must agree.
4. Visit an unknown username — not-found state.
5. Sign out — confirm the gate behaviour matches the plan.

### Branch & PR

- Branch `feature-7-player-profile-agent-<short-id>`.
- If `package-lock.json` regenerated, run `npm ci` (not install).
- PR title e.g. "feat: player profile page". Body references the plan and notes the mount slots awaiting features 8 & 9.

### Acceptance criteria

- All checks green; manual smoke passes; profile rank agrees with leaderboard ordering.

---

## Out of scope (do not bundle)

- Match history list (feature 8) and rating chart (feature 9) — only their mount slots.
- Profile editing, avatars, bios, social/follow.
- "This is me" owner actions (settings, API-key management — that's feature 6).

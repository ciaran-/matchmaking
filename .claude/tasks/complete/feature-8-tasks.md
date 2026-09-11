# Feature 8 — Match History: Task List

Plan: `.claude/plans/complete/feature-8-match-history.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

Renders **on the player profile** (feature 7) — feature 7 must be merged first (it provides the route, the `username` identifier convention, and the mount slot). **1v1 only** for v1 (confirmed scope decision).

---

## Dependency graph

```
[feature 7 merged] ──> T1 (getPlayerMatchHistory lib fn + pagination) ──> T2 (server fn) ──> T3 (<MatchHistory /> + mount) ──> T4 (verify + commit)
```

### Parallelism

- **T3's component** can be drafted against the `MatchHistoryPage` type (specified in T1) with a mock fixture while T1/T2 are in flight.

### Strict ordering

(feature 7) → T1 → T2 → T3 → T4.

---

## Pre-flight (do once)

1. Read `.claude/plans/complete/feature-8-match-history.md` and `feature-7-player-profile.md` (for the profile mount slot + identifier convention).
2. Read `CLAUDE.md` — **`createServerFn` Pattern**, **Sentry Instrumentation**, **Testing**, **Code Style**.
3. Confirm feature 7 is merged to `main` (the profile route + `getPlayerProfileFn` exist). Confirm `npm run build`/`test`/`test:integration` pass.
4. No schema changes required.
5. Branch: `feature-8-match-history-agent-<short-id>`.

**Key facts**: `GameResult` has `mode` (`ONE_VS_ONE`|`TEAM_VS_TEAM`), `teamAScore`, `teamBScore`, `createdAt`. `GameParticipant` has `userId`, `team` (`A`|`B`), `ratingBefore/After/Change`, FK to `GameResult`. For 1v1, a `GameResult` has exactly two participants on opposite teams. Indexes present: `GameParticipant @@index([userId])`, `GameResult @@index([mode, createdAt])`.

---

## T1 — `getPlayerMatchHistory` lib fn (paginated)

**Status:** pending
**Depends on:** feature 7 merged
**Blocks:** T2, T3

### Context

A paginated, newest-first log of a player's completed games, each row resolving the **opponent** and the **result from this player's perspective**. 1v1 only.

### Read first

- `schema.prisma` — `GameResult`, `GameParticipant`, `Team`.
- `src/lib/player-profile.ts` (feature 7) — reuse its `DbClient` alias, the username→user resolution, and the canonical W/L/draw helper for "result from perspective".
- `src/test/factories/game-result.ts` — `createGameResult` (creates participants; supports `createdAt` override).

### Create

- `src/lib/match-history.ts` (server-only header).
- `src/lib/match-history.integration.test.ts` (`// @vitest-environment node`).

### Implementation

```ts
export interface MatchHistoryRow {
  gameResultId: string;
  playedAt: string;            // ISO (GameResult.createdAt)
  mode: 'ONE_VS_ONE' | 'TEAM_VS_TEAM';
  opponentUsername: string;
  opponentId: string;
  outcome: 'win' | 'loss' | 'draw';   // from THIS player's perspective
  ratingChange: number;        // signed, this player's
  ratingAfter: number;         // this player's resulting rating
}

export interface MatchHistoryPage {
  rows: MatchHistoryRow[];
  nextCursor: string | null;   // opaque; null when no more
}

export async function getPlayerMatchHistory(
  username: string,
  opts: { cursor?: string; limit?: number } = {},
  client: DbClient = prisma,
): Promise<MatchHistoryPage | null> { /* ... */ }
```

- Resolve `username → user`; return `null` if unknown (caller → not-found; in practice the profile page guarantees the user exists, but be defensive).
- Query this player's `GameParticipant` rows joined to `GameResult`, ordered by `GameResult.createdAt DESC` (tie-break on `gameResultId` for stable cursoring). Filter `mode = 'ONE_VS_ONE'` for v1 (the plan scopes v1 to 1v1; guard explicitly rather than mis-rendering team games).
- For each game, fetch the **other** participant (opposite `team`) to get `opponentId`/`opponentUsername`. Avoid N+1: fetch the page of games, collect the game ids, then load all participants for those games in one query and pair them up in JS (`.map`/`.filter`, no `for` loops).
- `outcome` via the canonical helper (`ratingChange > 0` win / `< 0` loss / `=== 0` draw) from feature 7.
- **Pagination**: cursor encodes `(createdAt, gameResultId)` of the last row. `limit` default e.g. 20, clamp to a max (e.g. 100). `nextCursor` null when fewer than `limit` rows returned.
- Wrap in `Sentry.startSpan({ name: 'Player match history' }, ...)`.

### Tests

`withRollback` + factories. Cases:

1. Unknown username → `null`.
2. Player with no games → `{ rows: [], nextCursor: null }`.
3. Three games (win, loss, draw) → rows newest-first, each with correct opponent, outcome, signed `ratingChange`, `ratingAfter`.
4. Opponent resolution: player on team B → opponent is the team-A participant, and vice versa.
5. Pagination: 5 games, `limit: 2` → page 1 has 2 rows + cursor; following the cursor yields the next 2; final page has 1 row + `nextCursor: null`. No row appears twice or is skipped.
6. A `TEAM_VS_TEAM` game in the DB is excluded from v1 results.
7. No N+1: (optional) assert via query spy that opponents are loaded in a bounded number of queries.

### Acceptance criteria

- All cases pass; opponent resolution correct; pagination stable.
- 1v1-only guard in place; team games excluded.
- No `for` loops; `npm run check` clean.

---

## T2 — Server fn wrapper

**Status:** pending
**Depends on:** T1
**Blocks:** T3

### Read first

- `src/routes/player.$username.tsx` (feature 7) — colocate the new server fn here or in a sibling module per the file's pattern.
- CLAUDE.md §"`createServerFn` Pattern".

### Implementation

```ts
export const getPlayerMatchHistoryFn = createServerFn({ method: 'GET' })
  .inputValidator((d: { username: string; cursor?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: 'Match history' }, async () => {
      await authenticatedUser();
      return getPlayerMatchHistory(data.username, { cursor: data.cursor, limit: data.limit });
    });
  });
```

- `method: 'GET'`; static import at top of file.

### Acceptance criteria

- `npm run build` clean; client bundle free of `@prisma`/`PrismaClient`.
- `npm run check` clean.

---

## T3 — `<MatchHistory />` component + mount on profile

**Status:** pending
**Depends on:** T2
**Blocks:** T4

### Context

Render the history as a section in feature 7's mount slot, with "load more" pagination.

### Read first

- `src/routes/player.$username.tsx` — the `{/* MOUNT: match history ... */}` slot.
- `src/components/LeagueActivity.tsx` — example component + its `.test.tsx` for the testing pattern.
- Visual language in `league.tsx`/`match.tsx`.

### Create

- `src/components/MatchHistory.tsx`
- `src/components/MatchHistory.test.tsx`

### Implementation

- Props: `{ username: string }`. Fetch via `useQuery` calling `getPlayerMatchHistoryFn`, with "load more" appending pages (`useInfiniteQuery` is the natural fit given `nextCursor`).
- Each row: opponent username **linked to `/player/<opponentUsername>`** (feature 7), outcome badge (win=green / loss=red / draw=neutral), signed `ratingChange` (e.g. `+12` / `−8`), resulting rating, relative or absolute timestamp, mode label.
- States: loading skeleton; empty ("No games yet"); error (muted "Couldn't load match history", don't leak `error.message`); "Load more" button hidden when `nextCursor` is null.
- Mount in feature 7's profile slot: `<MatchHistory username={username} />`, replacing the placeholder comment.

### Tests (`MatchHistory.test.tsx`)

With a mock `MatchHistoryPage`: renders one row per entry with correct outcome styling and signed delta; opponent links to the right profile path; empty state; error state doesn't render the raw message.

### Acceptance criteria

- Section renders on the profile with correct data and working "load more".
- Opponent links navigate to their profiles.
- `npm run build` + `npm run check` clean.

---

## T4 — Verification + commit

**Status:** pending
**Depends on:** T3

### Pre-commit checklist (in order)

1. `npm run format` 2. `npm run check` 3. `npm run build` 4. `npm run test` 5. `npm run test:integration` (Docker)

### Manual verification

1. `npm run dev`, sign in, seed/record several 1v1 games for one user (varied outcomes).
2. Open that user's profile → history section shows games newest-first with correct opponent, outcome, and signed rating delta.
3. Click an opponent → lands on their profile (and their history shows the mirror result).
4. With > one page of games, "load more" appends without duplicates/gaps.
5. Empty case: a brand-new user shows the empty state.

### Branch & PR

- Branch `feature-8-match-history-agent-<short-id>`. `npm ci` if the lockfile regenerated.
- PR title e.g. "feat: per-player match history on profile". Body references the plan and notes 1v1-only scope + the `TEAM_VS_TEAM`/filtering follow-ups.

### Acceptance criteria

- All checks green; manual smoke passes; mirror results are consistent between the two players.

---

## Out of scope (do not bundle)

- Per-game expanded detail (per-round stats — schema slots are unused).
- Filtering by opponent/mode/date.
- A global "recent games across the league" feed.
- `TEAM_VS_TEAM` rendering (deferred until team matchmaking exists).
- Dispute/correction actions (competitive-integrity roadmap).

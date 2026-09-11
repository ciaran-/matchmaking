# Integration Testing Infrastructure

## Goal

Supplement existing unit tests with integration tests that run business logic against a real PostgreSQL database. Tests live in `*.integration.test.ts` files, run separately from unit tests via a dedicated npm script and CI job.

Integration tests target the **lib layer** (`src/lib/`) — framework-agnostic, covering both the current server function wiring and the future REST API without change.

---

## Phase 1: Docker / Testcontainers Setup

### 1a. Install dependencies

```bash
npm install --save-dev @testcontainers/postgresql testcontainers
```

### 1b. Shared DB helpers (`src/test/db.ts`)

Create a module that:
- Spins up a PostgreSQL container via testcontainers
- Applies Prisma migrations against it (`prisma migrate deploy`)
- Returns a configured `PrismaClient` pointed at the container
- Exports a `withRollback(prisma, fn)` helper that wraps each test in a transaction that gets rolled back — keeps tests isolated without truncating tables

Lifecycle: one container per test file (via `beforeAll` / `afterAll`), one rolled-back transaction per test case (via `beforeEach` / `afterEach`).

### 1c. Vitest configuration

Add a second Vitest config (`vitest.integration.config.ts`) that:
- Includes only `**/*.integration.test.ts` files
- Sets a longer timeout (container startup can take ~10s on a cold pull)
- Uses `--pool=forks` (testcontainers requires a real process, not threads)

Add npm script:

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

The existing `npm test` continues to run only unit tests (no change to its include pattern).

### 1d. CI job

Add an `integration-test` job to `.github/workflows/ci.yml`. `ubuntu-latest` runners ship with Docker pre-installed and the daemon running — no special runner configuration needed.

```yaml
integration-test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '24.11.x'
        cache: npm
    - run: npm ci
    - run: npm run test:integration
```

---

## Phase 2: Test Factories

Create `src/test/factories/` with one file per domain object. Each factory accepts a `PrismaClient` and a partial override object, writes to the DB, and returns the created record.

### `src/test/factories/user.ts`

Defaults: `username` generated from a counter, `currentRating: 1000`.

```ts
createUser(prisma, overrides?: Partial<UserCreateInput>): Promise<User>
```

### `src/test/factories/game-result.ts`

Creates a `GameResult` with its `GameParticipant` rows in one call. Accepts participant specs (userId, team, ratingBefore/After/Change) as an array alongside the game-level fields.

```ts
createGameResult(prisma, overrides?: {...}): Promise<GameResult & { participants: GameParticipant[] }>
```

Factories are intentionally designed to be reusable from future HTTP-level tests (same DB, same data setup, different call site).

---

## Phase 3: Scenario Seed Helpers

Create `src/test/scenarios.ts` with composable named scenarios that use the factories:

- `twoEqualRatedPlayers(prisma)` — creates two users, both at rating 1000, returns them
- `twoUnequalRatedPlayers(prisma, ratingA, ratingB)` — same, with specified ratings

These keep individual test bodies focused on assertions rather than setup boilerplate.

---

## Phase 4: Integration Tests for `record-game`

Create `src/lib/record-game.integration.test.ts` as the pilot integration test file.

**Cases to cover:**

- 1v1 game: winner's rating increases, loser's decreases, delta is symmetric
- 1v1 game: `GameResult` row created with correct mode, scores, and participant join rows
- 1v1 game: `ratingBefore` on each participant matches the user's `currentRating` at time of call
- Rating upset: lower-rated player wins, verify Elo moves as expected
- Team vs team: ratings updated for all participants on both sides

Each test uses `withRollback` — no manual cleanup needed.

---

## Out of Scope (this phase)

- HTTP-level tests for server function endpoints (awkward: hashed URLs, TanStack-specific request format)
- HTTP-level tests for REST API endpoints — deferred until the API exists; will reuse the same DB container setup and factories from this phase
- UI / browser integration tests

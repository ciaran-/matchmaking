# Integration Testing Infrastructure — Task List

Plan: `.claude/plans/integration-testing-infrastructure.md`

## Background

This work adds integration tests that run business logic against a real PostgreSQL database,
using testcontainers to spin up an ephemeral container per test file. Tests live in
`*.integration.test.ts` files and run separately from the existing unit tests (which mock
Prisma and must stay untouched).

The pilot integration test covers `src/lib/record-game.ts` — the function that records a
game result, updates Elo ratings, and writes to three tables atomically.

All integration tests call lib functions directly (not via HTTP) — this is intentional and
framework-agnostic, so the same tests will work whether the lib is invoked from a TanStack
Start server function or a future REST API endpoint.

---

## Dependency graph

```
Task 1: Core infra (src/test/db.ts + vitest config + npm script)   [no deps]
    ├── Task 2: CI job                                               [parallel with Task 3]
    └── Task 3: Test factories                                       [parallel with Task 2]
            └── Task 4: Scenario seed helpers
                    └── Task 5: record-game integration tests
                            └── Task 6: Verification
```

Tasks 2 and 3 write to entirely different files and can be assigned to separate agents
simultaneously once Task 1 is complete.

---

## Task 1 — Core test infrastructure

**Status:** pending
**Depends on:** nothing
**Blocks:** Tasks 2, 3

### Context

Everything else depends on this. It installs testcontainers, creates the shared DB helper
that integration tests import to get a real Postgres connection, and sets up a separate
Vitest config so integration tests run under their own settings (longer timeouts, `forks`
pool) without polluting the existing unit test run.

### Read first

- `package.json` — understand existing scripts and devDependencies before modifying
- `schema.prisma` (at the repo root, not in a `prisma/` subdirectory) — three models:
  `User`, `GameResult`, `GameParticipant`; migrations live in `./migrations/`
- `.github/workflows/ci.yml` — current CI setup (Task 2 will extend this)

### Install

```bash
npm install --save-dev testcontainers @testcontainers/postgresql
```

### Create: `src/test/db.ts`

This module is the single source of truth for spinning up and tearing down the test
database. Every integration test file will import from here.

```ts
// @vitest-environment node
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from '@prisma/client'
import { execSync } from 'node:child_process'

export interface TestDatabase {
	prisma: PrismaClient
	/** Delete all rows in FK-safe order. Call in beforeEach. */
	reset: () => Promise<void>
	/** Disconnect Prisma and stop the container. Call in afterAll. */
	teardown: () => Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
	const container = await new PostgreSqlContainer('postgres:16-alpine').start()
	const url = container.getConnectionUri()

	// Apply all migrations from ./migrations/ against the container.
	// schema.prisma is at the repo root (not ./prisma/schema.prisma).
	execSync('npx prisma migrate deploy --schema=./schema.prisma', {
		env: { ...process.env, DATABASE_URL: url },
		stdio: 'pipe',
	})

	const prisma = new PrismaClient({ datasources: { db: { url } } })

	return {
		prisma,
		reset: async () => {
			// Delete children before parents to satisfy FK constraints.
			await prisma.gameParticipant.deleteMany()
			await prisma.gameResult.deleteMany()
			await prisma.user.deleteMany()
		},
		teardown: async () => {
			await prisma.$disconnect()
			await container.stop()
		},
	}
}
```

### Create: `vitest.integration.config.ts` (at repo root)

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
	test: {
		include: ['src/**/*.integration.test.ts'],
		// testcontainers requires real child processes, not worker threads.
		pool: 'forks',
		// Container startup can take ~10–15s on a cold image pull.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
	resolve: {
		alias: {
			'@': resolve(import.meta.dirname, './src'),
		},
	},
})
```

Note: this config does NOT import from `vite.config.ts` — that file pulls in TanStack Start
and Netlify plugins that have no place in a test runner context.

### Modify: `package.json`

Add one script alongside the existing `"test"` entry:

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

The existing `"test": "vitest run"` must not be changed — it runs unit tests only.

### Acceptance criteria

- `npm install` completes without errors
- `npm test` still passes (unit tests unaffected)
- `npm run test:integration` exits with code 0 when no integration test files exist yet
  (vitest exits cleanly when the include pattern matches nothing)
- `npm run check` (Biome) passes on the new files

---

## Task 2 — CI job

**Status:** pending
**Depends on:** Task 1 (the `test:integration` npm script must exist)
**Blocks:** Task 6

### Context

The existing CI has three jobs: `test`, `lint`, `build`. Add a fourth: `integration-test`.

`ubuntu-latest` GitHub Actions runners ship with Docker pre-installed and the daemon
running — testcontainers works out of the box, no special runner configuration or
service containers required.

### Read first

- `.github/workflows/ci.yml` — read the full file before modifying; match the style of
  the existing jobs exactly

### Modify: `.github/workflows/ci.yml`

Add the following job. Place it after the existing `build` job:

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

Indentation: the existing jobs use 2-space indentation — match it.

### Acceptance criteria

- The YAML is valid (the existing jobs are not broken)
- The new `integration-test` job appears alongside `test`, `lint`, `build` in CI

---

## Task 3 — Test factories

**Status:** pending
**Depends on:** Task 1 (`src/test/db.ts` must exist so factories can be imported alongside it)
**Blocks:** Task 4

### Context

Factories are helper functions that insert a single domain object into the test database
with sensible defaults, accepting an optional overrides object so individual tests only
declare the fields they care about.

There are three models in the schema (`User`, `GameResult`, `GameParticipant`). `GameParticipant`
has no standalone factory — it is always created inline as part of a `GameResult` via
Prisma's nested `create`.

### Key schema facts (read `schema.prisma` to verify before writing)

**User:**
- `id` — auto-generated cuid, never set manually
- `clerkId` — `String? @unique` (nullable; test users don't need a real Clerk ID)
- `email` — `String @unique` (required; generate a unique value per call)
- `username` — `String @unique` (required; generate a unique value per call)
- `currentRating` — `Int @default(1000)`

**GameResult:**
- `id` — auto-generated cuid
- `mode` — `GameMode` enum: `ONE_VS_ONE` | `TEAM_VS_TEAM`
- `teamAScore`, `teamBScore` — `Int`
- `participants` — relation to `GameParticipant[]` (created via nested `create`)

**GameParticipant:**
- Composite PK: `[gameResultId, userId]`
- `team` — `Team` enum: `A` | `B`
- `ratingBefore`, `ratingAfter`, `ratingChange` — `Int`

### Create: `src/test/factories/user.ts`

```ts
import type { PrismaClient, User } from '@prisma/client'

let counter = 0

interface UserOverrides {
	clerkId?: string | null
	email?: string
	username?: string
	currentRating?: number
}

export async function createUser(
	prisma: PrismaClient,
	overrides: UserOverrides = {},
): Promise<User> {
	counter++
	return prisma.user.create({
		data: {
			clerkId: overrides.clerkId !== undefined ? overrides.clerkId : null,
			email: overrides.email ?? `testuser${counter}@test.local`,
			username: overrides.username ?? `testuser${counter}`,
			currentRating: overrides.currentRating ?? 1000,
		},
	})
}
```

The `counter` is module-level and never resets — within a test run it always produces
unique values, so the unique constraints on `email` and `username` are never violated
even across multiple tests in the same file.

### Create: `src/test/factories/game-result.ts`

```ts
import type {
	GameMode,
	GameParticipant,
	GameResult,
	PrismaClient,
} from '@prisma/client'

interface ParticipantSpec {
	userId: string
	team: 'A' | 'B'
	ratingBefore: number
	ratingAfter: number
	ratingChange: number
}

interface GameResultOverrides {
	mode?: GameMode
	teamAScore?: number
	teamBScore?: number
	participants?: ParticipantSpec[]
}

export async function createGameResult(
	prisma: PrismaClient,
	overrides: GameResultOverrides = {},
): Promise<GameResult & { participants: GameParticipant[] }> {
	return prisma.gameResult.create({
		data: {
			mode: overrides.mode ?? 'ONE_VS_ONE',
			teamAScore: overrides.teamAScore ?? 1,
			teamBScore: overrides.teamBScore ?? 0,
			participants: overrides.participants
				? { create: overrides.participants }
				: { create: [] },
		},
		include: { participants: true },
	})
}
```

### Acceptance criteria

- `npm run check` passes on both new files
- TypeScript compiles cleanly (no `tsc --noEmit` errors)
- `npm test` (unit tests) still passes — the factories don't import anything that would
  affect the existing test suite

---

## Task 4 — Scenario seed helpers

**Status:** pending
**Depends on:** Task 3
**Blocks:** Task 5

### Context

Scenarios compose factories into named, reusable setups so individual test cases don't
repeat boilerplate. A test that cares about an upset win shouldn't have to spell out two
`createUser` calls with specific ratings — it should just call `twoUnequalRatedPlayers`.

### Read first

- `src/test/factories/user.ts` (Task 3 output) — understand `createUser` signature before using it

### Create: `src/test/scenarios.ts`

```ts
import type { PrismaClient, User } from '@prisma/client'
import { createUser } from './factories/user'

/**
 * Two players both at rating 1000. The canonical baseline for testing
 * symmetric Elo outcomes.
 */
export async function twoEqualRatedPlayers(
	prisma: PrismaClient,
): Promise<[User, User]> {
	const playerA = await createUser(prisma, { currentRating: 1000 })
	const playerB = await createUser(prisma, { currentRating: 1000 })
	return [playerA, playerB]
}

/**
 * Two players at explicitly specified ratings. Use when the test is about
 * how Elo handles an imbalance (e.g. an upset, a dominant favourite).
 */
export async function twoUnequalRatedPlayers(
	prisma: PrismaClient,
	ratingA: number,
	ratingB: number,
): Promise<[User, User]> {
	const playerA = await createUser(prisma, { currentRating: ratingA })
	const playerB = await createUser(prisma, { currentRating: ratingB })
	return [playerA, playerB]
}
```

### Acceptance criteria

- `npm run check` passes
- TypeScript compiles cleanly

---

## Task 5 — Integration tests for `record-game`

**Status:** pending
**Depends on:** Task 4
**Blocks:** Task 6

### Context

This is the pilot integration test file. It calls `recordGame()` directly against a real
PostgreSQL database (via testcontainers) and asserts both the return value and the actual
database state.

`recordGame` lives in `src/lib/record-game.ts`. It:
1. Fetches both players by ID
2. Calculates Elo changes via `calculateElo1v1`
3. Writes a `GameResult`, two `GameParticipant` rows, and two `User` rating updates in
   a single `prisma.$transaction`
4. Returns `{ gameResult, ratingChangeA, ratingChangeB }`

The Elo function (`src/lib/elo.ts`) uses a K-factor of 32. For two equal-rated players,
a win produces `changeA = +16, changeB = -16`. For unequal players the changes are
asymmetric — the upset (lower-rated wins) produces a larger swing.

This file must NOT mock `@/db`. That is the whole point: we are verifying real DB writes.

### Read first

- `src/lib/record-game.ts` — full implementation; understand inputs, outputs, and what
  it writes to each table
- `src/lib/elo.ts` — understand `calculateElo1v1` return type `{ changeA, changeB }`
  and the K-factor constant `K_FACTOR = 32`
- `src/test/db.ts` (Task 1) — `createTestDatabase` and `TestDatabase` interface
- `src/test/scenarios.ts` (Task 4) — `twoEqualRatedPlayers`, `twoUnequalRatedPlayers`

### Create: `src/lib/record-game.integration.test.ts`

#### File structure

```ts
// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@/test/db'
import { twoEqualRatedPlayers, twoUnequalRatedPlayers } from '@/test/scenarios'
import { recordGame } from './record-game'

let db: TestDatabase

beforeAll(async () => {
	db = await createTestDatabase()
}, 60_000)

beforeEach(async () => {
	await db.reset()
})

afterAll(async () => {
	await db.teardown()
})

describe('recordGame', () => {
	// tests go here
})
```

#### Test cases

Write all tests inside the `describe('recordGame', ...)` block.

**1. A wins — ratings move in the right direction (equal players)**

```ts
it('increases winner rating and decreases loser rating when A wins', async () => {
	const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma)

	const { ratingChangeA, ratingChangeB } = await recordGame({
		playerAId: playerA.id,
		playerBId: playerB.id,
		result: 'A',
	})

	expect(ratingChangeA).toBeGreaterThan(0)
	expect(ratingChangeB).toBeLessThan(0)

	const updatedA = await db.prisma.user.findUniqueOrThrow({ where: { id: playerA.id } })
	const updatedB = await db.prisma.user.findUniqueOrThrow({ where: { id: playerB.id } })

	expect(updatedA.currentRating).toBe(playerA.currentRating + ratingChangeA)
	expect(updatedB.currentRating).toBe(playerB.currentRating + ratingChangeB)
})
```

**2. B wins — ratings move in the right direction**

Same structure; `result: 'B'`; assert `ratingChangeA < 0` and `ratingChangeB > 0`.

**3. Draw between equal players — neither rating changes**

`result: 'draw'`; assert `ratingChangeA === 0` and `ratingChangeB === 0`; assert both
`currentRating` values in the DB are unchanged.

**4. GameResult row is created with correct data**

```ts
it('creates a GameResult row with correct mode and scores', async () => {
	const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma)

	const { gameResult } = await recordGame({
		playerAId: playerA.id,
		playerBId: playerB.id,
		result: 'A',
	})

	const row = await db.prisma.gameResult.findUniqueOrThrow({
		where: { id: gameResult.id },
		include: { participants: true },
	})

	expect(row.mode).toBe('ONE_VS_ONE')
	expect(row.teamAScore).toBe(1)
	expect(row.teamBScore).toBe(0)
	expect(row.participants).toHaveLength(2)
})
```

**5. GameParticipant rows have correct team assignment**

Using the `row` from the previous pattern (or a fresh call), find each participant and assert:
- The participant whose `userId === playerA.id` has `team === 'A'`
- The participant whose `userId === playerB.id` has `team === 'B'`

**6. `ratingBefore` reflects the players' ratings at call time**

```ts
it('records ratingBefore matching the players currentRating at the time of the call', async () => {
	const [playerA, playerB] = await twoUnequalRatedPlayers(db.prisma, 1200, 800)

	const { gameResult } = await recordGame({
		playerAId: playerA.id,
		playerBId: playerB.id,
		result: 'A',
	})

	const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
		where: { id: gameResult.id },
		include: { participants: true },
	})

	const pA = participants.find((p) => p.userId === playerA.id)!
	const pB = participants.find((p) => p.userId === playerB.id)!

	expect(pA.ratingBefore).toBe(1200)
	expect(pB.ratingBefore).toBe(800)
})
```

**7. `ratingAfter = ratingBefore + ratingChange` for both participants**

Using the same `participants` array from the previous pattern, assert:
- `pA.ratingAfter === pA.ratingBefore + pA.ratingChange`
- `pB.ratingAfter === pB.ratingBefore + pB.ratingChange`

This can be its own test or combined with test 6 — your call, but keep it legible.

**8. Upset: lower-rated player wins, change is larger than expected**

```ts
it('produces a larger rating swing when the lower-rated player wins (upset)', async () => {
	// playerB is rated 400 points below playerA
	const [playerA, playerB] = await twoUnequalRatedPlayers(db.prisma, 1200, 800)

	const { ratingChangeA, ratingChangeB } = await recordGame({
		playerAId: playerA.id,
		playerBId: playerB.id,
		result: 'B', // underdog wins
	})

	// The upset should produce a bigger swing than a win by the favourite (16)
	expect(ratingChangeB).toBeGreaterThan(16)
	expect(ratingChangeA).toBeLessThan(-16)
})
```

**9. Sequential games use updated ratings**

```ts
it('uses updated ratings as ratingBefore for a subsequent game', async () => {
	const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma)

	// First game
	await recordGame({ playerAId: playerA.id, playerBId: playerB.id, result: 'A' })

	// Fetch updated state
	const updatedA = await db.prisma.user.findUniqueOrThrow({ where: { id: playerA.id } })
	const updatedB = await db.prisma.user.findUniqueOrThrow({ where: { id: playerB.id } })

	// Second game
	const { gameResult } = await recordGame({
		playerAId: playerA.id,
		playerBId: playerB.id,
		result: 'B',
	})

	const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
		where: { id: gameResult.id },
		include: { participants: true },
	})
	const pA = participants.find((p) => p.userId === playerA.id)!
	const pB = participants.find((p) => p.userId === playerB.id)!

	expect(pA.ratingBefore).toBe(updatedA.currentRating)
	expect(pB.ratingBefore).toBe(updatedB.currentRating)
})
```

### Acceptance criteria

- All tests pass: `npm run test:integration`
- `npm test` (unit tests) still passes — no mocks were removed or changed
- `npm run check` passes

---

## Task 6 — Verification

**Status:** pending
**Depends on:** Tasks 1–5
**Blocks:** nothing (PR-ready after this)

### Automated checks

Run all of these in order. All must pass.

```bash
npm test                   # unit tests — must not regress
npm run test:integration   # integration tests — all must pass
npm run check              # Biome lint + format
npm run build              # production build
npm ci                     # validates lockfile is clean
```

### Manual check

Inspect the testcontainers output: confirm the container is started and stopped cleanly
(no orphaned processes or containers) by running `docker ps` after `npm run test:integration`
completes — the list should be empty (or not include a postgres container from this run).

### Known things to watch for

**Container startup on first run:** The `postgres:16-alpine` image pull takes ~20s the
first time. Subsequent runs use the local Docker cache and are fast (~2s). This is expected.

**Prisma generate:** If `@prisma/client` types don't match `schema.prisma`, run
`npm run db:generate` locally. CI runs `npm ci` which installs from lockfile but does not
auto-generate the client — the generated client is committed (in `node_modules/.prisma`
after `npm ci`). If types are stale, the build step will catch it.

**Schema path:** `schema.prisma` is at the repo root, not `prisma/schema.prisma`.
The `--schema=./schema.prisma` flag in `src/test/db.ts` handles this for `migrate deploy`.
If you see a "schema not found" error, this is the first thing to check.

# Feature 3 — Record Game Result: Task List

Plan: `.claude/plans/feature-3-record-game-result.md`

---

## Dependency graph

```
Task 1: src/lib/record-game.ts          (no dependencies)
    ├── Task 2: record-game.test.ts     ─┐ independent of each other,
    └── Task 3: recordGameFn + imports  ─┘ can run in parallel
            └── Task 4: Modal UI in league.tsx
                    └── Task 5: Verification
```

**Parallelism opportunity:** Tasks 2 and 3 write to different files and can be
assigned to separate agents simultaneously once Task 1 is complete.
Tasks 3 and 4 both modify `league.tsx` and must run sequentially.

---

## Task 1 — Implement `src/lib/record-game.ts`

**Status:** pending
**Depends on:** nothing
**Blocks:** Tasks 2, 3

### Context

This is the core business-logic module for recording a 1v1 game result. It
fetches both players, calculates Elo changes, and writes the result atomically.
It must be server-only (it imports Prisma and Sentry) and must not be imported
directly from client-side code. Tests in Task 2 will mock its dependencies.

### Read first

- `src/lib/elo.ts` — understand `calculateElo1v1` signature and `EloResult` type
- `schema.prisma` — understand `GameResult`, `GameParticipant`, `Team`, `GameMode`
- `src/db.ts` — understand how `prisma` is exported
- `src/lib/sync-user.ts` lines 1-5 — copy the "Server-only module" comment convention

### Create

`src/lib/record-game.ts`

### Implementation

The file must start with:
```typescript
// Server-only module — do not import from client-side code.
```

**Imports:**
```typescript
import * as Sentry from '@sentry/tanstackstart-react'
import type { GameResult } from '@prisma/client'
import { prisma } from '@/db'
import { calculateElo1v1, type EloResult } from './elo'
```

**Exported types:**
```typescript
export interface RecordGameInput {
  playerAId: string  // User.id cuid
  playerBId: string  // User.id cuid
  result: EloResult  // 'A' | 'B' | 'draw'
}

export interface RecordGameOutput {
  gameResult: GameResult
  ratingChangeA: number
  ratingChangeB: number
}
```

**Function signature:**
```typescript
export async function recordGame(input: RecordGameInput): Promise<RecordGameOutput>
```

**Algorithm — implement in this order inside a `Sentry.startSpan({ name: 'Record game result' }, async () => { ... })` wrapper:**

1. Destructure `{ playerAId, playerBId, result }` from `input`.
2. If `playerAId === playerBId`, throw `new Error('playerAId and playerBId must be different')`.
3. Fetch users:
   ```typescript
   const users = await prisma.user.findMany({ where: { id: { in: [playerAId, playerBId] } } })
   if (users.length < 2) throw new Error('One or both players not found')
   const userA = users.find(u => u.id === playerAId)!
   const userB = users.find(u => u.id === playerBId)!
   ```
4. Derive scores:
   - `result === 'A'` → `teamAScore = 1, teamBScore = 0`
   - `result === 'B'` → `teamAScore = 0, teamBScore = 1`
   - `result === 'draw'` → `teamAScore = 0, teamBScore = 0`
5. Call `calculateElo1v1(userA.currentRating, userB.currentRating, result)` → `{ changeA, changeB }`.
6. Compute: `ratingAfterA = userA.currentRating + changeA`, `ratingAfterB = userB.currentRating + changeB`.
7. Run transaction:
   ```typescript
   const [gameResult] = await prisma.$transaction([
     prisma.gameResult.create({
       data: {
         mode: 'ONE_VS_ONE',
         teamAScore,
         teamBScore,
         participants: {
           create: [
             {
               userId: playerAId,
               team: 'A',
               ratingBefore: userA.currentRating,
               ratingAfter: ratingAfterA,
               ratingChange: changeA,
             },
             {
               userId: playerBId,
               team: 'B',
               ratingBefore: userB.currentRating,
               ratingAfter: ratingAfterB,
               ratingChange: changeB,
             },
           ],
         },
       },
     }),
     prisma.user.update({ where: { id: playerAId }, data: { currentRating: ratingAfterA } }),
     prisma.user.update({ where: { id: playerBId }, data: { currentRating: ratingAfterB } }),
   ])
   ```
   Note: only 3 items in the transaction array. The `GameParticipant` rows are
   created via nested `participants.create` inside the first operation.
8. Return `{ gameResult, ratingChangeA: changeA, ratingChangeB: changeB }`.

### Acceptance criteria

- `npm run check` passes (no lint/format errors)
- TypeScript compiles cleanly (`npm run build` in the worktree, or tsc --noEmit)
- The function is not imported anywhere on the client side

---

## Task 2 — Write `src/lib/record-game.test.ts`

**Status:** pending
**Depends on:** Task 1
**Blocks:** Task 5

### Context

Unit tests for `recordGame`. All DB calls must be mocked — do not hit a real
database. The Sentry `startSpan` must also be mocked to a pass-through so tests
don't need a Sentry DSN. This is a server-only test file.

### Read first

- `src/lib/record-game.ts` (Task 1 output) — read the full implementation before writing tests
- `src/lib/sync-user.test.ts` — reference for how `@/db` and external modules are mocked in this project
- `src/lib/elo.test.ts` — reference for test file style and structure

### Create

`src/lib/record-game.test.ts`

### File header and mock setup

```typescript
// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordGame } from './record-game'

// Mock Prisma at the module boundary
const mockFindMany = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockTransaction = vi.fn()

vi.mock('@/db', () => ({
  prisma: {
    user: { findMany: mockFindMany },
    gameResult: { create: mockCreate },
    user: { update: mockUpdate },
    $transaction: mockTransaction,
  },
}))

// Mock Sentry as a pass-through
vi.mock('@sentry/tanstackstart-react', () => ({
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
}))
```

**`beforeEach` setup:**
Reset all mocks and set up default happy-path stubs:
```typescript
beforeEach(() => {
  vi.clearAllMocks()

  // Default: two players found
  mockFindMany.mockResolvedValue([
    { id: 'player-a', username: 'alice', currentRating: 1000 },
    { id: 'player-b', username: 'bob',   currentRating: 1000 },
  ])

  // Default: transaction resolves with a game result as first element
  mockTransaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))

  // Default: gameResult.create resolves with a stub
  mockCreate.mockResolvedValue({ id: 'game-1', mode: 'ONE_VS_ONE', teamAScore: 1, teamBScore: 0 })

  // Default: user.update resolves
  mockUpdate.mockResolvedValue({})
})
```

### Test cases (11 tests)

Write all tests inside `describe('recordGame', () => { ... })`.

**1. A wins, equal ratings**
- Input: `{ playerAId: 'player-a', playerBId: 'player-b', result: 'A' }`
- Assert: `$transaction` called once
- Assert: `gameResult.create` called with `mode: 'ONE_VS_ONE'`, `teamAScore: 1`, `teamBScore: 0`
- Assert: `user.update` called for player-a with `currentRating` equal to `1000 + changeA` where `changeA > 0`
- Assert: `user.update` called for player-b with `currentRating` equal to `1000 + changeB` where `changeB < 0`
- Assert: returned `ratingChangeA > 0` and `ratingChangeB < 0`

**2. B wins, equal ratings**
- Input: `result: 'B'`
- Assert: `teamAScore: 0`, `teamBScore: 1`
- Assert: returned `ratingChangeA < 0`, `ratingChangeB > 0`

**3. Draw, equal ratings**
- Input: `result: 'draw'`
- Assert: `teamAScore: 0`, `teamBScore: 0`
- Assert: returned `ratingChangeA === 0`, `ratingChangeB === 0`

**4. Same player ID throws before any DB call**
- Input: `{ playerAId: 'player-a', playerBId: 'player-a', result: 'A' }`
- Assert: throws with message `'playerAId and playerBId must be different'`
- Assert: `mockFindMany` was NOT called (use `expect(mockFindMany).not.toHaveBeenCalled()`)

**5. Player A not found**
- Override `mockFindMany` to return only player-b
- Assert: throws with message `'One or both players not found'`

**6. Player B not found**
- Override `mockFindMany` to return only player-a
- Assert: throws with message `'One or both players not found'`

**7. Neither player found**
- Override `mockFindMany` to return `[]`
- Assert: throws with message `'One or both players not found'`

**8. Transaction failure propagates**
- Override `mockTransaction` to reject: `mockTransaction.mockRejectedValue(new Error('DB error'))`
- Assert: `recordGame(...)` rejects with an error

**9. `ratingBefore` is the player's rating at call time**
- Use players with non-default ratings: `currentRating: 1200` for player-a, `currentRating: 800` for player-b
- Assert: `gameResult.create` was called with participants where player-a's `ratingBefore === 1200` and player-b's `ratingBefore === 800`

To inspect the `participants.create` array from the mock call:
```typescript
const createCall = mockCreate.mock.calls[0][0]  // first argument of first call
const participants = createCall.data.participants.create
```

**10. `ratingAfter` consistency**
- Same setup as test 9 (or any valid input)
- Assert for both participants: `ratingAfter === ratingBefore + ratingChange`
- Read from the `participants.create` array as shown above

**11. Team assignment**
- Assert: participant with `userId === 'player-a'` has `team: 'A'`
- Assert: participant with `userId === 'player-b'` has `team: 'B'`

### Acceptance criteria

- All 11 tests pass: `npx vitest run src/lib/record-game.test.ts`
- Full suite still green: `npm run test`
- `npm run check` passes

---

## Task 3 — Add `recordGameFn` server function to `league.tsx`

**Status:** pending
**Depends on:** Task 1
**Blocks:** Task 4

### Context

This task adds the POST server function to the existing league route file and
the new imports it needs. It does NOT add any UI yet — that is Task 4.
Keeping these separate makes each change easier to review and debug.

The server function uses dynamic imports for Clerk and the record-game lib to
prevent them from being bundled into the client (this is a strict project
convention — see CLAUDE.md "createServerFn pattern").

### Read first

- `src/routes/league.tsx` — read the full current file before making changes
- `src/lib/sync-user.ts` lines 1–40 — reference for the Clerk auth pattern (`createClerkClient`, `authenticateRequest`)
- `src/lib/record-game.ts` (Task 1 output) — understand what `recordGame` accepts and returns
- `src/routes/demo/prisma.tsx` — reference for the `createServerFn` POST pattern with `.inputValidator`

### Modify

`src/routes/league.tsx`

### Changes

**1. Add new imports at the top of the file** (after existing imports):
```typescript
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { EloResult } from '@/lib/elo'
```

**2. Add the server function** — place it after `getLeaguePlaces` and before the `Route` export:

```typescript
const recordGameFn = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: { playerAId: string; playerBId: string; result: EloResult }) => data,
  )
  .handler(async ({ data }) => {
    const secretKey = process.env.CLERK_SECRET_KEY
    const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY
    if (!secretKey || !publishableKey) throw new Error('Missing Clerk env vars')

    const { createClerkClient } = await import('@clerk/backend')
    const { getRequest } = await import('@tanstack/react-start/server')
    const clerk = createClerkClient({ secretKey, publishableKey })
    const auth = await clerk.authenticateRequest(getRequest())
    if (!auth.isSignedIn) throw new Error('Unauthorized')

    const { recordGame } = await import('../lib/record-game')
    return recordGame(data)
  })
```

**Do not add any other changes in this task.**

### Acceptance criteria

- `npm run check` passes
- `npm run build` passes — critical, since this is where client/server bundle
  errors surface. If `record-game` or Clerk imports leak into the client bundle,
  the build will fail here.
- The existing leaderboard still renders correctly in dev (`npm run dev`)

---

## Task 4 — Add `RecordGameModal` UI to `league.tsx`

**Status:** pending
**Depends on:** Task 3 (server function must already be in the file)
**Blocks:** Task 5

### Context

This task adds the "Record Game" button and modal to the `LeagueTable` component.
The modal uses three existing storybook components — `Dialog`, `Button`, and
`RadioGroup` — wrapped in a hand-rolled full-screen overlay (the Dialog component
has no built-in backdrop).

The loader data (`leaguePlaces`) is reused to populate the player dropdowns —
no additional fetch is needed.

### Read first

- `src/routes/league.tsx` (after Task 3) — read the full file before making changes
- `src/components/storybook/dialog.tsx` — `DialogProps`: `title: string`, `children`, `footer?: ReactNode`, `className?`
- `src/components/storybook/button.tsx` — `ButtonProps`: `variant?` ('primary'|'secondary'|'danger'), `size?`, `disabled?`, `onClick?`, `type?`
- `src/components/storybook/radio-group.tsx` — `RadioGroupProps`: `label`, `name`, `options: {value,label}[]`, `value?`, `onChange?: (value: string) => void`

### Modify

`src/routes/league.tsx`

### Changes

**1. Add storybook component imports** at the top of the file:
```typescript
import { Button } from '@/components/storybook/button'
import { Dialog } from '@/components/storybook/dialog'
import { RadioGroup } from '@/components/storybook/radio-group'
import { PlusCircle } from 'lucide-react'
```

**2. Add state and derived values** inside `LeagueTable`, after the `leaguePlaces` line:
```typescript
const router = useRouter()
const [modalOpen, setModalOpen] = useState(false)
const [playerAId, setPlayerAId] = useState('')
const [playerBId, setPlayerBId] = useState('')
const [result, setResult] = useState<EloResult>('A')
const [submitting, setSubmitting] = useState(false)
const [error, setError] = useState<string | null>(null)

const playerAUsername = leaguePlaces.find((p) => p.id === playerAId)?.username
const playerBUsername = leaguePlaces.find((p) => p.id === playerBId)?.username
```

**3. Add submit handler** inside `LeagueTable`, after the derived values:
```typescript
async function handleSubmit() {
  if (!playerAId || !playerBId) return
  setSubmitting(true)
  setError(null)
  try {
    await recordGameFn({ data: { playerAId, playerBId, result } })
    setModalOpen(false)
    setPlayerAId('')
    setPlayerBId('')
    setResult('A')
    router.invalidate()
  } catch (e) {
    setError((e as { message?: string }).message ?? 'Failed to record game')
  } finally {
    setSubmitting(false)
  }
}
```

**Note on error shape:** TanStack Start may wrap thrown errors before they reach
the client. `(e as { message?: string }).message` is the correct pattern here —
do NOT use `e instanceof Error`.

**4. Add the "Record Game" button** — in the JSX, place it inside the leaderboard
`<section>` tag, between the opening of that section and the `<table>` element:

```tsx
{isSignedIn && (
  <button
    type="button"
    onClick={() => setModalOpen(true)}
    className="mb-8 flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-500
               hover:from-cyan-400 hover:to-blue-400 text-white font-semibold
               px-5 py-2.5 rounded-lg transition-all shadow-lg"
  >
    <PlusCircle className="w-5 h-5" />
    Record Game
  </button>
)}
```

(Using a plain `<button>` here rather than the storybook `Button` since we need
a custom gradient that `Button`'s `variant` props don't support.)

**5. Add the modal** — at the bottom of the component's return JSX, just before
the final closing `</div>`:

```tsx
{modalOpen && (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onClick={() => setModalOpen(false)}
  >
    <div
      className="w-full max-w-md mx-4"
      onClick={(e) => e.stopPropagation()}
    >
      <Dialog
        title="Record Game Result"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!playerAId || !playerBId || submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Saving…' : 'Record Result'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          {/* Player A */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Player A
            </label>
            <select
              value={playerAId}
              onChange={(e) => setPlayerAId(e.target.value)}
              className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
            >
              <option value="">Select a player…</option>
              {leaguePlaces.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username}
                </option>
              ))}
            </select>
          </div>

          {/* Player B — excludes selected Player A */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Player B
            </label>
            <select
              value={playerBId}
              onChange={(e) => setPlayerBId(e.target.value)}
              className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
            >
              <option value="">Select a player…</option>
              {leaguePlaces
                .filter((p) => p.id !== playerAId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.username}
                  </option>
                ))}
            </select>
          </div>

          {/* Result */}
          <RadioGroup
            label="Result"
            name="result"
            value={result}
            onChange={(v) => setResult(v as EloResult)}
            options={[
              { value: 'A', label: `${playerAUsername ?? 'Player A'} won` },
              { value: 'draw', label: 'Draw' },
              { value: 'B', label: `${playerBUsername ?? 'Player B'} won` },
            ]}
          />

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}
        </div>
      </Dialog>
    </div>
  </div>
)}
```

### Acceptance criteria

- `npm run check` passes
- `npm run build` passes
- Dev server (`npm run dev`): signed-in user sees "Record Game" button on `/league`
- Clicking button opens modal; clicking the backdrop closes it
- Player B dropdown excludes whichever player is selected in Player A
- RadioGroup labels update to show selected player usernames (e.g. "alice won / Draw / bob won")
- Submit button is disabled until both players are selected
- Successful submit: modal closes, table re-renders with updated ratings
- Failed submit: modal stays open, error message appears in red below the radio group

---

## Task 5 — Verification

**Status:** pending
**Depends on:** Tasks 1, 2, 3, 4
**Blocks:** nothing (ready for PR after this)

### Automated checks

Run all of these in the worktree root. All must pass before the branch is
considered ready for review.

```bash
npx vitest run src/lib/record-game.test.ts   # new unit tests in isolation
npm run test                                  # full suite (42+ tests) — no regressions
npm run check                                 # Biome lint + format
npm run build                                 # production build — catches client/server bundle errors
npm ci                                        # validates lockfile is clean (catches npm install drift)
```

### Manual QA checklist

Run `npm run dev` and work through each item:

- [ ] Unsigned-out user visits `/league` → sees "Sign in to view this page"; no "Record Game" button
- [ ] Signed-in user visits `/league` → sees "Record Game" button above the table
- [ ] Click "Record Game" → modal opens with title "Record Game Result"
- [ ] Click backdrop → modal closes without submitting
- [ ] Click "Cancel" → modal closes without submitting
- [ ] Select Player A → Player B dropdown no longer shows that player as an option
- [ ] Change Player A selection → Player B dropdown updates accordingly
- [ ] RadioGroup labels show selected usernames (e.g. "alice won / Draw / bob won")
- [ ] Submit with either player unselected → Submit button is disabled (cannot click)
- [ ] Submit a valid result → modal closes, leaderboard re-renders with updated ratings and rankings
- [ ] Check Prisma Studio (`npm run db:studio`) → confirm 1 `GameResult`, 2 `GameParticipant` rows, 2 updated `User.currentRating` values

### Known quirks to be aware of

1. **Error shape at runtime**: If an error from the server function doesn't surface
   correctly in the modal, `console.log(e)` in the catch block to inspect the
   actual shape. Adjust the `(e as { message?: string }).message` extraction if needed.

2. **Draw display**: After recording a draw between equal-rated players, wins/losses
   in the table will be unchanged (correct — ratingChange is 0 for both). For
   unequal players, a draw may show as a win/loss due to the Elo formula producing
   a non-zero change. This is expected behaviour, not a bug.

3. **`npm ci` vs `npm install`**: Use `npm ci` for the lockfile check — it is strict
   and will catch any drift that `npm install` would silently accept.

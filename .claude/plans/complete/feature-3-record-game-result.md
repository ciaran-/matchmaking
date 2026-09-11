# Feature 3 — Record Game Result

## Context

The `/league` route shows a read-only leaderboard. Ratings never change after seeding because there is no way to record match outcomes. This feature adds a "Record Game" button on the leaderboard that opens a modal, lets any signed-in user submit a 1v1 result, and updates the table live.

---

## Scope

**In scope:**
- 1v1 only (`ONE_VS_ONE`)
- Modal form with two player selectors and a result radio (A won / Draw / B won)
- Server function with auth guard, Elo calculation, and atomic DB write
- Loader invalidation on success so ratings + rankings update without a page reload
- Inline error display in the modal on failure
- `src/lib/record-game.ts` with full unit test coverage

**Out of scope:**
- `TEAM_VS_TEAM` (future feature — would need a different Elo strategy)
- Per-game score input (scores derived from result: A-win → 1/0, B-win → 0/1, draw → 0/0)
- Editing or deleting past results
- Optimistic UI updates

---

## Files

| File | Action |
|---|---|
| `src/lib/record-game.ts` | Create — core DB logic |
| `src/lib/record-game.test.ts` | Create — unit tests |
| `src/routes/league.tsx` | Modify — add server fn + modal UI |

No schema changes needed. `GameResult`, `GameParticipant`, `Team`, and `GameMode` already exist.

---

## `src/lib/record-game.ts`

### Types

```typescript
// Server-only module — do not import from client-side code.

import type { GameResult } from '@prisma/client'
import type { EloResult } from './elo'

export interface RecordGameInput {
  playerAId: string   // User.id cuid
  playerBId: string   // User.id cuid
  result: EloResult   // 'A' | 'B' | 'draw'
}

export interface RecordGameOutput {
  gameResult: GameResult
  ratingChangeA: number
  ratingChangeB: number
}

export async function recordGame(input: RecordGameInput): Promise<RecordGameOutput>
```

### Algorithm

1. **Same-player guard**: throw `Error('playerAId and playerBId must be different')` if equal.
2. **Fetch users**: `prisma.user.findMany({ where: { id: { in: [playerAId, playerBId] } } })`. Throw `Error('One or both players not found')` if fewer than 2 rows returned.
3. **Derive scores**: `result === 'A'` → `(1, 0)`; `result === 'B'` → `(0, 1)`; `result === 'draw'` → `(0, 0)`.
4. **Calculate Elo**: `calculateElo1v1(userA.currentRating, userB.currentRating, result)` → `{ changeA, changeB }`.
5. **Compute after-ratings**: `ratingAfterA = userA.currentRating + changeA`, same for B.
6. **Atomic transaction** — three operations in the array:
   ```
   prisma.$transaction([
     prisma.gameResult.create({
       data: {
         mode: 'ONE_VS_ONE',
         teamAScore,
         teamBScore,
         participants: {
           create: [
             { userId: playerAId, team: 'A', ratingBefore, ratingAfter: ratingAfterA, ratingChange: changeA },
             { userId: playerBId, team: 'B', ratingBefore, ratingAfter: ratingAfterB, ratingChange: changeB },
           ],
         },
       },
     }),
     prisma.user.update({ where: { id: playerAId }, data: { currentRating: ratingAfterA } }),
     prisma.user.update({ where: { id: playerBId }, data: { currentRating: ratingAfterB } }),
   ])
   ```
   The two `GameParticipant` rows are created inside the nested `participants.create`, so only three items go in the transaction array.
7. **Return** `{ gameResult: transaction[0], ratingChangeA: changeA, ratingChangeB: changeB }`.
8. Wrap the full function body in `Sentry.startSpan({ name: 'Record game result' }, async () => { ... })`.

---

## Server Function in `league.tsx`

Dynamic imports are required to keep Clerk + recordGame out of the client bundle (CLAUDE.md pattern).

```typescript
const recordGameFn = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    playerAId: string
    playerBId: string
    result: EloResult
  }) => data)
  .handler(async ({ data }) => {
    // Auth guard — same pattern as src/lib/sync-user.ts
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

---

## UI (`league.tsx` component changes)

### New state (inside `LeagueTable`)

```typescript
const router = useRouter()
const [modalOpen, setModalOpen] = useState(false)
const [playerAId, setPlayerAId] = useState('')
const [playerBId, setPlayerBId] = useState('')
const [result, setResult] = useState<EloResult>('A')
const [submitting, setSubmitting] = useState(false)
const [error, setError] = useState<string | null>(null)
```

Resolve display names inline:
```typescript
const playerAUsername = leaguePlaces.find(p => p.id === playerAId)?.username
const playerBUsername = leaguePlaces.find(p => p.id === playerBId)?.username
```

### Submit handler

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

Note: TanStack Start wraps thrown errors before they reach the client — use `(e as { message?: string }).message` rather than `e instanceof Error`. Verify the actual thrown shape at runtime.

### "Record Game" button

Place between the hero `<section>` and the `<table>` section. Only render when `isSignedIn`. Style: `bg-gradient-to-r from-cyan-500 to-blue-500` with a `PlusCircle` icon from `lucide-react`.

### Modal structure

The `Dialog` component from `src/components/storybook/dialog.tsx` is a production-ready component (not storybook-only), but renders a plain `div` with no portal or backdrop. Wrap it manually:

```tsx
{modalOpen && (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onClick={() => setModalOpen(false)}
  >
    <div onClick={e => e.stopPropagation()}>
      <Dialog
        title="Record Game Result"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button
              disabled={!playerAId || !playerBId || submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Saving…' : 'Record Result'}
            </Button>
          </>
        }
      >
        {/* Player A */}
        <label>Player A</label>
        <select
          value={playerAId}
          onChange={e => setPlayerAId(e.target.value)}
          className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
        >
          <option value="">Select a player…</option>
          {leaguePlaces.map(p => (
            <option key={p.id} value={p.id}>{p.username}</option>
          ))}
        </select>

        {/* Player B — excludes playerA */}
        <label>Player B</label>
        <select
          value={playerBId}
          onChange={e => setPlayerBId(e.target.value)}
          className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
        >
          <option value="">Select a player…</option>
          {leaguePlaces
            .filter(p => p.id !== playerAId)
            .map(p => <option key={p.id} value={p.id}>{p.username}</option>)}
        </select>

        {/* Result */}
        <RadioGroup
          label="Result"
          name="result"
          value={result}
          onChange={v => setResult(v as EloResult)}
          options={[
            { value: 'A', label: `${playerAUsername ?? 'Player A'} won` },
            { value: 'draw', label: 'Draw' },
            { value: 'B', label: `${playerBUsername ?? 'Player B'} won` },
          ]}
        />

        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </Dialog>
    </div>
  </div>
)}
```

Use `Button`, `Dialog`, and `RadioGroup` from `src/components/storybook/`.

---

## Tests (`src/lib/record-game.test.ts`)

```typescript
// @vitest-environment node

vi.mock('@/db', () => ({ prisma: { user: { findMany: vi.fn() }, $transaction: vi.fn() } }))
vi.mock('@sentry/tanstackstart-react', () => ({ startSpan: vi.fn((_o, fn) => fn()) }))
```

Mock `$transaction` to execute its array: `mockImplementation(ops => Promise.all(ops))`.

| Test | Assertion |
|---|---|
| A wins, equal ratings | `$transaction` called; `gameResult.create` has `teamAScore:1`, `teamBScore:0`; both `user.update` calls have correct `currentRating` |
| B wins | `teamAScore:0`, `teamBScore:1`; rating directions reversed |
| Draw | `teamAScore:0`, `teamBScore:0`; both changes are 0 for equal ratings |
| Same player ID | Throws before any DB call |
| Player A not found | `findMany` returns one user; throws `'One or both players not found'` |
| Player B not found | As above |
| Neither found | `findMany` returns `[]`; same error |
| Transaction failure | `$transaction` rejects; error propagates |
| `ratingBefore` snapshot | Participant `ratingBefore` equals the user's `currentRating` at call time |
| `ratingAfter` consistency | `ratingAfter === ratingBefore + ratingChange` for both participants |
| Team assignment | Player A → `team: 'A'`, player B → `team: 'B'` |

---

## Storybook Component References

- `src/components/storybook/dialog.tsx` — `Dialog` with `title` and `footer` props
- `src/components/storybook/button.tsx` — `Button` with `variant` ('primary'|'secondary'|'danger') and `disabled`
- `src/components/storybook/radio-group.tsx` — `RadioGroup` with `options`, `value`, `onChange`

---

## Known Quirks / Open Questions

1. **TanStack Start error shape**: Thrown `Error` instances may arrive at the client as `{ message: string }` rather than `Error` instances. Use `(e as { message?: string }).message` in the catch block and verify at runtime.

2. **Draw display in table**: The current "Wins" column counts `ratingChange > 0`. For equal-rated players a draw produces `ratingChange: 0`, so draws don't appear as wins — correct. For unequal players a draw can produce a non-zero change (lower-rated player gains), making it look like a win/loss in the table. This is a display quirk of Elo, not a bug introduced here. A "Draws" column would need a separate `draw` field on `GameParticipant` to track cleanly — defer to a later cleanup.

3. **Player selector scale**: Native `<select>` works well up to ~50 players. If the league grows larger, replace with a combobox/typeahead.

4. **`ssr: 'data-only'`**: This is already set on the league route. `router.invalidate()` triggers a client-side re-execution of the loader (which calls `getLeaguePlaces` as a server function). This is the correct pattern.

---

## Verification

```bash
npx vitest run src/lib/record-game.test.ts   # lib unit tests
npm run test                                  # full suite — no regressions
npm run check                                 # Biome lint + format
npm run build                                 # must pass before committing
```

Manual checks:
- "Record Game" button visible only when signed in
- Player B dropdown excludes the selected Player A
- Successful submit: modal closes, table re-renders with new ratings
- DB confirms: 1 `GameResult`, 2 `GameParticipant` rows, 2 updated `User.currentRating`
- Failed submit (e.g. DB error): modal stays open, error message shown inline

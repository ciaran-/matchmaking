# Feature 1 — Clerk ↔ DB User Sync: Implementation Tasks

> Read the full plan at `.claude/plans/feature-1-clerk-db-user-sync.md` before starting.
> Complete tasks in order — each step depends on the previous.

---

## Task 1 — Verify or install the Clerk backend SDK

**Goal:** Confirm which package provides `createClerkClient` and `authenticateRequest` for server-side use.

**Steps:**
1. Check whether `@clerk/clerk-react` v5 (already installed) exposes `createClerkClient` — import it and see if it resolves. In recent versions of the Clerk SDK this is available without a separate package.
2. If it does not resolve, install `@clerk/backend`:
   ```bash
   npm install @clerk/backend
   ```
3. Do **not** install `@clerk/nextjs` or any other framework-specific shim — they won't work with TanStack Start.
4. Note which package you used in a comment at the top of `src/lib/sync-user.ts` so future developers know where the import comes from.

**Done when:** You can import `createClerkClient` without a type error and confirm the package source.

---

## Task 2 — Add `clerkId` to the database schema

**Goal:** Link the `User` table to Clerk by adding a nullable, unique `clerkId` column.

**Steps:**
1. Open `schema.prisma` and add `clerkId String? @unique` to the `User` model, directly above the `email` field:
   ```prisma
   model User {
     id        String   @id @default(cuid())
     createdAt DateTime @default(now())
     updatedAt DateTime @updatedAt

     clerkId       String? @unique   // Clerk user ID — null for seed/legacy users
     email         String  @unique
     username      String  @unique
     currentRating Int     @default(1000)

     gameParticipations GameParticipant[]
     @@index([currentRating])
   }
   ```
2. Run the migration (this also regenerates the Prisma client automatically):
   ```bash
   npm run db:migrate
   ```
   When prompted for a migration name, use something like `add_clerk_id_to_user`.
3. Confirm the migration succeeded with no errors.
4. Confirm the Prisma client now includes `clerkId` by checking that `prisma.user.findUnique({ where: { clerkId: '...' } })` is valid TypeScript (no red squiggle).

**Done when:** Migration applied cleanly; `clerkId` is available on the Prisma `User` type.

---

## Task 3 — Create `src/lib/sync-user.ts`

**Goal:** Implement the cookie-gated user sync function.

This is a plain `async` function (not a `createServerFn`). It is called directly from the root loader on the server — making it a `createServerFn` would cause an unnecessary internal HTTP round-trip.

**Steps:**

### 3a — Implement `deriveUniqueUsername`

Create this as a **named export** (not private) so it can be tested in isolation.

```ts
export async function deriveUniqueUsername(clerkUser: ClerkUser): Promise<string>
```

- Priority order: Clerk `username` field → `firstName + lastName` (lowercased, spaces removed) → email prefix (everything before `@`)
- Handle the case where `firstName` and `lastName` are both null/empty — some OAuth providers don't provide these; fall through to email prefix
- If the derived name is already taken (Prisma throws a `P2002` unique constraint error on the `username` field), append a random 4-digit number (e.g. `alice4823`) and retry
- Retry up to 5 times; if all 5 attempts fail, throw an error (astronomically unlikely in practice)

### 3b — Implement `isPrismaUniqueConstraintError`

Create this as a **named export** so it can be tested in isolation.

```ts
export function isPrismaUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code === 'P2002'
  )
}
```

### 3c — Implement `syncUser`

```ts
export async function syncUser(): Promise<User | null>
```

The function must:

1. Call `getWebRequest()` from `@tanstack/react-start/server` to get the current `Request` object
2. Create a Clerk client: `createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })`
   - **Read `CLERK_SECRET_KEY` inside the function body, never at module scope.** Vite can accidentally bundle module-scope `process.env` references into the client bundle.
3. Call `clerk.authenticateRequest(request)` — do **not** manually read the `__session` cookie; this method handles Clerk's session transport correctly across SDK versions
4. If `!auth.isSignedIn`, return `null` immediately
5. Extract `clerkUserId = auth.toAuth().userId`
6. Parse the request's `Cookie` header and check if the `db_synced` cookie equals `clerkUserId`
   - If it matches: call `prisma.user.findUnique({ where: { clerkId: clerkUserId } })` and return the result (skip the upsert)
7. If no matching cookie: call `clerk.users.getUser(clerkUserId)` to get full user details
8. Run the upsert:
   ```ts
   prisma.user.upsert({
     where: { clerkId: clerkUser.id },
     create: {
       clerkId: clerkUser.id,
       email: clerkUser.emailAddresses[0].emailAddress,
       username: await deriveUniqueUsername(clerkUser),
       currentRating: 1000,
     },
     update: {}, // intentionally empty — never overwrite username or rating
   })
   ```
   - Wrap in try/catch; if the error is `P2002` (race condition — two tabs signing in simultaneously), fall back to `prisma.user.findUnique({ where: { clerkId: clerkUserId } })` and return that result
   - Re-throw any other error
9. After a successful upsert, set the response cookie:
   ```
   db_synced=<clerkUserId>; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/
   ```
   In TanStack Start, response headers are set via `setResponseHeader` (or equivalent from `@tanstack/react-start/server`) — check the TanStack Start docs for the exact API for setting response headers from a server-side loader context.
10. Return the upserted `User` row

**Done when:** The file compiles with no TypeScript errors and all logic branches are covered.

---

## Task 4 — Write tests for `src/lib/sync-user.ts`

**Goal:** Cover all meaningful logic branches with unit tests before wiring anything into the app.

Create `src/lib/sync-user.test.ts`. Add `// @vitest-environment node` at the top — this is server-only code with no browser APIs.

The test file will need to mock three external dependencies using `vi.mock()`:
- `@tanstack/react-start/server` — mock `getWebRequest` and `setResponseHeader`
- The Clerk SDK package (whichever was confirmed in Task 1) — mock `createClerkClient`
- `@/db` — mock `prisma`

### Tests for `isPrismaUniqueConstraintError`

| Case | Expected |
|------|----------|
| `{ code: 'P2002' }` | `true` |
| `{ code: 'P2001' }` (different Prisma error) | `false` |
| A plain `new Error('something')` | `false` |
| `null` | `false` |
| `undefined` | `false` |
| A string `'P2002'` | `false` |

### Tests for `deriveUniqueUsername`

These require mocking `prisma.user.upsert` to simulate username collision (P2002) or success.

| Case | Setup | Expected |
|------|-------|----------|
| Clerk `username` is set | `clerkUser.username = 'alice'` | Returns `'alice'` |
| No username, has first + last name | `username: null, firstName: 'Alice', lastName: 'Smith'` | Returns `'alicesmith'` |
| No username, firstName only | `username: null, firstName: 'Alice', lastName: null` | Returns `'alice'` |
| No username, no names | `username: null, firstName: null, lastName: null, email: 'alice@example.com'` | Returns `'alice'` |
| Derived name already taken once | Prisma upsert throws P2002 on first call, succeeds on second | Returns name with 4-digit suffix |
| Derived name taken 5 times in a row | Prisma upsert throws P2002 on all 5 calls | Throws an error |

### Tests for `syncUser`

| Case | Setup | Expected behaviour |
|------|-------|--------------------|
| No Clerk session | `auth.isSignedIn = false` | Returns `null`; no DB call; no cookie set |
| Cookie matches current userId | `db_synced` cookie = current `clerkUserId` | Returns `findUnique` result; no upsert; no `clerk.users.getUser()` call |
| Cookie present but different userId (different user signed in) | `db_synced` cookie = some other id | Runs upsert; sets cookie |
| No cookie, new user | No `db_synced` cookie; upsert creates row | Returns created user; sets `db_synced` cookie on response |
| No cookie, race condition (P2002 on upsert) | Upsert throws `{ code: 'P2002' }`; `findUnique` returns existing row | Returns the existing row; does **not** re-throw |
| No cookie, unexpected DB error | Upsert throws a non-P2002 error | Re-throws the error (root loader catches it) |

**Run tests:**
```bash
npx vitest run src/lib/sync-user.test.ts
```

**Done when:** All tests pass with `npm run test`.

---

## Task 5 — Update `src/routes/__root.tsx`

**Goal:** Wire `syncUser` into the root route so `dbUser` is available in router context on every page.

**Steps:**

### 5a — Extend `MyRouterContext`

Add `dbUser` to the existing context interface:
```ts
interface MyRouterContext {
  queryClient: QueryClient
  dbUser: User | null   // import User from '@prisma/client'
}
```

### 5b — Add a root loader

Add a `loader` property to the route definition. It must call `syncUser` and handle failures gracefully — if the DB is unreachable, the app should continue (Clerk auth still works), not crash:

```ts
export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({ /* existing head config — do not change */ }),
  loader: async ({ context }) => {
    try {
      context.dbUser = await syncUser()
    } catch (e) {
      console.error('[syncUser] failed, continuing without DB user:', e)
      context.dbUser = null
    }
  },
  shellComponent: RootDocument,
})
```

### 5c — Seed the context initial value

The router context object is created in `src/router.tsx` (or wherever `createRouter` is called). Ensure `dbUser: null` is included as an initial value so the TypeScript type is satisfied before the loader runs:
```ts
context: {
  queryClient,
  dbUser: null,
}
```

**Note on consumers:** Nothing in the current UI reads `dbUser` yet — the `Header` uses Clerk's own components and the league table fetches users independently. This wiring is infrastructure for future features. Do not change any existing components as part of this task.

**Note on tests:** The root loader itself (the try/catch glue) is not worth unit testing — TanStack Router's wiring is hard to test in isolation and the meaningful logic is all in `syncUser`, which is already covered. The loader is verified by the manual checks in Task 6.

**Done when:** The app compiles, the root loader runs on page load, and `dbUser` is accessible via `useRouterContext()` in any component.

---

## Task 6 — Run all tests then manual verification

### 6a — Run the test suite

```bash
npm run test
```

All tests must pass before proceeding to manual verification.

### 6b — Manual verification

Work through each step in order.

1. **Migration is clean:** `npm run db:migrate` applied without errors; no existing data was lost
2. **New user is created:** Start `npm run dev`, sign in via Clerk for the first time, open Prisma Studio (`npm run db:studio`) — confirm a `User` row exists with:
   - `clerkId` matching your Clerk user ID (visible in the Clerk dashboard)
   - `email` matching your Clerk account email
   - A sensible `username` derived from your Clerk profile
   - `currentRating` = 1000
3. **Cookie is set:** In browser DevTools → Application → Cookies → `localhost`, confirm a `db_synced` cookie exists with your Clerk user ID as the value; `HttpOnly` should be checked; expiry should be ~1 hour from now
4. **Subsequent loads skip the upsert:** Reload the page and check the server console — confirm no second upsert or `clerk.users.getUser()` call fires (only a `findUnique` should run)
5. **Idempotent on sign-out/sign-in:** Sign out, sign back in — row count in Prisma Studio stays the same; `db_synced` cookie is re-set
6. **League table unaffected:** Visit `/league` — the 11 seed users (with `clerkId = null`) still appear; your newly synced user also appears with rating 1000
7. **Graceful DB failure:** Stop the local PostgreSQL process, reload the page — app should not crash; Clerk auth still works; check the server console for the `[syncUser] failed` log line
8. **Recovery:** Restart PostgreSQL, reload the page — user re-syncs cleanly on the next page load

---

## Notes for the implementer

- The `db_synced` cookie does **not** need to be cleared on sign-out manually — Clerk's session invalidation removes Clerk's own cookies, and on the next signed-in page load the cookie either won't be present (if cleared by the browser) or will contain a mismatched `userId` (if a different user signs in), both of which trigger the upsert path correctly.
- The `update` block of the upsert is intentionally empty. Do not add `email` to it. If a user changes their Clerk email to one that matches an existing seed user's email, the unique constraint would throw. This is a deferred concern that will resolve itself when seed data is removed.
- Do not move the `CLERK_SECRET_KEY` read to module scope for convenience — this is a security requirement, not a style preference.
- `deriveUniqueUsername` is exported so it can be tested directly. It is not part of the public API of this module in the product sense — do not call it from outside `sync-user.ts` except in tests.

# Plan: Feature 1 — Clerk ↔ DB User Sync

## Context

Clerk manages authentication (identity, sessions, OAuth). The PostgreSQL `User` table manages app-level data (Elo rating, game history). Currently there is no link between them — no `clerkId` on `User`, no sync mechanism. Someone can sign in with Clerk and have no matching row in the DB. Every future feature (submitting results, displaying "your rating", player profiles) depends on being able to look up the DB `User` from a Clerk session.

---

## Approach: Plain async function called from the root loader

On each full SSR page load, if a Clerk session is present, upsert a `User` row in the DB (using the Clerk `userId` as the link). This is idempotent — if the user already exists, nothing changes. If they're new, they get created. The result is placed in the router context so any route can access it without re-fetching.

**Why a plain async function, not `createServerFn`?**
`createServerFn` is an RPC primitive — calling it from a server-side loader makes an internal HTTP round-trip to itself. For logic that runs in the root loader, export a plain `async` function and call it directly. No performance penalty, no request context loss.

**Why root loader over webhooks?**
Webhooks require a publicly accessible URL and external setup — overkill at this stage. The root loader runs server-side before any child route renders and is the natural place to establish identity.

**Known trade-off:** This adds a DB round-trip to every full-page SSR request, even for users already in the DB. For a small internal app this is acceptable. A future optimisation could skip the upsert if a short-lived cookie or `lastSyncedAt` timestamp indicates the user was recently synced.

---

## Schema changes

Add `clerkId` to the `User` model. Make it **nullable** so existing seed data (which has no Clerk accounts) continues to work.

```prisma
model User {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  clerkId       String? @unique   // ← add this
  email         String  @unique
  username      String  @unique
  currentRating Int     @default(1000)

  gameParticipations GameParticipant[]
  @@index([currentRating])
}
```

Run `npm run db:migrate` to create and apply the migration (this also regenerates the Prisma client automatically).

---

## New dependency

Before installing, verify whether `@clerk/clerk-react` v5 already exposes `createClerkClient` or `authenticateRequest` — in recent versions it may. If not, install:

```bash
npm install @clerk/backend
```

Do not use framework-specific shims (e.g. `@clerk/nextjs`) — they won't work with TanStack Start.

---

## New file: `src/lib/sync-user.ts`

A plain `async` function (not a server function) that:

1. Calls `getWebRequest()` (TanStack Start utility) to get the current `Request` object
2. Calls `createClerkClient({ secretKey }).authenticateRequest(request)` — this correctly handles Clerk's session transport (Authorization header + cookies) regardless of SDK version. **Do not** try to read `__session` manually.
3. If no valid session → returns `null` (unauthenticated users pass through)
4. If valid session → upserts a `User` row using `clerkId` as the unique key

**Important:** Read `CLERK_SECRET_KEY` inside the function body (`process.env.CLERK_SECRET_KEY`), never at module scope — Vite can accidentally bundle module-scope env var references into the client bundle.

```ts
// Pseudocode shape
export async function syncUser(): Promise<User | null> {
  const request = getWebRequest()
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })
  const auth = await clerk.authenticateRequest(request)

  if (!auth.isSignedIn) return null

  const clerkUser = await clerk.users.getUser(auth.toAuth().userId)

  try {
    return await prisma.user.upsert({
      where: { clerkId: clerkUser.id },
      create: {
        clerkId: clerkUser.id,
        email: clerkUser.emailAddresses[0].emailAddress,
        username: await deriveUniqueUsername(clerkUser),
        currentRating: 1000,
      },
      update: {
        // intentionally empty — don't overwrite username or rating
        // email update is omitted: if the Clerk email collides with a seed user's
        // unique email constraint it will throw; revisit when seed data is removed
      },
    })
  } catch (e) {
    // P2002 = unique constraint violation from a race condition (two tabs/devices
    // signing in simultaneously). Fall back to fetching the row that won the race.
    if (isPrismaUniqueConstraintError(e)) {
      return prisma.user.findUnique({ where: { clerkId: clerkUser.id } })
    }
    throw e
  }
}
```

**Username derivation (priority order):**
1. Clerk `username` (if set)
2. `firstName + lastName` lowercased, spaces removed
3. Email prefix (before `@`)
4. If the derived username is taken, append a random 4-digit number and retry (catch `P2002` on `username`, regenerate suffix). Retry up to 5 times; throw if all fail (extremely unlikely in practice).

---

## Changes to `src/routes/__root.tsx`

**1. Add `dbUser` to the router context interface:**

```ts
interface MyRouterContext {
  queryClient: QueryClient
  dbUser: User | null   // ← add this
}
```

**2. Add a `loader` that calls `syncUser` with graceful degradation:**

```ts
export const Route = createRootRouteWithContext<MyRouterContext>()({
  // existing head() config...
  loader: async ({ context }) => {
    try {
      context.dbUser = await syncUser()
    } catch (e) {
      console.error('[syncUser] DB unavailable, continuing without DB user', e)
      context.dbUser = null
    }
  },
  shellComponent: RootDocument,
})
```

If the DB is unreachable, the app degrades gracefully — Clerk auth still works, the user just won't have a DB row until the DB recovers.

**How child routes access `dbUser`:** Via `useRouterContext()` — any component in the tree can call this hook to read `context.dbUser`. This is cleaner than importing the root `Route` object into every child route.

---

## Note on current consumers

At this stage, nothing in the UI reads `dbUser` — the `Header` uses Clerk's own components, and the league table fetches all users independently. The root loader wiring is plumbing for future features (game submission, player profiles). No existing components need to change as part of this feature.

---

## Files to create / modify

| Action | File | Change |
|--------|------|--------|
| Modify | `schema.prisma` | Add `clerkId String? @unique` |
| Create | migration | Via `npm run db:migrate` |
| Create | `src/lib/sync-user.ts` | Plain async sync function |
| Modify | `src/routes/__root.tsx` | Add `dbUser` to `MyRouterContext`; add `loader` |

---

## Verification

1. Run `npm run db:migrate` — migration applies cleanly with no errors
2. Start dev server: `npm run dev`
3. Sign in via Clerk
4. Open Prisma Studio (`npm run db:studio`) — confirm a new `User` row exists with your `clerkId`, `email`, and derived `username`; `currentRating` should be 1000
5. Sign out and sign back in — confirm no duplicate row is created (row count stays the same)
6. Visit `/league` — existing seed users (with `clerkId = null`) still appear; your newly synced user also appears with rating 1000
7. Kill the DB while the dev server is running, reload a page — app should degrade gracefully (Clerk auth still works, no crash, error logged to console)
8. Restore the DB — next page load re-syncs cleanly

# Plan: Feature 1 — Clerk ↔ DB User Sync

## Context

Clerk manages authentication (identity, sessions, OAuth). The PostgreSQL `User` table manages app-level data (Elo rating, game history). Currently there is no link between them — no `clerkId` on `User`, no sync mechanism. Someone can sign in with Clerk and have no matching row in the DB. Every future feature (submitting results, displaying "your rating", player profiles) depends on being able to look up the DB `User` from a Clerk session.

---

## Approach: Cookie-gated root loader sync

On each full SSR page load, the root loader checks for a short-lived `db_synced` cookie containing the current Clerk `userId`. If the cookie is present and matches the session, the upsert is skipped entirely — zero DB cost. If the cookie is absent or belongs to a different user (sign-out/sign-in), the upsert runs and the cookie is set. The result is placed in the router context so any route can access it without re-fetching.

**Why a plain async function, not `createServerFn`?**
`createServerFn` is an RPC primitive — calling it from a server-side loader makes an internal HTTP round-trip to itself. For logic that runs in the root loader, export a plain `async` function and call it directly. No performance penalty, no request context loss.

**Why root loader with a cookie, over the alternatives?**

Three approaches were evaluated:

- **Root loader (upsert on every request):** Correct and simple, but adds a DB SELECT on every full-page SSR load even for users already in the DB. Rejected on performance grounds.
- **Webhooks (Clerk `user.created` event):** Zero per-request cost, but has a cold-start problem — between Clerk creating the user and the webhook firing, the DB row doesn't exist yet, so every server function still needs a null-handling fallback. Also requires ngrok/tunnel tooling for local development, a new `CLERK_WEBHOOK_SECRET`, a `svix` dependency, and manual Clerk dashboard configuration per environment. Too much operational overhead for an internal app.
- **Lazy/on-demand sync (`getOrCreateDbUser` called per server function):** Only pays the DB cost when a route actually needs the user. But creates a silent omission hazard — any future server function touching user-specific data must remember to call the helper. No centralised guarantee, error handling is per-call-site, and `dbUser` isn't available in context for layout-level use. Savings are theoretical for this app since `/league` already does a heavy `findMany`.

The cookie-gated root loader combines the correctness of the root loader (always synced, always in context, centralised error handling) with near-zero steady-state cost. Since the `update` block is intentionally empty (nothing is overwritten after creation), the upsert after first-visit is only a SELECT to confirm row existence — the cookie eliminates even that.

**Cookie spec:** `db_synced`, `httpOnly`, `sameSite=lax`, `maxAge=3600` (1 hour). Contains the Clerk `userId`. On sign-out, the cookie is cleared by Clerk's session invalidation; on next sign-in with a different account the userId won't match and the upsert runs for the new user.

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

  const clerkUserId = auth.toAuth().userId

  // Check the short-lived sync cookie — if it matches the current Clerk user,
  // the DB row already exists and we can skip the upsert entirely.
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  if (cookies.db_synced === clerkUserId) {
    return prisma.user.findUnique({ where: { clerkId: clerkUserId } })
  }

  // Cookie absent or belongs to a different user — run the upsert.
  const clerkUser = await clerk.users.getUser(clerkUserId)

  let dbUser: User
  try {
    dbUser = await prisma.user.upsert({
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
      return prisma.user.findUnique({ where: { clerkId: clerkUserId } })
    }
    throw e
  }

  // Set the sync cookie so subsequent page loads skip the upsert.
  // The response headers must be set on the outgoing response — in TanStack Start
  // this is done via setHeader() from the server request context.
  setResponseHeader(
    'Set-Cookie',
    `db_synced=${clerkUserId}; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/`
  )

  return dbUser
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
5. In browser DevTools (Application → Cookies), confirm a `db_synced` cookie is set with your Clerk `userId` as the value
6. Reload the page — confirm in server logs / Prisma query logs that no upsert fires (cookie is present; only a `findUnique` runs)
7. Sign out and sign back in — confirm no duplicate row is created (row count stays the same); confirm the cookie is cleared on sign-out and re-set on sign-in
8. Visit `/league` — existing seed users (with `clerkId = null`) still appear; your newly synced user also appears with rating 1000
9. Kill the DB while the dev server is running, reload a page — app should degrade gracefully (Clerk auth still works, no crash, error logged to console)
10. Restore the DB — next page load re-syncs cleanly

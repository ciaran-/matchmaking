# Migrate Clerk auth to @clerk/tanstack-react-start

## Why

The project currently uses `@clerk/clerk-react` + `@clerk/backend` directly for
server-side auth. This was set up before `@clerk/tanstack-react-start` was stable.

The low-level approach has a known footgun: `clerk.authenticateRequest(getRequest())`
fails on POST server functions in production (Netlify) because TanStack Start
consumes the request body to deserialize server function arguments before the
handler runs. `ClerkRequest` internally clones the original Request, which fails
on a locked body stream.

We worked around this in `recordGameFn` by passing a headers-only clone:
```ts
new Request(req.url, { headers: req.headers })
```
This is safe (Clerk only reads URL/headers/cookies), but it's a workaround.
`sync-user.ts` has the same latent issue if it ever handles a POST with a body.

## What to do

Replace all manual `createClerkClient` / `authenticateRequest` auth checks in
server functions with the `auth()` helper from `@clerk/tanstack-react-start`:

```ts
import { auth } from '@clerk/tanstack-react-start/server'

const myFn = createServerFn().handler(async () => {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error('Unauthorized')
})
```

Clerk docs: https://clerk.com/docs/reference/tanstack-react-start/auth

## Scope

- `src/routes/league.tsx` — `recordGameFn` handler (has the workaround today)
- `src/lib/sync-user.ts` — uses `authenticateRequest` directly; assess whether
  it should move to `auth()` or stay as-is (it's a GET-style call so the body
  issue doesn't bite it currently)
- Any future server functions that need auth

## Before starting

Check the current state of `@clerk/tanstack-react-start` — it had open issues
around `getAuth` not being a function in SSR contexts as recently as late 2025.
Verify the version in npm is stable before migrating.

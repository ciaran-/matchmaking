# Migrate Clerk auth to @clerk/tanstack-react-start

> **Archived 2026-09-11 — decided not to do this.**
>
> Nothing requires it. The body-consumption workaround this plan targeted
> still works (the headers-only request copy in `src/lib/auth.ts`). Since
> this plan was written, features 6 and 11 built personal API keys and M2M
> token acceptance directly on `@clerk/backend`. The TanStack package's
> `auth()` would support those too, so it would neither unblock nor break
> anything.
>
> Weighed on 2026-09-11:
>
> - **Benefits:** the server knows who is signed in while rendering
>   (no loading flash, server-side redirects); Clerk's handshake is handled
>   when a page loads with an expired session token; the request-copy
>   workaround goes away.
> - **Costs:** its middleware authenticates every request, including page
>   loads; it needs a TanStack Start upgrade; `auth.ts`, `sync-user.ts`,
>   both auth middlewares and the test stubs need rework; and it ties us
>   more closely to Clerk, against the aim of running locally without live
>   Clerk.
>
> The real Clerk need is different: `@clerk/clerk-react` is deprecated
> upstream. That is handled by
> `.claude/plans/clerk-react-core-3-upgrade.md`, which does not require
> this package.
>
> Revisit if server-side auth state becomes a real UX problem (for example
> sign-in flicker on gated pages, or a need for server-side redirects).
>
> The original plan follows unchanged.

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

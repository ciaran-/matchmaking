# 0003. Authentication is default-deny for server functions and the API

- **Status:** Accepted
- **Date:** 2026-09-10
- **Source:** `.claude/plans/complete/feature-11-service-identity.md`

## Context

Server functions compile to public HTTP endpoints at `/_serverFn/<id>`, and
the id ships in the client bundle. Authentication was opt-in: each handler
had to call `authenticatedUser()` itself. Fifteen did and two did not, and
calling the built server with no credentials returned a full page of
leaderboard data. A missing check reads exactly like a deliberately public
endpoint, so review could not catch it. The `/api/v1` routes had the same
opt-in shape.

## Decision

Authentication is enforced centrally. Being public is an explicit
allowlist entry that has to be defended in review.

- **Server functions:** a global `functionMiddleware` (`src/start.ts` →
  `src/lib/server-fn-auth.ts`) authenticates every call unless the function
  is in `PUBLIC_SERVER_FNS`. The only entry is `syncUserFn` (see 0002).
  - Entries are keyed `filename:name`, not by the server function id. The
    id is a content hash, so it changes whenever the file changes.
  - Function middleware, not request middleware: in this TanStack Start
    version `serverFnMeta` is undefined in request middleware, so an
    allowlist is impossible there.
- **REST API:** `apiMiddleware` on every `/api/v1` route authenticates
  unless the path is in `PUBLIC_API_PATHS`. The only entry is
  `openapi.json`. A test asserts every route file attaches the middleware.

## Consequences

- Forgetting to add auth now produces a refusal rather than a leak.
- There is no anonymous data surface. Adding one is a deliberate allowlist
  change that makes the endpoint world-callable.
- Every server function call verifies the Clerk session, and every API
  call verifies its credential. API-key verification is a network call to
  Clerk, memoized per request (see 0004).
- The two surfaces signal failure differently, on purpose. Server functions
  throw `Unauthorized`, which the UI already maps to a sign-in prompt; the
  REST API returns a `401` error envelope.

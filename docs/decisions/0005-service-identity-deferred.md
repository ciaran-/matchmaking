# 0005. Services are a distinct actor; the credential mechanism waits for a real caller

- **Status:** Accepted (partly open — credential mechanism not chosen)
- **Date:** 2026-09-10
- **Source:** `.claude/plans/complete/feature-11-service-identity.md`,
  `.claude/plans/feature-12-offline-game-import.md`
- **Supersedes:** feature 6's non-goal that every credential resolves to a
  person

## Context

Until feature 11, every credential resolved to a human `User`, and code
downstream relied on that. Some work, such as bulk-importing offline
games, needs the system to act as itself — with authority users
deliberately lack (0006).

The feature 11 plan first chose Clerk machine-to-machine (M2M) tokens,
carried over from the personal-API-key decision (0004). That reasoning does
not transfer. A user's key belongs to a person Clerk already manages; a
machine credential does not. Using Clerk for it would put a user identity
provider in the critical path of internal jobs, and pull against the goal
of local development without live third-party services.

## Decision

- **The actor model is a union.** `resolveActor` returns
  `{ kind: 'user' }` or `{ kind: 'service' }`, and `requireUser` narrows
  it. `resolveApiUser` is `resolveActor` plus `requireUser`, so every
  existing endpoint refuses a service.
- `acceptsToken` includes `m2m_token`. OAuth tokens are excluded, because
  listing a token type is what makes it acceptable.
- **The credential mechanism is not chosen until a real caller exists.**
  `matchmaker-tick` does not count: it runs `runMatcherPass()` in-process
  and calls `src/lib/` directly, so there is no request to authenticate.
- Guidance for when it is chosen:
  - A **purely internal job** should use a signed secret or HMAC, verified
    locally, which keeps Clerk out of the internal critical path.
  - A **caller operated by a third party** should use Clerk M2M.
  - `CLERK_SECRET_KEY` is the backend master key and is **never**
    presented as a caller credential.

## Consequences

- No infrastructure is built for a hypothetical caller.
- The first real service caller — likely the offline importer (feature 12)
  — must choose the credential. It must also add attribution first:
  `GameResult` records no actor today, and backfilling that later is
  guesswork.
- A Clerk M2M token would authenticate today if one were issued, and then
  be refused by every endpoint.
- ~~Open: whether `/.netlify/functions/matchmaker-tick` can be reached over
  HTTP in production has never been verified.~~ **Answered 14 Sep
  (feature 14): it cannot.** Netlify documents that a scheduled function
  cannot be invoked directly with a URL. Manual invocation is the `Run now`
  button in the Netlify UI, which requires an authenticated dashboard
  session, or `netlify functions:invoke` locally. No unauthenticated caller
  can trigger a matcher pass.

  Two caveats this does not remove. The protection is still a property of
  Netlify's routing rather than of our code, so a platform change would not
  announce itself — which is the original reason 0011's default-deny stance
  exists for everything we *do* control. And scheduled functions run only
  on published deploys, never on Deploy Previews or branch deploys, so the
  matcher will not run in the preview environment that feature 13 builds.
- Open, from the feature 11 plan's starting position: a service may record
  games, but may not act inside the matchmaking lifecycle as a player.

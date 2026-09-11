# Closing the Authenticated Boundary — Feature Plan

> **Reframed 2026-09-10.** This began as "add a service identity". The
> actual goal is narrower and more useful: *reject any call to any of our
> endpoints that does not come from ourselves or a signed-in user.*
> Service identity is one piece of that, and not the urgent one — see
> "Status" below.

A way for **the system itself** to authenticate to its own API, distinct
from any human user. This is a **high-level** plan; per-endpoint shapes and
the task breakdown come after the decisions in Checkpoint 1 are locked.

## Status

**Done.**

- **Server functions are default-deny.** They compile to public endpoints
  at `/_serverFn/<id>`, and authentication was opt-in: fifteen handlers
  called `authenticatedUser()`, two did not. An anonymous call to the
  built server returned a full page of leaderboard data — demonstrated,
  not theorised. `functionMiddleware` now authenticates every server
  function unless it is in a one-entry allowlist (`syncUserFn`, the
  sign-in path, which verifies Clerk itself).
- **REST routes are default-deny.** `apiMiddleware` authenticates the
  whole `/api/v1` surface; only `openapi.json` is exempt. A test asserts
  every route file attaches the middleware, so a new route cannot skip it
  silently.
- **The actor seam exists.** `resolveActor` returns
  `{ kind: 'user' } | { kind: 'service' }`, and `requireUser` narrows it.
  `acceptsToken` includes `m2m_token`, so a machine credential *would*
  resolve — nothing issues one yet.

**Deliberately not done: the credential mechanism.**

The original plan locked "use Clerk M2M" by inheritance from feature 6's
personal-API-key decision. That premise does not transfer. A user's PAT
belongs to a person Clerk already manages; a machine credential does not,
and using a *user* identity provider for machine auth puts Clerk in the
critical path for internal operations — a Clerk outage would stop
internal jobs, not just sign-ins. It also pulls against the goal of not
depending on live systems in local development.

The alternatives — a signed secret from the secrets manager, or HMAC
request signing — verify locally, cost nothing, and work offline, at the
price of manual rotation and no revocation trail.

**The decision is deferred until a real caller exists, because there
isn't one.** `matchmaker-tick` runs `runMatcherPass()` in the same
process; it calls `src/lib/` directly, so there is no request to
authenticate and a credential would buy it nothing. The batch importer is
not built. Choosing a mechanism now would be choosing for a hypothetical.

**When one does exist:** for a purely internal job, prefer a signed secret
and keep Clerk out of the internal critical path. For anything
representing a third party, Clerk M2M. Note also that
`CLERK_SECRET_KEY` is **not** a candidate — it is the backend master key
and must never be presented as a caller credential.

## Context

Today the only authentication mechanism is Clerk, and every credential
resolves to a human:

- Clerk **session token** (browser), and
- Clerk **API key** (PAT) — user-scoped; its `subject` is a `user_…` id.

Both terminate in `resolveApiUser`, which guarantees a `User` row and
throws otherwise. Everything downstream leans on that guarantee.

There is no shared secret, signing key, HMAC, or webhook signature
verification anywhere in the codebase. The whole environment is
`CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `NODE_ENV`. Note that
`CLERK_SECRET_KEY` authenticates **us to Clerk**; it gives a caller no way
to prove its identity **to us**.

Two things make this a problem now:

1. **Recording offline matches.** We want to bulk-record games played away
   from the app. Users must not be able to record arbitrary games (feature
   6 closed exactly that hole), but the system must be able to.
2. **`netlify/functions/matchmaker-tick.ts` already has no authentication
   at all.** It runs `runMatcherPass()` every minute — pairing players and
   creating pending games — and its only protection is that Netlify treats
   it as a scheduled function. That is a property of platform routing, not
   of our code, and nothing would tell us if it changed.

So we already have a privileged non-human actor, authenticated by
convention rather than by credential. This feature retrofits a real one.

Feature 6 deferred machine-to-machine identities on the grounds that "we
have no use for service identities yet". That premise is now false; this
plan supersedes that non-goal.

## Goal

A **service identity**: a credential representing the system, with no human
behind it, that the API can verify and authorise distinctly from a user —
plus the actor-model change that makes "the caller might not be a person"
representable, and its first two consumers.

## Non-goals

- **Not** a third-party developer platform. No OAuth client registration or
  partner onboarding.
- **Not** scoped/delegated roles. A tournament organiser's authority is
  bounded by a tournament they own and needs a grant table keyed by
  (user, scope) — see `src/lib/authorization.ts`. Unrelated to this.
- **Not** replacing personal API keys. A user's PAT keeps working exactly
  as it does; this is an additional principal type.
- **Not** letting a service impersonate a user. A service acts *as the
  system*, and its actions are attributed as such (see Audit below).

## Key decisions to lock in Checkpoint 1

1. **Credential mechanism.** Recommendation: **Clerk M2M tokens**,
   consistent with the locked decision to keep all identity in Clerk.
   Verified present in the installed `@clerk/backend@3.2.14`
   (`M2MTokenApi`: create / revoke / list; `mt_` opaque or JWT format;
   subject is a `mch_…` machine id). `authenticateRequest` already accepts
   them via `acceptsToken: ['m2m_token']` — feature 6 deliberately left
   that out of the accept list, so enabling it is a small, localised
   change.

   **Spike first, exactly as T3 did for API keys**: confirm the feature is
   enabled on our Clerk plan/instance before building on it. That check
   blocked nothing last time only because it passed.

   The alternative — a self-managed shared secret in an env var, compared
   with `timingSafeEqual` — is cheaper but reintroduces the key handling
   the PAT decision deliberately avoided (rotation, storage, no revocation
   trail). Prefer Clerk unless the enablement spike fails.

2. **Actor model.** `resolveApiUser` currently guarantees a `User`. Replace
   with an actor union:

   ```
   Actor = { kind: 'user'; user: AuthenticatedUser }
         | { kind: 'service'; serviceId: string }
   ```

   `src/lib/authorization.ts` is the intended seam — `canActOnGame` takes
   an `Actor` rather than a `User`, and call sites should not move. Decide
   whether user-only endpoints get a narrowing helper (e.g.
   `requireUser(actor)`) so that "this endpoint is meaningless for a
   service" is expressed once rather than re-checked everywhere.

3. **What a service may do.** Starting position: a service may record game
   results (including backdated and batched), and may run the matcher. A
   service may **not** act inside the matchmaking lifecycle as if it were a
   player (start a search, confirm a match) — those are meaningless without
   a person. Lock the list; do not grant blanket authority.

4. **Audit.** `GameResult` records no actor today. If the system records a
   game, that should be distinguishable from a player recording it — both
   for trust and for debugging a bad import. Likely a nullable
   `recordedBy` / `recordedByService` column. Decide before the batch
   endpoint ships, because backfilling attribution afterwards is guesswork.

## Checkpoints

### Checkpoint 1 — Service identity foundation
The enablement spike, the credential wrapper, the actor-model refactor, and
`acceptsToken` extended to `m2m_token`. Ship one existing endpoint accepting
a service credential end-to-end, with tests covering: a service token
authenticates; a user token still authenticates unchanged; a service is
refused where only a user makes sense.

### Checkpoint 2 — Bring `matchmaker-tick` under it
First, **verify how Netlify actually exposes scheduled functions** on our
deployment — whether `/.netlify/functions/matchmaker-tick` is reachable
over HTTP in production. Treat the answer as a finding either way; it
determines whether this is a live exposure or a latent one.

Then give the tick a real credential instead of relying on platform
routing, so its authorisation is a property of our code.

### Checkpoint 3 — *(spun out)*

Batch import of offline games is now
**`.claude/plans/feature-12-offline-game-import.md`**. It is a feature in
its own right rather than a checkpoint of an auth change: its hard parts
— Elo's order-dependence, idempotency, and backdating — have nothing to
do with authentication, and bundling them here would have hidden three
design decisions inside a security change.

It remains the first concrete caller that authenticates as the system,
and therefore the thing that decides feature 11's deferred credential
question.

## Testing

Reuse the existing HTTP harness (`src/test/http.ts`) and DB infrastructure;
`stubClerkCredential` gains a `service` credential kind. As with feature 6,
Clerk is mocked and the database is real: these tests prove our adapter
distinguishes principals correctly, not that Clerk verifies a token. A live
check with a real M2M token is worth doing once, as the PAT curl was — it
is what caught Clerk's revocation window.

Batch import needs integration tests asserting **ordering** (same games,
different submission order, identical final ratings) and **idempotency**
(the same batch applied twice leaves ratings unchanged).

## Open questions

- One service identity, or one per caller (importer, tick, future jobs)?
  Separate identities give a revocation and audit story per job; one is
  simpler. Leaning separate.
- Where do service credentials live in local development? This lands right
  next to the goal of not using live systems locally — a local fake is more
  tractable for a service credential than for a full Clerk user session.
- Does the batch importer need its own rate-limit exemption once T10's
  limiter is in place? A legitimate import will look like abuse.

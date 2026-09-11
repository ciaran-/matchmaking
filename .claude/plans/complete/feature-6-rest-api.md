# REST API — Feature Plan

A public HTTP API that exposes the same capabilities the web app already
has, backed by the **same `src/lib/` core** the server functions call. This
is the first step toward supporting non-browser clients (mobile, scripts,
future integrations) and is delivered as one feature with several
independently-shippable checkpoints.

This is a **high-level** plan. Per-endpoint shapes and the task breakdown
come later, once the conventions in Checkpoint 1 are locked.

## Context

- CLAUDE.md states the REST API is planned and that "the REST API and
  frontend-facing server functions should share core logic, with any
  usage-specific data translation located outside the shared core."
- The `src/lib/` layer is already framework-agnostic and fully covered by
  unit + integration tests. The API is a **thin HTTP adapter** over it — it
  should add almost no business logic.
- The integration-test infra (`src/test/db.ts`, factories, scenarios) was
  deliberately built to be reused for HTTP-level tests once the API exists
  (see `project_future_http_tests`).
- Today every client capability lives in `createServerFn` handlers inside
  route files (`__root`, `league`, `match`). Two of them duplicate an
  `authenticatedUser` Clerk helper inline.

## Goal

Stand up a versioned REST API (`/api/v1/...`) that mirrors the existing
client capabilities — read models, game recording, and the matchmaking
lifecycle — as HTTP endpoints, with a consistent auth model, error
envelope, validation boundary, and HTTP-level test coverage. The web app
keeps working exactly as it does now; the API is additive.

## Non-goals

- **Not** replacing or removing the existing server functions. The web app
  continues to call `createServerFn` handlers; both paths converge on the
  same `src/lib/` core. (Server fns may later be refactored to call the
  same adapter logic, but that is not required to ship this.)
- **Not** writing new business logic. If an endpoint needs behaviour that
  doesn't exist in `src/lib/`, that gap is called out and handled as its
  own change, not smuggled into the HTTP layer.
- **Not** the realtime/scaling refactor. The API exposes the existing
  poll-based matchmaking state as-is. Push/SSE/websockets and read-model
  projection remain future work (flagged, not fixed here).
- **Not** a third-party developer platform. No OAuth client registration or
  partner onboarding in this feature. Auth is Clerk-backed and **user-scoped
  only** (see Checkpoint 1): a credential always resolves to a human user.
  **Machine-to-machine (service) identities** — a credential representing a
  CI job / bot / backend with no user behind it — are explicitly deferred;
  we have no use for service identities yet.
- No GraphQL. REST + JSON only.

## Key decisions to lock in Checkpoint 1 (discuss before building)

These shape everything downstream, so they're resolved first:

1. **HTTP mechanism.** Confirm TanStack Start's server/API route mechanism
   (file-based server routes under `src/routes/api/`) and that it coexists
   cleanly with the existing `createServerFn` handlers and the Vite
   server-split. Verify with a single reference endpoint before fanning out.
2. **Versioning.** Namespace under `/api/v1/`. Cheap insurance; lets the web
   app's server fns evolve independently of the public contract.
3. **Auth model — dual credential, single resolution.** Every endpoint
   accepts **either** of two credentials, both of which resolve to the same
   Clerk/DB user; everything downstream is identical regardless of which was
   used:
   - **Clerk session token** — what the browser/web app already sends. The
     Clerk SDK acquires and refreshes it invisibly after interactive
     sign-in; the server validates it via the existing `authenticateRequest`
     dance. This path needs no new work beyond the shared helper.
   - **Personal API key (PAT)** — for programmatic clients (scripts, mobile,
     CI acting *as a user*). A browser-less client has no way to obtain a
     short-lived session token, so it can't use the session path at all.
     Instead, a signed-in user generates a long-lived, revocable key in the
     web app and sends it as `Authorization: Bearer <key>`. The API resolves
     it to that user. This is the GitHub-PAT model and is the *only* thing
     that makes the API usable outside a browser — so it is **in scope for
     this feature**, not a follow-up.

   **Decision (locked): use Clerk's native, user-scoped API keys** — issue,
   verify, and revoke them through Clerk so all identity stays in one system.
   We do **not** maintain our own key table or hashing. The only open work is
   confirming the exact Clerk SDK surface and that the feature is enabled on
   our plan (Checkpoint 1 spike), then wrapping it.

   Also decide how unauthenticated reads (if any) are treated. Service-level
   (M2M) credentials remain out of scope (see Non-goals).
4. **Error envelope + status codes.** One consistent JSON error shape and a
   small mapping from `src/lib/` thrown errors → HTTP status. Reuse
   `user-facing-errors.ts` where it fits.
5. **Validation boundary.** A schema-validation layer (e.g. zod) at the HTTP
   edge so handlers receive typed, validated input — the lib core stays
   trusting of its callers.
6. **Shared auth helper.** Extract the duplicated inline `authenticatedUser`
   (currently in `match.tsx` and `league.tsx`) into a reusable server-only
   module that both the server fns and the API adapters call.

## Checkpoints

Each checkpoint is independently shippable and testable. Order is chosen so
the conventions are proven on low-risk reads before touching writes.

### Checkpoint 1 — Foundations & one reference endpoint
Establish the mechanism, conventions, and shared plumbing from the decisions
above. Specifically includes the **dual-credential auth foundation**:
- the shared auth helper resolving **both** a Clerk session token and a
  personal API key to the same user;
- the **verify-Clerk's-native-API-keys** spike (decides build-vs-reuse for
  PATs) before any key-storage code is written;
- PAT **issuance + revocation** (web-app surface to mint/revoke keys) and
  **validation** on the API edge.

Ship **one** real endpoint end-to-end (a simple read, e.g. league
places/leaderboard), reachable via *both* credentials, plus its HTTP-level
integration test, to prove the pattern through to the DB. Nothing else fans
out until this is settled.

### Checkpoint 2 — Read endpoints
Expose the existing read models as GETs: leaderboard / league places, league
activity (already anonymised — preserve that contract), current user's
matchmaking state, and match state. Pure reads, no side effects. Establishes
serialization conventions on safe ground.

### Checkpoint 3 — Game results & rating
`POST` to record a game result, wrapping `recordGame`. Exercises the
write-path conventions (validation, auth, error mapping, idempotency
considerations) on a single well-understood operation.

### Checkpoint 4 — Matchmaking lifecycle
The full queue lifecycle as endpoints, over the existing event-sourced lib:
start search, cancel search, get/poll state, confirm, decline, record
pending-game result. Trickiest checkpoint — the current design assumes a
polling client; the API exposes that same model honestly (no new realtime
behaviour). Reuses the matchmaking integration scenarios.

### Checkpoint 5 — Hardening & docs
Cross-cutting concerns once the surface is complete: basic rate limiting,
request logging / Sentry spans on the HTTP layer, and machine-readable docs
(OpenAPI spec or equivalent) so the API can actually be "shared around."
Some of this may be pulled earlier if it's cheaper to bake in than retrofit.

## Architecture (the shared-core contract)

```
HTTP request
  → API route (src/routes/api/v1/...)        ← thin adapter
      · validate input (schema)
      · authenticate (shared Clerk helper)
      · map lib result/throw → HTTP envelope
  → src/lib/ core function                    ← shared with server fns
  → Prisma → Postgres
```

The same `src/lib/` function backs both the web app's `createServerFn` and
the REST endpoint. Any usage-specific translation (HTTP shaping, the
web-specific poll bundle, etc.) lives in the adapter, never in the core.

## Testing

- HTTP-level integration tests reusing `src/test/db.ts` + factories +
  scenarios — no new DB infra (this is exactly what that infra was built
  for). One per endpoint group, asserting status codes, error envelope, auth
  rejection, and DB effects.
- The existing `src/lib/` unit + integration tests already cover the
  business logic; the HTTP tests focus on the adapter (validation, auth,
  serialization, status mapping), not re-testing the core.

## Open follow-ups (track separately, do not bundle here)

- **Machine-to-machine (service) identities** — credentials representing a
  service/bot/CI job with no user behind them (distinct from a *user's* PAT,
  which ships in this feature). Needed only once a non-human caller exists.
- Refactoring the existing server fns to call the same adapter layer (vs.
  just the same lib core) to remove the last duplication.
- Realtime delivery for matchmaking (SSE/websockets) — replaces polling for
  API clients too; depends on the broader scaling work.
- Pagination / filtering conventions if read endpoints grow large.

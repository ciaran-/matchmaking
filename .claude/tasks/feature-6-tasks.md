# Feature 6 — REST API: Task List

Plan: `.claude/plans/feature-6-rest-api.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

This feature is **large and checkpointed**. Tasks are grouped by the plan's checkpoints. Each checkpoint is independently shippable — prefer separate PRs per checkpoint rather than one mega-PR.

---

## Dependency graph

```
Checkpoint 1 (foundations)
  T1 (mechanism spike + conventions) ──┬─> T2 (shared auth helper: session) ──┐
                                       │                                       ├─> T6 (reference endpoint + HTTP test infra)
  T3 (confirm Clerk API-key surface) ──> T4 (issue/revoke via Clerk) ──> T5 (key validation → resolver)┘
                                                                                       │
Checkpoint 2   T7 (read endpoints) <───────────────────────────────────────────────────┤
Checkpoint 3   T8 (game-result write) <─────────────────────────────────────────────────┤
Checkpoint 4   T9 (matchmaking lifecycle) <─────────────────────────────────────────────┤
Checkpoint 5   T10 (rate limit + logging + OpenAPI) <───────────── after T7/T8/T9 land
```

### Parallelism

- **T1 and T3** (both spikes) can run in parallel — different concerns.
- **T2** (session resolution) and the **T3→T4→T5** PAT chain can proceed in parallel once T1 fixes conventions; they converge in T5 (the resolver accepts both credentials).
- **T7, T8, T9** are independent of each other once T6 lands; they can be three parallel agents.

### Strict ordering

T1 → T2; T3 → T4 → T5; (T2, T5) → T6 → (T7, T8, T9) → T10.

---

## Pre-flight (do once before starting any task)

1. Read `.claude/plans/feature-6-rest-api.md` end-to-end.
2. Read `CLAUDE.md` — especially **`createServerFn` Pattern**, **Clerk auth guard**, **Testing** (unit + integration), **Path Aliases**, and **Netlify Production Checklist**.
3. Read the saved memory pointers: `feedback_server_fn_pattern`, `project_netlify_production_gotchas`, `feedback_prefer_static_imports`.
4. Confirm `npm install`, `npm run build`, `npm run test`, and `npm run test:integration` (Docker required) pass on current `main`.
5. Confirm `.mcp.json` exists locally with a valid `DATABASE_URL`. **No schema changes are required for this feature** — API keys are issued/verified through Clerk, so there is no new Prisma model or migration.
6. Branch per checkpoint: `feature-6-rest-api-cp<N>-agent-<short-id>`.

**Auth decision (locked):** personal API keys use **Clerk's native, user-scoped API keys** — issue/verify/revoke through Clerk, no self-managed key table or hashing. See the plan's auth decision.

**Stack facts** (verified): `@tanstack/react-start@^1.167`, `@tanstack/react-router@^1.168`, `zod@^4.1`. Server routes are available via TanStack Start's file-based server-route API — T1 confirms the exact export name and signature against the installed version.

---

## T1 — Mechanism spike + API conventions

**Status:** done
**Depends on:** nothing
**Blocks:** T2, T6
**Parallel with:** T3

### Context

The plan defers the exact HTTP mechanism to this checkpoint. TanStack Start ships file-based **server routes** (distinct from `createServerFn`). This task pins down the exact API for the installed version and locks the cross-cutting conventions every later endpoint depends on, so they aren't re-litigated per-endpoint.

### Read first

- `node_modules/@tanstack/react-start` exports + the installed version's docs for "server routes" / "API routes". Confirm the real export (historically `createServerFileRoute`, but **verify** — do not trust this name blindly).
- `src/router.tsx`, `src/routes/__root.tsx` — how routing is currently configured.
- `src/lib/user-facing-errors.ts` — existing error-message helper to reuse in the envelope.

### Deliverables

1. **A throwaway reference route** under `src/routes/api/v1/` (e.g. `_health.ts` or `ping.ts`) returning `{ ok: true }` as JSON, proving the mechanism end-to-end with `npm run build` + a curl against `npm run dev`. Keep it until T6 replaces it with a real endpoint, then delete.
2. **A short conventions doc** committed at `.claude/plans/feature-6-api-conventions.md` capturing the locked decisions:
   - URL namespace: `/api/v1/...`.
   - **Error envelope** — one JSON shape, e.g. `{ error: { code: string; message: string } }`, plus a `lib-error → HTTP status` mapping table (validation→400, auth→401, not-found→404, conflict→409, unexpected→500). Reuse `userFacingError` for the `message`.
   - **Success envelope** — decide bare object vs. `{ data: ... }`. Recommend bare resource objects for reads, `{ data }` only where pagination metadata is needed.
   - **Validation**: zod schema per endpoint at the edge; handler receives parsed input.
   - A tiny shared helper module `src/lib/api/respond.ts` (server-only) with `jsonOk(value, status?)` and `jsonError(code, message, status)` so every route serialises identically.
3. A small unit test for `respond.ts` (pure — no DB, no env).

### Acceptance criteria

- `npm run build` succeeds with the reference route present.
- `curl localhost:3000/api/v1/ping` (dev) returns the JSON.
- Conventions doc committed and concrete enough that T7/T8/T9 authors don't need to invent shapes.
- `respond.ts` unit tests pass; `npm run check` clean.
- Grep `dist/client/assets` confirms the server route's body does not leak server-only signals into the client bundle (per CLAUDE.md verification note).

---

## T2 — Extract shared auth helper (session-token path)

**Status:** done
**Depends on:** T1
**Blocks:** T5, T6
**Parallel with:** T3, T4

### Context

`authenticatedUser()` is currently duplicated inline in `src/routes/match.tsx` (line ~46) and `src/routes/league.tsx` (the `recordGameFn` handler). Both do the same Clerk `authenticateRequest` dance and load the `User` row. Extract one server-only helper that both the existing server fns and the new API routes call. This is the first concrete proof of the plan's "shared core" principle.

### Read first

- `src/routes/match.tsx` lines ~36–69 (`authenticatedUser`) and the headers-only `Request` clone comment.
- `src/routes/league.tsx` lines ~32–47.
- CLAUDE.md §"Clerk auth guard (in server functions)".

### Create

- `src/lib/auth.ts` (server-only — add the `// Server-only module — do not import from client-side code.` header).
- `src/lib/auth.test.ts` (`// @vitest-environment node`).

### Implementation

Expose `authenticatedUser(): Promise<User>` that:
- reads env (`CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`), throws on missing,
- builds the Clerk client, authenticates the **headers-only clone** of `getRequest()` (preserve the existing comment — the body is already consumed by server-fn deserialization; for API routes the body has not been consumed, so accept an optional `request?: Request` param that, when passed, is used directly instead of cloning `getRequest()`),
- resolves `clerkId → User`, throws `Unauthorized` / `User not found` consistently.

Then update `match.tsx` and `league.tsx` to import and call it; delete both inline copies. Verify no behavioural change.

### Tests

Mock `@clerk/backend` and `@tanstack/react-start/server` (per CLAUDE.md testing notes). Cases: missing env throws; unsigned request throws `Unauthorized`; signed but no DB row throws `User not found`; happy path returns the user. Stub env in `beforeEach`.

### Acceptance criteria

- Both routes use the shared helper; inline copies gone; `npm run build` + `npm run test` pass.
- `npm run test:integration` still green (no behaviour change to `recordGameFn`).
- `npm run check` clean.

---

## T3 — Confirm Clerk native API-key surface

**Status:** done
**Depends on:** nothing
**Blocks:** T4
**Parallel with:** T1, T2

### Context

The strategy is decided: **use Clerk's native, user-scoped API keys** (no self-managed key table). This task is a focused integration spike to nail down the *exact* SDK surface and enablement before T4 wraps it — not a build-vs-reuse decision.

### Deliverables

- Against the installed `@clerk/backend` version and Clerk's current docs, document the exact calls for: creating a user-scoped API key, backend verification of an incoming key, listing a user's keys, and revoking a key. Capture the request/response shapes and how the verified key maps back to a Clerk user id.
- Confirm the API-keys feature is **enabled on our Clerk plan/instance** (dashboard toggle / plan tier). Flag immediately if it is not — that blocks T4 and is a decision for the team, not a workaround.
- Note how a Clerk API key is distinguishable on the wire from a Clerk session token (prefix/format) so T5's resolver can branch deterministically.
- Write all of the above into `.claude/plans/feature-6-api-conventions.md` (the doc from T1) under an "API key integration" heading.

### Acceptance criteria

- Exact issue/verify/list/revoke calls documented against the installed SDK version.
- Plan/instance enablement confirmed (or blocker raised).
- Key-vs-session disambiguation rule recorded. No production code beyond throwaway verification.

---

## T4 — API-key issuance + revocation (Clerk wrappers)

**Status:** done — web surface at `/settings/api-keys`
**Depends on:** T3
**Blocks:** T5
**Parallel with:** T2

### Context

Implement personal-API-key issuance, listing, and revocation as **thin wrappers over Clerk's native API-key SDK** (per T3). A signed-in user can mint a key (raw value shown **once** at creation), see their existing keys (prefix/metadata only), and revoke one. **No Prisma model, no migration** — Clerk owns the key store.

### Read first

- T3's documented Clerk calls in `.claude/plans/feature-6-api-conventions.md`.
- `src/lib/auth.ts` (T2) — the existing Clerk client construction (`createClerkClient` with `secretKey` + `publishableKey`) to reuse for these calls.
- CLAUDE.md §"Clerk auth guard" — env-var requirements.

### Implementation

- `src/lib/api-keys.ts` (server-only header): thin functions over the Clerk SDK —
  - `issueApiKey(clerkUserId, name)` → creates a user-scoped Clerk API key, returns `{ raw, metadata }` where `raw` is shown once and **never persisted or logged** by us.
  - `listApiKeys(clerkUserId)` → metadata only (id, name, prefix, created/last-used), never the raw secret.
  - `revokeApiKey(clerkUserId, keyId)` → revokes via Clerk; guard that the key belongs to the calling user.
- All calls reuse the Clerk client from T2; surface Clerk errors mapped to the standard envelope at the route layer.
- Build the **web-app surface** to mint/list/revoke (a small "API keys" section on the profile/settings — confirm placement with feature 7's owner-actions note; a minimal page is fine for v1). Show the raw key exactly once with a copy affordance and an explicit "you won't see this again" warning.

### Tests

`api-keys.test.ts` — mock the Clerk SDK (per CLAUDE.md testing notes; stub env in `beforeEach`). Cases: issue returns a raw value once and never persists it locally; list returns metadata without the secret; revoke calls Clerk with the right key id and rejects revoking another user's key; Clerk errors propagate as mappable errors.

### Acceptance criteria

- Issue / list / revoke work against Clerk; **no new Prisma model or migration**.
- Raw key never stored or logged on our side.
- Tests pass; `npm run build` + `npm run check` clean.

---

## T5 — Dual-credential resolver

**Status:** done
**Depends on:** T2, T4
**Blocks:** T6
**Parallel with:** nothing

### Context

Unify both credentials behind one entry point so every endpoint is credential-agnostic. An incoming request authenticates via **either** a Clerk session token (cookie/Bearer, as today) **or** a personal API key (`Authorization: Bearer <pat>`), both resolving to the same `User`.

### Read first

- `src/lib/auth.ts` (T2), `src/lib/api-keys.ts` (T4), and T3's documented Clerk verification call + key-vs-session disambiguation rule in `.claude/plans/feature-6-api-conventions.md`.

### Implementation

In `src/lib/auth.ts`, add `resolveApiUser(request: Request): Promise<User>` that:
1. Inspects the `Authorization` header. If it carries a **Clerk API key** (identified via the prefix/format rule from T3) → verify it through Clerk (T4's path), resolve the returned Clerk user id → our `User` row, return it.
2. Otherwise → fall through to the existing Clerk session path (`authenticatedUser(request)`).
3. Throws the standard `Unauthorized` (mapped to 401 by the envelope) if neither resolves.

Keep `authenticatedUser` for the web server fns; `resolveApiUser` is the API edge's entry point and may simply wrap it. Both paths converge on a `User` looked up by `clerkId`, so downstream code is identical.

### Tests

`auth.integration.test.ts` (mock the Clerk SDK; stub env in `beforeEach`): valid API key resolves to the right user; revoked/invalid key → 401; malformed Bearer → 401; no credential → 401; valid session token still resolves. Key-vs-session disambiguation covered.

### Acceptance criteria

- Both credential types resolve to the correct user through one function.
- Revoked/expired keys rejected.
- `npm run check` + tests + `npm run build` clean.

---

## T6 — Reference endpoint + HTTP-level test infra

**Status:** pending
**Depends on:** T2, T5
**Blocks:** T7, T8, T9

### Context

Prove the whole stack — server route → validation → `resolveApiUser` → lib core → DB → envelope — with **one real read endpoint reachable via both credentials**, and stand up the HTTP-level integration-test harness the later endpoints reuse. Replace the throwaway T1 route.

### Read first

- `.claude/plans/feature-6-api-conventions.md` (T1/T3).
- `src/test/db.ts`, `src/test/factories/*`, `src/test/scenarios.ts` — reuse, do not rebuild (`project_future_http_tests`).
- `src/routes/league.tsx` `getLeaguePlaces` — the read this endpoint mirrors.

### Implementation

- `src/routes/api/v1/leaderboard.ts` (or similar) — a GET server route that calls a lib read fn (reuse `getLeaguePlaces`' query, or the feature-10 `getLeaderboard` if that's landed; if not, a minimal inline lib read is fine and gets replaced by feature 10). Auth via `resolveApiUser`. Serialise via `respond.ts`.
- HTTP test harness: a helper that issues a request against the route handler with a fabricated credential (a test PAT issued via T4, and/or a mocked Clerk session) inside the `withRollback` transaction. Document the pattern so T7/T8/T9 copy it.

### Tests

`*.integration.test.ts`: 200 + correct body shape with a valid PAT; 200 with a (mocked) valid session; 401 with no/invalid credential; envelope matches the conventions doc.

### Acceptance criteria

- Endpoint works via curl with a real PAT against `npm run dev`.
- HTTP integration tests pass and reuse `src/test/db.ts` + factories (no new DB infra).
- `npm run build` clean; client bundle free of server-only signals.
- Harness documented for reuse.

---

## T7 — Read endpoints (Checkpoint 2)

**Status:** pending
**Depends on:** T6
**Blocks:** T10
**Parallel with:** T8, T9

### Context

Expose the existing read models as GETs, following T6's pattern exactly. No new business logic — wrap existing lib reads.

### Endpoints (each: zod-validated params, `resolveApiUser`, envelope, HTTP test)

- `GET /api/v1/leaderboard` (already from T6 — extend with pagination params if feature 10 has landed; otherwise leave minimal).
- `GET /api/v1/league/activity` → wraps `getLeagueActivity` (`src/lib/matchmaking/dashboard.ts`). **Preserve the anonymisation contract** — return the bundle unchanged; add an HTTP test asserting no identifying fields (reuse feature 5's forbidden-keys approach).
- `GET /api/v1/me/search` → current user's active search (`getActiveSearchForUser`).
- `GET /api/v1/matches/:matchId` → `getMatchState`.

### Acceptance criteria

- Each endpoint: happy-path 200, 401 unauth, 404 where applicable, envelope-conformant.
- Activity endpoint passes the anonymisation assertion.
- No business logic added in route files — all delegate to `src/lib/`.
- `npm run check` + tests + build clean.

---

## T8 — Game-result write endpoint (Checkpoint 3)

**Status:** pending
**Depends on:** T6
**Blocks:** T10
**Parallel with:** T7, T9

### Context

First write path. `POST /api/v1/games` wrapping `recordGame` (`src/lib/record-game.ts`, `RecordGameInput = { playerAId, playerBId, result: 'A'|'B'|'draw' }`).

### Read first

- `src/lib/record-game.ts` (signature + throws: same-player, players-not-found).
- `src/routes/league.tsx` `recordGameFn` — the existing server-fn equivalent to mirror.

### Implementation

- zod body schema for `RecordGameInput` (`result` enum `['A','B','draw']`).
- `resolveApiUser` for auth (decide & document authorization policy: who may record a game — any signed-in user, as today? note it in the conventions doc).
- Map `recordGame` throws to envelope statuses: same-player / players-not-found → 400/404 per the mapping table; success → 201 with the `RecordGameOutput`.

### Tests

HTTP integration: valid body records a game + returns rating changes; same-player → 400; unknown player → 404; bad `result` value → 400 (zod); missing credential → 401. Reuse `createUser` factory inside `withRollback`.

### Acceptance criteria

- Endpoint records games and returns the documented shape.
- All error cases mapped correctly; `npm run check` + tests + build clean.

---

## T9 — Matchmaking lifecycle endpoints (Checkpoint 4)

**Status:** pending
**Depends on:** T6
**Blocks:** T10
**Parallel with:** T7, T8

### Context

Expose the queue lifecycle over the existing event-sourced lib. **No new realtime behaviour** — the API surfaces the same poll-based model the web app uses. Mirror the server fns in `src/routes/match.tsx` (`startSearchFn`, `cancelSearchFn`, `pollSearchStatusFn`, `confirmMatchFn`, `declineMatchFn`, `recordPendingGameResultFn`).

### Read first

- `src/routes/match.tsx` — all six server fns and their lib calls.
- `src/lib/matchmaking/search.ts`, `pending-game.ts`, `state.ts`, `run-matcher.ts`.

### Endpoints

- `POST /api/v1/search` → `createSearch` + hot-path `runMatcherForSearch`, returns derived state.
- `DELETE /api/v1/search` (or `POST /api/v1/search/cancel`) → `cancelSearch`.
- `GET /api/v1/search` → poll current state (mirror `pollSearchStatusFn`, incl. inline `expireIfStale`).
- `POST /api/v1/matches/:matchId/confirm` → `confirmPendingGame`.
- `POST /api/v1/matches/:matchId/decline` → `declinePendingGame`.
- `POST /api/v1/matches/:matchId/result` → `convertPendingGameToResult`.

All authenticate via `resolveApiUser` and **scope actions to the calling user** (a caller may only act on their own search / a match they belong to — assert this, returning 403 otherwise).

### Tests

HTTP integration reusing matchmaking scenarios (`twoSearchingPlayersAtEqualRating`, factories in `src/test/factories/matchmaking-events.ts`): start→match→confirm×2→result happy path; cannot act on another user's match (403); poll reflects state transitions; decline path. Race/terminal cases mirror the existing lib tests (don't re-test the lib, test the adapter).

### Acceptance criteria

- Full lifecycle drivable over HTTP with PAT auth.
- Cross-user action attempts rejected (403).
- `npm run check` + tests + build clean.

---

## T10 — Hardening: rate limiting, logging, OpenAPI (Checkpoint 5)

**Status:** pending
**Depends on:** T7, T8, T9
**Blocks:** nothing (ship)

### Context

Cross-cutting concerns once the surface is complete, so the API is safe and documented enough to share.

### Deliverables

- **Rate limiting**: a simple per-credential limiter on the API routes (in-process token bucket is acceptable v1; note shared/edge limiter as a follow-up — consistent with `feedback_no_premature_caching`, don't over-build). Return 429 with the standard envelope + `Retry-After`.
- **Logging / observability**: wrap each route handler in a `Sentry.startSpan` (per CLAUDE.md) named per endpoint; ensure 5xx are captured. Do not log raw PATs or request bodies containing secrets.
- **OpenAPI**: a machine-readable spec (`openapi.json` or generated from the zod schemas, e.g. via `zod-to-openapi`) served at `/api/v1/openapi.json`, plus a short `docs/api.md` linking it. This is what makes the API genuinely shareable.

### Acceptance criteria

- Exceeding the limit returns 429 + `Retry-After`; normal traffic unaffected.
- All API routes appear as Sentry spans; no secrets logged.
- OpenAPI spec validates and covers every endpoint from T7/T8/T9; `docs/api.md` references it.
- `npm run check` + tests + build clean. PR notes the Clerk API-keys plan/instance enablement (T3) and the rate-limit/edge follow-ups.

---

## Out of scope (do not bundle into this feature)

Per the plan's "Open follow-ups":

- Machine-to-machine (service) identities — distinct from a user's PAT.
- Refactoring the web server fns to call the API adapter layer (vs. sharing only the lib core).
- Realtime delivery (SSE/websockets) for matchmaking.
- Shared/edge rate limiting and pagination/filtering conventions beyond v1 basics.

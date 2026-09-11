# 0011. The REST API is a versioned contract with one envelope and edge validation

- **Status:** Accepted
- **Date:** 2026-09-09
- **Source:** `.claude/plans/complete/feature-6-rest-api.md`; the working
  rules are in `docs/api-conventions.md`, and the consumer-facing
  documentation is `docs/api.md`

## Context

The REST API exists so clients other than the browser can use the product.
Once it is shared, its shapes are a promise, and settling them per endpoint
would produce an inconsistent API.

## Decision

- **Versioned under `/api/v1`.** It is a published contract; the web app's
  server functions can change freely.
- **Bare resources.** `{ data, … }` wrapping is used only for paginated
  collections.
  - **Cursor pagination** for append-only feeds (match history).
  - **Page and offset, with a total**, for ranked tables where position
    matters (leaderboard).
  - When in doubt, use a cursor: it stays correct under concurrent writes.
- A single resource that may be absent returns `200` with `null`. `404`
  means the identifier names nothing.
- **One error envelope**, `{ error: { code, message } }`, with a closed set
  of codes. Messages are user-facing copy only; raw errors never reach the
  client.
- **Validation at the edge** with one zod schema per endpoint. `src/lib/`
  trusts its callers.
- **The OpenAPI spec is generated from those same zod schemas**, and a
  test asserts it covers every route. It is the only unauthenticated API
  path (0003).
- **Rate limit:** 120 requests per minute per credential, kept in process
  memory. Deliberately a courtesy limit, not a security control. On
  serverless each instance counts separately, and real enforcement belongs
  at the edge or in a shared store.

## Consequences

- Clients get one predictable shape for success, failure and paging.
- `src/lib/` has no typed errors, so HTTP status is chosen by matching
  error message text. Renaming a message can silently change a status code.
  Typed error classes are the tracked fix; until then the mapping table in
  `src/lib/api/errors.ts` is the one place to update.
- The rate limit does not bound abuse. Clients are told to respect
  `Retry-After` regardless.
- Adding pagination to an existing endpoint changes its shape: a
  documented breaking change within `v1`, or it waits for `v2`.

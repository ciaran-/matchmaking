# Feature 6 — REST API conventions

Locked in T1. Every endpoint in checkpoints 2–5 follows this document; it
exists so per-endpoint shapes aren't re-litigated by each task's author.

Verified against `@tanstack/react-start@1.167.16` /
`@tanstack/router-core@1.168.9` / `zod@4.1.11`.

---

## 1. HTTP mechanism

There is **no `createServerFileRoute`** in this version. Server routes are
ordinary file routes that declare a `server.handlers` map — the same
`createFileRoute` used by page routes:

```ts
import { createFileRoute } from '@tanstack/react-router';
import { jsonOk } from '@/lib/api/respond';

export const Route = createFileRoute('/api/v1/ping')({
	server: {
		handlers: {
			GET: () => jsonOk({ ok: true }),
		},
	},
});
```

Facts established by the T1 spike:

- Handler signature is `(ctx) => Response | Promise<Response>`, where `ctx`
  is `{ request, params, pathname, context, next }` (`request` is a real
  `Request`; `params` are the typed path params). Types live in
  `node_modules/@tanstack/start-client-core/dist/esm/serverRoute.d.ts`.
- Supported method keys: `ANY`, `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `OPTIONS`, `HEAD`.
- **The request body is not consumed before the handler runs.** This is the
  key difference from `createServerFn` handlers, which is why the shared
  auth helper (T2) must accept an explicit `request` rather than always
  cloning `getRequest()`.
- A route file with `server.handlers` and **no component** is stripped from
  the client bundle entirely — after `npm run build`, `api/v1` appears in
  `dist/server/assets/router-*.js` and matches zero times across
  `dist/client/assets/*.js`. Server-only imports in these files are
  therefore safe, consistent with CLAUDE.md's `createServerFn` guidance.
- Route files are picked up by the router plugin automatically;
  `routeTree.gen.ts` regenerates on build. Do not hand-edit it.

Per-route `server.middleware` exists and is where rate limiting and Sentry
spans should attach in T10 — **do not** hand-roll a wrapper function for
those in T7–T9.

## 2. URL namespace

- Everything lives under `/api/v1/...`, one file per resource under
  `src/routes/api/v1/`.
- Path params use the router's file conventions (`$matchId.ts` →
  `params.matchId`).
- The version prefix is deliberate: the web app's `createServerFn` handlers
  can evolve freely; `/api/v1` is a published contract.

## 3. Success envelope

**Bare resource objects.** `GET /api/v1/matches/:id` returns the match
object itself, not `{ data: match }`. Collections return a bare JSON array.

Wrap in `{ data, ... }` **only** where envelope metadata is genuinely
needed — i.e. when pagination lands (a follow-up in the plan, not v1).
Mixing the two shapes per-endpoint is worse than either, so if pagination
is added to an endpoint, that endpoint moves to `{ data, page }` as a
documented breaking change within `v1` or waits for `v2`.

Status codes: `200` reads, `201` for creates that produce a resource
(`POST /api/v1/games`), `204` for successful actions with no body.

## 4. Error envelope

One shape, always:

```json
{ "error": { "code": "not_found", "message": "That player does not exist." } }
```

- `code` is the stable, machine-readable discriminator. Clients branch on
  it. The closed set is `ApiErrorCode` in `src/lib/api/respond.ts`.
- `message` is **user-facing copy only**, produced via `userFacingError(e,
  fallback)` from `src/lib/user-facing-errors.ts`. Raw thrown messages are
  never returned — they leak Prisma and implementation detail. Sentry still
  captures the original.

| Condition | `code` | HTTP |
| --- | --- | --- |
| Schema/zod validation failure, malformed body | `bad_request` | 400 |
| Missing/invalid/revoked credential | `unauthorized` | 401 |
| Valid credential, not the caller's resource | `forbidden` | 403 |
| Resource does not exist | `not_found` | 404 |
| State conflict (already terminal, already recorded) | `conflict` | 409 |
| Rate limit exceeded (T10) | `rate_limited` | 429 |
| Anything else | `internal` | 500 |

### Mapping lib throws → status

`src/lib/` throws plain `Error` with descriptive messages; there is no
error-type taxonomy today. The HTTP edge therefore maps by **message
pattern**, exactly as `userFacingError` already does, and defaults to
`internal`/500 for anything unrecognised:

| Thrown message contains | `code` | HTTP |
| --- | --- | --- |
| `Unauthorized` | `unauthorized` | 401 |
| `not a participant` | `forbidden` | 403 |
| `not found` (`match … not found`, `One or both players not found`) | `not_found` | 404 |
| `must be different` | `bad_request` | 400 |
| `already terminal`, `not BOTH_CONFIRMED`, `first-wins` | `conflict` | 409 |
| *(unmatched)* | `internal` | 500 |

Defaulting to 500 is deliberate: an unrecognised throw is a bug in the
mapping, and a loud 500 in Sentry surfaces it. Do not add a catch-all 400.

**Known wart / follow-up (do not fix in this feature):** message matching
is brittle — renaming a lib error message silently changes an HTTP status.
The right fix is typed error classes in `src/lib/`, but that touches
feature-4 code and the plan explicitly forbids new business logic here.
Track it as a follow-up; the mapping table above is the single place it
would change.

## 5. Validation boundary

- One `zod` schema per endpoint, defined in the route file, applied at the
  edge. The handler receives parsed, typed input; `src/lib/` stays trusting
  of its callers and is not re-validated.
- Body: `schema.safeParse(await request.json())`. Query/path params parse
  the same way.
- A `safeParse` failure maps to `bad_request`/400 with a generic message —
  **do not** serialise zod's `issues` array into the response; it exposes
  internal field naming. Log the detail, return the summary.

## 6. Shared helpers

- `src/lib/api/respond.ts` — `jsonOk(value, status?)` and
  `jsonError(code, message, status)`. Every route serialises through these;
  no hand-built `new Response(JSON.stringify(...))` anywhere.
- `src/lib/auth.ts` — `authenticatedUser(request?)` (T2) and
  `resolveApiUser(request)` (T5). API routes call `resolveApiUser`, always
  passing the handler's `request`.
- Both modules carry the `// Server-only module` header.

## 7. Testing

HTTP-level integration tests reuse `src/test/db.ts`, the factories, and
`src/test/scenarios.ts` — no new DB infrastructure. The harness pattern is
established in T6 and copied by T7–T9. Tests assert status code, envelope
conformance, auth rejection, and DB effect — not the lib business logic,
which is already covered.

---

## 8. API key integration (T3)

Verified against the installed `@clerk/backend@3.2.14`. Types:
`dist/api/endpoints/APIKeysApi.d.ts`, `dist/api/resources/APIKey.d.ts`,
`dist/tokens/authObjects.d.ts`, `dist/tokens/machine.d.ts`.

**Enablement: confirmed.** A read-only probe against our instance on
2026-09-09 (`clerk.apiKeys.list({ subject })` for a real user) returned
200 with `totalCount: 0`. The feature is live on our plan; T4 is unblocked.

### Client surface

The client exposes `clerk.apiKeys` (`APIKeysAPI`):

| Call | Returns |
| --- | --- |
| `apiKeys.create({ name, subject, description?, claims?, scopes?, createdBy?, secondsUntilExpiration? })` | `APIKey` — **the only response carrying `.secret`** |
| `apiKeys.list({ subject, includeInvalid?, limit?, offset? })` | `{ data: APIKey[], totalCount }` |
| `apiKeys.get(apiKeyId)` | `APIKey` |
| `apiKeys.revoke({ apiKeyId, revocationReason? })` | `APIKey` (`revoked: true`) |
| `apiKeys.delete(apiKeyId)` | `DeletedObject` |
| `apiKeys.update({ apiKeyId, subject, ... })` | `APIKey` |
| `apiKeys.verify(secret)` | `APIKey` |
| `apiKeys.getSecret(apiKeyId)` | `{ secret }` |

`subject` is the owner id — a Clerk **user** id (`user_…`, 32 chars) for
the user-scoped keys this feature issues, or an org id. `APIKey` fields:
`id`, `type` (`'api_key'`), `name`, `subject`, `scopes`, `claims`,
`revoked`, `revocationReason`, `expired`, `expiration`, `createdBy`,
`description`, `lastUsedAt`, `createdAt`, `updatedAt`, `secret?`.

**Revoke, don't delete.** `revoke` preserves the row with `revoked: true`
and `revocationReason`, so a revoked key stays auditable and listable via
`includeInvalid: true`. `delete` destroys the record. T4 uses `revoke`.

**`getSecret` exists.** Contrary to the SDK's own docstring on `.secret`
("cannot be retrieved later"), the raw secret *is* retrievable from the
backend API. Our policy is unchanged and deliberate: we never call
`getSecret`, never persist the raw value, never log it, and keep the
show-once-at-creation contract in the UI.

### Key vs session disambiguation — do not hand-roll it

The prefix rule exists (`API_KEY_PREFIX = 'ak_'`; session tokens are JWTs,
matched by `isJwtFormat`) — but **the SDK already branches for us**:

```ts
const auth = await clerk.authenticateRequest(request, {
	acceptsToken: ['session_token', 'api_key'],
});
if (!auth.isAuthenticated) throw new Error('Unauthorized');
const { tokenType, userId } = auth.toAuth();
```

This supersedes the manual prefix-branching described in T5 of the task
list. One call resolves either credential; `tokenType` is
`'session_token' | 'api_key'` and `userId` is the Clerk user id in both
cases. T5 becomes a thin wrapper, not a dispatcher.

Two consequences for T2/T5:

- **`isSignedIn` is deprecated** in this SDK version in favour of
  `isAuthenticated`, which is the only discriminator present on *both*
  session and machine auth objects. The extracted helper uses
  `isAuthenticated`; the current inline copies use `isSignedIn`.
- **Org-scoped keys must be rejected.** For an `api_key` token the auth
  object is either `{ userId: string, orgId: null }` or
  `{ userId: null, orgId: string }`. This feature is user-scoped only (see
  the plan's non-goals), so a null `userId` is an `unauthorized`/401, not
  a crash on a null lookup.

Machine-to-machine tokens (`mt_`) and OAuth tokens (`oat_`) are also
supported by `acceptsToken` — deliberately **not** included. Service
identities are an explicit non-goal; leaving them out of the accept list
means an M2M token is rejected rather than silently resolving to nobody.

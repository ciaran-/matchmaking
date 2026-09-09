# Matchmaking REST API

Base URL: `/api/v1`

Machine-readable spec: **[`/api/v1/openapi.json`](/api/v1/openapi.json)**
(OpenAPI 3.1). The spec is generated from the same zod schemas the handlers
validate with, and a test asserts it documents every route that exists — so
it should not drift. Prefer it over this page when the two disagree.

## Authenticating

Every endpoint except the spec itself requires a credential. Two are
accepted, and both resolve to the same user, so nothing downstream behaves
differently depending on which you used:

- **Personal API key** — for scripts, CI, and anything without a browser.
  Create one at `/settings/api-keys`. Send it as a bearer token:

  ```bash
  curl -H "Authorization: Bearer ak_..." https://<host>/api/v1/leaderboard
  ```

- **Clerk session token** — what the web app already sends. Nothing to do;
  it works from a signed-in browser session.

The raw key is shown **once**, at creation. We do not store it and cannot
show it again — if you lose it, revoke it and make another.

> **Revoking takes up to a minute to take effect.** Clerk caches a
> successful key verification for roughly 60 seconds, so a key that was in
> use immediately before you revoked it keeps working until that expires.
> Treat a leaked key as live for a minute after revocation.

## Response shapes

Reads return the resource directly — a bare object or array, not wrapped in
`{ data }`. Errors always use one envelope:

```json
{ "error": { "code": "not_found", "message": "That match does not exist." } }
```

Branch on `code`, not on `message`. `message` is user-facing copy and may be
reworded; `code` is a stable, closed set:

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed body, or one that fails validation |
| `unauthorized` | 401 | Missing, invalid, or revoked credential |
| `forbidden` | 403 | Valid credential, but not your resource |
| `not_found` | 404 | No such resource |
| `conflict` | 409 | The resource is not in a state that allows this |
| `rate_limited` | 429 | Too many requests — see `Retry-After` |
| `internal` | 500 | Our bug. These are reported to Sentry |

## Who can do what

You may read and act on games you are playing in. A user with the `ADMIN`
role may act on anyone's.

Note that a non-participant gets **403 even when the resource does not
exist** — so `POST /api/v1/games` cannot be used to discover whether a
player id is real.

## Rate limits

120 requests per minute, per credential. Exceeding it returns `429` with a
`Retry-After` header giving whole seconds until the window resets.

> **Do not treat this as a hard ceiling.** The limiter is currently
> in-process, and the app runs on serverless functions, so each instance
> counts separately and the real limit is higher and variable. It is a
> courtesy limit to protect a single instance, not an enforced quota. Edge
> or shared-store enforcement is a tracked follow-up — build clients to
> respect `Retry-After` regardless.

## Endpoints

Full parameter and response detail is in the spec. In brief:

| Method | Path | |
| --- | --- | --- |
| GET | `/leaderboard` | League table, highest rating first |
| GET | `/league/activity` | Anonymised activity for the dashboard |
| GET | `/me/search` | Your active search — `null` if none, not a 404 |
| GET | `/matches/{matchId}` | One match's derived state |
| POST | `/games` | Record a completed game |
| GET | `/search` | Poll your search state |
| POST | `/search` | Enter the queue |
| POST | `/search/cancel` | Leave the queue |
| POST | `/matches/{matchId}/confirm` | Confirm a proposed match |
| POST | `/matches/{matchId}/decline` | Decline a proposed match |
| POST | `/matches/{matchId}/result` | Record a confirmed match's result |

Two things worth knowing before you write a client:

**Matchmaking is poll-based.** `GET /search` reflects the current state;
there is no push. This mirrors what the web app does. Realtime delivery is
a tracked follow-up, not a hidden feature.

**`result` is from your perspective.** On `/matches/{matchId}/result`,
`"A"` means *you* won — not that `playerA` won.

## Absent by design

- **No machine-to-machine credentials.** Every credential belongs to a
  person. A service identity is planned separately
  (`.claude/plans/feature-11-service-identity.md`); until then there is no
  way for a non-human caller to authenticate as itself.
- **No pagination.** Read endpoints return everything. Fine at current
  scale; it will need addressing before it isn't.

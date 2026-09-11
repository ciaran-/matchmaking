# 0004. Personal API keys are Clerk API keys

- **Status:** Accepted
- **Date:** 2026-09-09
- **Source:** `.claude/plans/complete/feature-6-rest-api.md`; detail in
  `docs/api-conventions.md` §8

## Context

A client without a browser — a script, CI, a mobile app — cannot obtain a
Clerk session token, so it cannot use the API at all without a long-lived
credential that acts as a user.

## Decision

- **Use Clerk's native user-scoped API keys.** We keep no key table and do
  no hashing of our own.
- Keys are sent as `Authorization: Bearer ak_…`. A key and a browser
  session resolve to the same `User`; endpoints cannot tell them apart and
  should not try.
- **Revoke, never delete**, so a revoked key stays auditable.
- **Never retrieve, store or log a raw secret.** It is shown once, at
  creation. Clerk's `getSecret` exists and we deliberately never call it.
- **Accept the ~60 second revocation window.** Measured against our
  instance: Clerk caches a successful verification server-side, so a key
  that was in use keeps authenticating for up to a minute after revocation.
  The key management page says so.
- Org-scoped keys are refused with `401`; the API is user-scoped only.

Rejected: re-checking the key's status after every successful
authentication. That closes the window but adds a Clerk round trip to
every API request, which is the wrong trade at our target scale.

## Consequences

- No secret storage for us to get wrong.
- A leaked key is live for up to a minute after revocation.
- Every API-key request is a network verification call to Clerk, not a
  local JWT check. That costs latency and depends on Clerk being
  available; it is memoized per request only.
- If a stricter revocation guarantee is ever needed, scope the extra check
  to sensitive write endpoints rather than applying it globally.

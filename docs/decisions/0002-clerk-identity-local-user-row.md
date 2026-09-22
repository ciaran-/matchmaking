# 0002. Clerk owns identity; a local `User` row is created on first sign-in

- **Status:** Accepted
- **Date:** 2026-04-10
- **Source:** `.claude/plans/complete/feature-1-clerk-db-user-sync.md`

## Context

Clerk handles sign-in, sessions and OAuth. The app needs its own `User`
row to hang ratings and games on, and every user-facing feature depends on
getting from a Clerk session to that row.

## Decision

- **Clerk is the identity provider.** We store no passwords and issue no
  sessions of our own.
- Each Clerk user maps to one `User` row through a unique, nullable
  `clerkId` (nullable so seed and legacy rows can exist without Clerk).
- **The row is created lazily on sign-in.** The root route's `beforeLoad`
  calls `syncUserFn`, which verifies the Clerk session and upserts the row.
  A short-lived (1 hour) `db_synced` cookie holding the Clerk user id skips
  the upsert on later page loads.
- **Username is derived once and never overwritten** — Clerk username,
  else first + last name, else email prefix, with a random suffix on
  collision. Email is not updated after creation either.
- Server-side verification uses `@clerk/backend` directly rather than a
  framework integration package.

Rejected at the time:

- **Clerk webhooks** — a signed-in user can exist before the webhook lands,
  so every caller still needs a missing-row fallback; they also need tunnel
  tooling locally and another secret.
- **Creating the row on demand in each server function** — every future
  function must remember to call the helper, with no central guarantee.

## Consequences

- No webhook infrastructure, and the row exists before any feature needs it.
- Profile changes made in Clerk (email, username) do not reach our database.
- `syncUserFn` is the one server function exempt from default-deny
  authentication (0003); it verifies the Clerk session itself.
- Clerk sits in the critical path for sign-in and for every authenticated
  request, and local development currently needs a live Clerk instance.
- The client SDK is `@clerk/react` (Clerk Core 3), which replaced the
  deprecated `@clerk/clerk-react` in feature 15, September 2026
  (`.claude/plans/complete/feature-15-clerk-react-core-3-upgrade.md`). That
  upgrade also removed `SignedIn` / `SignedOut` in favour of `Show`, and
  brought `@clerk/backend` to a version sharing one `@clerk/shared` with
  the client SDK. Moving to `@clerk/tanstack-react-start` was considered and
  not taken (`.claude/plans/archived/migrate-to-clerk-tanstack-package.md`).

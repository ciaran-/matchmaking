# 0006. You may act on games you play in; all checks go through one module

- **Status:** Accepted
- **Date:** 2026-09-09
- **Source:** `.claude/plans/complete/feature-6-rest-api.md`; detail in
  `docs/api-conventions.md` §6b

## Context

The web app's record-game dialog let any signed-in user record a result
between any two players. Exposing the same capability over the REST API
would have published that hole. Since both paths share `recordGame` (0001),
enforcing only at the API edge would have been cosmetic.

## Decision

- **The rule:** you may read or act on a game or match you are playing in.
  A user with `role: ADMIN` may act on anyone's.
- **Every authorization decision goes through `src/lib/authorization.ts`**
  (`canActOnGame`, `canActOnMatch`), never an inline check in a handler.
  Both the web server functions and the REST API call it.
- **403 before 404.** On writes such as `POST /api/v1/games`, a
  non-participant gets `403` even when a player id does not exist. This
  stops the endpoint from revealing which ids are real.
- **`User.role` is a global grant.** Authority bounded by a scope, such as
  a tournament organiser's, gets a grant table keyed by (user, scope) that
  `canActOnGame` consults. Do not widen the role enum for it.

## Consequences

- One place to read, test and extend authorization; call sites should not
  change when roles grow.
- No user can record a game they did not play in. System-level recording
  needs a service actor (0005).
- The authorization functions take a `User`, not an actor. A service caller
  will need them extended.
- `GameSides` names exactly two players. Team and multi-sided games will
  need a participant list; `canActOnGame` is the one place to change
  (0013).

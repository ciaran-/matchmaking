# 0001. Business logic lives in `src/lib/`; entry points are thin adapters

- **Status:** Accepted
- **Date:** 2026-09-09
- **Source:** `.claude/plans/complete/feature-6-rest-api.md`,
  `.claude/plans/complete/integration-testing-infrastructure.md`

## Context

The app has two ways in: `createServerFn` handlers called by the web app,
and `/api/v1` routes called by scripts and other clients. If each carried
its own business logic, the two would drift — and a rule enforced on one
path (see 0006) would be missing from the other.

## Decision

- All business logic lives in `src/lib/`, written framework-agnostic and
  tested there: unit tests, plus integration tests against a real
  PostgreSQL container.
- Server functions and REST route handlers are **thin adapters**:
  authenticate, validate input, call `src/lib/`, shape the output.
- Usage-specific translation — the HTTP envelope, the web app's poll
  bundle — stays in the adapter, never in the core.
- The adapter layer adds no new business logic. If an endpoint needs
  behaviour `src/lib/` lacks, that is added to `src/lib/` first as its own
  change.

## Consequences

- One place to test behaviour, and both entry points behave identically.
- Route-level wiring is verified manually or by HTTP-level tests; business
  rules are not re-tested there.
- Server functions and REST routes still each have their own adapter code,
  so some duplication remains. Moving server functions onto the same
  adapter layer is an open follow-up.
- `src/lib/` throws plain `Error`s, so adapters map errors by message text
  (see 0011).

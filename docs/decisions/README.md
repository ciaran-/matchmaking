# Architecture decisions

Decisions that shape the project beyond the feature that made them. Plans
in `.claude/plans/` record what we intended at the time and are frequently
overtaken by later work; these records say what is true **now**, and why.

For the working rules of the REST API, see `docs/api-conventions.md`. For
coding conventions and tooling, see `CLAUDE.md`.

## When to write one

When a plan's decision will constrain future work — a data model, a
security boundary, a contract with clients, a principle we expect to apply
again — record it here as part of completing that work. Local
implementation choices stay in code comments.

## Format

One file per decision: `NNNN-kebab-case-title.md`, numbered in order of
writing. Each has:

- **Status** — `Accepted`, `Accepted (partly open)`, or
  `Superseded by NNNN`.
- **Date** — when the decision was made.
- **Source** — the plan(s) it came from.
- **Context**, **Decision**, **Consequences** — what forced it, what we
  chose, and what that costs or commits us to.

## Changing a decision

Do not edit an accepted record to reverse it. Write a new record that
supersedes it, and change only the old record's status line to point at
the new one. Corrections of fact (a renamed file, a wrong constant) are
fine to edit in place.

Code comments and docs should cite a decision record rather than a plan.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-shared-lib-core.md) | Business logic lives in `src/lib/`; server functions and REST routes are thin adapters | Accepted |
| [0002](0002-clerk-identity-local-user-row.md) | Clerk owns identity; a local `User` row is created on first sign-in | Accepted |
| [0003](0003-default-deny-authentication.md) | Every server function and API route requires authentication unless allowlisted | Accepted |
| [0004](0004-personal-api-keys-via-clerk.md) | Personal API keys are Clerk API keys; ~60s revocation window accepted | Accepted |
| [0005](0005-service-identity-deferred.md) | Services are a distinct actor; the credential mechanism waits for a real caller | Accepted (partly open) |
| [0006](0006-participant-scoped-authorization.md) | You may act on games you play in; admins on any; all checks in one module | Accepted |
| [0007](0007-anonymise-cross-user-views.md) | Views of other users' live activity are aggregated and anonymised | Accepted |
| [0008](0008-elo-ratings-snapshotted-at-record-time.md) | Elo applied at record time and snapshotted per game | Accepted |
| [0009](0009-game-outcome-from-score.md) | Win/loss/draw is read from the score, never from rating change | Accepted |
| [0010](0010-event-sourced-matchmaking.md) | Matchmaking state is event-sourced; clients poll | Accepted |
| [0011](0011-rest-api-contract.md) | REST API is a versioned contract with one envelope and edge validation | Accepted |
| [0012](0012-measure-before-caching.md) | Measure before caching or adding infrastructure | Accepted |
| [0013](0013-multi-sided-games-not-blocked.md) | Games are 1v1 today; nothing may block teams or more than two sides | Accepted |
| [0014](0014-username-as-public-identifier.md) | Players are addressed by an immutable username | Accepted |

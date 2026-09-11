# 0014. Players are addressed by an immutable username

- **Status:** Accepted
- **Date:** 2026-09-10
- **Source:** `.claude/plans/complete/feature-7-player-profile.md`

## Context

Player profiles needed a URL, and the REST API needed a path parameter for
players. The options were a readable username, which breaks links if it
changes, or the internal id, which is stable but opaque.

## Decision

- **Players are addressed by username** in page URLs (`/player/$username`)
  and in the API (`/api/v1/players/{username}`, including `/matches` and
  `/ratings`).
- **Usernames do not change.** A username is set once at first sign-in and
  never overwritten (0002), and there is no rename feature.

## Consequences

- Profile links are readable and shareable.
- Adding renames would break existing links and API clients. It would need
  redirects or aliases from old usernames, or a stable id exposed
  alongside.
- Usernames are visible to every signed-in user through the ranking
  surfaces. That is consistent with the public-ranking posture, which is
  distinct from the anonymised live views (0007).

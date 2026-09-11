# 0007. Views of other users' live activity are aggregated and anonymised

- **Status:** Accepted
- **Date:** 2026-05-20
- **Source:** `.claude/plans/complete/feature-5-league-activity-dashboard.md`

## Context

The league activity dashboard shows every signed-in user who is searching,
confirming and playing right now. Framed at the time: *this is an
engagement tool, not a surveillance tool.*

## Decision

- Any view in which a user sees **live or aggregate state about other
  users** serves aggregates only.
  - Forbidden in the payload: `userId`, `clerkId`, `attemptId`, `matchId`,
    `gameResultId`, `username`, `email`, raw ratings, and timestamps of
    individual events.
- **Quasi-identifying values are binned on the server.** Ratings go into
  25-point buckets. Precise ratings identify people in small cohorts, and
  a new league is exactly when cohorts are smallest.
- The dashboard's anonymity is enforced by a test that checks the payload
  against that denylist.
- **Identities are visible only where that is the point:**
  - matched opponents, who are in a direct interaction;
  - the ranking surfaces that deliberately name players — leaderboard,
    profiles and match history. That posture was chosen separately
    (feature 7) and is not an exception to this rule.

## Consequences

- Anonymised views can be shown to every signed-in user without roles.
- New cross-user features default to aggregation. If one genuinely needs
  identities, that is an explicit design question, not an assumption.
- Binning cannot be skipped on the grounds that the league is still small.

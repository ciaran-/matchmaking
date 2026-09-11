# 0009. Win, loss and draw are read from the score, never from rating change

- **Status:** Accepted
- **Date:** 2026-09-10
- **Source:** `.claude/plans/complete/feature-7-player-profile.md`,
  `.claude/plans/complete/feature-10-leaderboard-hardening.md`
- **Supersedes:** the rating-change-sign rule used by the original `/league`
  table and the first cut of the leaderboard

## Context

`/league` and `GET /api/v1/leaderboard` decided the outcome from the sign
of `ratingChange`: positive was a win, negative a loss, zero a draw. That
is wrong. Elo moves both players on a draw unless their ratings are exactly
equal (a 1200 vs 1000 draw is −8 / +8). The underdog's draw counted as a
win and the favourite's as a loss. Rating change is a consequence of the
result, not the result.

## Decision

- **The outcome comes from the score.** `recordGame` writes team scores of
  `A: [1, 0]`, `B: [0, 1]` and `draw: [0, 0]`. A participant's outcome is
  their team's score against the other team's, and equal scores are a
  draw.
- **One definition.** `src/lib/game-outcome.ts` (`outcomeFor`,
  `countOutcomes`) is the only place outcomes are classified. The profile,
  match history and leaderboard all use it, so they cannot disagree.
- Counts are aggregated in SQL, one row per user, never by loading every
  participation into the application.

## Consequences

- The rule stays correct if the K-factor or rating algorithm changes.
- Every future recording path must write scores that encode the result,
  including equal scores for a draw.
- Win/loss/draw from two team scores assumes exactly two sides. It covers
  N v N teams unchanged, but free-for-all and multi-team games produce
  placements, not a win or a loss (0013).

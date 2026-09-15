# Feature 14 — Hardening Sweep (R2): Task List

Roadmap item R2 (`.claude/plans/roadmap.md`) — three unrelated gaps.

T1 has its own plan: `.claude/plans/feature-14-atomic-game-conversion.md`.
Read it in full before starting T1. T2 and T3 need no plan.

---

## Dependency graph

```
T1 (atomic conversion) — independent
T2 (matchmaker-tick reachability) — best after R1's preview database exists
T3 (worktree and branch cleanup) — independent, do any time
```

No ordering between them. T1 is the only one touching application code.

---

## Pre-flight (do once)

1. Read `CLAUDE.md` — **Testing**, **Code Style**, **Pre-commit
   Checklist**.
2. Confirm `npm run build`, `npm test` and `npm run test:integration` pass
   on `main`.
3. Branch: `feature-14-hardening-sweep-agent-<short-id>`.
4. This work contains no migration, so it is safe to merge before R1a.

---

## T1 — Make the pending-game conversion atomic

**Status:** done
**Depends on:** nothing
**Blocks:** roadmap R8a (disputes add a second write to this path)

Plan: `.claude/plans/feature-14-atomic-game-conversion.md`. Its two open
decision — how to record the
change against 0010 — should be settled before starting. The
concurrent-rating race **is** in scope: lock both user rows with
`SELECT … FOR UPDATE` while the conversion runs.

### Read first

- `src/lib/matchmaking/pending-game.ts`, the header comment on
  `convertPendingGameToResult` and the function itself.
- `src/lib/record-game.ts` in full.
- `src/lib/matchmaking/state.ts` for the `DbClient` type and the
  `client: DbClient = prisma` convention.
- `src/test/db.ts` on sharing the test connection.

### Change

- `recordGame(input, client?)` — opens its own interactive transaction when
  no client is given, runs on the caller's when one is.
- `convertPendingGameToResult` — one transaction covering the state
  re-read, first-wins check, `recordGame`, and the `PLAYED` and `CONSUMED`
  event appends.
- Delete the `KNOWN ORPHAN-RISK WINDOW` comment.
- In the same commit as the fix, amend the orphan-window bullet in
  `docs/decisions/0010-event-sourced-matchmaking.md` to say it is closed.
  Not before the fix lands, and not as a new decision record.

### Verify

- Existing unit and integration tests pass **unchanged**. The signature is
  backward compatible; if a call site needs editing, the approach has
  drifted.
- New integration test: force the event append to fail and assert no
  `GameResult` exists and neither rating moved.
- `npm run check`, `npm run build`, `npm test`, `npm run test:integration`.

---

## T2 — Determine whether `matchmaker-tick` is reachable over HTTP

**Status:** done — not reachable; no code change needed
**Depends on:** nothing; safer once R1a has given preview its own database

**Finding (14 Sep):** Netlify documents that scheduled functions cannot be
invoked directly with a URL. Manual invocation is the authenticated
`Run now` button in the Netlify UI, or `netlify functions:invoke` locally.
So no unauthenticated caller can trigger a matcher pass, and the stop
condition below does not apply. Recorded in 0005.

`netlify/functions/matchmaker-tick.ts` runs `runMatcherPass()` on a
one-minute schedule and has no authentication. Its only protection is that
Netlify treats it as a scheduled function — a property of platform routing,
not of our code. 0005 lists this as an open question.

### Actions

- Establish Netlify's documented behaviour for invoking a scheduled
  function over HTTP first.
- If that is ambiguous, test against a **deploy preview**, never
  production: an extra matcher pass there is harmless, and after R1a it
  cannot touch production data at all.
- Record the finding in 0005 — this closes one of its open questions either
  way.

### If it is reachable

Stop and raise it rather than fixing it inline: the fix is a shared-secret
header or signature check, which is the same credential question 0005
deliberately deferred to roadmap R6a. Note it and decide together.

---

## T3 — Remove merged worktrees and branches

**Status:** done
**Depends on:** nothing

**Done 14 Sep:** all five worktrees removed (none held uncommitted work)
and sixteen merged branches deleted. `lint-housekeeping-agent-afc919b9` was
kept: `git branch -d` refused it as unmerged, which is the intended
outcome — whether it is still wanted is a call for Ciaran, not a cleanup
decision.

Five worktrees under `.claude/worktrees/` sit on branches already merged to
`main`: `feature-6-rest-api-cp2-agent-b7`, `cp3-agent-t8`, `cp4-agent-t9`,
`feature-8-match-history-agent-8b`, `feature-9-rating-chart-agent-k7`.

### Actions

- `git worktree remove <path>` for each, then delete the merged local
  branches, including the stragglers named after bare agent IDs such as
  `worktree-agent-ab7963e93153fc9ae`.
- Leave unmerged branches alone.
- Confirm `git worktree list` shows only the main checkout, and
  `npm run check` still passes — Biome excludes that directory, and its
  absence should change nothing.

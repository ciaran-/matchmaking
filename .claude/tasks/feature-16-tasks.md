# Feature 16 — Dependabot Backlog (critical + high): Task List

Plan: `.claude/plans/feature-16-dependabot-backlog.md` — read in full before
starting. The plan is authoritative; this is the tactical breakdown.

Decisions taken 22 Sep 2026: `vite` 7 → 8 deferred, no `npm overrides` this
pass, and done means a measured improvement rather than zero alerts.

---

## Dependency graph

```
T1 (baseline) ──> T2 (Netlify plugin bump) ──> T3 (re-measure) ──┬──> T4 (runtime criticals)
                                                                 ├──> T5 (runtime highs)
                                                                 └──> T6 (dev-scope, incl. vitest)
                                                                          │
                                                                          └──> T8 (final measure + record)
```

### Strict ordering

T1 → T2 → T3 before any batch. T3 exists because the Netlify bump is
expected to move a large share of the count, and batching before
re-measuring would mean merging pull requests for alerts already gone.

---

## Pre-flight (do once)

1. Read the plan, including its Risks section.
2. Read `CLAUDE.md` — **Pre-commit Checklist**, **Testing**, and the
   client-bundle verification under **`createServerFn` Pattern**.
3. Confirm `npm run check`, `npm test`, `npm run test:integration` and
   `npm run build` pass on `main`.
4. Branch: `feature-16-dependabot-<slug>-agent-<short-id>`.
5. This work contains **no migration**, so the standing production call-out
   does not apply.

---

## T1 — Baseline measurement

**Status:** done 22 Sep — figures recorded below and in the plan
**Blocks:** everything

Record, in one place, so the end can be compared honestly to the start:

- GitHub alert counts by severity (`gh api repos/{owner}/{repo}/dependabot/alerts?state=open`).
- Critical and high grouped by package, with direct-or-transitive noted.
- The list of open Dependabot pull requests.

Baseline as of 22 Sep 2026: **83 open — 4 critical, 47 high, 27 moderate,
5 low**; 51 critical/high across 22 packages; 19 open pull requests.

---

## T2 — Bump `@netlify/vite-plugin-tanstack-start`

**Status:** done 22 Sep — see outcome below; deploy preview pending on the PR
**Depends on:** T1

1.3.3 → 1.3.19. Highest-value single move: its subtree carries `tar`
(critical), `toml`, `@opentelemetry/propagator-jaeger`, and both unpatched
packages.

**Stop condition:** if this pulls `vite` 8, stop and raise it. Decision 1
defers that major deliberately, and it must not arrive as a side effect.

### Verify

- `npm ci`, `npm run check`, `npm test`, `npm run test:integration`,
  `npm run build`.
- Client-bundle grep for server-only signals — this package is in the build
  path.
- **Deploy preview**, not just a green build. This touches the build
  toolchain, which is exactly where a passing build can still ship a broken
  deploy.

### Outcome (22 Sep 2026)

`vite` stayed on 7.3.3, so the stop condition did not trigger.

Local `npm audit`: **68 → 52** (critical 4 → 3, high 31 → 22, moderate
28 → 24, low 5 → 3).

- `tar` 7.5.13 → **7.5.22**, clearing the critical.
- `toml` → **4.3.0**.
- `extract-zip` and `image-size` are **gone from the dependency tree**. Both
  had no patch at any version, and the plan expected to accept and document
  them. The parent bump removed them instead, so there is nothing left to
  accept.

---

## T3 — Re-measure

**Status:** not started
**Depends on:** T2

Re-run T1's measurement. Decide which of the remaining pull requests are
still worth merging: some will be for alerts T2 already cleared.

---

## T4 — Runtime criticals

**Status:** not started
**Depends on:** T3

`seroval` (#67) and `tar` (#66), if T3 shows them still open. Small batch,
`npm ci` after, full verification.

---

## T5 — Runtime highs

**Status:** not started
**Depends on:** T3

`fast-uri` (#86), `undici` (#70), `brace-expansion` (#69), `picomatch`
(#41), `ws` (#53), `tmp` (#52), `postcss` (#68), `browserslist` (#81),
`toml` (#83), `@opentelemetry/propagator-jaeger` (#62) — whichever T3 shows
still standing.

Two or three pull requests at a time, verifying between batches. One giant
merge makes a failure impossible to attribute.

---

## T6 — Development-scope, including `vitest`

**Status:** not started
**Depends on:** T3

`shell-quote` (#65, critical) and the `vitest` cluster (#84, critical).
`vitest` is a direct devDependency, so this batch is the one most likely to
need a code or config change — if it does, that is a finding to raise, not
to absorb.

---

## T7 — Dropped (22 Sep 2026)

Closing the out-of-scope Dependabot pull requests by hand is unnecessary:
Dependabot closes its own pull requests once a merge supersedes them. A few
unrelated ones (`yaml`, `launch-editor`) may linger, which is harmless —
they carry no critical or high alert, so they are outside this pass either
way.

---

## T8 — Final measurement and write-up

**Status:** not started
**Depends on:** T4, T5, T6

- Re-measure and compare against T1's baseline.
- Record what remains and why. Note that `extract-zip` and `image-size` —
  the two with no patch at any version — left the tree with T2's parent
  bump, so they need no accept-and-document decision after all.
- Note any critical still standing as a **pre-launch risk signal**, per the
  decision taken.
- Consider whether a standing approach — grouping rules, a schedule, or
  auto-merge for patch-level devDependency bumps — would stop the backlog
  rebuilding. Feature 15's T1 predicted this need; this is the evidence.
- `git mv` the plan and this task list into `complete/`, updating
  references.

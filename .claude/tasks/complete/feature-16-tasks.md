# Feature 16 — Dependabot Backlog (critical + high): Task List

Plan: `.claude/plans/complete/feature-16-dependabot-backlog.md` — read in full before
starting. The plan is authoritative; this is the tactical breakdown.

Decisions taken 22 Sep 2026: `vite` 7 → 8 deferred, no `npm overrides` this
pass, and done means a measured improvement rather than zero alerts.

**Complete 13 Oct 2026.** T1 and T2 ran as planned. T3–T6 did not: Ciaran
took the remaining work on directly, merging the Dependabot pull requests
himself alongside `npm audit fix`, npm 11.19.1, Node 24 and the CI action
definitions. The outcome beats what the batch plan aimed at, so the task
structure below is left as written and the measurement is recorded in T8.

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

## T3–T6 — Overtaken by direct merges

**Status:** not run as written — superseded 22 Sep–13 Oct 2026

T3's re-measure, T4's runtime criticals, T5's runtime highs and T6's
dev-scope batch were all overtaken. Ciaran merged the Dependabot pull
requests directly (#81, #93, #94, #95 among them), ran `npm audit fix`,
bumped npm to 11.19.1, moved CI to a current Node 24, and refreshed the CI
action definitions. The vitest cluster T6 flagged as most likely to need a
code change landed in #95 without one.

So the ordering T3 enforced — re-measure before batching, to avoid merging
pull requests for alerts already cleared — was not needed in the end:
Dependabot closed the superseded ones itself, as T7 predicted.

---

## T7 — Dropped (22 Sep 2026)

Closing the out-of-scope Dependabot pull requests by hand is unnecessary:
Dependabot closes its own pull requests once a merge supersedes them. A few
unrelated ones (`yaml`, `launch-editor`) may linger, which is harmless —
they carry no critical or high alert, so they are outside this pass either
way.

---

## T8 — Final measurement and write-up

**Status:** done 13 Oct 2026

### Against the baseline

| | 22 Sep (T1) | 13 Oct |
| --- | --- | --- |
| GitHub open alerts | 83 | **3** |
|  critical | 4 | **0** |
|  high | 47 | **3** |
|  moderate | 27 | 0 |
|  low | 5 | 0 |
| Open Dependabot pull requests | 19 | **0** |
| Local `npm audit` | 68 | 21 |

Every critical is cleared and the pull request queue is empty. The pass met
its "measured improvement, not zero" bar comfortably.

### What GitHub still reports

- **#124 and #169 — `sharp`** (high, runtime). Route in:
  `@netlify/vite-plugin-tanstack-start` → `@netlify/vite-plugin` →
  `@netlify/dev` → `@netlify/images` → `ipx` → `sharp@0.34.5`. Patched in
  0.35.0 and 0.35.4, but **no parent pins a fixed version yet**, so this is
  the residue the no-`overrides` decision deliberately leaves standing. Same
  Netlify local-dev emulation subtree the plan already noted: not in the
  deployed runtime, despite the "runtime" label.
- **#151 — `deepmerge-ts`** (high, runtime). Route in: `prisma` →
  `@prisma/config` → `deepmerge-ts@7.1.5`, patched in 8.0.0. npm reports a
  fix available via the parent, so a `prisma` 6.x bump should clear it. Note
  the `prisma@6` pin is deliberate (CLAUDE.md: v8 has no `mcp` command), but
  this is a patch within 6.x, not a major.

### The two counts disagree, and that is worth knowing

Local `npm audit` on `main`'s lockfile still reports 21 — 3 critical, 17
high, 1 moderate — where GitHub reports 3 high. Most of the gap is counting
method: npm flags every package in a vulnerable chain, so the six-package
`@netlify/*` chain above appears six times for one root cause. But npm's
three criticals have no open GitHub alert at all:

- `shell-quote`, via `@tanstack/devtools-vite` → `launch-editor`
- `seroval` and `solid-js`, via `@tanstack/react-devtools`

All three are development tooling and all three report a fix available. One
check of why GitHub no longer lists them — dismissed, auto-closed on a
superseding merge, or simply not yet rescanned — is worth more than trusting
either number. Until then, treat `npm audit` as the pessimistic read.

### Finding: devtools sit in `dependencies`

`@tanstack/react-devtools`, `@tanstack/react-router-devtools`,
`@tanstack/react-query-devtools` and `@storybook/react-vite` are all in
`dependencies` rather than `devDependencies`. That is why their alerts
arrive labelled **runtime** scope, and it is why `seroval` read as a runtime
critical at baseline. Moving them is a small change that makes the alert
list mean what it says. Not done here — raised as a follow-up, since it is a
`package.json` change rather than a dependency bump.

### Residue

- **24 remote `dependabot/*` branches**, almost all superseded by the merges
  above. Harmless, but they make `git branch -r` unreadable. Worth a prune.
- The standing-approach question below is still open.

### Still worth deciding

Whether a standing approach — grouping rules, an update schedule, or
auto-merge for patch-level devDependency bumps — would stop the backlog
rebuilding. Feature 15's T1 predicted the need; this pass is the evidence
that it recurs. Not decided here.

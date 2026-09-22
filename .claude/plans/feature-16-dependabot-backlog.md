# Clearing the Dependabot Backlog — Feature Plan

Clear the **critical and high** vulnerability alerts on `main`, and leave a
repeatable way to keep them clear. Moderate and low are explicitly out of
scope for this pass.

Feature 16. Not on the autumn 2026 roadmap — agreed 22 Sep 2026 as the work
following feature 15, on direction that the backlog had grown far enough to
deserve its own pass.

## Measured state (22 Sep 2026)

GitHub reports **83 open alerts**: 4 critical, 47 high, 27 moderate, 5 low.
The critical and high ones are **51 alerts across 22 packages**. There are
**19 open Dependabot pull requests**.

npm's own `npm audit` counts 68 vulnerabilities — it and GitHub count
differently, so treat both as indicators, not as a score to drive to zero.

### The finding that shapes this work

**20 of the 22 flagged packages are transitive.** Only `vite` and `vitest`
are direct dependencies, and both are devDependencies. So the fix for most
of this is *not* bumping the flagged package — it is bumping the parent that
pins it, or overriding the resolution deliberately.

A dry run of `npm audit fix` confirms it: the non-breaking pass does not
clear the critical and high set, and the remainder is offered only behind
`npm audit fix --force`, which applies breaking major bumps unattended. That
is not a mechanism to point at this repo without reading what it changes.

### Where the criticals come from

| Package | Alerts | Route in |
| --- | --- | --- |
| `seroval` | 6 | `@tanstack/react-devtools` → `@tanstack/devtools` → `solid-js`, and `@tanstack/react-start` |
| `tar` | 3 | `@netlify/vite-plugin-tanstack-start` → `@netlify/vite-plugin` → `@netlify/dev` |
| `shell-quote` | 2 | transitive, development scope |
| `vitest` | 1 | **direct** devDependency |

### One parent dominates

`@netlify/vite-plugin-tanstack-start` is installed at **1.3.3**; **1.3.19**
is available. Its subtree is the route for `tar` (critical), `toml`,
`@opentelemetry/propagator-jaeger`, and both packages that have **no patch
at any version** — `extract-zip` and `image-size`. One parent bump is the
highest-value single move here.

Note those two unpatched packages arrive through Netlify's **local dev
emulation**, not through anything in the deployed runtime, even though the
alerts label them "runtime" scope. That distinction matters when deciding
whether to accept them.

## Approach

Ordered by value, each step verified before the next:

1. **Bump `@netlify/vite-plugin-tanstack-start` to 1.3.19.** Re-measure
   immediately — this one change is expected to move a large share of the
   critical and high count.
2. **Land the Dependabot pull requests that map to critical or high**, in
   small batches rather than one merge train, re-running `npm ci` per batch
   so the lockfile resolves once and honestly. Roughly: #67 (seroval), #66
   (tar), #65 (shell-quote), #86 (fast-uri), #70 (undici), #69
   (brace-expansion), #41 (picomatch), #53 (ws), #52 (tmp), #68 (postcss),
   #81 (browserslist), #83 (toml), #62 (propagator-jaeger), #84 (vitest
   cluster).
3. **Close, without merging, the Dependabot pull requests outside this
   scope** — #80, #57, #44, #46 and similar carry no critical or high
   alert. Dependabot reopens what still matters, and a shorter list is
   easier to keep honest.
4. **Re-measure, then decide the remainder deliberately.** Whatever is still
   flagged and still transitive with no fixed parent is a candidate for an
   `npm overrides` entry. There is no `overrides` block today; adding one is
   a decision to record, not a reflex, because it silently re-points a
   dependency the parent chose.
5. **Handle the unpatched two** — `extract-zip` and `image-size`. No version
   fixes either. The options are accept-and-document with the dev-only
   reasoning above, or drop the dependency that carries them. Whichever we
   pick gets written down, so the next person reading the alert list does
   not re-derive it.

## Decisions to settle before starting

- **`vite` 7 → 8.** A major bump, and `@netlify/vite-plugin` already wants
  vite 8. So the Netlify bump in step 1 may pull vite 8 with it, which makes
  this a decision about the whole build toolchain rather than a dependency
  tidy. If it does, that is its own piece of work, not a step in this one.
- **How far to take `overrides`.** Deliberate and recorded, or avoided
  entirely in favour of waiting for parents to update.
- **What "done" means.** Zero critical and high alerts, or zero *actionable*
  ones with the unpatched pair documented as accepted. The second is
  realistic; the first may not be reachable.

## Verification

Per batch, not once at the end:

- `npm ci` — strict lockfile check, never `npm install` for verification.
- `npm run check`, `npm test`, `npm run test:integration`, `npm run build`.
- Client-bundle grep for server-only signals, per CLAUDE.md, since several
  of these packages sit in the build path.
- A deploy preview before merging anything that touches the build
  toolchain — the Netlify plugin bump in particular.

## Risks

- **A toolchain bump wearing a security patch's clothes.** The Netlify
  plugin and vite changes reach the build, not just `node_modules`. Build
  green is necessary but not sufficient; the deploy preview is the check
  that matters.
- **Batch size.** One giant merge makes a failure impossible to attribute.
  Small batches cost more rounds and save the bisect.
- **Alert counts that never reach zero**, driving churn for its own sake.
  The unpatched pair is the obvious case: the honest end state may be
  documented acceptance.
- **Dependabot keeps producing these.** Feature 15's task list (T1) already
  observed this. A standing approach — grouping rules, an update schedule,
  or auto-merge for patch-level devDependency bumps — is worth considering
  at the end of this work, informed by what the backlog actually looked
  like.

## Not in scope

- Moderate and low alerts.
- The `vite` 7 → 8 major, unless step 1 forces it (see decisions).
- Any change to application code. This is a dependency pass; if a bump needs
  a code change, that is a finding to raise, not to absorb silently.
- The Prisma or Clerk lines, both recently handled.

## Note on production safety

This work contains **no migration**, so the standing call-out agreed on 17
Sep — that a pull request carrying a migration reaches production from its
preview build while feature 13 is deferred — does not apply here.

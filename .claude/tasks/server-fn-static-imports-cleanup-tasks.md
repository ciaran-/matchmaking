# Server Function Static Imports Cleanup: Task List

Plan: `.claude/plans/server-fn-static-imports-cleanup.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

---

## Dependency graph

```
T0 (pre-flight) ──> T1 (__root.tsx) ──> T2 (league.tsx) ──> T3 (match.tsx) ──> T4 (docs + memory) ──> T5 (verify + PR)
```

### Why sequential, not parallel

The route files are independent — they could be parallelised. They are sequenced here for three reasons:

1. **Build evidence accumulates.** If `__root.tsx` (1 site) converts cleanly with no client-bundle leak, that's strong evidence the same conversion will work in `league.tsx` (3 sites) and `match.tsx` (14 sites). If something does leak, we'd rather discover it on the smallest file.
2. **Easier to bisect.** Per-file commits in order means if a leak is later traced to one file, `git bisect` lands exactly on that conversion.
3. **`match.tsx` includes a non-handler helper (`authenticatedUser`).** That's the one place the conversion does something more interesting than a mechanical s/await import/import/ — saving it for last means we've calibrated against the mechanical cases first.

If picking up cold and you need to parallelise: yes, the route conversions are independent. T4 (docs + memory) still must wait for all three. T5 (verify + PR) must wait for everything.

---

## Verification template (referenced by T1, T2, T3, T5)

After any conversion, run:

```bash
npm run build
```

The build must succeed. Then verify the relevant client bundle does not contain server-only symbols. Bundle filenames have content hashes, so:

```bash
# For a converted route file named e.g. src/routes/match.tsx, find its CLIENT bundle:
BUNDLE=$(ls dist/client/assets/match-*.js | head -1)
# (substitute `__root` / `league` / `match` as appropriate; index.tsx maps to "index-*")

for token in "@prisma" "PrismaClient" "createClerkClient" "@clerk/backend" \
             "syncUser" "recordGame" "createSearch" "cancelSearch" \
             "runMatcherForSearch" "getActiveSearchForUser" "getMatchState" \
             "expireIfStale" "confirmPendingGame" "declinePendingGame" \
             "convertPendingGameToResult" "getLeagueActivity" \
             "DISTINCT ON"; do
  count=$(grep -c "$token" "$BUNDLE" 2>/dev/null || echo 0)
  printf "%-30s %s\n" "$token" "$count"
done
```

**Acceptance: every count must be `0`.** Any non-zero is a real leak. Do NOT commit; undo the conversion and stop to investigate. The most likely cause if something does leak is the failure mode listed under "Open risks" item 1 in the plan (`authenticatedUser` helper), but treat any leak as evidence to be examined, not explained away.

The `dist/client/assets/` directory is the load-bearing one. `dist/server/assets/` will contain server-only code by design — don't grep there.

---

## Pre-flight: T0

**Status:** pending
**Depends on:** nothing
**Blocks:** T1

### Context

Get into a known-good starting state and confirm the baseline. Catches local drift, dirty working trees, or stale `node_modules` before any code changes.

### Steps

1. Read `.claude/plans/server-fn-static-imports-cleanup.md` end-to-end. The plan is the source of truth for *why* this change is correct and what the verification contract is.
2. Read `CLAUDE.md`, especially the existing `## createServerFn Pattern` section (the one this work makes obsolete). Knowing the current advice helps spot any place in the code that's written explicitly to satisfy it.
3. Confirm `git status` is clean. If `AGENTS.md` is the only untracked file, that's expected — leave it alone.
4. Confirm you're on `main` and up to date: `git fetch origin && git checkout main && git pull --ff-only`.
5. Run a baseline build to make sure the world is green BEFORE any changes: `npm run build` — should succeed with no errors. Note the bundle sizes for `dist/client/assets/__root-*.js`, `dist/client/assets/league-*.js`, and `dist/client/assets/match-*.js` (rough numbers; they'll shift slightly after the refactor and the deltas should be sane — drop in size, not increase).
6. Run the verification grep template (above) against the current `match-*.js` client bundle on `main`. Expected result: every count is `0`. This is the "starting state" baseline — the cleanup must preserve it.
7. Create the working branch: `git checkout -b server-fn-static-imports-agent-<short-id>` (per CLAUDE.md sub-agent / worktree convention — short-id is 2–3 hex chars, not the full agent id).

### Acceptance criteria

- On the new branch, with clean working tree.
- Baseline `npm run build` succeeds.
- Baseline client-bundle grep returns all zeros.

---

## T1 — Convert `src/routes/__root.tsx`

**Status:** pending
**Depends on:** T0
**Blocks:** T2

### Context

`__root.tsx` is the smallest case — one `createServerFn` with one dynamic import. Use it to confirm the conversion pattern works before scaling up.

### Read first

- `src/routes/__root.tsx` in full
- `src/lib/sync-user.ts` (the imported module — confirm it's server-only and won't accidentally pull React/client code)
- Plan §"Inventory" — `__root.tsx` row
- Plan §"Approach" — the per-file conversion steps

### Modify

`src/routes/__root.tsx`:

1. Add a static top-level import: `import { syncUser } from '../lib/sync-user';`. Slot it into the existing import block in the order Biome would produce (external packages first, then relative imports — but check what's already there and mirror that group's style).
2. Inside the server fn handler (around line 17), delete the `const { syncUser } = await import('../lib/sync-user');` line.
3. The body of the handler now references `syncUser` directly from the top-level import; no other change needed.

### Verify

Run the verification template (above) against `dist/client/assets/__root-*.js`. The interesting symbol here is `syncUser` — it must not appear in the client bundle. Also re-check `@prisma` / `PrismaClient` since `sync-user.ts` transitively touches the DB; those must also remain absent.

Also re-grep the `match-*.js` and `league-*.js` client bundles — the baseline ones from T0. Cross-route side effects from this change are unlikely but a leak in another route caused by this change would still be a leak.

Then: `npm run format && npm run check`. Both clean.

### Commit

`refactor: convert __root.tsx server fn to static imports`

Body should briefly note this is part of the cleanup tracked in `.claude/plans/server-fn-static-imports-cleanup.md`.

### Acceptance criteria

- `__root.tsx` no longer contains `await import(`.
- Build succeeds.
- Verification grep for `__root-*.js` and the other two route bundles: all zeros.
- `npm run check` clean.

---

## T2 — Convert `src/routes/league.tsx`

**Status:** pending
**Depends on:** T1
**Blocks:** T3

### Context

Middle case — three dynamic import sites, two of them already-paired (Clerk auth dance: `createClerkClient` + `getRequest`). Same mechanical conversion as T1, just three sites.

### Read first

- `src/routes/league.tsx` in full
- `src/lib/record-game.ts` (confirm server-only — should already be, since it uses Prisma)
- Plan §"Inventory" — `league.tsx` row

### Modify

`src/routes/league.tsx`:

1. Add static top-level imports for `createClerkClient` (from `@clerk/backend`), `getRequest` (from `@tanstack/react-start/server`), and `recordGame` (from `../lib/record-game`).
2. Delete the three `await import(...)` lines from inside the handler (lines 34, 35, 45 at the time of writing — confirm by re-grepping if the file has drifted).
3. The handler body now uses the top-level imports directly.

If there's a justifying comment in the file about why those imports were dynamic (mirroring the block at `match.tsx:21–25`), delete it too. If there isn't one, no action.

### Verify

Run the verification template against `dist/client/assets/league-*.js`. Critical symbols: `createClerkClient`, `@clerk/backend`, `recordGame`, `@prisma`, `PrismaClient`. All must be `0`.

Also re-grep the `__root-*.js` and `match-*.js` client bundles.

Then: `npm run format && npm run check`. Both clean.

### Commit

`refactor: convert league.tsx server fns to static imports`

### Acceptance criteria

- `league.tsx` no longer contains `await import(`.
- Build succeeds.
- Verification grep for `league-*.js` and the other two route bundles: all zeros.
- `npm run check` clean.

---

## T3 — Convert `src/routes/match.tsx`

**Status:** pending
**Depends on:** T2
**Blocks:** T4

### Context

The largest and most interesting case. 14 dynamic import sites across 7 server function handlers AND inside the `authenticatedUser()` top-level helper.

The helper is the non-mechanical part. `authenticatedUser` is a top-level async function (not a `createServerFn`) called from every handler. Converting its three dynamic imports to static means we're trusting TanStack Start's `?tss-serverfn-split` Vite plugin to treat the helper's transitive imports as server-only because the helper is only reachable from handler bodies.

This was not exercised by the single-function test that motivated this plan (that test only converted `getLeagueActivityFn`'s body, leaving `authenticatedUser` with its dynamic imports). **The client-bundle grep after this commit is the moment of truth.** If `@clerk/backend`, `createClerkClient`, or `prisma` leaks, the helper's transitive imports aren't being stripped and the helper needs different treatment — most likely moved into its own `.ts` file that lives outside the route file and is only ever imported from handler bodies.

### Read first

- `src/routes/match.tsx` in full (especially the `authenticatedUser` helper at the top and the six handler definitions below it)
- Plan §"Inventory" — `match.tsx` rows
- Plan §"Open risks / things to look out for" — items 1 and 3 are directly relevant

### Modify

`src/routes/match.tsx`:

1. Add these static top-level imports (grouped per Biome's import order — external packages then `@/` aliases, alphabetical within group):

   - `import { createClerkClient } from '@clerk/backend';`
   - `import { getRequest } from '@tanstack/react-start/server';`
   - `import { prisma } from '@/db';`
   - `import { getLeagueActivity } from '@/lib/matchmaking/dashboard';`
   - `import { confirmPendingGame, convertPendingGameToResult, declinePendingGame, expireIfStale } from '@/lib/matchmaking/pending-game';`
   - `import { runMatcherForSearch } from '@/lib/matchmaking/run-matcher';`
   - `import { cancelSearch, createSearch } from '@/lib/matchmaking/search';`
   - `import { getActiveSearchForUser, getMatchState } from '@/lib/matchmaking/state';`

   Don't trust this list verbatim — re-derive from a fresh `grep -n "await import(" src/routes/match.tsx` to make sure no site has been added or removed since this was written.

2. Delete every `await import(...)` line inside the handlers and inside `authenticatedUser`. The handlers now reference the top-level imports directly.

3. Delete the obsolete comment block at the top of the file (was lines 21–25 at the time of writing):

   ```
   // Server-only modules (`@/db`, `@/lib/matchmaking/*`, `@clerk/backend`,
   // `@tanstack/react-start/server`) are deliberately NOT imported at the top
   // of this file. They are dynamically imported inside each `createServerFn`
   // handler so Vite does not pull them into the client bundle. See
   // CLAUDE.md §"createServerFn Pattern".
   ```

4. Re-grep the file to confirm zero remaining `await import(` lines.

### Verify

**This is the critical verification for the whole cleanup.** Run:

```bash
npm run format && npm run check && npm run build
```

All clean.

Then run the verification template against `dist/client/assets/match-*.js`. Every symbol must be `0`. Pay especial attention to:

- `@prisma`, `PrismaClient` — would indicate the `prisma` import inside `authenticatedUser` leaked.
- `createClerkClient`, `@clerk/backend` — same, for the Clerk import inside `authenticatedUser`.
- All the lib helpers (`createSearch`, `cancelSearch`, `runMatcherForSearch`, `getActiveSearchForUser`, `getMatchState`, `expireIfStale`, `confirmPendingGame`, `declinePendingGame`, `convertPendingGameToResult`, `getLeagueActivity`).

Also re-grep `__root-*.js` and `league-*.js` for completeness.

**If anything leaks:** do NOT commit. Run `git stash` (or `git restore .`) and report the leak. Likely path forward is to move `authenticatedUser` into a dedicated server-only file (e.g. `src/routes/match.server.ts` if that convention works, or `src/lib/auth/route-helper.ts`) and import it from `match.tsx`. That changes the diff shape and warrants its own discussion — don't paper over it.

Also run `npm run test` and `npm run test:integration` — neither should regress, but worth confirming since `match.tsx` is the most central file the project has.

### Commit

`refactor: convert match.tsx server fns to static imports`

Body should mention: (a) this includes the `authenticatedUser` helper; (b) build + client-bundle grep used to verify nothing leaked; (c) reference to the plan.

### Acceptance criteria

- `match.tsx` no longer contains any `await import(`.
- The obsolete top-of-file comment block is deleted.
- `npm run check` clean.
- `npm run build` succeeds.
- Verification grep for `match-*.js` (and the other two route bundles): all zeros.
- `npm run test` and `npm run test:integration` pass.

---

## T4 — Update `CLAUDE.md` and the auto-memory

**Status:** pending
**Depends on:** T3 (so the recommendation reflects code that already follows it)
**Blocks:** T5

### Context

Current `CLAUDE.md` instructs developers (and agents) to use the dynamic-import pattern. Now wrong. Also the auto-memory file `feedback_server_fn_pattern.md` carries the same wrong advice and will silently re-introduce the bad pattern unless updated.

The auto-memory directory is at: `/Users/ciaran/.claude/projects/-Users-ciaran-development-softbrew-internal-matchmaking/memory/`

Memory files are NOT in the git repo — they're per-developer and per-Claude-instance. Updating them on this machine is helpful for this user; updating the in-repo docs is what cross-cuts to everyone.

### Read first

- `CLAUDE.md` — the existing `## createServerFn Pattern` section (and the `### Clerk auth guard (in server functions)` example block beneath it).
- `/Users/ciaran/.claude/projects/-Users-ciaran-development-softbrew-internal-matchmaking/memory/feedback_server_fn_pattern.md` (the current memory body)
- `/Users/ciaran/.claude/projects/-Users-ciaran-development-softbrew-internal-matchmaking/memory/MEMORY.md` (the index)
- Plan §"Documentation updates (single commit at the end)" — has full proposed wording for all three files

### Modify

1. **`CLAUDE.md` `## createServerFn Pattern` section.** Rewrite using the wording proposed in the plan's §"Documentation updates". Headline change: static imports at top of file are recommended, the build's `?tss-serverfn-split` plugin handles the splitting, dynamic imports are actively discouraged.

2. **`CLAUDE.md` `### Clerk auth guard (in server functions)` example.** Rewrite to use top-of-file static imports (sample in the plan).

3. **`feedback_server_fn_pattern.md`** in the auto-memory. Rewrite body using the wording proposed in the plan. Crucially, the **why** section captures that a prior session recorded the opposite advice based on a real but unexplained Vite error, and that on re-check against current TanStack Start (version 1.167.16 — confirm via `package.json` in case it's drifted) the static imports work cleanly. This bit matters: it stops a future Claude from "fixing" the new memory back to the old one based on stale priors.

4. **`MEMORY.md`** in the auto-memory. Update the one-line entry for `feedback_server_fn_pattern.md` to reflect the new wording (see plan).

### Verify

`npm run check` clean (CLAUDE.md isn't linted by Biome, but if you accidentally broke a code block in it, this catches nothing — it's a manual proofread).

Open `CLAUDE.md` in a renderer (or just re-read it as the diff) and confirm the new section is internally consistent and doesn't contradict any other CLAUDE.md guidance.

### Commit

`docs: update createServerFn guidance to recommend static imports`

Body should mention:
- The TanStack Start `?tss-serverfn-split` plugin is the mechanism.
- Verification contract is `npm run build` + client-bundle grep.
- The auto-memory `feedback_server_fn_pattern.md` was also updated (not in the git diff because memory lives outside the repo, but noted for traceability).

### Acceptance criteria

- `CLAUDE.md` `## createServerFn Pattern` and `### Clerk auth guard` sections rewritten.
- `feedback_server_fn_pattern.md` rewritten to reflect the corrected understanding (with the "why" anchor to prevent regression).
- `MEMORY.md` index updated for the same memory.
- Nothing in `CLAUDE.md` still references "dynamic import inside the handler" as the recommended pattern.

---

## T5 — Final verification + PR

**Status:** pending
**Depends on:** T4
**Blocks:** nothing (merge)

### Context

Last pass. Catches anything that slipped through the per-task verification and gets the branch ready to merge.

### Pre-PR checklist (run in order)

1. `npm run format` — clean.
2. `npm run check` — clean.
3. `npm run build` — clean.
4. `npm run test` — clean.
5. `npm run test:integration` — clean.
6. Verification grep template against all three client bundles (`__root-*.js`, `league-*.js`, `match-*.js`). All zeros.
7. `grep -rn "await import(" src/routes/` — must return zero matches. (The Netlify scheduled function still has one and that's intentional — see plan §"Scope: Out of scope". Don't widen the grep to all of `src/` unless you want a noisy result that includes nothing actionable for this PR.)

### PR

Title: `refactor: use static imports for createServerFn handlers`

Body should include:

- A one-paragraph summary of what changed and why (citing the TanStack Start docs and the build-evidence verification).
- Reference to the plan: `.claude/plans/server-fn-static-imports-cleanup.md`.
- The commit list (4 commits: three route conversions + docs/memory).
- A test plan section listing the verification steps actually run (npm run check / build / test / test:integration / client-bundle grep).
- A short "previously" note: the old dynamic-import pattern was based on a Vite error captured by a prior session whose root cause was never determined. Re-verified against current TanStack Start that static imports work cleanly and the build plugin handles client-side stripping.

If `package-lock.json` was regenerated for any reason, run `npm ci` (not `npm install`) before pushing — per CLAUDE.md.

### Acceptance criteria

- All checklist steps pass.
- PR opened with the right title and body.
- No remaining `await import(` calls inside `src/routes/`.

---

## Out of scope (do not bundle into this PR)

These were considered and explicitly left out:

- **`netlify/functions/matchmaker-tick.ts`** still uses `await import('../../src/lib/matchmaking/run-matcher')`. This is a Netlify scheduled function, not a `createServerFn` — the `?tss-serverfn-split` plugin doesn't apply. The dynamic import there is a no-op (the handler unconditionally calls `runMatcherPass`) so converting to static is harmless, but the rationale is different and shouldn't muddy this PR. File a separate cleanup if desired.

- **`import type` patterns.** These are erased at compile time and never reach the client bundle. Leave alone.

- **Other refactors** in the route files. The diff should be exclusively s/dynamic-import/static-import plus the obsolete comment deletion. No rename, no helper extraction (except the helper-extraction fallback in T3's "if leak" path, which would be its own subsequent PR).

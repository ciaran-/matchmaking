# Server Function Static Imports Cleanup

## Background

Every `createServerFn` handler in this codebase currently uses a `const { X } = await import('...')` pattern instead of static imports at the top of the file. This pattern is documented in `CLAUDE.md` §"`createServerFn` Pattern" and saved in the auto-memory as `feedback_server_fn_pattern.md`. The stated rationale was a real, observed Vite error (`'Readable' is not exported by '__vite-browser-external'`) caused by static imports of server-only modules leaking into the client bundle.

While reviewing feature 5 the user pointed out the official TanStack Start docs explicitly recommend **static** imports for server functions and warn against dynamic imports ("Avoid dynamic imports for server functions" / "❌ Can cause bundler issues"). On verification:

- Converted `getLeagueActivityFn` in `src/routes/match.tsx` from dynamic to static imports and ran `npm run build`.
- The build succeeded.
- Scanned `dist/client/assets/match-*.js` for server-only symbols (`@prisma`, `PrismaClient`, `createClerkClient`, `@clerk/backend`, `getLeagueActivity`, `getActiveSearches`, `getActiveMatches`, `DISTINCT ON`). **Zero occurrences.**
- Build emitted a warning revealing the mechanism: `?tss-serverfn-split` — a TanStack Start Vite plugin that splits every `createServerFn().handler(...)` body into its own server-side chunk and stubs it in the client bundle. Static imports work because the plugin strips server-fn bodies (and their transitive imports) from the client side automatically.

The dynamic-import pattern was always unnecessary ceremony under current TanStack Start, and the warning explicitly says it's a no-op anyway (`dynamic import will not move module into another chunk` because the same modules are statically imported through other chains). Whatever original error prompted the workaround is no longer relevant.

This plan covers the cleanup: convert all dynamic imports inside server function handlers to static imports, update the in-repo docs and the auto-memory, and verify each route's client bundle stays clean.

## Scope

In scope:

- `src/routes/__root.tsx`
- `src/routes/league.tsx`
- `src/routes/match.tsx`
- `CLAUDE.md` — rewrite the `createServerFn` Pattern section
- `.../memory/feedback_server_fn_pattern.md` — rewrite to capture the corrected understanding
- `.../memory/MEMORY.md` — update the index line for the rewritten memory

Out of scope (and why):

- **`netlify/functions/matchmaker-tick.ts`** — this is a Netlify scheduled function, not a TanStack Start server function. The `?tss-serverfn-split` plugin does not touch it. The dynamic import there is functionally a no-op (the handler unconditionally calls `runMatcherPass`); converting it to a static import is harmless but is a different rationale and shouldn't be bundled with the server-fn cleanup. File a separate cleanup if desired.
- **Lib-side static imports** (e.g. `dashboard.ts` → `state.ts`). These are already static and correctly so; nothing to change.
- **`import type` patterns** (e.g. `import type { GameParticipant } from '@prisma/client'` at the top of `match.tsx`). Type-only imports are erased at compile time and don't leak into the client bundle. Leave alone.

## Inventory

`grep -rn "await import(" src/` produces this list. Each conversion is a `const { X } = await import('Y')` → an `import { X } from 'Y'` at the top of the file, plus removal of the now-redundant `await import(...)` line.

### `src/routes/__root.tsx` (1 site)

| Line | Currently dynamically imports |
|------|-------------------------------|
| 17   | `syncUser` from `../lib/sync-user` |

### `src/routes/league.tsx` (3 sites)

| Line | Currently dynamically imports |
|------|-------------------------------|
| 34   | `createClerkClient` from `@clerk/backend` |
| 35   | `getRequest` from `@tanstack/react-start/server` |
| 45   | `recordGame` from `../lib/record-game` |

### `src/routes/match.tsx` (14 sites across 7 functions)

The route file contains:
- `authenticatedUser()` helper — 3 dynamic imports (Clerk, request utils, prisma).
- `startSearchFn` — 3 dynamic imports.
- `cancelSearchFn` — 1 dynamic import.
- `pollSearchStatusFn` — 3 dynamic imports.
- `confirmMatchFn` — 1 dynamic import.
- `declineMatchFn` — 1 dynamic import.
- `recordPendingGameResultFn` — 2 dynamic imports.
- `getLeagueActivityFn` — 1 dynamic import.

The unique module set across all 14 sites is:
- `@clerk/backend` → `createClerkClient`
- `@tanstack/react-start/server` → `getRequest`
- `@/db` → `prisma`
- `@/lib/matchmaking/search` → `createSearch`, `cancelSearch`
- `@/lib/matchmaking/run-matcher` → `runMatcherForSearch`
- `@/lib/matchmaking/state` → `getActiveSearchForUser`, `getMatchState`
- `@/lib/matchmaking/pending-game` → `expireIfStale`, `confirmPendingGame`, `declinePendingGame`, `convertPendingGameToResult`
- `@/lib/matchmaking/dashboard` → `getLeagueActivity`

After the sweep, `match.tsx` has these as static top-of-file imports, and every `await import(...)` line inside the handlers is gone.

Also delete the obsolete comment block at lines 21–25 of `match.tsx`:

```
// Server-only modules (`@/db`, `@/lib/matchmaking/*`, `@clerk/backend`,
// `@tanstack/react-start/server`) are deliberately NOT imported at the top
// of this file. They are dynamically imported inside each `createServerFn`
// handler so Vite does not pull them into the client bundle. See
// CLAUDE.md §"createServerFn Pattern".
```

## Approach

Convert one route file at a time. Per file:

1. Add the static `import { ... } from '...'` lines at the top, grouped per the existing import style (external packages first, then `@/` aliases, alphabetical within group — match what Biome's import sorter produces).
2. Delete the `const { X } = await import('Y')` lines inside the handlers.
3. Delete any comment that justified the dynamic-import pattern.
4. Run `npm run build`.
5. Verify the client bundle for that route does not contain server-only symbols (see Verification below).
6. Commit the file as its own commit so a regression can be bisected.

Order: `__root.tsx` (smallest) → `league.tsx` (medium) → `match.tsx` (largest). Get build-evidence for the simpler cases first.

## Verification

After each file's conversion, run:

```bash
npm run build
```

For routes with server functions, scan the corresponding client bundle for server-only symbols. The exact bundle filename has a content hash, so:

```bash
# Pick the client bundle for the route. Replace <route> with the route name.
BUNDLE=$(ls dist/client/assets/<route>-*.js | head -1)
for token in "@prisma" "PrismaClient" "createClerkClient" "@clerk/backend" \
             "syncUser" "recordGame" "createSearch" "runMatcherForSearch" \
             "getActiveSearchForUser" "expireIfStale" "confirmPendingGame" \
             "convertPendingGameToResult" "getLeagueActivity" "DISTINCT ON"; do
  count=$(grep -c "$token" "$BUNDLE" 2>/dev/null || echo 0)
  printf "%-30s %s\n" "$token" "$count"
done
```

Acceptance: every count is `0`. Any non-zero is a leak and the conversion must be undone for investigation before continuing.

Also run, after all three route conversions land:

- `npm run check` — clean
- `npm run test` — clean (unit tests don't exercise routes directly, but no harm in confirming nothing regressed)
- `npm run test:integration` — clean (server-fn-adjacent lib code is exercised here)

Manual smoke not required for this refactor — `createServerFn` semantics don't change. Build evidence is the load-bearing check.

## Documentation updates (single commit at the end)

### `CLAUDE.md`

Rewrite the `## createServerFn Pattern` section. New content:

> Server functions are written with TanStack Start's `createServerFn`. **Import server-only modules statically at the top of the file** — the build's server-fn split plugin (`?tss-serverfn-split`) extracts each `handler(...)` body into its own server-side chunk and stubs it in the client bundle, so the static import never reaches the browser.
>
> Use `method: 'POST'` for any handler with side effects (DB writes, auth checks with cookie sets). Use `method: 'GET'` only for pure reads — GET functions can be triggered by router preloading.
>
> Avoid dynamic `await import(...)` inside handlers. The TanStack Start docs explicitly recommend against it ("❌ Can cause bundler issues"). Earlier project code used dynamic imports to work around a Vite client-bundle leak; that workaround is no longer required and the docs surface it as actively discouraged.
>
> Verify after non-trivial changes: `npm run build`, then `grep` the relevant client bundle for any server-only symbol (e.g. `@prisma`, `createClerkClient`, the name of an imported helper). Zero occurrences is the contract.

Delete the existing example block that shows the dynamic-import wrap; the static-import shape doesn't need its own example — it's standard ES module usage.

Keep the Clerk auth guard example, but rewrite to use static top-of-file imports:

```ts
import { createClerkClient } from '@clerk/backend';
import { getRequest } from '@tanstack/react-start/server';

const myFn = createServerFn({ method: 'POST' }).handler(async () => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) throw new Error('Missing Clerk env vars');

  const clerk = createClerkClient({ secretKey, publishableKey });
  const auth = await clerk.authenticateRequest(getRequest());
  if (!auth.isSignedIn) throw new Error('Unauthorized');
  // ...
});
```

### `feedback_server_fn_pattern.md` (auto-memory)

Rewrite. New body, roughly:

> Server functions written with `createServerFn` should statically import server-only modules at the top of the file. The TanStack Start build plugin (`?tss-serverfn-split`) splits handler bodies into a separate server-side chunk and stubs them in the client bundle; static imports do not leak. Dynamic `await import(...)` inside handlers is actively discouraged by the docs and was a no-op in this codebase (the modules were already in the server graph via other statically-imported lib files).
>
> **Why:** A prior session captured the opposite advice based on a real Vite error (`'Readable' is not exported by '__vite-browser-external'`). That error's actual cause was never determined; the dynamic-import workaround was preserved without re-testing across framework versions. On re-checking against current TanStack Start (1.167.16) and the official docs, static imports work cleanly and the dynamic-import pattern is now the wrong default. Past incident: feature 5 review; the user pushed back on the pattern, citing the docs; verified via build + client-bundle grep that static imports leak nothing.
>
> **How to apply:** Treat server function code as ordinary ES modules. Verify after non-trivial changes with `npm run build` and a grep of the relevant client bundle for server-only symbols. If a leak appears, *that* is the bug — investigate the specific file, not the pattern.

Cross-link `[[Build before commit]]` (since the build is the load-bearing verification step).

### `MEMORY.md` (auto-memory index)

Update the one-liner for `feedback_server_fn_pattern.md` to read:

> [createServerFn pattern](feedback_server_fn_pattern.md) — server functions use static imports at top of file; TanStack Start's split plugin strips handler bodies from the client bundle; verify via `npm run build` + client-bundle grep

## Open risks / things to look out for

1. **Helper functions called from handlers.** `authenticatedUser()` in `match.tsx` is a top-level helper (not a `createServerFn`) called from every handler. Once its imports become static, we're trusting the split plugin to treat the helper's transitive imports as server-only because they're only reachable from handler bodies. The single conversion test on `getLeagueActivityFn` didn't fully exercise this — that test left `authenticatedUser` with its dynamic imports intact. **Concrete check during `match.tsx`'s conversion**: after converting `authenticatedUser`'s three dynamic imports to static, the client-bundle grep must still come up clean for `@clerk/backend`, `createClerkClient`, and `prisma`. If anything leaks, that's the signal that the plugin's reachability analysis stops at handler boundaries and the helper itself needs different treatment (e.g. moving to a separate `.ts` file that's only ever imported from handler bodies).

2. **`__root.tsx`'s server fn runs at every navigation.** If something subtle changes in build output for that file, it affects the whole app. Inspect that build's client bundle especially carefully.

3. **Biome's import sorting.** After adding new top-level imports, run `npm run format` before `npm run check` — Biome's import sorter may reorder them and the CI lint is stricter than the formatter.

4. **The "uses [[X]]" memory links won't resolve until the memory is rewritten.** Update the memory file before relying on the new wording in any other context.

## Commit shape

One commit per route file, plus one for docs/memory:

1. `refactor: convert __root.tsx server fn to static imports`
2. `refactor: convert league.tsx server fns to static imports`
3. `refactor: convert match.tsx server fns to static imports`
4. `docs: update createServerFn guidance to recommend static imports`

The fourth commit also includes the memory update (the memory lives outside the repo, so it doesn't show up in the diff, but mention the update in the commit message body for traceability).

## Acceptance criteria

- All `await import(...)` calls inside `createServerFn` handlers in `src/routes/*.tsx` are gone.
- The obsolete comment block at `match.tsx:21-25` is deleted.
- `CLAUDE.md` no longer recommends dynamic imports.
- `feedback_server_fn_pattern.md` reflects the corrected understanding.
- `npm run check`, `npm run build`, `npm run test`, `npm run test:integration` all clean.
- For each converted route, a grep of its client bundle for the listed server-only symbols returns zero occurrences.

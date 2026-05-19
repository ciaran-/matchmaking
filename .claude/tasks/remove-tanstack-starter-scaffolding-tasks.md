# Remove TanStack Starter Scaffolding: Implementation Tasks

> Read the full plan at `.claude/plans/remove-tanstack-starter-scaffolding.md` before starting.
> Also read `CLAUDE.md` — in particular **Pre-commit Checklist**, the **`createServerFn` Pattern**, and the **Plans and Tasks** sections.

This is a cleanup pass. The work is mostly file deletions plus three small edits and one route rewrite. Each task below is small and self-contained; tasks T1–T5 and T7 are all independent deletions and can be done in any order (or in parallel) — only T6 (which couples a deletion with a route-file edit) has an internal ordering constraint.

## Dependency graph

```
Pre-flight
   └─> T1 (delete demo routes)
   └─> T2 (delete demo components)
   └─> T3 (delete demo hooks + .gitkeep)
   └─> T4 (delete demo data + .gitkeep)
   └─> T5 (delete demo db-collections + .gitkeep)
   └─> T6 (delete demo store + edit __root.tsx)   ← internal ordering, see task
   └─> T7 (trim storybook UI primitives)
   └─> T8 (rewrite home page)
   └─> T9 (replace README)
        └─> T10 (verification + commit)
```

T1–T9 are all independent and may be tackled in parallel. T10 must run last.

## Out of scope

These were considered and intentionally deferred. Do **not** touch them in this work:

- `package.json` dependencies (storybook, react-form, react-store, react-db, etc.). A future cleanup pass before product launch will remove unused deps.
- `public/` assets — manifest, robots, favicons, TanStack logos. Logos will be replaced as a separate piece of work once we have project artwork.
- TanStack logo references in retained source files (`/tanstack-circle-logo.png` is used by `src/routes/league.tsx` and the new `src/routes/index.tsx`). Leave them in place.
- `.storybook/` config — we'll likely add story-based testing soon.
- Renaming `src/components/storybook/` to something less misleading (e.g. `src/components/ui/`). Optional follow-up.

---

## Pre-flight (do once before any task)

1. Read `.claude/plans/remove-tanstack-starter-scaffolding.md` end-to-end.
2. Confirm working tree is clean (`git status`).
3. Create a branch following the worktree naming convention from CLAUDE.md: `remove-starter-scaffolding-agent-<short-id>` (or `-dev-<initials>` for human work).
4. Run `npm install` and `npm run build` against the current state to confirm a clean baseline.

---

## T1 — Delete `src/routes/demo/`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Remove all 18 demo route files. `routeTree.gen.ts` will regenerate on the next build/dev run — do not hand-edit it.

### Steps

1. Delete the entire directory: `rm -rf src/routes/demo/`.
2. Confirm none of the deleted files are referenced from outside `src/routes/demo/` itself:
   ```bash
   grep -rn "routes/demo" src --include="*.ts" --include="*.tsx"
   ```
   Should return nothing (other than the auto-generated `routeTree.gen.ts`, which doesn't matter — it regenerates).

### Done when

- `src/routes/demo/` no longer exists.
- `grep` for `routes/demo` in `src/` shows no live references.

---

## T2 — Delete demo components

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Remove the three demo components in `src/components/`.

### Steps

1. Delete:
   - `src/components/demo.chat-area.tsx`
   - `src/components/demo.FormComponents.tsx`
   - `src/components/demo.messages.tsx`
2. Confirm no remaining references (they should only have been imported by demo routes deleted in T1):
   ```bash
   grep -rn "demo.chat-area\|demo.FormComponents\|demo.messages" src
   ```

### Done when

- The three files are gone.
- Grep returns no references.

---

## T3 — Delete demo hooks + `.gitkeep`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Empty out `src/hooks/` (currently demo-only) but preserve the folder as a structural hint for future feature work.

### Steps

1. Delete:
   - `src/hooks/demo.form-context.ts`
   - `src/hooks/demo.form.ts`
   - `src/hooks/demo.useChat.ts`
2. Create `src/hooks/.gitkeep` (empty file).
3. Confirm:
   ```bash
   grep -rn "hooks/demo" src
   ```
   should return nothing.

### Done when

- All three demo files deleted.
- `src/hooks/.gitkeep` exists.
- `ls src/hooks/` shows only `.gitkeep`.

---

## T4 — Delete demo data + `.gitkeep`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Empty out `src/data/` and preserve the folder.

`league-places.ts` (the hardcoded Wheatus / Nirvana / etc. league) is verifiably unreferenced: `src/routes/league.tsx` declares its own local `getLeaguePlaces` inline rather than importing from this file. Safe to delete.

### Steps

1. Delete:
   - `src/data/demo.punk-songs.ts`
   - `src/data/league-places.ts`
2. Create `src/data/.gitkeep`.
3. Confirm:
   ```bash
   grep -rn "data/demo.punk-songs\|data/league-places" src
   ```
   should return nothing.

### Done when

- Both files deleted.
- `src/data/.gitkeep` exists.
- `ls src/data/` shows only `.gitkeep`.

---

## T5 — Delete demo db-collections + `.gitkeep`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Remove the `messagesCollection` (TanStack DB local-only collection used solely by the deleted demo chat). Preserve the folder.

### Steps

1. Delete `src/db-collections/index.ts`.
2. Create `src/db-collections/.gitkeep`.
3. Confirm:
   ```bash
   grep -rn "messagesCollection\|db-collections" src
   ```
   should return nothing.

### Done when

- `src/db-collections/index.ts` deleted.
- `src/db-collections/.gitkeep` exists.

---

## T6 — Delete demo store + clean up `__root.tsx`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Remove the demo TanStack Store and its devtools panel registration. This task couples a deletion with an edit because deleting the demo-store files while `__root.tsx` still imports them would break the build.

### Read first

- `src/routes/__root.tsx`

### Steps

1. Edit `src/routes/__root.tsx`:
   - Remove the import: `import StoreDevtools from '../lib/demo-store-devtools';`
   - Remove the `StoreDevtools` entry from the `plugins` array passed to `<TanStackDevtools ... />`.
   - Update the page title in the `head()` meta from `'TanStack Start Starter'` to `'Matchmaking'`.
2. Delete:
   - `src/lib/demo-store.ts`
   - `src/lib/demo-store-devtools.tsx`
3. Confirm no remaining references:
   ```bash
   grep -rn "demo-store\|StoreDevtools" src
   ```
   should return nothing.

### Done when

- Both lib files deleted.
- `__root.tsx` no longer imports or references `StoreDevtools`.
- The meta title is `'Matchmaking'`.
- `npm run build` succeeds.

---

## T7 — Trim storybook UI primitives

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Remove the storybook UI components that aren't used anywhere outside the (now-deleted) demo routes. Retain `button`, `dialog`, `radio-group` and their stories — they are used by `src/routes/league.tsx` and are real app code despite the misleading folder name.

### Steps

1. Delete:
   - `src/components/storybook/slider.tsx`
   - `src/components/storybook/slider.stories.ts`
   - `src/components/storybook/input.tsx`
   - `src/components/storybook/input.stories.ts`
   - `src/components/storybook/index.ts` (the barrel — has no consumers; verified by `grep -rn "from '@/components/storybook'"` returning nothing).
2. Confirm the kept files are still present:
   ```bash
   ls src/components/storybook/
   ```
   Should show: `button.stories.ts`, `button.tsx`, `dialog.stories.tsx`, `dialog.tsx`, `radio-group.stories.ts`, `radio-group.tsx`.
3. Confirm no remaining imports of the deleted modules:
   ```bash
   grep -rn "storybook/slider\|storybook/input\|from '@/components/storybook'" src
   ```
   should return nothing.

### Done when

- The five files above are deleted.
- The six retained files are still in place.
- Greps come back clean.

---

## T8 — Rewrite `src/routes/index.tsx` (home page)

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Replace the TanStack marketing page with a brief project-relevant home page. Use the simplest solution that works — static markup with a single auth-state branch (per CLAUDE.md "Prefer the simplest solution" guidance).

### Read first

- `src/routes/index.tsx` (the current page, to be replaced)
- `src/routes/match.tsx` lines ~596–608 (for the hero visual language we're aligning with)
- `src/routes/league.tsx` lines ~190–204 (for the auth-gate pattern: `useUser()` from `@clerk/clerk-react`, plus `isLoaded` / `isSignedIn` handling)
- `src/components/Header.tsx` (already exposes Find a Match + League Table links to signed-in users, and a sign-in button to signed-out users)

### Implementation

Replace the entire body of `src/routes/index.tsx` with a static home page following this structure:

- Outer container: same slate gradient as `match.tsx` / `league.tsx` (`min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900`).
- Hero section: matches the visual approach of `match.tsx` — large `MATCH` / `MAKING` title with the same gradient styling. Reuse `/tanstack-circle-logo.png` for now (a future task will swap the logo).
- One short subtitle sentence describing the product: "Internal 1v1 matchmaking with Elo ratings." Adjust the wording lightly if it reads better, but keep it to a single sentence.
- Below the hero:
  - When `!isLoaded`: render a small "Loading…" placeholder (mirror the pattern from `league.tsx`).
  - When `!isSignedIn`: render a one-line message — "Sign in to find a match." No second sign-in button; the Header already exposes Clerk's sign-in.
  - When `isSignedIn`: render two `<Link>` buttons side by side — "Find a match" → `/match`, "League table" → `/league`. Use TanStack Router's `<Link>` (already imported in `Header.tsx` for reference). Style them in line with the gradient buttons used elsewhere (`bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 ...`).

Do not add a loader, server function, or any data fetching — this is a static page with one client-side auth check.

Keep the `createFileRoute('/')` export and `Route` definition shape intact at the top of the file.

### Done when

- The TanStack feature-card / marketing content is gone.
- The new page renders the three states (loading / signed-out / signed-in) correctly.
- `npm run build` succeeds.
- A quick `npm run dev` smoke check shows the page renders correctly in both signed-in and signed-out states.

---

## T9 — Replace `README.md`

**Status:** pending
**Depends on:** Pre-flight
**Blocks:** T10

### Goal

Replace the TanStack Start template boilerplate (which includes a misleading "Demo files" section pointing at code being deleted) with a short project-specific README.

### Implementation

Rewrite `README.md` so it contains, at minimum:

- A one-line project description (e.g. "Internal 1v1 matchmaking with Elo ratings, built on TanStack Start.").
- A pointer to `CLAUDE.md` for development commands, architecture, and conventions.
- A note about `.env.local` requirements (mention the variables that exist today: `DATABASE_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `VITE_SENTRY_DSN`). Do **not** copy the actual values — just list the variable names.

Keep the file trim. Anything that duplicates `CLAUDE.md` is dead weight — link, don't repeat.

### Done when

- `README.md` no longer contains the TanStack template content (including the "Demo files" section).
- It points at `CLAUDE.md` for command/architecture details.

---

## T10 — Verification + commit

**Status:** pending
**Depends on:** T1–T9
**Blocks:** nothing

### Goal

Confirm the cleanup builds, passes all checks and tests, and runs correctly end-to-end before committing.

### Steps

Run, in order:

1. `npm run format` (per CLAUDE.md pre-commit checklist — avoids follow-up formatting commits).
2. `npm run check` — Biome lint + format. Must report zero errors.
3. `npm run build` — must succeed. Confirm `routeTree.gen.ts` regenerated with only `/`, `/league`, `/match` (plus root) — no demo routes remain.
4. `npm run test` — all unit tests pass.
5. `npm run test:integration` — all integration tests pass. (Requires Docker.)
6. `npm run dev` and manually verify:
   - Home page (`/`) renders the new content in both signed-out and signed-in states.
   - Header shows the correct nav links per auth state.
   - `/match` and `/league` still work end-to-end (start a search, record a game).
   - The "TanStack Store" tab is no longer present in the devtools panel.
7. `npm run storybook` boots; only `button`, `dialog`, and `radio-group` stories appear.

### Commit

Once all checks above pass:

1. Stage with explicit file paths (per CLAUDE.md Git Safety Protocol — avoid `git add -A`).
2. Single commit. Suggested message:
   ```
   chore: remove TanStack Start template scaffolding

   - Delete demo routes, components, hooks, data, db-collections, and store
   - Trim unused storybook UI primitives (slider, input, barrel)
   - Rewrite home page with project-relevant copy and auth-gated links
   - Replace README with project-specific content
   - Preserve src/data, src/hooks, src/db-collections (.gitkeep) as structural hints
   ```
3. Push and open a PR.

### Done when

- `npm run check`, `npm run build`, `npm run test`, `npm run test:integration` all pass.
- Manual smoke check confirms home page, header, match, and league all work.
- Commit pushed, PR opened.

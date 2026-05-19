# Remove TanStack Start template scaffolding

## Goal

Strip the unused starter-kit demos and references so the remaining tree
reads as our app, not the template. Rewrite the home page copy as the
first concrete step — the existing TanStack marketing pitch is no longer
relevant.

## Out of scope (deferred)

- Removing unused npm dependencies (storybook, react-form, react-store,
  react-db, etc.) — some are likely to be picked up soon. Defer to a
  dedicated cleanup pass before product launch.
- Replacing TanStack logo references in code (`/tanstack-circle-logo.png`
  used by `index.tsx` and `league.tsx`). Logos will be sourced/produced
  separately and swapped in their own piece of work.
- Replacing assets in `public/` (favicon, logo192/512, manifest, robots,
  tanstack logos, prisma.svg). Same reason as above; manifest + robots
  remain in place for SEO/PWA hygiene.
- Renaming `src/components/storybook/` (a misleading folder name for
  button/dialog/radio-group, which are real app code). Optional follow-up.

## Files to delete

### Demo routes — `src/routes/demo/` (18 files)

Delete the entire `src/routes/demo/` directory:

- `api.names.ts`
- `api.tq-todos.ts`
- `clerk.tsx`
- `db-chat-api.ts`
- `db-chat.tsx`
- `form.address.tsx`
- `form.simple.tsx`
- `prisma.tsx`
- `sentry.testing.tsx`
- `start.api-request.tsx`
- `start.server-funcs.tsx`
- `start.ssr.data-only.tsx`
- `start.ssr.full-ssr.tsx`
- `start.ssr.index.tsx`
- `start.ssr.spa-mode.tsx`
- `store.tsx`
- `storybook.tsx`
- `tanstack-query.tsx`

`routeTree.gen.ts` regenerates automatically — do not hand-edit; it
updates on the next `npm run dev` / `npm run build`.

### Demo components — `src/components/`

- `demo.chat-area.tsx`
- `demo.FormComponents.tsx`
- `demo.messages.tsx`

### Demo hooks — `src/hooks/`

- `demo.form-context.ts`
- `demo.form.ts`
- `demo.useChat.ts`

After this, `src/hooks/` is empty — keep the folder per direction (add
`.gitkeep`, see below).

### Demo data — `src/data/`

- `demo.punk-songs.ts`
- `league-places.ts` (hardcoded Wheatus/Nirvana/etc. league —
  unreferenced; `league.tsx` declares its own `getLeaguePlaces` inline)

After this, `src/data/` is empty — keep the folder (`.gitkeep`).

### Demo db-collections — `src/db-collections/`

- `index.ts` (messagesCollection, only used by demo db-chat)

After this, `src/db-collections/` is empty — keep the folder
(`.gitkeep`).

### Demo store + devtools panel — `src/lib/`

- `demo-store.ts`
- `demo-store-devtools.tsx`

### Unused storybook UI primitives — `src/components/storybook/`

Components not referenced outside the deleted demo routes:

- `slider.tsx`
- `slider.stories.ts`
- `input.tsx`
- `input.stories.ts`
- `index.ts` (barrel — no consumers; every callsite imports direct from
  the named file)

The rest of the folder stays: `button.tsx`, `button.stories.ts`,
`dialog.tsx`, `dialog.stories.tsx`, `radio-group.tsx`,
`radio-group.stories.ts` — all used by `src/routes/league.tsx` (and the
stories cover those kept components).

## Placeholder files

Add a `.gitkeep` to each of these so the empty top-level folders survive
as structural hints:

- `src/data/.gitkeep`
- `src/db-collections/.gitkeep`
- `src/hooks/.gitkeep`

## Files to edit

### `src/routes/__root.tsx`

- Remove the import: `import StoreDevtools from '../lib/demo-store-devtools'`.
- Remove the `StoreDevtools` entry from the `plugins` array passed to
  `TanStackDevtools`.
- Update the `head().meta` title from `'TanStack Start Starter'` to
  `'Matchmaking'`.

### `src/routes/index.tsx` — full rewrite

Replace the TanStack marketing page (six framework feature cards + docs
CTA) with a brief, project-relevant home page. Keep the existing visual
language (slate gradient background, hero centered, cyan/blue accents)
for continuity with `league.tsx` and `match.tsx`.

Proposed structure (simple static markup, per CLAUDE.md "simplest
solution" guidance):

- Hero
  - Logo image (keep `/tanstack-circle-logo.png` reference for now —
    swap as part of the future logo work).
  - Title: "MATCH" / "MAKING" gradient styling, matching `match.tsx`.
  - Subtitle: one short sentence describing the product, e.g.
    "Internal 1v1 matchmaking with Elo ratings."
- Body
  - Signed-out (`!isSignedIn`): "Sign in to find a match." (Header
    already surfaces the Clerk sign-in button — no second CTA needed.)
  - Signed-in: two link buttons — "Find a match" → `/match`, "League
    table" → `/league`.

Use `useUser()` from `@clerk/clerk-react` for the auth gate, mirroring
`league.tsx`. No server function or loader needed.

### `src/components/storybook/index.ts`

Already covered above — deleted in full since no consumers.

### `README.md`

The current README is entirely TanStack template boilerplate (including
a "Demo files" section that points at code we're deleting). Replace
with a short project-specific README:

- One-line description.
- Pointer to `CLAUDE.md` for development commands and conventions.
- Pointer to `.env.local.example` (or the relevant onboarding doc) for
  required env vars.

Keep this trim — anything that duplicates `CLAUDE.md` is dead weight.

## Verification

After applying the changes:

1. `npm run check` — Biome lint + format passes.
2. `npm run build` — Vite builds; `routeTree.gen.ts` regenerates with
   only `/`, `/league`, `/match` (plus root).
3. `npm run test` — all unit tests pass (no test imports a demo file).
4. `npm run test:integration` — integration tests pass.
5. `npm run dev` — manually verify:
   - Home page loads with the new copy.
   - Header shows Home (always), Find a Match + League Table (signed
     in), sign-in button (signed out).
   - `/match` and `/league` still function end-to-end.
   - Devtools panel no longer shows the "TanStack Store" tab.
6. `npm run storybook` — boots; only button / dialog / radio-group
   stories are listed.

## Summary of impact

- **Deleted**: 18 demo route files, 3 demo components, 3 demo hooks,
  2 demo data files, 1 demo collections file, 2 demo store files,
  5 unused storybook files = **34 files**.
- **Edited**: `src/routes/__root.tsx`, `src/routes/index.tsx`,
  `README.md` = **3 files**.
- **Added**: 3 `.gitkeep` placeholders.
- **Regenerated**: `routeTree.gen.ts`.
- **Untouched (intentionally)**: deps in `package.json`, `public/`
  assets, `.storybook/` config, all real app code under `src/lib/`,
  `src/components/Header.tsx`, `src/integrations/`, `src/test/`,
  database layer.

# Plan: Lint Housekeeping

## Context

A lint check was recently added to the PR pipeline (`npm run lint`). It is currently producing failures due to unused variables and has latent formatting drift that isn't caught by CI yet.

## Goals

1. Stop the immediate CI failures
2. Fix formatting drift that already exists
3. Tighten CI so formatting drift is caught going forward

---

## Tasks

### 1. Fix unused variables in `Header.tsx`

`src/components/Header.tsx` has two unused state variables (`groupedExpanded`, `setGroupedExpanded`) that are failing the `biome lint` CI check. Delete them (or prefix with `_` if they're intentional stubs — check the component first).

**Rule:** `lint/correctness/noUnusedVariables`

---

### 2. Auto-fix formatting violations

Three files have spaces-vs-tabs and missing semicolon issues that don't match Biome's formatter config. Run `npm run format` to fix them all in one pass, then verify the diff looks clean.

**Affected files:**
- `.vscode/settings.json`
- `src/components/demo.FormComponents.tsx`
- `src/components/storybook/button.stories.ts`

---

### 3. Upgrade CI lint step to `npm run check`

Change the GitHub Actions lint step from `npm run lint` → `npm run check` so that both lint errors and formatting drift are caught on every PR going forward.

**File:** `.github/workflows/ci.yml`

---

## Order of operations

Do 1 and 2 together in a single commit (code fix + format fix), then 3 in a follow-up commit so the CI change is clearly separated from the code changes.

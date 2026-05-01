# Lint Housekeeping: Implementation Tasks

> Read the full plan at `.claude/plans/lint-housekeeping.md` before starting.
> Complete tasks in order — Task 3 depends on Tasks 1 and 2 being clean and passing.

---

## Task 1 — Fix unused variables in `Header.tsx`

**Goal:** Remove dead code that is currently failing the `biome lint` CI check.

**Steps:**
1. Read `src/components/Header.tsx` and locate the `groupedExpanded` / `setGroupedExpanded` state pair.
2. Check whether either variable is referenced anywhere in the component. If they are not used at all, delete both the `useState` declaration and any related imports.
3. If they appear to be intentional stubs for future work, prefix both with `_` (`_groupedExpanded`, `_setGroupedExpanded`) — Biome treats underscore-prefixed variables as intentionally unused and will not flag them.
4. Run `npm run format` after editing to ensure the file is correctly formatted.

**Done when:** `npm run lint` exits with no errors referencing `Header.tsx`.

---

## Task 2 — Fix formatting violations in three files

**Goal:** Bring `.vscode/settings.json`, `src/components/demo.FormComponents.tsx`, and `src/components/storybook/button.stories.ts` into alignment with Biome's formatter config (tabs, single quotes, semicolons).

**Steps:**
1. Run `npm run format` — Biome will auto-fix all three files.
2. Review the diff for each file to confirm only whitespace and punctuation changed (no logic or config values were altered).

**Note:** Tasks 1 and 2 should be committed together in a single commit.

**Done when:** The diff contains only formatting changes across these three files and no other files are unexpectedly modified.

---

## Task 3 — Verify lint and formatting are both clean

**Goal:** Confirm Tasks 1 and 2 together produce a fully clean codebase before committing.

**Steps:**
1. Run `npm run check` (this runs both lint and format checks together).
2. Confirm the output reports zero errors and zero warnings.
3. Commit the changes from Tasks 1 and 2 together.

**Done when:** `npm run check` exits cleanly with no errors. Commit created.

---

## Task 4 — Upgrade CI lint step to `npm run check`

**Goal:** Ensure the PR pipeline catches both lint errors and formatting drift going forward, not just lint errors.

**Steps:**
1. Open `.github/workflows/ci.yml` and find the lint step — it currently runs `npm run lint`.
2. Change the command to `npm run check`.
3. Run `npm run format` and then commit this change separately from Tasks 1–2 so the CI change is clearly isolated in git history.

**Done when:** `.github/workflows/ci.yml` runs `npm run check` in the lint step and the commit is clean.

---

## Task 5 — Verify CI passes

**Goal:** Confirm the pipeline is green end-to-end with the updated check command.

**Steps:**
1. Push the branch and open a PR (or check an existing one).
2. Confirm the lint job passes using `npm run check`.
3. Confirm the test and build jobs are unaffected.

**Done when:** All CI jobs pass on the PR.

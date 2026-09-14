# Feature 15 — Clerk Core 3 Upgrade (R3): Task List

Plan: `.claude/plans/feature-15-clerk-react-core-3-upgrade.md` — read in
full before starting. The plan is authoritative; this is the tactical
breakdown.

Roadmap item R3.

---

## Dependency graph

```
T1 (decide Dependabot ordering) ──> T2 (dependency swap + codemod) ──> T3 (client import fixes) ──> T4 (appearance check)
                                                                   └─> T5 (backend bump + sync-user) ──> T6 (automated verification) ──> T7 (manual smoke) ──> T8 (deploy preview)
```

### Strict ordering

T2 before everything. T7 and T8 are last and cannot be skipped — the plan
is explicit that undocumented behaviour changes in `SignIn` and `useUser`
are why the smoke test exists.

---

## Pre-flight (do once)

1. Read `.claude/plans/feature-15-clerk-react-core-3-upgrade.md`,
   including its Risks section.
2. Read `CLAUDE.md` — **`createServerFn` Pattern** (client-bundle
   verification), **Testing**, **Pre-commit Checklist**.
3. Confirm `npm run build`, `npm test` and `npm run test:integration` pass
   on `main`.
4. Confirm access to the Clerk dashboard and to a deploy preview.
5. Branch: `feature-15-clerk-core-3-agent-<short-id>`.
6. This work contains no migration, so it is safe to merge before R1a.

---

## T1 — Dependabot ordering

**Status:** decided 14 Sep — this upgrade goes first
**Depends on:** nothing
**Blocks:** nothing

The two open Dependabot branches (`svgo-4.1.0` and a multi-package one)
wait until after this upgrade, and are handled as they come.

If one of them lands on `main` mid-flight, rebase and re-run `npm ci`
rather than merging `main` into the branch, so the lockfile resolves once.

Dependabot will keep producing these indefinitely, and a standing approach
to clearing them without blocking feature work is worth its own small
feature later. It is not this one.

---

## T2 — Swap the dependencies and run the codemod

**Status:** not started
**Depends on:** T1

- `npm uninstall @clerk/clerk-react`, `npm install @clerk/react@^6`.
- Run `npx @clerk/upgrade` and **review its diff** rather than trusting it.
  It may prompt; if so run it as `! npx @clerk/upgrade` so it has a TTY.
- `npm ci` afterwards to check the lockfile strictly.
- Confirm `npm ls @clerk/shared` reports a single version — running two
  Clerk cores side by side is the reason for this work.

---

## T3 — Fix the client imports the codemod missed

**Status:** not started
**Depends on:** T2

The plan's table is the checklist, whatever the codemod reported:

- `src/integrations/clerk/provider.tsx` — import path only.
- `src/integrations/clerk/header-user.tsx` — **`SignedIn`/`SignedOut` are
  removed in v6** → `<Show when="signed-in">` / `<Show when="signed-out">`.
- `src/components/SignInGate.tsx`, `src/components/Header.tsx`,
  `src/routes/match.tsx`, `src/routes/index.tsx` — import paths.
- `src/components/SignInGate.test.tsx` — mock `@clerk/react`.
- `src/lib/sync-user.ts` — update the comment naming `@clerk/clerk-react` v5.

---

## T4 — Appearance check on the sign-in gate

**Status:** not started
**Depends on:** T3

`colorRing` and `colorModalBackdrop` now render at full opacity rather than
15%, and `showOptionalFields` defaults to `false`. Check the focus ring and
the modal backdrop on `/`, and cap any correction at one polish pass.

---

## T5 — Bump `@clerk/backend`, and drop the deprecated call

**Status:** not started
**Depends on:** T2

- Bump `@clerk/backend` from `3.2.14` to the latest `3.x` — a minor bump
  spanning many releases, and decisions 0004 and 0005 rely on its `apiKeys`
  and M2M handling.
- Read its changelog for `apiKeys`, `authenticateRequest` and M2M changes.
- While here: `sync-user.ts` still uses the deprecated `isSignedIn`. Switch
  it to `isAuthenticated`, matching `auth.ts`.

---

## T6 — Automated verification

**Status:** not started
**Depends on:** T3, T5

- `npm run check`, `npm test`, `npm run test:integration`, `npm run build`.
- Grep the client bundles for server-only markers — `@clerk/backend`,
  `createClerkClient`, `@prisma` — per CLAUDE.md. Package-level signals
  must return zero matches.

---

## T7 — Manual smoke test

**Status:** not started
**Depends on:** T6

Needs live Clerk. Every step from the plan:

- Signed out on `/`: the styled button opens the sign-in modal; check the
  backdrop.
- Signed out on `/match` and `/league`: the themed `<SignIn />` renders;
  check the focus ring.
- Signing in reveals gated content without a reload, and the header swaps
  `SignInButton` for `UserButton`.
- Signing out returns to `/`.
- `/settings/api-keys`: minting and revoking a key still work.
- A real personal API key against `GET /api/v1/leaderboard` returns 200.

---

## T8 — Deploy preview check

**Status:** not started
**Depends on:** T7

Sign in on a Netlify deploy preview before merging. Cookies on a deployed
domain behave differently from localhost, which is the failure this catches.

---

## T9 — Close out

**Status:** not started
**Depends on:** T8

- Update the `@clerk/clerk-react` consequence in
  `docs/decisions/0002-clerk-identity-local-user-row.md`.
- `git mv` the plan and this task list into `complete/`, updating the
  references in 0002 and in the archived TanStack plan.

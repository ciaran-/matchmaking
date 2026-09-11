# Upgrade to `@clerk/react` (Clerk Core 3)

Replace the deprecated `@clerk/clerk-react` client SDK with `@clerk/react`,
and bring `@clerk/backend` up to date within its current major version, so
the app runs on a single, supported Clerk release line.

High-level plan; the task breakdown comes later.

## Why

- **`@clerk/clerk-react` is deprecated.** npm marks it: *"This package is no
  longer supported. Please use @clerk/react instead."* We are on `5.61.6`.
  Its replacement is `@clerk/react` v6, part of Clerk Core 3.
- **We are running two Clerk cores side by side.** `@clerk/backend@3.2.14`
  is already Core 3 and pulls in `@clerk/shared@4.10.2`, while
  `@clerk/clerk-react@5.61.6` pulls in `@clerk/shared@3.47.5`. After the
  upgrade there should be one copy.
- **This is not a move to `@clerk/tanstack-react-start`.** That was
  considered and rejected:
  `.claude/plans/archived/migrate-to-clerk-tanstack-package.md`.

Reference: Clerk's Core 3 upgrade guide,
<https://clerk.com/docs/guides/development/upgrading/upgrade-guides/core-3>.

## Environment check (already satisfied)

- Node: `@clerk/react@6` needs `>=20.9.0`. We use `24.11.1` (`.nvmrc`, CI).
- React: its peer range includes `~19.2.3`. We have `19.2.5`.
- `ClerkProvider` must sit inside `<body>`, not wrap `<html>`. Ours already
  does (`src/routes/__root.tsx`).

## Scope

### Dependencies

- Replace `@clerk/clerk-react` with `@clerk/react@^6`.
- Bump `@clerk/backend` from `3.2.14` to the latest `3.x`. This is a minor
  bump, but it spans 15 minor releases, and decisions 0004 and 0005 rely
  on its `apiKeys` and M2M token handling.
- Confirm afterwards that `npm ls @clerk/shared` shows a single version.

### Client code — every current `@clerk/clerk-react` import

| File | Uses | Change |
| --- | --- | --- |
| `src/integrations/clerk/provider.tsx` | `ClerkProvider` (`publishableKey`, `afterSignOutUrl`) | Import path only. `afterSignOutUrl` remains a `ClerkProvider` prop in Core 3. |
| `src/integrations/clerk/header-user.tsx` | `SignedIn`, `SignedOut`, `SignInButton`, `UserButton` | **`SignedIn` / `SignedOut` are removed** (confirmed absent from `@clerk/react@6.15.2`) → `<Show when="signed-in">` / `<Show when="signed-out">` |
| `src/components/SignInGate.tsx` | `SignIn`, `useUser`, `appearance.elements` | Import path; visual check (see Risks) |
| `src/components/SignInGate.test.tsx` | `vi.mock('@clerk/clerk-react')` | Mock `@clerk/react` instead |
| `src/components/Header.tsx`, `src/routes/match.tsx` | `useUser` | Import path |
| `src/routes/index.tsx` | `SignInButton`, `useUser` | Import path |
| `src/lib/sync-user.ts` | Comment naming `@clerk/clerk-react` v5 | Update the comment |

The guide lists no breaking changes for `SignIn`, `SignInButton`,
`UserButton` or `useUser`, and all four are still exported. Verify them by
type-checking and in the manual smoke test rather than assuming.

### Appearance (`SignInGate`)

We use `appearance.elements` only. Relevant Core 3 changes:

- `appearance.layout` is renamed to `appearance.options`. We don't use it.
- `colorRing` and `colorModalBackdrop` now render at full opacity instead
  of 15%. This may change the focus ring and the modal backdrop on `/`.
- `showOptionalFields` now defaults to `false`.

### Server code

- `src/lib/auth.ts`, `src/lib/sync-user.ts`, `src/lib/api-keys.ts` and the
  test harness (`src/test/http.ts`) use `@clerk/backend`. The guide gives no
  backend detail beyond renaming `verifySecret` / `verifyAccessToken` /
  `verifyToken` to `verify()`, none of which we call. Rely on type-checking
  plus the unit and HTTP integration suites, which stub `createClerkClient`
  per credential type.
- While touching it: `sync-user.ts` still uses the deprecated `isSignedIn`.
  Switch it to `isAuthenticated`, matching `auth.ts`.

## Approach

1. Branch per the repo convention.
2. Run Clerk's codemod, `npx @clerk/upgrade`, and **review its diff** rather
   than trusting it. It may prompt interactively; if so, run it as
   `! npx @clerk/upgrade` in the session.
3. Change dependencies (`npm uninstall @clerk/clerk-react`,
   `npm install @clerk/react@^6 @clerk/backend@^3`), then check the
   lockfile with `npm ci`.
4. Make any edits from the table above that the codemod missed.
5. Run `npm run check`, `npm run test`, `npm run test:integration` and
   `npm run build`. Then grep the client bundles for server-only markers
   (`@clerk/backend`, `createClerkClient`, `@prisma`) as `CLAUDE.md`
   describes.
6. Manual smoke test against the dev server (needs live Clerk):
   - Signed out, `/`: the styled button opens the sign-in modal. Check the
     backdrop's appearance.
   - Signed out, `/match` and `/league`: the themed `<SignIn />` renders.
     Check the focus ring.
   - Signing in shows the gated content without a reload, and the header
     swaps `SignInButton` for `UserButton`.
   - Signing out returns to `/`.
   - `/settings/api-keys`: minting and revoking a key still work.
   - A real personal API key against `GET /api/v1/leaderboard` returns 200.
7. Check sign-in on a Netlify deploy preview before merging: cookies on a
   deployed domain behave differently from localhost.

## Out of scope

- `@clerk/tanstack-react-start` (archived; see above).
- Clerk's prebuilt `APIKeys` component, new in `@clerk/react` v6. We
  already have `/settings/api-keys`.
- Removing live Clerk from local development — a separate direction.
- Any restyle beyond fixing drift the upgrade causes.

## Risks

- **The codemod may be interactive or incomplete.** The table above is the
  checklist, whatever the codemod reports.
- **Appearance drift** in the themed sign-in, from the focus ring and
  backdrop opacity changes. Cap it at one polish pass.
- **Undocumented behaviour changes** in `SignIn` or `useUser`, which is why
  the manual smoke test is not optional.
- **The `@clerk/backend` minor jump.** Read its changelog for `apiKeys`,
  `authenticateRequest` and M2M changes between `3.2.14` and the target
  version. The ~60 s revocation window (0004) is server-side at Clerk, so an
  SDK bump should not change it.

## When done

- Update the `@clerk/clerk-react` consequence in
  `docs/decisions/0002-clerk-identity-local-user-row.md`.
- Move this plan (and its task list, if any) to `complete/`, updating
  references — 0002 and the archived TanStack plan both cite this path.

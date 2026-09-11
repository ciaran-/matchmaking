# SignInGate Component: Task List

Plan: `.claude/plans/complete/sign-in-gate-component.md` — read this in full before starting any task. The plan is authoritative; this task list is a tactical breakdown.

---

## Dependency graph

```
T0 (pre-flight) ──> T1 (component + tests) ──> T2 (wrap match.tsx)  ─┐
                                          └─> T3 (wrap league.tsx) ─┼─> T5 (visual polish) ──> T6 (verify + PR)
                                          └─> T4 (update index.tsx) ─┘
```

### Parallelism opportunities

- **T2, T3, and T4** can run in parallel once T1 lands. They touch different files. The visual polish in T5 should wait until all three integrations exist, so it can be tuned against real layouts.
- **T1 cannot be parallelised with anything** — T2/T3/T4 all import the component it creates.

### Why this ordering

T1 first because every other task imports it. T5 last because polish is best done against the real, integrated layouts (not against a Storybook-style isolated render).

---

## Pre-flight: T0

**Status:** pending
**Depends on:** nothing
**Blocks:** T1

### Context

Standard baseline: get into a known-good state before touching anything.

### Steps

1. Read `.claude/plans/complete/sign-in-gate-component.md` end-to-end. The plan documents *what* the component does and *why*; this task list is the *how*.
2. Read `CLAUDE.md`, especially the `## Code Style`, `## Testing`, and `## Pre-commit Checklist` sections.
3. Read `src/components/LeagueActivity.tsx` and `src/components/LeagueActivity.test.tsx`. They're the most recent component + test in the repo and the right template for slate/cyan visual language plus the per-file jsdom test environment pattern.
4. Confirm `git status` is clean (`AGENTS.md` may be the only untracked file — leave alone).
5. Confirm on `main`, up to date: `git fetch origin && git checkout main && git pull --ff-only`.
6. Create the working branch: `git checkout -b sign-in-gate-agent-<short-id>` (per CLAUDE.md sub-agent / worktree convention; short-id is 2–3 hex chars).
7. Baseline build: `npm run build` succeeds.

### Acceptance criteria

- On the new branch, clean working tree.
- Baseline build passes.

---

## T1 — Build `<SignInGate>` component + tests

**Status:** pending
**Depends on:** T0
**Blocks:** T2, T3, T4

### Context

The reusable wrapper. Three states (loading / signed-out / signed-in), embedded themed Clerk `<SignIn />` for signed-out, children for signed-in. The component is intentionally minimal — see plan §"Component design" for the locked-in shape.

### Read first

- `src/components/LeagueActivity.tsx` for visual style references (slate/cyan, rounded-xl panel, spinner pattern).
- `src/components/LeagueActivity.test.tsx` for the `// @vitest-environment jsdom` per-file pattern and React Testing Library usage.
- `src/integrations/clerk/header-user.tsx` for an example of `SignInButton` import from `@clerk/clerk-react` (confirms the import path conventions).
- Plan §"Component design" and §"Clerk appearance theming" sections.

### Create

- `src/components/SignInGate.tsx`
- `src/components/SignInGate.test.tsx`

### Implementation

```tsx
// SignInGate.tsx
import { SignIn, useUser } from '@clerk/clerk-react';
import type { Appearance } from '@clerk/types';

interface SignInGateProps {
  children: React.ReactNode;
}

const signInAppearance: Appearance = {
  // Map Clerk element keys to slate/cyan-themed Tailwind utility strings.
  // See Clerk's docs for the full element catalogue:
  // https://clerk.com/docs/customization/appearance-prop/element-classes
  elements: {
    card: 'bg-slate-800/60 border border-slate-700 rounded-xl shadow-lg',
    headerTitle: 'text-slate-100',
    headerSubtitle: 'text-slate-400',
    formButtonPrimary:
      'bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-semibold rounded-lg shadow-md',
    formFieldInput:
      'bg-slate-700 border-slate-500 text-white placeholder:text-slate-400',
    formFieldLabel: 'text-slate-300',
    socialButtonsBlockButton:
      'bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600',
    footerActionLink: 'text-cyan-400 hover:text-cyan-300',
    // ...iterate during T5 visual polish.
  },
};

export function SignInGate({ children }: SignInGateProps) {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-10 h-10 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex justify-center py-8">
        <SignIn appearance={signInAppearance} />
      </div>
    );
  }

  return <>{children}</>;
}
```

Implementation notes:
- The `Appearance` type comes from `@clerk/types`. If TypeScript complains about the import path, the alternative is `import type { ComponentProps } from 'react'` and inferring from `SignIn` itself (`Parameters<typeof SignIn>[0]['appearance']`). Try the direct import first.
- The signed-in branch returns `<>{children}</>` rather than `<div>{children}</div>` — no extra DOM wrapper, so the gate is layout-transparent.
- The element-class mapping above is a first pass. The actual Clerk class names may need tweaks (e.g., `formFieldInput__primary`, `socialButtonsBlockButton__google`); confirm against the rendered DOM during T5.

### Tests

```tsx
// SignInGate.test.tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignInGate } from './SignInGate';

// Mock Clerk's exports so the gate can be tested without Clerk's real
// React context / network / render machinery.
vi.mock('@clerk/clerk-react', () => ({
  useUser: vi.fn(),
  SignIn: () => <div data-testid="mock-clerk-signin">[Clerk SignIn]</div>,
}));

import { useUser } from '@clerk/clerk-react';
const useUserMock = vi.mocked(useUser);

describe('SignInGate', () => {
  it('shows a loading spinner while Clerk is still booting', () => {
    useUserMock.mockReturnValue({ isLoaded: false, isSignedIn: false } as never);
    const { container } = render(
      <SignInGate>
        <div data-testid="children">protected</div>
      </SignInGate>,
    );

    // Spinner: an element with the animate-spin class.
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByTestId('mock-clerk-signin')).toBeNull();
    expect(screen.queryByTestId('children')).toBeNull();
  });

  it('shows the Clerk sign-in form when signed-out', () => {
    useUserMock.mockReturnValue({ isLoaded: true, isSignedIn: false } as never);
    render(
      <SignInGate>
        <div data-testid="children">protected</div>
      </SignInGate>,
    );

    expect(screen.getByTestId('mock-clerk-signin')).toBeDefined();
    expect(screen.queryByTestId('children')).toBeNull();
  });

  it('renders children when signed-in', () => {
    useUserMock.mockReturnValue({ isLoaded: true, isSignedIn: true } as never);
    render(
      <SignInGate>
        <div data-testid="children">protected</div>
      </SignInGate>,
    );

    expect(screen.getByTestId('children')).toBeDefined();
    expect(screen.queryByTestId('mock-clerk-signin')).toBeNull();
  });
});
```

The `as never` cast on the mock return shape is a pragmatic shortcut — `useUser`'s real return type is a discriminated union that requires more fields. The test only needs `isLoaded` and `isSignedIn`. If `as never` reads as too dirty, replace with `as ReturnType<typeof useUser>` and add the minimum fields TypeScript demands.

### Verify

`npm run format && npm run check && npm run test`. All clean.

### Commit

`feat: add SignInGate component`

Body: brief description of the three states, mentions the plan path.

### Acceptance criteria

- `src/components/SignInGate.tsx` exists with the three branches.
- `src/components/SignInGate.test.tsx` has the three test cases, all passing.
- `npm run check` and `npm run test` both clean.
- The visual theme is a first pass — close-enough to slate/cyan; T5 will polish.

---

## T2 — Apply `<SignInGate>` to `match.tsx`

**Status:** pending
**Depends on:** T1
**Blocks:** T6
**Parallel with:** T3, T4

### Context

Replace the early-return shortcut at `match.tsx:580–591` with a `<SignInGate>` wrapping the inner content section. Per the plan, the hero/headline stays visible for everyone; only the phase-dependent UI is gated.

### Read first

- `src/routes/match.tsx` — particularly the `MatchPage` component starting around line 432 and the render block around lines 580–680.
- Plan §"Where the gate sits in the page" — the example shows match.tsx's before/after structure.

### Modify

`src/routes/match.tsx`:

1. Import `SignInGate` from `@/components/SignInGate` at the top of the file.
2. Remove the early-return at `match.tsx:580–591` (`if (!isLoaded) { ... } if (!isSignedIn) { ... }`). Keep `isSignedIn` if other hooks reference it (they do — `pollEnabled` and `leagueActivityQuery.enabled`).
3. Wrap the inner `<section className="max-w-2xl mx-auto px-6 pb-16">` (which contains all the phase-dependent UI) with `<SignInGate>`. The outer `<div className="min-h-screen ...">` and the hero `<section className="py-12 px-6 text-center">` stay outside the gate so they render for everyone.

### Verify

- `npm run check` clean.
- `npm run build` clean.
- `npm run test` clean (component tests still pass).
- Manual smoke (dev server): open `/match` while signed-out — hero shows, gate shows the sign-in form. Sign in — gated content appears. Sign out — gate flips back.

### Commit

`feat: gate /match content with SignInGate`

### Acceptance criteria

- Early-return at the start of `MatchPage`'s render is gone.
- Gated section is wrapped in `<SignInGate>`.
- Hero remains visible regardless of auth state.
- Build clean. Manual smoke confirms signed-out / signed-in behaviour.

---

## T3 — Apply `<SignInGate>` to `league.tsx`

**Status:** pending
**Depends on:** T1
**Blocks:** T6
**Parallel with:** T2, T4

### Context

Same shape as T2 but for the `/league` route. Replace the early-return at `league.tsx:191–202` with a `<SignInGate>` around the inner section.

### Read first

- `src/routes/league.tsx` — particularly the `LeagueTable` component starting around line 190.

### Modify

`src/routes/league.tsx`:

1. Import `SignInGate` at the top.
2. Remove the early-return at `league.tsx:191–202`. Keep `isLoaded` / `isSignedIn` references only if other hooks need them (check — `useUser()` may be removable entirely if no other code reads it).
3. Wrap the inner content section (the gradient hero is line 205 onward; the `RANKINGS` headline is the hero; the table + record-game button live in the section starting around line 225). Gate the section that contains the table + button. The hero stays outside.

### Verify

Same as T2: check, build, test, manual smoke at `/league`.

### Commit

`feat: gate /league content with SignInGate`

### Acceptance criteria

- Early-return is gone.
- Table + record-game button are wrapped in the gate.
- Hero stays visible for everyone.
- Build + manual smoke clean.

---

## T4 — Update `index.tsx` (styled CTA, NOT the gate)

**Status:** pending
**Depends on:** T1 (technically not — this task doesn't use the gate component — but ordering after T1 keeps the conceptual flow tidy)
**Blocks:** T6
**Parallel with:** T2, T3

### Context

The homepage is structurally different. The plan establishes that the marketing hero must stay visible for everyone, and only the CTA changes by auth state. This task swaps the unstyled `<p>Sign in to find a match.</p>` at `index.tsx:34` for a styled gradient button that opens Clerk's modal flow via `<SignInButton mode="modal">`.

This task does NOT use `<SignInGate>`. See plan §"Why index.tsx is different".

### Read first

- `src/routes/index.tsx` — the full file is short (~57 lines).
- Plan §"Why index.tsx is different" — has the exact replacement snippet.

### Modify

`src/routes/index.tsx`:

1. Add `import { SignInButton } from '@clerk/clerk-react';` to the existing Clerk import line (currently only `useUser`).
2. Replace the `{isLoaded && !isSignedIn && (...)}` block at lines 33–35 with:

   ```tsx
   {isLoaded && !isSignedIn && (
     <SignInButton mode="modal">
       <button
         type="button"
         className="inline-block px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 shadow-lg shadow-cyan-500/30 transition-colors"
       >
         Sign in to find a match →
       </button>
     </SignInButton>
   )}
   ```

   The styling intentionally matches the signed-in CTAs further down (`index.tsx:39–50`) so the visual language is consistent.

3. No other change. Loading state, signed-in CTAs, hero — all untouched.

### Verify

- `npm run check` clean.
- `npm run build` clean.
- Manual smoke: open `/` while signed-out — hero + styled CTA button visible. Click → Clerk modal opens. Complete sign-in → modal closes, page reactively re-renders with the signed-in CTAs.

### Commit

`feat: styled sign-in CTA on homepage`

### Acceptance criteria

- Homepage hero unchanged.
- Signed-out state shows the styled button, not the unstyled paragraph.
- Modal flow works end-to-end in manual smoke.
- Build clean.

---

## T5 — Visual polish for the Clerk theme

**Status:** pending
**Depends on:** T1, T2, T3
**Blocks:** T6

### Context

T1 set up an initial Clerk `appearance` theme. T2 and T3 integrated the gate into real pages. T5 is the iteration step: load `/match` and `/league` while signed-out, inspect the rendered `<SignIn />`, and tune the `signInAppearance` constant in `SignInGate.tsx` until it feels coherent with the rest of the site.

Cap the time: aim for "coherent", not "pixel-identical to native Tailwind components". If you're 90 minutes in and still chasing edge cases, ship what you have and file the rest as a follow-up.

### Read first

- The current `signInAppearance` constant in `src/components/SignInGate.tsx`.
- Clerk's appearance docs (use the version matching `package.json` to find current element class names): https://clerk.com/docs/customization/appearance-prop/element-classes

### What to look at

In the dev server (`npm run dev`), navigate to `/match` while signed-out and inspect:

1. **The card.** Background, border, rounded corners, padding — do they match the slate-800/60 + slate-700 border + rounded-xl style used elsewhere?
2. **The primary button** ("Sign in"). Does it use the cyan → blue gradient? Hover state right?
3. **The inputs.** Slate background, white text, slate-400 placeholder?
4. **Labels.** Slate-300?
5. **The "Don't have an account? Sign up" link.** Cyan-400 with a hover state?
6. **Social buttons** (if Clerk is configured with any). Match the rest of the panel?
7. **Spacing.** Is the form too cramped or too sprawling against the page chrome?

### Approach

For each element that looks off:

1. Inspect the DOM in DevTools to find Clerk's actual element class (e.g. `cl-formButtonPrimary`).
2. Strip the `cl-` prefix to get the Clerk element key (e.g. `formButtonPrimary`).
3. Add or update the entry in `signInAppearance.elements` with the desired Tailwind classes.
4. Hot reload and re-check.

If an element resists styling cleanly via the `elements` map (rare), the `variables` and `layout` slots in the appearance object can also help.

### Verify

- All three pages (`/`, `/match`, `/league`) look coherent.
- `npm run check` clean (no stray TypeScript errors from typo'd element keys — Clerk types them).
- `npm run build` clean.

### Commit

`style: polish Clerk SignIn appearance to match site palette`

### Acceptance criteria

- The Clerk form looks like it belongs on the site (slate panel, cyan-blue button, etc.).
- `signInAppearance` is updated with whichever element keys needed tweaks.
- The bar is "good enough" — file remaining edge cases as follow-ups, don't grind.

---

## T6 — Final verification + PR

**Status:** pending
**Depends on:** T2, T3, T4, T5
**Blocks:** nothing (merge)

### Pre-PR checklist (run in order)

1. `npm run format` — clean.
2. `npm run check` — clean.
3. `npm run build` — clean.
4. `npm run test` — clean (the new SignInGate tests included).
5. `npm run test:integration` — clean (nothing in this PR touches the DB, but worth confirming nothing regressed).

### Manual smoke (a fresh `npm run dev`)

For each scenario, observe the visual behaviour AND watch the network tab for surprises:

1. **Signed-out → `/`** — hero visible; CTA is the new gradient button; click opens Clerk modal; complete sign-in; modal closes; page now shows signed-in CTAs without a reload.
2. **Signed-out → `/match`** — hero visible; gate renders themed `<SignIn />` below; complete sign-in; gate flips to gated content; matchmaking poll fires.
3. **Signed-out → `/league`** — hero visible; gate renders themed `<SignIn />` below; complete sign-in; table appears.
4. **Sign out from the header** while on `/match` — gate flips back to the sign-in form; no reload; no console errors.
5. **Sign out from the header** while on `/league` — same as above.

### PR

Title: `feat: styled SignInGate component replaces unstyled sign-in fallbacks`

Body should include:

- One-paragraph summary: the three unstyled fallbacks are gone, replaced with a shared `<SignInGate>` for the fully-gated pages and a styled CTA button on the marketing hero.
- Reference to the plan: `.claude/plans/complete/sign-in-gate-component.md`.
- Commit list (T1–T5; T0/T6 are not commits).
- Test plan (the checklist + manual smoke scenarios from this task).
- Open follow-ups verbatim from the plan's §"Open follow-ups" section.

### Acceptance criteria

- All checklist steps pass.
- All five manual smoke scenarios behave correctly.
- PR opened with the right title, body, and follow-ups.
- No remaining `'Sign in to view this page'` or `'Sign in to find a match.'` plain-text fallbacks in `src/routes/`.

---

## Out of scope (do not bundle into this PR)

These were considered and explicitly left out:

- **Header `<SignInButton />` style.** Currently uses Clerk's default. Touch up separately for visual cohesion with the new gate's button. The header's role is different (always-visible sign-in affordance on non-gated pages), so the decision about its visual is independent.
- **Account / profile UX.** Sign-out is already in the header; profile editing is not currently exposed. Not part of this work.
- **Loader gating on `/league`.** `getLeaguePlaces()` runs server-side regardless of auth, so its result is discarded for signed-out users. Cost is acceptable now; if it becomes meaningful, gate the loader. Different concern.
- **Component test infrastructure refactor.** The per-file `// @vitest-environment jsdom` is a workable pattern. Don't flip the global config in this PR.

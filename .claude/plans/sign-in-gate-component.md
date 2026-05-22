# SignInGate Component

## Background

Three routes currently display unstyled fallback text when the user is signed out:

- `src/routes/index.tsx:34` — `<p className="text-gray-300">Sign in to find a match.</p>`
- `src/routes/league.tsx:201` — `<div className="p-4">Sign in to view this page</div>`
- `src/routes/match.tsx:591` — `<div className="p-4 text-white">Sign in to find a match.</div>`

These fallbacks short-circuit the rest of the page render and produce a jarring, off-brand experience — visitors hit a beautifully styled page only to land on an unstyled paragraph the moment auth is required. The header already exposes a Clerk `<SignInButton />` in modal mode, but it's a small chip in the top bar and not always discoverable as the next step.

This work introduces a `<SignInGate>` component that renders an embedded, themed Clerk `<SignIn />` form in place of the gated content when the user is signed-out, and renders the gated content when they're signed-in. The homepage (`index.tsx`) is treated as a special case — its hero copy still renders for everyone; only the call-to-action is gated.

## Scope

In scope:

- New component `src/components/SignInGate.tsx`.
- Component test `src/components/SignInGate.test.tsx`.
- Apply the gate to `src/routes/league.tsx` and `src/routes/match.tsx` — both pages are fully gated; the gate replaces the inner content section while preserving the page chrome (gradient background, headline).
- Update `src/routes/index.tsx` — the marketing hero stays visible for everyone; replace the unstyled `<p>` with a prominent styled button that triggers Clerk's existing modal sign-in flow (`<SignInButton mode="modal">` from `@clerk/clerk-react`).

Out of scope:

- The header's existing `<SignInButton />` in `src/integrations/clerk/header-user.tsx`. Different context (a signed-out user on a non-gated page should still see a sign-in affordance in the header). Worth a styling pass to match the new gate's button — file as a follow-up, do not bundle.
- Sign-out UX, account management, profile editing. Clerk handles all of these via existing components and they're not in this scope.
- Broader polish of the index.tsx hero (gradients, CTAs for signed-in users, etc.). Only the signed-out CTA changes here.

## Decisions (already locked in)

These were confirmed via clarification questions before this plan was written. Listed here so the implementer doesn't re-litigate:

1. **Shape:** A reusable `<SignInGate>{children}</SignInGate>` wrapper. Not per-route components.
2. **Sign-in UX:** Embedded Clerk `<SignIn />` inline, themed to the slate/cyan palette. Not a modal-trigger button on gated pages.
3. **Sign-up:** Enabled via Clerk's default "Don't have an account? Sign up" link inside `<SignIn />`. Smoothest path for first-time visitors.
4. **Homepage:** Keep the marketing hero. Replace the unstyled signed-out paragraph with a prominent gradient button that opens Clerk's modal flow. **The homepage does NOT use `<SignInGate>`** — see "Why index.tsx is different" below.

## Component design

### Props

```ts
interface SignInGateProps {
  children: React.ReactNode;
}
```

Intentionally minimal. No `title`, no `description`, no `appearance` overrides in v1. If a caller wants different copy or theming, that's a v2 concern — over-parameterising before a real need leaks the abstraction.

### Three states (driven by `useUser()` from `@clerk/clerk-react`)

| Clerk state                  | Render                                                                                                            |
|------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `!isLoaded`                  | Styled loading state — a centred spinner matching the existing match.tsx pattern (cyan-400 ring with transparent top), inside the gate's content area. |
| `isLoaded && !isSignedIn`    | The themed `<SignIn />` component from `@clerk/clerk-react`. Centred. Sign-up link visible (Clerk default).        |
| `isLoaded && isSignedIn`     | `children` — passed straight through with no extra wrappers.                                                       |

The transition from `!isSignedIn` → `isSignedIn` happens automatically via Clerk's reactive `useUser()` context; the gate re-renders and the children appear. No `router.invalidate()` needed for current consumers:

- `match.tsx` already gates `useQuery` polling on `isSignedIn === true`, so the queries fire as soon as the gate flips.
- `league.tsx`'s `Route.useLoaderData()` is server-side and already populated when the route loaded — fine for signed-out users to "use" later.

### Where the gate sits in the page

The gate sits **inside the page chrome**, not as a top-level wrapper around the entire page. Both `match.tsx` and `league.tsx` have a `<div className="min-h-screen ...">` outer container with a hero/headline section and a content `<section>`. The gate wraps the content section only — the hero stays visible for everyone, so the user knows what they're signing in to.

Example (match.tsx today):

```tsx
return (
  <div className="min-h-screen bg-gradient-to-b ...">
    <section className="py-12 px-6 text-center">
      {/* MATCHMAKING headline + phase label */}
    </section>

    <section className="max-w-2xl mx-auto px-6 pb-16">
      {/* phase-dependent UI, all gated on isSignedIn */}
    </section>
  </div>
);
```

After:

```tsx
return (
  <div className="min-h-screen bg-gradient-to-b ...">
    <section className="py-12 px-6 text-center">
      {/* MATCHMAKING headline (no phase label until signed in) */}
    </section>

    <section className="max-w-2xl mx-auto px-6 pb-16">
      <SignInGate>
        {/* phase-dependent UI as before */}
      </SignInGate>
    </section>
  </div>
);
```

Implementer note: the existing `isLoaded`/`isSignedIn` early-return at `match.tsx:580–584` and `league.tsx:191–202` is what gets removed. The hooks that depend on auth (`useQuery({ enabled: isSignedIn })`, etc.) are unchanged — they just naturally do nothing while the gate is showing the sign-in form.

### Clerk appearance theming

Clerk's `<SignIn />` accepts an `appearance` prop that lets us override element-level styling. The mapping for slate/cyan is roughly:

- `card` → slate translucent panel matching `bg-slate-800/60 border border-slate-700 rounded-xl`.
- `headerTitle` / `headerSubtitle` → slate-200 / slate-400.
- `formButtonPrimary` → gradient `from-cyan-500 to-blue-500`, white text, rounded-lg.
- `formFieldInput` → `bg-slate-700`, `border-slate-500`, white text.
- `formFieldLabel` → slate-300.
- `socialButtonsBlockButton` → slate-700 background, slate-200 text.
- `footerActionLink` (the "Sign up" link) → cyan-400.

Define the theme as a `const` inside `SignInGate.tsx`. If it grows or starts being reused elsewhere, extract to `src/components/clerk-appearance.ts`.

**This is the most uncertain part of the work.** Clerk's appearance API can be fiddly, and the element class names occasionally change between versions. The right bar is "looks coherent with the rest of the site", not "pixel-identical to native Tailwind components". If it's eating disproportionate time, ship a "good enough" pass and file a polish follow-up.

### Why `index.tsx` is different

`index.tsx` is a marketing landing page — the gradient hero, the "MATCHMAKING" headline, and the subtitle render for everyone. Only the bottom CTA differs by auth state. Wrapping the whole page in `<SignInGate>` would replace the hero with the embedded sign-in form, which would be jarring (the user just landed on the site — they haven't expressed intent yet).

Instead, replace the unstyled `<p>` at `index.tsx:34` with a styled button that opens Clerk's modal sign-in flow:

```tsx
import { SignInButton } from '@clerk/clerk-react';

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

The button visual reuses the same gradient-button style already used for the signed-in CTAs further down the page (`index.tsx:39–50`). Modal mode keeps the user on the landing page; sign-in happens in a Clerk-hosted overlay; on success Clerk reactively updates `useUser()` and the page re-renders with the signed-in CTAs.

## Testing

### Unit (`SignInGate.test.tsx`)

Use `@vitest-environment jsdom` (matches `LeagueActivity.test.tsx`). Mock `@clerk/clerk-react` so `useUser()` returns controllable state and `<SignIn />` renders a stub.

Cases:

1. `!isLoaded` → renders a loading indicator, does NOT render children, does NOT render the sign-in stub.
2. `isLoaded && !isSignedIn` → renders the sign-in stub, does NOT render children.
3. `isLoaded && isSignedIn` → renders children, does NOT render the sign-in stub or loading indicator.

The sign-in stub assertion is intentionally minimal — we're testing the gate's branching logic, not Clerk's component. The mock should produce something with a stable test-id like `<div data-testid="mock-clerk-signin">` so the test can query for it.

### Manual smoke

After all changes:

- `/match` while signed-out: hero shows, gate shows the sign-in form below.
- `/league` while signed-out: hero shows, gate shows the sign-in form below.
- `/` while signed-out: hero + styled CTA button. Click → Clerk modal opens.
- Sign in via any of the above → page re-renders with the gated content visible. No reload required.
- Sign out (from header) → gate flips back to the sign-in form without a reload.

## Open follow-ups (track separately, do not bundle)

- **Header SignInButton style.** Currently uses Clerk's default look. Touch up to match the new gate's button style for visual cohesion across the app.
- **Loader timing on `/league`.** `getLeaguePlaces()` runs server-side regardless of auth. For signed-out users that data is discarded by the gate. Cost is fine today; if it becomes meaningful, gate the loader on the request's auth state.
- **`index.tsx` polish.** The current hero is fine but minimal. Separate from this work.
- **Component test infrastructure.** If we end up writing many more component tests, consider flipping the global vitest config to jsdom and opting node tests in (instead of `// @vitest-environment jsdom` per file). Same call as noted in the LeagueActivity component PR — defer until the count grows.

## Risks

1. **Clerk appearance API time-sink.** Already mentioned above. Cap iteration at a couple of passes; ship "good enough" and follow up if needed.
2. **Page chrome consistency.** The gate sits inside each page, so each integration needs to think about where exactly the gate lives in the layout. Easy to get a small alignment / spacing bug. Verify visually in the dev server before merging.
3. **Modal collision.** Clerk's modal renders at a high z-index. Should not collide with anything in the existing pages, but verify on `/` after changing the CTA button.

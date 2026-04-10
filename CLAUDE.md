# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Start dev server on port 3000 (with Sentry instrumentation)
npm run build        # Build for production
npm run start        # Start production server

# Code quality
npm run lint         # Biome linter
npm run format       # Biome formatter
npm run check        # Biome lint + format check

# Testing
npm run test         # Run all tests with Vitest
npx vitest run src/some/file.test.ts  # Run a single test file

# Database (all use .env.local)
npm run db:generate  # Generate Prisma client after schema changes
npm run db:migrate   # Create and apply a new migration
npm run db:push      # Push schema changes without a migration (dev only)
npm run db:studio    # Open Prisma Studio GUI
npm run db:seed      # Seed the database with test data
npm run db:reset     # Reset and re-run all migrations
```

## Architecture

**TanStack Start** full-stack app (React meta-framework with SSR). Routes live in `src/routes/` and use file-based routing with TanStack Router — the `routeTree.gen.ts` file is auto-generated and should not be edited manually.

**Data flow**: Client → server functions (`createServerFn`) → Prisma → PostgreSQL. There is no REST API for the moment but it's planned; currently all client-server communication goes through typed server functions co-located in route files. The rest API and frontend-facing server functions should share core logic, with any usage-specific data translation located outside the shared core functionality.

**Authentication**: Clerk. `ClerkProvider` wraps the app in `__root.tsx`. Use `useUser()` to get `isSignedIn`/`isLoaded`. Protected routes check auth before rendering (see `src/routes/league.tsx`).

**Database**: PostgreSQL via Prisma. The singleton client is in `src/db.ts`. Schema has three models: `User` (with `currentRating` for Elo), `GameResult` (with `GameMode` enum: `ONE_VS_ONE` | `TEAM_VS_TEAM`), and `GameParticipant` (join table tracking `ratingBefore`/`ratingAfter`/`ratingChange`).

**Styling**: Tailwind CSS. Biome handles linting and formatting (tabs for indentation, single quotes).

**Deployment**: Netlify (`netlify.toml`).

## Sentry Instrumentation

Wrap server function implementations with `Sentry.startSpan` for performance monitoring:

```tsx
import * as Sentry from "@sentry/tanstackstart-react";

const myFn = createServerFn({ method: "GET" }).handler(async () => {
  return Sentry.startSpan({ name: "Description of operation" }, async () => {
    // server-side logic here
  });
});
```

Error collection is automatic via `src/router.tsx` — no manual setup needed for errors.

## Path Aliases

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

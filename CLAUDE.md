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

Migrations are run via the Prisma MCP server (see below) — this handles the interactive TTY requirement automatically.

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

## Testing

Tests are written with Vitest and live alongside their source file (`foo.test.ts` next to `foo.ts`).

Every new function in `src/lib/` must have a corresponding test file. This is the primary place business logic lives and it must be covered.

Server functions in route files are harder to unit test in isolation — test the underlying `src/lib/` functions they call instead. The route-level wiring is verified manually.

For server-only modules (anything that uses Node APIs, Prisma, or TanStack Start server utilities), add `// @vitest-environment node` at the top of the test file to avoid jsdom overhead.

When mocking with `vi.mock()`, mock at the module boundary — mock `@/db` to stub Prisma, mock the Clerk SDK package to stub auth, and mock `@tanstack/react-start/server` to stub request/response utilities.

## Prisma MCP Server

The Prisma MCP server is configured for this project and gives Claude Code direct access to `migrate-dev`, `migrate-reset`, and `migrate-status` without needing an interactive terminal.

`.mcp.json` is in `.gitignore` — **do not commit it**. It contains a local `DATABASE_URL`. Each developer (and Claude Code instance) needs their own copy. To set it up:

```bash
claude mcp add --scope project prisma -- npx -y prisma@latest mcp
```

Then add your local `DATABASE_URL` to the `env` block in the generated `.mcp.json`.

## Path Aliases

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

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
npm run test                 # Run unit tests with Vitest
npm run test:integration     # Run integration tests (requires Docker)
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

## Pre-commit Checklist

Run these in order before every commit:

```bash
npm run format   # Biome formatter — prevents follow-up formatting-only commits
npm run build    # Catches Vite client/server bundle errors invisible in dev mode
```

If `package-lock.json` was regenerated (merge conflict, dependency update), also run:

```bash
npm ci           # Strict lockfile check — npm install is too lenient and silently accepts mismatches
```

## Architecture

**TanStack Start** full-stack app (React meta-framework with SSR). Routes live in `src/routes/` and use file-based routing with TanStack Router — the `routeTree.gen.ts` file is auto-generated and should not be edited manually.

**Data flow**: Client → server functions (`createServerFn`) → Prisma → PostgreSQL. There is no REST API for the moment but it's planned; currently all client-server communication goes through typed server functions co-located in route files. The REST API and frontend-facing server functions should share core logic, with any usage-specific data translation located outside the shared core functionality.

**Authentication**: Clerk. `ClerkProvider` wraps the app in `__root.tsx`. Use `useUser()` to get `isSignedIn`/`isLoaded`. Protected routes check auth before rendering (see `src/routes/league.tsx`).

**Database**: PostgreSQL via Prisma. The singleton client is in `src/db.ts`. Schema has three models: `User` (with `currentRating` for Elo), `GameResult` (with `GameMode` enum: `ONE_VS_ONE` | `TEAM_VS_TEAM`), and `GameParticipant` (join table tracking `ratingBefore`/`ratingAfter`/`ratingChange`).

**Styling**: Tailwind CSS. Biome handles linting and formatting (tabs for indentation, single quotes).

**Deployment**: Netlify (`netlify.toml`).

## Code Style

Prefer `.map()`, `.filter()`, `.reduce()` over `for` loops when transforming arrays. Imperative loops are acceptable only when the iteration is genuinely stateful and array methods would be forced.

## `createServerFn` Pattern

Server-only modules (anything importing from `@tanstack/react-start/server`, Prisma, `@clerk/backend`, or other Node-only packages) must **never** be statically imported in route files. Always wrap them in `createServerFn` with a dynamic import inside the handler.

```ts
const myFn = createServerFn({ method: "POST" }).handler(async () => {
  const { myServerModule } = await import("../lib/my-server-module");
  return myServerModule();
});
```

Use `method: 'POST'` for any handler with side effects (DB writes, auth checks with cookie sets). Use `method: 'GET'` only for pure reads — GET functions can be triggered by router preloading.

**Why**: Vite follows static imports at build time. A static import of a server-only module in a route file pulls it into the client bundle, causing `"Readable" is not exported by "__vite-browser-external"` errors. The dev server never catches this — it only surfaces during `vite build`.

### Clerk auth guard (in server functions)

```ts
const secretKey = process.env.CLERK_SECRET_KEY;
const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!secretKey || !publishableKey) throw new Error("Missing Clerk env vars");

const { createClerkClient } = await import("@clerk/backend");
const { getRequest } = await import("@tanstack/react-start/server");
const clerk = createClerkClient({ secretKey, publishableKey });
const auth = await clerk.authenticateRequest(getRequest());
if (!auth.isSignedIn) throw new Error("Unauthorized");
```

`@clerk/backend`'s `authenticateRequest` requires **both** `secretKey` and `publishableKey` passed explicitly — the backend SDK does not pick them up automatically.

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

### Unit tests

Tests live alongside their source file (`foo.test.ts` next to `foo.ts`).

Every new function in `src/lib/` must have a corresponding test file. This is the primary place business logic lives and must be covered.

Server functions in route files are harder to unit test in isolation — test the underlying `src/lib/` functions they call instead. The route-level wiring is verified manually.

For server-only modules (anything that uses Node APIs, Prisma, or TanStack Start server utilities), add `// @vitest-environment node` at the top of the test file.

When mocking with `vi.mock()`, mock at the module boundary — mock `@/db` to stub Prisma, mock the Clerk SDK package to stub auth, and mock `@tanstack/react-start/server` to stub request/response utilities.

Any `process.env` guard added to production code (i.e. `if (!process.env.FOO) throw`) must have a corresponding stub in the relevant test file's `beforeEach`:

```ts
beforeEach(() => {
  process.env.FOO = "test_value";
});
```

Forgetting this causes tests to pass locally (where the real env var exists) but fail in CI.

### Integration tests

Integration tests use testcontainers to run against a real PostgreSQL instance. They live in `*.integration.test.ts` files and are run separately from unit tests.

**Infrastructure** (`src/test/`):

- `src/test/db.ts` — spins up a Postgres container, applies migrations, exports `withRollback(prisma, fn)` that wraps each test in a rolled-back transaction for isolation
- `src/test/factories/user.ts` — `createUser(prisma, overrides?)`
- `src/test/factories/game-result.ts` — `createGameResult(prisma, overrides?)` including participants
- `src/test/scenarios.ts` — composable named setups (e.g. `twoEqualRatedPlayers`)

Lifecycle: one container per test file (`beforeAll`/`afterAll`), one rolled-back transaction per test (`beforeEach`/`afterEach` via `withRollback`).

Config: `vitest.integration.config.ts` — uses `--pool=forks` (testcontainers requires a real process, not threads). CI runs on `ubuntu-latest` which ships with Docker.

Future HTTP-level tests (once the REST API exists) should reuse the same `src/test/db.ts` setup and factories — no new DB infrastructure needed.

## TanStack Start Quirks

**Error shape on the client**: Thrown `Error` instances may arrive as `{ message: string }` plain objects, not `Error` instances. Use `(e as { message?: string }).message` in catch blocks.

**Loader invalidation**: After a mutation, call `router.invalidate()` to trigger a client-side re-execution of the loader without a full page reload. Works correctly when the route has `ssr: 'data-only'`.

**`import.meta.env.VITE_*` in server functions**: These variables are baked into the client bundle at build time but are not available as `import.meta.env` inside server-side code at runtime. Use `process.env.VITE_*` for server-side access — the variable just needs to be set in Netlify's environment.

## Netlify Production Checklist

Before merging any feature that touches server-side code or the build pipeline:

- `netlify.toml` must invoke `npm run build`, not a tool directly (e.g. `vite build`). Running the tool directly bypasses `package.json` and silently skips steps like `prisma generate`.
- `prisma generate` must run at build time — missing it causes `PrismaClientValidationError: Unknown argument` at runtime when new schema fields are added.
- Run `prisma migrate deploy` against the production DB **before** deploying code that depends on new columns.

## Plans and Tasks

Store plans in `.claude/plans/<readable-kebab-case-name>.md` within the repo. Do not create `PLAN.md` at the root.

Store task lists in `.claude/tasks/<readable-kebab-case-name>-tasks.md`.

**Plan approval ≠ implementation go-ahead.** When a plan is approved via `ExitPlanMode`, that means the plan document is accepted. Wait for an explicit instruction ("implement it", "go ahead") before writing any code.

## Scope Discipline

When asked to write a plan or task list, limit exploration to what's directly needed - avoid over-exploring the codebase before producing the deliverable

Prefer the simplest solution (e.g., static markup over JS-driven components) unless complexity is explicitly requested or required to address a need

## Sub-agent and Worktree Delegation

When spawning agents with `isolation: "worktree"` or creating branches manually, use the pattern:

```
<feature-or-task-slug>-agent-<short-id>
```

Example: `record-game-agent-f3`, not `worktree-agent-ae8476f8eda7fdb26`. Bare agent IDs are opaque in `git branch` output.

## Prisma MCP Server

The Prisma MCP server is configured for this project and gives Claude Code direct access to `migrate-dev`, `migrate-reset`, and `migrate-status` without needing an interactive terminal.

`.mcp.json` is in `.gitignore` — **do not commit it**. It contains a local `DATABASE_URL`. Each developer (and Claude Code instance) needs their own copy. To set it up:

```bash
claude mcp add --scope project prisma -- npx -y prisma@latest mcp
```

Then add your local `DATABASE_URL` to the `env` block in the generated `.mcp.json`.

## Path Aliases

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

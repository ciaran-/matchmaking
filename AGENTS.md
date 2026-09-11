# AGENTS.md

Codex-facing guidance for working in this repository. This is adapted from
`CLAUDE.md` and `.cursorrules`; keep those files in sync when project
conventions change.

## Commands

```bash
# Development
npm run dev          # Start dev server on port 3000
npm run build        # Generate Prisma client, then build for production
npm run serve        # Start Vite preview server

# Code quality
npm run lint         # Biome linter
npm run lint:fix     # Biome lint fixes
npm run format       # Biome formatter
npm run check        # Biome lint + format check

# Testing
npm run test                 # Unit tests with Vitest
npm run test:integration     # Integration tests; requires Docker
npx vitest run src/file.test.ts

# Database; all use .env.local
npm run db:generate
npm run db:migrate
npm run db:push      # Dev only; no migration file
npm run db:studio
npm run db:seed
npm run db:reset
```

Before any commit, run:

```bash
npm run format
npm run build
```

If `package-lock.json` changed because of dependency work or conflict
resolution, also run `npm ci` to verify the lockfile strictly.

## Architecture

- This is a TanStack Start full-stack app with SSR.
- Routes live in `src/routes/` and use TanStack Router file-based routing.
- Do not edit `src/routeTree.gen.ts` manually.
- Data flow is client -> `createServerFn` server functions -> Prisma ->
  PostgreSQL.
- There is no REST API yet. When one is added, REST handlers and existing
  server functions should share core logic, with route/API translation outside
  shared business code.
- Authentication is Clerk. `ClerkProvider` is mounted in `src/routes/__root.tsx`;
  route components use `useUser()` for `isSignedIn` and `isLoaded`.
- Database access goes through Prisma. The singleton client is `src/db.ts`.
- Styling is Tailwind CSS.
- Formatting and linting use Biome with tabs and single quotes.
- Deployment is Netlify via `netlify.toml`.
- `@/*` maps to `./src/*`.

## Code Style

- Prefer `.map()`, `.filter()`, and `.reduce()` for array transformations.
- Use imperative loops only when iteration is genuinely stateful or clearer.
- Keep business logic in `src/lib/` where it can be tested directly.
- Keep route-level code focused on UI, server function wiring, auth, validation,
  and data translation.

## `createServerFn` Pattern

Server-only modules must not be statically imported by route files. This
includes modules importing Prisma, `@tanstack/react-start/server`,
`@clerk/backend`, Node-only APIs, or other server-only packages.

Use a dynamic import inside the `createServerFn` handler:

```ts
const myFn = createServerFn({ method: 'POST' }).handler(async () => {
	const { myServerModule } = await import('../lib/my-server-module');
	return myServerModule();
});
```

- Use `method: 'POST'` for side effects, including DB writes and auth checks
  that may set cookies.
- Use `method: 'GET'` only for pure reads. GET server functions can be invoked
  by router preloading.
- This rule matters because Vite follows static imports at build time. Static
  server-only imports in route files can leak into the browser bundle and fail
  only during `vite build`.

### Clerk auth guard in server functions

Use `process.env` inside server functions, not `import.meta.env`, for runtime
server-side access.

```ts
const secretKey = process.env.CLERK_SECRET_KEY;
const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!secretKey || !publishableKey) throw new Error('Missing Clerk env vars');

const { createClerkClient } = await import('@clerk/backend');
const { getRequest } = await import('@tanstack/react-start/server');
const clerk = createClerkClient({ secretKey, publishableKey });
const auth = await clerk.authenticateRequest(getRequest());
if (!auth.isSignedIn) throw new Error('Unauthorized');
```

`@clerk/backend` requires both `secretKey` and `publishableKey` explicitly.

## Sentry

Error collection is already configured in `src/router.tsx`.

Instrument server function implementations and other meaningful server-side
operations with `Sentry.startSpan`:

```ts
import * as Sentry from '@sentry/tanstackstart-react';

const myFn = createServerFn({ method: 'GET' }).handler(async () => {
	return Sentry.startSpan({ name: 'Description of operation' }, async () => {
		return doServerWork();
	});
});
```

## Testing

### Unit tests

- Tests live next to the source file, for example `foo.test.ts` next to
  `foo.ts`.
- Every new function in `src/lib/` needs a corresponding test file.
- Test the underlying `src/lib/` business logic rather than route-level
  `createServerFn` wiring when possible.
- Server-only tests that use Node APIs, Prisma, or TanStack Start server
  utilities need `// @vitest-environment node` at the top.
- Mock at module boundaries with `vi.mock()`: mock `@/db` for Prisma,
  `@clerk/backend` for Clerk, and `@tanstack/react-start/server` for request
  utilities.
- If production code guards on `process.env.FOO`, tests should set that env var
  in `beforeEach` so CI does not depend on local machine state.

### Integration tests

- Integration tests are named `*.integration.test.ts` and run with
  `npm run test:integration`.
- They use testcontainers with real PostgreSQL, so Docker must be running.
- Reuse the existing infrastructure in `src/test/`:
  - `src/test/db.ts` for container setup, migrations, and `withRollback`.
  - `src/test/factories/user.ts`.
  - `src/test/factories/game-result.ts`.
  - `src/test/scenarios.ts`.
- Lifecycle is one container per test file and one rolled-back transaction per
  test.

## TanStack Start Quirks

- Client-side caught errors may be plain `{ message: string }` objects rather
  than `Error` instances. Read messages defensively with
  `(e as { message?: string }).message`.
- After mutations, call `router.invalidate()` to refresh loader data without a
  full page reload. This works with routes using `ssr: 'data-only'`.
- `import.meta.env.VITE_*` is baked into the client bundle and is not available
  as runtime server-side env inside server functions. Use `process.env.VITE_*`
  on the server.

## Netlify and Prisma

Before merging server-side or build-pipeline changes:

- `netlify.toml` should invoke `npm run build`, not `vite build` directly.
- `prisma generate` must run at build time; this is included in
  `npm run build`.
- Run `prisma migrate deploy` against production before deploying code that
  depends on new columns.

The local `.mcp.json` is intentionally ignored because it can contain a local
`DATABASE_URL`. Do not commit it.

## Planning and Scope

- Store implementation plans in `.claude/plans/<readable-kebab-case-name>.md`.
- Store task lists in `.claude/tasks/<readable-kebab-case-name>-tasks.md`.
- The top level of `.claude/plans/` and `.claude/tasks/` holds only upcoming
  or in-progress work. When work leaves that state, `git mv` the plan and its
  task list and update any path references:
  - `complete/` — actioned and implemented (merged to `main`).
  - `archived/` — moved on without doing it; add a note at the top saying
    why and what replaced it.
- Decisions that constrain work beyond one feature are recorded in
  `docs/decisions/` (see its README) as part of completing that work. Code
  and docs cite decision records or `docs/api-conventions.md`, not plans.
  Supersede a decision with a new record; don't edit the old one to reverse
  it.
- Do not create root-level `PLAN.md` files.
- If asked only to write a plan or task list, limit exploration to what is
  directly needed for that deliverable.
- Prefer the simplest solution that satisfies the feature unless extra
  complexity is explicitly required.

## Delegation and Branch Names

When creating worktrees, branches, or delegated agent work for a feature, use:

```text
<feature-or-task-slug>-agent-<short-id>
```

Example: `record-game-agent-f3`.

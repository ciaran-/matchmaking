# Matchmaking

Internal 1v1 matchmaking with Elo ratings, built on TanStack Start.

## Getting started

See [`CLAUDE.md`](./CLAUDE.md) for development commands, architecture, the
`createServerFn` pattern, testing setup, and deployment notes. The same
file is the source of truth for repo conventions.

## Environment variables

Create a `.env.local` with the following keys (values are provisioned per
developer — ask another contributor or check the deployment dashboard):

- `DATABASE_URL` — PostgreSQL connection string used by Prisma.
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk frontend key.
- `CLERK_SECRET_KEY` — Clerk backend key (server-only).
- `VITE_SENTRY_DSN` — Sentry DSN for error and performance reporting.

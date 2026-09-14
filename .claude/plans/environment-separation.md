# Separating Environments from Production — Feature Plan

Production, preview and local each get their own database, migrations stop
reaching production from a pull request, and preview and local are refilled
from anonymised production copies.

Roadmap item R1 (`.claude/plans/roadmap.md`). High-level plan; the task
breakdown comes after the open questions below are settled.

## Context

Three facts, all verified in the repo:

- **`netlify.toml` runs migrations in every build context.** The build
  command is `npx prisma migrate deploy && npm run build`, and the file has
  no `[context.*]` blocks. Whatever `DATABASE_URL` a build sees, it
  migrates.
- **Deploy previews use the production database.** So a pull request
  containing a migration applies it to production when its preview builds,
  before review or merge. A destructive migration does not wait for anyone.
- **Local is the only place migrations are authored.** `npm run db:migrate`
  runs `prisma migrate dev` against the database in `.env.local`. Nothing
  runs between there and production.

Supporting detail:

- `schema.prisma`, `migrations/` and `seed.ts` all live at the repo root.
- Seeding is `prisma db seed` → `ts-node seed.ts`, hand-written data that
  drifts from real shapes.
- CI (`.github/workflows/ci.yml`) has four jobs — test, lint, build,
  integration-test — and none of them touch a database except the
  testcontainers integration suite.
- All environments share one Clerk dev instance today. That stays true
  after this work; see Non-goals.

## Goal

- A pull request cannot change the production schema.
- Every migration runs against production-shaped data before production.
- Preview holds a recent, anonymised copy of production and is disposable.
- A developer can refill local from the same copy on demand.

## Scope

### R1a — Preview gets its own database

- Provision a preview database. **Recommendation: a separate RDS instance**,
  not a second database on the production instance. The point of the work
  is blast radius, and a shared instance still shares CPU, memory and
  connections with production.
- Scope `DATABASE_URL` per Netlify context: production, deploy-preview and
  branch-deploy. This is the fix that matters — with the variable scoped,
  the existing build command migrates whichever database that context owns.
- Optionally add explicit `[context.deploy-preview]` / `[context.production]`
  blocks to `netlify.toml`. They change no behaviour once the variable is
  scoped, but they make the intent readable in the repo instead of only in
  the Netlify UI.
- Verify with `netlify env:list --context deploy-preview` before and after,
  and by opening a throwaway pull request with a trivial migration and
  confirming production is untouched.

**Ships:** a pull request can no longer reach the production schema.

### R1b — A migration path with a step in the middle

- Production migrations run only from a production-context deploy of `main`.
- Add a CI job that proves the migration set is sound, independent of any
  real environment:
  - apply `prisma migrate deploy` to a throwaway Postgres service container
    from empty, which catches a migration that cannot apply from scratch;
  - then `prisma migrate diff` between the migrations and `schema.prisma`,
    failing on drift, which catches a schema edited without a migration.
- A migration merged to `main` has by then also run against the preview
  database, which (after R1c) holds production-shaped data.
- Update CLAUDE.md's Netlify checklist, which currently says to run
  `prisma migrate deploy` against production manually before deploying.
  That contradicts the build command and should describe the real flow.

**Ships:** every migration is exercised twice — from empty in CI, and
against production-shaped data in preview — before production sees it.

### R1c — Refresh pipeline

The sequence, which must run in this order:

1. Restore the latest RDS snapshot into a short-lived scratch instance.
2. Anonymise **on the scratch instance**: replace `User.email` and
   `User.username`; decide `User.clerkId` per the open question below.
   Ratings, games, participants and matchmaking events keep their real
   shapes and volumes.
3. `pg_dump` from scratch to a private, encrypted S3 bucket, with a short
   retention.
4. Destroy the scratch instance.
5. Load preview from the dump, then `prisma migrate deploy` to bring it to
   head.

Anonymisation never happens in preview after loading. Loading raw
production data there first would put production personal data in the
least-protected database, even briefly.

Locally, `npm run db:refresh` pulls the latest dump and loads it, then
migrates to head. `db:reset` and `db:seed` keep working for anyone without
AWS access, and `seed.ts` stays until the snapshot flow is proven.

A full anonymised copy is simpler than a slice while the database is small:
a slice still needs every user its games reference, and every matchmaking
event those users produced. Revisit when dump or restore time becomes
annoying.

**Ships:** local and preview data with production's shapes; the
hand-written seed retires.

## Non-goals

- **Per-pull-request databases.** One shared preview database is enough at
  this size, and the scheduled refresh is the reset button.
- **Splitting Clerk per environment.** All environments keep sharing the
  one dev instance. That switch is later config, and not free: `sync-user.ts`
  matches on `clerkId` alone, so users would arrive with new Clerk IDs,
  collide on the email unique constraint and fail to sign in. It needs a
  one-time relink and reissued API keys.
- **Load testing.** Explicitly out (roadmap, "Deliberately left off").
- **Changing the ORM or the migration tool.**

## Risks

- **Shared preview database, concurrent pull requests.** Two open branches
  with different migrations both write to it, and an abandoned branch leaves
  its migration behind. A destructive migration breaks other previews until
  the next refresh. Accepted; the refresh is the remedy.
- **Snapshot restore cost.** An RDS restore creates a full-size instance.
  The pipeline must destroy it even when a later step fails.
- **The dump is still confidential.** Anonymised or not, it is the real
  league's history. Private bucket, encryption, short retention, and no
  copies in tickets or chat.
- **Anonymisation gaps.** Anything added to `User` later — a display name,
  an avatar URL — needs adding to the scrub. Worth a test that asserts no
  production email domain survives in the dump.
- **First refresh will surface schema drift** between production and the
  migration history, if any exists. Better found now than during an
  incident.

## Open questions

- **Separate RDS instance, or a second database on the production
  instance?** Separate instance recommended above; it is a cost question.
- **Do team members keep their `clerkId` in preview?** Keeping it for an
  allowlist lets each of us sign into preview as ourselves with our real
  rating and history, which makes preview genuinely useful for testing.
  Nulling every `clerkId` is cleaner but means signing in creates a fresh,
  empty user. Leaning allowlist.
- **Refresh cadence**, and whether the refresh re-applies migrations for
  currently open pull requests or leaves them to the next preview build.
- **Who holds AWS credentials for `db:refresh`?** If not every developer,
  the dump needs another distribution path, or the command becomes a CI
  job that publishes somewhere they can reach.

## When done

- Record the environment topology and migration flow as a decision record
  in `docs/decisions/`. It constrains work well beyond this feature.
- Update CLAUDE.md: the Netlify checklist, and the database commands
  section, to include `db:refresh` and the real migration flow.
- Move this plan to `.claude/plans/complete/` and update references.

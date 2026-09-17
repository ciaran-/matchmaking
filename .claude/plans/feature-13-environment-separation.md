# Separating Environments from Production — Feature Plan

> **Deferred 17 Sep 2026.** Moved from the front of the roadmap to the end,
> on direction: the running cost of a second database is not worth adding
> right now, and the velocity penalty is accepted. Deferred, not dropped —
> everything below stands, and the plan stays here rather than moving to
> `archived/`.
>
> **While it waits, a pull request containing a migration still reaches
> production when its preview builds.** Nothing in the roadmap before R1
> changes that, so every schema change until then is done deliberately and
> by hand. R5 is the one to watch: it is entirely migrations.
>
> Tolerable for now because there are no live users — a botched migration
> is annoying, not serious. The agreed handling is that either side calls
> the risk out whenever a feature touches a migration, and we decide then
> whether to take the zero-cost `netlify.toml` fix (migrations scoped to
> the production context) recorded in the roadmap. That calculation
> changes the day real users arrive.

Production, preview and local each get their own database, migrations stop
reaching production from a pull request, and preview and local are refilled
from anonymised production copies.

Roadmap item R1, feature 13 (`.claude/plans/roadmap.md`).
Tasks: `.claude/tasks/feature-13-tasks.md`.

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
- Postgres is hosted on AWS RDS.

**Until R1a ships, no pull request containing a migration can safely be
merged.** That also blocks roadmap items R4/R5.

## Goal

- A pull request cannot change the production schema.
- Every migration runs against production-shaped data before production.
- Preview holds a recent, anonymised copy of production and is disposable.
- A developer can refill local from the same copy on demand.

## Decisions taken (14 Sep 2026)

- **Preview gets its own RDS instance**, not a second database on the
  production instance. A shared instance still shares CPU, memory and
  connections with production, which defeats the purpose.
- **Team members keep their `clerkId`** in the preview copy, so each of us
  can sign into preview as ourselves with real rating and history.
  Everyone else's is nulled.
- **Dumps live in S3 with short retention**, readable by anyone who can
  commit code. Separate production credentials come later; today that is
  one person.
- **Preview refreshes weekly**, during quiet hours — Sunday, or before
  06:00 Monday.
- **The refresh runs inside AWS**, not in GitHub Actions. Actions is for
  the code lifecycle; this is a data-plane job, and keeping it in AWS keeps
  the credentials there too. Note that Lambda's 15-minute ceiling rules it
  out as the executor — an RDS restore alone can exceed it — so the shape
  is EventBridge triggering Step Functions, with the dump step running as a
  Fargate task.
- **The team allowlist matches on email domain.** No list to maintain, and
  no names in the repo.
- **Dumps are retained for two weeks**, which keeps one spare when a
  refresh fails.
- **Infrastructure is written in Terraform**, new pieces first. The
  application runs on Netlify, not AWS, so the app-next-to-infra coupling
  that CDK, SST and Pulumi offer buys nothing here.
- **Production's AWS setup is brought into Terraform too**, as a second
  stage of this work rather than a someday item — once the preview
  instance and the refresh pipeline have proven the setup. Adoption is via
  `import`, changing nothing about the running instance.
- **The preview instance is always-on**, on the smallest class that runs
  the workload.

## Decisions still open

- **How wide the agent's AWS permission set is** (T0). The default is
  read-only to start, widened per task when a write is needed, rather than
  admin up front. This also settles whether `terraform apply` runs as a
  person or as the agent.
- **`docs/decisions/0002`** records that a local `User` row is keyed by
  `clerkId`. The allowlist rule is a carve-out worth recording alongside
  the environment topology when this lands.

## Preview instance lifecycle — always-on

**Decided 14 Sep: always-on, on the smallest class that runs the
workload.** Cost matters at the moment, but not more than a preview
database that is reliably there.

Deploy previews build on pull-request events, at unpredictable times, and
every preview build runs `prisma migrate deploy`. So a cold preview
database has to wake up inside a build's patience — that constraint, not
the monthly cost, is what ruled out the alternatives.

- **Always-on small instance — chosen.** No moving parts, and nothing that
  can make a preview build flaky. What the alternatives save is a
  low-tens-of-dollars line item.
- **RDS stop/start on a schedule.** Keeps engine parity with production.
  Compute stops, but storage and backups still bill, so the saving is the
  compute share only. A start takes minutes, so a pull request opened
  outside the window gets a failed or slow preview build. AWS also
  force-starts a stopped instance after seven days, so the schedule has to
  re-stop it.
- **Aurora Serverless v2 with auto-pause.** Scales to zero after an idle
  period and resumes in seconds, which is inside a build's tolerance, and
  bills only storage while paused. The trade-off is that Aurora PostgreSQL
  is a different engine family from production's RDS PostgreSQL —
  immaterial to Prisma, but it does weaken "preview mirrors production".
  Confirm current scale-to-zero behaviour, connection handling and
  in-region pricing before committing to it.

Revisit only if the bill grows teeth. Aurora Serverless v2 is the move at
that point; scheduled stop/start is not, because preview builds do not keep
office hours. Described in Terraform, that switch is a resource change
rather than a rebuild.

## Scope

### Before R1a — AWS access without the root user

Found 15 Sep 2026: the development machine's AWS CLI is signed in as the
account's root user, and the AWS MCP server refuses every account call.
Every later step builds infrastructure, much of it with an agent doing the
work, so access comes first:

- People sign in through IAM Identity Center with an administrator
  permission set. Root is locked away, with MFA and no access keys.
- Claude and the AWS MCP server use a separate, narrower permission set.
- Verified when the MCP server can call AWS as that narrower role, and is
  denied outside it.

### R1a — Preview gets its own database

- Provision the preview RDS instance.
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

### R1b — A migration path with a step in the middle

- Production migrations run only from a production-context deploy of `main`.
- Add a CI job that proves the migration set is sound, independent of any
  real environment:
  - apply `prisma migrate deploy` to a throwaway Postgres service container
    from empty, which catches a migration that cannot apply from scratch;
  - then `prisma migrate diff` between the migrations and `schema.prisma`,
    failing on drift, which catches a schema edited without a migration.
- A migration merged to `main` has by then also run against the preview
  database, which after R1c holds production-shaped data.
- Update CLAUDE.md's Netlify checklist, which currently says to run
  `prisma migrate deploy` against production manually before deploying.
  That contradicts the build command and should describe the real flow.

### R1c — Refresh pipeline

The sequence, which must run in this order:

1. Restore the latest RDS snapshot into a short-lived scratch instance.
2. Anonymise **on the scratch instance**: replace `User.email` and
   `User.username`; null `User.clerkId` except for the team allowlist.
   Ratings, games, participants and matchmaking events keep their real
   shapes and volumes.
3. `pg_dump` from scratch to a private, encrypted S3 bucket.
4. Destroy the scratch instance, including when an earlier step failed.
5. Load preview from the dump, then `prisma migrate deploy` to bring it to
   head.

Runs weekly in quiet hours, orchestrated by EventBridge and Step Functions
with the anonymise-and-dump step as a Fargate task.
Anonymisation never happens in preview after
loading: putting raw production data there first would place production
personal data in the least-protected database, even briefly.

Locally, `npm run db:refresh` pulls the latest dump and loads it, then
migrates to head. `db:reset` and `db:seed` keep working, and `seed.ts`
stays until the snapshot flow is proven.

A full anonymised copy is simpler than a slice while the database is small:
a slice still needs every user its games reference, and every matchmaking
event those users produced. Revisit when dump or restore time becomes
annoying.

## Non-goals

- **Per-pull-request databases.** One shared preview database, and the
  scheduled refresh is the reset button.
- **Splitting Clerk per environment.** All environments keep sharing the
  one dev instance for now. The likely shape later is a non-production
  Clerk instance shared by preview and local, plus scripts that re-create
  team logins after each snapshot refresh — which is exactly why the
  allowlist rule above is worth recording.
- **Load testing.**
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
  an avatar URL — needs adding to the scrub. A test should assert that no
  production email domain survives in the dump, other than allowlisted
  team rows.
- **First refresh will surface schema drift** between production and the
  migration history, if any exists. Better found now than during an
  incident.

## When done

- Record the environment topology, the migration flow and the `clerkId`
  allowlist carve-out as a decision record in `docs/decisions/`.
- Update CLAUDE.md: the Netlify checklist, and the database commands
  section, to include `db:refresh` and the real migration flow.
- Move this plan and its task list to `.claude/plans/complete/` and
  `.claude/tasks/complete/`, updating references.

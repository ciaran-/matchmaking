# Feature 13 — Environment Separation (R1): Task List

Plan: `.claude/plans/feature-13-environment-separation.md` — read in full
before starting any task. The plan is authoritative; this is the tactical
breakdown.

This is the roadmap's first item because **until T2 lands, any pull request
containing a migration applies it to production when its preview builds.**

---

## Dependency graph

```
T1 (terraform root + state) ──> T2 (preview instance + context-scoped DATABASE_URL) ──┬──> T3 (netlify.toml context blocks)
                                                                                      ├──> T4 (CI migration job)
                                                                                      └──> T5 (anonymise + dump) ──> T6 (load preview, schedule) ──> T7 (db:refresh)

T6 ──> T8 (adopt production into terraform) ──> T9 (docs + decision record)
```

### Strict ordering

T1 → T2 before anything else. T4 is independent of T5–T7 once T2 is done.

### Parallelism

- **T4** (CI job) touches only `.github/workflows/` and can be done by a
  second person while T5–T7 proceed.
- **T5–T7** are one chain; the same author should carry them.

---

## Pre-flight (do once)

1. Read `.claude/plans/feature-13-environment-separation.md` and the R1
   section of `.claude/plans/roadmap.md`.
2. Read `CLAUDE.md` — **Netlify Production Checklist**, **Database**
   commands, and **Pre-commit Checklist**.
3. Confirm `npm run build`, `npm test` and `npm run test:integration` pass
   on `main`.
4. Confirm AWS and Netlify access, including `netlify env:list`.
5. Branch: `feature-13-environment-separation-agent-<short-id>`.
6. **Do not merge any migration during this work.** That is the hole being
   fixed.

---

## T1 — Stand up Terraform

**Status:** not started
**Depends on:** nothing
**Blocks:** T2

Decided 14 Sep: infrastructure is written in Terraform, new pieces first,
with production adopted in T8.

### Actions

- Create the Terraform root: provider, region, and a state backend. State
  is itself infrastructure — an S3 bucket with locking, bootstrapped
  deliberately and documented, not created by accident on first apply.
- Describe the preview database: always-on, on the smallest instance class
  that runs the workload.
- Keep production out of this state file. It is adopted in T8, and the
  separation is what stops a preview change reaching production.

### Verify

- `terraform plan` is clean from a fresh checkout, with no drift.
- The state backend is not reachable publicly, and its contents are
  treated as sensitive — Terraform state holds connection details.

---

## T2 — Preview RDS instance, and context-scoped `DATABASE_URL`

**Status:** not started
**Depends on:** T1
**Blocks:** everything else

### Actions

- Provision the preview RDS instance, per T1's answer.
- In Netlify, scope `DATABASE_URL`: production → production database;
  deploy-preview and branch-deploy → preview database.
- Record the before state: `netlify env:list --context deploy-preview`.

### Verify

- `netlify env:list` for each context shows the intended database.
- Open a throwaway pull request containing a trivial, reversible migration.
  Its preview build must apply that migration to **preview**, and
  production must be untouched. Close the pull request and note the result
  in it.

This verification is the whole point of the task. Do not skip it.

---

## T3 — Make the contexts explicit in `netlify.toml`

**Status:** not started
**Depends on:** T2

Add `[context.production]` and `[context.deploy-preview]` blocks. Behaviour
does not change once T2 is done — this exists so the intent is readable in
the repo rather than only in the Netlify UI.

---

## T4 — CI job: migrations apply from empty, and match the schema

**Status:** not started
**Depends on:** T2

### Actions

- Add a `migrations` job to `.github/workflows/ci.yml` with a Postgres
  service container.
- Run `prisma migrate deploy` against it from empty. This catches a
  migration that cannot apply to a fresh database.
- Then run `prisma migrate diff` between the migration history and
  `schema.prisma`, failing on any difference. This catches a schema edited
  without a migration.

### Verify

- Push a branch with a deliberately drifted `schema.prisma` and confirm the
  job fails. Revert.

---

## T5 — Anonymise and dump

**Status:** not started
**Depends on:** T2

### Actions

- Script the sequence: restore the latest RDS snapshot to a scratch
  instance → anonymise **on scratch** → `pg_dump` → upload to the private,
  encrypted S3 bucket → destroy the scratch instance.
- Scrub `User.email` and `User.username`; null `User.clerkId` except for
  the team allowlist (mechanism per the plan's open decision).
- Destruction of the scratch instance must run even when an earlier step
  fails.
- Set the bucket's retention policy.

### Verify

- A test or script assertion that the dump contains no production email
  domain outside allowlisted team rows.
- Confirm the scratch instance is gone after both a successful run and a
  deliberately failed one.

---

## T6 — Load preview, and schedule the refresh

**Status:** not started
**Depends on:** T5

### Actions

- Load the dump into preview, then `prisma migrate deploy` to bring it to
  head.
- Schedule weekly, in quiet hours — Sunday, or before 06:00 Monday. Where
  it runs is an open decision in the plan; settle it here.

### Verify

- A deploy preview signs in and shows real-shaped data.
- An allowlisted team member signs in as themselves and sees their own
  rating and history.

---

## T7 — `npm run db:refresh`

**Status:** not started
**Depends on:** T6

Pull the latest dump from S3, load it into the local database, then
`prisma migrate deploy`. `db:reset` and `db:seed` keep working, and
`seed.ts` stays until this is proven.

---

## T8 — Adopt production's AWS setup into Terraform

**Status:** not started
**Depends on:** T6 — do this once the preview instance and the refresh
pipeline have proven the setup, not before

The second stage of this work: production stops being click-ops. Adoption
changes nothing about the running instance — `import` brings existing
resources under management, it does not recreate them.

### Actions

- Describe the production instance and its networking — subnet group,
  security group, parameter group, backup settings — to match what is
  actually deployed.
- Import each resource, then run `terraform plan` until it reports **no
  changes**. A plan that proposes changes means the description does not
  match reality; fix the description, never let the apply "correct" the
  instance.
- Keep production in its own state file or workspace, separate from
  preview.

### Risk to respect

Once production is under Terraform, a careless `apply` can reach it —
including replacing an instance. Separate state, a drift-free plan, and
reading every plan before applying are what make this safe. Consider
`prevent_destroy` on the production instance.

### Verify

- `terraform plan` is clean against production, twice, on different days.
- Sign-in and a recorded game still work; adoption should be invisible.

---

## T9 — Documentation and decision record

**Status:** not started
**Depends on:** T6 (T7 for the command reference, T8 for the Terraform
topology)

### Actions

- Write the decision record: environment topology, the migration flow, and
  the `clerkId` allowlist carve-out against 0002.
- Update CLAUDE.md's **Netlify Production Checklist**, which currently says
  to run `prisma migrate deploy` against production by hand — that
  contradicts the build command.
- Add `db:refresh` to CLAUDE.md's database commands.
- `git mv` this plan and task list into `complete/` and update references.

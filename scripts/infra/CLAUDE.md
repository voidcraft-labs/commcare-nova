# Deployment infrastructure

Nova has one deployment path: Cloud Build pushes the complete application
image directly from BuildKit and deploys its immutable digest. A separately
built reproducible migration image must have a verified successful Execution
before the service update. The gate reuses unchanged successful artifacts only
with the full Job contract, latest Execution identity, and etag still matching;
changed artifacts run the full migration and runtime probe while the app builds.
Job image changes PATCH the complete writable configuration with its etag;
Cloud Run Jobs do not accept an update mask.
The capture worker is built and updated explicitly outside application releases. Stable infrastructure is
managed explicitly by `manage-deployment.py` (plan by default, `--apply` to
change it); see `docs/architecture/deployment.md`. Do not add
traffic controllers, candidate services, rollout accounts, compatibility
paths, or deploy-time maintenance gates.

The required PR check named `Production build` and Cloud Build both invoke
`scripts/rollout/build-image.sh`. PR CI supplies synthetic build-time identity
and public configuration, builds the complete final image, and never pushes or
deploys it. Keep that shared Dockerfile + `.dockerignore` boundary intact: a
host-side `npm run build` cannot prove that production's filtered context
contains every build and runner input.

Each Job execution first reads the reconciled Job generation, proves its sole
container image, service account, command, dry-run/default args, task count,
parallelism, retry policy, and timeout match the checked-in contract, then
submits `jobs:run` with the Job `etag`. It proves the resulting immutable
Execution snapshots the effective override args under the same image,
authority, and execution shape, and that every task succeeded. This generation
fence prevents overlapping builds from changing a shared Job between its
inspection and execution. The execution POST is sent exactly once. Read-only
Job, operation, and Execution GETs retry bounded transient HTTP or transport
failures without resubmitting the Job; authentication and contract failures are
terminal.

`provision-deployment-identities.sh` is plan-only unless passed `--apply`. It
reconciles these permanent identities:

- `nova-build` builds, pushes, changes migration Job images, and deploys the
  service. It reads scheduler and media metadata to check prerequisites; it
  never connects to Postgres. It reads only the build-time secrets used by
  `cloudbuild.yaml`. Disposable private caches have separate bucket/repository
  grants and expire after fourteen days.
- `nova-migrate` connects as the migration database owner and runs Kysely,
  Better Auth, Nova auth initialization, privilege convergence, and the full
  runtime database probe. Historical repairs live in the explicit Docker
  `maintenance` target, not the serving image. Operators scan first, configure
  a maintenance Job with its immutable image, and execute it through
  `deploy-cloud-run.py --execute-job --image=REPOSITORY@sha256:...`.
- `nova-media-policy` owns only bucket metadata get/update and applies the exact
  capture retention/CORS policy. It never connects to Postgres.
- `nova-capture-cleanup` has no runtime-role membership. In Postgres it receives
  only public-schema `USAGE` and `SELECT`/`UPDATE`/`DELETE` on
  `form_attachments`; in GCS it receives object get/create/delete restricted to
  staged captures and Project durable-capture prefixes.
- `nova-capture-scheduler` may invoke only the capture-cleanup Cloud Run Job.
- `nova-audit` is the pool-one canonical-identity scanner login. It has no
  parent role, DML, DDL, sequence, or routine authority; privilege convergence
  grants only schema `USAGE` plus `SELECT` on the frozen scanner's exact
  relation inventory.
- `commcare-nova` serves the application with ordinary application DML, but no
  fixed-schema ownership or public-schema DDL.

Cloud Scheduler invokes the cleanup Job every five minutes. This is correctness
infrastructure: it resumes DB-first `preparing` rows, verifies deterministic
durable destinations after request crashes, finishes exact `discarding`, and
sweeps expired rows without application traffic. Every dispatch runs the same
bounded worker. A Postgres session advisory lock collapses at-least-once or
overlapping delivery to one active execution; a held lock or a pre-lock
SQLSTATE `53300` skips that dispatch. After winning, the worker prewarms its
second pool connection and proves its schema and database authority before maintenance; admission failure after lock
ownership fails the Job. There is no alternate mode, deploy-time invocation, or
storage probe.

The bucket policy is the independent hard-retention backstop for ordinary
staging-prefix bytes and must never match the durable capture prefix. The media
policy identity applies that policy with a metageneration fence, disables soft
delete, versioning, and default event holds, and refuses to remove an operator
retention policy. Capture object names are accepted only when every prefix
segment is non-empty; the IAM condition and its domain mirror enforce the same
shape. The condition uses only Cloud Storage's supported `resource.name`
surface: `startsWith`, `endsWith`, `extract`, and equality.

Every non-local database process declares one final workload:

- `service`: pool 3 plus one dedicated LISTEN connection per serving instance.
- `migration`: pool 1.
- `capture-cleanup`: pool 2 (advisory-lock session plus work session).
- `audit`: pool 1.
- `operator`: pool 1.

Cloud Run's service and revision maxima are both four. PostgreSQL direct-login
limits are the hard cluster boundary: runtime 16, migration 1, cleanup 3,
audit 1.
Migration inherits runtime table privileges but its sessions count against its
own role; cleanup and audit inherit no application role. The limits total 21
against `max_connections=25`, leaving one ordinary slot plus PostgreSQL's three
superuser-reserved slots. Unknown or absent production workloads fail before
connecting.

`provision-cloud-sql.sh` converges the complete Cloud SQL flag set exactly:
`cloudsql.enable_pgaudit=on`, `cloudsql.iam_authentication=on`,
`max_connections=25`, and `pgaudit.log=all`. Cloud SQL replaces the whole flag
set on patch, so preserving the exact list is load-bearing. The script also
creates the permanent IAM database users and wires the service's final VPC,
workload, and instance-limit configuration.

The privileged database bootstrap is intentionally a separately invoked local
operation. `bootstrap-database-owner.ts` is read-only unless passed `--apply`;
run the dry-run and inspect its catalog inventory before applying. It requires a
temporary `BUILT_IN` administrator because `CREATE EXTENSION` and
`ALTER ROLE ... CONNECTION LIMIT` require `cloudsqlsuperuser`, authority the
permanent migration identity deliberately lacks. In one bounded transaction it:

- applies the runtime/migration/cleanup/audit limits 16/1/3/1;
- creates `pg_trgm`, `fuzzystrmatch`, `postgis`, and `pgaudit`;
- makes migration the database owner;
- transfers non-permanent ownership to migration and removes the temporary
  administrator's owned grants; and
- proves required extensions are in `public`, owned only by Cloud SQL's managed
  `postgres` role or migration, with no dependency or ACL residue belonging to
  a non-permanent principal.

Before either dry-run or apply, Cloud SQL's PG18 membership API must give that
temporary administrator direct MEMBER plus SET access to migration, runtime,
cleanup, audit, and the legacy source owner when present. The bootstrap audits
all four permanent identities as direct non-superuser LOGIN roles and refuses
to alter a role it cannot fully inspect or `SET ROLE` to.

Delete the temporary administrator through Cloud SQL only after that audit
succeeds. Subsequent deploys use only the permanent identities and the ordinary
migration Job.

`scripts/rollout/deploy-cloud-run.py` is the permanent service policy. It
rejects mutable images and traffic tags, requires the exact candidate to own
100% of both desired and observed traffic, and permits revision GC only for
untagged zero-traffic revisions. Ordinary deployment requires automatic scaling before and after deployment,
creates exactly one new revision, and never pauses cleanup or changes ingress.
Completed historical cutover labels have no behavioral effect. Migration admission must succeed before the service changes. Worker image
updates are explicit infrastructure maintenance, outside the application pipeline.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

# Deployment infrastructure

Nova has one deployment path: Cloud Build constructs and pushes one image,
resolves that pushed tag once to its complete `repository@sha256` identity,
then passes only that immutable reference to the media-policy Job, blocking
migration Job, capture-cleanup Job, and direct service deployment. Do not add
traffic controllers, candidate services, rollout accounts, compatibility
paths, or deploy-time maintenance gates.
Each Job execution first reads the reconciled Job generation, proves its sole
container image, service account, command, dry-run/default args, task count,
parallelism, retry policy, and timeout match the checked-in contract, then
submits `jobs:run` with the Job `etag`. It proves the resulting immutable
Execution snapshots the effective override args under the same image,
authority, and execution shape, and that every task succeeded. This generation
fence prevents overlapping builds from changing a shared Job between its
inspection and execution.

`provision-deployment-identities.sh` is plan-only unless passed `--apply`. It
reconciles these permanent identities:

- `nova-build` builds, pushes, configures Jobs, and deploys the service. Its
  narrow deployment-ingress custom role can read/update backend services and
  use the regional serverless NEG so an admission cutover can detach and
  restore Nova's public backend; it has no broad Compute role. It can act as
  the Job/runtime identities but never connects to Postgres. It reads only the
  build-time secrets used by `cloudbuild.yaml`.
- `nova-migrate` connects as the migration database owner and runs the Kysely,
  Better Auth, and Nova auth migrations plus privilege convergence. It also
  owns the separately configured one-off case-type-retirement and
  case-parent-relationship-repair Jobs: Cloud Build pins both Jobs to the exact
  image only after the service deploy, but never executes either. Their stored
  args are dry-run only. After old-revision requests drain, an operator uses
  `deploy-cloud-run.py --execute-job
  --service=commcare-nova` with explicit writer args; that path applies the
  same service-image, Job-generation, authority/template, etag, effective-args,
  Execution-image, and task-success proofs as deployment Jobs.
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
second pool connection before maintenance; admission failure after lock
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
untagged zero-traffic revisions. A maintenance run keeps a `try/finally`
recovery arm live until terminal success; every failure detaches ingress,
restores manual zero, runs the exact-image migration Job's runtime-session
fence, pauses cleanup, and re-verifies the complete maintenance posture. Every
recovery action is attempted even if an earlier action fails; errors are
aggregated without replacing the original deployment failure.

An admission rule that an old serving revision does not enforce uses the
one-time labelled maintenance cutover in `cloudbuild.yaml`. The immutable
migration Job is configured first; if the service lacks that gate's version
label, deployment policy pauses cleanup, detaches ingress, scales the old
revision to zero, and terminates its runtime database sessions before the
fleet verifier runs. Candidate deployment retains manual zero until the exact
new revision owns traffic, then restores automatic scaling, ingress, and the
cleanup scheduler. Only that terminal success writes the version label. A
failed deployment stays in the verified maintenance posture for a safe retry,
and a failed label write repeats the cutover safely; the completed label
prevents downtime on later ordinary deploys.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

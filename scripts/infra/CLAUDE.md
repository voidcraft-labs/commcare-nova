# Deployment infrastructure

Nova has one deployment path: Cloud Build constructs one image, applies the
media-bucket policy, runs the blocking migration Cloud Run Job, configures the
capture-cleanup Job and Scheduler, then deploys that image directly to the
Cloud Run service. Do not add traffic controllers, candidate services, rollout
accounts, compatibility paths, or deploy-time maintenance gates.

`provision-deployment-identities.sh` is plan-only unless passed `--apply`. It
reconciles these permanent identities:

- `nova-build` builds, pushes, configures Jobs, and deploys the service. It can
  act as the Job/runtime identities but never connects to Postgres. It reads
  only the build-time secrets used by `cloudbuild.yaml`.
- `nova-migrate` connects as the migration database owner and runs the Kysely,
  Better Auth, and Nova auth migrations plus privilege convergence.
- `nova-media-policy` owns only bucket metadata get/update and applies the exact
  capture retention/CORS policy. It never connects to Postgres.
- `nova-capture-cleanup` has no runtime-role membership. In Postgres it receives
  only public-schema `USAGE` and `SELECT`/`UPDATE`/`DELETE` on
  `form_attachments`; in GCS it receives object get/create/delete restricted to
  staged captures and Project durable-capture prefixes.
- `nova-capture-scheduler` may invoke only the capture-cleanup Cloud Run Job.
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
- `operator`: pool 1.

Cloud Run's service and revision maxima are both four. PostgreSQL direct-login
limits are the hard cluster boundary: runtime 16, migration 1, cleanup 3.
Migration inherits runtime table privileges but its sessions count against its
own role; cleanup inherits no application role. The limits total 20 against
`max_connections=25`, leaving two ordinary slots plus PostgreSQL's three
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

- applies the runtime/migration/cleanup limits 16/1/3;
- creates `pg_trgm`, `fuzzystrmatch`, `postgis`, and `pgaudit`;
- makes migration the database owner;
- transfers non-permanent ownership to migration and removes the temporary
  administrator's owned grants; and
- proves required extensions are in `public`, owned only by Cloud SQL's managed
  `postgres` role or migration, with no dependency or ACL residue belonging to
  a non-permanent principal.

Delete the temporary administrator through Cloud SQL only after that audit
succeeds. Subsequent deploys use only the permanent identities and the ordinary
migration Job.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

# Deployment infrastructure

Nova uses the platform's ordinary deployment sequence: Cloud Build constructs
one image, a blocking Cloud Run migration Job applies schema changes, and Cloud
Run deploys the same image after its `/warmup` startup probe succeeds. Do not
add a Nova-specific traffic controller, cutover journal, candidate service, or
rollout service account without an explicit product decision.

`provision-deployment-identities.sh` is plan-only unless passed `--apply`. It
reconciles the dedicated deployment/maintenance identities while preserving
the existing `commcare-nova` runtime identity:

- `nova-build` builds, pushes, updates the migration Job, and deploys the
  service. It may act as migration/runtime but does not connect to Postgres.
  It can read only the three build-time secrets used by `cloudbuild.yaml`; the
  runtime-only OpenAI credential remains inaccessible to the build identity.
- `nova-migrate` connects as the migration database owner and runs all three
  Kysely migration phases plus post-migration privilege convergence.
- `nova-media-policy` applies the capture-bucket lifecycle and CORS contract
  through a custom role containing only bucket metadata get/update; it does
  not connect to Postgres.
- `nova-capture-cleanup` connects as an isolated IAM database user with direct
  `SELECT`/`UPDATE`/`DELETE` on `public.form_attachments` and no runtime-role
  membership. Its custom storage role contains only object get/create/delete,
  conditionally restricted to staged captures and each Project's durable
  capture prefix. It owns the two-connection cleanup pool (lock session plus
  work).
- `nova-capture-scheduler` signs the Cloud Scheduler OAuth invocation and has
  only the Cloud Run Job invoker path; it does not connect to Postgres or GCS.
- `commcare-nova` remains the runtime identity. It serves the app and receives
  ordinary application DML, but no fixed-schema ownership or public-schema DDL.

Cloud Scheduler's API must be enabled before the script grants its Google-
managed service agent token-creator access or the first build creates the
capture-maintenance job. The provisioning script does that enablement first;
`gcloud services enable` is the idempotent prerequisite, not a manual setup
step. That five-minute Cloud Run Job is correctness infrastructure, not merely
orphan hygiene: it resumes DB-first `preparing` rows, verifies deterministic
durable destinations after request crashes, and completes exact `discarding`
cleanup without relying on app traffic. The bucket lifecycle remains the
independent backstop for ordinary staging-prefix sources; it must never match
the durable capture prefix accepted submissions use.

The Job's stored mode is `scheduler`: ordinary five-minute dispatches are
best-effort when connection capacity or the advisory lease is already occupied.
Cloud Build overrides one execution to `strict` before traffic moves. That gate
waits up to its bounded deadline for capacity and the lease, proves
create/read/exact-generation-delete authority with an unguessable object under
the staged lifecycle prefix, and fails if row preparation/discard or exact
object deletion reports a failure.

Cloud SQL capacity is one production contract across service and Jobs, not a
service-only calculation. PostgreSQL direct-login limits are the hard,
cluster-wide boundary: runtime = 16, migration = 1, and capture cleanup = 3.
They total 20 against `max_connections=25`; two residual slots admit ordinary
operator/IAM logins, and PostgreSQL's final three
`superuser_reserved_connections` are true-superuser-only
(`reserved_connections=0`). Role attributes are not inherited: migration
inherits runtime's table privileges but its sessions count against its own
login cap; cleanup inherits nothing and receives only its exact attachment-
table grants. The active cleanup worker consumes two sessions (lock + work).
Scheduler contenders probe once and treat SQLSTATE `53300` or an already-held
lease as a best-effort no-op. Losing probes destroy their sessions; an owner
bounded-retries admission of its second session, returns it idle to the same
pool for Kysely, and only then runs maintenance. Reservation timeout or any
later `53300` is a hard worker failure.

Cloud Run's global and revision maxima of four are soft outer controls, not the
hard safety boundary. Cloud Build updates and verifies both on the old service,
then the bundled capacity preflight audits `max_connections=25`,
`superuser_reserved_connections=3`, `reserved_connections=0`, all three role
limits, and the presence of the `pgaudit` extension, then waits for old runtime
sessions to drain to at most 16 before migration. Migration and capture-cleanup
entrypoints repeat that audit at the start of every execution, so post-deploy
drift fails closed.
`provision-cloud-sql.sh` converges the exact complete four-flag replacement set
even on an existing instance:
`cloudsql.enable_pgaudit=on`, `cloudsql.iam_authentication=on`,
`max_connections=25`, and `pgaudit.log=all`. Cloud SQL patch semantics replace
the whole set, so omitting either pgaudit flag would disable production
auditing; extra flags are drift and must not be preserved implicitly. Every
non-local process declares `NOVA_DB_WORKLOAD`; operator scripts use their own
one-connection workload.

The first database split/cap cutover has one mandatory order:

1. Provision the capture-cleanup IAM database user.
2. Converge and verify both the existing Cloud Run service-global and
   revision-local maxima at four. This precedes the runtime role's hard cap:
   the old five-instance fleet can demand 20 sessions, which must never be
   placed behind a 16-session login limit.
3. Create a temporary `BUILT_IN` database user with a strong password and no
   inline `--database-roles`; inline roles suppress the built-in user's
   `cloudsqlsuperuser` membership.
4. After creation, assign runtime, migration, cleanup, and the retired role
   when present to that temporary user without `--revoke-existing-roles`, so
   its `cloudsqlsuperuser` membership is preserved. Independently converge
   migration -> runtime as the only application membership; cleanup remains
   isolated.
5. From the local repository, connect through the Cloud SQL connector with the
   temporary credentials and run `bootstrap-database-owner.ts` dry-run, then
   `--apply`. Cloud SQL Studio is optional for read-only catalog inspection; it
   cannot run the Node/TypeScript CLI. The dry-run reports each required
   extension's owner, version, schema, configuration relations, and dependency
   catalogs/count. The transaction creates missing extensions, sets all three
   login-role caps, transfers temporary/legacy ownership, and audits the result.
6. Delete the temporary user through the Cloud SQL API and verify it is absent.
7. Wait until `pg_stat_activity` reports no more than 16 runtime sessions and
   run the capacity audit.
8. Only then enable/run migration and capture-cleanup Jobs.

The special built-in `cloudsqlsuperuser` path is required for the transactional
`ALTER ROLE ... CONNECTION LIMIT` statements. The application roles do not
grant ADMIN OPTION to one another, and role memberships remain a Cloud SQL
Admin API concern rather than SQL bootstrap statements.

`bootstrap-database-owner.ts` is read-only unless passed `--apply`. In one
transaction it locks for at most 30 seconds, applies runtime/migration/cleanup
limits 16/1/3, creates `pg_trgm`, `fuzzystrmatch`, `postgis`, and `pgaudit`,
changes the `nova_cases` owner, and uses `REASSIGN OWNED` followed by
`DROP OWNED ... RESTRICT` for both the temporary administrator and, when
present, the retired role. The temporary-administrator transfer is required
because that principal owns any extension it creates during bootstrap.
Pre-existing Cloud SQL extensions remain owned by the managed `postgres` role:
PostgreSQL has no `ALTER EXTENSION ... OWNER TO`, and blanket
`REASSIGN OWNED BY postgres` would seize unrelated provider-managed objects.
The permanent trusted-owner contract is therefore exactly `postgres` or
migration for each required extension. The catalog inventory and audit reject
runtime, cleanup, temporary, legacy, or any unknown owner; prove every required
extension is present; and prove both retired principals have no remaining
ownership, ACL, or default-ACL dependency. Delete the retired database user and
temporary administrator through Cloud SQL only after this audit succeeds. The
migration then converges fixed-object ownership, exact cleanup grants, and moves
runtime-owned `cases` to its isolated schema.

The login limits persist independently of application images. Rolling back to
the prior image therefore keeps the database protected, although an older
larger pool/fleet may see connection-admission pressure until demand drains.
Before the first cutover, an audit failure stops all database Jobs without
changing schema; after the bootstrap commits, rerunning it is idempotent. This
is a one-time dogfood maintenance cutover, not temporary rollout machinery.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

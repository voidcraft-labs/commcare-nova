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
- `nova-media-policy` applies the capture-bucket lifecycle and CORS contract;
  it does not connect to Postgres.
- `nova-capture-cleanup` connects as its own IAM database user, inherits only
  the runtime database role, and can delete exact capture-object generations.
  It owns the two-connection cleanup pool (lock session plus work).
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

Cloud SQL capacity is one production contract across service and Jobs, not a
service-only calculation. PostgreSQL direct-login limits are the hard,
cluster-wide boundary: runtime = 16, migration = 1, and capture cleanup = 3.
They total 20 against `max_connections=25`; two residual slots admit ordinary
operator/IAM logins, and PostgreSQL's final three
`superuser_reserved_connections` are true-superuser-only
(`reserved_connections=0`). Role attributes are not inherited: migration and
cleanup inherit runtime's table privileges but their sessions count against
their own login caps. The active cleanup worker consumes two sessions (lock +
work), up to two other dispatches may already have reused their audited probe
sessions when the owner wins, and further contenders fail admission with
SQLSTATE `53300` and exit without work. Losing probes destroy their sessions;
the owner bounded-retries admission of its second session, returns it idle to
the same pool for Kysely, and only then runs maintenance. Reservation timeout
or any later `53300` is a hard worker failure.

Cloud Run's global and revision maxima of four are soft outer controls, not the
hard safety boundary. Cloud Build updates and verifies both on the old service,
then the bundled capacity preflight audits `max_connections=25`,
`superuser_reserved_connections=3`, `reserved_connections=0`, and all three
role limits and waits for old runtime sessions to drain to at most 16 before
migration. Migration and capture-cleanup entrypoints repeat the settings/role
audit at the start of every execution, so post-deploy drift fails closed.
`provision-cloud-sql.sh` converges the two durable database flags even on an
existing instance. Every non-local process declares `NOVA_DB_WORKLOAD`;
operator scripts use their own one-connection workload.

The first database split/cap cutover has one mandatory order:

1. Provision the capture-cleanup IAM database user.
2. Create a temporary `BUILT_IN` database user with a strong password and no
   inline `--database-roles`; inline roles suppress the built-in user's
   `cloudsqlsuperuser` membership.
3. After creation, assign runtime, migration, cleanup, and the retired role
   when present to that temporary user without `--revoke-existing-roles`, so
   its `cloudsqlsuperuser` membership is preserved. Independently converge
   migration -> runtime and cleanup -> runtime as the only two application
   memberships.
4. Connect with the temporary password and run
   `bootstrap-database-owner.ts` dry-run, then `--apply`. Its one transaction
   sets all three login-role caps, transfers ownership, and audits the result.
5. Delete the temporary user through the Cloud SQL API and verify it is absent.
6. Set the Cloud Run global/revision maxima to four and wait until
   `pg_stat_activity` reports no more than 16 runtime sessions.
7. Only then enable/run migration and capture-cleanup Jobs.

The special built-in `cloudsqlsuperuser` path is required for the transactional
`ALTER ROLE ... CONNECTION LIMIT` statements. The application roles do not
grant ADMIN OPTION to one another, and role memberships remain a Cloud SQL
Admin API concern rather than SQL bootstrap statements.

`bootstrap-database-owner.ts` is read-only unless passed `--apply`. In one
transaction it locks for at most 30 seconds, applies runtime/migration/cleanup
limits 16/1/3, changes the `nova_cases` owner, and uses `REASSIGN OWNED`
followed by `DROP OWNED ... RESTRICT` for both the temporary administrator and,
when present, the retired role. The temporary-administrator transfer is
required on a fresh instance because it installs the extensions before
bootstrap and therefore owns their catalog objects. The catalog audit rejects
foreign/shared dependencies and proves both principals have no remaining
ownership, ACL, or default-ACL dependency. Delete the retired database user and
temporary administrator through Cloud SQL only after this audit succeeds. The
migration then converges fixed-object ownership and moves runtime-owned `cases`
to its isolated schema.

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

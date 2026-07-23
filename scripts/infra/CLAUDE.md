# Deployment infrastructure

Nova uses the platform's ordinary deployment sequence: Cloud Build constructs
one image, a blocking Cloud Run migration Job applies schema changes, and Cloud
Run deploys the same image after its `/warmup` startup probe succeeds. Do not
add a Nova-specific traffic controller, cutover journal, candidate service, or
rollout service account without an explicit product decision.

`provision-deployment-identities.sh` is plan-only unless passed `--apply`. It
adds two identities while preserving the existing, already permissioned
`commcare-nova` runtime identity:

- `nova-build` builds, pushes, updates the migration Job, and deploys the
  service. It may act as migration/runtime but does not connect to Postgres.
  It can read only the three build-time secrets used by `cloudbuild.yaml`; the
  runtime-only OpenAI credential remains inaccessible to the build identity.
- `nova-migrate` connects as the migration database owner and runs all three
  Kysely migration phases plus post-migration privilege convergence.
- `commcare-nova` remains the runtime identity. It serves the app and receives
  ordinary application DML, but no fixed-schema ownership or public-schema DDL.

The first database split has an explicit Cloud SQL Admin API prerequisite:
assign the runtime role as the migration IAM user's sole custom database role,
give a temporary built-in administrator MEMBER+SET access to migration and (if
it still exists) the retired compute role, and remove the runtime user's retired
role membership before SQL runs. PostgreSQL 18 does not let a newly created
`cloudsqlsuperuser` grant arbitrary Cloud-SQL-created roles without ADMIN
OPTION, so do not move those memberships into SQL.

`bootstrap-database-owner.ts` is read-only unless passed `--apply`. In one
transaction it locks for at most 30 seconds, changes the `nova_cases` owner,
and, when the retired role exists, uses `REASSIGN OWNED` followed by `DROP
OWNED ... RESTRICT`. Its catalog audit rejects foreign/shared dependencies and
proves that the retired role has no remaining ownership, ACL, or default-ACL
dependency. A fresh instance where the retired role never existed runs only
the owner transfer. Delete the retired database user and temporary
administrator through Cloud SQL only after this audit succeeds. The migration
then converges fixed-object ownership and moves runtime-owned `cases` to its
isolated schema. This is a one-time dogfood maintenance cutover; do not disguise
it as an automatic zero-downtime transition.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

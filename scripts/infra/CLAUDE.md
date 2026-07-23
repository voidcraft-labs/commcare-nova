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

The first database split has one explicit bootstrap prerequisite that Google
IAM cannot grant: a Cloud SQL database administrator must make
`nova-migrate@commcare-nova.iam` the owner of `nova_cases` and grant it both
legacy object-owner authority through the runtime role.
`bootstrap-database-owner.ts` performs only that bounded four-statement
transfer, is read-only unless passed `--apply`, requires a temporary built-in
Cloud SQL administrator, and verifies that the administrator retained no
migration-role membership. The migration then transfers every fixed object to
the migration identity and the runtime-owned `cases` table to its isolated
schema. This is a one-time dogfood maintenance cutover; do not disguise it as
an automatic zero-downtime transition. Keep the legacy role memberships until
the first post-deploy ownership audit passes, then remove them separately.

The Cloud Build trigger switch is safe only after its service account has all
listed grants. A custom trigger identity overrides any `serviceAccount` field
inside `cloudbuild.yaml`; the checked-in provisioning script is the source of
truth for that identity.

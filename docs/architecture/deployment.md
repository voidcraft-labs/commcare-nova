# Build and deployment

Cloud Build pushes one complete production application image directly from
BuildKit, admits its independently built migration artifact, and deploys one
service revision. The migration gate blocks the service update. The verifier
requires automatic scaling, one new Ready revision, and 100% desired and
observed traffic at the exact image digest. App, docs, and MCP public probes
finish the deployment. Ordinary releases do not build or update the recurring
cleanup worker, bucket policy, Scheduler, or historical repair Jobs.

## Build caches and identity

`scripts/rollout/build-image.sh` is the shared production-image boundary for PR
CI and Cloud Build. Both build the complete runner and migration image with a
private Docker-container Buildx builder. CI uses synthetic configuration and
loads the images for validation; production pushes the application directly
from BuildKit and reads its immutable digest from the exporter's metadata.
Build, migration, cache, and maintenance targets are fixed in their respective
helpers. The application helper does not accept target overrides.

Cloud Build uses one immutable tool image containing the pinned Cloud SDK,
Docker CLI, Buildx, and Node versions. Its independent build recipe is
`scripts/infra/Dockerfile.build-tools`; build and push it explicitly when those
pins change, then update the digest in both Cloud Build configurations. The
application pipeline never builds its own tooling. The worker machine size is
the Cloud Build default.

A private registry cache holds the installed dependency layer, exported with
`mode=min` from the `deps` target. npm installs directly into that layer, and
warm builds restore it directly. There is no intermediate dependency archive
to write, extract, or fingerprint.
A separate
OCI image holds only `.next/cache`, including Turbopack and native TypeScript
incremental state. BuildKit seeds its writable cache mount directly from that
image; the compiler cache never enters the host source context or an
application layer. Zstandard level 1 keeps publication inexpensive. GCS stores
only a small completion manifest, published after the immutable cache image.
There are no host gzip archives, extraction passes, or multi-gigabyte GCS
transfers. Cache publication overlaps service deployment.

The compatibility namespace includes format, platform, production/benchmark
profile, Node/npm configuration, dependency lockfile, Dockerfile, Next and
production TypeScript configuration, and the build helper. Source edits reuse
compatible compiler state. Every build still receives its unique Cloud Build
ID for deployment, runtime provenance, and Sentry release identity. Server
Action encryption uses the pinned secret version; secrets enter through
BuildKit secret mounts and are absent from image environment variables.

Missing, corrupt, inaccessible, or incompatible cache images fall back to an
empty seed before application compilation begins. An application compile,
type-check, source-map upload, or image-export failure is terminal; it never
triggers a retry disguised as a cold build. Cache export/publication failure
does not invalidate a successfully built application. Generated Cloud Build
control and verification files are excluded from the Docker source context.
Cache export has no application-build dependency and receives no application
build credentials. It requires an exact Build ID marker written into the cache
mount only after the complete build succeeds, so publication cannot invoke a
second compilation. Private
cache artifacts expire after fourteen days and are never deployable images.

The build runs Next, the native production type check, and Sentry upload in
sequence. Parallel type checking and source-map processing caused CPU
contention on the default worker. The compiler processes use one Rayon, Tokio,
and Go worker to reduce measured contention without changing the Cloud Build
machine. These settings belong only to the builder stage. CI continues to
type-check the whole repo; the production configuration covers runtime code and Next's generated route
types. Turbopack generates native debug IDs and indexed maps with embedded
source content. The upload reads each file's debug ID to key its map and
leaves a file that already has one untouched; Sentry's symbolication reader
flattens indexed maps when needed. The upload retains the
SDK's exact manifest exclusions, including the private Server Action manifest.
The upload runs the `sentry` CLI that the Sentry SDK depends on. Nova declares
no copy of its own, so one CLI serves both and its version moves with the SDK;
the build test checks the installed CLI against every command and flag the
build sends.
Only after successful upload and release finalization are source maps and
mapping URLs removed from public, server, and standalone output. Cloud SQL,
Storage, KMS, the document/media parsers, and Sentry's server SDK use their
published native Node packages instead of being compiled into server chunks.
The Sentry server configuration carries the SDK's injected distribution-directory
value into its native global fallback, preserving frame-path rewriting.
Complete-image verification exercises workbook, document, and audio parsing plus
the generated instrumentation's error capture, release, transaction, and rewritten
stack frame through a local transport that never sends telemetry.

## Migration admission

The migration image contains the bundled migration entrypoint and its complete
transitive runtime dependencies. Its reproducible timestamps make unchanged
migration code retain the same digest across application build IDs. The
capture worker has a separate explicit image target. Neither bundle is in the
application runner.

Changed migration images use Cloud Run's Job PATCH API with the complete
writable Job configuration and its etag, preserving the full task template.
The API does not accept a field mask. Output-only state and execution tokens
are omitted, so updating an image cannot itself launch a migration.

`scripts/rollout/migration-gate.py` reuses a prior successful immutable Execution
only when the candidate digest, full Job contract, latest Execution identity,
and Job etag still match. It checks the Job again after reading the Execution.
Missing or failed evidence requires a real run. An active execution can be
joined only for the exact candidate artifact; another artifact refuses
admission. A changed artifact updates only the image with an etag fence and
executes the full migration/probe while the application compiles. This is an
artifact proof, not a commit-path heuristic or a compiler-cache success flag.

The migration runs while the previous revision is still serving, so every
schema change must be one that revision can live with: relax or add first, and
remove what it still reads in a later deploy.

Privilege convergence reads catalog ownership before issuing `ALTER OWNER`.
An already-correct owner must not request an exclusive table lock: the old
service is still reading and writing during migration. Real ownership repairs
and ACL reconciliation remain one audited transaction, with a local one-second
lock timeout. Contention aborts that transaction and blocks deployment; it does
not kill readers, skip privileges, or commit partial grants.

Better Auth checks its own tables when a process starts and refuses every auth
request while they differ from its configuration. A managed table that holds a
required column Better Auth does not write is such a difference, even when a
trigger fills it. A bridge on a Better Auth table therefore uses a nullable
column or a column default, never `NOT NULL` with a fill trigger.

## Stable infrastructure

The source of truth is `config/deployment-jobs.json`,
`config/media-bucket-policy.json`, and `scripts/infra/manage-deployment.py`.
Commands print a plan unless explicitly passed `--apply`:

```bash
python3 scripts/infra/manage-deployment.py check
python3 scripts/infra/manage-deployment.py media
python3 scripts/infra/manage-deployment.py scheduler
python3 scripts/infra/manage-deployment.py cache
python3 scripts/infra/manage-deployment.py job \
  --job commcare-nova-migrate --image "$NOVA_IMMUTABLE_IMAGE"
```

`check` reads media policy and Scheduler configuration without changing them.
Drift fails deployment with the command that repairs it. Media updates require
the observed metageneration and refuse to remove an operator retention policy.
Job provisioning requires an immutable image. Migration admission verifies
authority, command/arguments, environment,
network, resources, task/retry counts, and timeout against the manifest.
Migration submission uses the verified Job etag and sends the execution POST
once. Cloud Run omits VPC fields from the Execution response, so the Job
check and etag fence establish that part of the execution contract; any VPC
fields returned on an Execution must still match. It then proves the immutable Execution and every task succeeded. A
concurrent template change fails the fence instead of running unverified code.
Read polling retries transient HTTP failures, disconnects, and truncated
responses within its existing deadline. Write failures remain terminal and
never resubmit a Job. Authentication failures remain terminal even when their
diagnostic response body is incomplete.

Cleanup remains scheduled every five minutes. After winning its exclusive
advisory lock and prewarming its work connection, each execution proves its
schema and zero-row read/update/delete authority before maintenance. There is
no separately launched deployment probe. Build the `capture-worker` target and
update its Job explicitly when worker code changes; ordinary releases leave
its image and schedule alone.

IAM setup remains `provision-deployment-identities.sh` (plan first, `--apply`
to execute). The build identity needs scheduler viewer, media metadata reader,
cache writer, image writer, and its existing service/Job deployment authority.
Grant new read permissions before switching pipelines. After the simplified
pipeline is successfully serving, remove its obsolete `roles/cloudscheduler.admin`
and `projects/commcare-nova/roles/novaDeploymentIngressMaintenance` project
bindings, plus `roles/iam.serviceAccountUser` on `nova-media-policy` and
`nova-capture-scheduler`, and `nova-capture-cleanup`. Do not revoke them while
the old pipeline can run.
The separate media policy identity remains available for explicit maintenance.

## Historical repairs

Recurring migration retains ledgered schema migrations, Better Auth schema
convergence, Nova auth initialization (including the canonical MCP resource),
privileges, and the complete rollback-only runtime
fleet probe. The completed language repair runs only through its explicit CLI.

Build the Docker `maintenance` target explicitly, tag/push it to the application
artifact repository, and resolve its digest. It contains historical scan/writer
bundles and defaults to a dry run. Provision the appropriate Job using
`manage-deployment.py job --image "$NOVA_MAINTENANCE_IMAGE"`; inspect the plan
before applying it. Scan the live data first. After inspecting the findings,
execute the paired writer through the same fenced Job runner:

```bash
python3 scripts/rollout/deploy-cloud-run.py --execute-job \
  --project=commcare-nova --region=us-central1 \
  --job=commcare-nova-historical-repair \
  --image="$NOVA_MAINTENANCE_IMAGE" --wait-seconds=3060 \
  --execution-arg=language-identity-repair.cjs --execution-arg=--execute
```

Use each scanner's `--help` for its paired Job and arguments. The maintenance
image must be supplied explicitly; the service image contains no Job
bundles. Worker case schemas are valid derived storage even when absent from
the authored case-type catalog; the retirement scanner includes those types.
Archive completed Job definitions, execution evidence, and immutable image
references before deleting obsolete Jobs. The archive of a direct maintenance
cutover is the private bucket `gs://commcare-nova-cutover-evidence`, one prefix
per cutover. It has no lifecycle rule and nothing is deleted from it: it holds
content-free reports, IAM policy reads and Job definitions, and its list of the
member keys each run sent is the one record of a run that writes no row. It
names members by user id, so the future whole-tenant deletion lifecycle must
list it. Do not delete them until a successful release no longer refreshes
them. Historical schema migrations are immutable.

Choice starting-value repairs use `scripts/scan-select-starting-values.ts` for
the read-only census and `scripts/migrate-select-starting-values.ts` for an exact
reviewed plan. The maintenance image bundles them as
`select-starting-value-scan.cjs` and `select-starting-value-repair.cjs`.
The writer accepts one of `--plan <path>` or `--plan-base64 <encoded-json>` and
requires `--execute` to write. Base64 transports the private plan through Job
arguments; it is not encryption. Keep execution metadata in the private cutover
archive. Each app is fenced by sequence and source/target digests, active
holders refuse, and reruns verify the durable receipt. The fenced Job runner accepts the scanner (optionally scoped by `--app`) and
the writer with `--plan-base64`, with `--execute` only for a reviewed write.
Apply these reviewed repairs before deployment admission: the runtime database
probe checks every saved app with the incoming validator. After execution,
verify the affected app histories and require a clean full census or runtime
database probe before deploying the new revision.

## Incremental transcript storage cutover

`20261112000000_incremental_transcripts` replaces the transcript JSON column
with ordered message envelopes and parts. This is a direct maintenance cutover:
the previous application cannot serve after that column is removed. An ordinary
migration refuses a populated old table; an empty database initializes directly.
No dual writer or temporary compatibility bridge ships.

Before an authorized release, build the reviewed `maintenance` image and run
`thread-storage-scan.cjs` through the historical-repair Job. The scanner reports
counts, sizes, envelope findings and an exact logical-history digest, with no
message text. Resolve invalid envelopes before proceeding. The writer
`thread-storage-cutover.cjs --scan-digest <digest>` is read-only unless
`--execute` is supplied. Both commands are admitted by the existing fenced
Job runner, and both sources are included in the maintenance image.

The operator's release order is:

1. Stop admission and let executing runs finish. Paused conversations retain
   their holders, reservations and replay markers unchanged. Set
   the service to manual scaling with zero instances and verify it is disabled.
   [Cloud Run documents this service-disable operation](https://docs.cloud.google.com/run/docs/managing/services#disable).
   Disable login for the runtime database role and wait for its sessions to
   close. The writer verifies `NOLOGIN` and zero sessions; it does not terminate
   sessions or change roles itself.
2. Scan again while drained and execute the writer with that exact digest.
   Kysely owns the migration transaction and ledger. The writer locks the
   authority and thread tables, refuses still-executing runs, checks
   the scan digest, splits every message, and compares PostgreSQL JSON values
   before removing the old column. Failure rolls back the schema and data.
3. Require a clean post-scan with the same digest and no damaged normalized
   rows. A retry verifies the completed migration and never rolls later
   migrations backward. Archive the content-free scan and execution evidence.
4. Keep the service disabled, restore runtime database login, and release the
   reviewed application through the normal migration/privilege/full-probe gate.
   The deployment sets automatic scaling with the new image. Verify its exact
   revision and traffic, public probes and authorized cold conversation resume.
   Do not restart the old image against the converted database. A failed release
   stays in maintenance until a compatible image is ready.

The maintenance window includes migration and application deployment; it is not
a zero-downtime change. Restoring the old storage format would require a
separately reviewed conversion, so the migration's `down` refuses.

## Benchmarking

`cloudbuild.benchmark.yaml` builds and inspects the full final image with a fresh
build ID, real public configuration, pinned Action key, and real Sentry map
uploads. It does not push an app image, execute a database Job, or deploy. It
pushes a private benchmark migration artifact and disposable compiler caches.

```bash
gcloud builds submit --project=commcare-nova --region=us-central1 \
  --config=cloudbuild.benchmark.yaml \
  --service-account=projects/commcare-nova/serviceAccounts/nova-build@commcare-nova.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://commcare-nova-build-cache/benchmark-source \
  --substitutions=_CACHE_MODE=warm
```

Use `_CACHE_MODE=cold` for a cache-free control. Measure cold and warm builds on
the same default machine and include cache restore/export costs. The release
targets are under eight minutes cold and under four minutes warm, measured
through successful production deployment and public verification. A build-only
benchmark cannot establish either release target.

## Correlating error reports

Server `log.error` and `log.critical` preserve the original thrown value for
Sentry exception grouping and attach the SDK's returned event ID to the Cloud
Logging record as `labels.sentryEventId`. Search Cloud Logging by that exact ID
from a Sentry event to locate its structured log, even when there is no app or
run identity. An SDK capture ID is not proof of ingestion: local-disabled
reporting, SDK filtering, or delivery failure can leave a log without a stored
Sentry event. Browser error relays that explicitly skip duplicate Sentry capture
do not acquire another event ID.

Shared MCP tool and work-lifecycle failures report the tool name, private work
identity and request identity when available; saved-app execution also carries
its loaded Project and run identity. Reporting does not include tool arguments;
tool, work, request and run identities remain diagnostic-only fields. The logger indexes Project, work,
tool, operation and phase alongside app/run/user identities in Sentry tags.

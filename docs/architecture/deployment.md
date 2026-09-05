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
source content. Sentry accepts those maps directly (`--no-rewrite`); its
symbolication reader flattens indexed maps when needed. The upload retains the
SDK's exact manifest exclusions, including the private Server Action manifest.
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
case-index convergence, privileges, and the complete rollback-only runtime
fleet probe. Completed language, status, select-value, and Better Auth data repairs run
only through their explicit CLIs. The narrower XPath verification remains an
explicit read-only scan.

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
references before deleting obsolete Jobs. Do not delete them until a successful
release no longer refreshes them. Historical schema migrations are immutable.

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

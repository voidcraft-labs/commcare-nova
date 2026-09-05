# Build and deployment

Cloud Build builds one complete production image, pushes it, resolves its
immutable digest, runs one migration execution, then updates the cleanup worker
and deploys one service revision. Migration failure blocks both updates. The
service verifier requires automatic scaling, one new Ready revision, and 100%
desired and observed traffic at the exact digest. App, docs, and MCP public
probes finish the deployment. No ordinary release changes bucket policy,
Scheduler configuration, ingress attachments, or historical repair Jobs.

## Build caches and identity

`scripts/rollout/build-image.sh` is the shared production-image boundary for PR
CI and Cloud Build. It uses a private Docker-container Buildx builder, removed
on exit, with pinned Buildx and BuildKit versions. CI builds the complete runner
with synthetic configuration and never publishes an application image.

Production restores a private registry `mode=max` cache of dependency, source,
and Job layers and a separate
GCS archive of `.next/cache`. The compatibility namespace includes cache format,
platform, Node/npm configuration, the dependency lockfile, Dockerfile, and Next
configuration. Source changes reuse the compatible compiler cache. Every build
still receives its unique Cloud Build ID for deployment, runtime provenance,
and Sentry release identity. Server Action encryption uses the pinned secret
version; secrets enter through BuildKit secret mounts. The final image does not
retain the token/key as image environment variables.

Writers publish immutable archives and then completion manifests. Concurrent
builds cannot overwrite a snapshot. Missing, corrupt, inaccessible, or
incompatible caches produce a cold build. Cache export/publication failures do
not invalidate a successfully built image. The registry cache stops at the `jobs` stage; per-release runner and compiler
result layers are not exported because the next build ID cannot reuse them.
Registry cache layers contain intermediate build inputs and Job artifacts; access is restricted like other build artifacts.
Both cache stores expire after fourteen days. They contain no release pointer
and are never a source of a deployable image.

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
Job provisioning requires an immutable image. Each release changes only the
recurring Job image and verifies authority, command/arguments, environment,
network, resources, task/retry counts, and timeout against the manifest.
Migration submission uses the verified Job etag and sends the execution POST
once. It then proves the immutable Execution and every task succeeded. A
concurrent template change fails the fence instead of running unverified code.

Cleanup remains scheduled every five minutes. After winning its exclusive
advisory lock and prewarming its work connection, each execution proves its
schema and zero-row read/update/delete authority before maintenance. There is
no separately launched deployment probe.

IAM setup remains `provision-deployment-identities.sh` (plan first, `--apply`
to execute). The build identity needs scheduler viewer, media metadata reader,
cache writer, image writer, and its existing service/Job deployment authority.
Grant new read permissions before switching pipelines. After the simplified
pipeline is successfully serving, remove its obsolete `roles/cloudscheduler.admin`
and `projects/commcare-nova/roles/novaDeploymentIngressMaintenance` project
bindings, plus `roles/iam.serviceAccountUser` on `nova-media-policy` and
`nova-capture-scheduler`. Do not revoke them while the old pipeline can run.
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
image must be supplied explicitly; the service image has only recurring Job
bundles. Worker case schemas are valid derived storage even when absent from
the authored case-type catalog; the retirement scanner includes those types.
Archive completed Job definitions, execution evidence, and immutable image
references before deleting obsolete Jobs. Do not delete them until a successful
release no longer refreshes them. Historical schema migrations are immutable.

## Benchmarking

`cloudbuild.benchmark.yaml` builds and inspects the full final image with a fresh
build ID and synthetic Action key. It does not push an app image, upload Sentry
maps, run database jobs, or deploy. It may publish disposable compiler caches.

```bash
gcloud builds submit --project=commcare-nova --region=us-central1 \
  --config=cloudbuild.benchmark.yaml \
  --service-account=projects/commcare-nova/serviceAccounts/nova-build@commcare-nova.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://commcare-nova-build-cache/benchmark-source \
  --substitutions=_CACHE_MODE=warm
```

Use `_CACHE_MODE=cold` for a cache-free control and `--machine-type=E2_HIGHCPU_8`
for the larger-machine comparison. Compare complete build timing, including
restore/export costs, and account for the benchmark's omitted Sentry upload.
Keep the default machine unless the larger machine improves median end-to-end
time by at least 20% while increasing estimated compute cost by no more than
25%. Production deployment timing is verified after merge, not inferred from
a build-only benchmark.

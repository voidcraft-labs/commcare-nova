# Deployment audit, 5 September 2026

The production control was Cloud Build
`ae0bc910-1fce-41f1-9426-0c4a5f9b03e1`, source `b3336d26`.
Cloud Build step timing and Cloud Run execution/revision records showed:

| Work | Wall time |
| --- | ---: |
| Complete deployment | 20m 19s |
| Image build | 8m 03s |
| Media-policy execution and setup | 2m 37s |
| Migration execution | 3m 48s |
| Cleanup configuration and probe | 2m 54s |
| Service deployment | 1m 17s |

The previous deployment took 23m 50s. Docker used no external build cache.
The baseline image build included roughly 33 seconds of dependency installation,
48 seconds copying the entire dependency tree between stages, 3.2 minutes of
Next compilation, and 50 seconds of Sentry after-compile work. The migration
execution spent about 2m 09s launching and 86 seconds in code, including completed
historical repairs and the retained 46-second full runtime database probe.

A completed XPath maintenance label was written after every deployment. That
write created a second revision with the same image digest. The replacement
pipeline makes no label/scaling update and verifies one new revision.

## Data and configuration evidence

Read-only production scans found:

- Language identity: 491 apps, no rewrites, blocked apps, or unreadable apps.
- Case status: three clean candidates.
- Select option values: 415 candidates, none needing repair.
- Case parent relationships: 491 apps, no safe repairs, ambiguous cases, or failures.
- Legacy pre-plan builds: no candidates.
- Better Auth accounts: 38 current identities, no repair findings.
- Better Auth OAuth: 51 current clients linked to the canonical resource, no
  legacy columns or rolling-deploy bridge triggers.
- Project backfill: 396 case rows, no missing/mismatched Project IDs or orphaned apps.
- Case-type retirement: 491 apps, zero candidates after fixing the scanner's
  treatment of valid derived worker case schemas. The original scanner's four
  findings were false positives; two schemas retained real case rows. No repair
  was executed.

The media retention/CORS and five-minute enabled Scheduler configuration match
the checked-in policy. Both recurring Jobs pass the replacement verifier's
image, authority, environment, VPC, resource, task, retry, and timeout checks.
Historical Job definitions and execution inventories were archived before any
retirement. Serving traffic, database contents, and Job templates were not
changed during this implementation's build-only tests.

Fresh-database testing exposed one live initialization responsibility inside the
historical OAuth repair: canonical MCP resource creation. That insert now
belongs to normal auth initialization, preserves existing operator policy, and
has fresh-database and repeated-initialization integration coverage.

## Final benchmark method and results

The checked-in build-only configuration uses the same complete runner helper,
fresh Cloud Build IDs, real public configuration, the pinned production Action
key, and real Sentry source-map upload. It verifies the complete image's native
SDK imports, request-error capture and frame rewriting, source-map removal,
baked/runtime identity, runtime configuration, and Action key. It builds and
publishes the reproducible migration image, but does not execute database jobs
or deploy the application.

npm installs directly into the reusable dependency layer. BuildKit restores
that layer and the private compiler-state image directly from Artifact
Registry. GCS holds only immutable completion manifests. The benchmark includes
image loading and artifact extraction for verification, plus both cache
exports. Production instead pushes the application directly to the registry
and overlaps cache publication with deployment. Benchmark totals therefore
remain distinct from live deployment timings.

Matching frozen-source trials of `a8d96b49` used the unchanged default Cloud
Build machine, with no machine override:

| Cache state | Full benchmark total | Application build and image checks | Cache export |
| --- | ---: | ---: | ---: |
| Cold | 7m 38s | 5m 59s | 1m 00s |
| Warm | 3m 39s | 2m 17s | 0m 27s |

Build IDs: cold `3f6b1cf6-3738-4aa2-805e-a73d9b4d74e3`, warm
`18fe4fad-ab5e-4422-8663-306f6c9d237f`. Cache state was explicitly cold for the
first run; the second restored its completed snapshot. Both produced migration
digest `5c5832f97ad4b070be03e4796d2f403d8249e41959ed7bba77fc58c8c2daf487`.
Actual production results and final CI are recorded in
[PR #567](https://github.com/voidcraft-labs/commcare-nova/pull/567) after verification.

The preliminary trials in
[PR #563](https://github.com/voidcraft-labs/commcare-nova/pull/563) used synthetic
configuration, omitted Sentry upload, and transported compiler archives through
GCS. Their timings and machine-cost estimates do not describe the final path.
Larger-machine experiments were discarded; the deployed configuration retains
the existing default machine.

## Live migration API verification

The first optimized deployment stopped before traffic changed because its
migration Job PATCH used an unsupported `updateMask` query parameter. The
[Cloud Run Jobs API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch)
accepts a complete Job instead. The corrected gate preserves writable Job
metadata and the complete task template, changes only the image, includes the
verified etag, and omits output-only fields and execution tokens.

Cloud Run accepted the corrected request in `validateOnly` mode. The same gate
then updated the real Job and verified a successful execution of the immutable
migration image. A second invocation returned `mode=reused` without starting
another execution. These checks exercise both the changed-image and unchanged
image paths; they do not substitute for an application deployment.

Offline tests cover changed dependency namespaces, unavailable/corrupt caches,
invalid cache identities, and concurrent Job-template changes. Fresh and repeated auth
setup, cleanup schema/lease authority, and case-type retirement have integration
coverage. The full changed suite exposed a hard-coded OAuth test resource;
using the canonical resource passes the scoped integration and leak checks.
CI also exposed a popup geometry assertion reading a 4px inset during a scale
transition. The smoke test now waits for settled scale before measuring; the
layout requirement is unchanged.

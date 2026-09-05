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

## Benchmark method

The checked-in build-only configuration uses the same full runner image helper,
a fresh Cloud Build ID, synthetic public configuration, and a fixed synthetic
Action key. It verifies baked/runtime build identity, non-root runtime, command,
and Action key. It omits Sentry upload, app-image publication, database jobs, and
deployment. Timings therefore measure build work and cache costs, not a live
release or the complete production Sentry path.

The initial default-machine cold control was
`9f621656-cf4b-4f58-b5be-bff46163cc00`; it passed artifact verification and
published the first cache snapshot. Warm comparisons use the same dependency
namespace with changed source and fresh build IDs.

[Cloud Build list prices](https://cloud.google.com/build/pricing), checked on
5 September 2026, are $0.006/minute for the default e2-standard-2 and
$0.0156/minute for e2-highcpu-8 in us-central1. Queued time is excluded from
compute billing. The comparison uses list cost before free-tier credit and
excludes cache storage/network charges. Larger-machine adoption requires at
least 20% median end-to-end improvement and at most 25% higher compute cost.

The narrowed registry cache manifest and BuildKit configuration were inspected
for snapshot `581a91fe-7e43-4599-8b6d-4efc7a5171b9`: 12 cache records, with no
synthetic Action key or secret-value assignments in 7,659 bytes of metadata.

## Narrowed-cache result

The first warm comparison showed that exporting per-release compiler-result
layers cost about 80 seconds on the default machine. Those layers cannot be
reused under the next build ID. The final helper therefore exports registry
cache only through the reusable `jobs` stage and carries `.next/cache` through
GCS. Its first complete pair measured:

| Machine | Build-only total | Image build and cache export | Cache restore | GCS publication |
| --- | ---: | ---: | ---: | ---: |
| Default | 7m 03s | 4m 50s | 1m 07s | 0m 53s |
| E2_HIGHCPU_8 | 4m 12s | 2m 25s | 0m 48s | 0m 52s |

Build IDs: default `581a91fe-7e43-4599-8b6d-4efc7a5171b9`, larger machine
`8797e8a3-abba-4076-8f04-bea3eccdd799`. These samples cost about $0.042 and
$0.065 in build compute respectively, before free-tier credit. The larger
machine improves time but exceeds the 25% cost ceiling in this pair. The
pipeline retains the default machine. Repeated measurements and final CI
results are recorded in [PR #563](https://github.com/voidcraft-labs/commcare-nova/pull/563).

The build-only total includes cache publication. Production publishes that GCS
cache in parallel with image push and deployment work, so it is not generally
on the traffic-movement critical path. Conversely the benchmark omits Sentry
upload and all deployment work; it does not establish a new live-release time.
The additional artifact check inspects the compiled server deployment ID and
client release ID as well as runtime image configuration and Action encryption.

Offline tests cover changed dependency namespaces, unavailable/corrupt caches,
unsafe archives, and concurrent Job-template changes. Fresh and repeated auth
setup, cleanup schema/lease authority, and case-type retirement have integration
coverage. The full changed suite exposed a hard-coded OAuth test resource;
using the canonical resource passes the scoped integration and leak checks.
CI also exposed a popup geometry assertion reading a 4px inset during a scale
transition. The smoke test now waits for settled scale before measuring; the
layout requirement is unchanged.

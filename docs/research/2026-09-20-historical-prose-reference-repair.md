# Historical prose-reference repair

The July 31 canonical-identity cutover wrapped historical prose in literal text
parts. This lost the reference identity that Nova's editor, runtime, and CommCare
exporter use. Newer apps were not affected in the inspected production inventory.

## Scope and admission

The reviewed manifest contains 615 occurrences in 329 slots (327 labels and two
hints), across 93 live apps. The scan included recoverable deleted apps; none
required repair. Permanently deleted apps were outside the repair scope.

All references were resolved against immutable cutover baselines, then checked
against the current app. Eighteen historical own-case aliases were bound to their
original case type. One explicitly approved MUAC path correction was restricted
to its app, field, and token. A later Markdown edit was preserved exactly.

Each write held the app lock and required the reviewed Project, sequence, source
digest, baseline, and target digest. Occupied agent runs refused. Full canonical
admission preceded one system-attributed `blueprint-migration` history batch per
app. Compensation was tested against exact forward receipts and refused newer
edits. No app data was written through ad hoc SQL.

## Review and release evidence

- Implementation: [PR #639](https://github.com/voidcraft-labs/commcare-nova/pull/639),
  reviewed head `b7871046852d693988790176a6075de8b21b2e65`, merged as
  `6b0a518e7ebf7cbcaad1d1beb616fb92b6137e79`. Their Git trees are identical.
- Independent review found no material issues and checked every manifest mapping
  against production through read-only transactions.
- Local verification passed 65 focused tests, including real Postgres contention,
  atomic rollback, replay, compensation, retry, and persisted-data boundaries.
  All 24 final PR checks passed, including every test and browser smoke shard.
- Deployment build `947b2428-aa96-4a5c-aa22-2ee94f7cbc2f` succeeded. Revision
  `commcare-nova-00526-bzd` served 100% of traffic. Normal migration admission
  reused its unchanged verified artifact; it did not execute the repair.
- Manifest digest:
  `263059daaba6a679f03c7450cb43defaa5814deb6834d1031709f1f54d2d05b7`.
- Separate maintenance image:
  `us-central1-docker.pkg.dev/commcare-nova/cloud-run-source-deploy/commcare-nova/prose-reference-repair@sha256:9ed727cc1d247eef985e65bab44cbfcb90eff668289920fa33ff5b72c5d8ce2d`.
- Read-only execution `commcare-nova-prose-reference-repair-q6hrl`: 93 ready,
  zero blocked.
- Canary execution `commcare-nova-prose-reference-repair-lkxps`: one app committed,
  seven references in four slots. Independent reload matched its target digest
  and replayed history; four affected XForms passed the export oracle.

- Full execution `commcare-nova-prose-reference-repair-pmknm`: 92 apps committed,
  the canary deduplicated, zero blocked. Combined with the canary, all 93 apps
  received exactly one repair batch.
- Independent post-repair reload matched all 93 target digests, replayed every
  history, preserved all 329 editor round trips, evaluated restored runtime
  references, and validated all 236 affected XForms.

- The final read-only scan covered 463 live or recoverable apps and found zero
  remaining candidates and zero blockers.

- Retry execution `commcare-nova-prose-reference-repair-xdt4v`: all 93 apps
  deduplicated at their exact original repair sequence; zero additional writes.

Live UI inspection was unavailable: the browser's admin-policy verification
failed and denied access. This is a verification limitation. Editor serialization,
runtime prose resolution, and generated XForms were checked from production
snapshots; those checks do not claim a live UI observation.

No HQ app was republished and no production case was submitted. Existing HQ
copies require their normal re-upload/build/release to receive the repaired text.
Authoring UX work remains deferred.

## Retirement

The follow-up cleanup removes the scanner, writer, helper, repair-only tests,
Docker target and context exceptions, dedicated Job contract, execution override,
and temporary plan. The existing deployment contracts return exactly to their
pre-repair contents. No runtime compatibility reader, recurring migration, or
new authoring behavior remains.

The dedicated Cloud Run Job is deleted after the cleanup release is verified.
Its original contract is preserved in PR #639, and its image digest and successful
execution IDs are recorded above. Normal Cloud Logging retains execution logs.
Private local manifests are removed during worktree cleanup. Existing schema
migrations and the two ongoing Cloud Run Jobs are untouched.

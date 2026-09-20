# Historical prose-reference repair

Temporary explicit maintenance, followed by removal in a second PR. Ordinary
application releases never execute this repair. No schema changes.

The July 31 identity cutover preserved labels as literal text, losing dynamic
references. The inspected inventory is 615 occurrences in 329 label/hint slots
across 93 live apps. All have exact historical baselines. Eighteen occurrences
use the historical own-case alias. One explicitly reviewed MUAC path correction
is restricted to its exact app, field, and token. One later Markdown-only edit
retains the same original reference inventory and must remain byte-preserved.

## Execute

1. Run `node --import tsx --conditions=react-server scripts/scan-prose-references.ts
   --prod --output PRIVATE_DIRECTORY/prose-reference-manifest.json`. The scanner
   writes only local private output, and refuses to produce a manifest if any
   candidate is blocked. Review every mapping and bind its reported digest to
   the reviewed commit. Never commit production contents.
2. Build the Docker `prose-reference-repair` target from that commit with the
   private directory supplied as `--build-context prose-repair-manifest=...`.
   Pin/push the resulting linux/amd64 image digest. Its default is a read-only
   check of live source state and historical provenance.
3. Plan, then apply `manage-deployment.py job --job
   commcare-nova-prose-reference-repair --image REPOSITORY@sha256:DIGEST`.
   Use `deploy-cloud-run.py --execute-job` with that same job and image.
4. Run its default dry check. Execute the Household Registration canary with
   arguments `prose-reference-repair.cjs --execute --app APP_ID`; verify UI,
   persisted target digest/history, and exported output expressions.
5. Execute the manifest with `prose-reference-repair.cjs --execute`. Each app
   holds its own lock and atomically commits one system-attributed history batch.
   Occupied runs, changed versions/Projects/content, or invalid targets refuse.
   Any refusal exits nonzero. Investigate, rescan, and independently review
   changed entries; never widen the repair by bypassing admission.
6. Recheck target digests and replay, rescan for residuals, and execute again to
   prove no writes. Verify representative live chips, Preview, and exported
   XForms without submitting production cases or republishing to HQ.

`--rollback --app APP_ID` compensates only an unchanged target with its exact
forward receipt, through the same guarded commit. Newer edits refuse. Preserve
normal build/job logs, image/manifest digests and execution IDs for the record.

## Acceptance and retirement

Independent agent reviews the frozen code and private manifest. All required CI
must pass before squash merge. Verify the merged serving release before running
the explicit maintenance job. After repair acceptance, remove the new CLIs,
helper and repair-only tests, Docker/ignore additions, dedicated Job contract,
execution overrides, and this plan in a cleanup PR. Keep enduring behavior tests
only if they add independent value, plus a concise evidence record. Verify that
release, retain job execution evidence, then delete the dedicated temporary Job,
local manifests and task worktrees/branches. Existing shared maintenance jobs and
immutable schema migrations remain unchanged. Authoring UX is deferred.

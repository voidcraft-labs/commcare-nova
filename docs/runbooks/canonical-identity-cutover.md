# Runbook — canonical authored-identity maintenance cutover

**Status: NOT YET EXECUTED.** Delete this file only after the cutover has
completed in production and its terminal success latch is set.

This is the binding procedure for the one-time `20260728000000_canonical_identity_foundation`
cutover. It is an operational procedure, not a plan: the code it deploys is
already described in `docs/plans/complex-app-plan.md` under "What is built".
It lives here because a procedure that has not run yet is not history.

It is deliberately not an ordinary unattended merge. It closes public ingress,
holds the service at manual zero, fences the database ACL, and runs a forensic
repair that cannot be undone by transaction rollback once committed. Read the
whole file, including the rollback state matrix, before starting.

The scan is read-only and safe to run at any time:

```bash
npx tsx --conditions=react-server scripts/scan-canonical-identity-foundation.ts --prod
```

The repair defaults to a dry run that executes and rolls back; `--apply` needs
`--confirm 20260728000000-canonical-identity-repair-v2` and write authority on
`nova_case_runtime.cases`, which an ordinary operator IAM identity does not
hold.

---

The checked-in deployment path is permanent infrastructure, not a
cutover-only branch or flag. At the start of every deploy it records the
service's exact revision set and scaling mode and accepts only one of two
prestates: ordinary automatic scaling, or maintenance-owned manual scaling with
exactly zero instances. `gcloud run deploy` never passes `--scaling=auto`, so it
preserves that prestate while moving 100% traffic to the candidate. The script
then proves that the scaling mode did not change, the expected immutable digest
is Ready and owns 100% traffic, and every old revision owns 0% with no tag.
Finally it always performs the same separate service-level
`--scaling=auto` update and proves that it added no revision. At both the deploy
and scaling checks the candidate must be added and retained, no unexpected
revision may appear, and the only permitted removals are pre-existing untagged
zero-traffic revisions garbage-collected by Cloud Run. On an
ordinary later build the service began automatic, remained automatic, and that
last update is an idempotent no-op; on this maintenance cutover it began
manual-zero and only this step resumes instances, after the exact candidate is
the sole traffic owner. A deployment may not silently translate any other
scaling state.

The deploy verifier consumes production-shaped Cloud Run v2 responses. A
`LATEST` traffic target resolves through `latestReadyRevision`; explicit
revision names are normalized; desired and observed traffic are checked
separately; tags are forbidden; and the result is exactly candidate 100% with
every other live target at 0%. Revision retention may remove an old zero-traffic
revision under that same subset rule, but exactly one candidate is new and no
unexpected live target may appear. Image identity is the complete immutable
`repository@sha256:<digest>` value, never a comparison between a bare digest and
a full reference. Cloud Build resolves that immutable reference immediately
after push and uses it for the policy, migration, cleanup, and service
deployments; no destructive Job executes a mutable build tag. Before each
shared Job execution, the permanent helper proves one reconciled
generation/observed-generation and sole exact image, submits `jobs:run` with
that Job's `etag`, then proves the immutable Execution snapshot and every task
succeeded. An overlapping build therefore produces a generation conflict
instead of executing another build's image.

The permanent deployment path has a success latch and a guaranteed maintenance
recovery arm. Any failure after the canonical migration or after automatic
scaling resumes detaches the NEG if attached, restores and verifies manual-zero,
terminates runtime sessions, keeps cleanup paused, and preserves the original
failure. Every recovery action is attempted and its error retained even if an
earlier action fails. Scheduler state is recorded, restored by a trap on failure, and
rechecked after the cleanup probe; the maintenance execution requires the
pre-existing scheduler to remain `PAUSED`; Cloud Build proves that posture
before the first storage/database Job and again before updating cleanup.

Cloud Build's sequential steps are not the recovery owner. One operator-local
cutover orchestrator with its content-free action/evidence ledger stored as a
generation-matched object in a versioned operator bucket remains armed from the
pre-merge fence through public probes, the digest-bound audit scan and log gate,
final scheduler/configuration verification, and one successful cleanup
execution. A separately supervised watchdog reads that ledger, treats
orchestrator loss or stale heartbeat as failure, and applies
the same NEG-detach/manual-zero/session-termination/cleanup-paused arm. The
orchestrator disarms only after one explicit terminal-success latch; reattaching
the NEG is not success. The destructive migration Job has zero automatic task
retries. Any retry is a new orchestrator-controlled execution that first
reproves manual-zero, detached ingress, paused cleanup, exact ACL, complete
holder/session quiescence, and exact target image/configuration.

Production uses the binding maintenance-cutover procedure, not an ordinary
unattended merge:

1. Freeze the reviewed commit and complete the advisory scan plus a migration
   rehearsal against a restored production snapshot. Prove the rewrite, locks,
   UUID DDL, WAL growth, and full migration fit the Cloud Run migration job's
   1,020-second timeout; otherwise change and review that bound before cutover.
   On a production-shaped scratch service, also rehearse the exact serving
   control-plane sequence that the checked-in deploy implements: no traffic
   tags, manual-zero service scaling, candidate deployment with its default
   health check and database-backed startup probe while automatic scaling stays
   off, exact-digest Ready/100% assertions with every old revision stopped, then
   a separate scaling-only update to automatic that creates no revision.
2. Verify Cloud SQL PITR as secondary disaster-recovery evidence and a completed
   pre-drain on-demand backup for rehearsal. Record the exact serving
   revision/image; migration, media-policy, and capture-cleanup Job
   images, complete configurations, generations, and IAM policies; the
   scheduler's state, schedule, URI, auth, headers, and IAM policy; main-trigger
   state/IAM; and migration ledger. Neither PITR nor this backup is the
   authoritative cutover restore
   point: PITR creates a new instance and can lag the database clock, while
   legitimate requests may still commit after the pre-drain backup. An existing
   scratch target must have rehearsed restoring a production backup over itself,
   strict startup, and the complete old-workload rollback procedure. Freeze the
   resulting backup id, exported service manifest and hash, service IAM policy
   and hash, scaling/traffic/revision/image state, NEG target, and ACL evidence
   as cutover inputs.
3. Pause `commcare-nova-capture-cleanup`, detach the `nova-neg` serverless NEG
   from `nova-backend`, remove every Cloud Run revision traffic tag, and keep
   the three public hosts closed. Wait the full 3,600-second request bound, wait
   every cleanup execution through its 1,260-second bound, and prove no
   application request or runtime/cleanup write transaction remains. Only then
   set the service to manual scaling with exactly zero instances; this disables
   the service without creating a revision and prevents the old min-instance
   and its persistent LISTEN reconnect loop from starting again. Prove the
   control plane reports manual-zero scaling, no instance remains, and no
   tag-only revision exists. This drains chat, MCP, autosave, project moves,
   operator scripts, and capture cleanup without adding an application flag or
   traffic controller. Record the database ACL and effective-login inventory,
   ensure the migration owner has an explicit `CONNECT`, revoke `CONNECT` from
   `PUBLIC` and every non-migration login with effective application write
   authority, and terminate every non-migration session. A catalog query must
   then prove that no such session or inherited write path remains. Hold the
   service at manual zero and the database ACL fence through a stabilization
   interval, then prove again that no runtime session or reconnect appears.
   Repeat that proof after the role grants in step 5 while every old revision
   remains stopped. Operator use of the migration identity is frozen by the
   runbook. Before entering maintenance, impose an operator merge/build freeze
   that admits only the joint Unit 18/Unit 2 PR #349 exact-head merge and its
   named main build. Prove no other
   relevant Cloud Build or migration, media-policy, cleanup deployment, or
   cleanup execution is active at quiescence and again before ingress. The
   watcher aborts on any competing merge, trigger, build, or Job execution. The
   quiescence proof also requires the frozen complete holder derivation to find
   zero present app holders, zero thread stream/holder nonce, and no unexplained
   reservation remnant; terminal-less orphan chunk rows are allowed only
   because the transaction deletes the entire operational chunk log. With that
   fence held, create a fresh on-demand backup and wait until Cloud SQL reports
   it complete; record its backup id and the database clock. This
   post-quiescence backup is the authoritative restore point, and the fence
   proves no legitimate write can land after it. If the advisory scan found a
   topology defect, run the reviewed row-digest-pinned forensic repair manifest
   now, while the old schema is still the serving contract but every writer is
   fenced. One all-app repair transaction must prove every exact before digest,
   apply the approved Project-tenancy manifest and delete its one exact
   inaccessible test orphan, append the two topology-orphan-only property
   projections, delete the 42 exact topology roots, reconcile every affected
   lookup/media projection, apply the separately reviewed expression manifest,
   and append the attributed `blueprint-migration` plus `fold-baseline` changes
   for each surviving repaired app. The tenancy
   deletion first proves its full zero/one dependent inventory and has no
   reusable or inferred target. That
   expression manifest types the five proven references in the one affected
   label, clears its one unresolved token occurrence, and clears the two illegal
   catalog `validation` slots. Before commit, prove the exact
   effective-property metadata plus expected picker-order normalization,
   byte-identical `materializableCaseTypes`, case-store schema/index, XForm,
   suite, Preview, and summary for the topology repair; prove that the catalog
   clears change no current emitted form, that Preview and evaluated device
   label text remain equal for every form assignment, and that the only XForm
   byte difference is the digest-pinned deletion of the one invalid output
   node. The transaction rolls back as a whole if any proof fails. Neither
   repair may infer from a path string, and every source/replacement digest must
   match. Rerun the locked
   scanner and require zero topology, illegal catalog-expression, or
   unresolved-reference findings, zero null/blank app or case Projects, zero
   missing Project targets, and zero mismatched case/app tenants. A failure
   rolls that repair transaction back; an ambiguous row stops the cutover. The
   pre-repair backup remains the authoritative rollback point. Before merge, arm an
   operator-local one-shot watcher keyed to joint PR #349, its frozen combined
   Unit 18/Unit 2 head SHA, reviewed base SHA, and named main trigger. After
   exact-head squash
   merge, it resolves the PR's resulting merge commit, verifies its parent/base
   and tree against the frozen merge result, then requires the named main
   build's source commit to equal that merge commit. Only then does it bind the
   build id and immutable Artifact Registry digest from Cloud Build metadata; it
   refuses any revision whose reported digest differs. Once that target build is
   bound, the orchestrator disables further trigger admission, verifies no
   competing build is queued or running, and temporarily narrows control-plane
   update/execute IAM so only the target Cloud Build identity and cutover
   orchestrator can touch the named service, Jobs, scheduler, or NEG. Immediately
   before every Job update and execution it rechecks target build id, Job
   generation, complete configuration, immutable image, and IAM, rejecting any
   manual execution. The recorded trigger and control-plane IAM state is restored
   only at terminal success or completed rollback. It may reattach the existing
   NEG only after the later strict runtime proof and exact new-revision
   conditions succeed, but remains armed through the terminal-success latch.
4. Only after quiescence, exact-head squash-merge joint PR #349 at its frozen
   combined Unit 18/Unit 2 head. Its normal main trigger builds that exact image,
   then the migration Job takes
   deterministic all-app locks and one migration-owned transaction and reruns
   the blocking scanner. This scan is authoritative: it records a fresh
   quiescent digest and aborts on any topology/unresolved-reference finding,
   current unmigratable finding, live
   writer, inventory/schema-version mismatch, or capacity bound violation — not
   on ordinary drift from the earlier advisory snapshot. The transaction
   executes the dispatcher's exact `rewrite-current` plan and proves zero
   `block-current` findings. Inside that transaction it constructs every
   rewritten candidate, final-parses each complete assembled Blueprint and
   remaining current event, and only then persists those candidates. After all
   candidate and index proofs pass, it archives every existing mutation event
   while changing both `events.event.kind` and the projected `events.kind`
   column atomically, migrates typed event attachments, writes all exact
   `app_changes` rows and immutable Project-bearing
   `app_change_fold_baselines`, deletes every presence and
   `chat_stream_chunks` row, strictly parses every `lookup_rows.values` object
   and validates every key against its exact table/column context while
   preserving the complete `lookup_rows` table byte-for-byte, converts the SQL
   columns, makes
   `apps.project_id` and `cases.project_id` nonblank and `NOT NULL`, adds the
   named deferred composite case/app tenant foreign key, rebuilds constraints
   and indexes, and commits only when every invariant and post-horizon baseline
   proof passes. The four Better-Auth-Project foreign keys belong to the
   Nova-owned auth-app migration that runs later in this same migration Job:
   `apps.project_id`, `app_changes.from_project_id`,
   `app_changes.to_project_id`, and
   `app_change_fold_baselines.project_id`. It runs after Better Auth creates
   `auth_organization`; a fresh database must not
   depend on that table existing during the earlier case-store migration. A
   noncanonical lookup-row key is a locked-scan blocker rather than an input to
   runtime lowercasing. The migration's `down` entrypoint throws
   an explicit forward-only error so Kysely can never remove its ledger row while
   leaving the UUID schema in place. The Job configuration pins
   `maxRetries: 0`; the orchestrator alone may start a later fully refenced
   execution.
   The following case-schema index-convergence DDL cutover first locks and
   classifies its complete catalog and data. Only the exact source shape runs
   plain DDL and seeds `index_pending_seq = synced_seq`; the exact final shape is
   a no-write audit that preserves a legitimate newer pending sequence. Any
   partial, wrong-type/default/index/constraint, extra, or duplicate shape
   blocks, and its `down` is forward-only.
5. Still inside the exact new image's migration entrypoint and before service
   deployment, run Better Auth's own migrations and then the Nova auth-app
   migration. The latter verifies every surviving referenced Project exists and
   adds the four exact named, validated foreign keys above with restricted
   update/delete actions; unknown Project rows or any
   alternate definition fail the Job. It locks the app and Project relations
   and inventories the complete `project_id` column/index plus local and
   referencing constraint set before its first write; alternate-name duplicate
   FKs, alternate actions or deferrability, `NOT VALID`, and partial/extra
   objects block. An exact applied rerun is read-only and its `down` is
   forward-only. Then converge to the final explicit
   database ACL: only the migration,
   runtime, cleanup, and dedicated audit identities regain their intended
   `CONNECT` and least-privilege grants; the audit identity has only the exact
   `SELECT` privileges required by the scanner and no DML or role inheritance.
   `PUBLIC` and incidental operator logins do not regain access.
   Keep the service at manual zero with no traffic tags, terminate any direct
   runtime-login session again, and prove none exists after the grant. From the
   migration connection, `SET ROLE` to the runtime database role and run the
   zero-finding steady-state parser plus an authorization-aware app read and
   rollback-only synthetic write through the real membership/commit primitives,
   using an existing Project member without emitting their data. This proves the
   final runtime privileges while no old runtime process can reconnect. Record
   the authoritative digest. The runtime probe runs the complete steady-state
   domain validator plus local and Project-scoped reference-index checks; it
   never hardcodes a zero parser result or hides an eligible editor behind an
   arbitrary row limit.
   Separately execute the new cleanup image's strict schema probe under the
   cleanup identity while its scheduler remains paused, and prove the Cloud
   Build update did not unpause it. Either failure stops Cloud Build with
   ingress closed; this is the required proof that the new runtime and
   independent writer can use the migrated shape, not an external probe after
   public writes have resumed.
6. The service stays at manual zero while the trigger deploys the same exact
   image without disabling Cloud Run's deployment health check and without
   passing `--scaling=auto`. The permanent deploy script records and requires
   the maintenance prestate to be manual-zero; the external watcher fails the
   build if the script instead reports the ordinary automatic prestate. Manual
   scaling ignores revision minimum/maximum settings, so every old revision
   stays stopped while the deployment health check starts only the candidate
   and its database-backed `/warmup` probe passes under the real runtime login.
   After `gcloud run deploy` returns and before scaling changes, assert that the
   service is still manual zero, the exact new immutable digest is Ready and
   owns 100% traffic, and every old revision is at 0% with no tag. Prove zero
   old runtime session or log activity after the post-grant fence. Then let the
   same permanent path issue its unconditional service-level
   `--scaling=auto` update, prove the same candidate/allowed-removal revision
   subset rule with no addition, and verify the expected automatic
   minimum/maximum scaling. Because only the exact new
   revision owns traffic, it is the only revision that can start. Prove its
   fresh runtime-login connection and authorization-aware read before the build
   may continue; `/warmup` plus `SELECT 1` alone is not that proof. If any
   post-migration Cloud Build phase fails, ingress and
   cleanup stay paused; return the service to manual zero and terminate runtime
   sessions. Before ingress resumes, the authoritative in-place backup restore
   remains available.
7. Only after steps 5–6 succeed does the armed one-shot reattach `nova-neg`; that
   timestamp is the recorded rollback cutoff because public writes may begin
   immediately. Cloud Build's retrying public-host probes then verify routing,
   and the orchestrator starts a scanner/probe Job from the exact target
   `repository@sha256` image under the dedicated audit identity. Its immutable
   entrypoint opens a read-only transaction, emits only the content-free report
   plus its digest, and must match the expected zero/post-horizon result. It then
   inspects the error-log gate. Any failure in those probes, scan, or log gate
   immediately detaches the NEG, returns the service to manual zero, terminates
   runtime sessions, and leaves cleanup paused before fix-forward begins.
   Resume cleanup only after every check passes, then verify the scheduler is
   `ENABLED` with the exact recorded/new schedule, URI, auth, headers, Job
   generation/configuration/IAM, and immutable target image; wait for and verify
   one successful cleanup execution. Scheduler resume or execution failure uses
   the same recovery arm. Only then restore trigger/control-plane IAM, set the
   terminal-success latch, and disarm the orchestrator and watchdog. They are
   disposable operator orchestration, never checked-in runtime or deployment
   machinery.

The orchestrator records and enforces this rollback/fix-forward state matrix;
each transition stores its evidence before the next begins:

| State | Required evidence | Failure and retry |
| --- | --- | --- |
| Source unmerged; forensic repair uncommitted | Original source/build/Jobs/ACL/scheduler inventory | Roll back the open transaction and restore recorded configuration; a retry restarts the full drain. |
| Forensic repair committed; canonical migration uncommitted | Repair horizon/digests and authoritative pre-repair backup | Backup restore is mandatory before old workloads; if source was merged, the exact revert-build path is also mandatory. |
| Canonical migration committed; automatic scaling not resumed | Migration ledger/baselines/DDL/ACL digests; manual-zero and NEG detached | Restore the authoritative backup and follow the exact revert-build path; a forward retry first repeats every fence and probe. |
| Automatic scaling resumed; NEG detached | Candidate digest/traffic/revision subset and runtime proof | Return to manual-zero, terminate sessions, then either restore-and-revert or repeat the fully fenced forward deployment. |
| NEG attached; cleanup scheduler still paused | Public-ingress timestamp plus passing target revision/runtime proof | Detach NEG, return to manual-zero, terminate sessions, keep cleanup paused, and fix forward; backup restore is forbidden because public writes may have landed. |
| Cleanup scheduler enabled; terminal latch unset | Exact scheduler/Job config and target image | The same detach/manual-zero/session-termination/fix-forward arm remains active until one cleanup execution and every terminal proof pass. |
| Terminal success latched | Public probes, audit scan digest, log gate, cleanup execution, trigger/IAM restoration | Disarm; later incidents use ordinary production recovery, not this cutover rollback. |

Rollback before the all-app repair transaction commits, including an earlier
build/media-policy failure, is transaction rollback plus restoring and
verifying the recorded pre-fence database ACL, old media-policy and
capture-cleanup Job images/configuration/IAM, complete scheduler
configuration/IAM, trigger/control-plane IAM, and scheduler state. Route 100% to the
exact recorded old revision, restore and verify its recorded traffic/tag and
automatic-scaling configuration, and prove the old runtime and cleanup schemas,
but keep the NEG detached until the source-control closure below. Once the
repair transaction commits, rollback restores the authoritative backup even if
the later canonical migration has not started or committed; transaction
rollback/config restoration alone cannot undo that committed repair. After the
canonical migration commits, no down migration and no old revision is allowed
against the migrated database. In either post-repair case and until the explicit
NEG reattachment cutoff, rollback means returning the service to manual zero,
terminating runtime sessions, and restoring the completed authoritative backup
**in place** over the existing `nova-cases` instance, preserving its connection
name. Verify the restored settings, IAM database users, and migration ledger;
then explicitly reconverge and verify database flags, backup/PITR
configuration, networking, connection identity, IAM database users, migration
ledger, and the recorded pre-fence ACL because an in-place restore may preserve
target settings while resetting backup defaults and the authoritative backup
contains the fenced ACL. Restore the recorded old service
and cleanup images, 100%-old-revision traffic, traffic tags, automatic scaling,
every Job configuration/IAM, and complete scheduler configuration/state; prove
both old workload schemas while ingress remains closed.

The merge/build freeze remains in force through either rollback path. Returning
to old production is not complete while the joint Unit 18/Unit 2 merge still
sits on `main`: revert that exact PR #349 merge, require the named main trigger's
source commit to equal the revert commit, and verify its old service image,
migration ledger behavior, all three Job configurations, and restored database
together before restoring ingress and releasing the freeze. Before triggering
that revert build, arm a fresh
one-shot rollback watcher keyed to the exact revert commit, named build, and
fresh revert-build image it will resolve. The recorded old digest remains
pre-cutover evidence, not the expected output of a new build: the revert build
has a new deployment id and therefore a new immutable digest. The watcher binds
that fresh `repository@sha256` from the exact revert build and uses it for the
service and every restored Job, so rollback does not depend on the recorded old
revision surviving Cloud Run garbage collection. The NEG remains detached
through the restore, old schema/ledger/Job proofs, and the revert build's deploy.
Reverting Unit 18 also restores the prior `cloudbuild.yaml`, whose public-host
verification begins immediately after deploy and retries for a bounded window.
Once the watcher observes that exact revert build's deploy step complete, the
fresh revert digest Ready at 100%, the restored database and all three Jobs
proven together, and no competing source/build/job activity, it reattaches the
existing NEG exactly once while those public retries are still active. Those
probes must then pass inside the build; the revert build cannot turn green on
internal evidence alone. A missed retry window or any failed/mismatched proof
fails the build, detaches the NEG again if necessary, returns the service to
manual zero, terminates runtime sessions, and keeps cleanup paused. If the
revert build cannot produce and prove its image, ingress stays closed and the
only alternative is fix-forward. This is the rollback path's only ingress
reattachment point. Old production never reopens with the strict new source
silently pending on `main`. PITR is not the restore path because PostgreSQL PITR
always creates a new Cloud SQL instance. Once the NEG is reattached after the
forward cutover, the only path is fix-forward with the NEG detached, service at
manual zero, runtime sessions terminated, and cleanup paused; a partial table
restore or replay across the horizon is forbidden.

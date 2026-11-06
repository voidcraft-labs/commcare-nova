# Retiring per-property case indexes

This release requires an approved maintenance window. **Do not merge this stack
through the ordinary automatic release path before the cutover is prepared.**
The old application writes index-convergence columns and performs property DDL;
the new migration removes that contract. The new application also stops
pre-dropping old numeric indexes before retyping values. Existing expression
indexes must therefore be retired before the new schema and application run.

## Evidence and final behavior

The November 6 read-only production investigation found 7,327 indexes on `cases`
for 456 rows across 31 apps. There were 5,563 text, 1,081 integer, 448 numeric and
234 array expression indexes, plus the primary key. Two database backends failed
on November 5 with `out of shared memory` and PostgreSQL's
`max_locks_per_transaction` hint. The instance used 64 locks per transaction and
25 connections. Adding authored properties grew the relation-lock and planning
burden for every app, even apps with no records.

The final application uses only the primary key and two fixed indexes:
`cases_project_app_type_idx(project_id, app_id, case_type)` for tenant reads and
`cases_app_type_idx(app_id, case_type)` for app-scoped schema work. The expression
compiler still owns filtering; property predicates evaluate after the indexed
scope restriction. Index count no longer grows with apps, case types or
properties. Schema changes and row reshaping commit in one transaction with no
post-commit DDL queue, watermark or completion callback. The runtime role loses
CREATE on the case schema.

Native proof grows a schema to 2,500 properties without adding an index, then
executes a production-compiled numeric filter and checks the actual PostgreSQL
plan against 20,000 unrelated records. This establishes fleet isolation of the
scan, not a latency guarantee for an individual app with millions of records.
Large individual app workloads need measured query-specific design, not eager
fleet-wide indexes for every possible property.

## Prepare without changing production

1. Retain the reviewed stack heads, green CI, independent reviews, current
   serving revision/image, migration image and Job contracts. Build the exact
   reviewed `maintenance` Docker target and publish its immutable digest using
   the deployment instructions. The maintenance target includes
   `case-expression-index-scan.cjs` and `case-expression-index-retirement.cjs`.
2. Run the advisory scan as the existing read-only operator identity:

   ```bash
   npx tsx --conditions=react-server scripts/scan-case-expression-indexes.ts --prod
   ```

   Preserve the complete JSON privately. The scan checks the exact index name
   hashes, property expression, app/type predicate, access method, operator
   class, owner, key count and absence of a uniqueness/constraint role. It also
   recognizes removed properties through their exact historical catalog
   spelling, without trusting a current schema to describe past indexes.
   An unknown expression index is a blocker, never an automatic drop candidate.
3. Verify a Cloud SQL restore point and a tested restoration procedure, available
   database capacity, the approved ingress controls for **all three hostnames**,
   scheduled capture worker and other database writers. Record the exact old
   ingress and Scheduler settings to restore. Reserve an operator window long
   enough for 7,326 individually committed concurrent drops; no duration is
   claimed from a local test. No scanner or merge approval authorizes production
   changes by itself.

## Verified controls and drain checks

Read-only inspection on November 6 found `nova-url-map` routes all HTTPS hosts
through global `nova-backend`, which attaches `nova-armor`. The earliest rule was
priority 90; priorities 5 and 10 were unused. Cloud Run's default URL was disabled,
ingress was `internal-and-cloud-load-balancing`, and the only traffic target was
an untagged revision at 100%. Recheck these facts at the window. A changed routing
path, existing rule at either reserved priority, or tagged URL is a blocker.

Save private JSON snapshots with these read-only commands before any change:

```bash
gcloud compute security-policies describe nova-armor --project=commcare-nova --format=json
gcloud compute url-maps describe nova-url-map --global --project=commcare-nova --format=json
gcloud compute backend-services describe nova-backend --global --project=commcare-nova --format=json
gcloud run services describe commcare-nova --region=us-central1 --project=commcare-nova --format=json
gcloud run services get-iam-policy commcare-nova --region=us-central1 --project=commcare-nova --format=json
gcloud scheduler jobs describe commcare-nova-capture-cleanup --location=us-central1 --project=commcare-nova --format=json
gcloud run jobs executions list --region=us-central1 --project=commcare-nova --format=json
```

The currently deployed Scheduler is enabled every five minutes. Pausing it stops
new dispatches, not an execution already running. Inspect each unfinished
execution with `gcloud run jobs executions describe EXECUTION --region=us-central1
--project=commcare-nova --format=json`; wait for terminal success or investigate
failure. Do not cancel a worker mid-write. Stop other operators and deployment
submissions for the window; an idle migration Job is not a fence against a new
Cloud Build. The release merge itself stays pending until step 5.

Through the authenticated operator's read-only Cloud SQL connection, take these
SQL snapshots in a **new transaction on each observation**:

```sql
SELECT current_user,
       pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS full_activity_visibility;
SELECT pid, usename, application_name, state, xact_start,
       wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
ORDER BY usename, pid;
SELECT id, status, awaiting_input, run_id, lock_run_id, lock_expire_at,
       res_run_id, res_period, res_settled
FROM public.apps
WHERE status = 'generating' OR lock_run_id IS NOT NULL
   OR (res_period IS NOT NULL AND res_settled IS DISTINCT FROM true);
SELECT id, state, awaiting_input, run_id, run_lease_expires_at,
       res_run_id, res_period, res_settled
FROM public.design_sessions
WHERE run_id IS NOT NULL
   OR (res_period IS NOT NULL AND res_settled IS DISTINCT FROM true);
SELECT thread_id, app_id, design_session_id, run_id, active_stream_id, active_holder_nonce
FROM public.threads
WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL;
```

`full_activity_visibility` must be true for the backend snapshot to prove a
drain. Read-all-data alone does not expose other roles' activity: NULL activity
fields under insufficient privilege are **not evidence of idle connections**.
If the operator lacks statistics visibility, have an already authorized database
administrator collect this snapshot; do not grant extra permissions or proceed
on hidden data as an incidental release step. Require no active/idle-in-transaction
application backend, no unfinished worker/migration execution, and no unresolved
live run/stream. Idle pools and a dedicated LISTEN connection can remain. Inspect
any persisted paused or stale holder with the existing `inspect-logs.ts` or
`inspect-design-session.ts --help` workflow and account for its reservation; do
not erase it or infer settlement from an expired lease. Observe again after all
in-flight requests have completed. Cloud Armor blocks new requests, but does not
cancel an existing stream or internal work. Any internal caller that bypasses
the load balancer must be stopped and identified before this proof is sufficient.

## Approved cutover

1. Add a temporary edge deny rule and pause the Scheduler. These are explicit
   maintenance mutations, to execute only within the approved window:

   ```bash
   gcloud compute security-policies rules create 10 \
     --security-policy=nova-armor --project=commcare-nova \
     --src-ip-ranges='*' --action=deny-403 \
     --description='Temporary case-index retirement maintenance'
   gcloud scheduler jobs pause commcare-nova-capture-cleanup \
     --location=us-central1 --project=commcare-nova
   ```

   Confirm the rule is enforced (`preview: false`) and all three external URLs
   return 403: `https://commcare.app/`, `https://docs.commcare.app/`, and
   `https://mcp.commcare.app/mcp`. Confirm Scheduler state is PAUSED. Complete
   the execution, durable-holder and database drain checks above; retain the
   evidence. Do not change service scaling, ingress, IAM or revision traffic.
2. Take the final restore point. Rerun the read-only scanner while writers remain
   stopped. Inspect its zero-blocker inventory and copy its `digest` into the
   writer invocation. The pre-window digest is advisory and cannot substitute
   for this frozen scan.
3. Provision the migration-authority historical-repair Job with the reviewed
   immutable maintenance image. The November 6 inventory contained only migrate
   and capture-cleanup Jobs, so do not assume this Job exists. Inspect the plan,
   then apply it inside the approved window:

   ```bash
   python3 scripts/infra/manage-deployment.py job \
     --job commcare-nova-historical-repair --image "$NOVA_MAINTENANCE_IMAGE"
   python3 scripts/infra/manage-deployment.py job \
     --job commcare-nova-historical-repair --image "$NOVA_MAINTENANCE_IMAGE" --apply
   ```

   Execute through the fenced runner, which verifies the declared
   one-task/zero-retry contract:

   ```bash
   python3 scripts/rollout/deploy-cloud-run.py --execute-job \
     --project=commcare-nova --region=us-central1 \
     --job=commcare-nova-historical-repair \
     --image="$NOVA_MAINTENANCE_IMAGE" --wait-seconds=3060 \
     --execution-arg=case-expression-index-retirement.cjs \
     --execution-arg=--scan-digest --execution-arg="$NOVA_INDEX_SCAN_DIGEST" \
     --execution-arg=--writers-stopped
   ```

   `--writers-stopped` is an operator assertion, not an ingress controller. The
   writer rechecks the complete digest before its first drop and the exact OID,
   definition and owner before each subsequent drop. Each `DROP INDEX
   CONCURRENTLY` commits independently so the transaction never accumulates
   thousands of locks. A failure keeps ingress blocked. Rescan the remaining
   inventory, inspect it and rerun with its new digest; a stale digest refuses.
4. Rerun the scanner independently and require zero candidates and zero blockers.
   Archive scan and Job evidence under the private cutover evidence bucket.
5. Resume the capture Scheduler **before** starting the normal release, while
   the edge deny rule stays in place:

   ```bash
   gcloud scheduler jobs resume commcare-nova-capture-cleanup \
     --location=us-central1 --project=commcare-nova
   python3 scripts/infra/manage-deployment.py check
   ```

   The release prerequisite requires Scheduler state ENABLED; leaving it paused
   would block Cloud Build before migration. The existing worker only changes
   `form_attachments` and capture objects, so resuming it after index retirement
   cannot recreate case indexes or touch removed case-schema metadata. Inspect
   the next worker execution and require success. If worker code also changes
   in the reviewed stack, build/update its independent `capture-worker` image
   explicitly using its checked-in Job contract before resuming it. The app
   release does not update that image.

   Now merge/apply the exact reviewed release through normal migration/deployment
   machinery while public ingress remains blocked. The registered retirement migration
   refuses any remaining case expression index before dropping the obsolete
   queue/columns and updating disposable test-namespace creation. The next
   migration creates the two fixed scope indexes. Privilege convergence and the
   rollback-only fleet/runtime probe must pass. Verify the serving revision is
   Ready with 100% observed traffic on the exact release image.
6. Before opening public ingress, verify the case index catalog is exactly the fixed
   set, no obsolete marker columns/table remain, runtime CREATE is absent, and
   real scoped preview reads, sample-data writes, property rename/retype,
   authoring save and an isolated app test succeed. For authenticated browser/MCP
   checks, allow only the named operator's stable public CIDR ahead of the deny
   rule after the new revision is proven Ready:

   ```bash
   gcloud compute security-policies rules create 5 \
     --security-policy=nova-armor --project=commcare-nova \
     --src-ip-ranges="$NOVA_OPERATOR_CIDR" --action=allow \
     --description='Temporary operator verification for case-index retirement'
   ```

   Verify an external address outside that CIDR still receives 403. This allow
   rule bypasses later Armor rules for that operator, so remove it with the
   deny rule immediately after verification. Confirm case counts and app
   identities against the frozen baseline and account for the intentional smoke
   writes. Inspect Cloud Logging/Sentry for lock, schema, privilege and cast
   failures, then restore normal public traffic:

   ```bash
   gcloud compute security-policies rules delete 5 \
     --security-policy=nova-armor --project=commcare-nova
   gcloud compute security-policies rules delete 10 \
     --security-policy=nova-armor --project=commcare-nova
   ```

   Compare the final policy to the saved snapshot, verify the Scheduler remains
   ENABLED with its original schedule, and check ordinary traffic again. Never
   delete a pre-existing rule: this procedure requires both priorities to have
   been vacant before the window.

## Failure and rollback

Before the first drop, restore ingress only after confirming no state changed.
During retirement, keeping writers stopped and retrying from a reviewed remaining
inventory is the normal recovery. Dropped indexes contain no unique data; however,
restarting the old application can recreate thousands of them, so that is not a
completed rollback. After metadata migration, the old application is incompatible.
Keep ingress blocked and either repair forward with the exact new contract or
restore the frozen database and old application together. Never route an old
revision onto the new schema. Resolve NOVA-6H and related index-convergence issues
only after this production proof, not when the PR merges.

# S02c runtime-capability rollout

**Status:** S02c1 shipped in PR #300 and is live as
`commcare-nova-00354-dq4`; S02c2 deployment hardening is in progress on
`agent/s02c2-simple`. This document records the checked-in contract and its safe
verification commands. Nova uses the ordinary Cloud Build → blocking migration
Job → Cloud Run deployment path; this slice adds no custom traffic controller.

## Source of truth

`config/runtime-capabilities.json` is the only authored capability manifest:

| Declaration | S02c1 value |
| --- | ---: |
| Schema | 1 |
| Lookup-reference writer | 0 |
| Stream receiver | 1 |
| Runtime reader | 1 |
| Stream registry | 1 |
| Cloud Run request cap | 3,600 seconds |
| Stream lease grace | 300 seconds |
| Derived stream lease TTL | 3,900 seconds |
| Renewable edit-run lease | 900 seconds |
| Renewable build-staleness horizon | 600 seconds |

Only request cap plus grace derives the 3,900-second stream lease. The edit and
build liveness clocks are separate authored manifest fields: neither derives
from the stream lease nor bounds a detached SA run's total lifetime.
`lib/db/constants.ts` projects them to its legacy minute-valued names without
owning another duration literal.

`lib/runtimeCapabilities/core.mts` owns strict parsing, canonical
serialization, generated environment/label shapes, and the fail-closed parser
for deployed declarations. `lib/runtimeCapabilities.ts` is the validated,
browser-safe accessor. Node hashing is quarantined in
`lib/runtimeCapabilities/serverHash.mts`, with `server.ts` as the marked Next
server entry. A missing, padded, signed, fractional, overflowing, or otherwise
malformed version declaration is v0. The transaction-local lookup writer
declaration derives from `writerVersion`.

## Stream receiver admission

Every browser EventSource URL must carry exactly one `receiverVersion` from the
capability manifest compiled into that browser bundle. Missing, duplicate,
padded, signed, fractional, overflowing, or otherwise malformed declarations
are v0. A serving revision supports the minimum of its compiled receiver and
its strictly parsed deployed-environment receiver, and supports only v0 unless
both its compiled and deployed stream-registry declarations are at least 1.
The admitted lease version is the minimum of browser and serving support. This
keeps a newly deployed server from attributing v1 support to an already-open old
browser bundle.

Each lease uses a database-minted connection UUID. The server never accepts a
client-asserted connection identity.

`lib/db/streamReceiverCapabilities.ts` implements this calculation as a pure
server-side boundary. The stream route now authenticates first, then registers
the admitted receiver and a database-minted UUID in one app + serialized fresh
membership + compatibility transaction. PostgreSQL statement time authors the
lease after lock waits and expiry is exactly 3,900 seconds later. A below-floor
request creates no lease or subscription and receives only a seq-less
`client-upgrade-required` revocation. Teardown disowns the stream first and then
best-effort deletes that exact app/connection lease; expiry covers a crash or
failed cleanup. Cadence reauthorizes the captured Project/role/canEdit tuple but
does not re-read the floor, so a floor raise affects new connections only.

`ReconcilerProvider` now appends the manifest's compiled `receiverVersion` to
every EventSource URL, so newly built v1 browser bundles declare v1. An already
open pre-wiring bundle still omits the parameter and therefore declares v0.
All compatibility floors remain 0, so the landed wiring is intentionally
non-activating until the old leases and request epoch are drained.

## Runtime-holder writes

Chat attribution and holder authority are deliberately separate. `runId`
remains the stable thread/run attribution visible in events and summaries; each
claim also mints a private UUID nonce. The database-defined holder is therefore
`(mode, runId, nonce)`: a build reads its run id from the reservation after
booking and from root `run_id` only in the just-created pre-reservation window;
an edit reads it from `lock_run_id`. `apps.run_holder_nonce` stores the current
generation, while `threads.active_holder_nonce` stores only the continuation
capability for that thread. A loader projects the latter as transient
`holder_nonce` only to the actor who owns the exact paused app holder; it never
enters message history or the public thread metadata. The live POST sends the
nonce directly to its authenticated caller, while `DurableStreamWriter` stores
only a count-preserving private marker (thread id plus SHA-256 nonce digest) in
the view-scoped chunk log. Reconnect rehydrates that marker from the thread's
retained nonce plus current app holder only for the owning actor; a co-member
receives the inert marker, preserving cursor math without receiving the
capability. The digest also prevents an old same-run stream from receiving a
successor claim's fresh nonce after the paused stream marker has cleared.

The manifest runtime reader is v1. Every current holder-touching transaction
declares it before DML: creation, claim/replacement, reservation, paused
reacquisition, same-holder blueprint commits, heartbeats/pause writes, and all
terminal/failure/reaper/recovery paths. The declaration identifies the current
writer, not ownership of an existing holder: below cutoff an exact unchanged
legacy holder stays v0 and census-visible. Only a genuinely new/replaced v1
holder must have a concrete run id + nonce and receives a v1 stamp; an unchanged
holder whose old stamp is below the active floor fails closed. An absent
declaration is deployed v0 and clears an inherited nonce/version even when a
stable thread id leaves `(mode, runId)` unchanged. Releases clear the runtime
stamp but retain the nonce as the last-holder/reaper tombstone; they still pass
the floor check, so undeclared old terminal writers fail after cutoff. The trigger also
fires on `awaiting_input`, `lock_expire_at`, and `updated_at`, because the
deployed v0 paused-resume paths set no runtime GUC and update only those
pause/lease columns. Migration replay clears only present null-nonce holders,
so it cannot erase live v1 state.

`lookup_reference_compatibility.run_holder_nonce_enforced` is the activation
switch and defaults to `false`. While false, lifecycle admission and SQL CAS use
the legacy `(mode, runId)` projection, so old browser continuations without a
nonce remain accepted. A paused v0 resume mints and stores a fresh server nonce
in its app-locked write and returns that authoritative value to the client. Once
the switch is true, missing or mismatched nonces fail closed with an explicit
refresh response. The switch can change only `false → true`, and a database
constraint forbids enabling it below runtime-reader floor 1.

Every lifecycle/credit transaction locks the app first, then holds the
compatibility singleton `FOR SHARE`, then touches any credit rows. Terminal,
failure, finalization, pause/heartbeat, and reaper updates repeat the currently
admitted holder predicate in SQL; credit writers require exactly one affected
app row after any ledger refund or throw to roll the transaction back. Chat
blueprint writes carry the full generation as `ChatRunHolderCapability`, while
MCP's ordinary `runId` remains attribution only. Migration Phase A checks the
capability while holding the app row, and the final committed-batch app update
repeats it. Every build claim stamps root `run_id` before any mutation, so even
a no-mutation successor remains the latest-claim fence after reap.
Thread-marker installation follows the same app-row-first compatibility proof
before locking the thread. A run that loses ownership in the claim-to-persist
window may merge its real incoming transcript into an existing same-app thread,
but it cannot install or clear the successor's run id, stream id, or holder
nonce; the committed merge is followed by a terminal holder-lost result.
Reaper queue entries include the identity observed by their scan; never enqueue
or invoke a reaper with a bare app id, because a delayed bare-id reap can target
a replacement that later becomes stale. The source guard in
`lib/db/__tests__/runHolderWriteGuard.test.ts` pins the app-DML authorities,
manifest declarations, exact predicates, reaper signatures, and recovery CLI
delegation. The scan must narrow the identity to a concrete non-empty run id.
A present `(mode, null)` holder is corrupt, not canonically reapable: it cannot
distinguish one corrupt generation from a later one, remains a blocking v0
census row, and requires explicit data repair.
The only absent-holder completion is the exact false-reap signature: free error
row, marker run id cleared by the reaper, and matching root `run_id`. A build
whose marker was already settled retains `res_run_id` through the stale reap and
is intentionally not self-healable.

`scripts/recover-app.ts` remains dry-run by default. A free app can be recovered
with `--confirm`; a present holder requires all three explicitly verified flags:
`--holder-mode`, `--holder-run-id`, and `--holder-nonce` (a UUID). Operator
recovery is always exact-generation authority even while runtime compatibility
is still false; a v0/null-nonce or otherwise corrupt holder cannot be proven and
the tool refuses it. The confirmed writer re-locks the app and repeats the
free/exact-holder condition in SQL, so the preflight display is never write
authority. Recovering an exact build holder settles its reservation as a kept
charge while releasing the build through the status transition; recovering an
edit repairs status/error only and leaves its proven lock and marker in place.

## Non-blueprint side effects

The source audit found one SA tool with a write behind a read-shaped tool
contract: `remove_media_asset`. Its metadata delete now runs in the same
app-locked transaction as fresh Project/edit authorization, compatibility
`FOR SHARE`, and the holder predicate. GCS object and extract cleanup runs only
after that transaction commits; losing the holder, Project, or authorization
latches a terminal run error. This is a narrow zombie-delete fence, not the
complete attach/delete winner protocol—S02c3 still owns that race.

Document extraction has a separate permission split: `GET` remains a Project
view operation, while the cost/status-writing `POST` requires Project edit
capability. No other read-shaped SA tool found by this pass mutates durable
state.

## S02c2 activation boundary

This commit stores and transports nonce generations but does not activate exact
nonce authority. S02c2 changes no floor and every activation flag remains
false. The serving identity cannot update compatibility control state, and
S02c2 exposes no floor-raise or nonce-activation command. Any explicitly
reviewed total-consumer activation must
first serve compatible code at 100% traffic, drain the request epoch, every
v0/null-nonce run holder, and every below-floor stream receiver lease. Only that
later unit may raise the runtime-reader floor and irreversibly set
`run_holder_nonce_enforced = true`; after activation an old tab without the
exact nonce is required to refresh.

## S02c2 deployment decisions

The default `run.app` URL remains disabled. `/warmup` is strengthened to fail
closed when the baked capability environment, build identity, or bounded
database check is wrong. Cloud Run waits for that startup probe before its
ordinary deploy moves traffic. Nova does not provision a candidate-only load
balancer, traffic controller, or durable cutover journal.

Production unknown hosts are not a general internal trust zone. Apart from the
platform's exact `/warmup` request, they return 404 before `/api/*` handling;
localhost-only conveniences remain development-only. This closes the forged
Host path through the public load balancer without exposing a rollout-only
application route.

Migration, runtime, and build use distinct IAM/database identities. Migration
owns the database, `public`, and fixed/auth/control objects; runtime receives
application DML and read-only compatibility state, with no separate rollout
database role. Runtime owns only `nova_case_runtime.cases` because the live
schema path performs concurrent index DDL, and its schema `CREATE` privilege is
confined there. The initial table move requires the documented one-time
maintenance cutover; this path intentionally adds no bridge or database cutover
journal.

## Build and deploy behavior

Before Docker runs, Cloud Build executes:

```bash
node scripts/rollout/render-build-config.mjs \
  --check \
  --build-id "$BUILD_ID" \
  --output /workspace/rollout.env
```

The renderer validates the exact manifest schema and canonical formatting,
then emits shell-quoted values. The Docker build sources that file and bakes
the declarations into the runner image. Its structural check also proves:

- both long-lived Next route `maxDuration` literals equal the request cap;
- Cloud Build passes every generated declaration exactly once;
- Docker declares and persists every value exactly once; and
- the database writer version and both legacy run-liveness constants derive
  from the manifest instead of duplicate literals.

Cloud Build tags each image with its always-present unique build UUID, runs the
migration Job as `nova-migrate`, then deploys that same image as the existing
`commcare-nova` runtime identity. The generated request cap pins Cloud Run's
timeout. The first split-identity deploy is an explicit dogfood maintenance
cutover because ownership convergence moves `cases` out of `public`; it is not
presented as zero-downtime machinery.

Before merging the pipeline switch, first run the GCP identity plan and apply
it after review:

```bash
./scripts/infra/provision-deployment-identities.sh
./scripts/infra/provision-deployment-identities.sh --apply
```

Then create one temporary built-in Cloud SQL administrator, use the bounded
bootstrap utility, and delete the administrator immediately afterward. Never
print or persist its generated password:

```bash
set -euo pipefail
NOVA_BOOTSTRAP_PASSWORD="$(openssl rand -base64 48)"
cleanup_bootstrap_user() {
  gcloud sql users delete nova-deployment-bootstrap \
    --project=commcare-nova \
    --instance=nova-cases \
    --quiet >/dev/null 2>&1 || true
  unset NOVA_BOOTSTRAP_PASSWORD
}
trap cleanup_bootstrap_user EXIT
gcloud sql users create nova-deployment-bootstrap \
  --project=commcare-nova \
  --instance=nova-cases \
  --type=BUILT_IN \
  --password="$NOVA_BOOTSTRAP_PASSWORD"
NOVA_DB_BOOTSTRAP_USER=nova-deployment-bootstrap \
NOVA_DB_BOOTSTRAP_PASSWORD="$NOVA_BOOTSTRAP_PASSWORD" \
  npx tsx scripts/infra/bootstrap-database-owner.ts --apply
cleanup_bootstrap_user
trap - EXIT
```

If the bootstrap command fails, delete the temporary administrator before doing
anything else; its SQL is idempotent and can be rerun with a new temporary
administrator after the cause is fixed. The first migration/deploy may briefly
interrupt case endpoints while `cases` moves schemas. Fix forward if the new
revision fails; no old revision is falsely advertised as a database-compatible
rollback after ownership convergence.

### One-time maintenance execution

This dogfood cutover accepts a short case-endpoint outage; it does not contain a
traffic-drain switch. Do not improvise an IAM or load-balancer deny rule: the
public service sits behind the existing load balancer, and changing invocation
policy without separately verified topology can block both users and Cloud
Build's public probes. Schedule the merge, tell dogfood users not to start or
edit apps during the window, and keep the window open until the triggered build
and its public verification complete.

Before merging, require both provisioning commands and the bootstrap above to
exit zero. The bootstrap's final JSON must show:

- `databaseOwner` = `nova-migrate@commcare-nova.iam`;
- `publicSchemaOwner` = `pg_database_owner` (the database owner is its current
  implicit member);
- `migrationCanUseRuntime` = `true`;
- `runtimeCanUseMigration` = `false`; and
- `currentUserCanUseMigration` = `false` after the temporary administrator's
  grant is removed.

Record the current revision, merge during the announced window, then identify
and stream the regional trigger build:

```bash
gcloud run services describe commcare-nova \
  --project=commcare-nova \
  --region=us-central1 \
  --format='value(status.latestReadyRevisionName,status.traffic)'

gcloud builds list \
  --project=commcare-nova \
  --region=us-central1 \
  --sort-by='~createTime' \
  --limit=5
gcloud builds log BUILD_ID \
  --project=commcare-nova \
  --region=us-central1 \
  --stream
```

The expected order is image push → successful `commcare-nova-migrate`
execution → Ready new revision and standard traffic move → successful public
main/docs/MCP probes. Between migration commit and the new revision taking
traffic, the old revision does not know the second search-path schema; case
requests may fail during precisely that accepted interval.

After Cloud Build succeeds, run this read-only catalog check in Cloud SQL
Studio and require the shown shape before ending maintenance:

```sql
SELECT namespace.nspname AS schema_name,
       class.relname AS relation_name,
       pg_catalog.pg_get_userbyid(class.relowner) AS owner
FROM pg_catalog.pg_class AS class
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = class.relnamespace
WHERE class.relname IN ('cases', 'apps', 'auth_member',
                        'kysely_migration')
ORDER BY schema_name, relation_name;

SELECT
  pg_catalog.has_schema_privilege(
    'commcare-nova@commcare-nova.iam', 'public', 'CREATE'
  ) AS runtime_can_create_public,
  pg_catalog.has_schema_privilege(
    'commcare-nova@commcare-nova.iam',
    'nova_case_runtime',
    'CREATE'
  ) AS runtime_can_create_case_schema;
```

`cases` must be the sole table in `nova_case_runtime` and owned by runtime;
`apps`, `auth_member`, and `kysely_migration` must remain in `public` and be
owned by migration. The two booleans must be `false, true`. Finally, require
HTTP 200 from `https://commcare.app/` and `https://docs.commcare.app/`, plus the
OAuth discovery 401 from the MCP probe already encoded in `cloudbuild.yaml`.

Failure handling is deliberately small:

- If the migration Job fails, its convergence transaction rolls back, including
  the schema move. Fix the cause and rerun the same commit's regional trigger.
- If migration succeeds but deploy or verification fails, maintenance remains
  open and the old revision is not a valid rollback. Fix forward by rerunning
  the same SHA (or landing a corrective SHA):

  ```bash
  gcloud builds triggers run 8d269c82-7de7-4b9f-a435-30b173f597b2 \
    --project=commcare-nova \
    --region=us-central1 \
    --sha=MERGED_COMMIT_SHA
  ```

  Privilege convergence is idempotent after `cases` has moved. Do not manually
  move it back or restore runtime `CREATE` on `public`; that would recreate the
  owner-everything boundary this cutover removes.

## Safe verification

These commands are read-only and require no Cloud access:

```bash
node scripts/rollout/render-build-config.mjs --check
npx vitest run \
  lib/runtimeCapabilities/__tests__/runtimeCapabilities.test.ts \
  --maxWorkers=1
npm run typecheck
```

All compatibility floors remain `0`; `run_holder_nonce_enforced` and the
carrier-commit, schema-action, and Project-move flags remain false. Changing the
manifest alone never raises a database floor or activates exact nonce authority
or lookup-reference vocabulary.

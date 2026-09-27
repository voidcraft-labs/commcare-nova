# Private authoring workspace

The architect, ordinary chat editor and MCP use the shared authoring tools
against a durable private `BlueprintDoc`.
Incomplete intermediate work may carry validator findings; canonical app state
changes only when `saveWork` passes the full current gate. There is no separate
compiler vocabulary, handle graph, or model-authored completion receipt.

## Boundaries

- `runtime.ts` dispatches shared operations through the same authored input
  preparation as ordinary editing. `registry.ts` excludes operations whose
  declared staging policy forbids private execution. External Project writes
  use their own authorized services rather than pretending to be staged.
- `workspace.ts` implements the common `ToolWorkspace` contract. Each invocation
  reads one revision and may perform one mutation operation. Creation identities
  are allocated before content binding; accepted canonical mutations are stored
  with the exact semantic tool result.
- `store.ts` owns authority, private revisions, ordered mutation stages, and
  request receipts. Stable request identity plus input digest makes retry exact.
  Reusing an identity with different input refuses. Successful no-ops retain
  their semantic result without advancing the private revision.
- Workspace opening and replay recovery hold the authorized candidate lock
  while loading its metadata, base, and steps. Concurrent staging cannot pair an
  older revision with a newer step sequence or masquerade as data corruption.
- `diagnostics.ts` reports the current candidate's findings. Its committability
  verdict is advisory: publication resolves current Project references and
  reruns the canonical gate under transaction locks.
- `materializeGenesis.ts` creates the first meaningful, export-ready app through
  `lib/db/appGenesis.ts`. App state, runtime schema, history, session mapping,
  workspace receipt, and materialization event commit together.
- `commit.ts` publishes later checkpoints through the canonical mutation kernel.
  It requires the exact canonical base sequence and either commits all work or
  preserves private work with an actionable conflict. Even a compatible
  intervening canonical edit refuses; there is no implicit rebase. It never
  rewrites an accepted operation to make a conflict disappear. Its active-schema
  Phase A and saved-data migration report commit with the checkpoint; retries
  retain the original consequence. Index and worker convergence remain derived
  post-commit work.

## Authority and receipts

Every write reauthorizes its session in the owning transaction. Architect work
proves the current `(run_id, holder_nonce)`, holder actor, Project and edit
membership; plan review and peer ownership remain build-only checks. Ordinary
work proves its permanent actor and Project authority, with current app edit
access after birth. It does not invent a build run or plan. Existing design
sessions retain their lineage without a mandatory backfill. Before app birth,
the session is the authority carrier; afterward authority follows its immutable
app mapping to the locked app row.

Existing-app operations acquire the app before the session or workspace rows;
pre-app operations acquire the session first. Project membership is checked
under the membership gate after authority rows. Never invert that order.
Captured Project identity is not a live tenancy assertion: a moved app cannot
publish an old workspace into its new Project.

Receipts record effects, not permission. Exact committed replay reauthorizes the
current session authority and membership before returning the stored
result. Response and
usage persistence precede tool dispatch in `build/architectLoop.ts`, so recovery
can replay unanswered calls without repeating mutations or losing created IDs.
A successful no-op has a receipt too, including a translation whose requested
text is already current. Do not infer tool outcomes from an empty mutation list.

A batch-exclusive operation, such as property rename or case-type retirement,
owns its workspace alone. Admission checks the entire pending batch against its original base before
appending a stage. An identity removed by an earlier private edit stays reserved
until that batch commits; a replacement needs a new identity. Staging, reopening, and
checkpoint commits reduce the same combined batch, including translation cleanup.
This matches both first-save and later-checkpoint admission.
Admission errors reject before appending a stage;
validator findings may remain private for repair. A rejected publication leaves
the candidate available. Any intervening canonical sequence refuses the save
instead of merging or overwriting. Save and discard bind the exact candidate
revision. Explicit discard abandons the candidate and keeps the work
identity. The next
edit creates a candidate from the latest saved base, or the empty construction
base before app birth. Reads do not create candidates, and a previously prepared
operation cannot cross into the replacement candidate.
It never reverses an earlier checkpoint or an external write.

The shared canonical-JavaScript digest governs workspace identity. SQL fold
snapshot digests belong to a separate domain and are never compared to it.
No accumulated external read set participates in validity. The current locked
lookup, media, organization, and runtime-schema checks own those boundaries.

## Evidence

The store tests exercise real SQL authority, idempotency, and lifecycle failures.
Runtime tests prove private isolation, semantic result replay, stale-holder and
membership refusal, stale-base refusal, explicit restart, repair and batch
exclusivity. Genesis tests inject
late SQL failure and verify that no partial app or receipt survives. The
orchestrator tests resume at private writes, saved checkpoints, and active peer
reviews through the production SDK transport. All database tests use migrated
Postgres; none needs to pin prompt text or the former executor protocol.

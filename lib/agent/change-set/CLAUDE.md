# Private authoring workspace

A build uses the shared authoring tools against a private `BlueprintDoc`.
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
- `diagnostics.ts` reports the current candidate's findings. Its committability
  verdict is advisory: publication resolves current Project references and
  reruns the canonical gate under transaction locks.
- `materializeGenesis.ts` creates the first meaningful, export-ready app through
  `lib/db/appGenesis.ts`. App state, runtime schema, history, session mapping,
  workspace receipt, and materialization event commit together.
- `commit.ts` publishes later checkpoints through the canonical mutation kernel.
  It rebases admitted mutations onto fresh state and either commits all work or
  preserves private work with an actionable conflict. It never rewrites an
  accepted operation to make a conflict disappear.

## Authority and receipts

Every write proves the current `(run_id, holder_nonce)`, holder actor, Project,
and edit membership in the owning transaction. Before app birth, the claimed
session is the authority carrier. After birth, authority follows the immutable
session-to-app mapping to the locked app row. Plan review and peer ownership are
checked by `lib/db/authoringPlanGuard.ts`; an active peer pauses construction.

Existing-app operations acquire the app before the session or workspace rows;
pre-app operations acquire the session first. Project membership is checked
under the membership gate after authority rows. Never invert that order.
Captured Project identity is not a live tenancy assertion: a moved app cannot
publish an old workspace into its new Project.

Receipts record effects, not permission. Exact committed replay reauthorizes the
current holder and membership before returning the stored result. Response and
usage persistence precede tool dispatch in `build/architectLoop.ts`, so recovery
can replay unanswered calls without repeating mutations or losing created IDs.
A successful no-op has a receipt too, including a translation whose requested
text is already current. Do not infer tool outcomes from an empty mutation list.

A batch-exclusive operation, such as property rename or case-type retirement,
owns its workspace alone. Admission checks the entire pending batch against its original base before
appending a stage. An identity removed by an earlier private edit stays reserved
until that batch commits; a replacement needs a new identity. This matches both
first-save and later-checkpoint admission and survives reopening the workspace.
Admission errors reject before appending a stage;
validator findings may remain private for repair. A rejected publication leaves
the candidate available. Concurrent canonical edits are preserved when replay
is valid; removed targets and incompatible changes refuse instead of overwriting.

The shared canonical-JavaScript digest governs workspace identity. SQL fold
snapshot digests belong to a separate domain and are never compared to it.
No accumulated external read set participates in validity. The current locked
lookup, media, organization, and runtime-schema checks own those boundaries.

## Evidence

The store tests exercise real SQL authority, idempotency, and lifecycle failures.
Runtime tests prove private isolation, semantic result replay, stale-holder and
membership refusal, rebase, repair, and batch exclusivity. Genesis tests inject
late SQL failure and verify that no partial app or receipt survives. The
orchestrator tests resume at private writes, saved checkpoints, and active peer
reviews through the production SDK transport. All database tests use migrated
Postgres; none needs to pin prompt text or the former executor protocol.

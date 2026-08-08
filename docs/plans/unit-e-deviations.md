# Unit E — deviation log (working file; folded into the plan and deleted before push)

Records every place the implementation departs from (or refines) the plan text,
so the final plan fold can state each as always-designed present tense.

## Decided

1. **Pending case-index work needs no new table.** §12.3's `pendingIndexWork`
   is the existing durable convergence state: `case_type_schemas.index_pending_seq`
   (set by `applySchemaChangePhaseA` inside the transaction) plus the idempotent
   post-commit drain (`drainPendingIndexConvergence`). The genesis writer calls
   `applySchemaChangePhaseA(tx, …, syncedSeq: 1)` per case type inside the
   materialization transaction and `drainPendingCaseSchemaIndexes(appId)` after
   commit. `GenesisRuntimeSchemaPlan` is therefore a preparation-time proof
   (deterministic compile of every case type) rather than a carried row set.

2. **Legacy non-`complete` apps without design lineage.** The old SA build path
   is deleted with no fallback. Pre-cutover apps stuck at `generating`/`error`
   (no bound design session) are handled by a one-off scan/migrate script pair
   (`scripts/`) that flips reaped, holder-free, pre-cutover rows to `complete`
   (every persisted app is valid by construction, so "at rest" is truthful);
   after that, every app-targeted chargeable turn is edit-shaped. Runbook note
   in the PR; scripts deleted in a follow-up commit after the production run.

## Open

(watch this section — anything still here at the end routes to its owning
unit's block in §19)

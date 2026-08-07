# Unit B — deviations and reconciliation notes

Decision log for the Unit B implementation of
`reviewed-intent-atomic-change-sets-plan.md` (Atomic Change Set runtime).
Each entry names the plan section it diverges from or makes concrete, and why.
This file is input to a later plan reconciliation; the plan itself carries no
history.

## Sequencing: Unit B lands before Units C, D, and E

1. **Design/plan identity columns are opaque, FK-less (§10.2, §18.7).**
   `design_change_sets` (and the receipt/provenance tables) carry
   `design_session_id`, `design_revision_id`, `build_plan_id`, `slice_id`,
   `attempt_id` and both digests as non-null opaque identities, exactly the
   final column shapes, but WITHOUT foreign keys — the referenced tables ship
   with Units C/D/E. Those units add the FKs in their own migrations.
2. **Genesis authority lock (§10.4 step 2, §11.13 rule 4).** A pre-app build's
   stage/commit authority carrier is the design-session row, which ships with
   Unit D. Until then a genesis change set's stage transaction locks only the
   change-set row, and owner verification uses the row's own
   `owner_user_id`/`owner_run_id` attribution columns. The authority-target
   resolution is a closed union (`app` | `genesis`), so Unit D adds the
   design-session arm without reshaping the store. App-edit sets follow the
   final lock order today: app row first, change-set row second.
3. **`lib/agent/design/ids.ts` and
   `lib/agent/design/projection/coordinates.ts` land early.** Unit B's tables
   need `designIdSchema` (§6.2) and the closed
   `implementationCoordinateSchema` (§14.4, required by §18.9's
   `app_change_intents` strict parsing). Both land as small leaf files at the
   exact paths the plan assigns them; Units C/F build the rest of those
   packages around them.
4. **Model-facing executor tools defer to Unit E.** The §10.7 surface exists
   as internal server functions — `beginAppEditChangeSet`/
   `beginGenesisChangeSet`, `commitDesignChangeSet`,
   `ChangeSetMutationWorkspace.inspect()`, `abandonChangeSet`/
   `supersedeChangeSet` — plus three granular staging tool MODULES
   (`stageModule`, `stageForm`, `moveStagedModule`), all exercised by tests
   and mounted on no chat/MCP surface; the executor loop that wraps them as
   model tools is Unit E. `stageFields`/`stageCaseListColumn`/
   `stageCaseOperation` are not separate modules: the plan's own §10.7 note
   ("existing shared granular edit tools operate on the overlay once targets
   exist") already covers that grain — `addFields`, the case-list-config
   family, and the case-operation family stage as-is. The genuinely new grain
   Unit B adds is incomplete module/form creation and module reorder.
   `raiseDesignExecutionIssue` (whose schema is a §13.12 orchestration
   artifact) ships entirely with Unit E.
5. **Per-stage event emission is a pure helper (§10.10 steps 17–18).**
   No surface drives a change-set commit in Unit B, so nothing emits SSE or
   event-log envelopes. `committedStageEnvelopes` derives the per-stage
   envelope inputs from the stored step-stage ranges + committed sequence;
   Unit E's executor surface wires emission (post-commit only, unchanged
   semantics).
6. **The shared canonical module-reorder tool (§10.7) defers.** Adding a new
   SA/MCP tool (`moveModule`/`move_module`) changes the model-facing surface
   (prompt guidance, nova-plugin sweep, MCP docs) and is not needed until the
   executor builds module-by-module; it belongs with the Unit E cutover. The
   private `moveStagedModule` staging tool ships now.

## Concretizations the plan left open

7. **Digest discipline.** Every change-set digest (`base_snapshot_digest`,
   `input_digest`, `mutation_digest`, `committed_snapshot_digest`) is SHA-256
   hex over canonical JS JSON bytes: object keys recursively sorted by UTF-16
   code point, then `JSON.stringify`. Producer and verifier are both
   JavaScript, so PostgreSQL's jsonb canonicalization never participates.
   (`app_change_fold_baselines.snapshot_digest` remains its separate
   SQL-computed domain — the two are never compared.)
8. **Request rows have one timestamp (§18.7 lists `completed_at`).** A stage
   request commits atomically or not at all — there is no durable in-progress
   state — so `created_at` is the only timestamp. §10.2's
   `DesignChangeSetRequestRow` (which has only `createdAt`) is the shape
   implemented.
9. **Commit routes through `applyBlueprintChange` uniformly.** The plan's
   §10.10 names the canonical kernel; the repository's real exclusive-saga and
   post-commit schema-sweep owner is `applyBlueprintChange`, which composes
   that kernel. Every change-set commit goes through it, so rename/retire
   Phase A, ordinary case-type sweeps, and index convergence keep their exact
   current semantics. The typed sidecars ride
   `CanonicalCommitTransactionHooks.sidecars` (kernel-executed, closed
   dispatcher in `lib/db/canonicalCommitSidecars.ts`), which
   `applyBlueprintChange` passes through.
10. **Rebase classification runs as preflight + post-rejection
    reclassification.** The kernel's in-transaction rejection is authoritative
    (all-or-nothing holds regardless); the structured `ChangeSetRebaseReport`
    is derived from a fresh strict snapshot immediately before the
    authoritative attempt and re-derived if the kernel rejects a batch the
    preflight passed (narrow race). Steps are always retained.
11. **Read-set capture is workspace-owned and automatic.** Lookup deps are
    captured by wrapping the invocation context's `lookupDefinitions`/
    `lookupCatalog` AND from each step's own diagnostics resolution; the
    organization dep from the write's `expectedOrganizationRevision` policy;
    media-asset deps from the staged batch's authored-asset-ref delta.
    `project-scope` is the row-level `base_project_id` rather than a
    per-step entry. The required-read-set fence is real: a tool whose
    registry policy declares `organization` stages only with a captured
    organization revision, and one declaring lookup kinds stages a
    lookup-referencing candidate only when a Project definitions reader
    recorded the revisions (`READ_SET_UNRECORDED` otherwise).
11a. **Three staging-classified tools are fenced out of the change-set
    registry until their bodies are overlay-native.** `getAutomations`,
    `getOrganization`, and `updateAutomation` read the authoritative
    persisted app/organization snapshot (and the update's zero-diff arm
    proves its no-op via `adoptAuthoritativeSnapshot`), so admitting them
    would make staged private state invisible to an executor's own
    read-backs. Their reviewed §9.8 staging classification is unchanged;
    `lib/agent/change-set/registry.ts::NOT_YET_OVERLAY_NATIVE` is a
    runtime-readiness fence the executor unit removes by making those
    bodies read `ctx.snapshot.doc`.
12. **Slice intent coverage is informational in Unit B (§10.8).** With no
    build-plan artifact yet, `sliceIntentCoverage` reports which staged
    `intentIds` have steps; the required-coverage gate becomes real when
    Unit C/E supply the owning-intent set. `canCommit` therefore keys on
    gating findings, read-set currency, exclusive coherence, and (genesis)
    export readiness.
13. **Batch-exclusive fence semantics.** A staged batch carrying
    `renameCaseProperties` or `retireCaseType` must be the change set's ONLY
    step: staging it into a set with existing steps rejects, and staging
    anything further into a set holding an exclusive step rejects
    (`design_change_sets.exclusive_kind` records which). Mutation admission
    already forces `renameCaseProperties` to be alone within its batch;
    `retireCaseType` may ride inside its composing batch (module removal +
    retirement), and that whole batch is the exclusive step.
14. **Bounded base loading skips the final gate (§10.3).** The sequence-
    bounded canonical loader replays the baseline-plus-suffix fold through the
    recorded base sequence as exact mutation reduction and proves the recorded
    base digest — it does not run today's lookup-context gate against the
    historical document (the fold module's own header states why that would
    be dishonest). The full-head fold keeps its existing gate.
15. **Change-set rows do not re-tenant on Project move.**
    `design_change_sets.base_project_id` is the captured base scope, not live
    tenancy: an app Project move leaves open change sets behind by design —
    their commit rejects with `PROJECT_CHANGED`, the plan's terminal outcome
    (§10.11, §20.7). Committed lineage (`design_committed_slices`,
    `app_change_intents`) is app-keyed and carries no Project column, so it
    follows the app implicitly. The Project-move transaction is untouched.
16. **Diagnostics deltas speak fingerprints (§10.8).**
    `introducedSincePreviousStep`/`resolvedSincePreviousStep` carry stable
    16-hex finding fingerprints rather than full `ValidationError[]`: a
    RESOLVED finding's full body is not recomputable from the compact
    receipts the protocol persists, and `inspect` recomputes full current
    details on demand — carrying full bodies for one delta direction and
    identities for the other would be a lopsided contract.
17. **Sidecar execution point (§9.5).** Sidecars run inside the kernel
    transaction AFTER the committed-batch write tail (the plan leaves the
    point unstated): the provenance rows' immediate FK onto the fresh
    `app_changes` row then holds without deferrable constraints, and a lost
    holder compare-and-set aborts before any sidecar state exists.
18. **`WorkspaceMutationOutcome` gains an optional `staged` receipt (§9.7).**
    The success arm carries the durable `StageRequestReceipt` exactly when
    the change-set host wrote it — how a staging tool's result and the §9.7
    "disposition: staged plus new workspace revision" reach the tool layer
    without a second result channel. The canonical host never sets it.
19. **Staging projection scope (§10.6).** Unit B lands the reviewed
    handle-eligibility classification over the identity-pointer registry
    (`lib/agent/identityPointerRegistry.ts` — every UUID slot of every
    staging-allowed tool classified handle-eligible or canonical-only, new
    carriers failing CI until classified), the structural handle resolver
    (exact one-key `{ handle }` objects only; prose/paths never interpreted;
    a source test proves no canonical tool schema owns a `handle` property),
    and the second parse through the original tool schema. The
    executor-FACING projected wire schemas (the `uuid | { handle }` union
    emission) ride Unit E with the executor surface that serves them.

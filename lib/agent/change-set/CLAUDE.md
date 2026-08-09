# lib/agent/change-set — the Atomic Change Set runtime

A private, durable workspace where one slice executor assembles exact
canonical mutations across idempotent staging calls before ONE canonical
commit. The private candidate may be incomplete (gating findings are
diagnostics here, never persistence outcomes), but it is never executable,
never visible, and never a second app state: **no staged state reaches any
canonical, read, stream, or peer surface** — no `app_changes` row, no SSE, no
event log, no NOTIFY, no Preview. Only `commit.ts`'s all-or-nothing
transition creates a visible revision, through the same canonical kernel,
gate, and integrity services every other write uses.

## Authority

- `store.ts` — the durable protocol. The STAGE TRANSACTION is the
  correctness spine: authority carrier first (an app-edit set's app row
  `FOR SHARE`, holder capability proved on it; a genesis set locks its
  CLAIMED design-session row — state `active`, the presented chat-run
  holder proved against the session lease — and the change-set owner
  columns are attribution only), fresh Project
  `edit` membership, change-set row `FOR UPDATE` second, the idempotency-
  ledger replay, the exact-revision fence, then receipt + step + stage
  ranges + handle bindings + revision advance in ONE transaction. There is
  no durable in-progress state; a concurrent duplicate converges through
  the `(change_set_id, request_id)` primary key. Fault injection rides
  `__setStageTransactionFaultHookForTests`. Production slice creation also
  locks the exact delegated holder and running attempt, inserts the change
  set, and binds its id onto that attempt in one transaction; recovery may
  adopt only an open set whose complete lineage, owner, kind, and base match.
- `workspace.ts` — `ChangeSetMutationWorkspace`, the same tool-facing
  contract as the canonical workspace (`lib/agent/workspace/types.ts`) over
  durable staging. It owns: serialized synchronous ordinals, one write per
  invocation, durable idempotent replay by request id + input digest
  (recomputed at the STORED expected revision, so a post-advance retry
  still replays its original receipt — the receipt, not prose, is the
  replay contract), handle declaration/resolution against a scratch table
  merged only when the step commits, automatic read-set capture, the
  batch-exclusive fence, and the REAL whole-document evaluator whose
  findings land on the receipt as compact fingerprints.
  `adoptAuthoritativeSnapshot` is a protocol error here — a private overlay
  has no fresher authority than its own replay.
- `commit.ts` — `commitDesignChangeSet`: the concatenated admitted steps as
  one batch under the deterministic
  `design-change-set:<id>:r<revision>:<digest24>` batch id, driven through
  `applyBlueprintChange` (so rename/retire Phase A, ordinary case-type
  sweeps, dedup, fresh authorization, and post-commit index convergence
  keep their exact semantics) with the typed sidecars riding the kernel's
  transaction-hook seam. A rejection returns a structured per-step
  `ChangeSetRebaseReport` (never a name/position retarget) with every step
  retained; a retry converges on the stored `design_committed_slices`
  receipt, and a canonical batch without that receipt is corruption, not a
  commit. Genesis sets refuse this path — their commit is
  `materializeGenesis.ts`.
- `intentCoverage.ts` — the commit-time proof that every mutation-bearing
  durable step names only intents owned by the slice and that their union
  covers every owned intent. Executor calls supply `implementedIntentIds`;
  the runtime strips that executor-only field before canonical tool parsing,
  persists the IDs on the step, and derives implementation coordinates from
  the admitted mutations. A plan's ownership list is never copied into a
  receipt as proof of implementation.
- `materializeGenesis.ts` — `materializeAppFromGenesis`, the design-slice
  birth: pre-read → committed-replay short-circuit (rebuilds the exact
  receipt from `design_committed_slices` + the sequence-1 canonical fold) →
  read-set preflight → ONE transaction ordering actor gate →
  `lockSessionRow` (mode/state/Project/proposed-app/exact-holder verified)
  → change-set row → step replay proved against the empty-genesis digest →
  `prepareGenesisCandidate` → reservation check →
  `writePreparedGenesisInTransaction` with the holder+reservation transfer
  → commit sidecars (the exact attempt `running → committed`, change-set flip,
  committed-slice receipt, and intent provenance at seq 1) → the session's atomic
  `authority-cleared + materialized + app_id` flip (table CHECKs make a
  partial transfer unrepresentable). Gate rejection rolls the whole
  transaction back; pending case-index work drains post-commit.
- `baseLoader.ts` / `runtime.ts` — the candidate is DERIVED, never stored:
  the exact canonical base (greatest fold baseline at-or-below the recorded
  sequence plus the admitted suffix, digest-proved via the gate-free
  bounded fold in `lib/db/canonicalMutationFold.ts`) replayed through the
  durable steps. Caches are discardable; replay is the authority.
- `handles.ts` / `stagingProjection.ts` — the private symbol table. A
  handle reference is EXACTLY the one-key `{ "handle": "@name" }` object,
  resolved structurally before the ORIGINAL tool schema re-parses the
  resolved input; prose is never searched, and no canonical tool schema
  owns a `handle` property (a source test proves the collision freedom).
  `STAGING_PROJECTION_DECISIONS` is the reviewed handle-eligibility
  classification over the identity-pointer registry — only Blueprint-entity
  families are handle-eligible; app/Project/media/lookup/location/external
  identities stay canonical. Executor-facing `uuid | { handle }` wire
  schemas emit from this map in the executor unit.
- `readSets.ts` / `diagnostics.ts` — external read sets are captured
  automatically (lookup reads via the wrapped readers, the organization
  fence from the write's `expectedOrganizationRevision`, media identities
  from the authored-asset-ref delta; Project scope is the row's
  `base_project_id`). Commit policy per kind: organization fences its exact
  revision through the kernel; lookup/media re-resolve under the kernel's
  fresh locked verdicts. `canCommit` = zero gating findings + current read
  sets + (genesis) export readiness; it is advisory until the kernel's gate
  — nothing here redefines validity.
- `registry.ts` / `stageTools.ts` — which tools a change set may dispatch:
  every shared registry entry whose reviewed staging classification is not
  `forbidden`, plus the executor-only granular tools (`stageModule`,
  `stageForm`) that create deliberately incomplete private structure —
  INCOMPLETENESS is the only thing that earns a staging tool, so ordinary
  reordering rides the shared canonical `moveModule`. Every shared body
  reads `ctx.snapshot.doc`, so a dispatched read answers from the overlay's
  own staged state; the organization-deriving tools keep only their PLACE
  reads external (rows, not Blueprint), and `updateAutomation`'s zero-diff
  arm proves its no-op from the overlay instead of adopting an
  authoritative snapshot. External-effect tools are structurally absent from
  the map. The batch-exclusive mutation KINDS (`renameCaseProperties`,
  `retireCaseType`) fence at admission: such a batch owns its change set
  alone (`exclusive_kind` closes the set).

## Invariants

1. Staged mutations are exact admitted canonical mutations after handle
   resolution; steps never contain handles.
2. A stage request is idempotent by stable request id + input digest; a
   reused id with different content latches
   (`ChangeSetRequestIdCollisionError`), and rejection receipts replay too.
3. Admission failures (wire canonicality, identity collision, invalid
   anchor, missing target, rename-plan issues, reducer throws, policy
   fences, unbound handles) reject BEFORE a step appends; validator
   findings do not — the private candidate may carry them.
4. Lock order (the plan's rule for existing-app staging): apps →
   design_change_sets → membership gate/member row. No path holds a
   change-set row while waiting for an app row, and the membership gate is
   only ever taken while already holding the authority rows — membership
   writers never take change-set or app locks, so gate-after-row cannot
   cycle. A GENESIS set has no app row: its authority carrier is the
   CLAIMED design-session row, locked first (`lockSessionRow`, state
   `active`, the presented chat-run holder proved against the session's
   lease), then the change-set row — the session holder is the ownership
   proof, and the change-set owner columns are attribution only. The
   staging ledgers are append-only at the privilege level; the row-locked
   authority table serializes them.
5. `base_project_id` is captured scope, not live tenancy: a Project move
   strands open sets by design (commit rejects), and no move transaction
   touches these rows. Committed lineage is app-keyed and moves implicitly.
6. Every digest is the shared canonical-JS discipline
   (`lib/utils/canonicalJson.ts`); fold-baseline SQL digests are a separate
   domain, never compared against these.
7. A canonical design commit accepts only the exact bound slice attempt in
   `running` state and transitions that attempt in the same transaction as
   the canonical revision, committed-slice receipt, and provenance.

## Tests

`__tests__/changeSetStore.integration.test.ts` (the fault matrix +
idempotency/authority/lifecycle), `changeSetRuntime.integration.test.ts`
(workspace replay/process death, isolation gate, exclusivity, commit +
rebase + provenance), and the pure suites (`digest`, `handles`,
`stagingProjection` — classification completeness + collision freedom,
`changeSetSourceGuards` — the package-level import isolation).

## Adjacent boundaries

The tool-facing contract lives in `lib/agent/workspace/` (this package's
host implements it; the extensions — nullable `appId`,
`externalContextDigest`, `intentIds`/`readSet` — are change-set-only, and
the canonical workspace rejects them). The kernel sidecar vocabulary lives
in `lib/db/canonicalCommitSidecars.ts` (server-owned, closed). The
executor loop, model-facing tool wrappers, and materialization consume this
package in later units; nothing mounts these tools on chat or MCP today.

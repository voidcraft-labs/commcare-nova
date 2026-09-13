# lib/agent/change-set — the Atomic Change Set runtime

A private, durable workspace where one slice executor assembles exact
canonical mutations across idempotent native tool calls before ONE canonical
commit. The private candidate may be incomplete (gating findings are
diagnostics here, never persistence outcomes), but it is never executable,
never visible, and never a second app state: **no staged state reaches any
canonical, read, stream, or peer surface** — no `app_changes` row, no SSE, no
event log, no NOTIFY, no Preview. Only `commit.ts`'s all-or-nothing
transition creates a visible revision, through the same canonical kernel,
gate, and integrity services every other write uses.

## Authority

- `store.ts` — the durable protocol. The private-mutation transaction is the
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
  adopt only an open set whose complete lineage, kind, and base match, and the
  current authorized session holder transfers its owner attribution in that
  same recovery transaction.
- `workspace.ts` — `ChangeSetMutationWorkspace`, the same tool-facing
  contract as the canonical workspace (`lib/agent/workspace/types.ts`) over
  durable staging. It owns: serialized synchronous ordinals, one write per
  invocation, durable idempotent replay by request id + input digest
  (recomputed at the STORED expected revision, so a post-advance retry
  still replays its original receipt — the receipt, not prose, is the
  replay contract). If a stored receipt advanced beyond this workspace, it
  first rehydrates the durable steps and handles before serving that receipt.
  Authored preparation runs after replay lookup against the serialized context.
  Server-owned implementation bindings use a scratch table merged only when
  the step commits. The workspace also owns automatic read-set capture, the
  batch-exclusive fence, and the REAL whole-document evaluator whose
  findings land on the receipt as compact fingerprints.
  `inspectState` pins one immutable candidate and returns its diagnostics with
  the authorized, rows-free lookup definitions used to compute them. The repair
  helper uses that same snapshot to print lookup filters and names. It reads no
  table rows and grants no new commit authority; `inspect` remains the ordinary
  diagnostics-only reader.
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
  receipt. Every public committed-receipt replay verifies the exact
  actor/run owner and locks current app scope and Project view membership;
  revoked membership or a changed Project refuses the replay. A canonical
  batch without that receipt is corruption, not a commit. Genesis sets refuse this path — their commit is
  `materializeGenesis.ts`.
- `materializeGenesis.ts` — `materializeAppFromGenesis`, the design-slice
  birth: pre-read → committed-replay short-circuit (rebuilds the exact
  receipt from `design_committed_slices` + the sequence-1 canonical fold) →
  read-set preflight → ONE transaction ordering actor gate →
  `lockSessionRow` (mode/state/Project/proposed-app/exact-holder verified)
  → change-set row → step replay proved against the empty-genesis digest →
  `prepareGenesisCandidate` → reservation check →
  `writePreparedGenesisInTransaction` with the holder+reservation transfer
  → commit sidecars (the exact attempt `running → committed`, change-set flip,
  committed-slice receipt at seq 1) → the session's atomic
  `authority-cleared + materialized + app_id` flip (table CHECKs make a
  partial transfer unrepresentable). Gate rejection rolls the whole
  transaction back; pending case-index work drains post-commit.
- `baseLoader.ts` / `runtime.ts` — the candidate is DERIVED, never stored:
  the exact canonical base (greatest fold baseline at-or-below the recorded
  sequence plus the admitted suffix, digest-proved via the gate-free
  bounded fold in `lib/db/canonicalMutationFold.ts`) replayed through the
  durable steps. Caches are discardable; replay is the authority.
- `handles.ts` retains exact internal implementation bindings. The executor
  binds accepted module/form compositions to UUIDs in server preparation; new
  one-to-one compositions use their accepted UUID bytes through that explicit
  binding. Existing verified bindings win. Names never infer the identity of
  an existing implementation. Fields, choices, and other creations need no
  extra symbols: their canonical staged mutations and receipts retain identity.
  A binding cannot reassign a lineage key or UUID. Only bindings whose entities
  survive the staged candidate are persisted; recovery also omits deleted
  inherited entities. Earlier committed slices contribute verified bindings
  through the existing plan lineage. Generic internal `invoke` still supports
  structural symbol resolution; model-facing `stageDispatch` accepts authored
  values and never resolves old `{handle}` arguments.
  Removing an accepted entity prunes its active binding, not its historical
  declaration. Recreating that entity reconciles the exact tuple under the
  existing stage lock. UUID, kind, and binding-key reassignment reject without
  advancing the stage; the original declaration's request ID remains intact.

- `designLookupReferences.ts` resolves accepted semantic lookup sources through
  the immutable materialization receipt when composing working context. Tools
  then use the shared lookup grammar and authorized names or IDs. Canonical
  reads use the same authored projection as chat and MCP.
- `readSets.ts` / `diagnostics.ts` — external read sets are captured
  automatically (lookup reads via the wrapped readers, the organization
  fence from the write's `expectedOrganizationRevision`, media identities
  from the authored-asset-ref delta; Project scope is the row's
  `base_project_id`). Commit policy per kind: organization fences its exact
  revision through the kernel; lookup/media re-resolve under the kernel's
  fresh locked verdicts. `canCommit` = zero gating findings + current read
  sets + (genesis) export readiness; it is advisory until the kernel's gate
  — nothing here redefines validity. Genesis readiness loads Project-filtered
  uploaded rows and synthesizes built-in-icon rows through the same media seam
  as ordinary export. Its boundary-only findings join `allFindings` and the
  diagnostic fingerprint summary, so a blocked workflow finalizer is actionable and
  cannot masquerade as an empty change set.
- `registry.ts` / `handleDeclarations.ts` — which tools a change set may dispatch:
  every shared registry entry whose reviewed staging classification is not
  `forbidden`. The executor mounts those ordinary semantic tools directly;
  it has no alternate read/batch/creation protocol. Ordinary reordering rides
  the shared canonical `moveModule`. Every shared body
  reads `ctx.snapshot.doc`, so a dispatched read answers from the overlay's
  own staged state; the organization-deriving tools keep only their PLACE
  reads external (rows, not Blueprint), and `updateAutomation`'s zero-diff
  arm proves its no-op from the overlay instead of adopting an
  authoritative snapshot. External-effect tools are structurally absent from
  the map. The batch-exclusive mutation KINDS (`renameCaseProperties`,
  `retireCaseType`) fence at admission: such a batch owns its change set
  alone (`exclusive_kind` closes the set). Shared creation identities are
  allocated during authored preparation; exact composition bindings are
  committed with the same stage receipt. Optional inline choices can inherit
  catalog defaults without model-authored identity declarations.

## Invariants

1. Staged mutations are exact admitted canonical mutations after handle
   resolution; steps never contain handles.
2. A private mutation call is idempotent by stable request id + input digest; a
   reused id with different content latches
   (`ChangeSetRequestIdCollisionError`), and rejection receipts replay too. A
   successful call that proves itself a no-op records an accepted no-op receipt
   without advancing the private revision, so process recovery does not lose
   that tool boundary. `configureCaseSelection`'s mutation-free typed
   `needs_changes` result additionally persists its exact JSON tool envelope on
   that receipt, so confirmation, repair, and refresh details drive the same
   executor decision after process replacement instead of becoming generic
   no-op success.
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
   the canonical revision and committed-slice receipt.
8. A semantic replay conflict never amends an append-only failed step. A real
   changed canonical base may supersede the open set plus running attempt under
   the current delegated holder. A deterministic failure instead abandons the
   set and permanently closes that exact plan/slice. Recovery reuses a bound
   open set only when its actor/run owner matches the current holder.
9. Executor recovery proves private-work authority from the current candidate,
   exact lineage, durable call receipts, and handle bindings. Separately, each slice attempt owns one
   exact append-only executor context generation: process recovery of that
   attempt reopens it, while the next attempt starts a fresh generation instead
   of inheriting the prior tool transcript. Each generation opens with the
   accepted workflow and a bounded workspace overview; compaction restores both.
   Focused reads provide omitted details. Hosted search stays in provider
   history and is never dispatched as a native Nova operation. Each returned
   provider response and its usage-bearing payload-free
   completed-step event commit atomically. Recovery replays any unanswered tool call under its
   original call id before another provider request. Each mutation call,
   commit, and blocker request has an idempotent durable sub-budget claim, so
   replay cannot consume a second unit. A paid blocker result is durably
   appended before execution continues; a response lost before that write
   stops rather than purchasing another decision. The orchestrator recognizes
   already committed slices from their canonical receipts and advances to a
   fresh context generation; prior transcript gaps do not authorize replay. The attempt
   transcript preserves local reasoning continuity but never decides what
   committed or was already applied privately. Repeating one identical compiler failure
   automatically invokes the bounded architect on occurrence two; occurrence
   three after durable guidance stops rather than retrying or redesigning.

## Tests

`__tests__/changeSetStore.postgres.test.ts` (the fault matrix +
idempotency/authority/lifecycle), `changeSetRuntime.postgres.test.ts`
(fresh-workspace replay, isolation gate, real command exclusivity, commit +
rebase), `materializeGenesis.postgres.test.ts` (including a native late
SQL failure after every required genesis write, rollback and successful retry),
and the pure suites (`digest`, `handles`,
`stagingProjection` — classification completeness + collision freedom,
`changeSetSourceGuards` — the package-level import isolation).

## Adjacent boundaries

The tool-facing contract lives in `lib/agent/workspace/` (this package's
host implements it; nullable `appId` and automatic external read-set capture
are private-workspace concerns). The kernel sidecar vocabulary lives
in `lib/db/canonicalCommitSidecars.ts` (server-owned, closed). The
executor loop, model-facing tool wrappers, and materialization consume this
package in later units; nothing mounts these tools on chat or MCP today.

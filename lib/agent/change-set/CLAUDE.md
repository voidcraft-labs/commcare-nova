# lib/agent/change-set: private durable Blueprint candidates

An Atomic Change Set is a private durable workspace derived from one exact
canonical base plus admitted semantic mutation steps. The reviewed initial
build uses one genesis change set for the complete executable app candidate.
The candidate may be temporarily incomplete, but it is never canonical,
renderable, exportable, collaborative, or externally writable.

## Ownership

- `types.ts` defines genesis/app-edit change sets and the
  `design-candidate` purpose. A candidate set carries its session, proposed
  app, Project, base digest, exact owner run, monotonic workspace revision,
  and lifecycle.
- `store.ts` owns opening/rebinding, idempotent request receipts, admitted
  steps, stage ranges, handle bindings, phase-gated append, lifecycle writes,
  and statement-boundary fault tests. Genesis staging locks and reauthorizes
  the design-session holder; app-edit staging uses the app holder.
- `workspace.ts` implements the shared `ToolWorkspace` contract over durable
  staged state. It serializes invocations, resolves handles, dispatches the
  original shared tool, evaluates the private candidate, and commits one
  request receipt/step/handle/revision transaction before returning.
- `registry.ts` is the closed list of shared tools allowed to operate against
  private state. The candidate agent mounts ordinary semantic tools from this
  registry; `stageModule` and `stageForm` remain granular internal helpers and
  are not part of the reviewed model surface.
- `stagingProjection.ts`, `handles.ts`, and `handleDeclarations.ts` own the
  handle grammar and identity-family classification. Every Blueprint entity a
  candidate can create is handle-eligible. Locations, media, lookup resources,
  and other state outside the candidate remain canonical-only.
- `runtime.ts` and `baseLoader.ts` rehydrate the exact candidate from its base
  and stored steps. No second document snapshot is persisted.
- `diagnostics.ts` runs the same whole-document and export-readiness logic over
  private state and records stable finding fingerprints without making the
  diagnostics an alternate validator.
- `readSets.ts` records exact Project-scoped organization, lookup, and media
  observations. Append-only dependencies cannot be erased by a later fresh
  read; materialization re-proves them.
- `materializeGenesis.ts` is the atomic accepted-candidate publication path.
  It locks session and set authority, replays all steps from the canonical
  empty base, proves the accepted checkpoint's exact revision and digest,
  reruns all genesis integrity, writes canonical sequence 1, commits the set,
  and transfers the holder/reservation in one transaction. Lost-response
  replay reconstructs the receipt from canonical state.
- `commit.ts` and intent-coverage modules support other private change-set
  consumers. The reviewed initial build does not ask a model to commit,
  declare intent coverage, or author provenance.

The shared tool-facing contracts live under `lib/agent/workspace/`. Do not
import this package into shared tool bodies; hosts implement the abstraction.

## Stage transaction

One request transaction performs this order:

1. Lock and prove the exact live session/app authority carrier and current
   Project membership.
2. Lock the change-set row and verify owner, status, base, and expected
   workspace revision.
3. Replay an identical stored `(requestId, inputDigest)` result, or reject a
   request-ID collision.
4. For a design candidate, prove the session points to this set and its phase
   is `authoring` or `revising`.
5. Resolve or declare handles structurally, then parse the resolved request
   through the original shared tool schema.
6. Run the shared tool against the exact private snapshot.
7. Admit the exact returned mutation batch and evaluate the next private
   Blueprint.
8. Persist request receipt, step, stage spans, handle bindings, and one
   revision increment atomically.

An idempotent replay is checked before the authoring-phase gate so a response
lost immediately before review can still return its already committed receipt.
A genuinely new step cannot append while review, blocked, or accepted.

## Handle rules

- Spelling is `@[a-z][a-z0-9_-]{0,63}`.
- One handle binds once to one server-minted UUID and one entity kind.
- One UUID has at most one handle in a set.
- Exact `{ "handle": "@name" }` objects are the only reference form.
- Creation slots declare handles before canonical schema parsing; target and
  anchor slots reference existing bindings and never mint entities.
- Resolved UUIDs, never handles, are persisted in mutation steps and canonical
  state.
- Candidate-visible results and summaries project the durable handle back over
  an authored UUID so the model never has to manage the canonical identity.

## Materialization invariants

1. Only a `design-candidate` genesis set at its exact current revision may use
   the reviewed publication path.
2. The session must select an `accepted` checkpoint for that same set and
   revision, and replay must derive the same candidate digest.
3. Whole-document validity, export readiness, organization integrity, exact
   media admission, lookup edges, and case-schema admission run inside the
   transaction.
4. The app row, entities, reference edges, sequence-1 baseline, runtime schema,
   set commit, and session holder/reservation transfer commit together or not
   at all.
5. Membership loss, holder loss, Project movement, revision drift, stale
   external reads, or digest mismatch stop publication.
6. The first visible app is complete. No intermediate workflow is exposed for
   editing.

## Tests

Use real Postgres tests for authority, idempotency, phase gates, checkpoint and
review lineage, statement-boundary atomicity, materialization, and replay.
Pure tests cover handle declarations/resolution, schema projection,
diagnostics, read sets, and mutation admission. Scope async-leak checks to the
touched files; never run the full leak sweep locally.

# lib/agent/design: reviewed executable app design

This package owns the private design state for a reviewed chat build. The
design is the executable private `BlueprintDoc`, not a parallel product model.
The Solutions Architect authors that candidate through ordinary Nova tools,
an independent reviewer checks its exact digest, and an accepted checkpoint is
the only candidate that may materialize.

Nothing here is canonical app state. A private candidate cannot render,
preview, export, stream to peers, write case data, or bypass the ordinary
validator and canonical transaction kernel. Direct builder/chat/MCP edits do
not consult design metadata.

## Current production path

- `sourcePackage.ts` is the authorized source boundary. It projects bounded
  user messages, answered question rounds, Project-authorized attachment
  extracts, digest-bound images, and platform constraints. Persisted packages
  hold references and proof hashes rather than copied source bodies.
- `candidate.ts` defines the only sidecar design vocabulary:
  `DesignBriefV1`, exact-review findings, and human-readable Blueprint
  coordinates. The brief records objective, consequential decisions,
  external requirements, unsupported requests, and open questions; it never
  duplicates app structure or carries a traceability matrix.
- `candidatePrompt.ts` holds the static author and independent-reviewer
  instructions. One session builds one app in the current Project. The author
  cannot create Projects or media bytes and must use handles for every app
  identity it creates.
- `candidateAgent.ts` mounts all stageable shared high-level tools except the
  granular `stageModule` and `stageForm` helpers. Candidate-facing schemas
  widen handle-eligible identity slots and require a handle-backed identity on
  every server-minted bulk item. Tool results and recovered state project
  durable handles over authored UUIDs. `finishCandidate` is private and
  checkpoints only a clean exact workspace.
- `candidateReviewer.ts` is one fresh Sol xhigh structured review over the
  authorized source package, exact Blueprint JSON/digest, and brief. A
  corrected candidate receives focused verification against the findings that
  required it.
- `candidateStore.ts` owns immutable candidate checkpoints and reviews plus
  exact session selection. Every write locks and reauthorizes the live
  `(runId, holderNonce)`, actor, and Project. The durable phase is
  `authoring | reviewing | revising | blocked | accepted`; only authoring and
  revising may append Blueprint steps.
- `designGenerationContext.ts` is the pre-app structured-generation context,
  sharing provider, logging, metering, cancellation, and strict structured
  output behavior with app-bound generation.
- `artifactResult.ts` is the small common structured-call result adapter.

`build/candidateLoopRunner.ts` owns the outer loop and stream projection. It
inserts the source package, opens/rebinds the candidate change set, restores
the active checkpoint/review/phase, runs authoring and review, and returns only
an accepted checkpoint, a question pause, or a classified stop. Private tools
never render in chat.

The contract/revision/build-plan modules and `design/loop/` are not imported by
the reviewed initial-build orchestrator. Do not build Unit F or Unit G on
those parallel artifact shapes; the binding plan is
`docs/plans/reviewed-intent-atomic-change-sets-plan.md`.

## Phase protocol

1. `authoring`: build the complete private Blueprint. Only this initial phase
   may call `askQuestions`, and only for a decision that materially changes the
   app.
2. `reviewing`: checkpoint the exact clean workspace and freeze mutations.
3. Independent review: advisory findings may pass; critical or important
   findings move the exact checkpoint to correction.
4. `revising`: edit the same candidate with the review in context, preserving
   correct work. No user questions are mounted.
5. Focused verification: check the corrected digest against the findings that
   required the change.
6. `accepted`: create an accepted checkpoint only when the exact active digest
   has its required non-blocking persisted review.

If focused verification still blocks, the candidate freezes in `blocked` and
does not publish. Only the explicit Continue-build redrive may reauthorize and
move that exact checkpoint back to `revising`. An ordinary new message cannot
redirect the build.

## Compaction and recovery

OpenAI automatic compaction may replace old model-visible turns, never durable
state. After a compatible compaction checkpoint, stale private-state messages
are removed and the runner appends a fresh server-derived Blueprint summary,
handle map, current findings, and active review. The visible thread remains
complete.

A process restart reopens the same change set and reconstructs the candidate
from the canonical base plus admitted steps. The checkpoint/review/phase and
handle table, not model memory or tool transcripts, determine what happens
next.

## Invariants

1. The private Blueprint is the design. No non-executable contract or plan is
   implementation authority.
2. A checkpoint binds one exact workspace revision, candidate digest, source
   package digest, brief digest, run, and session.
3. A full review belongs only to an original draft. A focused verification
   belongs only to a corrected draft.
4. Acceptance requires the exact active digest and its non-blocking review.
5. Every newly authored app identity is handle-backed and server-minted.
   External Project resources remain canonical identities.
6. Source content is untrusted data and cannot redefine tools, policy, or
   authority.
7. Model-facing prose never exposes schemas, UUIDs, validation internals,
   review machinery, or implementation protocols to the user.
8. Operational tool diagnostics contain only opaque call identity, tool name,
   duration, input size, and stable outcome code, never payloads, validation
   prose, source text, or customer-authored names.

## Tests and scripts

Focused tests pin the candidate schemas and prompt boundaries, handle
projection, source packages, strict review output, phase transactions,
compaction reinjection, and exact accepted materialization. Live schema or
browser/model benchmarks spend money and require explicit approval.

Read-only design inspectors may expose private artifacts only to an authorized
operator and must keep their output out of user-facing chat.

# lib/agent/design — the Design Contract domain and the design agent loop

A typed, evidence-linked, NON-EXECUTABLE design layer: the vocabulary a
chat-started app is designed in (actors/tasks/records/facts/rules/read
models/lookup tables/access/navigation/decisions/scenarios), the
server-gated agent loop that authors it, the independent review of it, and
the digest-bound slice plan that lowers it. Nothing here
is a Blueprint phase: no wire emitter, no Preview, no export, no mutation
authority — design artifacts influence a build brief and can do nothing
else, and a stale or absent Design Contract never blocks a valid human or
direct MCP edit.

## Authority

- `ids.ts` — `DesignId`: canonical UUID bytes, a SEPARATE brand from the
  Blueprint's authored `Uuid`. Never passes into a canonical mutation
  without an explicit implementation binding.
- `evidence.ts` / `platformConstraints.ts` — source references are
  POINTERS (message coordinate, attachment-extract coordinate, image
  asset-id + bytes digest, catalogued constraint code), never copies; the
  constraint-code leaf is the closed citable platform vocabulary
  (dependency-free so validators don't drag the tool registry in). An
  explicit claim must cite a message, attachment, or image source — the
  claim schema enforces it, and an image citation is bound to the exact
  bytes the model saw.
- `contract.ts` + `graph.ts` — the contract collections and
  `validateDesignGraph`, which runs INSIDE the schema parse (id
  uniqueness across one namespace, kind-compatible reference closure,
  claim represent-or-defer, fact-writer/answer-capture coherence,
  record-bound transition writes, acyclic parent forests, blocking
  questions naming their intents, scenarios exercising the workflow). An
  incoherent contract is an invalid structured output, never an artifact.
  A `lookup` fact source names the contract's own `lookupIntents` — a table
  intent and one of THAT table's columns — with no exemption; lookup
  intents describe Project reference data an external action loads, so
  they are deliberately absent from `implementableIntentIds` and no slice
  owns one.
- `review.ts` — findings (severity EARNED by basis: heuristic never
  critical, source-supported critical needs source refs,
  platform-critical needs a catalogued code), dispositions, and closure.
  Cross-artifact rules are SCHEMA FACTORIES (`designReviewSchemaFor`,
  `designRevisionResultSchemaFor`) so ungrounded output fails the parse;
  the structural schemas serve persisted reads, where digest binding
  proves the artifact unchanged since its validated write. The
  sensitivity pair rule (`validateSensitivityNotSilentlyLowered`) runs in
  the reviser call.
- `buildPlan.ts` — slices/external actions/ownership;
  `validateSlicePlanStructure` (one materialization root, acyclic DAG,
  ownership coherence, root-closure external-action timing, no pre-app
  data migration) plus `buildPlanSchemaFor(contract)` (exact ownership
  over the implementable intents, scenario coverage, parent-selection
  reachability). New-plan admission additionally caps one slice at 30 owned
  intents so the bounded executor receives task-complete work it can finish;
  persisted schemas still read older wider plans. `buildPlanDraftSchema` is
  the planner MODEL's shape — the server stamps plan id and revision identity.
- `complexity.ts` — deterministic depth (`compact|standard|extended`),
  persisted with each contract envelope; controls process depth and the
  conservative user estimates (about 25 / 45 / 75 minutes), never
  Blueprint authority or validity.
- `envelope.ts` + `artifactStore.ts` — the immutable artifact envelope
  (canonical-JS digest over every field but the digest) and the ONE
  read/write boundary over the five artifact tables. Insert-only;
  predecessor digests proved on insert; `::text` +
  `parsePersistedJsonText` + the exact producer schema on every read (a
  revision re-proves its whole graph); acceptance impossible without a
  persisted review of the parent draft; dispositions land in the
  revision's transaction; plans only over accepted revisions. Table
  policy lives in `lib/db/privilegeConvergence.ts` (append-only, never
  row-locked) and the DDL in
  `lib/case-store/migrations/20260808000000_design_artifacts.ts`
  (`design_session_id` bound to `design_sessions(id)` by the
  design-session unit's migration).
  Every insert first locks the session's live authority carrier (the session
  before genesis, its delegated app afterwards), proves the exact build
  `(runId, holderNonce)` and fresh Project edit membership in that transaction,
  then verifies artifact ancestry before inserting. Selecting the active
  revision/plan uses the same authority proof and accepts only an accepted
  revision plus a same-session plan that targets it.
- `sourcePackage.ts` (+ `sourcePackageDeps.ts`, the production resource
  seams split out so the pure builder never drags the office-parser import
  graph into a consumer) — the one boundary turning a caller-authorized
  transcript into model input: bounded labeled blocks, Project-verified
  attachments through the extraction store, image projections bound by
  content digest (that digest is also the image's citable coordinate, in
  the labeled `sources` index and on the rendered image label), honest
  over-bound REJECTION (never silent clipping of a source away), and a persisted payload of references + normalized claims
  only — no extract bodies, no transcripts, no image bytes.
- `prompts.ts` — versioned static system prompts + renderers.
  `DESIGN_PROMPT_VERSIONS` rides every envelope; bump on any
  meaning-bearing change after the prompt has shipped; one version key never
  describes two production prompt contracts. Both prompts open with the shared
  `DOMAIN_PREAMBLE`: the reviewer runs a fresh context and the agent's context is born per
  session, so the preamble names the domain (CommCare, Dimagi, what a
  case is, offline-first, NOT a general app platform) to activate the
  model's real prior knowledge and keep a design from drifting toward a
  web/mobile stack — without it "Nova" is an undefined word. Source text
  renders inside fixed `<nova:source>` delimiters with the source-is-data
  contract stated in every system prompt.
- `loop/` — the design agent: ONE `ToolLoopAgent` (`designAgent.ts`) that
  asks, drafts, dispositions, and plans through server-executed tools
  (`tools.ts`), with legality decided from durable artifact ancestry
  (`gates.ts`). `submitContract` opens a design cycle; `requestReview`
  runs the independent reviewer over the draft's OWN package, re-rendered
  from its persisted reference row when the digest has moved
  (`packageRebuild.ts`) and refused honestly when the sources no longer
  reproduce it; `submitRevision` proves disposition closure plus the
  sensitivity pair rule inside execute; `submitPlan` lowers the accepted
  revision. Rounds count persisted reviews along the OPEN cycle (above
  the newest accepted revision), so a crash, a resume, or a question
  round can never mint a free review, and answers to an accepted design's
  blocking questions reopen a fresh reviewed cycle. Submissions register
  the strict wire projection (`strict: true`) and run the exact schema
  factories inside execute, so a rejection is a repairable tool result,
  bounded at two consecutive per kind. The immediately preceding rejected
  contract/revision stays only in that live loop; a retry may replace named
  top-level contract sections (or the revision's complete disposition set),
  after which the full graph and cross-artifact proofs run again. On a contract
  repair the strict wire's fixed `schemaVersion: 1` sibling is envelope
  scaffolding, not a second authored form; every other full-contract sibling
  remains an illegal mixed submission. A second
  review is evidence-based: unresolved critical risk, at least two critical
  first-pass findings, or critical feedback that changed architecture; depth
  alone is not a trigger. `claimSeeding.ts` derives
  cumulative deterministic claims from every answered question round
  (name-based UUIDs over thread coordinates), which is what makes package
  rebuilds byte-identical. `packageRender.ts` decomposes the package onto
  the conversation (per-message source blocks; cumulative claims ride the
  per-turn state message). The package is PURE — its stream/session
  writers live in `lib/agent/build/designLoopRunner.ts` (invariant 6).
- `reviewer.ts` — the one call that stays a fresh-context one-shot
  structured call over `lib/agent/modelRunContext.ts` (the §7.5 seam;
  `designGenerationContext.ts` is the pre-app implementation), because
  fresh context IS its value. Its inputs are EXACTLY the source package,
  the proposed contract, and the capability catalog — never agent
  reasoning or prior reviewer prose, never tool authority.
- `capabilityCatalog.ts` — generated from `SHARED_TOOL_REGISTRY`, the
  field/case-data vocabularies, and the constraint leaf; snapshot-pinned
  (`__tests__/capabilityCatalog.test.ts`), with gap codes pinned against
  the remaining `docs/plans/complex-app/` unit files. It explains
  capability; it cannot emit mutations.

## Invariants

1. Design artifacts are immutable, schema-validated on read, revisioned,
   digest-bound to their inputs, and explicitly superseded — never
   updated in place.
2. "Reviewed" is true only when a persisted review artifact and complete
   finding dispositions exist for that exact revision. A failed reviewer
   call can never be labeled reviewed.
3. Source content is untrusted data: it cannot redefine orchestration
   policy or tool authority, and secrets never enter a source call.
4. Evidence points at authorized source material; raw attachments,
   transcripts, and hidden reasoning are never duplicated into design
   tables.
5. Every digest is the shared canonical-JS discipline
   (`lib/utils/canonicalJson.ts`).
6. Nothing here reaches a canonical store: no `app_changes`, no SSE, no
   NOTIFY, no Blueprint mutation, no external write. The consumers live
   outside the package: change sets strict-parse `DesignId`s, and
   `lib/agent/build`'s orchestrator runs this pipeline behind the chat
   route's design-session turns and executes its accepted plans.

## Tests

`__tests__/designGraph.test.ts`, `designReview.test.ts`,
`buildPlan.test.ts`, `complexity.test.ts` (clone-and-break rule
coverage over the `fixtures.ts` contract/plan);
`artifactStore.integration.test.ts` (digest binding, predecessor proofs,
tamper/unknown-dialect fail-closed, disposition atomicity);
`loop/__tests__/gates.test.ts` (cycle legality, round derivation,
budgets); `designLoop.integration.test.ts` (the loop's tools over the
real store with a scripted context); `sourcePackage.test.ts` (bounds, digest
content-binding, honest rejection); `capabilityCatalog.test.ts` (the
drift tripwire). The wire pin for the calls is
`lib/agent/__tests__/designGenerationContextWire.test.ts`.

## Scripts

`scripts/preview-app-design.ts` (⚠️ live model calls — a scripted
in-memory loop preview: real agent prompt, real schemas, real reviewer,
interactive question rounds, no persistence) and
`scripts/inspect-design-artifacts.ts` (read-only session inspector,
`--prod` capable; `--reasoning` prints each artifact's reasoning
summaries from the run event log).

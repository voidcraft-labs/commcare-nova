# lib/agent/design — the Design Contract domain and review pipeline

A typed, evidence-linked, NON-EXECUTABLE design layer: the vocabulary a
chat-started app is designed in (actors/tasks/records/facts/rules/read
models/lookup tables/access/navigation/decisions/scenarios), the independent
review of that design, and the digest-bound slice plan that lowers it. Nothing here
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
  reachability). `buildPlanDraftSchema` is the planner MODEL's shape —
  the server stamps plan id and revision identity.
- `complexity.ts` — deterministic depth (`compact|standard|extended`),
  persisted with each contract envelope; controls process depth only.
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
  meaning-bearing change. Every system prompt opens with the shared
  `DOMAIN_PREAMBLE`: each call is a fresh context, so the preamble names
  the domain (CommCare, Dimagi, what a case is, offline-first, NOT a
  general app platform) to activate the model's real prior knowledge and
  keep a design from drifting toward a web/mobile stack — without it
  "Nova" is an undefined word. Source text renders inside fixed
  `<nova:source>` delimiters with the source-is-data contract stated in
  every system prompt.
- `author.ts` / `reviewer.ts` / `reviser.ts` / `planner.ts` — thin
  structured calls over `lib/agent/modelRunContext.ts` (the §7.5 seam;
  `designGenerationContext.ts` is the pre-app implementation). ALL FOUR
  calls receive the rendered capability catalog — the author designs
  within the constructible surface rather than having the reviewer
  discover the overrun a paid round later. The reviewer's independence
  is unchanged: EXACTLY the source package, the proposed contract, and
  the catalog — never author reasoning or prior reviewer prose, never
  tool authority.
- `capabilityCatalog.ts` — generated from `SHARED_TOOL_REGISTRY`, the
  field/case-data vocabularies, and the constraint leaf; snapshot-pinned
  (`__tests__/capabilityCatalog.test.ts`), with gap codes pinned against
  the remaining `docs/plans/complex-app/` unit files. It explains
  capability; it cannot emit mutations.
- `pipeline.ts` — the SERVER-OWNED bounded machine: source package →
  draft → review → dispositions + accepted revision → plan, each
  transition durable before the next call. Bounds: one author, one
  review, one revision on gated findings, one second round only when the
  first revision leaves a critical finding or changes architecture
  (extended depth always re-reviews), no third loop. A failed review
  leaves the draft persisted and UNREVIEWED; blocking questions on the
  accepted revision short-circuit to `awaiting-input` with no plan;
  rerunning with the same package converges on committed artifacts.
  Models never decide whether a required phase happened.

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
`designPipeline.integration.test.ts` (the bounded machine over the real
store with a scripted context); `sourcePackage.test.ts` (bounds, digest
content-binding, honest rejection); `capabilityCatalog.test.ts` (the
drift tripwire). The wire pin for the calls is
`lib/agent/__tests__/designGenerationContextWire.test.ts`.

## Scripts

`scripts/preview-app-design.ts` (⚠️ live model calls — artifact-quality
preview, no persistence) and `scripts/inspect-design-artifacts.ts`
(read-only session inspector, `--prod` capable).

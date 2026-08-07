# Unit C deviations log (working file — folded into the plan at the end, then deleted)

Decisions made while implementing Unit C that refine, interpret, or deviate
from the plan text. Each entry names the plan section it touches.

## Resolved interpretations (fold into plan text)

- **§6.1 file layout.** `projection.ts` already became `projection/`
  (Unit B). Unit C adds `platformConstraints.ts` (the closed constraint-code
  leaf both the graph validator and the capability catalog consume),
  `graph.ts` (validateDesignGraph — too large to inline in `contract.ts`),
  `envelope.ts` (§6.12), `sourcePackage.ts` (§6.14), `pipeline.ts` (§7.1/7.3
  bounded state machine), `capabilityCatalog.ts` (§7.6), `artifactStore.ts`
  (persistence over lib/db), `designGenerationContext.ts` (§7.5 impl).
  Dispositions (§6.13) live in `review.ts`. `conformance.ts` / `quality.ts`
  are Unit F and do not land here.
- **§6.13 closure validation shape.** `validateDispositionClosure` needs the
  parent draft's review passes, which a bare zod refinement cannot see. It is
  a schema FACTORY: `designRevisionResultSchemaFor(reviews)` binds the
  closure check into the parse, so an invalid closure is an invalid
  structured output (retriable), exactly like any other parse failure. A
  structural `designRevisionResultSchema` (self-contained refinements only)
  remains for persisted reads, where digest binding proves the artifact
  unchanged since its validated write.
- **§7.2 finding evidence validation shape.** Same factory pattern:
  `designReviewSchemaFor(contract, sourcePackage)` binds
  `validateFindingEvidence`'s cross-artifact rules (intent existence,
  evidence-ref membership) into the reviewer parse; the structural
  `designReviewSchema` covers persisted reads.
- **§6.15 sensitivity-lowering rule placement.** "Sensitivity cannot be
  lowered by a reviser without a source-supported rationale" is a
  revision-PAIR property, not a single-graph property; it is enforced in the
  reviser acceptance path (parent contract vs revised contract comparison),
  not in `validateDesignGraph`.
- **§6.15 "owning intent" definition.** An explicit in-scope claim is
  "represented" when at least one implementable intent (record, fact, rule,
  task, transition, read model, access policy, navigation) lists it in
  `evidence`. Actors, decisions, assumptions, scenarios are context, not
  owners.
- **§8.2 intent-ownership domain.** The intents requiring exactly one owning
  slice are the implementable intents of the accepted contract (records,
  facts, rules, tasks, transitions, read models, access policies,
  navigation). Intents present in the accepted contract are by construction
  the non-deferred in-scope set — deferral happens at claim level and the
  reviser removes/never-creates intents for deferred claims.
- **§8.2 materialization-root external actions.** "No post-materialization
  external action in the root's transitive prerequisite closure" is enforced
  as: every external action referenced by the root or its transitive
  prerequisites has timing `before-materialization` or `manual-setup`.
- **§8.2 rule 10 (exclusive slices).** Plan-level validation checks an
  `exclusive` slice is not the materialization root; the actual
  one-exclusive-command fence is the change-set admission fence (Unit B).
- **§6.12/§18.2 source-package row shape.** `design_source_packages` is a
  deterministic projection, not a model artifact: its row carries the package
  digest and payload but no producer/prompt-version columns (there is no
  model producer to record).
- **§6.12 acceptance is insert-only.** A revision row's `lifecycle` is fixed
  at insert (`draft` or `accepted`); acceptance of a reviewed draft with no
  required revision inserts a NEW `accepted` revision row (parent = the
  draft, envelope inputs include the review digest) rather than mutating the
  draft row.
- **§7.5 GenerationTarget leaf.** Unit C lands `lib/db/generationTargets.ts`
  as a type/schema leaf only (the closed `app | design-session` union);
  Unit D adds the resolver module around it — same landed-early pattern as
  `design/ids.ts`.
- **§7.5 abort support.** `subGeneration.ts` gains `abortSignal`
  pass-through (the AI SDK already accepts it); this extends the shared
  core rather than duplicating it.

## Open questions / to fold

(none yet)

# Valid Revisions, Reviewed Intent

## Current architecture and remaining implementation plan for design-driven builds and Atomic Change Sets in CommCare Nova

**Primary goal:** Improve app design quality, worker UX, and agent authoring ergonomics without weakening valid-by-construction, multiplayer safety, transcript durability, run/credit authority, Preview truthfulness, case-store coherence, or export guarantees.

Repository references use stable `file::symbol` names rather than line numbers.
Sections 1–13 describe the current foundation and label their Unit F
completion extensions inline. Section 14 and §15.15 specify remaining Unit F;
Sections 16–17 specify remaining Unit G. Section 18 labels current persistence
separately from the rows Unit F adds. Section 19 is the only delivery sequence:
Unit F followed by Unit G.

## 1. Decision

Nova preserves the absolute whole-document commit gate and uses two non-canonical state spaces around it:

1. A **typed, non-executable Design Contract**, authored and independently reviewed before construction.
2. A **private Atomic Change Set**, where one slice executor can assemble a dependency-closed workflow across multiple idempotent staging calls before attempting one canonical commit.

Neither state space is a Blueprint phase. Neither is consumed by Preview, export, deployment, the multiplayer reconciler, case-store consumers, or ordinary app readers. The canonical Blueprint remains the only executable app representation and remains fully valid at every persisted sequence.

A chat-started app begins as a durable **design session**, not as an app. The first app revision is created only when:

- the accepted Design Contract and build plan name a materialization slice;
- that slice's Atomic Change Set is complete;
- its exact private candidate has zero gating findings against fresh external context;
- the candidate is export-ready;
- required runtime case-schema rows can be admitted transactionally;
- the caller still owns the exact design-session holder and reservation.

That complete candidate becomes the immutable sequence-`1` fold baseline. Private genesis steps remain provenance, not replay history.

The explicit **Start with a blank app** path remains. Its requested product is the smallest valid app, so it materializes the canonical Survey/Form/Question scaffold through the same closed genesis owner. MCP's direct `create_app` retains this explicit minimal-app contract.

There is still:

- no stored invalid Blueprint;
- no Blueprint draft mode;
- no per-surface validity regime;
- no post-hoc `validateApp` repair loop;
- no finishing operation that changes invalid state into valid state;
- no staged mutation in `app_changes`, app SSE, Preview, presence, or peer reconciliation;
- no model review that can override the canonical validator;
- no stale Design Contract that can block a valid human or direct MCP edit.

The build orchestrator may make a completion assertion about intent coverage and quality. That assertion controls messaging and workflow status only. It creates no Blueprint state transition.

## 2. Why this is the right boundary

The repository has the non-executable design frontend and private compiler workspace around its canonical backend.

- `lib/agent/workspace` gives shared tools one workspace-owned snapshot and serialized mutation host; direct chat/MCP edits still commit immediately through the canonical host.
- `lib/agent/change-set` persists admitted private steps, local handles, read sets, diagnostics, exact intent coverage, and all-or-nothing canonical commits.
- `lib/agent/design` owns strict, immutable, digest-bound source packages, contracts, independent reviews, dispositions, and build plans.
- `lib/agent/design/loop` runs design as one server-gated agent loop whose durable artifact ancestry, not transcript prose, decides what is legal next.
- `lib/db/designSessions.ts`, target-polymorphic threads/streams/summaries, and `app/api/chat/route.ts` provide pre-app run, credit, conversation, pause, resume, and recovery scope.
- `lib/agent/build` derives slice briefs, enforces bounded one-call executor steps, blocks on receipted external prerequisites, and folds an append-only orchestration chain under the exact live holder.
- `lib/agent/change-set/materializeGenesis.ts` and `lib/db/appGenesis.ts` create the first meaningful export-ready app revision atomically, including organization/media/lookup/runtime-schema integrity and holder transfer.
- `lib/db/canonicalCommitSidecars.ts` commits the exact running slice attempt, receipt, and staged implementation provenance with the canonical revision.
- The explicit blank path still creates the canonical Survey/Form/Question starter through the same genesis owner; design-driven chat never flashes that starter.
- `lib/domain/users.ts` distinguishes user properties, user types, and Preview personas. The UX-level actor remains a separate design concept until Unit G binds amended intent to current implementation.

The architectural move is therefore not “permit invalid apps while building.” It is:

> Permit incomplete reasoning and a private admitted mutation program outside the app, while preserving the existing canonical transaction, fold, collaboration, and runtime contracts.

The hard boundary is causal:

- Design artifacts may influence a build brief but cannot execute.
- A staged mutation may influence a private candidate but cannot reach canonical stores.
- Only the existing canonical admission semantics can create a visible revision.
- Review may request another valid revision but cannot retroactively redefine validity.

## 3. Non-negotiable invariants

These invariants bind every implementation unit and test.

### 3.1 Canonical app invariants

1. Every persisted Blueprint passes the same absolute whole-document gate used by current chat, MCP, and builder writes.
2. Every committed mutation batch crosses the exact JSON/mutation admission boundary before reduction, persistence, streaming, or logging.
3. Every canonical write reauthorizes the actor against the fresh Project and, for chat, proves the exact `(mode, runId, holderNonce)` capability.
4. Every canonical write replays the admitted batch against the fresh locked app snapshot; no caller-supplied prospective document is authoritative.
5. Lookup, media, organization, case-schema, entity, history, and notification behavior use one shared commit kernel and retain current lock order.
6. Preview reads only canonical Blueprint and canonical runtime stores.
7. Export and HQ upload re-run zero-tolerance boundary validation.
8. Multiplayer peers receive only committed canonical batches or a full canonical reload.
9. Sequence `1` is a complete immutable fold baseline, never a placeholder or partial scaffold.
10. A canonical app change and its design provenance sidecars commit together or neither commits.
11. Performance-index convergence is never confused with Blueprint or runtime-schema validity.

### 3.2 Design-layer invariants

1. A Design Contract is never embedded in `BlueprintDoc`.
2. A Design Contract has no wire emitter and cannot be previewed, submitted, exported, or deployed.
3. Reviewer findings cannot directly mutate the contract or Blueprint.
4. Every persisted design artifact is immutable, schema-validated on read, revisioned, digest-bound to its inputs, and explicitly superseded rather than updated in place.
5. Evidence points to authorized source material. Raw attachments, full transcripts, secrets, and hidden reasoning are not duplicated into design tables.
6. Source content is treated as untrusted data. It cannot redefine orchestration policy or tool authority.
7. Design actors are not Preview personas. A later binding maps an actor to user types/personas.
8. A stale or absent Design Contract never blocks a valid human or direct MCP edit.
9. “Reviewed” is true only when a persisted review artifact and complete finding dispositions exist for that exact contract revision.

### 3.3 Workspace and change-set invariants

1. The workspace owns its current document. Tool callers cannot nominate a different `prevDoc`.
2. Every tool invocation reads one immutable `WorkspaceSnapshot` and carries its opaque revision into its one allowed workspace write.
3. Read and write ordering is explicit and durable; it never depends on SDK parallelism or microtask timing.
4. An open change set is private to one design session/run and never enters `app_changes`.
5. Staged mutations are exact admitted canonical mutations after handle resolution.
6. Missing targets, malformed JSON, identity collisions, invalid anchors, unsupported exclusive combinations, stale workspace revisions, and unrecorded required read sets reject before a step is appended.
7. Shape, soundness, and completeness findings may exist only in the private candidate.
8. A stage request is idempotent by stable request ID and input digest. A retry returns the original receipt.
9. Handle binding and step append are one transaction.
10. The candidate is derived from the exact canonical base plus durable admitted steps; it is never an independently editable stored document.
11. A change-set commit is all-or-nothing against the fresh canonical base.
12. A rejected commit retains steps for amendment and never requires reconstruction of prior successful payloads.
13. Side-effecting tools without a canonical transaction/compensation contract are impossible to invoke in a staging context.
14. Process-local caches and mutexes may improve performance but are never correctness authorities.

### 3.4 Run, credit, transcript, and stream invariants

1. One per-actor transaction gate serializes admission across both app and design-session generation targets.
2. Claim, cross-target concurrency check, affordability check, reservation, and holder write remain one transaction.
3. Materialization transfers the exact holder and unsettled reservation once; a claimed-but-unreserved or double-reserved target is unrepresentable.
4. Pause, resume, re-drive, reaping, refund, settle, and holder-loss semantics remain target-polymorphic versions of the current app protocol.
5. A thread write preserves merge-by-message-ID, step-barrier snapshots, terminal marker retirement, failure claw-back, and tombstones.
6. Stream chunks remain idempotent by `(stream_id, first_index)` and retain terminal outcome semantics.
7. A target transition never changes thread ID, run ID, stream ID, response message ID, or chunk cursor.
8. A reconnect after materialization can resolve the design session to its app without requiring a lost transient event.

### 3.5 User-trust invariants

1. A clarifying conversation that never builds leaves no app in the app list.
2. The structure tree never shows a placeholder module the user did not request.
3. Nova never says a staged change is saved.
4. Nova never says a reviewer checked a design when the review call or artifact persistence failed.
5. Nova never claims intent completeness while critical source-grounded or deterministic conformance findings remain unresolved.
6. External/manual setup is named honestly and is never described as implemented app behavior.
7. A deterministic materialization failure creates no app. A post-commit performance-index failure does not falsely imply the app disappeared.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| **Generation target** | Closed runtime scope: an app or a design session. Threads, streams, usage, holder checks, and summaries accept this union. |
| **Design session** | Durable, Project-scoped workflow state for one high-level build or design-aware edit. It may exist before an app does. |
| **Design artifact envelope** | Immutable metadata wrapper binding a typed artifact to its session, revision, parent, source digest, schema/prompt version, producer, and timestamp. |
| **Design Contract** | Typed, versioned, non-executable representation of actors, tasks, records, facts, read models, access, decisions, assumptions, and scenarios. |
| **Design actor** | UX-level description of a person doing work. Distinct from a Blueprint user type or Preview persona. |
| **Design review** | Fresh-context structured critique of one exact Design Contract revision against authorized evidence and platform constraints. |
| **Finding disposition** | Accepted, rejected-with-rationale, or deferred-with-user-visible-consequence resolution tied to one review finding. |
| **Build slice** | Dependency-closed, task-complete vertical unit of implementation. It may cross modules, forms, case types, case lists, users, and actions. |
| **Tool workspace** | The sole owner of the document snapshot and mutation ordering for one canonical or change-set executor. |
| **Workspace revision** | Opaque monotonic token proving which workspace snapshot a tool invocation read. |
| **Atomic Change Set** | Private durable sequence of admitted mutation batches assembled against an exact base and committed as one canonical transition. |
| **Stage request** | Idempotent tool invocation identified by request ID, input digest, expected workspace revision, and persisted receipt. |
| **Change-set handle** | Private compiler-local symbol bound once to a server-minted canonical Blueprint UUID and resolved before mutation admission. |
| **External read set** | Exact mutable non-Blueprint observations a staged operation depends on, such as organization revision or media identity. |
| **Materialization** | Creation of the app row and meaningful sequence-`1` baseline from the first valid build slice. |
| **Runtime schema admission** | Transactional proof/write of case-schema rows required for case-store correctness. |
| **Index convergence** | Idempotent post-commit creation/removal of performance indexes; never a Blueprint-validity phase. |
| **Conformance review** | Sequence-keyed comparison of canonical implementation against accepted intent. It does not participate in Blueprint validity. |
| **Quality finding** | Deterministic or model-assisted observation about unnecessary complexity, workflow coherence, UX, or implementation quality. |
| **Canonical commit** | Existing valid-by-construction transition into app rows, Blueprint entities, `app_changes`, exact reference edges, and dependent transactional stores. |

## 5. End-state architecture

```text
User request + authorized source material
                 │
                 ▼
        Design-session run scope
 (thread, resumable stream, holder, credits,
  usage, artifacts; no app exists yet)
                 │
                 ▼
     Server-gated design agent loop
 (askQuestions anytime; submitContract /
  requestReview / submitRevision / submitPlan,
  legality decided from artifact ancestry)
                 │
                 ▼
     Stateless structured reviewer
      (one fresh-context call the
       requestReview tool runs)
                 │
                 ▼
  Accepted Design Contract revision
                 │
                 ▼
   Digest-bound build-slice plan
    (the loop's submitPlan tool)
                 │
                 ▼
     Slice-specific Tool Workspace
        ┌───────────────────────┐
        │ Atomic Change Set     │
        │ durable requests      │
        │ admitted steps        │
        │ local handles         │
        │ external read sets    │
        │ real diagnostics      │
        └───────────────────────┘
                 │
       zero gating findings
                 │
        ┌────────┴─────────┐
        │                  │
 first materialization   later slice
        │                  │
        ▼                  ▼
 prepared genesis      canonical commit
 transaction kernel    transaction kernel
        │                  │
 app + seq-1 baseline   sequence N change
 runtime schema rows    provenance sidecars
        │                  │
        └────────┬─────────┘
                 ▼
   post-commit index convergence
                 │
                 ▼
 deterministic implementation projection
                 │
                 ▼
 stateless implementation/quality review
                 │
                 ▼
       corrective valid slices
                 │
                 ▼
      honest completion assertion
```

Four implementation boundaries must remain explicit:

| State space | May be incomplete? | Executable? | Canonical visibility? | Source of truth |
| --- | ---: | ---: | ---: | --- |
| Design Contract | Yes | No | No | Immutable design artifact revision |
| Open Atomic Change Set | Yes | No | No | Exact base + durable admitted steps |
| Canonical Blueprint revision | No gating findings | Yes | Yes | App row/entities + admitted history |
| Pending performance-index work | Yes | Not app semantics | Operational only | Durable schema/index work queue |

The fourth row is deliberately not another application state. It is derived database convergence, comparable to current post-commit index work.

## 6. Design Contract domain

### 6.1 Package layout

The server-safe package is:

```text
lib/agent/design/
  ids.ts
  platformConstraints.ts
  evidence.ts
  contract.ts
  graph.ts
  review.ts
  buildPlan.ts
  complexity.ts
  envelope.ts
  artifactStore.ts
  sourcePackage.ts
  sourcePackageDeps.ts
  prompts.ts
  artifactResult.ts
  reviewer.ts
  capabilityCatalog.ts
  designGenerationContext.ts
  loop/
    designAgent.ts
    tools.ts
    gates.ts
    artifacts.ts
    claimSeeding.ts
    packageRender.ts
    packageRebuild.ts
  projection/
  conformance.ts   (Unit F)
  quality.ts       (Unit F)
  CLAUDE.md
```

`platformConstraints.ts` is the closed constraint-code leaf both the graph
validator and the capability catalog consume (dependency-free so the
validator never drags the tool registry into its import graph); `graph.ts`
holds `validateDesignGraph`; `envelope.ts`/`artifactStore.ts` are §6.12's
persistence; `loop/` is §7.1/§7.3's server-gated design agent (the tools,
their legality gates, and the envelope sealing), and `reviewer.ts` is the
one call that stays a fresh-context one-shot. `sourcePackageDeps.ts` holds the production resource seams separately, so the pure builder never drags the office-parser import graph (mammoth/bluebird) into a consumer.

The Zod schemas are the authority. TypeScript types are inferred from them. Every persisted JSONB artifact round-trips through the same schema used by its producer and reader.

### 6.2 Identity

Design identities use canonical UUID bytes but a separate TypeScript brand from authored Blueprint UUIDs.

```ts
export const designIdSchema = canonicalUuidStringSchema.brand<"DesignId">();
export type DesignId = z.infer<typeof designIdSchema>;
```

A `DesignId` is not in the Blueprint's global authored-identity namespace. It can never be passed to a canonical mutation as an entity UUID without an explicit implementation binding.

### 6.3 Source evidence

```ts
const sourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    threadId: z.string().uuid(),
    messageId: z.string(),
    partIndex: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("attachment-extract"),
    assetId: mediaAssetIdSchema,
    extractorVersion: z.number().int().positive(),
    sectionPath: z.array(z.string().min(1)).default([]),
    figureMarker: z.string().optional(),
  }),
  z.object({
    kind: z.literal("platform-constraint"),
    code: z.string().min(1),
    sourceAnchor: z.string().min(1),
  }),
]);

const sourceClaimSchema = z.object({
  id: designIdSchema,
  statement: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema).min(1),
  status: z.enum(["explicit", "inferred", "assumption"]),
  confidence: z.number().min(0).max(1),
});
```

Rules:

- Store normalized requirements, not raw source excerpts, unless an exact label/choice/value is itself the requirement.
- Do not store model reasoning.
- A claim marked `explicit` must carry a user-message or attachment source.
- A claim based only on Nova/CommCare capability knowledge uses `platform-constraint`, whose `code` is the closed vocabulary in `platformConstraints.ts` (enforced by the schema enum).
- An image requirement cites the IMAGE evidence coordinate — asset id plus content digest — and the author/reviewer prompts teach that citation; the attaching message remains citable for conversational context, but an image-only requirement is never reduced to it.
- A reviewer cannot create a source-supported critical finding without a source reference.

### 6.4 UX-level design actor

Use `DesignActor`, not `Persona`.

```ts
const designActorSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  responsibilities: z.array(z.string().min(1)),
  workContext: z.array(z.string().min(1)),
  authority: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  failureRisks: z.array(z.string().min(1)),
  evidence: z.array(designIdSchema),
});
```

Later implementation bindings map this actor to blueprint concepts:

```ts
const actorRuntimeBindingSchema = z.object({
  actorId: designIdSchema,
  userTypeUuid: uuidSchema.optional(),
  personaUuids: z.array(uuidSchema).default([]),
});
```

The binding is implementation provenance, not part of the actor's meaning.

### 6.5 Records and facts

```ts
const recordConceptSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  purpose: z.string().min(1),
  parentRecordId: designIdSchema.optional(),
  relationshipMeaning: z.string().min(1).optional(),
  lifecycleStates: z.array(z.string().min(1)),
  evidence: z.array(designIdSchema),
});

const factSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), taskInputId: designIdSchema }),
  z.object({ kind: z.literal("derived"), ruleId: designIdSchema }),
  z.object({ kind: z.literal("session"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("lookup"),
    lookupIntentId: designIdSchema,
    columnIntentId: designIdSchema,
  }),
  z.object({ kind: z.literal("external") }),
  z.object({ kind: z.literal("constant"), value: z.unknown() }),
]);

const factDefinitionSchema = z.object({
  id: designIdSchema,
  recordId: designIdSchema,
  name: z.string().min(1),
  meaning: z.string().min(1),
  dataShape: z.enum([
    "text", "integer", "decimal", "boolean", "date", "datetime",
    "single-choice", "multiple-choice", "location", "attachment", "unknown",
  ]),
  source: factSourceSchema,
  sensitivity: z.enum(["ordinary", "sensitive", "highly-sensitive"]).default("ordinary"),
  requiredIntent: z.string().optional(),
  writerTaskIds: z.array(designIdSchema),
  readerIds: z.array(designIdSchema),
  evidence: z.array(designIdSchema),
});
```

A fact's `source` is load-bearing. It is the basis for lowering direct field-to-case writes correctly and for identifying unjustified hidden writer fields.

The `lookup` arm's intent ids name the contract root's design-level lookup vocabulary (table/column intents), and the arm participates in graph closure like every other reference family — a lookup fact naming an undeclared intent rejects the artifact. Lookup intents are design vocabulary, not claim ownership: a slice's `owningIntentIds` never name them, and the canonical commit gate remains the runtime authority over real lookup references.

### 6.6 Tasks, inputs, transitions, and read-back

```ts
const taskInputSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  purpose: z.string().min(1),
  factId: designIdSchema.optional(),
  requiredIntent: z.string().optional(),
  choiceSetIntent: z.array(z.string()).optional(),
  evidence: z.array(designIdSchema),
});

const writeIntentSchema = z.object({
  id: designIdSchema,
  targetFactId: designIdSchema,
  sourceDescription: z.string().min(1),
  ruleId: designIdSchema.optional(),
});

const lifecycleTransitionSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  sourceRecordId: designIdSchema.optional(),
  targetRecordId: designIdSchema,
  transitionKind: z.enum(["create", "update", "close", "link", "reassign"]),
  conditionRuleId: designIdSchema.optional(),
  writes: z.array(writeIntentSchema),
  outcomeDescription: z.string().min(1),
  evidence: z.array(designIdSchema),
});

const taskSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  actorId: designIdSchema,
  goal: z.string().min(1),
  trigger: z.string().min(1),
  contextRecordId: designIdSchema.optional(),
  preconditions: z.array(z.string().min(1)),
  inputs: z.array(taskInputSchema),
  decisionRuleIds: z.array(designIdSchema),
  writes: z.array(writeIntentSchema),
  transitionIds: z.array(designIdSchema),
  readBackIds: z.array(designIdSchema),
  exceptionPaths: z.array(z.string().min(1)),
  evidence: z.array(designIdSchema),
});
```

A task describes a real-world transaction. A CommCare form is one possible lowering of a task; it is not the task itself.

### 6.7 Rules without a duplicate executable language

Do not create a second XPath or Predicate AST in the Design Contract. Design rules remain typed references plus an exact semantic statement:

```ts
const ruleIntentSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  statement: z.string().min(1),
  inputIds: z.array(designIdSchema),
  outputFactIds: z.array(designIdSchema),
  evidence: z.array(designIdSchema),
});
```

The build executor lowers a `RuleIntent` into the existing canonical `Predicate`, `ValueExpression`, `XPathExpression`, or validation representation. Conformance checks compare the implementation with the statement and referenced facts. No design rule is executed directly.

### 6.8 Task-oriented read models

```ts
const readModelSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  actorIds: z.array(designIdSchema).min(1),
  recordId: designIdSchema,
  decisionSupported: z.string().min(1),
  filters: z.array(z.string().min(1)),
  sortIntent: z.array(z.string().min(1)),
  scanFactIds: z.array(designIdSchema),
  detailFactIds: z.array(designIdSchema),
  searchFactIds: z.array(designIdSchema),
  selectionTaskId: designIdSchema.optional(),
  emptyStateMeaning: z.string().min(1),
  evidence: z.array(designIdSchema),
});
```

A CommCare case list is the primary lowering target, but the design object is a work queue/read model: who opens it, what decision it supports, what they scan, how urgency is ordered, and what happens after selection.

### 6.9 Access and navigation

```ts
const accessPolicySchema = z.object({
  id: designIdSchema,
  actorId: designIdSchema,
  targetIntentIds: z.array(designIdSchema).min(1),
  capability: z.enum(["discover", "view", "create", "update", "close", "administer"]),
  condition: z.string().optional(),
  locationScopeIntent: z.string().optional(),
  evidence: z.array(designIdSchema),
});

const navigationIntentSchema = z.object({
  id: designIdSchema,
  actorIds: z.array(designIdSchema).min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  entryTaskIds: z.array(designIdSchema),
  readModelIds: z.array(designIdSchema),
  parentNavigationId: designIdSchema.optional(),
  orderRationale: z.string().min(1),
});
```

Navigation is decided from worker tasks and read models. Module/menu hierarchy is the lowering target.

### 6.10 Decisions, assumptions, questions, and scenarios

```ts
const architectureDecisionSchema = z.object({
  id: designIdSchema,
  question: z.string().min(1),
  options: z.array(z.object({
    id: designIdSchema,
    description: z.string().min(1),
    consequences: z.array(z.string().min(1)),
  })).min(1).max(3),
  selectedOptionId: designIdSchema,
  rationale: z.string().min(1),
  evidence: z.array(designIdSchema),
});

const assumptionSchema = z.object({
  id: designIdSchema,
  statement: z.string().min(1),
  consequenceIfWrong: z.string().min(1),
  evidence: z.array(designIdSchema),
});

const openQuestionSchema = z.object({
  id: designIdSchema,
  question: z.string().min(1),
  structuralImpact: z.enum(["none", "local", "architecture"]),
  blocking: z.boolean(),
  relatedIntentIds: z.array(designIdSchema),
});

const acceptanceScenarioSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  actorId: designIdSchema,
  given: z.array(z.string().min(1)),
  when: z.array(z.string().min(1)).min(1),
  then: z.array(z.string().min(1)).min(1),
  relatedIntentIds: z.array(designIdSchema),
  evidence: z.array(designIdSchema),
});
```

### 6.11 Root contract

```ts
const appDesignContractSchema = z.object({
  schemaVersion: z.literal(1),
  id: designIdSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  inScope: z.array(z.string().min(1)),
  outOfScope: z.array(z.string().min(1)),
  sourceClaims: z.array(sourceClaimSchema),
  actors: z.array(designActorSchema).min(1),
  records: z.array(recordConceptSchema),
  facts: z.array(factDefinitionSchema),
  rules: z.array(ruleIntentSchema),
  tasks: z.array(taskSchema).min(1),
  transitions: z.array(lifecycleTransitionSchema),
  readModels: z.array(readModelSchema),
  accessPolicies: z.array(accessPolicySchema),
  navigation: z.array(navigationIntentSchema),
  decisions: z.array(architectureDecisionSchema),
  assumptions: z.array(assumptionSchema),
  openQuestions: z.array(openQuestionSchema),
  acceptanceScenarios: z.array(acceptanceScenarioSchema).min(1),
  deferredRequirements: z.array(z.object({
    claimId: designIdSchema,
    reason: z.string().min(1),
  })),
}).superRefine(validateDesignGraph);
```

`validateDesignGraph` proves internal referential closure, unique IDs, selected-option membership, fact/task consistency, acyclic navigation, and that every in-scope explicit claim is represented or explicitly deferred. It is not the Blueprint validator. It runs inside the schema's parse, so it executes everywhere the schema does — the producer call, the persistence boundary, and every persisted read.

---

### 6.12 Immutable artifact envelope and revision rows

The schemas above define artifact payloads. Persistence wraps every payload in a common immutable envelope:

```ts
const designArtifactEnvelopeSchema = <T extends z.ZodTypeAny>(
  artifactType: string,
  payload: T,
) => z.object({
  artifactType: z.literal(artifactType),
  artifactSchemaVersion: z.number().int().positive(),
  artifactId: z.string().uuid(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  designSessionId: z.string().uuid(),
  revision: z.number().int().positive(),
  parentArtifactId: z.string().uuid().nullable(),
  sourcePackageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputArtifactDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  promptVersion: z.string().min(1),
  producer: z.object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    finishReason: z.string().nullable(),
  }),
  createdAt: z.string().datetime(),
  payload,
}).strict();
```

Rules:

- `artifactDigest` is over the canonical exact JSON bytes of every authoritative envelope field except `artifactDigest` itself. It is not `JSON.stringify` of a live object with implementation-dependent key order.
- The producer metadata is operational provenance, not a claim that the same model call is deterministic.
- Raw prompts, raw model output, hidden reasoning, provider response bodies, and source documents are not stored in the envelope.
- An artifact row is insert-only. `accepted`, `superseded`, and `active` are relationships or pointers stored separately, not mutations of the artifact body. Acceptance of a reviewed draft is therefore a NEW `accepted` revision row (parent = the draft, inputs binding the review digest) — even when the content is unchanged — never a lifecycle flip on the draft row.
- A contract envelope additionally carries the deterministic complexity evidence (§7.4) as an optional `complexity` field, so the depth decision persists with the draft it graded.
- `active_design_revision` on `design_sessions` points only to a fully parsed accepted contract revision, and `active_build_plan` targets that exact revision in the same session. Selection locks the live session/app authority carrier, proves the exact holder and current Project edit membership, and verifies the lineage in the same transaction.
- Every read parses both envelope and payload through the current exact schema. Unknown keys fail closed.
- Prompt/schema version changes require a new artifact revision; they never silently reinterpret an old JSONB body.

Suggested rows:

```ts
interface DesignRevisionRow {
  id: string;
  designSessionId: string;
  revision: number;
  parentRevisionId: string | null;
  lifecycle: "draft" | "accepted";
  envelope: DesignArtifactEnvelope<AppDesignContract>;
  contractDigest: string;
  createdAt: Date;
}

interface DesignReviewRow {
  id: string;
  designSessionId: string;
  designRevisionId: string;
  reviewOrdinal: number;
  envelope: DesignArtifactEnvelope<DesignReview>;
  reviewDigest: string;
  createdAt: Date;
}
```

`design_sessions.active_design_revision_id` may point only to an `accepted` revision from the same session. Historical accepted revisions remain immutable; supersession is derived from the active pointer and revision ancestry, not by updating their payload/status. Revision numbering is monotonic per session with `(revision = 1) ⇔ (parent IS NULL)`: a fresh draft after a superseding source package parents the session's prior head, so ancestry records the supersession.

### 6.13 Review dispositions

Review dispositions use this persisted shape:

```ts
const findingDispositionSchema = z.object({
  findingId: designIdSchema,
  status: z.enum([
    "accepted",
    "rejected-with-rationale",
    "deferred-with-user-visible-consequence",
  ]),
  rationale: z.string().min(1),
  resultingIntentIds: z.array(designIdSchema),
  userVisibleConsequence: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (
    value.status === "deferred-with-user-visible-consequence" &&
    value.userVisibleConsequence === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["userVisibleConsequence"],
      message: "A deferred finding must state its user-visible consequence.",
    });
  }
});

const designRevisionResultSchema = z.object({
  contract: appDesignContractSchema,
  dispositions: z.array(findingDispositionSchema),
}).superRefine(validateDispositionClosure);
```

`validateDispositionClosure` needs the parent draft's review passes, which a bare refinement cannot see, so it binds as a schema FACTORY — `designRevisionResultSchemaFor(reviews)` — making an unclosed disposition set an invalid structured output (retriable) rather than a persisted artifact. The structural `designRevisionResultSchema` (self-contained refinements only) serves persisted reads, where digest binding proves the artifact unchanged since its validated write. Dispositions persist in the SAME transaction as the revision that carries them; in a two-round flow that revision is round one's re-reviewable draft, so dispositions may ride a draft — acceptance itself still requires a persisted review of the parent. It proves:

- every critical/important finding from every review pass for the parent draft appears exactly once;
- no unknown finding is dispositioned;
- accepted resolutions are represented by changed or newly linked intent IDs;
- a rejected source-supported or platform finding contains a contradiction/evidence rationale, not “model disagreed” (the deterministic layer cannot judge prose, so this rule is prompt-enforced; the schema requires a nonempty rationale);
- deferred critical findings create a blocking open question or an explicit deferred requirement — the disposition's `resultingIntentIds` must name it in the revised contract — and cannot be hidden from completion policy.

### 6.14 Evidence authorization and source-package construction

`lib/agent/design/sourcePackage.ts` is the only boundary that turns thread messages and attachments into model input.

```ts
interface DesignSourcePackage {
  schemaVersion: 1;
  designSessionId: string;
  projectId: string;
  packageDigest: string;
  request: ResolvedUserRequest;
  claims: SourceClaimSeed[];
  attachments: AuthorizedAttachmentProjection[];
  images: AuthorizedImage[];
  platformConstraints: PlatformConstraint[];
  /** The labeled index of every projected source — the closed set of
   *  references a reviewer may cite (plus catalog constraints). */
  sources: Array<{ ref: SourceRef }>;
}
```

Image attachments project as identity + content digest + transport
(`assetId`, `mediaType`, `bytesDigest`, `dataUrl`); the package digest
covers the identity and byte digest, never the base64 transport, and a
reviewer cites an image through the message that attached it.

The builder:

1. resolves the thread through its authorized generation target;
2. verifies every attachment still belongs to the same Project;
3. uses the existing extraction/figure pipeline and media-reference protection;
4. bounds text, table, and image projections by explicit per-source and total limits, REJECTING an over-bound source honestly (`SourcePackageError`) instead of silently clipping evidence away;
5. labels every source with an opaque source reference;
6. excludes assistant hidden reasoning and prior reviewer narrative;
7. computes one canonical digest over the exact projected package;
8. persists only source references and normalized claims (`design_source_packages.payload` — the digest, the claims, the labeled source index, and count/byte observability metadata; no extract bodies, transcripts, or image bytes). The row is a deterministic projection, so it carries no producer/prompt-version columns, and `(design_session_id, package_digest)` is unique — an identical rebuild converges on the stored row.

The design agent's and reviewer's system prompts state that all source text is **quoted data**, not instruction. A source that says “ignore prior instructions,” requests credentials, asks the model to call tools, or declares itself a system message has no authority.

### 6.15 Stronger graph validation

`validateDesignGraph` additionally proves:

- every `evidence` design ID points to a `sourceClaim`;
- `explicit` claims have at least one message or attachment source;
- `platform-constraint` claims have only catalogued constraint codes;
- every fact writer and reader reference resolves to a compatible intent kind;
- every `taskInput.factId` and `fact.source.answer.taskInputId` relation is mutually coherent;
- every transition write targets a fact belonging to its target record;
- access targets resolve only to targetable intent kinds;
- parent record and navigation graphs are acyclic;
- architecture-decision option IDs are local to that decision;
- every blocking open question is referenced by at least one affected intent or architecture decision;
- every non-deferred explicit in-scope claim has at least one OWNING intent — a record, fact, rule, task, transition, read model, or access policy citing it as evidence (actors, decisions, assumptions, and scenarios are context, not owners);
- every acceptance scenario references at least one task/transition/read model;
- sensitivity cannot be lowered by a revision without a dispositioned finding naming the fact — a revision-PAIR property enforced inside the submitRevision tool (`validateSensitivityNotSilentlyLowered`), not in the single-graph validator.

Graph validation is deterministic and runs before review, after revision, before build planning, and on every persisted read (it lives inside the contract schema's parse). `LookupTableIntent` is the contract's typed declaration of an external Project resource, not a Blueprint mutation ownership unit; the facts and tasks that consume it remain ordinary implementable intent roots, while any lookup data/schema work is represented as an external action.

## 7. Independent review pipeline

### 7.1 Orchestration

The design turn is ONE server-gated agent: a `ToolLoopAgent`
(`lib/agent/design/loop/`) that asks questions, drafts, dispositions
review findings, and plans, in one growing context under a per-session
prompt-cache key. The model still never chooses whether required phases
occur: every phase transition is a server-executed tool whose legality the
session's durable artifact ancestry decides (`loop/gates.ts`), and an
illegal call is a tool error naming the legal next action, never a state
change.

The tool surface:

- `askQuestions`: the existing client pause tool, always legal, any
  number of rounds; free-text questions carry an empty options list.
- `submitContract`: the complete contract, parsed through the exact
  schema and graph proof. Opens a design cycle; legal at session start
  and again only when later user input reopened design work (a stale
  unreviewed draft, or answers to an accepted design's blocking
  questions). A rejection returns the refinement messages AS THE TOOL
  RESULT: the in-loop repair, bounded at two consecutive rejections per
  submission kind.
- `requestReview`: the server runs the independent reviewer (§7.1 below)
  over the draft's OWN package, re-rendered from its persisted reference
  row when the digest has moved (`loop/packageRebuild.ts`) and refused
  honestly when the sources no longer reproduce it. A review with no
  gated findings is accepted by the server on the spot (the draft's
  content re-issues as the accepted revision with empty dispositions).
- `submitRevision`: revised contract plus dispositions, validated by
  `designRevisionResultSchemaFor` plus the sensitivity-pair rule inside
  execute; the server decides acceptance or a required second round.
- `submitPlan`: the build plan, legal only once the accepted design
  carries no blocking open questions.

Submissions register the strict wire projection (`strict: true`
constrained decoding); the exact factory schemas run inside execute, so a
refinement failure is a repairable tool result rather than an SDK
invalid-input abort. Provider/network failures are not results — they
throw, and the design branch's bounded redrive
(`lib/agent/build/designLoopRunner.ts`) re-drives the turn with a fresh
content-bearing state message (the persisted contract and any findings
awaiting disposition, whenever the thread does not already hold them).

The durable transitions are unchanged:

```text
source package accepted
  -> draft persisted
  -> review persisted
  -> dispositions + accepted revision persisted
  -> build plan persisted
```

No later state may exist without its exact predecessor and digest. A model response never advances state until the artifact has parsed, graph-validated, and committed.

The same model family drives the loop and the review, but review is a stateless fresh-context call with a reviewer-specific system prompt. It receives:

- the resolved, authorized source package;
- the proposed Design Contract payload;
- Nova's versioned capability/constraint catalog;
- the exact contract/source digests;
- no author hidden reasoning;
- no prior reviewer prose;
- no tool authority.

A later model-diversity experiment changes only producer configuration, not artifact schemas or orchestration.

### 7.2 Review shape

Retain `designFindingSchema` and `designReviewSchema` from v1, with these refinements:

```ts
const designFindingSchema = z.object({
  id: designIdSchema,
  category: z.enum([
    "requirement-coverage",
    "workflow-gap",
    "data-model",
    "read-write-coherence",
    "access-and-actor",
    "privacy-and-sensitivity",
    "usability",
    "unsupported-assumption",
    "unnecessary-complexity",
    "platform-constraint",
  ]),
  severity: z.enum(["critical", "important", "advisory"]),
  basis: z.enum([
    "source-supported",
    "contract-internal",
    "platform-constraint",
    "heuristic",
  ]),
  claim: z.string().min(1),
  evidenceRefs: z.array(sourceRefSchema),
  affectedIntentIds: z.array(designIdSchema),
  proposedResolution: z.string().optional(),
  confidence: z.number().min(0).max(1),
}).superRefine(validateFindingEvidence);
```

`validateFindingEvidence` proves:

- source-supported critical/important findings carry an authorized source reference;
- contract-internal critical findings identify a deterministic graph contradiction;
- platform-constraint critical findings cite a known capability-catalog code;
- heuristic findings cannot be critical;
- a finding cannot cite an intent absent from the reviewed revision;
- evidence refs belong to the reviewed source package;
- a reviewer may flag missing intent with an empty `affectedIntentIds`, but must tie it to evidence.

The reviewer cannot rewrite the contract. The revision that follows must persist one disposition for every critical/important finding.

### 7.3 Bounded review state machine

Default limits, per DESIGN CYCLE (a draft lineage from a `submitContract`
to its accepted revision):

- one review round;
- one revision when critical/important findings exist;
- one second review and one second revision only when the first revision leaves a critical finding (a critical dispositioned deferred, or rejected — the agent overriding the reviewer on a critical deserves the second independent look) or changes architecture (the decision set or a selected option changed); extended depth always takes the second review — its impacted-scenario re-review;
- no third automatic loop. A revision awaiting its second review persists as a `draft`.

Rounds derive digest-INDEPENDENTLY: the gates count persisted reviews
along the open cycle's parent chain (the revisions above the session's
newest accepted revision), whatever package digest each artifact bound.
Answered question rounds and new messages move the digest, so a
digest-scoped count would reset after every pause and mint free reviews;
the ancestry count means a crash, a resume, or a question round between a
review and its revision can never grant an extra round, and a cycle
reopened by answered blocking questions starts a fresh budget — every
cycle ends in its own reviewed acceptance.

Terminal outcomes:

| Outcome | Durable state | User/app consequence |
| --- | --- | --- |
| Accepted | Accepted contract revision | `submitPlan` becomes legal — unless the accepted revision carries blocking open questions, which gate the plan; the agent asks them, and the answers reopen a fresh reviewed cycle (an accepted revision is immutable, so it never becomes plannable after the fact). |
| Blocking source question | `awaiting_input = true`, the agent's own `askQuestions` round in the thread | No app; the loop resumes with its context intact when the answers arrive. |
| Structured output rejected twice | Retriable design-session error carrying the refinement messages | No app; preserve source package and artifacts already committed. |
| Provider/network failure | Retriable design-session error (after the bounded redrive) | No app; settle/refund according to actual usage policy. |
| Critical platform impossibility | Accepted revision with explicit deferred/out-of-scope consequence, or user question | No silent workaround. |
| Review call failed | Draft remains unreviewed | Never label reviewed or continue to build. |

A terminal system failure does not manufacture a user question, and a
loop that simply stops emitting (no pause, no plan, no error) is a
retriable design-session error — a silent stop can never present as
success. It records a retriable operational error and ends the run
honestly.

Resume is by ANCESTRY plus thread, never by timestamp or model recollection: a
re-mounted loop's gates converge on the durable state (an existing draft
resumes at review, a reviewed draft at revision, an accepted revision at
planning, and an existing plan returns only while its accepted revision is
still the head and its source-package digest matches the current turn), the thread carries the
dialogue, and the per-turn state message carries content the thread may
lack. Later user content makes a historical plan inactive and reopens a fresh
reviewed design cycle; the old plan remains immutable provenance but cannot
own new execution.

### 7.4 Proportional design depth

The deterministic complexity score is calculated only after the draft passes schema and graph validation, and persists — component counts and final score — as the contract envelope's `complexity` field (`complexity.ts::computeDesignComplexity`, workflow-shape arithmetic over records/hierarchy/actors/tasks/transitions/rules/read models/access/location scope/lookup facts/sensitivity).

```ts
type DesignDepth = "compact" | "standard" | "extended";

interface DesignComplexityEvidence {
  score: number;
  components: Record<string, number | boolean>;
  depth: DesignDepth;
  algorithmVersion: 1;
}
```

- `compact`, score `0–2`: one draft and one review; revise only for critical/important findings.
- `standard`, score `3–6`: full contract, one review, required revision for important findings.
- `extended`, score `7+`: full contract, explicit architecture decisions, review, revision, and impacted-scenario re-review.

The score controls process depth, not Blueprint features, model authority, or validity.

### 7.5 Structured-generation seam

Extract an app-independent, cancellation-aware model context from `GenerationContext`:

```ts
interface StructuredModelRunContext {
  readonly userId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly target: GenerationTarget;

  model(id: string): LanguageModel;

  runStructured<T>(args: {
    schema: z.ZodType<T>;
    modelId: string;
    system: string;
    prompt?: string;
    file?: { mediaType: string; data: string };
    images?: SubGenerationImage[];
    maxOutputTokens: number;
    providerOptions?: SubGenerationProviderOptions;
    signal: AbortSignal;
    onProgress?: (deltaChars: number) => void;
  }): Promise<SubGenerationObjectResult<T>>;

  trackSubGeneration(usage: LanguageModelUsage): void;
}
```

Implementations:

- `DesignGenerationContext` for a pre-app design session;
- `AppGenerationContext` for an app-bound SA/edit run;
- one shared adapter over `streamObjectWith`/`generateObjectWith`, provider privacy settings, safe structured-output logging, and usage metering.

Do not duplicate provider code: `lib/agent/modelRunContext.ts` holds the interface plus the ONE adapter over `subGeneration.ts`'s `generateObjectWith`/`streamObjectWith` (which carry `abortSignal` pass-through), so `store: false`/training-disallow behavior, the sanitized structured-output logging, and cancellation are written once and cannot drift between targets. `lib/db/generationTargets.ts` holds the closed `app | design-session` union as a type leaf, and the design-session resolver (§11.1) builds around it; `design/ids.ts` follows the same dependency-leaf pattern. The offline wire pin is `lib/agent/__tests__/designGenerationContextWire.test.ts`.

### 7.6 Capability catalog

The capability catalog is generated from code-owned registries and versioned static constraints, not freehand prompt prose. The design agent carries its rendered projection in its static instructions and the reviewer receives it in its prompt — the design is made inside the constructible surface rather than corrected against it a round later — and both system prompts open with a shared domain preamble naming CommCare and the design stage's place in Nova (the reviewer is a fresh context and the agent's context is born per session; the preamble is what activates the model's prior platform knowledge).

It contains:

- constructible Blueprint vocabulary;
- known stageability/exclusivity policy;
- Preview/runtime limitations;
- external setup requirements;
- supported case/data shapes;
- deployment/HQ constraints;
- deliberate target gaps from `docs/plans/complex-app/00-contracts.md`.

A source test fails when a shared tool, authored entity family, or platform constraint changes without updating or explicitly exempting the catalog: the generated catalog (tool surface from `SHARED_TOOL_REGISTRY` policies, field kinds, case data shapes, the closed constraint codes) pins against a checked-in snapshot keyed by its canonical digest, and every deliberate-gap constraint pins against the remaining `docs/plans/complex-app/` unit FILES — a gap code must name a unit file that still exists, and every remaining unit file must carry a gap code, so shipping a unit forces the vocabulary to shed its code. The catalog may explain capability; it cannot emit mutations.

## 8. Build-slice plan

### 8.1 Shape

```ts
const externalActionSchema = z.object({
  id: designIdSchema,
  kind: z.enum([
    "media-upload",
    "place-write",
    "lookup-write",
    "hq-setup",
    "deployment",
    "worker-provisioning",
    "manual",
  ]),
  timing: z.enum([
    "before-materialization",
    "before-slice",
    "after-slice",
    "manual-setup",
  ]),
  requiredFor: z.enum(["construction", "runtime", "deployment", "optional"]),
  description: z.string().min(1),
  idempotencyOwner: z.enum(["nova", "user", "external-system"]),
  completionEvidence: z.string().min(1),
});

const buildSliceSchema = z.object({
  id: designIdSchema,
  name: z.string().min(1),
  goal: z.string().min(1),
  intentIds: z.array(designIdSchema).min(1),
  ownedIntentIds: z.array(designIdSchema).min(1),
  prerequisiteSliceIds: z.array(designIdSchema),
  acceptanceScenarioIds: z.array(designIdSchema),
  risk: z.enum([
    "ordinary",
    "cross-record",
    "external-effect",
    "data-migration",
  ]),
  role: z.enum(["materialization-root", "ordinary", "exclusive"]),
  expectedBlueprintAreas: z.array(z.enum([
    "app",
    "case-catalog",
    "users",
    "organization-shape",
    "navigation",
    "case-list",
    "forms",
    "case-operations",
    "media-references",
    "automations",
  ])),
  externalActionIds: z.array(designIdSchema),
});

const buildPlanSchema = z.object({
  schemaVersion: z.literal(2),  // server-stamped; the planner MODEL emits
                                // only { slices, externalActions,
                                // intentOwnership } (buildPlanDraftSchema)
  designRevisionId: z.string().uuid(),
  designRevisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().uuid(),
  slices: z.array(buildSliceSchema).min(1),
  externalActions: z.array(externalActionSchema),
  intentOwnership: z.array(z.object({
    intentId: designIdSchema,
    owningSliceId: designIdSchema,
    contributingSliceIds: z.array(designIdSchema),
  })),
}).superRefine(validateSlicePlan);
```

### 8.2 Planning invariants

`validateSlicePlan` proves:

1. Slices are organized around actor tasks and observable outcomes, not modules.
2. The DAG is acyclic and every prerequisite resolves.
3. Exactly one slice has `role = "materialization-root"`.
4. The materialization root has no prerequisite slices, directly owns the first useful app, and references only `manual-setup` external actions. Export readiness is proved by genesis, not asserted by the plan validator.
5. Every non-deferred in-scope intent has exactly one owning slice — the implementable intents of the accepted contract (records, facts, rules, tasks, transitions, read models, access policies, navigation; intents present in the accepted contract are by construction the non-deferred in-scope set, deferral happening at claim level before intents exist), covered EXACTLY by `intentOwnership` and mirrored in the slices' `ownedIntentIds`.
6. An intent may contribute to later slices, but completion is not double-counted.
7. Every acceptance scenario belongs to at least one owning slice.
8. Every external action has an owner, timing, required-for class, and completion evidence.
9. A viewer/read model required before a child-creating task belongs in the same slice or a prerequisite: a slice owning a task that create-transitions a child record must reach a read model over the parent record in its own intents or its prerequisite closure.
10. A batch-exclusive operation is the only canonical semantic operation in its `exclusive` slice (the runtime enforcement is the change-set admission fence; the plan validator's contribution is that an exclusive slice is never the materialization root by role).
11. A data-migration slice is impossible for a new app before materialization.
12. New place rows, lookup rows/schemas, deployments, workers, and media bytes are not represented as Blueprint mutations.
13. No slice references a Design Contract revision other than the plan's exact digest.
14. A contract revision supersedes all uncommitted plans/change sets derived from the prior digest.

### 8.3 Materialization-root quality

The root is not “the smallest number of mutations.” It is the smallest **task-complete, dependency-closed, useful** slice.

It must include, when required for the first workflow:

- case catalog declarations;
- registration/update form;
- visible inputs and direct writes;
- case operations and links;
- a usable case list/read model;
- required actor/user-type bindings;
- navigation entry points;
- exact labels and validation;
- any other Blueprint dependency needed for export readiness.

It must not include unrelated deferred workflows merely to reduce later commits.

### 8.4 External action policy

Pre-app design is read-only against external Project resources.

Allowed before materialization:

- reading authorized lookup definitions/rows;
- reading organization shape/places;
- listing existing media;
- reading deployment capability;
- asking the user to create/provide an external prerequisite.

Disallowed before materialization:

- creating or editing places;
- changing lookup schema/rows;
- uploading/deleting media;
- deploying or provisioning workers;
- mutating HQ;
- writing sample cases or submissions.

A pre-app external writer requires a separate approved contract for ownership, idempotency, cleanup, abandonment, Project move, materialization transfer, and compensation. Atomic Change Sets imply no such authority, and the current build runtime registers no generic external-action writer or receipt producer.

The persisted timing vocabulary retains the producer-bound
`before-materialization` and `before-slice` arms so every valid stored envelope
remains readable, and the orchestrator's fail-closed receipt verifier proves
their exact session/plan/action/Project/app digest and typed evidence before an
attempt can open. Because no production receipt producer is registered, new
build-plan insertion rejects both blocking timings instead of persisting an
unresumable plan. Current plans use:

- `after-slice`: remains typed plan metadata and is never mounted on the slice executor; a producer-specific adapter may act only after the canonical receipt exists;
- `manual-setup`: never auto-executes.

The defensive verifier still fails a missing, stale, or mismatched `before-*`
receipt before a dependent change set opens, so registering a producer cannot
weaken the consumer boundary. Unit F consumes outstanding `after-slice` and
`manual-setup` metadata in its completion report and prevents a completion
claim that depends on unfinished external work; neither category changes
canonical validity.

### 8.5 Slice execution brief

The executor receives one immutable, digest-bound brief:

```ts
interface SliceExecutionBrief {
  schemaVersion: 1;
  designRevisionId: string;
  designRevisionDigest: string;
  buildPlanId: string;
  buildPlanDigest: string;
  appObjective: string;
  slice: BuildSlice;
  owningIntentIds: DesignId[];
  dependencyIntentIds: DesignId[];
  actors: DesignActor[];
  tasks: Task[];
  records: RecordConcept[];
  facts: FactDefinition[];
  rules: RuleIntent[];
  transitions: LifecycleTransition[];
  readModels: ReadModel[];
  accessPolicies: AccessPolicy[];
  navigation: NavigationIntent[];
  decisions: ArchitectureDecision[];
  scenarios: AcceptanceScenario[];
  assumptions: Assumption[];
  externalActions: ExternalAction[];
  lookupIntents: LookupTableIntent[];
  loweringConstraints: PlatformConstraint[];
}
```

Only transitive dependencies of the slice are included. The system prompt remains static for prompt caching. The brief and workspace snapshot ride as volatile context.

The orchestrator verifies both digests before every executor call. A mismatch supersedes the open change set; the executor never “adapts” an obsolete brief.

## 9. Tool Workspace and canonical mutation refactor

Tool execution uses one workspace abstraction rather than splitting a mutable closure document from persistence authority. `guardedMutate` is only the adapter into that workspace-owned boundary.

### 9.1 Final tool execution shape

```ts
type WorkspaceRevision = number; // safe persisted monotonic token; callers compare only

interface WorkspaceSnapshot {
  readonly doc: BlueprintDoc;
  readonly revision: WorkspaceRevision;
  readonly canonicalSeq: number | null;
  readonly projectId: string;
}

interface ToolInvocationIdentity {
  readonly requestId: string;
  readonly invocationOrdinal: number;
  readonly toolName: string;
}

interface ToolInvocationContext {
  readonly appId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly runId: string;
  readonly chatRunHolder?: ChatRunHolderCapability;
  readonly snapshot: WorkspaceSnapshot;
  readonly invocation: ToolInvocationIdentity;

  readonly lookupDefinitions?: (
    tableIds: readonly LookupTableId[],
  ) => Promise<LookupDefinitionsSnapshot>;
  readonly lookupCatalog?: () => Promise<LookupDefinitionsSnapshot>;
  conversionImpact(
    args: Parameters<ConversionImpactFn>[0],
  ): Promise<ConversionImpact>;

  applyBatch(args: {
    readonly mutations: unknown;
    readonly stage?: string;
    readonly policy?: MutationApplicationPolicy;
  }): Promise<WorkspaceMutationOutcome>;

  applyStages(args: {
    readonly stages: unknown;
  }): Promise<WorkspaceMutationOutcome>;

  adoptAuthoritativeSnapshot(args: {
    readonly doc: BlueprintDoc;
    readonly canonicalSeq?: number;
  }): void;
}
```

`MutationApplicationPolicy` is the commit-time policy a tool attaches to its
one write — today exactly the organization-revision fence
(`{ expectedOrganizationRevision? }`).

`adoptAuthoritativeSnapshot` exists because two canonical behaviors require a
tool to hand the workspace a FRESHER authoritative document than its
invocation snapshot: an authoritative zero-diff proof (an automation update
whose requested state is already persisted proves it against a fresh
Blueprint-plus-organization read, on both its no-op and conflict branches),
and a cross-store service receipt (an archive that unassigns personas commits
through its own app-locked transaction and returns the exact committed doc).
Adoption is explicit and counts toward the invocation's one-workspace-write
budget; a tool can never nominate a document through its RESULT.

The change-set host (`lib/agent/change-set/workspace.ts`) extends this exact
shape where its durable state gives the extensions real content: `appId`
widens to `string | null` (a genesis change set has no app row),
`WorkspaceSnapshot` gains the `externalContextDigest` binding the captured
external context, and `applyBatch`/`applyStages` gain `intentIds`/`readSet`
arguments recorded with each staged step. The canonical host fabricates none
of these — a canonical invocation carrying the staged arguments is a
protocol error, never data to silently drop.

Shared tool modules become:

```ts
interface SharedToolModule<I, O> {
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  execute(input: I, ctx: ToolInvocationContext): Promise<O>;
}
```

There is no separate `doc` argument. A tool reads `ctx.snapshot.doc` and may perform at most one workspace mutation operation. Multi-stage semantic tools use `applyStages` once.

Read-shaped external side effects remain possible on the canonical surface only when their registry policy grants the required capability; they are not inferred from the result discriminator.

### 9.2 Workspace interface

```ts
interface ToolWorkspace {
  readonly mode: "canonical" | "change-set";

  invoke<T>(args: {
    readonly toolName: string;
    readonly requestId?: string;
    execute(ctx: ToolInvocationContext): Promise<T>;
  }): Promise<T>;

  currentSnapshot(): WorkspaceSnapshot;
}
```

Callers supply `toolName` and the surface's stable per-call id (the AI SDK
`toolCallId` on chat; the workspace mints one when the surface has none). The
`invocationOrdinal` is allocated BY the workspace, synchronously at `invoke`
entry — a caller-supplied ordinal would let a buggy wrapper forge ordering,
the exact hazard the ordinal exists to remove. `currentSnapshot()` is the
read-only introspection surface wrappers use; the change-set workspace
additionally exposes the richer `inspect()` diagnostics (section 10.8).

`invoke` owns the full critical section:

1. allocate the invocation ordinal and assert start order;
2. load or rehydrate the authoritative snapshot;
3. build a per-invocation context carrying that exact snapshot/revision;
4. run the tool body;
5. apply at most one write against that same revision;
6. advance or reload the workspace snapshot;
7. return only after durable persistence or durable staging.

A process-local queue serializes calls for efficiency. The durable revision and request-ID protocol remains authoritative after process death or multi-process continuation.

### 9.3 Ordering

For the slice executor:

- set provider/tool configuration to disallow parallel tool calls;
- reject a model turn containing multiple executable tool calls as an executor protocol error unless the SDK can prove order and the wrapper schedules them explicitly;
- allow the model to retry in a new step.

For the existing canonical SA:

- synchronously allocate `invocationOrdinal` at the top of each `execute` callback, before any await;
- enqueue by that ordinal;
- never rely on the current “identical async path implies microtask FIFO” property;
- remove the independent closure `doc`;
- adopt the canonical workspace's committed/reloaded snapshot after every invocation.

### 9.4 Mutation helper

`lib/agent/tools/common.ts` is a pure admission/error adapter:

```ts
export async function guardedMutate(
  ctx: ToolInvocationContext,
  mutations: unknown,
  stage?: string,
  policy?: MutationApplicationPolicy,
): Promise<WorkspaceMutationOutcome> {
  return ctx.applyBatch({ mutations, stage, policy });
}
```

The helper no longer accepts `prevDoc`, resolves a second lookup context, or invokes persistence methods directly. The workspace implementation owns optimistic diagnostics and the authoritative boundary.

The final code removes `recordMutations` and `recordMutationStages` from the shared tool-facing context. Event/SSE/log behavior is a canonical-workspace concern after commit.

### 9.5 Canonical transaction kernel

The guarded write is centralized in one internal service:

```ts
interface CanonicalCommitRequest {
  appId: string;
  actorUserId: string;
  expectedProjectId: string;
  runId?: string;
  chatRunHolder?: ChatRunHolderCapability;
  batchId: string;
  kind: ClientAppChangeKind;
  mutations: AdmittedMutationBatch;
  expectedOrganizationRevision?: OrganizationRevision;
}

interface CanonicalCommitReceipt {
  seq: number;
  committedDoc: BlueprintDoc;
  deduped: boolean;
}
```

The kernel's receipt stays exactly what the guarded commit returns today;
migration outcomes remain on `applyBlueprintChange`'s result, and post-commit
schema/index convergence remains that caller's descriptor. Server-owned
callers compose the kernel through its transaction-hook seam
(`CanonicalCommitTransactionHooks` — the `beforeWrite` hook case-store Phase A
rides). Typed `sidecars` on those hooks are that seam's closed vocabulary
(`lib/db/canonicalCommitSidecars.ts`).

The service owns these contracts from `lib/db/apps.ts::commitGuardedBatch` and `lib/db/applyBlueprintChange.ts::applyBlueprintChange`:

1. app-row lock;
2. persisted batch-ID/fingerprint deduplication;
3. expected Project check;
4. fresh Project membership reauthorization;
5. exact chat-holder check;
6. strict fresh app/entity assembly;
7. organization-revision fence when supplied;
8. stale target/anchor and reducer-minted-identity rejection;
9. one candidate preparation on the fresh doc;
10. lookup target union locks and fresh lookup verdict;
11. absolute whole-document gate;
12. exact media reference admission;
13. organization cross-store commit integrity;
14. rename/retirement case-store phase A where applicable;
15. entity diff, app scalar/sequence update, exact reference edges;
16. one admitted `app_changes` row;
17. caller-specified SQL sidecars;
18. transactional notification;
19. post-commit schema/index convergence descriptor.

A `CanonicalCommitSidecar` is a closed internal SQL-only operation. Initial variants:

```ts
type CanonicalCommitSidecar =
  | {
      kind: "commit-design-change-set";
      changeSetId: string;
      expectedRevision: number;
      /** Receipt-row identity, minted by the caller OUTSIDE the retryable
       * transaction so a retry reuses it. */
      receiptId: string;
      sliceAttemptId: string;
      designSessionId: string;
      designRevisionId: string;
      designRevisionDigest: string;
      buildPlanId: string;
      buildPlanDigest: string;
      sliceId: DesignId;
      owningIntentIds: DesignId[];
      mutationCount: number;
    }
  | { kind: "write-intent-provenance"; rows: IntentProvenanceRow[] };
```

The `commit-design-change-set` sidecar locks the change-set row and its exact bound slice-attempt row (AFTER the kernel's app lock — the canonical order), verifies status/revision/lineage, flips the attempt `running -> committed` and the set `open -> committed`, and inserts the immutable committed-slice receipt using the kernel's authoritative sequence, batch ID, and committed snapshot digest. Sidecars run in the same retryable transaction AFTER the committed-batch write tail — a provenance row's foreign key onto the fresh `app_changes` row is then immediately checkable, and a lost holder compare-and-set has already aborted — and must be deterministic, idempotent, and free of network/object-store effects. They cannot alter the candidate Blueprint or bypass the gate, and a dedup hit skips them entirely: the original commit ran them, and a canonical batch without its receipt is corruption for the caller to detect, never a new commit.

### 9.6 CanonicalMutationWorkspace

`CanonicalMutationWorkspace` preserves current user-facing semantics:

- initial snapshot is one authorized app snapshot;
- every mutation receives a server-minted batch ID tied to the invocation request;
- optimistic diagnostics may run before the commit;
- the canonical transaction kernel re-applies the batch to fresh state;
- a retryable conflict reloads one fresh authorized snapshot;
- Project move, reauthorization, holder loss, and batch-ID collision latch terminally;
- successful SSE and event-log mutation envelopes are emitted only after commit;
- per-stage event tags are preserved;
- parked-value notes are carried from the canonical receipt;
- MCP response/progress shape remains unchanged.

No canonical tool can observe a private change-set workspace.

### 9.7 ChangeSetMutationWorkspace

`ChangeSetMutationWorkspace`:

1. loads the row-locked change set and proves exact owner/run/nonce;
2. checks `requestId` for a prior receipt;
3. verifies the expected workspace revision;
4. rehydrates the exact base and durable steps;
5. resolves change-set handles structurally;
6. parses the resolved input through the original tool schema;
7. admits exact mutation JSON;
8. prepares against the private overlay;
9. rejects non-replayable failures;
10. records required external read-set dependencies;
11. appends the request, handle bindings, and step atomically;
12. evaluates real validator diagnostics;
13. increments the durable change-set revision;
14. returns the durable staged receipt (disposition, ordinal, handle
    bindings, mutation digest, compact diagnostics) on the write outcome's
    `staged` slot.

It accepts a private candidate with gating findings. It never calls the canonical transaction kernel, emits app mutation events, or writes canonical stores. A store-level replay convergence — a concurrent continuation landed the same request between the ledger pre-check and the stage transaction — resyncs the workspace wholesale from durable state before answering from the stored step, so locally minted identities can never shadow the winner's. `adoptAuthoritativeSnapshot` is a protocol error on this host: a private overlay has no fresher authority than its own replay.

### 9.8 Tool execution policy

Extend `SHARED_TOOL_REGISTRY` with final-shape policy:

```ts
interface ToolExecutionPolicy {
  effect:
    | "read-blueprint"
    | "mutate-blueprint"
    | "mutate-external"
    | "mixed-transaction";
  staging:
    | "allowed"
    | "exclusive"
    | "forbidden";
  readSets: readonly ExternalReadSetKind[];
  capabilities: readonly ToolRuntimeCapability[];
  emitsFinalGuidanceFrom?: readonly ExternalReadSetKind[];
}

interface SharedToolRegistryEntry {
  saName: string;
  mcpName: string;
  tool: SharedToolModule<unknown, unknown>;
  requires: AppCapability;
  policy: ToolExecutionPolicy;
}
```

Runtime capabilities are injected, not globally reachable:

```ts
type ToolRuntimeCapability =
  | "canonical-blueprint-write"
  | "change-set-stage"
  | "organization-read"
  | "organization-write"
  | "media-read"
  | "media-write"
  | "lookup-read"
  | "lookup-write"
  | "case-store-migration"
  | "deployment-write";
```

The change-set context lacks every external-write capability. A static registry test and source import guard enforce that a staging-allowed module cannot import an external writer directly.

Initial classification:

- **Allowed ordinary:** app scalar/name, case catalog additions, module/form/field edits, case lists, display/validation expressions, case operations without row migration, user properties/types/personas, organization-level and location-property **Blueprint definitions**, automations with captured organization read set, media-reference attachment to an existing asset.
- **Exclusive:** `renameCaseProperties` — the tool whose every batch IS the batch-exclusive saga. Tools whose batches only SOMETIMES compose the retirement/row-migration saga (a module removal retiring a case type, a retype, a field edit migrating rows) stay `allowed` at tool granularity; the batch-exclusive mutation KINDS (`renameCaseProperties`, `retireCaseType`) are the change-set admission fence, which is strictly more precise than a per-tool ban and matches how `applyBlueprintChange` routes today.
- **Forbidden while open:** media upload/delete, place row create/update/move/archive, lookup schema/row writes, deployment/HQ operations, worker provisioning, sample case generation, form submission, case data writes, object-store operations.
- **Mixed transaction:** organization archive operations that may update external rows and Blueprint in one service remain canonical-only.

The exact classification is generated/tested against every registry entry; the list above is a starting audit, not a hand-maintained exception table.

Stageability is the reviewed POLICY classification; the change-set registry additionally fences classified tools whose BODIES are not yet overlay-native — `getAutomations`, `getOrganization`, and `updateAutomation` read the authoritative persisted app/organization snapshot (and the update's zero-diff arm proves its no-op through `adoptAuthoritativeSnapshot`), so admitting them would make staged private state invisible to an executor's own read-backs. They stay canonical-only until the executor unit makes those bodies read `ctx.snapshot.doc` and removes the fence.

### 9.9 External read sets

```ts
type ExternalReadDependency =
  | {
      kind: "organization";
      projectId: string;
      revision: string;
    }
  | {
      kind: "lookup-definition";
      projectId: string;
      tableId: string;
      definitionRevision: string;
    }
  | {
      kind: "lookup-column";
      projectId: string;
      tableId: string;
      columnId: string;
      definitionRevision: string;
    }
  | {
      kind: "media-asset";
      projectId: string;
      assetId: string;
      metadataDigest: string;
    }
  | {
      kind: "project-scope";
      projectId: string;
    };
```

Capture is workspace-owned and automatic: lookup dependencies record through the invocation context's wrapped `lookupDefinitions`/`lookupCatalog` readers AND from each staged step's own diagnostics resolution; the organization dependency comes from the write's `expectedOrganizationRevision` policy; media-asset dependencies come from the staged batch's authored-asset-ref delta; `project-scope` is the change-set row's `base_project_id` rather than a per-step entry. The required-read-set fence is enforced at staging (`READ_SET_UNRECORDED`): a tool whose registry policy declares `organization` stages only with a captured revision fence, and one declaring lookup kinds stages a lookup-referencing candidate only when a Project definitions reader recorded the revisions.

Per-kind commit policy:

- `organization` requires exact equality — the LATEST captured revision across steps rides the kernel's `expectedOrganizationRevision` fence;
- lookup and media dependencies re-resolve and revalidate under the kernel's fresh locked verdicts (their staged currency is advisory diagnostics);
- guidance-projecting tools recompute final guidance after commit;
- anything else rejects and asks the executor to inspect/revise.

For example, an automation staged using location-derived setup guidance carries the organization revision. The final canonical commit fences that revision or recomputes guidance from the committed state before anything is shown to the user.

### 9.10 Structural bypass guards

Source tests fail when:

- a shared tool imports `commitGuardedBatch`, `applyBlueprintChange`, `saveBlueprint`, external organization/media/lookup/deployment writers, or app event emitters outside an approved adapter;
- a tool-facing context exposes canonical persistence methods;
- a staging-allowed tool lacks policy/read-set metadata;
- a Blueprint reference carrier is omitted from the staging projection;
- a direct app mutation event can be emitted by `ChangeSetMutationWorkspace`;
- a new external writer capability is added without a registry classification.

## 10. Atomic Change Sets

### 10.1 Package layout

```text
lib/agent/change-set/
  types.ts
  schemas.ts
  store.ts
  baseLoader.ts
  runtime.ts
  workspace.ts
  diagnostics.ts
  readSets.ts
  handles.ts
  stagingProjection.ts
  commit.ts
  rebase.ts
  stageTools.ts
  registry.ts
  errors.ts
  CLAUDE.md
```

### 10.2 Durable rows

```ts
const changeSetStatusSchema = z.enum([
  "open",
  "committed",
  "abandoned",
  "superseded",
]);

interface DesignChangeSetRow {
  id: string;
  designSessionId: string;
  designRevisionId: string;
  designRevisionDigest: string;
  buildPlanId: string;
  buildPlanDigest: string;
  sliceId: DesignId;
  kind: "genesis" | "app-edit";
  appId: string | null;
  proposedAppId: string | null;

  baseSeq: number | null;
  baseProjectId: string;
  baseSnapshotDigest: string;
  revision: number;
  nextOrdinal: number;

  attemptId: string;
  ownerUserId: string;
  ownerRunId: string;

  status: ChangeSetStatus;
  committedSeq: number | null;
  committedBatchId: string | null;
  committedSnapshotDigest: string | null;

  createdAt: Date;
  updatedAt: Date;
}

interface DesignChangeSetRequestRow {
  changeSetId: string;
  requestId: string;
  inputDigest: string;
  expectedRevision: number;
  resultingRevision: number;
  toolName: string;
  status: "staged" | "rejected";
  rejectionCode: string | null;
  receipt: StageRequestReceipt;
  createdAt: Date;
}

interface DesignChangeSetStepRow {
  changeSetId: string;
  ordinal: number;
  requestId: string;
  toolName: string;
  mutations: AdmittedMutationBatch;
  intentIds: DesignId[];
  readSet: ExternalReadDependency[];
  mutationDigest: string;
  createdAt: Date;
}

interface DesignChangeSetStepStageRow {
  changeSetId: string;
  stepOrdinal: number;
  stageOrdinal: number;
  stageName: string;
  mutationStart: number;
  mutationCount: number;
}

interface DesignChangeSetHandleRow {
  changeSetId: string;
  handle: ChangeSetHandle;
  uuid: Uuid;
  entityKind: StagedEntityKind;
  requestId: string;
  createdAt: Date;
}
```

Required constraints:

- unique `(change_set_id, request_id)`;
- unique `(change_set_id, ordinal)`;
- unique `(change_set_id, handle)`;
- unique `(change_set_id, uuid)`;
- one open change set per slice attempt (a partial unique index on
  `attempt_id` while `open`; a second begin under the same attempt names
  the reopenable set instead of surfacing a raw constraint error);
- `next_ordinal >= 0`, `revision >= 0`;
- genesis has `app_id IS NULL`, `proposed_app_id IS NOT NULL`, `base_seq IS NULL`;
- app edit has `app_id IS NOT NULL`, `proposed_app_id IS NULL`, `base_seq IS NOT NULL`;
- committed status requires sequence, batch ID, and committed snapshot digest;
- only open rows may receive requests or attempt commit;
- exact owner-attribution columns are non-null while open;
- holder authority is verified on the locked design-session/app row, not duplicated on the change set;
- digests are lower-hex SHA-256 over canonical JS JSON bytes — object keys recursively sorted by code point — computed and verified in JavaScript only; the SQL-computed fold-baseline digest is a separate domain, never compared against these;
- `design_session_id`, design revision, build plan, and attempt identities are foreign-key-bound to the durable design/orchestration tables.

No durable `committing` state exists. Commit either atomically changes `open -> committed` beside the canonical write or rolls back to `open`. A lost response is resolved through the deterministic canonical batch ID and committed receipt, not through an intermediate lifecycle state.

### 10.3 Base document

The private candidate is derived, never stored.

For an app edit, `beginChangeSet` records:

- the exact authorized app sequence;
- Project ID;
- canonical snapshot digest;
- design/build-plan digests.

The base loader is:

```ts
async function loadCanonicalBlueprintAtSequence(args: {
  appId: string;
  seq: number;
  expectedProjectId: string;
}): Promise<{ doc: BlueprintDoc; digest: string }>;
```

Implementation:

1. select the greatest immutable fold baseline at or before `seq`;
2. read the contiguous admitted suffix through `seq`;
3. strictly parse every persisted carrier and app-change envelope;
4. replay only through the requested sequence;
5. prove the resulting snapshot digest matches the recorded base digest;
6. do not use current app-head entities as the base;
7. do not require the historical candidate to be re-authored from names or tool payloads.

This reuses `lib/db/canonicalMutationFold.ts` primitives but adds a sequence-bounded loader. Current lookup context is applied when diagnostics or commit require it; history replay itself remains exact mutation reduction. The bounded fold runs no final lookup-context gate — a historical Blueprint passed the absolute gate when it committed, and today's mutable definitions cannot honestly re-judge it; identity is proved by the recorded base digest, and the fold's arrival Project must equal the recorded base Project.

For genesis, the base is the canonical empty in-memory Blueprint with `proposedAppId`, a fixed schema version, and a recorded digest. It is never persisted as an app.

An in-process cache may retain `(changeSetId, revision) -> overlay`, but every cache miss rehydrates from the durable base and steps. Cache contents are discardable.

### 10.4 Request idempotency

Every executor tool call receives a server-derived stable `requestId` from the run plus the AI SDK tool-call identity, and that identity is persisted with the assistant tool-call unit before execution. If transport/process recovery replays the same tool call, the same ID is reused.

`inputDigest` is the canonical SHA-256 of:

```ts
{
  stagingProtocolVersion,
  toolName,
  expectedWorkspaceRevision,
  projectedInput
}
```

The projected input is admitted as an exact JSON data tree before hashing. The digest is computed before handle resolution so a retry compares the caller's actual request, while the stored mutation digest proves the resolved canonical result.

Stage transaction:

1. resolve the change set's authority target without holding a row lock;
2. start the transaction and lock the authority carrier first:
   - active pre-app build: design-session row;
   - materialized build or design-aware edit: app row;
3. re-resolve target/Project mapping and prove exact user/run/holder ownership;
4. lock the change-set row second, then re-prove fresh Project edit
   membership — the membership gate is only ever taken while already
   holding the authority rows, and membership writers take no change-set
   or app locks, so gate-after-row cannot cycle;
5. parse status and artifact/base identities;
6. look up `(changeSetId, requestId)`;
7. if found and the tool name and input digest match — a retry recomputes its digest at the STORED expected revision, so a post-advance retry still replays its original receipt — return the stored receipt unchanged;
8. if found and any differ, throw `ChangeSetRequestIdCollisionError` and latch the run;
9. require `expectedRevision === row.revision`;
10. rehydrate the overlay at that revision;
11. execute handle allocation/resolution, admission, preparation, and diagnostics;
12. insert handle rows, step/stage rows, and request receipt;
13. increment `revision` and `nextOrdinal`;
14. commit.

A rejected **protocol/admission** request may persist a small rejection receipt for idempotent replay, but it does not increment revision or append a step. A validator finding is not a rejected request; the admitted step appends and diagnostics report the finding.

The receipt schema includes only safe structured facts:

```ts
interface StageRequestReceipt {
  requestId: string;
  disposition: "staged" | "rejected";
  workspaceRevision: number;
  ordinal?: number;
  handles: Record<ChangeSetHandle, Uuid>;
  mutationDigest?: string;
  diagnostics?: ChangeSetDiagnosticsSummary;
  error?: { code: ChangeSetStageErrorCode; message: string };
}
```

### 10.5 Change-set-local handles

```ts
type ChangeSetHandle = `@${string}`;

type StagedEntityRef =
  | { uuid: Uuid }
  | { handle: ChangeSetHandle };
```

Rules:

1. Handles exist only in executor-only projected schemas.
2. Spelling is bounded and canonical, for example `@[a-z][a-z0-9_-]{0,63}`.
3. A handle is bound once to a server-minted canonical UUID and entity kind.
4. Allocation is deterministic for a retried request because the original binding is persisted.
5. A handle reference is exactly the one-key `{ "handle": "@name" }` object, resolved structurally to its UUID before the original tool schema runs; prose strings are never searched, and no canonical tool schema owns a `handle` property (a source test proves the spelling collision-free).
6. Persisted steps contain only exact canonical mutation JSON and UUIDs.
7. Handles never enter Blueprint, app history, event log, MCP, builder, export, or deployment.
8. A handle cannot be rebound, reused for another kind, or shadowed.
9. A reference cannot point to a handle created by a later invocation.
10. The handle table and step commit atomically.
11. Declarations ride the granular staging tools' identity slots; minting happens outside the durable transaction against a scratch table merged into workspace state only when the step commits.

This is a private symbol table, not a second authored identity system.

### 10.6 Staging schema projection

`lib/agent/change-set/stagingProjection.ts` owns the executor-facing schema projection.

The projection is a reviewed classification per identity FAMILY over the same identity-pointer registry the identity-parity tests derive from (`lib/agent/identityPointerRegistry.ts`):

- only Blueprint-entity families are handle-eligible (`uuid | { handle }`);
- app, Project, media asset, lookup, location, case, thread, run, batch, submission, and external IDs remain canonical;
- prose strings are never searched or replaced;
- path/name/slug values are never interpreted as handles;
- projected input resolves structurally (the one-key `{ handle }` object form);
- the resolved value is parsed again through the original shared tool schema;
- the ordinary tool body sees only canonical input.

A source test fails when an identity family is added without a projection decision, and every handle-eligible family maps to its staged entity kind. The executor-facing `uuid | { handle }` wire schemas emit from this same classification on the executor surface.

### 10.7 Executor-only staging tools

The executor-only structural tools are registered only for `ChangeSetMutationWorkspace`. They represent incomplete structure creation and reorder in the runtime:

- `stageModule`
- `stageForm`

`beginChangeSet`, `commitChangeSet`, `inspectChangeSet`, `discardChangeSet`, and `raiseDesignExecutionIssue` are server functions (`beginAppEditChangeSet`/`beginGenesisChangeSet`, `commitDesignChangeSet`, `ChangeSetMutationWorkspace.inspect()`, `abandonChangeSet`/`supersedeChangeSet`) whose model-facing tool wrappers mount with the executor. There are no separate `stageFields`/`stageCaseListColumn` twins: field, case-list, and case-operation grains ride the existing shared granular tools over the overlay once targets exist.

`stageModule` and `stageForm` expose granular canonical mutation builders without imposing canonical completeness on each call. They may create an incomplete private module/form because no canonical write occurs.

The builders still enforce:

- exact identity;
- valid parent/member topology for entities that exist;
- no duplicate IDs/UUIDs;
- valid anchors;
- canonical field/entity schemas;
- no unsupported mutation kind;
- deterministic mutation order.

Existing shared granular edit tools operate on the overlay once targets exist. Canonical `createModule`/`createForm` retain complete convenience semantics for direct chat/MCP/builder use.

Module reordering rides the shared canonical `moveModule` tool over the overlay; there is no private reorder twin.

### 10.8 Diagnostics

```ts
interface ChangeSetDiagnostics {
  snapshotRevision: number;
  candidateDigest: string;
  allFindings: ValidationError[];
  /** Stable 16-hex finding fingerprints for BOTH delta directions: a
   * resolved finding's full body is not recomputable from the compact
   * receipts the protocol persists, and `inspect` recomputes full current
   * details on demand. */
  introducedSincePreviousStep: string[];
  resolvedSincePreviousStep: string[];
  readSetStatus: ReadSetStatus[];
  sliceIntentCoverage: IntentCoverage[];
  canCommit: boolean;
}
```

Diagnostic calculation:

1. rehydrate exact overlay;
2. resolve fresh lookup/media/organization context according to read-set policy;
3. run the real whole-document evaluator;
4. run deterministic slice-coverage checks;
5. compare stable finding fingerprints with the prior step's diagnostic summary;
6. group findings by affected object;
7. compute `canCommit` only when:
   - zero gating findings;
   - every captured read set is current/resolvable;
   - at least one step is staged;
   - genesis also passes export-readiness preflight.
   (An unsupported exclusive combination is unrepresentable — the
   admission fence closes an exclusive set to further steps. Required
   intent coverage joins the derivation when the accepted build plan
   supplies the owning-intent set; until then `sliceIntentCoverage` is the
   informational per-intent step count.)

Full validator findings are not duplicated into every row. Request receipts persist compact stable fingerprints/counts; `inspectChangeSet` recomputes full current details.

Diagnostics are advisory until canonical commit. They never redefine validity.

### 10.9 Commit batch identity

For an existing-app change set at an exact open revision:

```ts
const batchId =
  `design-change-set:${changeSetId}:r${revision}:${mutationDigest.slice(0, 24)}`;
```

The ID is deterministic and within the repository's batch-ID constraints.

- Retrying the same revision uses the same batch ID.
- Appending a correction increments revision and creates a different batch ID.
- Reusing the same ID with different admitted bytes is a terminal protocol error.
- The concatenated batch preserves step order and each step's stage slices for event attribution.

Genesis is deliberately different: sequence `1` remains the protected empty `fold-baseline` app change with the repository-required `genesis:<appId>` batch identity. Materialization idempotency is anchored by the server-minted proposed app ID, locked design session/change set, fold-baseline unique constraints, and atomic committed-slice receipt. Private genesis mutation bytes are provenance, not an `app_changes` mutation batch.

### 10.10 Commit against an existing app

`commitDesignChangeSet` performs one authoritative operation:

1. read enough metadata to identify the app without taking a change-set lock;
2. start the retryable transaction;
3. lock the app row first;
4. lock the change-set row second;
5. prove exact actor, Project, design session, run, holder nonce, status, design/build-plan digests, slice, and expected change-set revision;
6. derive and verify the deterministic canonical batch ID/fingerprint for the locked revision;
7. load the fresh strict app snapshot;
8. concatenate admitted steps in ordinal order;
9. reapply the exact batch to fresh state;
10. reject target/anchor/exclusive/read-set conflicts with a structured rebase report;
11. run the guarded case-schema-coupled writer (`applyBlueprintChange`, composing the canonical transaction kernel) so rename/retirement Phase A, ordinary case-type sweeps, and the current lookup/media/organization/case-schema rules keep their exact semantics;
12. write one `app_changes` row and entity diff;
13. prove that mutation-bearing durable steps name only owned intents, collectively cover every owned intent, and derive implementation coordinates from those admitted mutations;
14. write the derived intent provenance and atomically mark the exact running attempt plus change set committed via canonical sidecars;
15. commit;
16. run returned post-commit index/schema convergence;
17. build per-stage event-log envelopes from the stored step-stage ranges (`committedStageEnvelopes` — the executor surface owns emission) and emit/log only after commit;
18. emit user-facing app mutation/progress frames only after commit.

When Unit F adds conformance reports, a later canonical sequence derives an
older report as stale by exact sequence/digest comparison; no report row is
mutated. Event-log delivery remains post-commit and is not a transaction
sidecar.

No success path performs a second transaction to mark the change set committed.

The structured rebase report derives from a fresh strict snapshot immediately before the authoritative attempt and re-derives after a kernel rejection; when the change set meanwhile committed — a concurrent duplicate won — the outcome is the stored receipt, never a conflict report against the set's own committed work. Every kernel-transaction failure maps into the closed change-set taxonomy: a sidecar revision race is the ordinary stale-revision signal (rehydrate, re-derive, retry), a mid-commit Project move is scope loss, and a deterministic-batch-id collision is integrity corruption.

A retry normally observes `status = committed` under the change-set lock and returns the stored `design_committed_slices` receipt. If canonical batch dedup is reached, preserve current repository semantics: it may pair the original committed sequence with the currently authorized head document. Never derive the original slice snapshot digest from that current document; verify and return the atomic stored slice receipt instead. A canonical batch without its change-set/receipt sidecars is corruption, not a new commit.

### 10.11 Rebase report

```ts
interface ChangeSetRebaseReport {
  kind: "rebase-conflict";
  baseSeq: number;
  currentSeq: number;
  conflicts: Array<{
    code:
      | "TARGET_REMOVED"
      | "TARGET_KIND_CHANGED"
      | "ANCHOR_REMOVED"
      | "IDENTITY_COLLISION"
      | "EXTERNAL_READ_SET_CHANGED"
      | "EXCLUSIVE_BASE_CHANGED"
      | "PROJECT_CHANGED"
      | "DESIGN_SUPERSEDED";
    stepOrdinal?: number;
    mutationIndex?: number;
    coordinates?: ImplementationCoordinate[];
    message: string;
  }>;
}
```

Rules:

- Rebase never retargets by name, position, or “closest match.”
- A clean replay over a newer app may commit.
- A conflict leaves the change set open with all steps retained.
- The orchestrator may append explicit corrections or supersede it.
- Project change and lost authorization/holder are terminal for the run.
- An exclusive migration requires the exact base preconditions named by its existing saga.

### 10.12 Genesis commit

Genesis uses the same request/idempotency/change-set protocol but a dedicated prepared-genesis kernel because no app row exists to lock. Section 12 defines that transaction. It still consumes the same admitted concatenated batch and canonical integrity services.

### 10.13 Recovery and lifecycle

- **Process death:** rehydrate from base plus durable steps.
- **Lost stage response:** retry same request ID and receive same receipt/handles.
- **Lost commit response:** retry same revision/batch ID; canonical dedup returns the original sequence.
- **User requirement change:** persist a new contract/build-plan revision, mark the old change set `superseded`, and begin a new one.
- **Reviewer correction:** append a new step when the contract is unchanged; otherwise supersede.
- **Stale base:** deterministic replay on fresh canonical state or structured conflict.
- **Abandonment:** exact owner marks `abandoned`; no canonical state changes.
- **Unknown commit outcome:** look up the deterministic batch ID under ordinary canonical dedup and verify the atomic change-set receipt; otherwise the set remains `open`.
- **Retention:** committed provenance remains durable; abandoned/superseded private steps follow the documented retention policy after no active run or audit reference remains.

## 11. Pre-app design sessions and target-polymorphic chat

App and design-session targets share a closed generation-target abstraction for run ownership, credit reservation, thread scope, and stream-resume authorization. The abstraction preserves the complete thread protocol rather than treating target polymorphism as only a foreign-key concern.

### 11.1 Generation target

```ts
type GenerationTarget =
  | { kind: "app"; appId: string }
  | { kind: "design-session"; designSessionId: string };

interface ResolvedGenerationTarget {
  target: GenerationTarget;
  projectId: string;
  appId: string | null;
  state: "active" | "materialized" | "completed" | "abandoned";
}
```

The shared resolver module is:

```text
lib/db/generationTargetScope.ts
```

(`lib/db/generationTargets.ts` stays the dependency-free type leaf holding
the union and the nullable-column mappers — the resolver reaches the
run-protocol stack, so it lives beside the leaf, not inside it, keeping
every type-consumer's import graph free of `apps`/`designSessions`.)

It is the only shared boundary for:

- Project membership resolution;
- holder/liveness projection;
- thread target checks;
- stream authorization;
- usage/run-summary target keys;
- post-materialization app resolution;
- opaque not-found behavior.

No caller open-codes `if (appId) ... else ...` authorization.

### 11.2 Design-session table

```sql
CREATE TABLE design_sessions (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('build', 'edit')),
  project_id text NOT NULL,
  owner_user_id text NOT NULL,

  proposed_app_id text,
  app_id text,

  state text NOT NULL CHECK (state IN ('active', 'materialized', 'completed', 'abandoned')),
  awaiting_input boolean NOT NULL DEFAULT false,

  run_id text,
  run_holder_nonce uuid,
  run_actor_user_id text,
  run_mode text CHECK (run_mode IN ('build', 'edit')),
  run_lease_expires_at timestamptz,

  res_period text,
  res_reserved integer,
  res_settled boolean,
  res_user_id text,
  res_run_id text,

  last_error_type text,
  active_design_revision_id uuid,
  active_build_plan_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (mode = 'build' AND proposed_app_id IS NOT NULL) OR
    (mode = 'edit' AND app_id IS NOT NULL)
  ),
  CHECK (
    state <> 'materialized' OR (mode = 'build' AND app_id IS NOT NULL)
  ),
  CHECK (
    state <> 'completed' OR (mode = 'edit' AND app_id IS NOT NULL)
  ),
  CHECK (
    mode <> 'edit' OR state <> 'materialized'
  ),
  CHECK (
    mode <> 'build' OR state <> 'active' OR app_id IS NULL
  ),
  CHECK (
    NOT (mode = 'build' AND app_id IS NOT NULL AND state = 'abandoned')
  ),
  CHECK (
    run_id IS NULL OR (mode = 'build' AND run_mode = 'build')
  ),
  CHECK (
    res_run_id IS NULL OR res_run_id = run_id
  ),
  CHECK (
    res_user_id IS NULL OR res_user_id = run_actor_user_id
  ),
  CHECK (
    state NOT IN ('materialized', 'completed', 'abandoned') OR (
      run_id IS NULL AND run_holder_nonce IS NULL AND run_actor_user_id IS NULL
      AND run_mode IS NULL AND run_lease_expires_at IS NULL
      AND res_period IS NULL AND res_reserved IS NULL AND res_settled IS NULL
      AND res_user_id IS NULL AND res_run_id IS NULL
    )
  ),
  CHECK (
    (run_id IS NULL AND run_holder_nonce IS NULL AND run_actor_user_id IS NULL
      AND run_mode IS NULL AND run_lease_expires_at IS NULL)
    OR
    (run_id IS NOT NULL AND run_holder_nonce IS NOT NULL
      AND run_actor_user_id IS NOT NULL AND run_mode IS NOT NULL)
  ),
  CHECK (
    (res_period IS NULL AND res_reserved IS NULL AND res_settled IS NULL
      AND res_user_id IS NULL AND res_run_id IS NULL)
    OR
    (res_period IS NOT NULL AND res_reserved IS NOT NULL
      AND res_settled IS NOT NULL AND res_user_id IS NOT NULL
      AND res_run_id IS NOT NULL)
  ),
  CHECK (
    mode <> 'edit' OR (
      awaiting_input = false
      AND run_id IS NULL AND run_holder_nonce IS NULL AND run_actor_user_id IS NULL
      AND run_mode IS NULL AND run_lease_expires_at IS NULL
      AND res_period IS NULL AND res_reserved IS NULL AND res_settled IS NULL
      AND res_user_id IS NULL AND res_run_id IS NULL
    )
  )
);
```

Use repository-native ID column types and foreign keys in the actual migration; the SQL above communicates the closed shape.

Pre-app build sessions derive liveness beside the app derivation in the SAME module (`runLiveness.ts::designSessionLeaseState` over the session's explicit `run_lease_expires_at` lease, whose deadline shares `MAX_GENERATION_MINUTES` through `designSessionLeaseDeadlineMs`). Sessions are deliberately simpler than apps: only a `build`-mode holder exists, the holder and reservation column groups travel whole, and a reservation can never outlive its holder — so every terminal writer settles/refunds and releases BOTH groups in one transaction (`designSessionAuthorityCleared`), a failed or reaped session stays `active` with `last_error_type` set (recoverable or discardable), and no reaper-signature/false-reap self-heal arm exists (the state it repairs on apps is unrepresentable here). Timeout arithmetic is never copied into a second module.

### 11.3 Atomic cross-target admission

A simple `SELECT` across `apps` and `design_sessions` is race-prone. The cross-target admission boundary is:

```ts
async function withActorGenerationAdmissionGate<T>(
  tx: Transaction<AppDatabase>,
  actorUserId: string,
  body: () => Promise<T>,
): Promise<T>;
```

It takes a transaction-scoped advisory lock in PostgreSQL's 64-bit keyspace (a different keyspace from the two-int32 Project-membership gate, so the two cannot interact): the key is the first 8 bytes of `SHA-256("nova:actor-generation-admission:v1:" + actorUserId)`, big-endian as a signed int64 (`actorGenerationGateKey`, golden-vector-pinned). A cross-actor hash collision only over-serializes and cannot affect correctness.

Every function that can create/claim/reacquire a chargeable generation must take this gate before evaluating the one-active-generation rule:

- `reserveForNewBuild`;
- `claimAndReserveRun`;
- design-session create/claim/reserve;
- design-session free-continuation reacquire where it can restore a holder;
- materialization holder transfer;
- stale run reapers before freeing/refunding;
- any operator recovery that creates a live holder.

For any transaction that **creates, releases, pauses, resumes, settles, refunds, reaps, or transfers** a holder/reservation, the actor gate is the first lock. It is followed by the authority row (`apps` or `design_sessions`) and then the existing membership/dependent-row order. Canonical app commits and read/write operations that merely verify an unchanged holder (the liveness heartbeats) do not take the actor gate and retain app/session-row-first ordering.

One gate per transaction, keyed as follows: admission-evaluating writers (claim, reserve, reacquire, pause) key on the calling actor; holder-releasing/settling/reaping writers, whose callers carry only the holder token, key on the HOLDER's actor derived from an unlocked pre-read of the authority row (`lockActorGenerationGateForAppHolder` / `ForSessionHolder` — build holds charge to `res_user_id` falling back to `owner`, edit holds to `lock_actor_user_id`), skipping the gate when no row exists. A pre-read that goes stale is harmless: the writer's exact-holder compare-and-set already no-ops, and deadlock freedom needs only the uniform gate-before-row order, which one gate per transaction preserves. A source-scan test (`actorGenerationGate.test.ts`) pins gate-before-row on every lifecycle writer and gate-absence on every heartbeat.

This is a deliberate, narrow amendment to the current app-row-first run-lifecycle convention. Applying the gate after an app row on one path and before a design-session row on another would permit a gate↔row deadlock during cross-target reap/admission.

Inside the gate:

1. lock the target authority row when one already exists;
2. scan live, non-paused holders across apps and design sessions using the same liveness classifier;
3. classify/reap eligible stale rows only through exact-holder compare-and-set;
4. reject when another live target counts against the policy;
5. check affordability;
6. write the exact holder and reservation;
7. commit atomically.

Two concurrent new-design requests for the same actor cannot both create active reservations.

### 11.4 Run and credit functions

Target-specific wrappers expose the shared policy:

- `claimAndReserveDesignSessionRun`
- `reacquireDesignSessionLease`
- `refreshDesignSessionLiveness`
- `setDesignSessionAwaitingInput`
- `completeAndSettleDesignSessionRun`
- `failAndRefundDesignSessionRun`
- `reapStaleDesignSessionRun`

Every write:

- locks the design-session row;
- takes the actor admission gate when holder/reservation state changes;
- proves exact owner identity while the session is pre-app;
- reauthorizes current Project edit membership;
- compares exact mode/run/nonce;
- repeats the exact-holder predicate on the SQL update;
- preserves current refund-vs-settle behavior based on actual billable work and run outcome.

The pre-app mode is `build`. `claimAndReserveDesignSessionRun` rejects `mode = 'edit'`: an edit-mode design session is an artifact/orchestration scope only, while the bound app row remains the sole holder and reservation authority.

### 11.5 Materialization holder transfer

The materialization transaction:

- holds the design-session row and actor admission gate;
- proves the exact design-session holder;
- inserts the app row carrying that same holder identity and unsettled reservation;
- clears holder/reservation columns from the design session;
- marks it materialized.

There is never an interval with two holders or no owner for an unsettled reservation. Heartbeat code switches target only after receiving the committed materialization receipt.

### 11.6 Thread target union

Migrate `threads` to exactly one stored target:

```sql
ALTER TABLE threads
  ADD COLUMN design_session_id uuid REFERENCES design_sessions(id);

ALTER TABLE threads
  ALTER COLUMN app_id DROP NOT NULL;

ALTER TABLE threads
  ADD CONSTRAINT threads_exactly_one_target CHECK (
    (app_id IS NOT NULL)::int + (design_session_id IS NOT NULL)::int = 1
  );

CREATE INDEX threads_design_session_updated
  ON threads (design_session_id, updated_at DESC)
  WHERE design_session_id IS NOT NULL;
```

Refactor all thread functions around:

```ts
type ThreadTarget = GenerationTarget;
```

A build thread remains design-session-targeted after materialization — including the EDIT turns that follow completion: the chat route derives the run's generation target from the thread's design LINEAGE (a presented `designSessionId`, or the app-target build claim's bound session), not from whether the orchestrator runs, so the same transcript row keeps its exact target for its whole life while thread writes stay exact-target-guarded. This preserves one transcript lineage and avoids rewriting a live row while a stream may be using it. The target resolver returns the materialized app when app authority is needed, thread READS on an app target additionally include its bound materialized session's rows (the app page is where the user finds the build conversation), and the wire thread meta carries `design_session_id` so the client echoes it on every send.

### 11.7 Preserve the complete transcript protocol

Generalize, without semantic changes, these current contracts from `lib/db/threads.ts` and `app/api/chat/route.ts`:

1. `upsertThreadTurn`
   - merges incoming history by message ID;
   - persists the new user/answered-question state;
   - sets the exact active stream/run marker;
   - removes only the dead predecessor partial on a valid re-drive;
   - preserves claw-back tombstones.

2. `persistResponseSnapshot`
   - writes cumulative completed assistant units at SDK step barriers;
   - runs only after the chunk log is durably flushed through that barrier;
   - merges by message ID;
   - clears only this stream's marker at terminal success/pause;
   - preserves the holder nonce for a paused continuation.

3. `clawBackThreadResponse`
   - restores a continuation seed or removes a fresh failed response;
   - clears only this stream's marker;
   - tombstones the response ID in one transaction.

4. Load/reconcile
   - derives `resume_interrupted` from target liveness plus stream terminal state;
   - derives `run_paused` from exact holder and `awaiting_input`;
   - never clears recovery markers on a read;
   - refuses a stale client's copy of a clawed-back assistant partial.

5. Bailed-history merge
   - persists real incoming client state without taking over the live marker;
   - never writes across a different target.

Target-specific lock order:

- pre-app thread write: design-session row, then thread row, then media assets;
- materialized design-session thread write: resolve immutable session→app mapping without a held row lock, then app row, then thread row, then media assets;
- app-targeted thread write: app row, then thread row, then media assets.

A materialized session's `app_id` is write-once except for physical cascade cleanup. A Project move updates its Project-scoped lineage under the app lock.

### 11.8 Exact thread media references

Split conversation references from Blueprint references.

New table:

```sql
CREATE TABLE thread_media_refs (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  PRIMARY KEY (thread_id, asset_id)
);
```

Rules:

- Blueprint commits replace exact app/Blueprint media edges only.
- Thread writes replace the exact edge set for that thread in the same transaction as transcript persistence.
- Thread target resolution supplies Project tenancy.
- Asset deletion checks both app references and thread references, including soft-deleted/recoverable app/thread policy. Deletion is the one irreversible consumer (bytes purge post-commit), so when the per-thread projection shows no conversation reference it additionally re-proves absence against the transcripts themselves — a candidate whose transcript names the asset, or whose attachment metadata cannot be parsed to prove it doesn't, blocks.
- Project move re-tenants/remaps thread references with transcript attachment IDs in the existing app-move transaction. The move's conversation set spans both thread target kinds: the app's own threads and the threads of its bound design sessions (an active pre-app session has no bound app and never enters the set).
- The migrate Job's runtime probe audits the SPLIT shape: `media_asset_refs` re-derives from the Blueprint alone, each thread's `thread_media_refs` rows re-derive from its transcript, and asset readiness/kind/Project verdicts cover both families.
- The migration's thread backfill is deliberately lenient where the runtime writers are strict — it crosses history the current admission rules never saw, and a deploy-blocking Job must not fail closed on it: an unparseable legacy transcript contributes nothing, a reference naming no asset row is skipped (the FK would reject it; vanished bytes guard nothing), and both skips are counted in the Job log. Threads page through a keyset loop so Job memory stays bounded.
- Existing app threads are backfilled from exact transcript carriers INSIDE the design-session migration (the deletion guard reads `thread_media_refs` from its first request, and the migrate Job is the one point ordered before it), which also rebuilds every edge-bearing app's `media_asset_refs` to the Blueprint-only projection; the backfill imports the production walks rather than freezing copies, because a derived-projection rebuild must converge on the projection the current runtime maintains. A one-off scan/migrate script pair re-runs the same convergence after the old revision drains (its writers keep the app-wide shape through the deploy window), then is deleted. App-wide transcript projection code is removed in the same final-shape cutover.
- Assistant-message attachment metadata remains forbidden.

This removes the current accidental coupling where one thread write reprojects the app's complete media carrier set.

### 11.9 Resumable stream target union

Migrate `chat_stream_chunks` to exactly one target and retain its existing primary/idempotency key:

```ts
interface StreamChunkAppend {
  streamId: string;
  target: GenerationTarget;
  runId: string;
  firstIndex: number;
  chunks: unknown[];
  terminal: boolean;
  terminalOutcome?: string;
}
```

Database shape:

- nullable `app_id`;
- nullable `design_session_id` with a real `ON DELETE CASCADE` foreign key (a pruned operational log cascading with a physically deleted session is harmless and keeps §18.11's explicit-delete-behavior rule);
- exact-one CHECK;
- existing `(stream_id, first_index)` uniqueness;
- existing terminal outcome and retention behavior.

`streamChunkMeta` returns `{ target, runId }`. The reconnect endpoint:

1. loads target metadata;
2. resolves current Project and app, if materialized;
3. performs the same opaque authorization;
4. reads/tails by cursor;
5. uses target liveness to decide whether an unsealed stream may still produce chunks.

The stream remains design-session-targeted for the life of the POST even when materialization occurs midstream — which is exactly why target liveness DELEGATES: a session carrying an `app_id` answers with the APP's liveness (`generationTargetHeldLive`), the same bound-app delegation the thread writers' lock order performs, so a reconnect after materialization never reads the terminal session row and cuts a still-live run's tail.

### 11.10 Run summaries and usage

Generalize:

```ts
type RunSummaryTarget = GenerationTarget;

interface AccumulatorSeed {
  target: RunSummaryTarget;
  userId: string;
  runId: string;
  holderNonce: string;
  model: string;
  promptMode: "build" | "edit";
  appReady: boolean;
  moduleCount: number;
  // existing usage/reservation fields unchanged
}
```

`run_summaries` gets an exact target union and partial unique indexes:

- unique `(app_id, run_id)` where app-scoped;
- unique `(design_session_id, run_id)` where session-scoped.

The same high-level build thread remains design-session-keyed after materialization. Admin readers join to `design_sessions.app_id`.

Preserve:

- first-write unique-race retry;
- pinned vs latest vs accumulated field policy;
- per-turn token pricing;
- refund on failed/no-billable work;
- charge-period fidelity across month boundaries;
- non-blocking summary storage failure;
- monthly usage keyed by user, unchanged.

Design metrics remain separate; the existing run summary is not overloaded with full contracts or findings.

### 11.11 Pre-app event/log behavior

Do not create a pre-app dialect of `app_changes` or the app event log.

Generation telemetry uses this small interface:

```ts
interface GenerationTelemetrySink {
  noteMilestone(event: SafeGenerationMilestone): void;
  noteToolCall(name: string, outcome: "ok" | "error"): void;
  flush(): Promise<void>;
}
```

- Pre-app sink updates aggregate design-session metrics and safe milestone timestamps only.
- The durable transcript stores user/assistant content, the design
  agent's reasoning summaries included (the thread persists reasoning
  parts exactly as the SA's does).
- Design/review/build artifacts store typed work products.
- Resumable chunks store transient wire replay.
- After materialization, canonical mutation/conversation events may use the existing app `LogWriter`.
- Raw Design Contracts, prompts, source extracts, and private mutation steps never enter Sentry or generic app events. Display-safe reasoning SUMMARIES are the one deliberate admission: the independent reviewer's and each executor step's summaries land in the run event log as `assistant-reasoning` events (the same elevated admin read surface as the run's other diagnostics), joined to their artifacts by `created_by_run_id`, because the WHY behind a design outcome is the record its tuning reads. A session that never materializes keeps those rows reachable through the session's run ids (`scripts/inspect-design-artifacts.ts --reasoning`), and they follow the design session's §11.12 retention and discard policy, never an app's.

UI stage is derived from durable artifacts, not an event-log replay.

### 11.12 Designs-in-progress UX and recovery

Design sessions do not appear as apps. A **Designs in progress** collection provides:

- title from accepted/draft contract or first user message;
- last activity;
- derived stage;
- current error/pause state;
- resume;
- discard.

A question-only or failed pre-app build remains honest and recoverable.

Discard:

- requires current Project edit permission and exact user ownership;
- refuses while another live holder owns the session;
- marks the session abandoned;
- releases/refunds only through exact-holder/reservation policy;
- abandons open change sets, supersedes running attempts, and clears thread
  stream-holder markers in the same transaction;
- retains or deletes transcript/artifacts according to explicit retention and audit policy;
- never creates/deletes an app.

### 11.13 Complete lock order

Document and test:

1. Holder/reservation lifecycle transition on any target: actor generation advisory gate → authority row (`apps` or `design_sessions`) → membership gate/member row → credit/dependent rows.
2. Design-session creation: actor generation advisory gate → membership gate/member row → insert design-session/reservation.
3. Canonical app commit or unchanged-holder verification: app row → membership gate/member row → lookup/media/organization/case-schema/dependent rows. No actor gate.
4. Pre-app staging/thread write with unchanged holder: design-session row → change-set/thread row → media rows. No actor gate.
5. Existing-app or materialized-session change-set stage/commit: resolve session mapping without a held lock → app row → change-set row → membership/external resource locks → sidecars.
6. Materialization/holder transfer: actor generation advisory gate → design-session row → change-set row → membership gate/member row → new app insert → dependent rows.
7. Materialized-session thread write: resolve session mapping without a held lock → app row → thread row → media rows.
8. Project move: existing app/membership order → materialized design-session/provenance/thread refs in the same transaction. It never waits on the actor gate.
9. No path may hold a change-set or thread row while waiting for an existing app row.
10. Append-only/read-only tables are never row-locked, preserving runtime privilege contracts.

A lock-order test matrix composes run claim/reap/finalize, canonical commit, staging, materialization, thread writes, membership mutation, and Project move. The actor gate key derivation has versioned golden vectors.

## 12. Meaningful app materialization

### 12.1 One closed genesis owner

App creation has one closed genesis interface:

```ts
type PreparedAppGenesis =
  | {
      kind: "explicit-blank";
      appId: string;
      actorUserId: string;
      projectId: string;
      admittedGenesis: AdmittedMutationBatch;
      genesisDigest: string;
      status: "complete";
    }
  | {
      kind: "design-slice";
      appId: string;
      actorUserId: string;
      projectId: string;
      designSessionId: string;
      designRevisionId: string;
      designRevisionDigest: string;
      buildPlanId: string;
      buildPlanDigest: string;
      changeSetId: string;
      changeSetRevision: number;
      mutationDigest: string;
      sliceId: DesignId;
      exactHolder: ExactDesignSessionHolder;
      status: "generating";
    };

async function materializeAppFromGenesis(
  genesis: PreparedAppGenesis,
): Promise<AppMaterializationReceipt>;
```

The design-slice variant does **not** carry a caller-prepared candidate document. The materialization transaction reloads the change set, replays its admitted steps from the canonical empty base, and re-evaluates everything.

The explicit-blank variant is produced by a renamed `blankAppGenesis` helper and passes the same exact admission, absolute gate, export-readiness, media/lookup/organization, entity, baseline, and runtime-schema boundaries.

Call-site contract:

- `Start with a blank app` → `explicit-blank`;
- direct MCP `create_app` → `explicit-blank`;
- chat design build → `design-slice`;
- no caller inserts an app row and seeds it later;
- no generic `createApp` remains.

### 12.2 Prepared genesis kernel

The prepared genesis kernel is:

```text
lib/db/appGenesis.ts
```

with two layers:

```ts
interface PreparedGenesisCandidate {
  appId: string;
  projectId: string;
  admittedMutations: AdmittedMutationBatch;
  candidate: BlueprintDoc;
  candidateDigest: string;
  lookupTargets: LookupTargetSet;
  mediaTargets: MediaTargetSet;
  entityRows: BlueprintEntityRows;
  runtimeSchemaPlan: GenesisRuntimeSchemaPlan;
}

function prepareGenesisCandidate(...): PreparedGenesisCandidate;

async function writePreparedGenesisInTransaction(...): Promise<AppMaterializationReceipt>;
```

Preparation may happen optimistically, but the transaction repeats every correctness-bearing external read and verdict before write.

The genesis writer shares code-owned services with the canonical commit kernel for:

- exact JSON/mutation admission;
- candidate reduction;
- whole-document verdict;
- export readiness;
- lookup locks and reference edges;
- media locks and exact references;
- organization integrity and location references;
- entity decomposition;
- fold-baseline digest/procedure;
- Project membership authorization;
- deterministic case-schema compilation.

It does not duplicate these rules in `apps.ts`.

### 12.3 Transactional runtime schema vs post-commit indexes

Current case-schema code separates transactional schema/data work from concurrent index DDL. Genesis formalizes that split.

`GenesisRuntimeSchemaPlan` contains:

```ts
interface GenesisRuntimeSchemaPlan {
  schemaRows: PreparedCaseTypeSchemaRow[];
  deterministicChecks: SchemaAdmissionCheck[];
  pendingIndexWork: PendingCaseIndexWork[];
}
```

Before app insertion, preparation proves:

- every case type/property compiles;
- identifiers and index specifications are canonical;
- no deterministic schema compiler error exists;
- no live/parked rows exist for the new app;
- required runtime schema rows can be written at desired sequence `1`.

Inside the materialization transaction:

- insert/upsert required `case_type_schemas` rows at `synced_seq = 1` (`applySchemaChangePhaseA`, per case type);
- record durable pending index work — the existing `index_pending_seq` convergence column, no new table;
- do not run `CREATE INDEX CONCURRENTLY`.

After commit:

- call the existing idempotent pending-index drain;
- transient or operational DDL failure leaves pending work for retry/heal;
- the app remains correct because indexes are performance structures;
- a deterministic plan/compiler failure must have been caught before commit;
- logs and admin diagnostics expose stuck index work.

Do not claim that concurrent index DDL is part of the app transaction.

### 12.4 Design-slice materialization transaction

One retryable transaction:

1. take the actor generation-admission advisory gate;
2. lock the design-session row;
3. prove exact session state, actor, Project, run, holder nonce, reservation, and `awaiting_input = false`;
4. lock the change-set row;
5. prove genesis kind, open status, exact expected revision, accepted design/build-plan digests, slice ID, and proposed app ID;
6. derive the protected canonical genesis batch ID `genesis:<proposedAppId>` and verify any existing receipt/baseline identity;
7. rehydrate the canonical empty Blueprint with `proposed_app_id`;
8. replay every admitted step in ordinal order;
9. re-resolve current Project edit membership;
10. resolve and lock exact lookup/media/organization dependencies;
11. validate external read sets;
12. run exact mutation/candidate admission, absolute gate, and export readiness;
13. prepare/validate runtime schema phase A and pending index work;
14. prove `proposed_app_id` is unused;
15. insert the app row at `mutation_seq = 1`, `status = 'generating'`, carrying the exact transferred holder and reservation;
16. insert Blueprint entities and root/list fields;
17. insert exact lookup/media/organization/location reference edges;
18. write runtime schema rows and pending index work;
19. insert the attributed empty `fold-baseline` app change at sequence `1`;
20. write the immutable Project-bearing fold baseline from the meaningful candidate through the existing privileged genesis routine;
21. mark the change set committed at sequence `1` and batch ID;
22. insert the immutable committed-slice receipt with sequence/snapshot digest;
23. write design/slice/intent provenance;
24. set `design_sessions.app_id`, `state = 'materialized'`, and clear its holder/reservation columns;
25. commit.

Nothing exists if any pre-commit step fails.

Step order within the transaction is rollback-equivalent: the shared genesis writer evaluates the absolute gate and export readiness against the prepared candidate after the app-row insert (the lookup-definition locks it needs follow the row), and a rejection aborts the whole transaction — "nothing exists on failure" is the invariant, not a particular statement order. A design-session claim conflict surfaces PRE-STREAM as the ordinary busy rejection: a session is single-author scope, so the conflicting holder is this user's own live run in another tab and there is nothing to serialize behind (the app path's serialize-with-wait stays app-only).

The app event log begins at materialization. Private genesis steps are design provenance, not app replay history.

### 12.5 Explicit-blank transaction

The explicit blank path uses the same writer with:

- the closed canonical Survey/Form/Question admitted batch;
- no design session or change set;
- `status = 'complete'`;
- no holder/reservation;
- the same runtime schema and fold-baseline rules;
- the current server-derived Project access receipt.

Its receipt keeps the starter UUIDs because the blank-builder UX selects/names them. The design-slice receipt has no `starter` field.

### 12.6 Materialization receipt

```ts
const appMaterializationReceiptSchema = z.object({
  eventVersion: z.literal(1),
  designSessionId: z.string().uuid().nullable(),
  appId: z.string().min(1),
  projectId: z.string().min(1),
  role: z.string().min(1),
  canEdit: z.boolean(),
  seq: z.literal(1),
  batchId: z.string().min(1),
  changeSetId: z.string().uuid().nullable(),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  blueprint: persistableDocSchema,
  starter: z.object({
    moduleUuid: uuidSchema,
    formUuid: uuidSchema,
    fieldUuid: uuidSchema,
  }).nullable(),
}).strict();
```

The stream frame is:

```ts
type AppMaterializedData = {
  type: "data-app-materialized";
  data: AppMaterializationReceipt;
  transient: true;
};
```

The event includes the same server-derived access tuple as the current creation receipt. It never trusts client Project/role/canEdit claims.

### 12.7 Client activation

`ChatContainer` and the builder install one strict activation path shared by blank creation and design materialization.

For `data-app-materialized`:

1. strict-parse the receipt;
2. if no app is active, verify the design session matches the page;
3. install the complete sequence-`1` snapshot;
4. verify the local digest;
5. initialize the reconciler cursor at `1`;
6. set Project access from the receipt;
7. replace `/build/new?...` with `/build/{appId}` without adding a history entry;
8. mount tree and Preview;
9. continue later slices through normal `data-mutations`.

Idempotency:

- duplicate receipt with same app ID, sequence, and digest is a no-op;
- same app ID/sequence with a different digest triggers a fresh authorized reload;
- receipt for a different active app is refused;
- no partial store activation occurs before strict parsing and digest verification.

The current `data-app-id` frame retires from chat builds. The blank server action may call the same installer directly with an explicit-blank receipt.

### 12.8 Lost-event recovery

A committed materialization does not depend on the transient frame.

On reconnect/page load:

1. resolve the design session;
2. if active, return design-session transcript/artifact state;
3. if materialized, authorize through the app's current Project and return the exact current app activation snapshot plus thread/stream resume metadata;
4. activate/reload idempotently;
5. resume the original design-session-targeted stream if still retained.

A client disconnect between commit and frame emission creates one complete app, never a duplicate.

### 12.9 Completion status after materialization

The app remains `generating` while later build slices execute. Each later slice is a valid canonical revision.

Only the run's existing exact-holder finalization may mark the app `complete` and settle the kept build charge. The current foundation requires:

- no open change set remains;
- required runtime schema admission is current;
- pending performance-index work does not block status.

Unit F inserts its sequence-bound conformance/correction/completion decision
before that same finalization. A grounded unresolved blocker prevents the
completion claim, not use of the valid materialized app.

A failed later slice never makes earlier canonical revisions invalid. The run failure/refund policy follows current build semantics.

### 12.10 Binding contract

`docs/plans/complex-app/00-contracts.md` binds the current closed
`explicit-blank | design-slice` genesis owner, immutable meaningful sequence-1
baseline, non-executable Design Contracts/change sets, exact live-holder
authority, external-action receipt boundary, and private handles that resolve
before original tool-schema and mutation admission.
- require target-polymorphic transcript/run/credit semantics;
- distinguish transactional runtime schema admission from post-commit index convergence;
- retain the repository's direct final-shape delivery discipline.

## 13. Design-driven build executor

### 13.1 Separate method ownership from tool execution

The build package is:

```text
lib/agent/build/
  orchestrator.ts
  orchestratorState.ts
  executor.ts
  executorLoop.ts
  executorPrompt.ts
  executionBrief.ts
  issueEscalation.ts
  completion.ts
  progress.ts
  recovery.ts
  CLAUDE.md
```

Responsibilities are intentionally unequal:

- `BuildOrchestrator` owns the durable method: source resolution, the design agent loop (`designLoopRunner.ts`, which mounts the loop on the run's stream and owns its sanitizers, bounded redrive, and progress frames), accepted artifact selection, build-plan selection, slice sequencing, user questions, correction loops, and completion policy.
- `BuildExecutor` is a bounded compiler worker for exactly one `BuildSlice` and one `AtomicChangeSet`.
- `ToolWorkspace` owns the current private document and serial tool invocation.
- the model never decides whether review happened, which design revision is accepted, whether a slice may commit, or whether the overall build is complete.

`createSolutionsArchitect` remains the direct canonical edit executor. It already uses the shared workspace/host plumbing and does not inherit the design method implicitly; Unit G adds an explicit reviewed-edit workflow beside it.

### 13.2 Durable orchestrator state

Control state is not inferred solely from the chat transcript. Append-only attempts persist and derive one current state:

```ts
const buildOrchestratorStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("designing"),
    designSessionId: z.string().uuid(),
    sourcePackageDigest: sha256Schema,
  }),
  z.object({
    kind: z.literal("awaiting-user"),
    designSessionId: z.string().uuid(),
    // The blocking questions live ON the accepted revision, so the
    // revision id is the question artifact's address; the paused holder
    // itself rides the design-session row, never an event payload.
    designRevisionId: z.string().uuid(),
    blockingQuestionIds: z.array(designIdSchema).min(1),
  }),
  z.object({
    // The design agent paused on its own askQuestions round: the
    // questions live in the THREAD (the tool part the client renders),
    // and a round can precede any contract, so the head revision rides
    // only when one exists.
    kind: z.literal("awaiting-user-questions"),
    designSessionId: z.string().uuid(),
    designRevisionId: z.string().uuid().nullable(),
  }),
  z.object({
    kind: z.literal("planning"),
    designRevisionId: z.string().uuid(),
    designRevisionDigest: sha256Schema,
  }),
  z.object({
    kind: z.literal("executing-slice"),
    designRevisionId: z.string().uuid(),
    buildPlanId: z.string().uuid(),
    sliceId: designIdSchema,
    changeSetId: z.string().uuid(),
    attempt: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("finished"),
    appId: z.string().min(1),
    appSeq: persistedSequenceSchema,
  }),
  z.object({
    kind: z.literal("failed"),
    failureId: z.string().uuid(),
    recoverable: z.boolean(),
    errorType: z.string().min(1),
  }),
]);
```

The `reviewing-implementation` arm and `finished`'s `completionReportId` are
the conformance unit's additions: verification inserts its own event kinds
between `executing-slice` and `finished` when it lands, and `finished` then
carries the completion report it produced. Slice completion itself needs no
event kind — a slice's only completion authority is its committed receipt
(`design_committed_slices` / the materialization receipt), so the fold reads
committed slices from their own table rather than from a duplicated event.

The row does not store an editable state-machine blob. Each transition is an append-only orchestration event with:

- event ID;
- design session ID;
- the holder's run id plus a SHA-256 digest of its nonce (the capability
  itself never lands in an event row);
- prior-event ID/digest;
- event kind and strict payload;
- timestamp.

The current state is the strict fold of those events (`readOrchestrationHead` re-verifies contiguity, each predecessor id + digest, and kind-vs-payload agreement on every read), and the APPEND admits its payload against the same schema — an unpersistable state fails before it can poison the chain. A unique predecessor constraint prevents two continuations from advancing the same state. A loser adopts the winner only when the exact next revision carries the same strict state payload; a divergent winner raises `OrchestrationForkError`. This gives process-death recovery and makes “review was skipped” structurally detectable without turning a lost identical response into a terminal failure.

### 13.3 Slice execution attempt

A slice attempt is immutable:

```ts
interface SliceExecutionAttempt {
  id: string;
  designSessionId: string;
  designRevisionId: string;
  designRevisionDigest: Sha256;
  buildPlanId: string;
  buildPlanDigest: Sha256;
  sliceId: DesignId;
  attempt: number;
  baseTarget:
    | { kind: "empty-genesis"; proposedAppId: string; digest: Sha256 }
    | { kind: "app"; appId: string; seq: number; digest: Sha256 };
  changeSetId: string | null;
  executorModel: string;
  promptVersion: string;
  briefDigest: Sha256;
  status:
    | "running"
    | "committed"
    | "superseded"
    | "design-issue"
    | "failed";
}
```

`buildPlanDigest` / `designRevisionDigest` are those artifacts' ENVELOPE digests (`artifactDigest`) — a plan has no second self-digest. Unique `(design_session_id, build_plan_id, slice_id, attempt)` and a partial one-`running` constraint prevent duplicate workers. Begin/recover, change-set creation plus once-only binding, supersession, and terminal transitions lock and reauthorize the exact live delegated session/app holder in the same transaction as the control write. A replacement draft atomically supersedes every open change set and running attempt from its deactivated historical plan. Recovery compares every immutable identity above, not only artifact digests; an exact match reuses the row, while drift supersedes it before a fresh attempt opens. Terminal replay is idempotent only when status and failure metadata agree.

### 13.4 Execution brief

One immutable `SliceExecutionBrief` derives from the accepted design and build plan. Its digest persists on the attempt.

```ts
interface SliceExecutionBrief {
  schemaVersion: 1;
  designRevisionId: string;
  designRevisionDigest: Sha256;
  buildPlanId: string;
  buildPlanDigest: Sha256;
  appObjective: string;
  slice: BuildSlice;
  owningIntentIds: DesignId[];
  dependencyIntentIds: DesignId[];
  actors: DesignActor[];
  tasks: Task[];
  records: RecordConcept[];
  facts: FactDefinition[];
  rules: RuleIntent[];
  transitions: LifecycleTransition[];
  readModels: ReadModel[];
  accessPolicies: AccessPolicy[];
  navigation: NavigationIntent[];
  decisions: ArchitectureDecision[];
  scenarios: AcceptanceScenario[];
  assumptions: Assumption[];
  externalActions: ExternalAction[];
  loweringConstraints: PlatformConstraint[];
}
```

Rules:

1. include only transitive dependencies of the slice;
2. include every acceptance scenario the slice claims;
3. preserve exact Design IDs;
4. include accepted assumptions and deferred consequences;
5. include no raw attachment body or hidden reasoning;
6. include no mutable “latest contract” pointer;
7. strict-parse and verify all parent digests before model invocation.

The system prompt stays static for cacheability. The brief, current workspace summary, diagnostics delta, and prior tool results are volatile messages.

### 13.5 Executor tool protocol

The executor receives:

- read tools backed by the current `ToolWorkspace` snapshot;
- stageable Blueprint tools projected through the staging schema;
- executor-only granular construction tools;
- `inspectChangeSet`;
- `commitChangeSet`;
- `raiseDesignExecutionIssue`;
- no external-effect capability;
- no app lifecycle/finalization tool;
- no user-facing final-answer tool.

Every executable call uses the AI SDK's stable `toolCallId` as the `stagingRequestId`. Every mutating call also carries executor-only `implementedIntentIds`; the dispatcher verifies that each ID belongs to the slice, removes that field before the canonical tool schema parses, and persists the IDs beside the admitted step:

```ts
interface ExecutorToolRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
  implementedIntentIds?: DesignId[];
  expectedWorkspaceRevision: WorkspaceRevision;
}
```

The server computes the exact input digest. Replaying the same `toolCallId` with the same tool, revision, and digest returns the stored receipt. Reusing it with different content is a terminal executor protocol error.

The model never supplies a batch ID, ordinal, holder nonce, Project identity, or commit authority. It uses handles for handle-capable structural entities; tools that deliberately expose no handle support, including automations, personas, user types, organization levels, location properties, and their nested authored items, require fresh canonical UUIDs in their schemas.

### 13.6 No parallel mutation semantics

For the design executor, one assistant step may contain at most one executable tool call.

Enforce this at the response/tool-dispatch boundary:

1. request provider-side non-parallel tool calls;
2. inspect the returned tool-call set before executing any call;
3. when more than one executable call is present, execute none and return a deterministic protocol result asking for one call;
4. reads are not exempt; a read followed by a dependent write belongs in two ordered steps;
5. a server-owned compound tool may perform multiple deterministic internal operations only when its schema and transaction define them as one invocation.

This removes dependency on the current `ToolLoopAgent` microtask behavior.

For the direct canonical SA:

- allocate an invocation ordinal synchronously at wrapper entry, before any await;
- queue by that ordinal;
- pass one workspace revision into the invocation;
- retain source/runtime coverage proving an async hook cannot reorder calls.

The direct canonical SA may emit multiple serialized tools in one model turn. The stricter one-call-per-step protocol belongs only to the design-slice executor, where durable private-step replay requires an unambiguous step boundary.

### 13.7 Executor state machine

One slice attempt follows this server-owned state machine:

```text
load accepted artifacts
        │
        ▼
open/recover one change set
        │
        ▼
run one-call executor loop
        │
        ├─ design issue ───────────► orchestrator
        │
        ├─ fatal protocol/scope ───► fail attempt
        │
        ▼
inspect exact diagnostics
        │
        ├─ fixable findings ───────► continue same change set
        │
        ├─ architectural gap ──────► orchestrator
        │
        ▼
server checks commit preconditions
        │
        ▼
commit/materialize
        │
        ├─ rebase report ──────────► continue or replan by policy
        │
        └─ committed ──────────────► record slice receipt
```

`commitChangeSet` may be exposed as a model tool for ergonomics, but the call is only a request. The server independently proves:

- the call names the active change set;
- the attempt still owns it;
- the accepted design/build-plan digests match;
- required intent coverage is present;
- `canCommit` is true against a freshly rehydrated workspace;
- the plan contains no currently unsupported blocking external-action timing,
  and the defensive receipt verifier finds no required `before-*` action
  outstanding;
- no newer orchestration event superseded the attempt.

The orchestrator may also issue commit after an inspect result. The model's assertion is never authority.

### 13.8 Bounded execution

Set explicit budgets per slice:

```ts
interface SliceExecutionBudget {
  maxModelSteps: number;
  maxStagedRequests: number;
  maxCommitAttempts: number;
  maxRebaseAttempts: number;
  maxDesignIssueEscalations: number;
  maxWallClockMs: number;
}
```

Budgets derive from slice complexity and risk, with hard global ceilings. Exceeding a budget:

- leaves the private change set open or marks it superseded according to retry policy;
- persists a safe failure artifact;
- settles/refunds according to actual billable work and current run rules;
- never commits a partial canonical prefix;
- never reports completion.

The wall-clock budget is an absolute deadline, not a between-step check. The
executor races provider, staging, and inspection awaits against one combined
abort signal and checks the deadline before every side-effect boundary. Both
the private staging transaction and canonical commit receive the same absolute
timestamp and install PostgreSQL `transaction_timeout` for the remaining
duration, so a detached or slow write rolls back instead of committing after
executor authority expires. Executor-owned commit paths return after the
transaction and leave idempotent post-commit schema/index convergence to its
durable drain or point-of-use heal; they never start that derived work outside
the slice budget. Transaction retries consume the original deadline.

Every provider response is metered immediately when it returns, before the
post-await deadline decision. Its input/output/cache tokens accrue even when
the deadline has just expired, and each executor call increments the run's
model-step counter exactly once.

There is no unbounded “amend until valid” loop.

### 13.9 New build discipline

The executor prompt and deterministic checks enforce:

1. implement the accepted slice, not a module-by-module sketch;
2. begin or recover one change set;
3. attach the exact implemented owned-intent IDs to every mutating call;
4. use local handles for new structural entity references and canonical UUIDs
   for authorable families whose schemas do not expose handles;
5. stage at natural semantic grain;
6. use granular private creation rather than canonical completeness scaffolds;
7. prefer direct answer-to-case writes when source semantics allow;
8. inspect after meaningful groups and before commit;
9. append corrections; do not reconstruct successful prior steps;
10. raise a design issue rather than silently changing architecture;
11. do not call unavailable external effects;
12. do not say staged work is saved;
13. commit once per successful slice boundary;
14. do not continue after holder loss, Project movement, access loss, or artifact supersession.

### 13.10 Granular staging tools

The executor's closed model-facing surface combines staging-allowed shared tools with:

- `stageModule`;
- `stageForm`;
- `inspectChangeSet`;
- `commitChangeSet`;
- `raiseDesignExecutionIssue`.

`stageModule` and `stageForm` are the only private creation grains: they permit an incomplete initial structure. Complete module/form creation and module reordering ride the shared `createModule`/`createForm`/`moveModule` tools over the overlay. There is no `moveStagedModule`, `stageFields`, `stageCaseListColumn`, or `stageCaseOperation` twin. `discardChangeSet` is deliberately not model-facing: abandoning a slice is the orchestrator's decision (supersession, budget, escalation), never the executor's, so the discard writer exists only on the server surface.

These tools reuse existing domain mutation builders where possible. They do not fork domain rules.

A granular tool may permit a private intermediate object that the canonical helper refuses, but it must still:

- produce exact canonical mutations;
- preserve runnable-topology identity rules within the mutation reducer;
- reject malformed identity/anchor/reference operations;
- resolve handles structurally before original schema admission;
- return a strict idempotent receipt.

### 13.11 Direct-write lowering rule

`lib/agent/design/directCaseWrite.ts` owns direct-write lowering:

```ts
function directCaseWritePlan(args: {
  input: TaskInput;
  fact: FactDefinition;
  task: Task;
  formContext: FormLoweringContext;
}): DirectCaseWritePlan | null;
```

Choose a visible field's `caseWrite` directly only when all are proven:

- the fact source is exactly that answer;
- no transformation, normalization, composition, or alternate source is required;
- the field may legally write that case type/property;
- the write cardinality is one;
- repeat/context scope is compatible;
- relevance, requiredness, blank preservation, and update semantics match;
- catalog data type agrees;
- the field's single direct-write slot is not needed by another target.

Use a calculated/hidden writer only for additional semantics:

- transformation or composition;
- conditional constant;
- session/user/location value;
- lookup result;
- generated identity;
- shared intermediate calculation;
- runtime/wire constraint;
- multiple destinations;
- a blank/update behavior not expressible by the visible field.

Lowering provenance from Design IDs to implementation coordinates persists with the canonical slice so conformance can distinguish an intentional calculated writer from accidental identity copying.

### 13.12 Design issue escalation

```ts
const designExecutionIssueSchema = z.object({
  schemaVersion: z.literal(1),
  id: designIdSchema,
  category: z.enum([
    "missing-information",
    "contract-contradiction",
    "platform-gap",
    "stale-external-dependency",
    "implementation-impossibility",
  ]),
  affectedIntentIds: z.array(designIdSchema).min(1),
  explanation: z.string().min(1),
  evidenceRefs: z.array(sourceRefSchema),
  implementationCoordinates: z.array(implementationCoordinateSchema),
  structuralImpact: z.enum(["local", "architecture"]),
  proposedOptions: z.array(z.string().min(1)).max(3),
}).strict();
```

A raised issue ends the slice attempt's model loop. The orchestrator's full disposition vocabulary is:

- answer from already accepted evidence and resume with a new immutable brief;
- create and independently review a contract revision;
- ask the user through the existing question protocol;
- record a transparent deferred requirement and replan;
- fail the build as unsupported.

The current new-build orchestrator exercises two of those arms: `missing-information` routes to the user question protocol, and every other category ends the run as an honest recoverable failure (the session stays claimable and the issue is durable on the attempt). Unit F adds the evidence-answer, revision, and replan dispositions through its bounded correction loop.

The executor cannot edit the Design Contract, disposition a reviewer finding, or select a new architecture.

### 13.13 Rebase policy

A commit-time replay conflict is classified, not flattened to a string:

```ts
type RebaseDecision =
  | { kind: "clean-replay"; freshSeq: number }
  | { kind: "retryable-anchor"; coordinates: ImplementationCoordinate[] }
  | { kind: "semantic-conflict"; affectedIntentIds: DesignId[] }
  | { kind: "scope-lost" }
  | { kind: "exclusive-conflict" };
```

Policy:

- `clean-replay`: the transaction commits;
- `retryable-anchor`: keep the change set open, refresh the workspace base, and allow a bounded amendment;
- `semantic-conflict`: stop and replan/review affected intent;
- `scope-lost`: terminal for the run;
- `exclusive-conflict`: supersede the attempt and schedule an isolated exclusive slice.

The executor never silently retargets a missing entity by name, position, or similarity.

### 13.14 Crash and resume

On process restart:

1. reacquire the exact design/app holder;
2. load the orchestration event head;
3. load the active slice attempt;
4. lock and rehydrate its change set;
5. verify every artifact and base digest;
6. return persisted tool receipts for already completed tool calls;
7. continue from the first uncompleted model step or run a fresh bounded step with the current brief and diagnostics.

A model response itself is not replay authority. Durable staged requests and orchestration events are.

### 13.15 Slice commit receipt

Every successful slice produces:

```ts
interface CommittedSliceReceipt {
  schemaVersion: 1;
  designSessionId: string;
  designRevisionId: string;
  designRevisionDigest: Sha256;
  buildPlanId: string;
  buildPlanDigest: Sha256;
  sliceId: DesignId;
  changeSetId: string;
  appId: string;
  seq: number;
  batchId: string;
  committedSnapshotDigest: Sha256;
  owningIntentIds: DesignId[];
  mutationCount: number;
  committedAt: string;
}
```

The receipt is immutable provenance and the only input by which the orchestrator marks a slice committed. A chat event is a projection of this row, not the authority.

### 13.16 Acceptance

- One slice executor cannot mutate two change sets.
- A repeated tool call after a lost response returns the original handles, mutations, workspace revision, and result.
- A parallel tool response executes zero calls.
- Process death after step persistence resumes without duplicate UUIDs or mutations.
- The executor cannot obtain external-write capabilities.
- A stale design/build-plan digest prevents staging and commit.
- Commit authority remains server-owned.
- A committed receipt names the exact canonical sequence and digest.

## 14. Conformance and quality — Unit F (remaining)

This section is the implementation contract for Unit F. The current foundation
already persists slice-owned intent IDs and mutation-derived implementation
coordinates beside canonical commits; conformance/quality analyzers, reports,
correction orchestration, completion reports, and their read surfaces do not
exist until this unit is complete.

### 14.1 Keep validity, conformance, and quality separate

| Evaluator | Question | Input authority | Blocks canonical commit? | May block completion claim? |
| --- | --- | --- | ---: | ---: |
| Blueprint validator | Can this exact canonical revision execute safely and export truthfully? | Canonical document plus exact external validation context | Yes | Yes |
| Deterministic conformance analyzer | Does implementation structurally cover accepted intent? | Accepted design/build plan plus deterministic implementation projection | No | Yes, for grounded critical findings |
| Model-assisted quality reviewer | Is the workflow coherent, simple, usable, and faithful? | Accepted evidence, design, projection, and deterministic findings | No | Only under bounded grounding rules |

Neither conformance nor quality introduces a Blueprint state, release state, save gate, or editor permission. A valid human/MCP change remains valid even when design metadata is absent, stale, or contradicted.

### 14.2 Sequence- and digest-bound reports

Every conformance or quality report binds to exact immutable inputs:

```ts
const conformanceReportEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  designRevisionId: z.string().uuid(),
  designRevisionDigest: sha256Schema,
  buildPlanId: z.string().uuid(),
  buildPlanDigest: sha256Schema,
  appId: z.string().min(1),
  appSeq: persistedSequenceSchema,
  appSnapshotDigest: sha256Schema,
  projectionVersion: z.string().min(1),
  projectionDigest: sha256Schema,
  deterministicRuleVersion: z.string().min(1),
  deterministicFindings: z.array(conformanceFindingSchema),
  modelReviewId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict();
```

A report is current only if all of these still match:

- latest accepted design revision selected for the session;
- current build plan;
- current canonical app sequence and snapshot digest;
- current projection/rule versions.

A newer canonical sequence marks it stale immediately. Staleness is informational and cannot block ordinary canonical editing.

### 14.3 Deterministic implementation projection

Create:

```text
lib/agent/design/projection/
  types.ts
  projectApp.ts
  projectRecords.ts
  projectTasks.ts
  projectReadModels.ts
  projectWrites.ts
  projectTransitions.ts
  projectActors.ts
  projectNavigation.ts
  projectExternalSetup.ts
  coordinates.ts
  digest.ts
  CLAUDE.md
```

```ts
interface ImplementationProjection {
  schemaVersion: 1;
  appId: string;
  appSeq: number;
  appSnapshotDigest: Sha256;
  app: AppProjection;
  records: ImplementedRecord[];
  tasks: ImplementedTaskSurface[];
  forms: ImplementedFormTransaction[];
  readModels: ImplementedReadModel[];
  writes: ImplementedWrite[];
  transitions: ImplementedTransition[];
  actors: ImplementedActorBinding[];
  navigation: ImplementedNavigation[];
  externalSetup: ExternalSetupRequirement[];
}
```

Derive it only from deterministic repository data:

- canonical `BlueprintDoc`;
- canonical reference index;
- effective case-type catalog;
- form/field/case-operation graph;
- user types/personas;
- organization shape and Blueprint-backed settings;
- case-list/search configuration;
- automation definitions and generated setup requirements;
- exact design-to-implementation provenance rows.

The projection performs no model inference and invents no historical intent. Every projected element carries stable implementation coordinates.

### 14.4 Implementation coordinates

Use a closed coordinate union rather than prose paths:

```ts
const implementationCoordinateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app"), appId: z.string() }),
  z.object({ kind: z.literal("module"), uuid: uuidSchema }),
  z.object({ kind: z.literal("form"), uuid: uuidSchema }),
  z.object({ kind: z.literal("field"), uuid: uuidSchema }),
  z.object({ kind: z.literal("case-list-column"), uuid: uuidSchema }),
  z.object({ kind: z.literal("case-operation"), uuid: uuidSchema }),
  z.object({ kind: z.literal("user-type"), uuid: uuidSchema }),
  z.object({ kind: z.literal("persona"), uuid: uuidSchema }),
  z.object({ kind: z.literal("organization-level"), uuid: uuidSchema }),
  z.object({ kind: z.literal("location-property"), uuid: uuidSchema }),
  z.object({ kind: z.literal("automation"), uuid: uuidSchema }),
  z.object({
    kind: z.literal("case-property"),
    caseType: z.string().min(1),
    property: z.string().min(1),
  }),
  z.object({
    kind: z.literal("external-action"),
    externalActionId: designIdSchema,
  }),
]);
```

Coordinates are persisted with committed intent provenance and used by diagnostics, conformance, Design history, and corrective planning. Display paths are derived at read time.

### 14.5 Conformance finding shape

```ts
const conformanceFindingSchema = z.object({
  id: z.string().uuid(),
  code: conformanceCodeSchema,
  severity: z.enum(["critical", "important", "advisory"]),
  basis: z.enum([
    "deterministic-proof",
    "source-supported",
    "platform-constraint",
    "model-heuristic",
  ]),
  claim: z.string().min(1),
  affectedIntentIds: z.array(designIdSchema).min(1),
  implementationCoordinates: z.array(implementationCoordinateSchema),
  evidenceRefs: z.array(sourceRefSchema),
  ruleVersion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  suggestedCorrection: z.string().optional(),
}).strict();
```

Grounding rules:

- deterministic rules may emit any severity supported by their proof;
- a source-supported `critical` finding requires exact source refs and an accepted in-scope intent;
- a platform-constraint `critical` finding requires a versioned capability-catalog code;
- a model-heuristic finding is never `critical`;
- a model reviewer cannot upgrade a deterministic advisory finding without independent source/platform support;
- inability to prove coverage yields `important` or `advisory`, not fabricated certainty;
- findings never mutate the app or design.

### 14.6 Initial deterministic rules

Initial codes:

- `REQUIRED_INTENT_NOT_IMPLEMENTED`
- `INTENT_PROVENANCE_POINTS_TO_MISSING_COORDINATE`
- `COMMITTED_SLICE_MISSING_OWNING_INTENT`
- `TASK_HAS_NO_REACHABLE_ENTRY_POINT`
- `TASK_INPUT_NOT_CAPTURED`
- `TASK_INPUT_CAPTURED_MULTIPLE_TIMES`
- `PERSISTENT_FACT_HAS_NO_EXPECTED_WRITER`
- `FACT_SOURCE_DOES_NOT_MATCH_IMPLEMENTATION`
- `WRITE_TARGET_TYPE_MISMATCH`
- `READ_MODEL_MISSING_SCAN_FACT`
- `READ_MODEL_HAS_NO_SELECTION_OR_MONITORING_PURPOSE`
- `TRANSITION_HAS_NO_IMPLEMENTED_TRIGGER`
- `TRANSITION_HAS_NO_RESULTING_READ_PATH`
- `ACTOR_ACCESS_NOT_IMPLEMENTED`
- `ACTOR_BINDING_MISSING`
- `ACCEPTANCE_SCENARIO_HAS_NO_STRUCTURAL_PATH`
- `EXTERNAL_ACTION_REQUIRED_BUT_UNSATISFIED`
- `UNSUPPORTED_IMPLEMENTATION_NOT_GROUNDED_IN_DESIGN`
- `REDUNDANT_IDENTITY_CASE_WRITER`
- `DUPLICATE_CAPTURE_OF_FACT`
- `DEFERRED_REQUIREMENT_REPORTED_AS_IMPLEMENTED`
- `STALE_EXTERNAL_SETUP_GUIDANCE`

Each rule documents:

- exact inputs;
- proof conditions;
- severity;
- false-positive limitations;
- implementation coordinates;
- tests and fixtures;
- whether it may block completion.

### 14.7 Intent ownership and coverage

The build plan gives every non-deferred in-scope intent exactly one owning slice. Dependency slices may reference that intent but do not own it.

A committed intent is covered only when:

1. the owning slice has a `CommittedSliceReceipt`;
2. its receipt matches the accepted design/build-plan digests;
3. provenance maps the intent to at least one still-existing implementation coordinate or a completed external-action receipt;
4. deterministic checks do not prove that mapping semantically empty;
5. the canonical app sequence is at or after that receipt.

Do not infer coverage merely because a similarly named field or form exists.

### 14.8 Acceptance scenarios

A structural scenario check proves only that the implementation graph contains a reachable path matching the scenario's actor, trigger, task, writes/transitions, and read-back.

It does **not** prove:

- runtime behavior on every device;
- CommCare HQ configuration that has not been completed;
- production data quality;
- human usability;
- network availability;
- clinical or programmatic correctness beyond accepted evidence.

Reports label this `structural-path`. End-to-end runtime tests remain separate acceptance evidence.

### 14.9 Redundant identity-writer analyzer

A `REDUNDANT_IDENTITY_CASE_WRITER` candidate requires all of:

1. hidden/calculated field;
2. calculate is exactly one canonical field reference plus ignorable whitespace;
3. hidden field writes one current-case property;
4. source and hidden field share compatible repeat/context scope;
5. source can legally carry the same direct `caseWrite`;
6. relevance, requiredness, blank preservation, and update semantics are equivalent;
7. hidden field is not referenced by another expression/action;
8. source has no conflicting direct-write target;
9. data-type/catalog semantics agree;
10. no runtime/wire constraint recorded in lowering provenance justifies the hidden field.

Start advisory. Do not auto-rewrite until parity tests prove behavior across supported CommCare runtimes and blank/update cases.

### 14.10 Fresh-context implementation review

After deterministic projection/checks, make a stateless structured call with:

- accepted source package projection;
- accepted Design Contract and dispositions;
- build plan and committed slice receipts;
- exact implementation projection;
- deterministic findings;
- unresolved external actions;
- relevant platform constraints;
- no executor reasoning or transcript narrative.

The reviewer evaluates:

- task/workflow coherence;
- worker UX;
- scanability and navigation;
- read/write coherence;
- access fit;
- unnecessary complexity;
- unsupported additions;
- assumption handling;
- external-setup honesty.

It does not re-run low-level Blueprint validity and does not treat raw source text as instructions.

The result uses the same immutable artifact envelope, prompt/schema versions, safe logging, and bounded retry rules as design review.

### 14.11 Correction loop

A proposed correction is not an edit. The orchestrator:

1. dispositions every critical/important implementation finding;
2. converts accepted corrections into one or more new build slices;
3. independently checks whether the correction changes intent;
4. creates a reviewed Design Contract revision only when intent changes;
5. executes corrections through ordinary Atomic Change Sets;
6. regenerates projection/report at the new sequence.

Bounds:

- one implementation review after planned slices;
- one correction round by default;
- a second only for grounded critical findings introduced or left unresolved;
- further looping ends with an honest incomplete result or a user question.

No reviewer can directly mutate the canonical app.

### 14.12 Completion report

Completion is an immutable assertion artifact:

```ts
const completionReportSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  designSessionId: z.string().uuid(),
  designRevisionId: z.string().uuid(),
  designRevisionDigest: sha256Schema,
  buildPlanId: z.string().uuid(),
  buildPlanDigest: sha256Schema,
  appId: z.string(),
  appSeq: persistedSequenceSchema,
  appSnapshotDigest: sha256Schema,
  conformanceReportId: z.string().uuid(),
  status: z.enum(["complete", "complete-with-external-setup", "incomplete"]),
  committedSliceIds: z.array(designIdSchema),
  deferredRequirements: z.array(designIdSchema),
  outstandingExternalActions: z.array(designIdSchema),
  unresolvedFindings: z.array(z.string().uuid()),
  userSummary: z.string().min(1),
  createdAt: z.string().datetime(),
}).strict();
```

The orchestrator may assert `complete` only when:

- every non-deferred in-scope explicit claim maps to its committed owning slice;
- every required slice has a current receipt;
- no unresolved critical design finding remains;
- no grounded critical conformance finding remains;
- every acceptance scenario has a structural path;
- no open change set remains;
- the current canonical app passes the ordinary absolute gate and export readiness;
- the report's sequence/digest matches the current app;
- no required-before-completion external action remains.

`complete-with-external-setup` is allowed only when the app itself is complete but named manual/HQ setup remains and the Design Contract accepted that dependency.

`incomplete` is an honest terminal outcome. It does not invalidate or hide already committed valid slices.

### 14.13 Relationship to app lifecycle

The completion report is not the `apps.status` authority.

- Build-run finalization may set the app `complete` once Nova's current run/credit and usability conditions are satisfied.
- A later human/MCP edit may make the latest completion report stale without changing app status.
- Design-session UI derives “review complete” from report currency, not from `apps.status`.
- Export and deployment always validate current canonical state independently.

### 14.14 Acceptance

- A model-only heuristic can never be a critical completion blocker.
- Every critical blocker names evidence/platform proof or a deterministic rule.
- A report for sequence N is stale at N+1.
- Stale reports do not block direct edits, Preview, export, or deployment.
- Intent coverage cannot be claimed from names alone.
- Correction review cannot mutate the app.
- Bounded correction exhaustion yields an honest `incomplete` report.

## 15. UX and agent experience

### 15.1 Pre-materialization builder state

Before meaningful genesis, `/build/new` shows:

- the conversation;
- textual progress stages;
- a compact reviewed-design outline;
- unresolved questions/assumptions when relevant;
- resume/discard controls;
- no app tree;
- no Preview;
- no deployment controls;
- no fake module/form/field skeleton.

The page is scoped by `designSessionId`, not `appId`. A missing design session starts only after the first authorized, chargeable user turn is durably admitted.

### 15.2 Progress stages

Use truthful, non-percentage stages:

```ts
type DesignBuildStage =
  | "understanding"
  | "designing"
  | "reviewing-design"
  | "revising-design"
  | "planning"
  | "building-first-workflow"
  | "building"
  | "reviewing-implementation"
  | "ready"
  | "needs-input"
  | "incomplete"
  | "failed";
```

Stage is derived from durable artifacts/orchestration events, never from a client-only state machine or model prose.

Do not show a percentage unless Nova later has an objective denominator. Slice progress may show “2 of 5 planned workflows committed” only when the current build plan is still active.

### 15.3 Reviewed design outline

The outline card is a safe projection, not the raw Design Contract. It includes:

- app objective;
- design actors;
- principal tasks/workflows;
- record concepts;
- work queues/read models;
- key handoffs and access boundaries;
- important assumptions;
- blocking open questions;
- review status and finding counts;
- explicit out-of-scope/deferred items.

It does not expose:

- source excerpts containing PHI;
- attachment bodies;
- model reasoning;
- private change-set steps;
- internal confidence values without product meaning;
- implementation UUIDs.

The outline is informational. User approval is not a mandatory gate unless a question changes architecture, safety, external effects, or a source-supported requirement.

### 15.4 Durable progress projection

Server events:

- `data-design-session` — the turn's scope announce (`{designSessionId, materializedAppId}`; the one frame outside the envelope below, since it precedes any orchestration event);
- `data-design-pulse` — the throttled live-activity signal while design-phase model work streams (`{phase: design|review|revise|plan, chars, step?}` — the phase from the server's own control flow, the cumulative delivered character count, and optionally the sub-step label the key-order narrator derived from a streaming submission's top-level keys, e.g. "Working out the records"; volume and a canned label, never content). The pulse is what keeps the stage line truthful through the reviewer's silent minutes, and it is the one legitimate live source for the `reviewing-design`/`revising-design` stages, which no durable frame can name until the phase has already ended;
- `data-design-outline`;
- `data-build-plan-summary`;
- `data-build-slice-started`;
- `data-build-slice-committed`;
- `data-app-materialized` — the strict activation receipt itself;
- `data-build-completion`.

Review findings ride the outline projection (its status + finding counts) rather than a separate `data-design-review-summary` frame; `data-conformance-summary` is the conformance unit's addition.

Every enveloped event has:

```ts
interface DesignProgressEnvelope<T> {
  eventVersion: 1;
  designSessionId: string;
  orchestrationEventId: string;
  orchestrationRevision: number;
  data: T;
}
```

The stream frame is a projection of a durable row. Reconnect re-derives the latest projection; the client does not need every transient frame to recover.

Unknown versions/keys fail closed and trigger a fresh authorized session snapshot.

### 15.5 No private staging in user surfaces

Do not stream or render:

- raw admitted staged mutations;
- handle maps;
- incomplete private modules/forms;
- private validator findings one tool step at a time;
- model chain-of-thought;
- raw review prompts/outputs.

The UI may show coarse statements such as “Building intake workflow” or “Resolving a form dependency.” Only committed canonical revisions enter the tree, Preview, collaboration stream, event log, or deployment surfaces.

### 15.6 Materialization handoff

When `data-app-materialized` arrives:

1. strict-parse the receipt and install the complete sequence-`1` document atomically (install is synchronous — later frames in the same stream land on the installed doc — while the digest verifies concurrently over the shared canonical JSON text, WebCrypto against the server's `node:crypto` digest, surfacing the reload recovery on a mismatch);
2. promote the URL without a second history entry;
3. initialize collaboration at sequence `1`;
4. mount the normal builder;
5. show the first coherent workflow;
6. continue chat/build progress in place.

The explicit-blank action returns this exact receipt shape (null design lineage and change set, the starter UUIDs present), so one installer serves both births.

There is no transient Survey/Question 1 flash. The design outline remains accessible from the conversation or later Design panel.

A lost event heals through design-session resolution and authorized app snapshot fetch.

### 15.7 Later slices

Later committed slices use ordinary canonical app-change frames. The UI:

- updates tree and Preview only after the app change commits;
- shows a brief “workflow added” progress item keyed to the committed slice receipt;
- never predicts that an open change set will succeed;
- preserves current selection when possible;
- falls back to a valid parent/default selection when a committed revision removes it.

Peer tabs see only those canonical commits and normal reload boundaries.

### 15.8 Questions and pause

The design agent asks whenever it has questions — early, fully, any
number of rounds — through its own `askQuestions` calls. When a round
pauses the run:

- the exact `askQuestions` tool state persists in the transcript (the
  agent's real call, not a synthesized part);
- `awaiting_input` is set under the exact target holder — the SESSION row pre-materialization, the APP row after (the pause stamps whichever row carries the run) — and the `awaiting-user-questions` orchestration event names the state for the stage fold;
- show `needs-input`;
- do not create/materialize an app merely to host the pause;
- on answer, reacquire the same design-session holder nonce using the target-polymorphic resume protocol; the loop resumes with its context intact (the answers seed cumulative deterministic claims, and no author re-run occurs);
- answers to an ACCEPTED design's blocking questions reopen a fresh reviewed design cycle (§7.3), and a superseding acceptance supersedes obsolete open change sets.

A stale tab with the wrong nonce receives the same refresh-required semantics as current app chat.

### 15.9 Designs in progress

The Project home renders a separate list section, not app cards:

```ts
interface DesignInProgressSummary {
  designSessionId: string;
  title: string;
  projectId: string;
  stage: DesignBuildStage;
  lastActivityAt: string;
  materializedAppId: string | null;
  awaitingInput: boolean;
  recoverable: boolean;
}
```

Rules:

- active pre-app sessions appear here;
- materialized sessions normally resolve to the app and leave this list;
- a materialized session with a recoverable interrupted build may show a resume affordance associated with the app, not a duplicate app card;
- discarded/expired sessions disappear from ordinary lists but follow retention policy;
- active pre-app sessions are owner-private even to Project co-members;
- list/search/resume/discard require exact owner identity plus current Project
  membership and collapse denial to opaque not-found behavior;
- after materialization, the app is the Project-shared authority boundary.

### 15.10 Discard and cancellation

Discarding a pre-app design:

1. takes the design-session lock;
2. proves current user permission and no incompatible live holder;
3. marks the session abandoned;
4. releases/refunds an unsettled reservation according to the current ledger contract;
5. abandons open change sets;
6. supersedes running slice attempts and retires thread stream-holder markers;
7. retains or deletes artifacts according to explicit retention policy;
8. does not delete shared media assets;
9. removes only thread-media edges owned by the discarded thread when the transcript is deleted.

After materialization, the UI does not offer pre-app “discard design.” Stopping an interrupted build follows the app run/error lifecycle, while reviewed design lineage remains attached. App deletion remains the ordinary app lifecycle.

A browser disconnect is not cancellation; server work and durable stream behavior remain unchanged.

### 15.11 Explicit blank path

“Start with a blank app” remains a distinct, immediate action:

- it creates the canonical minimal Survey/Form/Question app;
- it uses the strict shared activation receipt;
- it mounts tree and Preview immediately;
- it creates no Design Contract or design session;
- its user-facing name may remain “blank app,” but implementation/documentation call it `explicit-blank`.

Do not route this path through the design method merely for architectural uniformity.

### 15.12 Error and incomplete states

User-visible messages distinguish:

- access/Project scope loss;
- another active generation;
- out of credits;
- source/attachment unavailable;
- structured design/review failure;
- unsupported platform requirement;
- rebase conflict;
- deterministic implementation failure;
- transient infrastructure failure;
- honest incomplete completion.

Never say:

- “saved” for staged work;
- “reviewed” when the reviewer call failed;
- “complete” with grounded critical findings;
- “deployed” for a Blueprint-only commit;
- “Previewed” for an external automation that Preview does not execute.

A failed pre-app run leaves no app. A failed post-materialization run leaves the last valid canonical revision and follows current app error/refund semantics.

### 15.13 Accessibility and interaction

- Progress/status changes use polite live regions; errors/questions use assertive announcements only when action is required.
- The outline, findings summary, and slice progress are keyboard navigable.
- Stage is conveyed by text, not color alone.
- Focus moves to the question card when input is required and to the builder heading after first activation.
- URL replacement does not unexpectedly reset focus or scroll.
- Resume/discard actions have explicit destructive confirmation where transcript/artifact deletion is involved.
- Long outlines use semantic headings and disclosure controls rather than a dense JSON view.

### 15.14 Agent experience

The executor gains:

- immutable reviewed task specifications;
- slice-bounded context;
- local handles instead of UUID bookkeeping;
- granular construction;
- durable idempotent request receipts;
- amendment instead of payload recomposition;
- exact introduced/resolved diagnostics;
- explicit external dependency/read-set errors;
- deterministic module reordering;
- direct-write lowering provenance;
- bounded issue escalation;
- crash-safe resume.

The orchestrator gains:

- immutable design/review/build artifacts;
- server-owned state transitions;
- exact slice receipts;
- bounded correction loops;
- honest completion artifacts.

### 15.15 Design history after build — Unit F (remaining)

After the pipeline is stable, add a read-only **Design** surface:

- accepted Design Contract revision;
- source-claim summary and evidence links;
- review findings and dispositions;
- build plan and committed slice sequences;
- implementation coordinates;
- current/stale conformance status;
- assumptions/deferred requirements;
- external setup/actions;
- completion report.

It never edits Blueprint state. Sensitive source access remains separately authorized, and the panel does not duplicate raw source bodies.

### 15.16 Acceptance

- No app tree or Preview appears before materialization.
- No placeholder starter flashes during a chat build.
- Refresh/reconnect reconstructs stage from durable state.
- Duplicate activation receipts are harmless.
- A lost activation frame still reaches one app.
- A question-only session creates no app.
- Private change-set details never enter user or peer surfaces.
- Screen-reader and keyboard paths cover design, question, activation, and recovery states.

## 16. Design-aware edit mode — Unit G (remaining)

No reviewed app-edit workflow is active in the current foundation. Direct
builder, chat edit, and MCP mutations remain immediate canonical edits. This
section specifies the reviewed edit workflow Unit G adds after Unit F supplies
projection, conformance, and correction primitives.

### 16.1 Authority model

A design-aware edit creates a `design_sessions(mode = 'edit', app_id = ...)` artifact scope, but the **app row remains the only run/credit/mutation authority**. Creation holds the app row `FOR SHARE` and derives the session's Project from it, rejecting a caller whose authorization snapshot a concurrent Project move invalidated — the session's tenancy agrees with its app's by construction, because the move's re-tenanting UPDATE only reaches rows that exist when it runs.

- Claim and reserve through the current app edit protocol.
- Hold one exact app `(mode, runId, nonce)` capability.
- Store design/review/amendment artifacts under the design session.
- Target the conversation thread at the design session when preserving a distinct reviewed-edit lineage is useful; the generation-target resolver delegates liveness and writes to the bound app.
- Never duplicate the holder or reservation on the edit design-session row.
- Every change-set commit reuses the app's exact holder capability.

Add database checks so a `mode = 'edit'` design session cannot carry pre-app holder/reservation columns.

### 16.2 Design amendment

```ts
const designAmendmentSchema = z.object({
  schemaVersion: z.literal(1),
  id: designIdSchema,
  baseDesignRevisionId: z.string().uuid().nullable(),
  baseDesignDigest: sha256Schema.nullable(),
  baseAppSeq: persistedSequenceSchema,
  baseAppSnapshotDigest: sha256Schema,
  requestClaimIds: z.array(designIdSchema).min(1),
  affectedIntentIds: z.array(designIdSchema),
  proposedAdditions: z.array(designIdSchema),
  proposedChanges: z.array(designIdSchema),
  proposedRemovals: z.array(designIdSchema),
  expectedExternalEffects: z.array(designIdSchema),
  rationale: z.string().min(1),
}).strict();
```

The amendment is an immutable proposal produced from the user's new request, accepted source evidence, current app projection, and existing design lineage. It does not itself mutate either contract or app.

### 16.3 Apps with design lineage

For an app with a current accepted Design Contract:

1. claim the app edit run and load one authorized exact snapshot;
2. load the latest accepted design revision selected for this app lineage;
3. derive any conformance report at an older app sequence as stale;
4. compare the deterministic implementation projection with design provenance;
5. model the request as a `DesignAmendment`;
6. classify it:
   - `intent-change`;
   - `implementation-correction`;
   - `external-setup-only`;
7. independently review architectural impact;
8. create a new Design Contract revision only for `intent-change`;
9. create an impacted build plan with exactly owned intent changes;
10. execute through Atomic Change Sets based on the exact current app sequence;
11. run impacted deterministic conformance and bounded quality review;
12. settle/release through the existing app edit finalization;
13. append the terminal orchestration event and set the edit design session to `completed` only after the app holder is released/settled.

An implementation correction may cite the existing accepted intent and produce only corrective slices. Do not churn the Design Contract merely because the implementation was deficient.

### 16.4 Reconciliation before planning

Human, builder, MCP, deployment-related migrations, or prior agent turns may have changed the app after the latest design report.

Before planning:

- load current canonical app at sequence N;
- verify its digest;
- derive a current implementation projection;
- load all still-valid design-to-implementation provenance;
- classify unmapped additions/removals;
- never reject the current app merely because it diverged;
- expose divergences as amendment context.

The model may infer possible intent from implementation only when explicitly labeled `inferred-from-blueprint`. It cannot rewrite source-grounded accepted intent without a reviewed amendment.

### 16.5 Apps without design lineage

Create a `RecoveredDesignSnapshot`:

```ts
interface RecoveredDesignSnapshot {
  schemaVersion: 1;
  id: string;
  appId: string;
  appSeq: number;
  appSnapshotDigest: Sha256;
  projectionVersion: string;
  projectionDigest: Sha256;
  provenance: "inferred-from-blueprint";
  actors: RecoveredActor[];
  records: RecoveredRecord[];
  tasks: RecoveredTaskSurface[];
  readModels: RecoveredReadModel[];
  navigation: RecoveredNavigation[];
  unknownHistoricalIntent: string[];
}
```

Rules:

- derive only from the deterministic projection;
- point “evidence” to implementation coordinates, not user-message source refs;
- state that original rationale, omitted requirements, and rejected alternatives are unknown;
- do not present it as an accepted Design Contract;
- use the user's new request as the first source-grounded amendment;
- independently review the amendment and impacted plan.

A recovered snapshot may guide impact analysis, but it cannot establish historical requirement coverage.

### 16.6 Removals and destructive consequences

A design-aware removal must name:

- affected intent IDs;
- implementation coordinates;
- case/data consequences;
- external resource consequences;
- whether saved case values are renamed, retired, parked, or left untouched;
- whether user confirmation is required;
- whether the operation is batch-exclusive.

Case-property renames remain explicit semantic commands. Generic endpoint diff never synthesizes one.

External destructive actions are separate confirmed workflows and never staged inside an Atomic Change Set.

### 16.7 Concurrent canonical edits

The edit change set records its exact base sequence/digest and replays on the fresh app under the canonical kernel.

- Clean replay may merge.
- Missing target/anchor returns a structured conflict.
- A human edit to an unrelated area may coexist.
- A semantic conflict stops the slice; the model cannot guess by name.
- A newer canonical sequence makes prior conformance reports stale.
- A concurrent Project move/access loss is terminal for the run.

The accepted design is not a lock on human edits.

### 16.8 Human and direct MCP edits

Direct visual-builder and existing MCP tools:

- continue to commit immediately through `CanonicalMutationHost`;
- do not require a Design Contract or design session;
- do not run design review automatically;
- preserve current result and validity semantics;
- mark sequence-bound reports stale through ordinary sequence comparison;
- may optionally write minimal “unmapped implementation change” provenance later, but absence of provenance never invalidates the commit.

This preserves three-editor symmetry on canonical state.

### 16.9 Edit questions and pause

A design-aware edit may ask a question only when the answer materially affects architecture, safety, external effects, or a source-supported requirement.

Pause/reacquire uses the app's exact edit holder. The design session records the question artifact and orchestration state but owns no parallel lease.

### 16.10 Acceptance

- An edit design session cannot carry its own live holder/reservation.
- Legacy rationale is never fabricated.
- Implementation-only correction does not create a needless contract revision.
- Intent changes are independently reviewed.
- Direct builder/MCP edits remain immediate.
- Current canonical state is always the rebase authority.
- A valid app never becomes unusable because design metadata is stale.

## 17. MCP surface — direct tools current; reviewed workflow Unit G remaining

Section 17.1 is the current MCP contract. Sections 17.2–17.9 are Unit G's
remaining high-level workflow contract; none of those workflow tools is
registered until Unit G ships them together.

### 17.1 Preserve direct canonical tools

Existing shared MCP tools retain immediate canonical semantics:

- same original strict tool schemas;
- same admitted mutation grammar;
- same `CanonicalMutationHost`;
- same Project authorization;
- same `applyBlueprintChange` treatment for exclusive schema operations;
- same result/error shapes unless a separately reviewed MCP contract change is required.

`create_app` continues to mean explicit minimal app creation. It does not silently become a reviewed chat-style build.

### 17.2 High-level reviewed workflow tools

After the browser path is stable, add:

- `start_design_session`;
- `get_design_session`;
- `get_design_contract`;
- `get_design_review`;
- `submit_design_answers`;
- `execute_design_session`;
- `get_design_conformance`;
- `abandon_design_session`.

These tools orchestrate the same durable design/build workflow. They are not alternate Blueprint editors.

### 17.3 Strict workflow results

High-level calls return a closed state:

```ts
type DesignWorkflowResult =
  | {
      kind: "awaiting_input";
      designSessionId: string;
      orchestrationRevision: number;
      questions: QuestionProjection[];
    }
  | {
      kind: "design_ready";
      designSessionId: string;
      designRevisionId: string;
      designRevisionDigest: Sha256;
      outline: DesignOutlineProjection;
    }
  | {
      kind: "building";
      designSessionId: string;
      orchestrationRevision: number;
      committedSlices: number;
      plannedSlices: number;
      appId: string | null;
    }
  | {
      kind: "complete";
      designSessionId: string;
      appId: string;
      appSeq: number;
      completionReportId: string;
    }
  | {
      kind: "incomplete";
      designSessionId: string;
      appId: string | null;
      reason: string;
      recoverable: boolean;
    };
```

Return projections and artifact IDs. Do not return model reasoning, raw private change-set steps, holder nonces, or source bodies the caller did not explicitly request and authorize.

### 17.4 Idempotency and authority

Every mutating high-level MCP call requires an MCP request ID. Persist:

- tool name;
- caller/user identity;
- target Project/app/session;
- exact input digest;
- orchestration revision;
- result receipt.

Same ID and digest returns the same result. Same ID with different input rejects.

The server owns:

- session IDs;
- proposed app IDs;
- run/holder nonces;
- credit reservation;
- artifact versions;
- staging request IDs;
- change-set commit batch IDs.

MCP clients cannot inject canonical authority through these tools.

### 17.5 Questions

`execute_design_session` may stop with `awaiting_input`. `submit_design_answers`:

- names the exact question artifact and orchestration revision;
- strict-parses answers;
- reacquires the exact target holder;
- rejects stale/superseded rounds;
- resumes the same durable workflow.

Do not manufacture default answers merely because an MCP client expects one synchronous result.

### 17.6 No generic open staging transaction initially

Do not expose `begin_change_set`, granular stage calls, or `commit_change_set` as a generic multi-request MCP transaction in the first release.

That surface would require a separate public contract for:

- leases and expiry;
- ownership transfer;
- durable request idempotency;
- handle discovery;
- base refresh/rebase;
- client crash recovery;
- diagnostics pagination;
- abandonment/retention;
- external read-set changes.

The initial MCP reviewed workflow executes its private change sets server-side through the same executor.

### 17.7 Progress

Use MCP progress notifications as projections of durable orchestration events. Missing notifications do not lose state; `get_design_session` returns the current strict projection.

Do not emit one notification per private mutation.

### 17.8 Authorization and privacy

Every read/write:

- resolves current Project membership;
- returns opaque not-found for foreign/missing identifiers;
- applies the same source/attachment authorization as browser chat;
- uses the same no-training provider configuration;
- logs only safe artifact metadata/digests;
- respects the same retention/delete policy.

### 17.9 Acceptance

- Direct MCP mutations remain immediate and canonical.
- High-level MCP build results match browser artifacts and commit semantics.
- A repeated request ID cannot duplicate design sessions, model runs, staged steps, or apps.
- Awaiting questions are resumable and stale-answer-safe.
- No private change-set API leaks before its lease/recovery contract exists.

## 18. Persistence and migrations

The repository carries one operational legacy repair pair:
`scan-legacy-preplan-builds` is read-only, and
`migrate-legacy-preplan-builds` converges holder-free non-`complete` apps that
have no design-session lineage through the reviewed operator-recovery
authority. Held rows wait for the reaper; empty rows require per-app operator
decisions. This is not a second runtime reader or persistence dialect.

### 18.1 Table inventory

The current reviewed-build foundation owns:

- `design_sessions`
- `design_source_packages`
- `design_revisions`
- `design_reviews`
- `design_review_dispositions`
- `design_build_plans`
- `design_orchestration_events`
- `design_slice_attempts`
- `design_committed_slices`
- `design_change_sets`
- `design_change_set_requests`
- `design_change_set_steps`
- `design_change_set_step_stages`
- `design_change_set_handles`
- `design_external_action_receipts`
- `app_change_intents`
- `thread_media_refs`

Unit F adds exactly:

- `design_conformance_reports`
- `design_completion_reports`

Existing-table changes:

- `threads`: exact app/design-session target union;
- `chat_stream_chunks`: exact app/design-session target union;
- `run_summaries`: exact app/design-session target union;
- app/media reference readers: Blueprint references and thread references are separate;
- Project move/delete/retention inventories: include materialized design lineage.

Prefer a table per lifecycle/authority rather than one generic polymorphic `design_artifacts` JSON bag. The JSON payloads remain typed, but relational keys/statuses/digests are first-class constraints.

### 18.2 Artifact tables

Each typed MODEL artifact row carries:

```text
id
design_session_id
artifact_digest
parent linkage where applicable
source_package_digest
producer_model
prompt_version
created_by_run_id
created_at
envelope jsonb        (the full §6.12 envelope, schema version inside)
```

`design_source_packages` is the deliberate exception: a deterministic
projection with no model producer, so its row is
`(id, design_session_id, project_id, package_digest, created_by_run_id,
payload, created_at)` with `(design_session_id, package_digest)` unique.

Additional exact bindings:

- `design_revisions`: monotonic immutable revision with lifecycle `draft | accepted` fixed at insert, `contract_digest` beside the envelope digest, `(revision = 1) ⇔ (parent IS NULL)`; supersession derives from the session's active pointer and ancestry; acceptance requires a persisted review of the parent draft, proved at insert;
- `design_reviews`: reviewed revision ID/digest (proved against the stored revision at insert), per-revision `review_ordinal`, reviewer call metadata; the review's source package must be the revision's;
- `design_review_dispositions`: `(review_id, finding_id)` primary key, status, resulting revision, and the exact `FindingDisposition` payload — inserted in the SAME transaction as the revision that carries them;
- `design_build_plans`: accepted design revision/digest (a plan over a draft is unpersistable), plan digest;
- Unit F `design_conformance_reports`: app ID/sequence/snapshot digest and projection/rule versions;
- Unit F `design_completion_reports`: exact current design/plan/app/report identities.

Use unique constraints so one accepted revision or active build plan is selected explicitly, not by “latest timestamp” ambiguity.

### 18.3 Parse persisted JSON exactly

Apply the repository's persisted-JSON discipline:

- select every replayable/authoritative JSONB payload as `::text`;
- parse through `parsePersistedJsonText`;
- strict-parse through the current artifact schema;
- verify the canonical digest;
- reject duplicate keys, noncanonical numbers, unknown keys, or schema drift;
- never cast arbitrary database JSON to a TypeScript type;
- never retain a fallback reader for an old artifact dialect after cutover.

Producer and reader use the same Zod schema. A migration changes all stored rows or establishes a new immutable artifact version with an explicit reader; it does not silently coerce.

### 18.4 Design-session constraints

Actual DDL must make these impossible:

- build session without `proposed_app_id`;
- edit session without `app_id`;
- pre-app build session with both `app_id` and `state = 'active'`;
- materialized build session without `app_id`;
- `materialized` state on an edit session or `completed` state on a build session;
- abandoned session with a live holder;
- partial holder column group;
- partial reservation column group;
- edit session carrying design-session holder/reservation/`awaiting_input` authority;
- active pre-app session moved to another Project;
- two active selected design revisions/build plans for one session.

The migration uses repository-native ID column types and validated Project/app foreign keys.

### 18.5 Orchestration events

`design_orchestration_events` is append-only:

```text
design_session_id
revision
event_id
predecessor_event_id
predecessor_digest
run_id
holder_nonce_digest
kind
payload
created_at
PRIMARY KEY (design_session_id, revision)
UNIQUE (design_session_id, event_id)
UNIQUE (design_session_id, predecessor_event_id) WHERE predecessor_event_id IS NOT NULL
```

Do not persist raw holder nonces; store only the current authority on the holder row and a safe digest/identifier in audit metadata.

The event fold strict-parses the complete suffix. Runtime may `SELECT, INSERT` only. No update/delete outside retention of an abandoned whole session where policy permits physical deletion.

### 18.6 Slice attempts and committed receipts

`design_slice_attempts` is the mutable execution-control row described in section 13. It holds immutable input identities plus status and failure metadata. One partial unique index permits one `running` attempt per `(design_session_id, build_plan_id, slice_id)`.

`design_committed_slices` is append-only and stores the exact `CommittedSliceReceipt`:

```text
id
design_session_id
design_revision_id
design_revision_digest
build_plan_id
build_plan_digest
slice_id
slice_attempt_id
change_set_id
app_id
seq
batch_id
committed_snapshot_digest
owning_intent_ids
mutation_count
committed_at
```

Constraints:

- unique `change_set_id`;
- unique `(app_id, seq, slice_id)`;
- unique `(build_plan_id, slice_id)` for committed owning slices;
- exact foreign keys to attempt/change set/artifacts;
- strict JSON parsing for `owning_intent_ids`;
- row inserted in the same canonical/materialization transaction that commits the change set.

The orchestrator may append a `slice-committed` event after the transaction, but recovery treats `design_committed_slices` as the authoritative receipt if that projection event was lost.

### 18.7 Change-set tables

`design_change_sets`:

```text
id
design_session_id
design_revision_id
design_revision_digest
build_plan_id
build_plan_digest
slice_id
attempt_id
kind                  genesis | app-edit
app_id
proposed_app_id
base_seq
base_project_id
base_snapshot_digest
owner_user_id
owner_run_id
status                open | committed | abandoned | superseded
revision
next_ordinal
exclusive_kind
committed_seq
committed_batch_id
committed_snapshot_digest
created_at
updated_at
```

Constraints:

- exactly one of app base or empty genesis base according to `kind`;
- `committed_*` all present only when committed;
- no intermediate commit status exists: canonical write and `open -> committed` transition are atomic;
- one open change set per slice attempt;
- design/build-plan digests are non-null and immutable;
- `revision` and `next_ordinal` are safe persisted sequences.

`design_change_set_requests`:

```text
change_set_id
request_id
tool_name
input_digest
expected_revision
resulting_revision
status                staged | rejected
rejection_code
receipt
created_at
PRIMARY KEY (change_set_id, request_id)
```

A successful request, handles, stages, result receipt, and revision advance commit in one transaction. There is no durable in-progress request state — and therefore one timestamp. A staged request advances the revision by exactly one and a rejected one advances nothing; a CHECK ties `resulting_revision` to `status`.

`design_change_set_steps`:

```text
change_set_id
ordinal
request_id
tool_name
mutations
mutation_digest
intent_ids
read_set
created_at
PRIMARY KEY (change_set_id, ordinal)
UNIQUE (change_set_id, request_id)
```

`design_change_set_step_stages` keeps exact stage ranges, not duplicated mutations:

```text
change_set_id
step_ordinal
stage_ordinal
stage_name
mutation_start
mutation_count
PRIMARY KEY (change_set_id, step_ordinal, stage_ordinal)
```

`design_change_set_handles`:

```text
change_set_id
handle
uuid
entity_kind
binding_request_id
created_at
PRIMARY KEY (change_set_id, handle)
UNIQUE (change_set_id, uuid)
```

All mutation/read-set/result JSON uses exact text parsing and strict schemas.

### 18.8 Candidate is not persisted

Never store a second Blueprint snapshot on the change set.

Rehydrate from:

- exact canonical base at `base_seq` and `base_snapshot_digest`, or the typed empty genesis base;
- admitted steps in ordinal order.

Optional in-memory or cache snapshots are disposable and keyed by `(change_set_id, revision, derived_digest)`. A cache miss or disagreement falls back to authoritative replay.

### 18.9 Provenance

`app_change_intents` records committed design provenance:

```text
app_id
seq
design_session_id
design_revision_id
build_plan_id
slice_id
intent_id
coordinate_kind
coordinate_payload
created_at
```

Primary/unique keys prevent duplicate ownership records. Coordinate payload strict-parses through the closed coordinate schema.

For sequence `1`, provenance rows land in the materialization transaction. For later slices, they are canonical transaction sidecars.

Deleting/superseding a design artifact does not delete provenance for a live app; durable app lineage remains auditable.

### 18.10 External action receipts

```ts
interface ExternalActionReceipt {
  id: string;
  designSessionId: string;
  buildPlanId: string;
  externalActionId: DesignId;
  projectId: string;
  appId: string | null;
  actionDigest: Sha256;
  outcome: "completed" | "manual-confirmed";
  evidence:
    | { kind: "nova-operation"; operationId: string; resultDigest: Sha256 }
    | { kind: "user-confirmation"; confirmationId: string; confirmedByUserId: string }
    | { kind: "external-system"; referenceDigest: Sha256; resultDigest: Sha256 };
  completedAt: string;
}
```

External actions do not masquerade as Blueprint commits. Before opening a dependent change set, the orchestrator requires the exact session/plan/action/Project/app scope, re-digests the current action, strict-parses its evidence, and verifies that the evidence kind matches the completion outcome and idempotency owner. Materialized receipts follow their app in a Project move; pre-app receipts never move.

### 18.11 Thread/stream target migrations

Each target-polymorphic table has:

- nullable `app_id`;
- nullable `design_session_id`;
- `CHECK ((app_id IS NOT NULL)::int + (design_session_id IS NOT NULL)::int = 1)`;
- target-specific indexes;
- foreign keys with explicit delete behavior;
- loaders that return a closed `GenerationTarget`.

Existing rows remain app-targeted. No data rewrite is required beyond validating the new exact-one constraint.

`chat_stream_chunks` preserves `(stream_id, first_index)` idempotency. `run_summaries` uses partial unique indexes:

- `(app_id, run_id)` where app-targeted;
- `(design_session_id, run_id)` where session-targeted.

### 18.12 Thread media references

`thread_media_refs` owns only conversation carriers.

- primary key `(thread_id, asset_id)`;
- exact Project ID for tenancy/inventory checks;
- `ON DELETE CASCADE` from thread;
- `ON DELETE RESTRICT` or authoritative deletion guard from asset;
- replacement under the target/thread transaction;
- no app-wide overwrite.

Blueprint media-reference tables remain unchanged and app-scoped.

### 18.13 Runtime privileges

Update:

- `lib/db/pg.ts`;
- `lib/db/types.ts`;
- `lib/db/persistedJson.ts`;
- `lib/db/privilegeConvergence.ts`;
- runtime database probe;
- row-lock privilege tests;
- tenant-scope guards;
- Project-move inventory;
- soft-delete/physical-delete inventory;
- migration fixtures.

Register every table with its final runtime capability:

- append-only artifacts/events/provenance: `SELECT, INSERT`;
- mutable holder/session/change-set authority rows: required `SELECT, INSERT, UPDATE`, and delete only where lifecycle needs it;
- read-only immutable reports if written through privileged routines: exact policy;
- retention deletions through narrowly owned service paths.

Do not add row-lock clauses to tables whose runtime role lacks the PostgreSQL `UPDATE` privilege required by those clauses.

The change-set tables' concrete policy: `design_change_sets` is the one read-write authority row (row-locked to serialize its ledgers); the request/step/stage/handle ledgers, `design_committed_slices`, and `app_change_intents` are append-only (`SELECT, INSERT`) and never row-locked. External-action receipts are read-write only because an app Project move re-tenants their Project key in the same app-locked transaction. No realtime channel exists for any of them — private staging never pokes a stream.

### 18.14 Project movement

Before materialization, a design session cannot change Projects.

After materialization, an app Project move transaction:

- locks the app using the current order;
- reauthorizes source/destination;
- updates materialized design-session Project IDs;
- updates Project-scoped external-action rows (committed slice receipts and intent provenance are app-keyed, carry no Project column, and follow the app implicitly);
- validates/remaps thread media as current app move rules require;
- preserves app-change Project continuity;
- does not rewrite immutable source claims or artifact content;
- makes subsequent artifact reads authorize against the destination Project.

A mode-edit design session follows its bound app move or is rejected if a live incompatible edit run exists under current move rules.

Open change sets deliberately do NOT re-tenant on a move: `base_project_id` is the captured base scope, so a moved app strands its open sets — their commit rejects terminally — and the move transaction never touches change-set rows.

### 18.15 Soft delete and physical delete

Soft-deleted apps retain the current app-bound lineage:

- canonical history/baseline;
- design provenance;
- accepted design/review/build artifacts (Unit F adds conformance/completion
  artifacts to the same retention set);
- thread/media references required for exact restore;
- materialized design session linkage.

They are not executable while deleted.

Physical deletion cascades or explicitly removes app-bound lineage according to retention/legal policy. Pre-app abandoned sessions have their own delete path and never create an app tombstone.

### 18.16 Retention

- Accepted design revisions, reviews, dispositions, plans, committed slice
  receipts, and provenance are durable app lineage. Unit F's conformance and
  completion reports join that same durable lineage.
- Raw model reasoning is never stored.
- Source packages store normalized claims/pointers, not duplicated raw attachments.
- Open/superseded/abandoned staging steps may be pruned only after no live run, retry receipt, audit, or support policy references them.
- Request idempotency receipts outlive the maximum retry/reconnect horizon.
- Stream chunks retain the existing operational window.
- Thread transcripts follow the existing conversation retention model plus explicit user deletion.
- Retention jobs use exact status/age predicates and cannot touch active sessions.

### 18.17 Migration delivery policy

Follow the repository's final-shape/direct-cutover contracts:

- one final-shape migration per persisted change;
- no feature-flagged dual readers/writers;
- no old/new target aliases;
- no backfill Design Contract for existing apps;
- no automatic rewrite of existing starter apps;
- existing threads/streams/summaries remain app-targeted;
- all creation call sites cut atomically to the closed genesis owner;
- migration scans and a maintenance runbook cover incompatible table constraints;
- migrations are immutable after running;
- new image proves all final shapes before ingress resumes.

### 18.18 Acceptance

- Every impossible target/status/holder combination is database-rejected.
- Every artifact/request/mutation JSON round-trips through exact persisted parsing.
- A change-set candidate can be fully reconstructed without a stored snapshot.
- A repeated request cannot allocate a second ordinal or handle.
- Existing app conversations survive the target migration unchanged.
- Runtime privileges match every lock/write path.
- Project move and soft-delete inventories include design lineage.

## 19. Delivery plan

### 19.1 Program discipline

This is one architecture program delivered as a reviewed PR train.

Every PR must:

- read the applicable root/subtree `CLAUDE.md` contracts first;
- ship final-shape production code for the behavior it activates;
- contain its tests and present-state documentation;
- avoid feature flags, dual persistence, compatibility readers, and temporary aliases;
- preserve current public behavior unless the unit explicitly performs the final cutover;
- include a rollback/restore decision for every migration;
- pass the full repository verification required by touched subtrees.

Internal final-shape modules may land before they are reachable. Do not create a temporary public path or temporary database dialect merely to split review.

### 19.2 Current implementation baseline

The current foundation that Units F and G extend is enforced by the code and
the contracts in Sections 1–13 and 18:

1. **Canonical workspace and commit kernel:** shared tools execute against a workspace-owned snapshot; canonical chat, MCP, and builder mutations retain one admission, authorization, holder, integrity, history, notification, and post-commit convergence path.
2. **Atomic Change Sets:** private candidates persist exact admitted steps, handles, read sets, diagnostics, and idempotency receipts. Staged state reaches no canonical reader or stream. Commit replays the complete candidate and writes the canonical revision, exact running-attempt transition, committed-slice receipt, and implementation provenance in one transaction.
3. **Reviewed design artifacts:** source packages, Design Contracts, independent reviews, dispositions, and build plans are immutable, strict-parsed, digest-bound artifacts. The design loop advances only through server-derived durable ancestry, makes a plan inactive when newer source content reopens the design, and persists every artifact under the exact live holder, actor, owner-before-materialization, and current Project membership.
4. **Pre-app generation target:** owner-private build design sessions carry run, reservation, thread, stream, pause, resume, failure, discard cleanup, and reaper semantics before an app exists. Materialization transfers that authority once to the Project-shared app; all later writers lock and authorize the delegated app holder.
5. **Meaningful genesis and slice execution:** chat materializes only an export-ready meaningful root with no prerequisite slices. The bounded executor stages exact per-step intent ownership, admits no blocking external action without a registered receipt producer, meters every provider response observed before its post-await deadline decision, and commits each later slice as one canonical revision. Attempt-control writes and production change-set open/bind use the same exact-holder transaction as their lifecycle transition. The app remains reopenable after a later recoverable slice failure.
6. **Recovery and UI:** a fresh design immediately acquires a durable `/build/new?design=<id>` recovery URL; a materialized scope resolves to the authoritative app. Active designs participate in the Project empty-state decision, and a materialized build is reachable from its app card.
7. **Explicit blank and direct editors:** explicit blank creation remains the immediate Survey/Form/Question path. Direct builder and shared MCP tools remain immediate canonical editors and do not require design metadata.

These are maintained invariants, not remaining work. Unit F may add reporting
and corrections around them; Unit G may add reviewed edit orchestration.
Neither unit may reopen the current persistence shapes or introduce a second
validity/authority regime.

### 19.3 Remaining dependency order and review gates

Only two units remain, in this order:

1. **Unit F — Completion truth gate.** Deterministic, sequence-bound conformance and grounded quality review may block a completion claim, never valid app use or direct canonical editing.
2. **Unit G — Editor symmetry gate.** Reviewed app edits and high-level MCP reuse the same artifacts, change sets, holder authority, idempotency, and correction machinery while direct builder/MCP mutation paths remain immediate.

Unit G depends on Unit F's implementation projection, provenance readers, conformance vocabulary, and correction path. They are not parallel units.

### Unit F — Conformance, quality, correction, and Design history

**Builds on:** The current reviewed-artifact, provenance, change-set, and materialization foundation.

**Contract:** Nova verifies accepted intent and workflow quality without changing canonical validity or direct-editor permissions.

**Primary files:**

- new `lib/agent/design/projection/*`
- `lib/agent/design/conformance.ts`
- `lib/agent/design/quality.ts`
- build orchestrator completion/correction modules
- conformance/completion tables
- read-only Design panel

**Work:**

1. Implement deterministic implementation projection and coordinates.
2. Implement exact provenance readers.
3. Implement initial grounded rule set.
4. Implement sequence/digest-bound report storage.
5. Implement fresh-context quality review.
6. Implement finding dispositions and bounded correction slices.
7. Implement completion report and truthful final-message policy.
8. Add read-only Design history surface.
9. Add stale-report projection on later canonical sequences.

**Acceptance:**

- A critical completion blocker has deterministic/source/platform grounding.
- Model-only heuristics cannot be critical.
- Human/MCP edits continue despite stale/absent design.
- A critical conformance issue prevents a false completion message, not app use.
- Correction is an ordinary valid slice.
- Correction loops are bounded.
- External/manual setup is explicit.
- Legacy or unmapped implementation is not falsely source-grounded.

**Reviewer focus:** epistemic honesty and separation from validity.

### Unit G — Design-aware edits and high-level MCP

**Depends on:** Unit F.

**Contract:** Reviewed edits amend intent where needed while direct canonical editors remain unchanged; high-level MCP invokes the same server-owned workflow.

**Primary files:**

- design amendment/recovered snapshot modules
- build edit orchestration
- app-target design-session integration
- MCP high-level adapters/schemas/docs
- edit/rebase/concurrency tests

**Work:**

1. Add `DesignAmendment` and impact review.
2. Add deterministic reconciliation with current app.
3. Add legacy `RecoveredDesignSnapshot`.
4. Add implementation-correction path without contract churn.
5. Add impacted slice planning/conformance.
6. Add high-level MCP workflow tools and request idempotency.
7. Add question/resume behavior for MCP.
8. Preserve direct shared MCP tool paths.

**Acceptance:**

- Edit design sessions own no separate holder/reservation.
- No legacy rationale is fabricated.
- Intent changes produce reviewed revisions.
- Implementation corrections can reuse existing intent.
- Direct MCP tools still commit immediately.
- High-level MCP retries cannot duplicate sessions, runs, steps, or apps.
- Concurrent app changes rebase or return structured conflicts without name guessing.

**Reviewer focus:** authority separation and editor symmetry.

### 19.4 Coding-agent checklist per remaining unit

Before changing code:

1. read root and relevant subtree `CLAUDE.md`;
2. locate all call sites by symbol, not assumed filenames alone;
3. inventory database privileges, Project-move, soft-delete, and runtime probes for every table change;
4. inventory every implementation of the interface being changed;
5. write/lock characterization tests for behavior-preserving refactors.

Before declaring the unit done:

1. run focused tests;
2. run the repository-required full checks;
3. run source/privilege/migration probes;
4. inspect generated migration SQL/constraints;
5. exercise failure and retry paths;
6. update present-state docs;
7. delete obsolete paths/imports/tests;
8. confirm no temporary compatibility code remains.

## 20. Verification matrix

This matrix combines maintained foundation coverage with the acceptance work
for the two remaining units. Sections 20.1–20.16 and 20.18 primarily protect
the current foundation. Section 20.17 is Unit F. The Design-history,
design-aware-edit, high-level-MCP, and final completion assertions in the
browser journey are owned by Unit F or G according to Section 19; they are not
a third delivery unit.

### 20.1 Design schema and artifact integrity

- Every schema accepts and round-trips complete fixtures.
- Unknown keys reject at every persisted boundary.
- Every Design ID is unique and kind-compatible.
- Every reference family is closure-checked.
- Parent-record and navigation cycles reject.
- Selected architecture option belongs to its decision.
- Fact writers/readers/tasks are internally coherent.
- Every explicit in-scope source claim is owned or explicitly deferred.
- Evidence status rules reject unsupported `explicit` claims.
- Critical/important review findings obey basis/evidence rules.
- Every required finding has exactly one disposition.
- Artifact digest changes on any authoritative payload/parent/version change.
- Parent/source/design/plan digest mismatch rejects on read/use.
- Prompt/schema/model metadata is complete.
- Persisted JSON duplicate keys/noncanonical numbers/unknown dialects reject.

### 20.2 Build-plan properties

- DAG is acyclic.
- Exactly one materialization-root slice exists.
- Materialization root has no prerequisite slices and directly owns everything required for the first export-ready app.
- Every non-deferred intent has exactly one owning slice.
- Dependency references do not count as ownership.
- Every acceptance scenario belongs to at least one slice (a corrective slice may carry none — scenarios are contract objects a plan covers, not per-slice inventions).
- Every external action has a stable ID, timing, idempotency, required-for policy, and completion evidence type.
- Exclusive operations occupy isolated slices/change sets.
- Plan design revision/digest matches the accepted contract.
- A contract revision makes the prior plan unusable, not silently current.
- Complexity scoring and budget derivation are deterministic.

### 20.3 Workspace semantics

For canonical and change-set workspaces:

- one invocation receives one immutable snapshot/revision;
- a stale expected revision rejects;
- reads after writes observe the new workspace revision;
- failed writes do not advance the workspace;
- no tool can replace the workspace snapshot directly;
- invocation ordering is explicit;
- two calls cannot commit as the same revision;
- cache eviction/reconstruction yields the same snapshot/digest.

Canonical SA regression:

- injecting branch-specific async delay does not reorder calls;
- future SDK parallel dispatch cannot corrupt or clobber the workspace;
- terminal holder/scope errors fence queued work.

Executor regression:

- an assistant response with two executable calls executes none;
- one-call responses preserve tool-call ID idempotency.

### 20.4 Mutation-host parity

For every shared tool registry entry:

- policy metadata is present and strict;
- required capabilities/read sets are declared;
- canonical host admitted batch equals pre-refactor behavior;
- chat and MCP use the same domain/tool module;
- change-set host stages the same admitted batch for stageable tools;
- nonstageable/external tools reject before side effects;
- original canonical schema re-parse occurs after handle resolution;
- result envelopes and no-op behavior remain equivalent;
- expected organization revision behavior remains equivalent;
- direct persistence/import bypass fails structural tests.

Golden fixtures cover:

- simple batch;
- multi-stage batch;
- no-op proof;
- concurrent stale target;
- lookup-backed field options;
- media attachment;
- organization-dependent automation;
- user/persona/organization shape;
- case-property rename/retirement;
- parked case-value note.

### 20.5 Durable staging idempotency

Fault inject after each statement/operation boundary:

1. request row admission;
2. handle allocation;
3. mutation admission;
4. step insert;
5. stage-range insert;
6. diagnostics calculation;
7. result receipt;
8. change-set revision update;
9. transaction commit;
10. response emission.

Assert:

- a committed request is returned exactly on retry;
- an uncommitted request leaves no partial handle/step/revision;
- same request ID plus different input rejects;
- UUIDs do not change after response loss;
- ordinals are contiguous;
- `next_ordinal` and revision remain coherent;
- two processes cannot invert dependent steps;
- no `applying` limbo survives a transaction;
- request receipts outlive reconnect retry horizon.

### 20.6 Change-set replay properties

Property/fuzz tests prove:

1. Any accepted step sequence replays deterministically from its exact base.
2. Replayed digest matches workspace digest.
3. A stored step is exact admitted canonical mutations.
4. Candidate replay does not depend on handles.
5. Missing base sequence/digest rejects.
6. A private candidate may have validator findings without persistence.
7. Admission failures never enter the log.
8. Introduced/resolved finding identity is deterministic.
9. Amending a rejected boundary preserves prior steps.
10. Superseded/abandoned sets cannot stage or commit.
11. Exclusive sets contain exactly one exclusive semantic command.
12. External-effect capabilities are impossible in the workspace.

### 20.7 External read-set tests

Organization:

- exact revision captured for organization-dependent automation/setup guidance;
- revision drift before commit returns stale read-set or deterministic recomputation according to policy;
- place row writers are unavailable in a change set.

Lookup:

- table/column identity and revision are captured;
- deletion/identity change races serialize or reject opaquely;
- final canonical commit uses fresh locked definitions.

Media:

- attach stages only an asset identity that is available in the Project;
- deletion racing a commit is caught by canonical media locks;
- remove-media remains external and cannot run in private staging.

Project:

- Project move after staging is terminal;
- no cross-Project rebase occurs.

### 20.8 Canonical commit kernel

Characterization/integration tests assert:

- dedup same batch ID/digest returns original sequence/result;
- same batch ID/different digest is terminal;
- fresh Project authorization happens under lock;
- exact chat holder is checked under lock and repeated on write;
- fresh strict app snapshot is used;
- stale target/anchor rejects without prefix;
- lookup locks cover prior/candidate union;
- absolute verdict uses exact context;
- media/organization integrity run before write;
- entity/header/history/reference writes are atomic;
- provenance/change-set sidecars are atomic;
- notification occurs only on commit;
- app-change fold reaches persisted head;
- exclusive rename/retirement retains phase-A atomicity and phase-B convergence;
- transaction retries are free of external side effects.

### 20.9 Cross-target generation admission

Concurrency tests:

- two new design-session claims for one actor;
- new design-session claim racing an app edit claim;
- new design-session claim racing a stale app reaper;
- materialization transfer racing a second claim;
- free continuation racing a superseding chargeable turn;
- actor with live paused run according to current policy;
- out-of-credits and concurrency rejection rollback.

Assert one exact holder/reservation or none, never two.

Verify advisory lock namespace/key stability and collision test vectors.

### 20.10 Run, credit, and finalization

For app and design-session targets:

- chargeable claim books holder/reservation atomically;
- no-op/failed run refunds exactly once;
- successful run settles exactly once;
- month-boundary refund uses booked period;
- reaper exact-holder compare-and-set;
- pause does not appear stale;
- resume requires exact actor/mode/run/nonce;
- stale nonce returns refresh-required;
- holder loss fences all queued tools;
- materialization transfers unsettled reservation once;
- post-transfer heartbeat targets app;
- pre-transfer heartbeat targets session;
- process death at transfer yields one authoritative owner;
- run summary accumulation keeps first/latest/sum field semantics;
- concurrent first summary insert does not drop deltas.

### 20.11 Thread and stream protocol

Run the current transcript test corpus against both target kinds:

- initial thread write;
- stale-client merge;
- completed step barrier;
- log-flush-before-barrier ordering;
- continuation seed extension;
- terminal success;
- terminal pause with retained nonce;
- failed fresh response deletion;
- failed continuation revert;
- claw-back tombstone refuses stale resurrection;
- terminal marker lost/died stream recovery;
- re-drive marker replacement;
- serialize-wait stream liveness;
- bailed-history merge;
- stream append retry idempotency;
- mid-batch cursor read;
- terminal zero-chunk marker;
- retention pruning;
- cross-target/Project authorization;
- materialized session resolving to app;
- lost `data-app-materialized` while transcript/stream continue.

### 20.12 Thread media references

- adding/removing transcript attachments replaces only that thread's edge set;
- two threads in one app do not erase each other's edges;
- pre-app thread references prevent asset deletion;
- Blueprint references and thread references independently prevent deletion;
- Project mismatch is opaque;
- failed transcript write changes no edges;
- physical thread deletion cascades its edges;
- app Project move remaps/retains materialized thread assets according to current media contract;
- source extracts never create asset references without an authorized thread carrier.

### 20.13 Materialization transaction

Fault inject before/after every numbered materialization step.

Assert one of:

- no app row, no entities, no baseline, open change set/session holder retained; or
- one complete sequence-`1` app, exact entities/edges/schema/baseline/provenance, committed change set, materialized session, holder/reservation on app only.

Specific checks:

- proposed app ID collision;
- stale/superseded design/plan/change set;
- source-step corruption;
- lookup/media/organization rejection;
- gate finding;
- export readiness failure;
- runtime case-schema deterministic failure;
- privileged fold-baseline routine failure;
- provenance constraint failure;
- notification/frame loss;
- transaction serialization retry.

Canonical fold from sequence `1` equals stored app and Project.

### 20.14 Runtime schema and index convergence

- Required case-schema rows land transactionally before app activation.
- Schema admission failure aborts materialization.
- Pending index work is durable at commit.
- `CREATE INDEX CONCURRENTLY` never executes inside the materialization transaction.
- Post-commit index success clears pending work.
- Transient failure remains pending and retries/heals.
- Deterministic index/compiler failure is observable and does not corrupt the app.
- Preview/form-submit/sample-data first use sees admitted schema.
- Monotone sequence guards preserve concurrent additive schema changes.
- Exclusive rename/retirement behavior remains unchanged.
- Pending performance indexes do not alter Blueprint validity or completion wording.

### 20.15 Client activation and collaboration

Unit/browser tests:

- strict event-version/key parsing;
- snapshot digest verification;
- duplicate same receipt no-op;
- conflicting digest triggers authorized reload;
- different-app receipt refused;
- no partial store install;
- URL replaces once;
- selection/focus behavior;
- reconciler starts at sequence `1`;
- peer opened before materialization sees no app;
- peer opened after sees sequence `1`;
- later app changes stream normally;
- lost frame recovers from design session;
- reconnect cannot create a second app;
- old `data-app-id` build frame is rejected/absent after cutover;
- explicit blank uses the shared installer.

### 20.16 Orchestrator and executor recovery

- orchestration predecessor uniqueness rejects forks;
- stale holder cannot append an event;
- artifact digest mismatch stops execution;
- active slice attempt uniqueness;
- resume returns stored tool receipts;
- budget exhaustion persists honest failure;
- design issue ends executor loop;
- contract revision supersedes obsolete attempts/change sets;
- commit receipt is the only slice-completed authority;
- model saying “done” without receipt changes nothing;
- no external effect is executed from the executor;
- correction loops honor hard bounds.

### 20.17 Conformance and completion

- projection is deterministic and digest-stable;
- every coordinate resolves or produces a deterministic finding;
- report binds exact app sequence/digest;
- N+1 marks N stale;
- one owning slice per intent;
- names alone do not establish coverage;
- structural scenario checks label their limitation;
- model heuristic cannot be critical;
- source-supported critical finding requires exact evidence;
- platform critical finding requires catalog code/version;
- completion refuses current grounded critical findings;
- `complete-with-external-setup` lists exact outstanding actions;
- `incomplete` leaves the valid app usable;
- direct human/MCP commit does not consult completion.

### 20.18 Migration and runtime probe

- fresh database builds all migrations;
- production-shape upgrade scan passes;
- final constraints validate;
- old app-target rows remain readable;
- privilege convergence matches exact table policies;
- runtime role can execute required locks/writes and no more;
- row-lock source tests cover new append-only tables;
- Project move, soft delete, physical delete, and retention inventories are complete;
- no old schema reader/writer/import remains;
- application starts and probes final artifact JSON schemas.

### 20.19 Browser acceptance journey

1. Start chat build.
   - Design in progress appears.
   - No app card/tree/Preview.
2. Receive/answer a clarifying question.
   - Refresh preserves transcript and question state.
3. Observe reviewed outline.
   - Review status is truthful.
4. Build first workflow.
   - Only coarse progress is visible.
5. Materialize.
   - URL promotes once.
   - First tree is meaningful.
   - Preview runs.
   - No starter flash.
6. Commit later slices.
   - Each appears atomically.
   - Peer sees only commits.
7. Interrupt server at design/review/staging/materialization/later commit.
   - Recovery meets the applicable invariant.
8. Finish.
   - Final wording matches completion report/external setup.
9. Start explicit blank.
   - Minimal app appears immediately without a design session.

## 21. Observability and metrics

The opaque-ID and no-customer-content rules in this section already bind the
current build path. Unit F adds the conformance, quality, correction, and
completion fields; Unit G adds reviewed-edit and high-level-MCP workflow
projections. Each remaining unit supplies the counters and spans for the
behavior it activates, so this section defines the final operational view
without creating another delivery unit.

### 21.1 Correlation model

Every safe log/metric can correlate by opaque IDs:

- `designSessionId`;
- `runId`;
- `orchestrationRevision`;
- `designRevisionId`;
- `buildPlanId`;
- `sliceId`;
- `sliceAttemptId`;
- `changeSetId`;
- `stagingRequestId`;
- `appId` after materialization;
- canonical `seq`;
- batch ID.

Do not log holder nonces, raw source text, raw Design Contracts, model output, mutation payloads, case data, or transcript bodies.

### 21.2 Metrics shape

```ts
interface DesignBuildMetrics {
  designDepth: DesignDepth;

  sourceClaimCount: number;
  sourcePackageBytesProjected: number;

  designCallCount: number;
  designRevisionCount: number;
  designStructuredFailureCount: number;
  reviewCallCount: number;
  reviewFindingCountBySeverity: Record<string, number>;
  reviewFindingCountByBasis: Record<string, number>;
  reviewDispositionCount: Record<string, number>;

  plannedSliceCount: number;
  committedSliceCount: number;
  supersededSliceAttemptCount: number;
  designIssueEscalationCount: number;

  stagedToolCallCount: number;
  idempotentToolReplayCount: number;
  stagingRequestCollisionCount: number;
  staleWorkspaceRejectionCount: number;
  stagedMutationBytes: number;
  committedMutationBytes: number;
  discardedMutationBytes: number;

  changeSetCommitAttemptCount: number;
  changeSetBoundaryRejectionCount: number;
  changeSetRebaseCount: number;
  changeSetSemanticConflictCount: number;
  externalReadSetStaleCount: number;

  materializationAttemptCount: number;
  materializationConflictCount: number;
  activationReloadCount: number;
  timeToFirstMaterializationMs: number | null;

  deterministicConformanceCounts: Record<string, number>;
  qualityFindingCounts: Record<string, number>;
  correctionSliceCount: number;
  redundantIdentityWriterCount: number;

  externalActionCountByOutcome: Record<string, number>;
  completionStatus: "complete" | "complete-with-external-setup" | "incomplete" | null;
}
```

Store aggregate metrics in a design-session/run summary table or safe derived view. Do not put them in `app_changes`.

### 21.3 Timing spans

Record monotonic durations for:

- source projection;
- design agent steps;
- design review;
- design revision;
- build planning;
- per-slice model execution;
- per-stage DB transaction;
- diagnostics;
- change-set commit;
- materialization transaction;
- post-commit index convergence;
- implementation projection;
- conformance;
- quality review;
- client activation acknowledgment when available.

Separate model wait, database work, and external-storage work. A single “build time” cannot diagnose the system.

### 21.4 Safe failure taxonomy

Use stable codes:

- `DESIGN_STRUCTURED_OUTPUT_INVALID`
- `DESIGN_REVIEW_UNAVAILABLE`
- `ARTIFACT_DIGEST_MISMATCH`
- `ORCHESTRATION_FORK_REJECTED`
- `WORKSPACE_REVISION_STALE`
- `STAGING_REQUEST_ID_COLLISION`
- `HANDLE_RESOLUTION_FAILED`
- `EXTERNAL_READ_SET_STALE`
- `CHANGE_SET_REBASE_CONFLICT`
- `CHANGE_SET_SCOPE_LOST`
- `MATERIALIZATION_GATE_REJECTED`
- `MATERIALIZATION_SCHEMA_ADMISSION_FAILED`
- `MATERIALIZATION_TRANSACTION_FAILED`
- `ACTIVATION_DIGEST_MISMATCH`
- `CONFORMANCE_CRITICAL_UNRESOLVED`
- `EXECUTION_BUDGET_EXHAUSTED`

Logs carry code, safe IDs, counts, versions, digests, database error class/code, and finish reason. They do not carry customer content.

### 21.5 Idempotency observability

Track separately:

- healthy duplicate request replay;
- same-ID/different-digest collision;
- canonical batch dedup;
- activation receipt duplicate;
- materialization retry returning existing receipt.

Healthy retry behavior should not page as an error. Collisions indicate protocol defects or abuse and should be high-signal.

### 21.6 Run and credit observability

Extend existing finalize logs with target kind and transfer outcome:

- app vs design-session target;
- reservation created/settled/refunded;
- holder acquired/reacquired/released/superseded;
- materialization transfer committed;
- refund failure/reaper retry;
- summary write action;
- billable model/tool steps by phase.

Never infer charge state from a UI completion frame.

### 21.7 Transcript/stream observability

Safe counters:

- barrier snapshot count;
- chunk-log append retries;
- marker reconciliation;
- resume interrupted;
- claw-back fresh vs continuation;
- tombstone refusal count;
- lost activation frame recovered;
- stream terminal outcome;
- stream target kind.

Do not log message IDs beside content or transcript payloads.

### 21.8 Schema/index observability

Track:

- transactional schema admission success/failure by case-type count;
- pending index-work count/age;
- concurrent index convergence success/transient/deterministic failure;
- point-of-use schema heal;
- parked case-value counts/reasons;
- materialization blocked by deterministic schema admission.

Alert on old pending index work, not on every transient retry.

### 21.9 Operational views

Admin inspection links, under authorization:

```text
design session
  ├─ source package metadata
  ├─ design revisions/reviews/dispositions
  ├─ build plans
  ├─ orchestration events
  ├─ slice attempts/change sets
  ├─ run summaries/usage
  ├─ materialized app + sequences
  ├─ conformance/completion reports
  └─ external actions
```

Default views show metadata and summaries. Access to source pointers/transcripts follows their own authorization and audit rules.

### 21.10 Service-level indicators

Initial SLIs:

- design sessions ending without an app by user choice vs failure;
- successful first-materialization rate;
- duplicate app rate (target zero);
- invalid canonical revision rate (target zero);
- unrecoverable staging request rate;
- activation recovery rate;
- critical conformance at initial completion;
- time to first meaningful materialization by complexity;
- staged-to-committed byte ratio;
- review finding acceptance rate;
- correction round rate;
- pending index-work age;
- refund/reaper failure rate.

Do not set product targets until baseline distributions exist.

### 21.11 Acceptance

- No raw source/design/mutation/transcript content reaches Sentry or general logs.
- Every failure path has a stable safe code.
- One session can be traced across pre-app/materialization/post-app phases.
- Healthy idempotent retries are distinguishable from collisions.

## 22. Security and privacy

### 22.1 Authorization boundary

Every design-session, artifact, review, plan, attempt, change-set, report, thread, stream, and external-action read/write resolves current Project membership through one server-owned scope resolver. A pre-app session additionally requires exact owner identity; a materialized session delegates visibility and write authority to its Project-shared app.

Rules:

- IDs are selectors, never capabilities.
- Missing and foreign-Project IDs return the same opaque shape.
- Project role/capability comes from the fresh server-side membership read.
- Model/tool inputs cannot supply `projectId`, role, holder nonce, or actor authority except where a public request names an expected Project that is freshly reauthorized.
- A materialized session delegates app authority to the app's current Project.
- Project move and membership loss are rechecked at correctness-bearing writes.

### 22.2 Capability separation

Use narrow runtime capability objects:

```ts
interface WorkspaceCapabilities {
  blueprintRead: BlueprintReadCapability;
  blueprintStage?: BlueprintStageCapability;
  canonicalCommit?: CanonicalCommitCapability;
  externalRead?: ExternalReadCapability;
  externalWrite?: ExternalWriteCapability;
  runAuthority: ExactRunAuthority;
}
```

The change-set executor receives no `externalWrite` or canonical direct-commit capability. It receives a change-set commit request capability that still routes through the server-owned boundary.

A TypeScript cast is not a security boundary. Source/import tests and module layout must make forbidden services unavailable.

### 22.3 Untrusted source material

User messages, attachment text, tables, images, labels, filenames, and extracted metadata are untrusted data.

The source projection layer:

- separates source blocks from system instructions with fixed delimiters;
- tells the model that source instructions have no orchestration/tool authority;
- accepts only the typed output schema;
- never includes server secrets, environment variables, holder tokens, or hidden prompts in the source call;
- bounds text/image count and size;
- rejects unsupported/unsafe file forms through the current attachment admission;
- stores normalized claims and source pointers, not full copied documents.

Examples such as “ignore prior instructions,” “call this tool,” or JSON resembling a Design Contract remain evidence text, not commands.

### 22.4 Model privacy

All author/reviewer/planner/executor calls use the repository's current privacy configuration, including `disallowPromptTraining`/provider-equivalent settings.

Do not enable provider-side storage merely to support review independence. Fresh-context review is implemented by Nova's own request construction.

Logs and telemetry never retain raw prompt/output. Structured-output errors are sanitized before Sentry, matching `lib/agent/subGeneration.ts`.

### 22.5 Sensitive data in design artifacts

A `sensitive` or `highly-sensitive` fact definition is metadata about intended app data, not a patient/person record.

Design artifacts must not contain:

- actual case records;
- worker credentials;
- passwords;
- API keys;
- attachment bodies copied wholesale;
- unnecessary names/identifiers from source documents;
- hidden reasoning.

Where an exact label/value is itself a requirement, store only the minimum required text and retain its source pointer.

### 22.6 Attachment and media lifecycle

- Pre-app attachments are protected by exact `thread_media_refs`.
- Blueprint media remains protected by app reference edges.
- Asset deletion checks both reference families transactionally.
- Extraction artifacts inherit Project tenancy and deletion/retention policy from their source asset.
- A source pointer never permits cross-Project asset fetch.
- Model-produced asset IDs are revalidated against current Project availability.
- Discarding a design session removes references according to transcript retention; it does not blindly delete shared assets.

### 22.7 External actions

A model-proposed external side effect cannot execute from a private change set.

External actions require:

- an explicit typed build-plan action;
- server-owned capability and current authorization;
- an idempotency key/input digest;
- required confirmation where destructive or externally visible;
- a durable receipt;
- clear before/after/manual timing.

Media deletion, place row mutation, lookup mutation, deployment, worker provisioning, HQ upload, and other remote actions remain separate authoritative services.

### 22.8 Identity isolation

- `DesignId` is not a Blueprint UUID.
- Change-set handles are not identities outside one private set.
- Handles resolve structurally before original schema and mutation admission.
- Protocol IDs, app IDs, Project IDs, case IDs, asset IDs, and external IDs are never handle slots.
- Canonical UUID collisions reject before staging.
- A model cannot choose `proposed_app_id` or canonical batch IDs.

### 22.9 Integrity and replay

- Every authoritative artifact has a canonical digest.
- Every staging request has an exact input digest.
- Every canonical batch has an idempotency fingerprint.
- Every change set records exact base sequence/digest.
- Every report records exact app sequence/digest.
- Replay never uses a “latest by name” fallback.
- Persisted JSON uses exact canonical parsing.

Digests provide integrity/correlation, not confidentiality; do not expose source-derived digests as a substitute for authorization.

### 22.10 Transaction and retry safety

`withAppTx`/retryable transactions must not perform:

- model calls;
- object-store deletion;
- remote HTTP calls;
- notification side effects outside transactional `NOTIFY`;
- mutable in-memory state that survives a retry.

Prepare all external/non-idempotent work outside, then revalidate and commit only database-safe state. Post-commit work is idempotent and durable where required.

### 22.11 Denial-of-service and cost controls

Bound:

- source size/image count;
- design object counts/string lengths;
- review iterations;
- slice count;
- model steps/tool calls;
- staged mutation bytes;
- change-set steps/handles;
- diagnostics/report size;
- rebase/correction attempts;
- stream retention;
- concurrent active generation per policy.

Reject oversized artifacts before expensive validation/model calls where possible. Charge/refund logic remains tied to actual admitted runs.

### 22.12 Audit and deletion

Audit records identify:

- actor;
- Project;
- design session/run;
- artifact versions/digests;
- slice/change set;
- canonical sequence;
- external-action outcome.

They do not store secret credentials or raw source/model content.

User deletion and operator retention paths document what is removed, retained for app history, or retained for compliance/support. A pre-app session deletion cannot erase an app it later materialized.

## 23. Documentation contract

Documentation describes present behavior and moves in the same unit as that
behavior. It does not preserve rollout history.

### 23.1 Current documentation surfaces

- Root `CLAUDE.md` / `AGENTS.md` map the reviewed design pipeline, build
  orchestrator, slice executor, meaningful genesis, and immediate direct MCP
  editor.
- `lib/agent/CLAUDE.md`, `lib/agent/design/CLAUDE.md`, and
  `lib/agent/change-set/CLAUDE.md` own model, artifact, authority, staging,
  intent-coverage, and commit contracts.
- `lib/db/CLAUDE.md` owns design-session run/credit scope, canonical sidecars,
  materialization, Project movement, and runtime privileges.
- `components/CLAUDE.md` and `components/builder/CLAUDE.md` own pre-app,
  activation, URL recovery, and canonical-only rendering behavior.
- `docs/plans/complex-app/00-contracts.md` binds meaningful/explicit-blank
  genesis, non-executable design/change-set state, external-action separation,
  and direct-editor validity.
- `content/docs/building-with-nova.mdx` explains the current reviewed build,
  designs-in-progress recovery, meaningful first workflow, later-slice
  recovery, explicit blank path, and external prerequisites in user language.

Stable `file::symbol` references are used instead of line numbers. Ordinary
help never exposes holder nonces, transaction sidecars, admitted mutations, or
private change-set handles.

### 23.2 Unit F documentation

Unit F updates the design/agent/database/builder contracts with deterministic
projection, report freshness, correction authority, and Design history. Public
documentation adds the Design panel, assumptions, review results, conformance
status, and external setup only when those surfaces exist. Operational docs add
report inspection and correction fault codes.

### 23.3 Unit G documentation

Unit G updates the agent/build/MCP contracts with amendments, recovered legacy
snapshots, app-target design sessions, high-level workflow idempotency, and
question/resume semantics. MCP reference and narrative guides clearly separate:

- immediate direct canonical mutation tools;
- explicit blank `create_app`;
- high-level reviewed workflow tools;
- artifact/report getters;
- the deliberate absence of a generic public staging transaction.

The copied `nova-plugin` documentation changes in the same PR whenever Unit G
changes a model-visible MCP contract.

### 23.4 Documentation verification

Source tests continue to pin registry policy, forbidden imports/effects,
target-union writers, privilege/Project-move/delete inventories, removal of old
build paths, and no-content logging. The program is complete only when code,
contracts, subtree docs, public docs, operational docs, MCP reference, and the
plugin describe the same end state.

## 24. Definition of done

The program is complete only when all of the following are true.

### Canonical validity and history

1. Every persisted Blueprint revision passes the existing absolute whole-document gate.
2. Every mutation-bearing app change contains the exact admitted canonical mutation value.
3. Every sequence-`1` app has one complete immutable Project-bearing fold baseline.
4. Canonical fold replay reaches the persisted app head.
5. Preview, export, deployment, peers, and collaboration streams observe only canonical revisions.
6. No completion/review operation changes an app from invalid to valid.

### Design and review

7. A typed evidence-linked Design Contract is produced for chat builds.
8. Source material is treated as untrusted data.
9. Review is a fresh-context structured call with no author reasoning.
10. Every critical/important finding has valid grounding and one disposition.
11. Accepted artifacts are immutable, digest-bound, strict-parsed, and versioned.
12. Failed/unavailable review never becomes “reviewed.”

### Planning and execution

13. Every non-deferred intent has exactly one owning slice.
14. Exactly one materialization root exists, has no prerequisite slices, and directly owns everything required for the first export-ready app.
15. External actions are typed, idempotent, and separately receipted.
16. The executor receives one immutable slice brief and one private workspace.
17. One executor step executes at most one tool call.
18. Staging requests are durable/idempotent across lost responses and process death.
19. Local handles resolve before original tool-schema and mutation admission and never enter canonical history.
20. Open change sets may be incomplete but never executable or user/peer visible.
21. Boundary rejection is corrected by appending steps, not resending successful payloads.
22. External-effect tools are impossible in an open change set.
23. Every executor/review/rebase/correction loop has a hard bound.

### Canonical commit parity

24. Shared tools use a workspace/host without caller-owned `prevDoc`.
25. Canonical chat, MCP, and builder behavior remains equivalent to the pre-refactor path.
26. Change-set commit reuses the canonical transaction kernel.
27. Dedup, fresh Project authorization, exact holder, lookup locks, media, organization integrity, exclusive case-store work, entity/history/reference writes, and notification order are preserved.
28. A commit retry cannot duplicate a canonical batch.

### Pre-app run and conversation

29. A chat build can converse, review, pause, stream, bill, recover, and retain attachments without an app row.
30. Cross-target generation admission is atomic for one actor.
31. Target-polymorphic thread behavior preserves barriers, terminal seals, claw-back, tombstones, re-drive, and resume cursors.
32. Thread media references are exact and separate from Blueprint media references.
33. Credit reservation/refund/settle and run summaries remain exact across target kinds.
34. Edit design sessions do not own a second holder/reservation.

### Materialization and activation

35. A conversational build creates no app before a meaningful valid slice exists.
36. The first chat-built revision is meaningful, export-ready, and sequence `1`.
37. Materialization yields no app or one complete app at every failure point.
38. Required runtime case-schema state exists before activation.
39. Concurrent index work is durable post-commit convergence and never validity.
40. Holder/reservation transfers exactly once from design session to app.
41. The strict activation receipt is digest-bound and idempotent.
42. Losing the activation frame cannot duplicate or orphan an app.
43. The app tree never flashes a generic starter.
44. Explicit blank creation remains immediate and produces the minimal Survey/Form/Question app.

### Conformance and completion truth

45. Implementation projection/conformance is deterministic and sequence-bound.
46. Model-only heuristics cannot be critical blockers.
47. Grounded critical conformance findings prevent a false completion claim but not valid app use.
48. Structural scenario evidence is not reported as full runtime proof.
49. Correction is another ordinary valid slice and is bounded.
50. External/manual setup is named honestly.
51. Human/direct MCP edits remain valid when design metadata is absent or stale.
52. Legacy apps never receive fabricated historical rationale.

### Persistence, delivery, and operations

53. Database constraints reject impossible target/status/holder combinations.
54. New tables are covered by runtime types, exact JSON parsing, privileges, probes, Project move, delete, and retention inventories.
55. Cross-Project identifiers are opaque.
56. No raw source, transcript, Design Contract, mutation payload, or model reasoning is written to general logs/Sentry.
57. Transaction retries cannot duplicate external effects.
58. Migration/cutover uses one final shape with no dual reader/writer or feature flag.
59. Current-state contracts, subtree docs, public docs, operational docs, and MCP reference agree.
60. The implementation deletes obsolete early-app and old build-event paths.
61. A coding agent can trace every unit to exact files/symbols, invariants, tests, and acceptance gates in this plan.

## 25. Final product principle

> **Valid revisions, reviewed intent.** The canonical Blueprint is always fully valid. Design alternatives, assumptions, user journeys, data provenance, read models, access decisions, and external dependencies live in a typed non-executable Design Contract that is independently reviewed before construction. The accepted design is implemented as task-complete Build Slices inside private Atomic Change Sets. Each slice becomes visible only when the existing absolute gate and canonical transaction kernel accept it as one revision. Review can improve the experience through further valid revisions, but no finishing operation is ever required to make the app valid.

The authoring corollary remains:

> **CommCare's module → form → field hierarchy is the output grammar, not Nova's design method.**

The implementation corollary is:

> **Private incompleteness is a replayable compiler workspace, not a second app state.**

The authority corollary is:

> **Models propose typed artifacts and tool requests; locked server state decides ordering, scope, persistence, and completion.**

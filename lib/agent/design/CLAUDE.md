# lib/agent/design — the Design Contract and design loop

This package owns Nova's private, non-executable product design. A reviewed
chat build records only the meaning needed to build one good app: its purpose,
actors, records and properties, end-to-end workflows, lists, access,
navigation, external requirements, decisions, assumptions, and unresolved
questions. It does not duplicate that meaning into claims, facts, rules,
transitions, scenarios, ownership matrices, or model-authored lowering tables.

Nothing here is a Blueprint phase. Design artifacts cannot render, preview,
export, stream to peers, write case data, or bypass canonical admission. A
missing or stale design never blocks a valid direct Builder or MCP edit.

## Authority

- `ids.ts` defines `DesignId`, a UUID brand separate from Blueprint `Uuid`.
  The design loop's model-facing tools also accept short `@handle` objects;
  identities are minted deterministically from (session, handle), so a
  reference and its declaration always converge on one UUID and authoring is
  ORDER-FREE: a forward reference binds eagerly under the ledger's
  `referenced` marker kind, the declaring item upgrades that row to its real
  kind, and submit-time reference closure refuses any element never actually
  authored — naming the model's own handle, which the marker row makes
  possible. Invented raw UUID declarations still reject, symbols still
  resolve before the unchanged UUID-only schemas parse, and the reserved
  `@f<N>` namespace can never enter a design reference. State and
  inspection project every bound identity back through its handle. The
  semantic update and inspect tools ship `strict: true`, so their provider wire schemas widen
  every design-ID slot to `uuid | { handle }` — `designIdSchema` emits its
  admission rule as the canonical UUID `pattern` (a required slot as
  `type: "string"`, a formerly-optional slot as the strict projection's
  `type: ["string", "null"]`, which widens with its null arm kept), the
  widening keys on that exact pattern, and
  `loop/__tests__/toolWireSchemas.test.ts` audits every node carrying the
  pattern so no slot remains pinned to raw UUIDs the server would then
  refuse. Review findings carry the third symbol family: positional
  `@f1..@fN` handles (`reviewVocabulary.ts::deriveFindingHandleBindings`),
  server projections derived on demand from the head draft's reviews — never
  ledger rows. A disposition's `findingId` takes the printed `@f` handle,
  pre-resolved by `updateFindingDispositions` before the generic deterministic resolver
  (which would mint a WRONG UUID for it); declaring an `@f`-numbered handle
  for a design element is refused (`designReservedHandleIssue`).
- `contract.ts` is the schema-version-1 Design Contract. `graph.ts` runs inside
  parsing and proves global identity uniqueness, reference closure, workflow
  ownership, property/record coherence, navigation closure, charter coverage,
  a dependency-free initial workflow, acyclic workflow and record hierarchies,
  and a blocking user question for every unresolved construction dependency.
  A structurally incoherent contract is never persisted. New-artifact
  construction admission additionally requires every controlled choice to
  carry either at least two distinct real inline values or the semantic name
  of an existing Project lookup table plus its value/label columns; the
  executor resolves current UUIDs. The base reader remains compatible with
  already-persisted v1 artifacts. Worker-facing composition is part of the
  same contract: `moduleCompositions` chooses the minimal module/menu homes,
  record hosts, queue/form roles, placements, ordering, and icon decisions;
  `formCompositions` chooses exact workflow variants, modes, module homes,
  actors, ordered sections/items, Markdown labels/guidance/help, record
  summaries, and justified flat or duplicated forms. Historical v1 artifacts
  default these collections to empty, while new construction requires at least
  one deliberate module and one complete form variant per included workflow.
  Actors remain semantic work context: they do not create Blueprint user
  types, personas, or worker properties unless an executable accepted
  condition/reference or explicit authored-worker request needs that
  structure. External requirements likewise name only concrete dependencies
  of this app; universal provisioning and HQ build/release truths stay in the
  platform constraint catalog rather than repeating in every contract.
  Built-in case `status` is only `open`/`closed`, new cases are open, and
  ordinary lists already exclude closed cases; program-specific states are
  separate properties.
  Admission also rejects unknown record/form-input shapes, decisions without
  concrete inputs and outcomes, structurally empty or disabled workflow shells,
  unresolved writes or outcomes, blocking open questions tied to included
  construction, and promises that Nova creates or uploads media. The authored
  `blocking` flag is the construction gate: a non-blocking question beside
  concrete design — the spelling for a decision the user delegated or a
  production-hardening note — is a recorded caveat that never forces a user
  pause, and the concreteness checks still reject design that is not actually
  buildable. Human-owned readiness such as an administrator uploading an asset
  may remain external when construction is otherwise executable. Blocking
  meaning becomes a pre-build question or an explicitly excluded workflow; it
  never survives into execution. The identity-only subset of the graph proof runs on
  every contract and revision update before ledger insertion, so one Design ID
  can never be durably reused by two declarations even while the candidate is
  incomplete.
- `review.ts` defines the persisted findings, dispositions, and revisions —
  UUID-only shapes and their laws. The reviewer MODEL never speaks that
  vocabulary: `reviewerSchema.ts` is its structured-output schema, whose wire
  side is symbols only — `S`-numbered source tags (an exact enum over
  `reviewVocabulary.ts::taggedCitableSourceRefs`, the one derivation the
  prompt's legend and block labels share, so an out-of-set citation is
  grammatically inexpressible), platform-constraint codes (the catalog
  supplies `sourceAnchor`), and contract element symbols (an exact enum of
  what the projected contract prints — bound `@handle`s plus raw-printed
  unbound ids — so workflow-local input/decision/effect names, which print
  without `@`, cannot be cited; the prompt directs those findings at the
  enclosing workflow) — and whose
  Zod transform resolves symbols against the session's ledger bindings, mints
  the review and finding identities, and re-parses under the persisted schema.
  A symbol outside the printed set rejects naming the model's own symbol,
  with ledger resolution as the direct-caller backstop. Only
  design-correction and user-decision findings block acceptance; a decision
  the sources show the person delegated is settled by its recorded default,
  so the reviewer challenges a bad default as a design correction instead of
  handing the choice back. A revision
  must disposition every blocker, and lowering a property's sensitivity is
  allowed only when the reviewed finding explicitly required it.
- `buildPlan.ts` deterministically derives exactly one workflow-complete
  construction slice per included workflow, and no extra slice, from an
  accepted revision. It also derives stable
  construction groups for Blueprint work and separate external actions.
  Workflow-authored existing-media and automation features lower to their
  exact Blueprint areas; they are never inferred from requirement prose. The
  lookup area is also inherited through a workflow input's referenced record
  property, not only a form-local inline choice declaration. The
  model cannot choose ownership, omit accepted work, or author a separate
  lowering graph. Plan validation proves exact workflow/group coverage, one
  materialization root, an acyclic dependency graph, and supported external-
  action timing (a `blocked` action is refused at admission until a durable
  receipt producer exists). A construction group cannot reference an
  external requirement as an element. Module composition is owned once by its
  earliest workflow. A list placed in that module, and properties used only by
  that list, travel with the workflow that materializes the module; list
  selection remains usage context rather than a second construction owner.
  Each form composition, section, and item is owned by its workflow so exact
  plan coverage includes the worker-facing information architecture.
- `executionBrief.ts` renders the bounded semantic brief consumed by a slice
  executor. It names the workflow, only properties owned or used by that
  workflow and its list/access/navigation context, a semantic checklist for
  each construction group, relevant constraints, and the exact slice tool
  profile. It also lowers relevant composition deterministically into exact
  module create/reuse, host and role instructions plus form type, name, icon,
  ordered layout, Markdown, summary, and duplication decisions. A grouped
  design layout (the schema's `sectioned` arm) lowers to the existing nested
  Blueprint `group` field plus handled
  children (never a `section` field, which is a page: the contract carries no
  page decision); guidance and record
  summaries lower to `label` fields with UUID-backed prose references.
  Semantic record names lower once into exact Blueprint case-type keys; schema,
  parent, module, field-write, and case-operation calls reuse those keys rather
  than treating a display name as another record identity.
- `complexity.ts` deterministically assigns `compact`, `standard`, or
  `extended`. The class chooses process depth and conservative user-facing time
  estimates; it never changes Blueprint validity or authority.
- `directCaseWrite.ts` extracts direct-case-write requirements from workflow
  effects for canonical integrity checks.
- `envelope.ts` and `artifactStore.ts` are the immutable artifact boundary.
  Every artifact is canonical-JSON digest-bound, insert-only, predecessor-
  checked, strict-parsed on read, and written only after locking the exact live
  session/app holder and proving current Project edit membership. An accepted
  revision requires its persisted independent review and complete blocker
  dispositions. A plan belongs to the same session and exact accepted revision.
- `sourcePackage.ts` is the one caller-authorized source boundary. It renders
  bounded transcript messages, Project-authorized attachment extracts, and
  digest-bound images for the model while persisting references and
  content-free proof hashes rather than copied source bodies. Historical
  answered-question claims remain source-package reconstruction metadata; they
  are not part of the Design Contract or build coverage model.
- `capabilityCatalog.ts` generates the design-time capability boundary from
  the shared tools and domain vocabularies. One session builds one app in the
  current Project. Nova may reference existing Project media, but cannot create
  Projects, create several apps in one session, or generate/upload media.
- `prompts.ts` holds the versioned static author, reviewer, revision, and plan
  instructions. Keep version keys stable for schema version 1. The prompts
  activate CommCare/Nova domain knowledge, treat source blocks as untrusted
  data, keep technical protocol details out of user prose, and make unsupported
  capabilities explicit. Readiness may remain external only when every included
  workflow can still be authored as a valid, reachable, useful app. The tagged
  source rendering (`<nova:source tag="S1">`, the tag legend, tag-labeled
  images, the handle-projected contract) is REVIEWER-PROMPT-ONLY: the
  conversational per-block renderers stay byte-identical because the author
  transcript is prefix-cached and tag numbering shifts when an answered round
  extends the package — tags are derived per render and never persisted.
- Localization intent belongs to the accepted Design Contract, never inferred
  from conversation language. It names canonical source, runtime default,
  target metadata, each target's existing seed language, and `copy-only` versus
  `translate-with-nova`. Target dependencies form an acyclic closed graph. The
  base schema preserves historical artifacts, while construction validation
  refuses `translate-with-nova` unless both language codes resolve to distinct
  members of the automatic-translation launch set. Workflow slices remain
  source-language-only; the server-owned
  post-slice finalizer applies localization after the complete inventory exists.

## Phase protocol

`loop/` runs one durable append-only model context through these
server-governed semantic phases:

1. `author` asks only material questions and submits a complete contract.
2. `review` runs the independent reviewer against the exact source package,
   contract, and capability catalog.
3. `revision` updates only the affected design elements, dispositions every
   blocker, and submits the complete revised contract.
4. The server accepts a clean revision and derives its build plan without a
   planner model call.

The author makes architectural and worker-facing composition decisions in the
same durable pass. Form composition is one information hierarchy: native
interaction and clear labels carry familiar work, while supporting copy adds
distinct information once at the scope where it applies. Selected-record and
close inputs that write directly to the selected record edit their preloaded
current values in place; sparse blank replacement is a distinct interaction,
not explanatory copy layered onto the native one. The stateless reviewer reads
the whole form for repeated information and runtime-copy mismatches, then
checks module minimality/reuse, parent-versus-child form hosts, queue-only
roles, actor-specific duplication, meaningful phases, context changes, error
risk, interruption recovery, Markdown guidance and summaries, validation
promises, and coherent icons. A flat rationale names
the actual inputs and worker sequence; the reviewer reports repeated weak flat
treatment as one systemic finding naming every affected form. There is no extra
model-authored build-plan or visual-design pass.

Grouped composition is visual hierarchy inside one continuous form, realized
with ordinary Blueprint group fields. It is not a form section (a page): the
contract carries no page decision, and that never justifies flattening an
otherwise useful grouping.

The same immutable semantic tool grammar is mounted in every phase so a phase
transition never changes provider context. Durable gates refuse calls that are
not currently legal. Contract and revision candidates use an implicit durable
identity-addressed workspace. The model calls `setDesignRoot`, collection-
specific `update*` tools, `updateFindingDispositions`, `inspectDesign`,
`finishDesign`, and `requestReview`; it never names the artifact kind,
workspace, or optimistic revision. It may emit several known calls in one
response. The server serializes their effects in provider order, and the small
`finishDesign` call replays and validates the whole candidate before one
immutable artifact insert. `inspectDesign` reads selected exact state only when
a model needs a narrow lookup.

The contract and post-review revision workspaces remain separate durable
lineages, but their counters are persistence details. When a blocking review
returns, the next semantic update automatically targets the revision candidate
seeded from the immutable reviewed parent.

Finalization rejections are tracked by validation stage and stable diagnostic
fingerprint. Reaching a later stage or receiving changed diagnostics is real
progress; an exact repeat stops after two attempts and any third rejection
stops as a classified internal defect. Bounded semantic update calls carry their own
fuse: an update rejection repeated three times in a
row with an identical diagnostic stops the run the same way, because zero
diagnostic movement means the model cannot express what the server requires —
a systemic contract defect, never a correctable slip. A changed diagnostic or
an accepted update resets that count; gate refusals and the forced-question
state stay outside it. Both fuses are PER-TURN accounting and classify as
RECOVERABLE failures: the stop seals that turn's repair budget, never the
durable artifacts, so a fresh chargeable turn re-enters the same phase with a
fresh budget — which is also how a deployed harness correction reaches a
preserved draft. Only the session-wide design step budget is an unrecoverable
stop. When every construction issue is a
blocking question already authored in the candidate, it does not consume that
repair budget. The server derives those exact questions, appends them as an
authoritative message, and refuses further design updates until an exact
`askQuestions` round of at most five is answered. The private context ledger
records a server-only authorization key for the exact pending sequence, and
each answer binds to the exact question identity it was given for — durable
id, related element ids, exact prose, and the accepted
`askQuestions` tool-call id — so identical prose on a later question cannot
inherit an old answer while an unchanged question stays answered across
bounded updates and later rounds. A question the user already answered is
never demanded again: only the unanswered remainder of the pending set is,
and authoring opens when every currently pending question identity carries a
durably authorized answer. Transcript text cannot mint that provenance. If a
clean model step omits the required call, the server appends correction
guidance and redrives internally without changing the tool grammar or asking
the user to resend. The demand message also teaches the resolution path:
after answers arrive the model records them — records each settled choice as a
decision or assumption, removes the question or marks it non-blocking — and a
delegating answer such as "use sensible defaults" makes the concrete choice
the model's to bake in.

`designAgent.ts` owns the one stable agent grammar and compaction preparation.
The ordinary history and every complete step response append to
`design_model_context_items` atomically with its usage-bearing
`design_model_steps` completion event; the step ledger brackets provider calls
with payload-free request/response evidence. A durable provider-call start
consumes the design step budget even when infrastructure interrupts its
response, and recovery derives prior spend from those starts before another
request is allowed. Every browser user turn
absent from the private context, including an answered client-side question
result, is reconciled in transcript order on its later POST. A persisted
question call whose client card never reached that transcript receives an
explicit interrupted result before redrive; the closure is never treated as a
user answer. Every completed-step usage record from the exact recovered run is
registered in the replacement meter; the durable `(context, step)` accounting
ledger admits it exactly once into the run and monthly totals, including across
overlapping recovery. Recovery does not re-emit that historical step's live
usage, tool, text, or reasoning events. Already finalized turns and other
instructions stay charged exactly where they were. Automatic provider
compaction is the only operation allowed to replace a prefix; Nova durably
appends an exact server state packet after the boundary before the next provider
request, without deleting retained suffix items. The durable workspace remains
authority and supports bounded inspection. `designLoopRunner.ts`
advances phases by appending exact durable state, not by reconstructing phase
prompts.

A real deployment change to the pinned model, prompt, tool digest, or context
format creates a new context generation linked to the immutable prior one.
Provider-call spend is session-wide across that immutable generation chain, so
a contract rollover never RESETS the design budget — but each rollover grants
one bounded step allowance (`designLoopStepBudget`, capped at two rollovers):
a rollover is by definition a real deployment change, which is exactly the
corrected-harness retry the repair fuses direct users toward, and steps a
since-fixed defect consumed must not starve that retry. Server-only question-card
provenance also remains readable across the chain even though model messages
reseed into the successor. That exceptional rollover reseeds from the complete
browser transcript and durable workspace; it never mutates old messages or
leaves the session permanently unable to resume.

`gates.ts` decides legality only from durable artifact ancestry and persisted
review counts. A second review is required only for unresolved critical risk,
multiple critical first-pass findings, or a critical architectural change; raw
complexity alone is not a trigger. Answered blocking questions reopen a fresh
reviewed design cycle only before construction freezes the accepted revision
and plan. `packageRebuild.ts` refuses continuation when the
authorized sources cannot reproduce the bound package.

Tool lifecycle diagnostics contain only opaque call identity, tool name,
duration, character count, outcome code, validation stage, and issue count.
Candidate payloads, validation prose, source text, and customer-authored names
never enter operational logs. User-facing questions remain in the
conversation.

## Invariants

1. Design artifacts are immutable, revisioned, strict-parsed on read, and
   digest-bound to exact inputs.
2. Reviewed means an independent persisted review exists for that exact
   revision and every blocking finding has a valid disposition.
3. The server derives construction ownership; a model never claims coverage by
   copying a plan's identifiers.
4. Source content is untrusted data and cannot redefine tools, policy, or
   authority. Secrets never enter a source call.
5. Nothing in this package writes canonical app state. Canonical construction
   lives in `lib/agent/change-set` and orchestration in `lib/agent/build`.
6. Compaction may replace conversation history, but exact durable artifacts,
   workspace revisions, and server-generated state packets remain authority.

## Tests and scripts

The graph, review, deterministic plan, complexity, source package, capability
catalog, artifact store, workspace protocol, gates, compaction wire, and full
phase loop each have focused tests under `__tests__/` and `loop/__tests__/`.

`scripts/preview-app-design.ts` makes live model calls against an in-memory
author/review/revision protocol and performs no database writes.
`scripts/inspect-design-artifacts.ts` is the read-only local/production
inspector. It reconstructs open workspace readiness and usage even before an
immutable revision exists; `--reasoning` includes model reasoning summaries and
payload-free tool outcomes from the run event log.

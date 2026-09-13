# lib/agent/design — the Design Contract and design loop

This package owns Nova's private, non-executable product design. A reviewed
chat build records only the meaning needed to build one good app: its purpose,
actors, records and properties, end-to-end workflows, lists, Project-data
tables and their uses, access, menus and forms, external requirements, decisions,
assumptions, and unresolved questions. It does not duplicate that meaning into
claims, facts, rules, transitions, scenarios, ownership matrices, or
model-authored lowering tables.

Nothing here is a Blueprint phase. Draft and review artifacts cannot render,
preview, export, stream to peers, write case or Project data, or bypass
canonical admission. After a clean review, the server-owned lookup materializer
consumes the exact accepted contract before Blueprint construction; it is not a
model tool or a draft side effect. A missing or stale design never blocks a
valid direct Builder or MCP edit.

## Authority

- `ids.ts` defines `DesignId`, a UUID brand separate from Blueprint `Uuid`.
  The design loop's model-facing tools also accept short `@handle` strings;
  identities are minted deterministically from (session, handle), so a
  reference and its declaration always converge on one UUID and authoring is
  ORDER-FREE: a forward reference binds eagerly under the ledger's
  `referenced` marker kind, the declaring item upgrades that row to its real
  kind, and submit-time reference closure refuses any element never actually
  authored — naming the model's own handle, which the marker row makes
  possible. Invented raw UUID declarations still reject, symbols still
  resolve before the unchanged UUID-only schemas parse, and the reserved
  `@f<N>` namespace can never enter a design reference. State and
  inspection project bound identities back through their names.
  `identityProjection.ts` walks schema-declared identity slots for both author
  and reviewer; literal text is never rebound, even when it equals a name or UUID. The
  semantic update and inspect tools ship `strict: true`. Their provider grammar
  widens explicitly marked DesignId slots to `uuid | @name`, keeping the
  null arm where the slot was optional. The `x-nova-design-identity` marker is
  consumed before provider serialization; Project lookup, source and media
  UUIDs retain their own canonical identity semantics even in same-named slots.
  `loop/__tests__/toolWireSchemas.test.ts` admits complete payloads through an
  independent JSON Schema validator and the actual canonical parse seam.
  Review findings carry the third symbol family: positional
  `@f1..@fN` handles (`reviewVocabulary.ts::deriveFindingHandleBindings`),
  server projections derived on demand from the head draft's reviews — never
  ledger rows. A disposition's `findingId` takes the printed `@f` handle,
  pre-resolved by `updateFindingDispositions` before the generic deterministic resolver
  (which would mint a WRONG UUID for it); declaring an `@f`-numbered handle
  for a design element is refused (`designReservedHandleIssue`).
- `contract.ts` owns the one Design Contract vocabulary. The server sets
  `schemaVersion: 2`; authors do not supply format metadata. Current readers
  verify sealed bytes and parse only the current schema. Obsolete private
  sessions are retired by the separate [format cutover](../../../docs/architecture/design-format-cutover.md),
  not converted on read. `graph.ts` runs inside
  parsing and proves global identity uniqueness, reference closure, workflow
  ownership, property/record coherence, menu closure, charter coverage,
  a dependency-free initial workflow, acyclic workflow and record hierarchies,
  and a blocking user question for every unresolved construction dependency.
  A structurally incoherent contract is never persisted. New-artifact
  construction admission additionally requires every controlled choice to
  carry either at least two distinct real inline values or one canonical lookup
  source. An existing source names current table/value/label UUIDs; a designed
  source names the exact table and columns by DesignId. Catalog display names
  let the author find an existing resource; the stable identities returned
  beside those names are what the contract retains. The accepted source
  reference survives planning and the execution brief unchanged. A private
  server boundary resolves a designed reference immediately before the shared
  tool parses it and reverses canonical lookup carriers in read results, so the
  executor never sees or manages the materialization mapping. Every created or
  changed row set carries bounded source references and
  a summary of what establishes its exact values; the graph, construction gate,
  and reviewer refuse invented or ungrounded Project data. Worker-facing
  composition is part of the
  same contract: `moduleCompositions` chooses the minimal module/menu homes,
  optional one-tier parent menu, record hosts, queue/form roles, placements,
  ordering, and icon decisions. Access policies target these same compositions;
  there is no second navigation collection to author or keep in sync.
  Parents precede their contiguous child block,
  a child cannot parent another composition, and its construction owner is the
  same as or later than its parent's owner. Sibling menu order is independent
  of construction-owner order;
  `formCompositions` chooses exact workflow variants, modes, module homes,
  actors, ordered sections/items, Markdown labels/guidance/help, record
  summaries, and justified flat or duplicated forms. Construction requires at least one deliberate module and
  a complete form variant for each task that captures answers or changes records.
  A read-only task can instead use placed lists and details that show every
  requested property to each actor. Searchable but hidden values do not qualify.
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
  `blocking` flag is the construction gate for every current-contract question,
  including questions about app prerequisites, decisions, or assumptions. Graph
  admission includes all declared workflows and resolves question targets;
  removing an excluded workflow also removes or resolves its blocking questions.
  A non-blocking question beside
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
  side is symbols only — stable source labels (an exact enum over
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
- `buildPlan.ts` deterministically derives construction slices covering every
  included workflow from an
  accepted revision plus its exact lookup materialization receipt. It also
  derives stable
  construction groups for Blueprint work and separate external actions.
  A read-only task with no separately owned construction joins the last
  prerequisite's existing group. Its workflow element remains in the plan and
  its requirements, records and external setup remain in the execution brief;
  it requires neither a dummy form nor an empty executor slice. Read tasks that
  own construction still receive their own slice. Committed receipts remain
  nonempty and cover the complete deterministic plan.
  Workflow-authored existing-media and automation features lower to their
  exact Blueprint areas; they are never inferred from requirement prose. The
  lookup area is also inherited through a workflow input's referenced record
  property, not only a form-local inline choice declaration. The
  model cannot choose ownership, omit accepted work, or author a separate
  lowering graph. New-plan admission compares the complete slices and external
  actions with the deterministic projection of the accepted contract, including
  identities, names, goals, ordered ownership, areas, dependencies and risk.
  Plan validation also proves one
  materialization root, an acyclic dependency graph, and supported external-
  action timing (a `blocked` action is refused at admission until a durable
  receipt producer exists). A construction group cannot reference an
  external requirement as an element. `constructionOwnership.ts` supplies the
  same workflow order and module ownership to graph admission and planning.
  A form-only home belongs to its first form's workflow. A home with an accepted
  list can be created before its forms: a child is scheduled after its parent
  selection exists and no later than a parent-menu workflow that creates its
  records. Its list and list-only properties travel with that owner; its later
  forms retain their own workflows. Authored workflow membership stays unchanged.
  Ownership is fixed from semantic workflow order before construction dependencies
  are sorted. Each form depends on its module owner; parent placement, parent
  selection and child writers supply the other dependencies. Graph admission
  rejects construction cycles and any prerequisite for the initial workflow.
  A module whose parent has a different owner gains that
  exact owner workflow as a prerequisite; sibling position adds no dependency;
  same-slice construction keeps
  the parent first and requires that owner to carry the parent's own form or
  case-list surface. The executor creates a form-and-queue home as a viewer
  when none of its forms belong to the current slice. Shared form creation
  converts it to a form-bearing module atomically when its first menu form is
  added, using the same mutation preparation as Builder. Selection
  is owned by the module composition, including a form-host module that uses
  only its default Results screen; it never needs a synthetic WorkList. Its
  explicit one/several setting names every selected-record/close workflow
  affected by that module, including same-record child consumers beneath a
  queue-only parent. Planning makes the latest affected workflow depend on
  the others and lowers one deterministic selection realization for each
  affected module only after all relevant forms exist. That final workflow may
  receive `configureCaseSelection` without receiving the rest of the case-list
  tool family; an earlier module creation never enables several-case selection
  while a later affected form is still absent.
  Explicit entry-point intent is owned by module/form composition: optional
  `entryPoint` and module `caseListEntryPoint` carry an optional external `id`,
  with `ignoreDisplayConditions: true` available only on forms. Absent stored
  slots stay absent. The compiler reserves explicit IDs before generating
  collision-free defaults from destination names. The last workflow owns all
  entry-point realization and depends on every earlier workflow, so navigation
  topology and selection consumers exist before endpoints are enabled. Endpoint
  form creation uses a deterministic `@form_<DesignId>` handle, inherited through
  the existing private plan handle table. The final brief authorizes only the
  entry-point tool family needed there; `finishWorkflow` proves exact bound
  destination, external ID, visibility behavior, missing coverage, and extra
  endpoints against that accepted inventory.
  Each form composition, section, and item is owned by its workflow so exact
  plan coverage includes the worker-facing information architecture.
- `executionBrief.ts` renders the bounded semantic brief consumed by a slice
  executor. It names the workflow, only properties owned or used by that
  workflow and its list/access/navigation context, a semantic checklist for
  each construction group, relevant constraints, and the exact slice tool
  profile. It also lowers relevant composition deterministically into exact
  module create/reuse, host, parent/preceding-sibling placement, and role
  instructions, plus the exact default/create/configure action for semantic
  module selection. Each module composition lowers from its DesignId to one exact
  `blueprintModuleHandle` in the existing private change-set handle vocabulary,
  so equal display names and record hosts never become identity. Form
  instructions carry type, name, icon,
  ordered layout, Markdown, summary, and duplication decisions. A grouped
  design layout (the schema's `sectioned` arm) lowers to the existing nested
  Blueprint `group` field plus handled
  children (never a `section` field, which is a page: the contract carries no
  page decision); guidance and record
  summaries lower to `label` fields with UUID-backed prose references.
  Semantic record names lower once across the complete accepted catalog into
  distinct, bounded Blueprint case-type keys. Collisions receive the full record
  UUID suffix, including when another display name resembles a generated key;
  this mapping is independent of catalog order. Schema,
  parent, module, field-write, and case-operation calls reuse those keys rather
  than treating a display name as another record identity. Every newly owned
  case module also carries one exact `requiredInitialResultsColumn`, a visible
  plain `case_name` column derived from its host record. This compiler input
  makes the module's birth call valid without turning Results into form fields.
  External prerequisite guidance selects named capability entries: media upload
  for media references, worker/resource provisioning for users or organization
  shape, and person-operated HQ deployment for a linked deployment requirement.
  The executor admits module creation, reuse, forms, updates, and moves only
  through that exact handle and accepted placement, and `finishWorkflow`
  proves the committed module identity, parent, and sibling order before
  sealing a slice. Lookup choice sources are different from these compiler-
  derived record and module projections: the brief copies their accepted
  semantic table and column identities exactly and tells the executor to copy
  them unchanged.
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
  dispositions. Each disposition names a finding in its exact persisted review;
  reads also compare its relational finding/status with the payload. Artifact
  readers compare relational identity, predecessor and source/digest metadata
  with the sealed body before returning a record. A plan belongs to the same
  session, source package and exact accepted revision. The writer checks its
  complete construction semantics against that revision inside the same
  authority transaction, after verifying any lookup receipt. Its raw payload digest
  is verified before the current contract is parsed. Private
  workspace finalization belongs only to contract/revision authoring; the
  deterministic planner has no workspace.
  Lookup materialization receipts retain every minted table, column, and row
  binding under their full result digest. The BuildPlan binds the exact receipt
  to execution authority, but the execution brief does not expose that mapping.
  When a newer revision supersedes accepted pre-app work, or the session is
  discarded, artifact orchestration releases that materialization's temporary
  lookup protections but never guesses that the accepted Project data itself is
  safe to delete.
- The build orchestration event chain re-proves its stored payloads and
  predecessor links under the session authority lock before each append, then
  requires the caller's exact head identity, revision and digest. Identical
  concurrent replays may adopt the persisted winner. Terminal app completion,
  charge settlement and the final event commit atomically. Chain continuity
  does not replace the design/build owners' phase-transition rules.
- `sourcePackage.ts` is the one caller-authorized source boundary. It renders
  bounded transcript messages, Project-authorized attachment extracts, and
  digest-bound images for the model while persisting references and
  content-free proof hashes rather than copied source bodies.
  Answered-question claims require the actual question input shape and a
  nonempty string answer for every question in the flat client result map.
  Malformed or unfinished cards seed nothing; complete cards retain their
  original UUID namespace, statement spelling and transcript coordinates.
  These claims remain source-package reconstruction metadata; they
  are not part of the Design Contract or build coverage model.
  Asset metadata must be ready and match the attached kind before projection.
  Package reconstruction uses the earliest prefix containing the original
  source coordinates, so later reattachments do not pull new text into an
  older design. The recomputed digest still refuses changed or missing content.
- `capabilityCatalog.ts` generates the design-time capability boundary from
  the shared tools and domain vocabularies. One session builds one app in the
  current Project. The catalog and bounded Project-data inspector expose current
  lookup identities, definitions, revisions, and selected row pages so reuse is
  an informed identity choice. Nova may reference existing Project media, but
  cannot create Projects, create several apps in one session, or generate/upload
  media.
- `prompts.ts` holds the author and reviewer briefs. The generated capability
  catalog contributes the platform constraints once per role; it does not list
  execution tools that the design author cannot call. Every prompt or grammar change bumps its persisted prompt
  version instead of reusing an old key. The prompts activate
  CommCare/Nova domain knowledge, treat source blocks as untrusted data, keep
  technical protocol details out of user prose, and make unsupported
  capabilities explicit. Readiness may remain external only when every included
  workflow can still be authored as a valid, reachable, useful app.
  `sourceReferences.ts` gives each source a label derived from its identity.
  Labels stay stable when the source index grows or changes order, so the
  author's cached message prefix and the reviewer's citations share one
  vocabulary. Message coordinates, media digests and extract versions stay
  behind the boundary. Lookup evidence accepts a displayed label directly;
  a document citation may add a section path or figure marker. Binding accepts
  only sources in the current authorized package. Plain document citations
  never inherit a prior citation's location. Artifacts retain full canonical
  references; labels are projections, never another stored ledger.
  Claims, candidate reads, reviewed parents and returned findings use the same
  projection. Source notes show statements and citations without private claim
  identities. State packets report saved facts without repeated continuation
  instructions.
  Message, attachment, image-label and normalized-claim text all neutralize
  source delimiters before projection. Rendering tests prove this formatting
  boundary; they do not prove that a model obeys the source-data instruction.
- `artifactResult.ts` admits an independent review or architect decision only
  after normal provider completion and successful schema parsing. Cancellation
  and token truncation take precedence even if complete JSON arrived earlier.
  Provider/transport errors retain their original classification and throw.
- Localization intent belongs to the accepted Design Contract, never inferred
  from conversation language. It names canonical source, runtime default,
  target metadata, each target's existing seed language, and `copy-only` versus
  `translate-with-nova`. Target dependencies form an acyclic closed graph. The
  artifact reader preserves stored contracts, while construction validation
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
4. Only an independent review with no blocking findings accepts its exact
   parent draft. Every correction is persisted as another draft and reviewed
   again; session budgets may stop a non-converging cycle, but review count
   never grants acceptance. The server then atomically materializes its approved
   Project-data intent and immutable receipt, then derives its build plan
   without a planner model call. The compiler keeps the design's lookup
   references; server-owned resolution is private to workspace dispatch.

The author makes architectural and worker-facing composition decisions in the
same durable pass. Form composition is one information hierarchy: native
interaction and clear labels carry familiar work, while supporting copy adds
distinct information once at the scope where it applies. One-case
selected-record and close inputs that write directly to the selected record edit
their preloaded current values in place; sparse blank replacement is a distinct
interaction, not explanatory copy layered onto the native one. Several-case
forms instead start those inputs blank and apply each nonblank shared answer to
the complete selection, while blank preserves each case's existing value. A
module selection is the exact module-wide consumer set, not one representative
workflow and not a WorkList feature; the author and reviewer must judge the
one/several interaction for every selected-record and close form it affects.
The stateless reviewer reads
the whole form for repeated information and runtime-copy mismatches, then
checks module minimality/reuse, parent-versus-child form hosts, queue-only
roles, actor-specific duplication, meaningful phases, context changes, error
risk, interruption recovery, Markdown guidance and summaries, validation
promises, and coherent icons. A flat rationale names
the actual inputs and worker sequence; the reviewer reports repeated weak flat
treatment as one systemic finding naming every affected form. There is no extra
model-authored build-plan or visual-design pass. The same review checks each
Project table's purpose, schema, typed values, reuse, duplicate risk, and every
consumer. Reusing an existing table is read-only by default; an edit to shared
Project data needs a direct user request or a durably answered question that
states the Project-wide consequence.

Grouped composition is visual hierarchy inside one continuous form, realized
with ordinary Blueprint group fields. It is not a form section (a page): the
contract carries no page decision, and that never justifies flattening an
otherwise useful grouping.

The same design tool catalog is mounted in every phase. Hosted tool search
loads semantic operations when needed; questions, waiting, and completion
remain immediately available. `designAgentToolDefinitions` owns this mount for
production and `/agents`. The durable digest covers every mounted definition,
including discovery and provider loading settings. Hosted discovery is retained
in model history but never enters the native operation queue. Successful design
updates return `{ok, deduplicated}` without conversational instructions. Durable gates refuse calls that are
not currently legal. Contract and revision candidates use an implicit durable
identity-addressed workspace. The model calls `setDesignRoot`, collection-
specific `update*` tools, `updateFindingDispositions`, `inspectProjectData`, `inspectDesign`,
and `finishDesign`; it never names the artifact kind,
workspace, or optimistic revision. It may emit several known calls in one
response. The server serializes their effects in provider order, and the small
`finishDesign` call replays and validates the whole candidate before one
immutable artifact insert. The runner then starts the independent reviewer
directly; the author never calls a tool to start review. A saved clean review
resumes acceptance without another model call, provided its source package is
still current and authorized Project data still satisfies the design. Blocking
findings return to the author in the saved design state. A durable wait or unanswered question
wins over pending review on recovery. The server replays the selected question
card without buying another author response; a later answer or user message
supersedes it. `inspectProjectData` returns a byte-bounded,
cursor-paged authorized Project table catalog or one cursor-bound page of at
most 100 rows; it never accepts names as identity. Catalog cursors bind the
exact Project revision and table/column position, so the author must read until
`complete` and restart without a cursor if Project data changes between pages.
A saved-value/label choice projection returns useful counts over the complete
ordered table. The author selects the table, value and label columns, and
`tableRevision`; `lookupChoiceAuthoring.ts` binds the full evidence through the
authorized Project reader. The server records the revision and display metadata,
hashes row identities/order/cells, and counts invalid, distinct, duplicate, and
blank-label rows. The model neither copies nor authors this evidence. Authoring
state projects it back to the selected revision. Existing workspace operations
and the source contract retain the evidence needed for replay after a source is
removed from the candidate; no separate receipt registry exists. Submission,
acceptance, and materialization retain their current Project-data checks.
Workspace operations use storage version 3. The [one-time format cutover](../../../docs/architecture/design-format-cutover.md)
retires older private design sessions, including their obsolete choice-evidence
operations. It preserves sealed artifacts, conversation messages, billing,
canonical apps and Project data. Current readers exclude retired scopes before
parsing. Runtime authoring contains no old-format replay or repair path.
`inspectDesign` reads selected exact state only when
a model needs a narrow workspace lookup. `waitForInput` is the explicit terminal when the
conversation says more requirements are coming but no question is ready yet.
It is serialized with every server-side design callback, while the stream
arbiter puts it in the same provider order as the client-side `askQuestions`
call: the first valid input terminal wins, and a later question is closed
without ever reaching the transcript. The wait persists in the private model
ledger before orchestration and is recovered from that ledger before any later
model call. Recovery also recreates its complete UI tool part when the private
response outlived the thread chunks, so the ordinary composer opens again. It
preserves the current workspace and closes the stream as awaiting input. The
durable response key binds the wait to the exact incoming turn; a later user
message supersedes that wait instead of replaying an older pause.
A clean response with no update, question, wait, or phase finalizer receives
one server-authored correction and one internal redrive. If the omission used
the last ordinary session step, one runner-owned step is reserved solely for
that correction. The provider response is keyed to its exact logical turn and
phase before orchestration inspects it, so process replacement restores the
same correction before enforcing the step ceiling. A second omission stops as the recoverable
`design-terminal-omission` defect instead of silently ending the turn.

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
preserved draft. The 64-step allowance is per logical user turn, including an answered question;
reconnects retain the same count and a new user message starts a fresh allowance. When every construction issue is a
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
guidance, redrives internally, and forces `askQuestions` without changing the
tool grammar or asking the user to resend. The demand message also teaches the
resolution path: after answers arrive the model records them — records each settled choice as a
decision or assumption, removes the question or marks it non-blocking — and a
delegating answer such as "use sensible defaults" makes the concrete choice
the model's to bake in.

Semantic tool replay retains its persisted call identity after eager forward
references become known or declared. A changed binding batch may replay only
when the stored operation envelope is identical and every supplied binding is
already proven in the session ledger; replay adds no workspace steps or handles.

`designAgent.ts` owns the one stable agent grammar and compaction preparation.
A retained state packet suppresses fresh derivation only when its durable append
key proves a server `state:` or `compaction-state:` write after the newest provider
checkpoint. User text, including a copied state heading or an old server packet,
cannot establish that origin. The packet commits before the next provider call.
The ordinary history and every complete step response append to
`design_model_context_items` atomically with its usage-bearing
`design_model_steps` completion event; the step ledger brackets provider calls
with payload-free request/response evidence. Completion verifies that its
declared response digest binds the exact persisted messages. Recovery verifies
every current and predecessor step event against its stored digest before using
request counts, completion state or usage for accounting. A durable provider-call start
consumes the design step budget even when infrastructure interrupts its
response, and recovery derives prior spend from those starts before another
request is allowed. Every browser user turn
absent from the private context, including an answered client-side question
result, is reconciled in transcript order on its later POST. A persisted
question call whose client card never reached that transcript receives an
explicit interrupted result before redrive; the closure is never treated as a
user answer, and that reconciliation takes precedence over classifying a
correction response as a terminal omission. Every completed-step usage record
from the exact recovered run is registered in the replacement meter; the
durable `(context, step)` accounting
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
Provider-call starts carry immutable logical-turn provenance and a separately verified
provenance digest without rewriting historical event digests. The 64-step limit
is reserved transactionally across all generations for that turn. Reconnects,
provider retries and deployment rollovers cannot replenish it. A new user
message or newly answered question starts a new allowance. The runtime refuses a missing turn before another provider request. Completed usage stays attached to its original run.
Server-only question-card
provenance also remains readable across the chain even though model messages
reseed into the successor. That exceptional rollover reseeds from the complete
browser transcript and durable workspace; it never mutates old messages or
leaves the session permanently unable to resume.
Item-only rollover generations never hide an older provider response: terminal
recovery searches back to the newest generation that actually completed one,
while a genuinely newer provider response still supersedes the older terminal.

`gates.ts` decides legality only from durable artifact ancestry. A reviewed
correction always becomes another draft, and only a fresh independent review
with zero blockers can accept it; the durable session and repair budgets stop
non-convergence honestly rather than converting it into acceptance. Answered
blocking questions reopen design work only before construction freezes the
accepted revision and plan. `packageRebuild.ts` refuses continuation when the
authorized sources cannot reproduce the bound package.
When new source evidence reopens an accepted design, its old blocking questions
remain context, while the server's next-action message directs authoring to
incorporate the new evidence. It must not demand the same answer again merely
because the historical accepted artifact still contains the question.

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
7. Drafting and review never write Project lookup data. Accepted lookup intent
   materializes once, before construction, under a digest-bound UUID receipt;
   every retry consumes that receipt rather than repeating the write.

## Tests and scripts

The graph, review, deterministic plan, complexity, source package, capability
catalog, artifact store, workspace protocol, gates, compaction wire, and full
phase loop each have focused tests under `__tests__/` and `loop/__tests__/`.

Design lifecycle tests exercise the production runner, durable artifacts, and
installed provider decoder against controlled HTTP responses and Postgres. Paid
quality trials must use that same production path; there is no separate in-memory
author/review protocol.
`scripts/inspect-design-artifacts.ts` is the read-only local/production
inspector. It reconstructs open workspace readiness and usage even before an
immutable revision exists; `--reasoning` includes model reasoning summaries and
payload-free tool outcomes from the run event log.

Progress narration recognizes completed top-level JSON keys across streamed
deltas, including split escapes. Nested keys and source prose do not announce
submission steps. It retains only a bounded candidate key; submission schemas
still own validation, and progress labels never imply artifact acceptance.


### Menu placement and continuation

`placeModules` edits menu identity, parent and preceding sibling atomically.
Null parent means a root; null preceding sibling means first in that parent.
Moving a parent carries its children. Module updates preserve position, append new modules to their parent, and
reparent existing modules at the end of the new parent's children. Canonical
preorder is a storage projection. One runtime grammar handles every workspace.

Build plans and briefs use one schema. Only real workflow, parent, selection
and viewer prerequisites determine newly derived construction order. Existing
sealed plans retain their explicit dependency data without a special reader.
Brief placement always projects accepted order onto the full expected
construction prefix, including earlier slices. Missing expected modules remain
failures; future modules are not required early.

A response containing tool calls, including a rejected finalizer, is never a
clean terminal omission. Only text-only completion gets the one durable
correction step; the 64-step ceiling stays a distinct recoverable stop.


The pre-app chat composer accepts a new message after a stopped design, including
on reload. Only materialized accepted builds offer `Resume build`, which
re-drives the frozen plan without adding design instructions. The initial app
editor remains locked throughout construction.

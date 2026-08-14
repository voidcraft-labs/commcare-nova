# Valid revisions, reviewed design

## Current architecture and the two remaining units

Nova turns one user request into one app in the current Project. It first
records the product meaning in a lean, non-executable Design Contract, checks
that design independently, derives a deterministic workflow build plan, and
constructs each workflow inside a private Atomic Change Set. Only a complete,
valid canonical Blueprint revision becomes visible.

The primary product goal is a high-quality app that reflects what the user
asked for. Design artifacts exist only when they improve that result, make a
failure recoverable, or let Nova make an honest completion claim. The design
layer is not a requirements-management product and does not mirror the same
meaning across claim, fact, rule, transition, scenario, ownership, and lowering
tables.

The current foundation is complete through initial reviewed builds. Two units
remain, in order:

1. **Unit F: completion truth and Design history.** Verify the built app against
   the accepted workflow design, run one grounded quality review, correct real
   issues through ordinary valid slices, and persist an honest completion
   report.
2. **Unit G: reviewed edits and high-level MCP.** Reuse the same design,
   projection, conformance, and change-set machinery for substantial edits and
   for clients that want the reviewed workflow rather than direct mutation
   tools.

This file describes the present architecture plus those two remaining units.
It is not a rollout log.

## 1. Product and authority boundaries

### 1.1 One canonical app state

An app is still one canonical `BlueprintDoc`. Preview, export, deployment,
case-store schema, collaboration, the builder, and direct MCP tools consume
only canonical revisions.

Two private state spaces support a reviewed build:

- the Design Contract, which may be incomplete while it is being authored but
  cannot execute;
- an Atomic Change Set, which may contain an incomplete private candidate but
  cannot render, export, stream to peers, or write case data.

Only the existing canonical admission and transaction kernel can create a
visible app revision. There is no Blueprint draft mode, finishing operation,
alternate validity regime, or model override of the validator.

### 1.2 One app and one Project

A design session creates exactly one app in the current Project. Nova cannot
create or choose Projects or CommCare HQ project spaces. If the request asks
for multiple apps, the design agent asks which single app to build rather than
pretending that one session can produce several.

External assets and resources are explicit boundaries:

- Nova may reference media that already exists in the current Project.
- Nova cannot record, synthesize, validate, or upload audio or other media from
  the design loop.
- Lookup data, places, workers, HQ rules, build/release work, and deployment
  steps remain separately authorized resources or human prerequisites.
- A private change set has no external-write capability.

### 1.3 Direct editors remain direct

The visual builder, the ordinary app edit agent, and existing shared MCP tools
continue to commit valid canonical changes immediately. They do not require a
Design Contract. Missing or stale design metadata never makes a valid app
uneditable, unpreviewable, or unexportable.

The explicit **Start with a blank app** action and MCP `create_app` still create
the minimal valid Survey, Form, and Question app immediately. They do not enter
the reviewed conversational build flow.

## 2. Current reviewed-build flow

```text
user request and authorized attachments
                |
                v
       owner-private design session
  thread, stream, holder, credits, recovery
                |
                v
        author phase: lean contract
 bounded durable stages plus one finalizer
                |
                v
        fresh independent review
                |
        +-------+-------+
        |               |
      clean         blocking findings
        |               |
        |               v
        |        targeted revision phase
        |               |
        +-------+-------+
                |
                v
      accepted contract revision
                |
                v
  deterministic workflow build plan
                |
                v
     one private change set per slice
                |
                v
 canonical sequence 1, then later revisions
```

The design method advances through durable server state. Model prose and
transcript recollection do not decide whether a draft exists, whether review
happened, whether a revision is accepted, which plan is active, or which slice
committed.

## 3. Lean Design Contract v1

`lib/agent/design/contract.ts` is the authority. The schema remains version 1
because this is the first shipped contract.

### 3.1 Root shape

The contract records:

- `charter`
- `actors`
- `records`
- `workflows`
- `lists`
- `access`
- `navigation`
- `externalRequirements`
- `decisions`
- `assumptions`
- `openQuestions`

It does not record source-claim mirrors, confidence scores, separate fact or
rule graphs, transition tables, standalone acceptance-scenario matrices,
intent ownership, implementation coordinates, or a model-authored build plan.

Source references remain in the authorized source package. The independent
review is the only design artifact that attributes an important conclusion to
specific source evidence.

### 3.2 Charter

The charter fixes the session boundary and overall product:

- app name and objective;
- exactly one app;
- the current Project;
- every included workflow exactly once;
- explicitly excluded workflows;
- offline-first, online-first, mixed, or undecided delivery context;
- the initial useful workflow.

The initial workflow becomes the materialization root. The graph validator
proves that it exists, belongs to the included workflow set, and has no
workflow prerequisite.

### 3.3 Actors and records

An actor records only the information needed to design usable work:

- name;
- goals;
- responsibilities;
- work context;
- constraints.

An actor is not a Blueprint user type or Preview persona. Runtime bindings are
implementation provenance.

A record owns its properties. Each property records:

- name and meaning;
- data shape;
- sensitivity;
- optional required condition;
- allowed values for a choice property.

Properties are declared once under their record. Writer and reader relations
are derived from workflows and lists rather than copied into the property.

### 3.4 Workflows

A workflow is the main unit of design and construction. It records one
task-complete user outcome:

- actors, goal, and trigger;
- optional current record context;
- prerequisite workflows and plain-language prerequisites;
- inputs, including form-only inputs when nothing persists;
- workflow-local decisions and outcomes;
- authored existing-media and automation features when the workflow needs them;
- record effects: create, update, close, link, or reassign;
- property writes and unanswered-value behavior;
- readback that confirms or supports the next decision;
- exception paths;
- external requirements;
- concrete preconditions, action, and expected-result examples.

Workflow-local handles identify inputs, decisions, and effects without adding
global Design IDs for every nested item. They are semantic names inside one
workflow, not Blueprint identities — and a third vocabulary from both the
session's `@handle` identity symbols (§4.2) and the server's positional `@f`
finding handles (§4.4): the three never share a resolution path.

### 3.5 Lists, access, and navigation

A list records the record type, actors, purpose, filters, sort intent, scan
properties, detail properties, search properties, selection workflow, and
empty-state meaning.

Access records actor capabilities over record, workflow, list, or navigation
targets. Conditions and location scope describe both the intended user
experience and the data boundary. Hidden navigation alone is never described
as a security boundary.

Navigation groups workflows and lists around user purpose. Parent navigation
is acyclic.

### 3.6 External requirements, decisions, assumptions, and questions

An external requirement names what is outside Blueprint construction, which
workflows depend on it, and whether construction truly has to wait — one
kind and one blocking flag, from which the plan derives each action's
timing; there is no separate authored timing axis restating them. Runtime or deployment setup is non-blocking only when every included
workflow can still be authored as a valid, reachable, useful app. Every
controlled choice has either at least two distinct real inline values or the
semantic name of a lookup table and value/label columns that already exist in
the current Project; the executor resolves their current identities. Missing
values, an unevidenced lookup claim, or another absent reference remains
construction-blocking when it would require empty, one-value, duplicate, or
invented placeholder choices, or an always-hidden workflow. The design instead
obtains the real values, names the existing lookup, chooses a supported
alternative, or defers that workflow. The persisted v1 reader stays compatible
with earlier artifacts, while contract finalization and deterministic plan
derivation enforce this construction proof for new work.

A decision stores the selected decision and its rationale. It does not preserve
an option matrix when the discarded alternatives have no ongoing product
value.

An assumption states what Nova is relying on and what changes if it is wrong.

An open question states its structural impact, whether it blocks, and the
contract elements it can change. A blocking question cannot float without an
affected element. The authored blocking flag is the construction gate: only a
blocking question tied to included construction forces a user decision before
finalization, while a non-blocking question is a recorded caveat beside
concrete design — the spelling for a decision the user delegated or a
production-hardening note — and the concreteness proofs above still reject
design that is not actually buildable. A user answer that delegates a
decision makes it the model's: it bakes concrete values into the design,
records them as a decision or assumption, and does not hold a blocking
question open for them.

### 3.7 Deterministic graph checks

`lib/agent/design/graph.ts::validateDesignGraph` runs inside the contract
schema parse. It proves at least:

- global Design ID uniqueness;
- kind-compatible reference closure;
- actor, record, property, workflow, list, access, and navigation references;
- acyclic record, navigation, and workflow dependencies;
- workflow-local handle uniqueness;
- form-only inputs declare a data shape;
- effects write only properties of their target record;
- readback and list properties belong to the record being read;
- access targets exist;
- unsupported promises block affected construction;
- the charter includes every workflow exactly once;
- blocking questions name affected elements.

The contract schema is not the Blueprint validator. It checks design
coherence, not executable wire validity.

## 4. Design authoring and independent review

### 4.1 One append-only design context

The runner uses distinct semantic phases:

- `author`
- `review`
- `revision`
- `awaiting-input`

All phases share one tenant-scoped append-only model context and the same seven
provider tool definitions. Durable gates decide which operations are legal.
A terminal phase tool advances ancestry, and the runner appends the next exact
state without requiring another user message or rebuilding the prompt. Complete
responses and client-side question answers are durably appended; payload-free
step events bracket each provider call for recovery diagnostics. Recovery scans
the complete browser transcript and appends every user turn absent from the
private context rather than assuming only the newest turn can be missing.
If a deployment genuinely changes the pinned model, prompt, tool schema, or
context format, Nova preserves that context immutably and starts one explicit
successor generation. The successor reseeds from the complete visible
transcript and durable workspace; it never rewrites the old provider contract
in place or strands the design session on a permanent compatibility error.
Provider-call spend is recovered across the complete immutable generation
chain, so the successor cannot reset the design step budget. Server-only
question-card provenance remains readable across that chain even though the
successor model context reseeds its messages.

### 4.2 Bounded durable workspaces

Authoring and revision use:

- `stageContract` or `stageRevision`;
- `inspectDesignWorkspace`;
- `submitContract` or `submitRevision`.

A stage changes the root or one coherent collection and carries the exact
expected workspace revision. Every new global element uses a readable handle
such as `{ "handle": "@register_client" }`. Identities are minted
deterministically from (session, handle), so staging is ORDER-FREE: a
reference may precede its declaration in any stage, binding eagerly in the
session-scoped ledger under a `referenced` marker kind that the declaring
item later upgrades. Submit-time reference closure refuses any element never
actually authored, naming the model's own handle. Invented raw UUID
declarations are rejected at staging, and the reserved `@f` finding namespace
can never enter a design reference. Persisted artifacts remain
UUID-only, while exact model state projects known IDs back through handles.
The reviewer's tag/handle vocabulary (§4.4) is the same projection law applied
to the review surface: symbols in every model-facing direction, UUIDs at rest,
resolution server-side before admission.

Each stage is bounded to 32 item changes and 48 KiB. Successful stages are
durable. A rejected finalization leaves every accepted stage intact, so the
model corrects only the affected items and necessary cross-dependencies.
Before a contract or revision stage enters the ledger, Nova replays it and
proves that every declared design element still has a globally unique identity.
References may target declarations already bound by an earlier stage or a
declaration in the same stage; they cannot point speculatively at future work.

Finalization rejections carry a validation stage and payload-free diagnostic
fingerprints. A later stage or changed fingerprint is progress; an exact repeat
stops after two attempts and any third rejection stops honestly as an internal
design defect. A bounded stage call rejected three times in a row with an
identical diagnostic stops the same way; a changed diagnostic or an accepted
stage resets that count. When every construction issue is an authored blocking
question, the server appends the exact required questions and refuses further
design staging until an `askQuestions` round, at most five questions, is
answered. Those user decisions do not consume the model-repair budget.
Server-only durable append keys bind the exact batch's question ids,
structural scope, related elements, prose, and accepted tool-call id, so
identical later prose or an incomplete model-authored subset cannot unlock
staging. An answer binds to the exact question identity it was given for, so
it stays valid while bounded stages apply it and across later rounds: a
question the user already answered is never demanded again, only genuinely
new or re-authored questions are, and staging opens when every currently
pending question identity carries a durably authorized answer. A clean response
that omits the required call receives internal correction guidance and is
redriven without changing the provider tool grammar or asking the user to
resend. If process replacement preserves a question call but its user-facing
card never committed, redrive first appends an explicit interrupted tool result
and derives the still-current questions again. It never sends an unmatched
function call to the provider or mistakes the closure for a user answer.

There is no plan workspace. The model neither stages nor submits a plan.

### 4.3 Exact state after resume and compaction

The complete visible `UIMessage[]` transcript and the private design/executor
`ModelMessage[]` contexts remain durable. Provider compaction is the only legal
model-history prefix replacement within one compatible context generation.
Completed provider-step usage is durable beside the exact response. A
replacement process registers every same-run completion in its fresh meter
before reusing the response. The persistent `(context, step)` usage-account
ledger admits each contribution exactly once, in the same transaction as the
run summary and monthly dollar total; overlapping POSTs and process replacement
therefore need no timestamp watermark. Already finalized turns and context
retained from another instruction do not move or duplicate that instruction's
cost. Recovery registers historical usage without replaying live step events,
and a zero-cost credit refund requires the successful accounting transaction's
authoritative cumulative run total.

After a compatible compaction checkpoint, Nova preserves the retained suffix
and appends a fresh exact state packet when the suffix does not already carry
one. Ordinary phase transitions also append current state. The packet contains:

- the legal next phase;
- resolved answers and source outline;
- open review findings;
- the current workspace revision and counts;
- the exact current candidate;
- the immutable reviewed parent during revision.

The durable workspace is authority. The model retains normal conversational
continuity, while a compaction checkpoint is a lossy prefix replacement rather
than a hand-built phase reset. Narrow inspection remains available for exact
lookups.

### 4.4 Independent review

`requestReview` runs a stateless fresh-context structured reviewer. It receives
only:

- the exact authorized source package;
- the exact proposed contract, printed through the session's identity-handle
  projection;
- the capability and platform-constraint catalog;
- the session's durable identity-handle bindings (a read-only ledger read that
  authorizes like every workspace read and creates nothing).

It receives no author hidden reasoning, prior reviewer prose, mutation tools,
or canonical authority.

A finding records exactly the two decisions the machine consumes plus its
content:

- severity (critical, important, advisory);
- disposition class (design correction, user decision, or note — readiness
  work outside construction and optional improvements);
- claim;
- affected contract elements, named by their printed `@handle` symbols;
- proposed resolution when useful;
- evidence references only for critical or important findings, named by
  server-assigned source tags or a platform-constraint code.

There is no category taxonomy, basis flag, or confidence score: nothing
consumed them, and every extra correlated classification is another way a
whole structured review fails its parse.

The reviewer emits no identities Nova already owns. A structured generation
reproduces short semantic symbols far more reliably than 32-hex-digit UUIDs or
compound source coordinates — both observed live failure classes were the
model failing to copy an arbitrary string it could not mean — so the model's
whole output vocabulary is symbols, resolved inside the reviewer's own schema
(`reviewerSchema.ts`, a Zod transform: the strict wire projection emits the
symbol grammar, the parse returns the persisted UUID-only review). Source
citations are `S`-numbered tags derived once (`taggedCitableSourceRefs`) for
the prompt's legend, the source-block labels, and the schema's exact tag enum,
so an out-of-set citation is grammatically inexpressible rather than merely
rejected; no raw coordinate appears anywhere in the reviewer's context.
Platform citations are the catalog's code enum, and the catalog supplies the
`sourceAnchor` (a model-emitted anchor was never verifiable). Affected
elements get the same exact-enum closure: the grammar admits only the symbols
the projected contract prints — bound `@handle`s plus any raw-printed unbound
identity — so a symbol the contract does not print is grammatically
inexpressible, and a rejection names the model's own symbol. Workflow-local
input, decision, and effect names (printed without `@` inside their workflow)
are deliberately outside that set; the prompt directs such findings at the
enclosing workflow's `@handle`, with the local name in the claim prose.
Ledger-binding resolution remains the backstop for direct callers.
The server mints the review and finding identities at resolution, and the
resolved value re-parses under the persisted schema before anything persists.

Advisories carry no citations. A critical or important finding must ground
itself: a source tag, a platform-constraint code, or — when the defect is the
contract contradicting itself — the affected elements whose meanings conflict.
Demanding a citation where none genuinely exists was the pressure that
produced padded citations. Only design corrections at critical or
important severity, plus unresolved user decisions, block acceptance.
Notes remain visible
context but do not force a pointless design rewrite. A decision the sources
show the person delegated is settled by its concretely recorded default: the
reviewer challenges a bad default as a design correction rather than raising
a user-decision finding to hand the choice back.

### 4.5 Revision and review depth

A revision workspace begins from the immutable reviewed parent. It upserts or
removes only affected items and persists one disposition for each blocking
finding. Unchanged content stays in place.

The agent never copies a finding's UUID either: findings return from
`requestReview` — and print in every state packet — with server-assigned
positional `@f1..@fN` handles (continuous across the head draft's reviews in
ordinal order, derived on demand, never stored), and a disposition's
`findingId` is that printed handle. The revision stage resolves finding
handles against that derivation BEFORE the generic workspace resolver runs,
because findings are server-minted identities a deterministic handle mint
would silently miss; an unknown finding handle refuses naming the open set.
Declaring an `@f`-numbered handle for a design element is refused at staging,
so the projection can never print one symbol for two things.

One second review occurs only when the first revision:

- leaves critical risk unresolved;
- follows a first review with at least two critical findings; or
- changes architecture in response to critical feedback.

Complexity alone does not trigger a second review. There is no third automatic
review loop.

Sensitivity may be lowered only when an accepted correction explicitly names
the affected property. A revision cannot silently downgrade sensitive data.

### 4.6 Complexity and user expectation

Complexity is deterministic over workflow shape. It assigns `compact`,
`standard`, or `extended` and persists the component readings with the
contract envelope. It controls process budgets and the conservative user time
estimate:

- compact: about 30 minutes;
- standard: about an hour;
- extended: about 90 minutes.

It never changes validity or grants model authority.

## 5. Deterministic BuildPlan v1

`lib/agent/design/buildPlan.ts::deriveBuildPlan` is a compiler pass over one
accepted contract revision. The plan is not model-authored.

### 5.1 Slices

The compiler creates exactly one slice per workflow in topological order.

Each slice records:

- workflow identity, name, and goal;
- prerequisite slice identities derived from workflow prerequisites;
- construction groups;
- related external actions;
- risk;
- role.

The charter's initial workflow is the only `materialization-root`; every
other workflow is ordinary.

External actions remain separate from Blueprint effects. New-plan admission
allows manual setup and after-slice readiness, but rejects a blocked
(construction-blocking) action until a typed durable receipt producer
exists. An
unresolved construction dependency stays linked to a blocking user question,
so an accepted design cannot be mistaken for a plan the executor can start.

### 5.2 Construction groups

Construction groups are the executor's small coverage vocabulary. Current
group kinds are:

- data and people;
- workflow;
- lists and search;
- access and navigation.

Every constructible top-level design element belongs to exactly one group:

- actors;
- records and properties;
- workflows;
- lists;
- access policies;
- navigation.

External requirements remain related external actions and execution context.
They are not construction groups because they do not require Blueprint
mutations, and a construction group cannot reference one as an element.

Ownership is assigned deterministically to the earliest workflow that creates,
writes, exposes, or protects the element. This is enough to prove that each
slice implemented its real units of work without forcing the model to cite
every nested design object on every tool call.

Decisions and assumptions inform the materialization-root execution brief but
are not separate construction work.

### 5.3 Plan checks

The persisted plan proves:

- exactly one slice per included workflow and no extra slice;
- one materialization root;
- an acyclic prerequisite graph;
- unique slice and group identities;
- every group belongs to its slice workflow;
- every constructible contract element appears in exactly one group;
- every referenced element still exists in the accepted contract;
- every external action corresponds to an external requirement.

Stable slice, group, and action IDs derive from the accepted revision digest.
A crash between acceptance and plan insertion is recovered by deriving the
same plan again and inserting it through the normal authority boundary.

## 6. Slice execution and Atomic Change Sets

### 6.1 Immutable execution brief

Each executor receives one exact brief containing:

- the one-app charter;
- its workflow and prerequisite workflow summaries;
- only properties owned by this slice or read/written by its workflow, queue,
  access rule, or navigation, plus the actors, records, lists, and requirements
  that context needs;
- root decisions and assumptions when relevant;
- each construction group as an explicit semantic checklist;
- a slice-specific read/mutation profile and only relevant capability and
  platform constraints;
- exact accepted revision and plan digests.

The brief contains no source documents, author reasoning, traceability matrix,
or model plan.

### 6.2 Compiler worker

The slice executor is a bounded compiler, not a designer. It receives:

- shared read operations over the private candidate;
- `readBatch` for up to four related reads;
- `stageBatch` for one ordered construction group;
- `inspectChangeSet`;
- `commitChangeSet`;
- `reportExecutionBlocker`.

Only `readBatch`, `stageBatch`, `inspectChangeSet`, `commitChangeSet`, and
`reportExecutionBlocker` are top-level tools. Their provider definitions and
batch operation unions are immutable across the accepted plan, preserving one
cacheable context. The slice brief contains the narrower operation profile and
the server enforces it as a hard dispatch allowlist, including the correction
operations for that slice. Unrelated lookup, media, organization, automation,
external-effect, app-lifecycle, user-message, and direct canonical commit
authority remain unavailable even though stable batch schemas describe their
ordinary authoring arms.

Every mutating operation names one or more `constructionGroupIds`. The server
strips that executor-only field before the original shared tool schema parses.
Durable mutation-bearing steps must collectively cover every group in the
slice before commit.

The existing database columns retain their historical `intent_*` names, but
their v1 semantic value in this pipeline is a construction-group ID. Unit F
must read them through the construction-group plan and must not restore a
per-element attribution matrix.

### 6.3 Handles and batch efficiency

The executor uses private readable handles for entities created inside a
change set. The server resolves handles before original tool-schema and
mutation admission. Handles never enter Blueprint, app history, MCP, export,
or deployment.

There is one declaration rule: a creator places `{ "handle": "@name" }` in
its ordinary canonical identity slot. Worker properties, user types, personas,
and place-information properties use `userPropertyUuid`, `userTypeUuid`,
`personaUuid`, and `locationPropertyUuid`. A binding is durable across batches,
model steps, context compaction, process recovery, and later slices in the
same frozen plan. Before a later slice inherits it, rehydration proves that the
UUID and entity kind exist in that slice's exact base revision. Executor reads
and checkpoints project symbols rather than raw UUIDs or binding maps.

When a correction removes an entity created earlier in the private candidate,
the same durable stage prunes its local handle. An earlier committed slice's
symbol is not imported after a later slice deletes that identity. A case-bound
select also spells out its catalog options on the executor path so every option
is born through a handled `optionUuid`; shared catalog defaulting never
introduces anonymous authorable identities into a private build.

`stageBatch` runs ordinary Nova operations serially. A rejected operation stops
the batch before that operation while preserving the accepted prefix. The next
batch corrects only the failed operation and its dependent suffix.

Complete `createModule` and `createForm` operations are preferred when the
accepted workflow already specifies the complete structure. `stageModule` and
`stageForm` exist only for a genuine dependency or call-size boundary. There is
no one-field-at-a-time fallback strategy. Field assembly is atomic across
`addFields`, `createForm`, and `createModule`: if any requested field cannot be
assembled or admitted, the entire call is rejected and no returned identity
can name an omitted field.

### 6.4 Coverage and provenance

At commit, the server proves coverage from durable mutation-bearing steps. It
does not copy every group from the plan into the receipt as if the model had
implemented it.

Mutation-derived implementation coordinates are persisted beside the canonical
revision. The current coordinate vocabulary includes app, module, form, field,
case-list column, case operation, user type, persona, organization level,
location property, automation, case property, and external action.

Unit F joins:

```text
contract element -> deterministic construction group -> committed group
                 -> mutation-derived implementation coordinates
```

This provides useful verification without asking the design agent to maintain
the same mapping manually.

### 6.5 Commit and materialization

`commitChangeSet` is only a request. The server independently proves current
holder, Project membership, artifact lineage, workspace revision, read sets,
coverage, validator state, and canonical replay.

After the executor has requested validation, a fully accepted correction may
consume its final model step. At that exact step boundary the server re-runs
the same current-read, coverage, and validator proofs and may commit the clean
candidate directly. It never infers completion before the executor enters
validation, after a stopped batch, or from a partial accepted prefix. The model
step budget therefore bounds reasoning without discarding already complete,
fully proved work merely for lack of a final mechanical commit call. The
attempt row durably records validation entry and last-action eligibility, and
claiming another model step clears eligibility transactionally, so process
recovery at the budget boundary re-runs the proofs instead of losing a clean
candidate or accepting stale readiness. The final accepted action records its
model-step marker with its staged receipt; a successful correction that is
already satisfied records an accepted no-op receipt and the same marker without
advancing the private revision.

The sequence-one materialization transaction creates the first useful,
export-ready app and transfers the exact holder and unsettled reservation from
the design session to the app. Later slices use the normal app-locked canonical
kernel.

The exact running slice attempt, change-set transition, committed-slice
receipt, and implementation provenance commit with the canonical revision or
not at all.

The orchestration appends `finished` only after every exact plan slice has one
matching committed attempt and receipt, every construction group has durable
mutation coverage, the final receipt matches the canonical app head, the full
validator passes, and the ordinary `.ccz` export path compiles. A valid prefix
or a valid app with an uncommitted slice is never completion.

Receipt, attempt, validator, and ordinary export-compilation proof failures are
deterministic terminal build defects. Infrastructure failures while reading
those authorities remain ordinary classified throws and resume without a
terminal completion event. While the accepted build owns the app, the canonical
writer rejects holder-less MCP and autosave mutations. After the proof,
case-schema convergence lands first. The exact-sequence app-status
compare-and-set, kept-charge settlement, and append-only `finished` event then
commit in one holder-authorized transaction; a concurrent canonical edit cannot
be adopted as a head that was never receipt-matched and compiled, and no app can
release its build authority before recording its terminal event.

### 6.6 Blockers and terminal behavior

An executor reports evidence when implementation appears to require changed
meaning. A fresh architect may give construction guidance that preserves the
accepted workflow or declare it unsupported by the current compiler.

The accepted contract and deterministic plan freeze when construction begins.
The architect cannot require a contract revision, ask the user to reinterpret
an accepted workflow, remove workflows, or replace the plan. Such a result is
an internal build defect and stops honestly. A local tool-schema rejection is
a construction problem, not a reason to rewrite product intent.

Budgets cover model steps, staged requests, blocker resolutions, commit and
rebase attempts, and active wall time. The same deadline reaches awaited
provider work and database transactions. Each attempt durably claims model,
staging, blocker, and commit spend before starting that work. Wall-clock
spend is a durable active-time integrator: each genuine claim accrues the
interval since the attempt's last accrual point, recovery resets the point
without accruing, and the deadline grants only the unspent remainder — the
dead gap between a killed process and its resume is not spend, so a recovered
attempt is never born past its deadline. Every sub-budget claim has a stable
operation key; replaying that exact operation reuses the existing claim
instead of charging a second unit, while infrastructure recovery grants no
new budget beyond that unspent remainder. Each PAID architect decision grows
the attempt's step, staging, and wall-clock limits by one bounded priced
allowance: a `continue` guidance directs rework the deterministic plan never
priced, and `maxBlockerResolutions` caps the total extension at two
allowances. A paid
architect blocker result is appended before execution continues, and a result
lost before that durable write stops instead of purchasing a second decision. A
validation/finalization checkpoint survives on the same attempt row. Each run
id is appended to that attempt before the run can spend model work, so a
replacement holder never erases cost-evidence provenance. A post-COMMIT
response that races the deadline reconciles through the already
durable receipt without retrying the write. A deterministic failure closes the
exact plan, slice, model, prompt, and brief combination. Sending another user
message does not reroll unchanged work.

Each attempt also owns authoritative wire-invalid, stage-rejected, and
validator-repair counters. A process opens a durable outcome-evidence window
before executing and closes it only after every observed outcome is
checkpointed; recovery over an unclosed window latches incomplete evidence, so
absence from the fire-and-forget operational event log can never count as zero.
A successful canonical commit seals a collecting window transactionally with
the slice receipt; an already-incomplete window never becomes complete.

## 7. Recovery, UI, and user trust

### 7.1 Durable recovery

Before materialization, the design-session row owns the build holder,
reservation, transcript, stream, artifacts, and recovery URL. After
materialization, the session maps immutably to the app and holder authority
delegates to the app row.

Stage requests and design workspace operations are idempotent by tool-call ID,
input digest, and expected revision. Lost responses return the stored receipt.
Process death rehydrates from durable artifacts and steps. If infrastructure
replaces the run, the current authorized session holder adopts the same exact
running attempt and open change set transactionally; it does not start a fresh
model attempt or reset any spent budget.

### 7.2 What the user sees

Before materialization the user sees:

- the conversation;
- one truthful status line directly above the composer;
- a compact reviewed-design outline;
- questions when needed;
- resume and discard controls;
- no app tree or Preview.

The stage projection derives dead-run evidence from the durable row alone: a
recorded failed-run marker, or a still-present holder whose lease lapsed with
no failure flush (a process death). Either form projects the stopped stage and
its resume control immediately, report-only, without waiting for a later
claim's admission scan to reap the session.

Internal contract, review, and revision tool parts remain in durable model
history but never render in chat. Technical validation errors and model-only
success instructions stay internal. The outline does not show finding counts
or severity labels.

If final construction admission discovers that an included workflow still
depends on a user decision, Nova returns to the question card before accepting
the design. It cannot present an unfinished workspace as a saved reviewed
design, and it cannot convert a design defect into a user retry strategy.

After materialization, the builder installs the complete sequence-one snapshot
atomically, promotes the URL, starts collaboration at sequence one, and keeps
visual authoring and the composer read-only until the initial plan completes.
Only a persisted pre-build question accepts an answer. The central progress
card stays on Build while construction is active.

A later slice failure never hides or invalidates an earlier materialized app.
The valid committed portion remains recoverable for diagnosis, but it stays
locked and Nova never reports it as a completed build.

### 7.3 User-language rule

Nova speaks about the user's workflow, not its implementation protocol. It may
say that it is understanding the work, improving the design, checking the
design, or building a workflow. It does not expose schemas, IDs, validator
codes, tool names, internal review counts, or private staging mechanics.

Long-running work receives brief contextual updates in Nova's voice. Time
expectations use the assigned deterministic effort level and lean toward the
longer side.

## 8. Persistence and operational invariants

The current foundation owns:

- design sessions;
- source packages;
- contract revisions;
- reviews and dispositions;
- deterministic build plans;
- design artifact workspaces;
- orchestration events;
- slice attempts and committed receipts;
- change sets, requests, steps, stage ranges, and handles;
- external-action receipts;
- implementation provenance;
- target-polymorphic threads, stream chunks, and run summaries;
- exact thread media references.

All authoritative JSON is selected as text, parsed through
`parsePersistedJsonText`, strict-parsed through the current schema, and digest
verified. Artifact and event tables are append-only where their lifecycle
allows. Row locks are taken only on mutable authority carriers.

Every correctness-bearing write reauthorizes the live holder and current
Project membership inside the transaction. IDs are selectors, never
capabilities. Foreign and missing IDs fail opaquely.

Logs and Sentry receive safe codes, opaque identities, counts, durations,
model usage, and digests. They do not receive customer design text, source
bodies, transcripts, model prompts, raw tool payloads, private mutations, or
holder nonces. Admin-authorized run inspection may expose the deliberately
persisted reasoning summaries used for quality diagnosis.

The design-session inspector reconstructs pre-revision sessions from the
durable workspace ledger and prints workspace revision, readiness stage,
session error classification, model usage, elapsed time, and estimated cost.
After acceptance it prints one payload-free build aggregate: accepted and
committed workflow counts; each slice's attempt and commit status; wire-invalid,
stage-rejected, and validator-repair counts; model steps, token and cache use,
elapsed time, and estimated cost. It fails the mechanical gate when any attempt
lacks complete outcome evidence or any persisted package, artifact-workspace
step, revision, review, plan, orchestration, or execution run lacks a usage
summary.

## 9. Unit F: conformance, quality, correction, and Design history

### 9.1 Goal

Unit F answers one question before Nova says the initial build is complete:

> Does the current canonical app implement the accepted workflows well enough
> to make that claim honestly?

It does not add another validity gate. A conformance finding may block Nova's
completion message and trigger a corrective valid slice. It never blocks use of
an already valid app or a direct builder/MCP edit.

### 9.2 Deterministic implementation projection

Add `lib/agent/design/projection/` readers that project the current canonical
app into a compact semantic view:

- app and navigation;
- record catalog and relationships;
- forms as workflow transactions;
- captured inputs;
- writes and case effects;
- lists, search, and readback surfaces;
- actor/user-type/persona bindings;
- external setup requirements;
- stable implementation coordinates.

Inputs are only deterministic repository data:

- canonical `BlueprintDoc` at an exact sequence and snapshot digest;
- effective case-type catalog;
- reference index;
- user, organization, list, search, automation, and setup state;
- committed slice receipts;
- construction-group provenance.

The projection performs no model inference and invents no historical intent.
Its schema and digest version independently.

### 9.3 Conformance from workflow semantics

Compare the projection directly with the lean contract:

- each accepted workflow has a reachable entry point;
- expected inputs are captured once in the correct workflow;
- persisted inputs write the intended record properties;
- form-only inputs are not falsely reported as stored;
- record effects exist with the correct source, target, condition, and writes;
- create effects are not duplicated by both registration and a second create
  operation;
- readback and lists expose the properties needed for the next decision;
- prerequisite workflow order is reachable;
- actor access and navigation are represented at every required layer;
- location-scoped designs pair user-facing gates with ownership and search
  filtering rather than treating hidden menus as security;
- external requirements are reported with their real readiness state;
- deferred or unsupported work is not described as implemented;
- every required construction group has a current committed receipt and at
  least one still-resolving implementation coordinate.

The first rules should be few and high-signal. Do not recreate a generic
requirement traceability matrix. A rule documents its exact proof, severity,
false-positive boundary, and whether it may block completion.

### 9.4 Initial finding vocabulary

Initial deterministic codes should cover:

- missing committed construction group;
- provenance pointing to a missing coordinate;
- workflow with no reachable entry point;
- workflow input missing or duplicated;
- expected property write missing or type-incompatible;
- record effect missing or duplicated;
- readback/list missing a needed property;
- list with no usable selection or monitoring purpose;
- actor binding, access, or navigation missing;
- external requirement unsatisfied;
- deferred work reported as implemented;
- redundant identity-only hidden writer;
- stale generated setup guidance.

The redundant-writer rule begins advisory. It may become corrective only after
supported-runtime parity tests prove blank, relevance, repeat, and update
semantics.

### 9.5 Sequence-bound report

Persist one immutable conformance report bound to:

- design session, accepted contract revision, and plan digests;
- app ID, sequence, and snapshot digest;
- projection version and digest;
- deterministic rule version;
- deterministic findings;
- optional quality-review artifact.

A newer app sequence makes the report stale by comparison. No row is updated
and no direct editor consults the stale report.

### 9.6 Grounded quality review

After deterministic analysis, run one fresh-context structured reviewer over:

- the authorized source projection;
- accepted lean contract and dispositions;
- deterministic plan and committed receipts;
- exact implementation projection;
- deterministic findings;
- unresolved external requirements;
- relevant platform constraints.

It evaluates workflow coherence, worker effort, navigation, scanability,
read/write fit, access fit, unnecessary complexity, unsupported additions,
assumption handling, and setup honesty.

It receives no executor reasoning or raw chat narrative. A model heuristic
cannot be critical. A critical finding requires deterministic proof, exact
source support, or a versioned platform constraint. Findings do not carry a
numeric confidence score. Its citation and element vocabulary follows §4.4:
server-assigned symbols over its projection inputs, resolved in its own
schema — a second citation dialect would reintroduce the copyable-coordinate
failure class the design reviewer already retired.

### 9.7 Bounded correction

The orchestrator dispositions each blocking implementation finding. Accepted
corrections become new server-derived correction slices and execute through
ordinary Atomic Change Sets.

Create a new reviewed contract revision only when the correction changes user
meaning, record relationships, access, or an external promise. An
implementation defect should not churn the Design Contract.

Run one correction round by default. A second is allowed only for grounded
critical findings introduced or left unresolved. Exhaustion produces an
honest incomplete result, not an unbounded retry loop.

### 9.8 Completion report

Persist one immutable completion report bound to the exact current design,
plan, app sequence, snapshot, and conformance report.

Statuses:

- `complete`
- `complete-with-external-setup`
- `incomplete`

Nova may say complete only when:

- every planned workflow slice has a current committed receipt;
- every construction group has current mutation-derived provenance;
- no unresolved critical design or conformance finding remains;
- every workflow acceptance example has a structural path;
- no open change set remains;
- the current canonical app passes the ordinary absolute gate and export
  readiness;
- no construction-critical external action remains.

`complete-with-external-setup` names the exact runtime, HQ, deployment, media,
lookup, place, or worker steps still required. `incomplete` leaves every valid
committed revision usable.

### 9.9 Read-only Design history

Add a read-only Design surface showing safe projections of:

- accepted charter, actors, records, and workflows;
- decisions, assumptions, open or deferred items;
- review status and user-relevant resolutions;
- planned workflows and committed sequences;
- current/stale conformance status;
- external setup;
- completion status.

Do not show raw source bodies, private tool calls, mutation payloads, internal
IDs, confidence scores, or model reasoning. Source links remain separately
authorized.

### 9.10 Persistence

Unit F adds exactly:

- `design_conformance_reports`
- `design_completion_reports`

Both are immutable, exact-parsed, digest-bound lineage. Update runtime types,
privileges, probes, Project movement, soft/physical delete, retention,
inspection, and migration tests in the same unit.

### 9.11 Unit F acceptance

- Projection is deterministic and digest-stable.
- A report for sequence N is stale at N+1.
- Names alone do not prove implementation.
- Construction-group provenance resolves through the deterministic plan to
  contract elements.
- Model-only heuristics cannot become critical blockers.
- A grounded critical finding prevents a false completion claim but not valid
  app use.
- Corrections are ordinary valid slices and are bounded.
- External setup is explicit.
- Design history is read-only and privacy-safe.
- Direct human and MCP edits do not consult conformance reports.

## 10. Unit G: reviewed edits and high-level MCP

### 10.1 Goal

Unit G gives substantial app edits the same design quality and recovery
properties as initial builds while preserving immediate direct editors.

Unit G depends on Unit F's projection, provenance readers, conformance
vocabulary, correction path, and completion reports.

### 10.2 Edit authority

A reviewed edit creates a `design_sessions(mode = 'edit', app_id = ...)`
artifact and orchestration scope. The app row remains the only run, credit,
holder, mutation, and Project authority.

An edit design session never owns a second holder or reservation. Every stage,
artifact, attempt, and commit proves the exact app edit holder and fresh Project
membership.

### 10.3 Design amendment

Create an immutable amendment bound to:

- the user's new source-grounded request;
- current app sequence and snapshot digest;
- current deterministic implementation projection;
- current accepted design revision when one exists;
- affected workflows and elements;
- proposed additions, changes, and removals;
- external and destructive consequences;
- rationale.

Classify the work as:

- intent change;
- implementation correction;
- external-setup only.

Only intent change creates and independently reviews a new Design Contract
revision. Implementation correction reuses accepted meaning.

### 10.4 Reconciliation

Before planning, compare the current canonical projection with current design
lineage and provenance. Human, builder, direct MCP, migration, or prior agent
changes may have made an older report stale.

Unmapped implementation is context, not invalid state. The model may describe
possible intent only as inferred from Blueprint and cannot overwrite
source-grounded accepted meaning without a reviewed amendment.

### 10.5 Apps without design lineage

Derive a `RecoveredDesignSnapshot` only from the deterministic implementation
projection. It may describe observable actors, records, workflow surfaces,
lists, and navigation, but it must state that original rationale, omitted
requirements, and discarded alternatives are unknown.

The recovered snapshot is not an accepted Design Contract. The user's new
request is the first source-grounded amendment.

### 10.6 Destructive work and concurrency

A removal names affected design elements, implementation coordinates,
case/data consequences, external consequences, and whether confirmation or an
exclusive schema operation is required.

External destructive actions remain separate confirmed workflows. They never
stage inside an Atomic Change Set.

Every edit change set records the exact base sequence and digest. Clean replay
may merge over unrelated concurrent edits. Missing targets, changed kinds,
removed anchors, Project movement, or semantic conflicts return structured
conflicts. The model never retargets by name or similarity.

### 10.7 High-level MCP

Keep every existing direct shared MCP tool immediate and canonical. Add a
separate reviewed workflow surface:

- `start_design_session`
- `get_design_session`
- `get_design_contract`
- `get_design_review`
- `submit_design_answers`
- `execute_design_session`
- `get_design_conformance`
- `abandon_design_session`

High-level calls return closed states such as awaiting input, design ready,
building, complete, or incomplete. They return projections and artifact IDs,
not private change-set steps, holder nonces, source bodies, or model reasoning.

Every mutating call requires a request ID and exact input digest. A replay
returns the original result. Reuse with different input rejects. The server
owns session, app, run, holder, artifact, stage, and commit identities.

Do not expose a generic public `begin_change_set` or granular staging
transaction in this unit. That would require a separate lease, discovery,
rebase, retention, and crash-recovery contract.

### 10.8 Unit G acceptance

- Edit design sessions own no holder or reservation.
- Legacy rationale is never fabricated.
- Intent changes produce reviewed contract revisions.
- Implementation corrections do not churn the contract.
- Current canonical state remains rebase authority.
- Direct builder and MCP mutations remain immediate.
- High-level MCP retries cannot duplicate sessions, runs, stages, or apps.
- Questions are resumable and stale-answer safe.
- Concurrent semantic conflicts stop without name guessing.

## 11. Verification and delivery discipline

### 11.1 Maintained foundation checks

Every remaining unit keeps the current guarantees covered by focused and
integration tests:

- exact artifact parsing, lineage, and digest checks;
- design graph closure and review grounding, including the reviewer's
  tag/handle vocabulary staying in lockstep with its prompt legend;
- deterministic plan derivation;
- workspace revision and request idempotency;
- handle resolution before original schema admission, including the reviewer
  output schema's in-schema symbol resolution;
- change-set replay and coverage;
- external read-set fences;
- canonical sidecar atomicity;
- sequence-one materialization fault matrix;
- holder, credit, transcript, stream, Project move, and recovery behavior;
- canonical-only UI activation and collaboration;
- no customer content in operational logs.

### 11.2 Unit F verification

Add tests for:

- projection determinism and coordinate resolution;
- every initial conformance rule, including false-positive boundaries;
- construction group to element to coordinate joins;
- report freshness at exact sequence and digest;
- quality-review grounding and severity limits;
- correction bounds and contract-revision classification;
- completion status and external setup;
- Design history authorization, privacy, accessibility, and staleness;
- migration, runtime privileges, probes, move, deletion, and retention;
- browser journey through completed and honestly incomplete builds.

### 11.3 Unit G verification

Add tests for:

- app-holder-only edit authority;
- amendment classification;
- current-app reconciliation;
- recovered snapshots without invented rationale;
- destructive consequence and confirmation policy;
- concurrent clean replay and semantic conflicts;
- high-level MCP idempotency, pause, resume, and privacy;
- unchanged direct MCP behavior.

### 11.4 Delivery order

Deliver Unit F before Unit G. Each unit includes code, migration, tests,
present-tense subtree contracts, public documentation for behavior that
exists, operational inspection, and any copied `nova-plugin` model-facing
contract in the same PR.

Use one final shape. Do not ship feature-flagged dual readers, compatibility
aliases, temporary persistence dialects, or an inactive public API. Run a fresh
independent review against one frozen SHA and fix findings before landing.

## 12. Final product principle

> **Valid revisions, reviewed design.** Nova records the minimum durable design
> meaning needed to build and verify a good app. The independent reviewer
> improves that meaning. The server derives construction work. Private
> workspaces make long work recoverable. Only the existing canonical gate makes
> app state real.

CommCare's module, form, and field hierarchy is the output grammar, not the
design method. Traceability exists only where it buys product truth: review
cites important evidence, construction groups prove committed work, and Unit F
checks workflow meaning against the canonical implementation.

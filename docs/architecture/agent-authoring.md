# Agent authoring

Nova gives one architect the user's request, relevant source material, and a
shared Markdown plan. The architect carries the work through design,
construction, inspection, and correction. An independent peer reviews the plan
before construction and the saved app before completion. Both reason about the
same content; there is no translation into a second design graph or compiler
brief for a separate builder.

## Plan and judgment

`lib/agent/planning` stores a revisioned Markdown document. Writes and exact
passage edits have durable request receipts. A peer review acquires exclusive
plan ownership while the architect is paused. The peer can improve the plan and
returns a concise assessment; the architect receives both the updated document
and the assessment. There is no finding-ID or disposition protocol.

Review identity binds the plan revision, source digest, and, for an app review,
the actual canonical revision. Editing the plan or app makes the relevant old
review stale. The architect remains responsible for resolving feedback and
judging completion. Review is not a formal proof that the app meets every human
requirement. Mechanical correctness belongs to the document gate; functional
quality needs inspection and representative journeys through the running behavior.
`startAppTest`, `continueAppTest` and `readAppTest` expose app entry, saved worker
identities, menu eligibility, record selection and Details, answers, submission effects and
the next task. They use disposable Postgres records and the production Preview
projections, FormEngine and submission transaction. They do not change live cases
or assert native-device correctness. Builder's Test journeys shows the same
retained observations, including the source revision and boundaries.

Expected journey-test refusals, including an unavailable test reference after
app authorization, return to the architect or peer as tool errors they can
correct. Missing app authority remains terminal; a mistaken evidence identifier
does not stand in for revoked access or reveal another app's observations.
Omitting the identity from `readAppTest` lists recent saved evidence by purpose
and source revision, allowing a peer to find the architect's recorded journeys.

Form and journey answers accept coordinates for location questions and use the
real Preview picker formatter. Invalid supplied coordinate values are input
refusals, distinct from the form's authored validation. These checks do not
exercise a map service or device GPS.

Question observations distinguish participation from visibility. Included hidden
calculations have values; excluded questions report only a retained answer,
which is not a value available to expressions or submission. Saved submission
effects, rather than retained answers, establish record changes.

For a narrower question, `evaluateForm` evaluates one form without a transaction.
Its optional scenario supplies test records and parent relationships without
storing them, allowing follow-up forms and record-dependent rules to be exercised
before an app has real data. Stored records and supplied records never mix;
Project lookup data remains authorized and real. The result identifies its source
and does not claim a successful submission or additional case-operation execution.

Planning exposes reads and plan edits. It does not expose app or Project data
writes. The peer can inspect the saved app, evaluate forms and exercise disposable
test journeys without submitting real cases. Questions are reserved for decisions the agent cannot reasonably
make. A planning-only request can finish with a reviewed plan and no app.

## One authoring vocabulary

The architect, ordinary chat editor, and MCP clients share the registry's
semantic operations. Tools accept names, Markdown, and expressions; the
`authoring` boundary resolves identities and typed content inside an authorized
workspace invocation. The document and mutation kernel retain their canonical
contracts. Tool schemas describe inputs and effects, while a focused reference
guide is available on request. Worker reads expose built-in identity and assigned-place expressions
in their supported form and record scopes, separately from custom worker
information. They describe the simulated worker, independently of the actor
that authorizes access and the owner that controls case sharing.
Scoped reads expose effective initial values,
ordinary answer destinations and
built-in lifecycle metadata. Worker readiness distinguishes a role definition
from an available Preview identity and reports missing information or place
assignments. Those are configuration observations, not proof of entry or workflow
completion.

Lifecycle guidance describes operational effects, including closure's effect on
sync and dependent records, and distinguishes business stage, ownership and actor
history. [The primary-source audit](../research/record-lifecycle-authoring.md)
records Nova, Core and HQ read semantics and the limits of that evidence.

Prompts do not duplicate either the inventory or
the underlying storage grammar.
The architect consults focused guidance before designing around uncertain
platform behavior; the peer derives expected outcomes from the request before
judging the proposed solution. Design and review assess how users obtain the first required records from their
provided or agreed starting state. Seeded later-stage journeys cannot establish
that readiness; retained start observations identify supplied record counts by
type. External setup remains a design decision to resolve when it changes the
user's workflow, not a handoff that automatically makes a blocked app usable.
Review includes later visits where required
history could be lost behind a current summary. Record-expression reads include
the read-only `case_id`, including through relationships, so a parent update does
not require copied identity fields or a redesigned workflow. Form reads expose
`recordContext`: the single selected type and its reachable ancestors, with
form reference spellings. Form XPath reads ancestors by type, such as
`#household/region`; record expressions use relationship functions. Neither
registration/survey nor multiple selection claims a single record context.
The fields guide distinguishes this selected-record context from a query-bound
repeat's retained row identity. It documents the direct-child
`current()/../@id` read and the actual initialization point: form load for a
top-level repeat, creation of its enclosing repeat row for a nested repeat.
Later answers or page entry do not rebuild membership.

The architect has a durable 180-call allowance per user turn, including recovery;
peer and translation bounds remain separate. Reaching a bound is an unfinished
run, not successful delivery. The initial 120-call role trial failed during
peer-driven corrections and remains failed evidence.

Hosted tool search defers shared definitions for Nova's model calls. This lowers
the initial context but does not remove their eventual cost. The architect's
construction catalog stays stable before and after the first save; operations
requiring a saved app explain that prerequisite at invocation before side effects.
This avoids teaching a temporary absence as a permanent product limitation.
Schema factoring,
plain authored content, scoped reads, and concise semantic results reduce the
actual representation. `/agents` keeps the total catalog visible alongside the
initial surface, prompt, changing context, and recorded usage.

## Private construction and canonical checkpoints

A Project-scoped session exists before an app does. Construction begins from a
reviewed plan in a private workspace. Shared mutations can leave incomplete
intermediate work there; only a complete, valid candidate can be saved. The
first save atomically creates a meaningful app, including its runtime schema,
ordered history, lookup edges, session mapping, and exact receipt. Later saves
commit valid checkpoints through the same canonical kernel used by Builder and
MCP. Each private edit admits the full pending batch against its original base,
so removing and recreating an identity cannot poison a later checkpoint. Staging,
reopening and saving reduce that same batch, including translation cleanup.
Preview and export consume only canonical revisions.

The current holder and Project edit membership authorize every write. An active
peer review pauses construction. A checkpoint re-resolves current resources and
replays admitted mutations against locked canonical state, preserving compatible
concurrent changes and rejecting conflicts. The initial build stays locked for
ordinary editing until completion. If later work stops, its earlier canonical
revision remains available and the same session can resume.

External writes are separate effects. During construction, a Project data tool
may create or change a table through the normal service. Its exact request
receipt and expected revision commit with the Project change. A retry first
reauthorizes the current holder and membership. Planning and review cannot make
those changes, and private workspace rollback cannot undo them. Existing shared
data changes need the user's request or informed confirmation; a similar name
is not permission to adopt or overwrite a resource. Organization writes retain
their independent role and revision checks as well.

## Conversation and recovery

The architect has one durable conversation per compatible context. Each peer
review has its own revision-bound completion identity and inherits the peer's
previous investigation, never the architect's private reasoning. Source messages
already present are not repeated. A new review message identifies the current
source, plan and app revisions and the correction focus. Focus is saved before
the peer starts, so recovery preserves it. Earlier observations remain evidence
for their recorded revisions; the peer inspects corrections and dependencies
while retaining still-relevant evidence. It can broaden the investigation when
its independent judgment calls for that. Completed model response items and their usage commit before any tool
executes. Tool results preserve created identities, saved values, confirmations,
and actionable failures without a repeated instruction to continue.

A restarted process replays unanswered tool calls using their original request
IDs. The owning transaction returns the exact prior result. New input and a
fresh current-state message follow those effects, then model work can continue.
A successful no-op is still a completed effect with a durable receipt.

Model, prompt, schema, and context compatibility govern provider checkpoint
reuse. A contract change retains the useful conversation but does not replay an
incompatible encrypted checkpoint. Human-readable reasoning summaries and the
full stored message history remain inspectable. Each logical turn has a durable
step allowance; reconnection does not reset it. Completed usage is accounted
once, including a response completed by a holder that has since lost authority.
Losing authority permits accounting, not another mutation.

Final completion verifies the live holder, exact app revision, and current
orchestration event, then records the terminal event with app completion and
usage settlement. Cancellation and failure join owned streams and heartbeat
work. A saved checkpoint is not, by itself, a completed build.

## Translation

Requested translation reads the current app rather than a frozen plan. It sends
bounded groups of source units to the translator, validates protected references,
and stages accepted batches together. Current translations remain intact;
missing, outdated, or unreviewed copied text is eligible. Retry uses durable
responses and the exact tool receipt, including when nothing needed translation.
See [multilingual localization](multilingual-localization.md).

## Evidence and cutover

Tests use the real SDK with controlled provider responses and migrated Postgres
to exercise interrupted responses, outstanding effects, private and canonical
checkpoints, review ownership, stale holders, revision races, cancellation, and
usage settlement. Those tests establish runtime behavior, not design quality.
Live trials must also inspect the generated app against its original request,
plan, messages, reasoning summaries, failed calls, and corrections. A fresh
reviewer assesses that evidence independently.

Old private formats are converted once by the operator workflow in
[design format cutover](design-format-cutover.md). Serving code never interprets
the retired workflow graph. Canonical apps, collected data, conversations,
billing, and original historical artifacts remain intact.

The peer anatomy has separate design-review and saved-app-review moments. The
latter includes disposable journey tools. Recorded conversations distinguish
retained earlier messages from new revision context; replaying those messages
consumes input even though it does not repurchase their earlier calls. Current
catalog estimates do not reconstruct a historical request or remove the cost of
deferred definitions once loaded.

An ordinary edit turn initializes its workspace with the document and canonical
revision from the same authorized snapshot. Disposable tests can start before any
edit; an incidental app mutation is never a prerequisite for observing saved work.

When an ordinary edit reaches its step limit after a tool, the route appends an
unfinished-turn notice before finishing the stream. Completed changes remain
saved. The same notice survives reconnect and thread replay without another model
call. Errors, lost authorization and questions awaiting an answer retain their
own terminal behavior; a bounded stop is not a successful completion claim.

Unused custom record-property definitions can be removed through the shared
`removeCaseProperties` / `remove_case_properties` operation. Reference checks
include form writers and all indexed reads. The canonical transaction refuses
live or parked values before changing the storage schema, so cleanup cannot
silently discard collected data in a later record edit. Populated retirement
remains a reviewed one-time migration.

App-test navigation distinguishes a leaf form's transient selected record from
a persistent parent-menu selection, matching Preview's CaseListScreen and menu
context. Returning to a case-first module after a leaf form reopens Results.
Explicit link-carried selections and parent chains retain their own production
lifetime. Older retained journeys remain evidence at their original runtime;
they require a new test to execute after a navigation contract change.

Sectioned form journeys expose the current page and offered sections. Page
entry uses the same FormEngine insertion lifecycle as Builder Preview, retaining
form-start snapshots and creating nested rows only when their page is reached.
Forward page turns validate intervening answers; test callers cannot answer an
unvisited page or submit from an earlier one. Returning preserves existing rows.
A one-shot form check follows supplied answer order and visits remaining pages;
it is not a navigation acceptance result. Native checks remain necessary for
question-by-question timing outside authored sections.
